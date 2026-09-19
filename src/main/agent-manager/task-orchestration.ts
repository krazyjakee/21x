import { TaskStatus } from '../../shared/constants'
import { findBlockingSibling, isSuccessorGraphInProgress, successorsFireOnReview } from '../../shared/subtask-graph'
import { emitTaskEvent } from '../project-events'
import type { AdmissionReason } from './admission'
import { buildSubtaskWakeMessage } from './prompts'
import type { SessionHost } from './types'

type OrchestrationHost = Pick<SessionHost,
  | 'db' | 'findSessionByTaskId' | 'updateTaskFromLocalAgent' | 'sendToRenderer' | 'requestSession' | 'startSession'
  | 'startTask' | 'sendByTaskId' | 'defaultAgentId'>

export interface StartTaskResult {
  /** `queued`: over a concurrency limit; it starts on its own when a slot frees. */
  action: 'task_started' | 'subtask_started' | 'triage_started' | 'already_running' | 'queued' | 'no_action'
  sessionId?: string
  startedTaskId?: string
  agentId?: string
  /** 1-based place in the start queue when `action` is `queued`. */
  queuePosition?: number
  queueReason?: AdmissionReason
}

/**
 * Starts the next piece of work for a task: its next subtask (when preferred),
 * a triage session when it has no agent, or its own agent.
 */
export async function startTask(
  host: OrchestrationHost,
  taskId: string,
  opts?: { preferSubtasks?: boolean; allowTriage?: boolean }
): Promise<StartTaskResult> {
  const task = host.db.getTask(taskId)
  if (!task) {
    throw new Error(`Task not found: ${taskId}`)
  }

  const preferSubtasks = opts?.preferSubtasks !== false
  const allowTriage = opts?.allowTriage !== false

  if (preferSubtasks) {
    const subtasks = host.db.getSubtasks(taskId)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

    // Same rule as the schedulers: only a running sibling blocks; one in
    // ready_for_review has finished its run and cannot accept itself.
    const activeSubtask = findBlockingSibling(subtasks)
    if (activeSubtask) {
      return {
        action: 'already_running',
        startedTaskId: activeSubtask.id,
        agentId: activeSubtask.agent_id ?? undefined
      }
    }

    // Once successor edges drive the run, never pick the next one by list order.
    const nextSubtask = isSuccessorGraphInProgress(subtasks)
      ? undefined
      : subtasks.find((subtask) => subtask.status === TaskStatus.NotStarted && !!subtask.agent_id)
    if (nextSubtask?.agent_id) {
      const outcome = await host.requestSession(nextSubtask.agent_id, nextSubtask.id)
      if (outcome.status === 'queued') {
        return { action: 'queued', startedTaskId: nextSubtask.id, agentId: nextSubtask.agent_id, queuePosition: outcome.position, queueReason: outcome.reason }
      }
      return {
        action: 'subtask_started',
        sessionId: outcome.sessionId,
        startedTaskId: nextSubtask.id,
        agentId: nextSubtask.agent_id
      }
    }
  }

  const runningSession = host.findSessionByTaskId(taskId)
  if (runningSession && runningSession.session.status !== 'idle' && runningSession.session.status !== 'error') {
    return {
      action: 'already_running',
      sessionId: runningSession.sessionId,
      startedTaskId: taskId,
      agentId: runningSession.session.agentId
    }
  }

  if (!task.agent_id) {
    if (!allowTriage || task.parent_task_id) {
      return { action: 'no_action', startedTaskId: taskId }
    }

    const defaultAgentId = host.defaultAgentId()
    if (!defaultAgentId) {
      return { action: 'no_action', startedTaskId: taskId }
    }

    host.updateTaskFromLocalAgent(taskId, { status: TaskStatus.Triaging })
    host.sendToRenderer('task:updated', {
      taskId,
      updates: { status: TaskStatus.Triaging }
    })

    // Triage is exempt from the limits, so this never queues.
    const sessionId = await host.startSession(defaultAgentId, taskId)
    return {
      action: 'triage_started',
      sessionId,
      startedTaskId: taskId,
      agentId: defaultAgentId
    }
  }

  const outcome = await host.requestSession(task.agent_id, taskId)
  if (outcome.status === 'queued') {
    return { action: 'queued', startedTaskId: taskId, agentId: task.agent_id, queuePosition: outcome.position, queueReason: outcome.reason }
  }
  return {
    action: 'task_started',
    sessionId: outcome.sessionId,
    startedTaskId: taskId,
    agentId: task.agent_id
  }
}

/** Wakes a parent coordinator when its subtasks finish, and follows successor edges. */
export class ParentWakeups {
  /** Parents being woken (dedupe guard: several subtasks finishing at once produce one wake-up). */
  private wakingParents = new Set<string>()
  /** Completed subtasks whose explicit successor edges are being followed. */
  private routingCompletedSubtasks = new Set<string>()

  constructor(private readonly host: OrchestrationHost) {}

  /**
   * Called when a subtask reaches ready_for_review or completed. An idle
   * parent coordinator (or one whose runtime was released) is resumed with a
   * summary so it can continue orchestrating; it need not stay resident while
   * its children run.
   *
   * - A live parent that is NOT idle (e.g. inside wait_for_subtasks) sees the
   *   subtask state itself, so nothing is injected.
   * - The wake-up fires once no subtask is still being worked on, so a parent
   *   that went idle while creating children is resumed as the pipeline
   *   drains, once rather than per child.
   * - A completed subtask with `next_subtask_ids` starts those siblings
   *   instead. The parent is woken at once (even mid-pipeline) if a successor
   *   is missing, has no agent, or fails to start. When the chain opts in
   *   ({@link successorsFireOnReview}), a subtask in review starts its
   *   successors too; it stays in review, as accepting it is a human's call.
   */
  async notify(parentTaskId: string, subtaskId: string): Promise<void> {
    const parentTask = this.host.db.getTask(parentTaskId)
    if (!parentTask) return
    if (parentTask.status === TaskStatus.Completed) return

    const completedSubtask = this.host.db.getTask(subtaskId)
    const routesSuccessors =
      completedSubtask?.status === TaskStatus.Completed ||
      (completedSubtask?.status === TaskStatus.ReadyForReview && successorsFireOnReview(parentTask, completedSubtask))
    const nextSubtaskIds = routesSuccessors ? completedSubtask?.next_subtask_ids ?? [] : []
    let routingIssue: string | null = null

    if (nextSubtaskIds.length > 0) {
      if (this.routingCompletedSubtasks.has(subtaskId)) return
      this.routingCompletedSubtasks.add(subtaskId)
      try {
        const siblings = new Map(this.host.db.getSubtasks(parentTaskId).map((task) => [task.id, task]))
        let hasPendingSuccessor = false
        for (const nextSubtaskId of nextSubtaskIds) {
          const nextSubtask = siblings.get(nextSubtaskId)
          if (!nextSubtask) {
            routingIssue = `Selected successor ${nextSubtaskId} no longer exists.`
            continue
          }
          if (nextSubtask.status === TaskStatus.Completed) continue
          if (nextSubtask.status !== TaskStatus.NotStarted) {
            hasPendingSuccessor = true
            continue
          }
          if (!nextSubtask.agent_id) {
            routingIssue = `Selected successor ${nextSubtaskId} has no agent assigned.`
            continue
          }
          try {
            const result = await this.host.startTask(nextSubtaskId, { preferSubtasks: false, allowTriage: false })
            if (result.action === 'no_action') routingIssue = `Selected successor ${nextSubtaskId} could not start.`
            else hasPendingSuccessor = true
          } catch (err) {
            console.error(`[AgentManager] Failed to start successor ${nextSubtaskId} after subtask ${subtaskId}:`, err)
            routingIssue = `Selected successor ${nextSubtaskId} failed to start.`
          }
        }
        if (!hasPendingSuccessor && !routingIssue) {
          routingIssue = 'All selected successors are already completed.'
        }
      } finally {
        this.routingCompletedSubtasks.delete(subtaskId)
      }
      if (!routingIssue) return
      // Project event (#57): a chain that cannot advance on its own needs the
      // project's Captain, not only the parent coordinator.
      emitTaskEvent(this.host.db, 'chain_stuck', parentTaskId, `After subtask ${subtaskId}: ${routingIssue}`)
    }

    const live = this.host.findSessionByTaskId(parentTaskId)
    if (live && live.session.status !== 'idle') {
      console.log(
        `[AgentManager] Subtask ${subtaskId} terminal, but parent ${parentTaskId} session is ${live.session.status} — no wake-up needed`
      )
      return
    }

    const subtasks = this.host.db.getSubtasks(parentTaskId)
    if (subtasks.length === 0) return

    // Not only when every child is terminal: a parent must learn the pipeline
    // drained so it can start the next not_started child or consolidate. A
    // successor-routing problem needs a decision now, even mid-pipeline.
    const stillWorking = subtasks.some(
      (s) => s.status === TaskStatus.AgentWorking || s.status === TaskStatus.Triaging
    )
    if (!routingIssue && stillWorking) {
      console.log(
        `[AgentManager] Subtask ${subtaskId} terminal, but parent ${parentTaskId} still has a subtask being worked on — deferring wake-up`
      )
      return
    }

    if (this.wakingParents.has(parentTaskId)) return
    this.wakingParents.add(parentTaskId)
    try {
      const message = buildSubtaskWakeMessage(parentTaskId, subtasks, routingIssue ? { subtaskId, issue: routingIssue } : undefined)
      console.log(`[AgentManager] Waking parent coordinator ${parentTaskId} after subtask ${subtaskId}${routingIssue ? ' (successor routing issue)' : ''}`)
      await this.host.sendByTaskId(parentTaskId, message)
    } finally {
      this.wakingParents.delete(parentTaskId)
    }
  }
}
