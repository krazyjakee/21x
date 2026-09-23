/**
 * Side effects of creating or updating a task, shared by every write route
 * (task API, mobile API) so they cannot drift apart.
 */
import type { DatabaseManager, TaskRecord, UpdateTaskData } from './database'
import type { AgentManager } from './agent-manager'
import type { RecurrenceScheduler } from './recurrence-scheduler'
import type { HeartbeatScheduler } from './heartbeat-scheduler'
import { TaskStatus } from '../shared/constants'
import { emitTaskEvent } from './project-events'

type TaskLifecycleController = Pick<
  AgentManager,
  'notifyParentOfSubtaskCompletion' | 'startTask' | 'stopByTaskId' | 'hasTaskStartOwnership' | 'reconcileTaskRuntime'
>

export interface PreparedUserTaskUpdate {
  /** Fields that remain ordinary data after lifecycle intent is removed. */
  data: UpdateTaskData
  /** Execution-stage moves must enter AgentManager's durable admission path. */
  startAfterWrite: boolean
}

export function isExecutionTaskStatus(status: string | undefined): boolean {
  return status === TaskStatus.Triaging || status === TaskStatus.AgentWorking
}

/**
 * Turn a user/API status edit into a lifecycle command before anything is
 * persisted. Execution stages are owned by AgentManager: callers write any
 * accompanying metadata first, then call `startPreparedTask`. Moving away
 * first withdraws durable admission ownership and stops the live runtime, so
 * a board/API edit can never silently strand an agent behind a cosmetic status.
 */
export async function prepareUserTaskUpdate(
  agents: TaskLifecycleController | null | undefined,
  previous: TaskRecord,
  requested: UpdateTaskData
): Promise<PreparedUserTaskUpdate> {
  if (requested.status === undefined) return { data: requested, startAfterWrite: false }

  // Feedback is a command to reuse the retained conversation for learning.
  // The user-write route validates the rating and records its completion marker.
  if (requested.status === TaskStatus.AgentLearning && requested.feedback_rating !== undefined) {
    return { data: requested, startAfterWrite: false }
  }

  if (isExecutionTaskStatus(requested.status)) {
    if (!agents) throw new Error('Agent runtime is unavailable; the task was not started.')
    const data = { ...requested }
    delete data.status
    return { data, startAfterWrite: true }
  }

  const ownsRuntime = agents?.hasTaskStartOwnership?.(previous.id) ?? false
  if (isExecutionTaskStatus(previous.status) || ownsRuntime) {
    if (!agents) throw new Error('Agent runtime is unavailable; the running task was not moved.')
    await agents.stopByTaskId(previous.id)
  }
  return { data: requested, startAfterWrite: false }
}

/** `byUser` marks a person's own status change (see AgentManager.startTask). */
export async function startPreparedTask(
  agents: TaskLifecycleController,
  taskId: string,
  byUser = false
): Promise<Awaited<ReturnType<AgentManager['startTask']>>> {
  const result = await agents.startTask(taskId, { resumeManualStop: true, ...(byUser ? { explicitUserStart: true } : {}) })
  if (result.action === 'no_action') {
    throw new Error('No configured agent is available to start this task.')
  }
  return result
}

let automationTrigger: (() => void) | null = null
let recurrenceScheduler: Pick<RecurrenceScheduler, 'initializeRecurringTask'> | null = null
let heartbeatScheduler: Pick<HeartbeatScheduler, 'disableHeartbeat'> | null = null

/**
 * Runs one auto-start / auto-complete reconciliation pass.
 *
 * A caller with no window cannot rely on the renderer to act on the
 * `auto_start_agent` / `auto_complete_without_review` flags it just set.
 * Poking the main-process scheduler keeps those flags immediate rather than
 * leaving them until its next 60s tick.
 */
export function setTaskAutomationTrigger(fn: (() => void) | null): void {
  automationTrigger = fn
}

export function setTaskSchedulers(schedulers: {
  recurrence?: Pick<RecurrenceScheduler, 'initializeRecurringTask'> | null
  heartbeat?: Pick<HeartbeatScheduler, 'disableHeartbeat'> | null
}): void {
  if (schedulers.recurrence !== undefined) recurrenceScheduler = schedulers.recurrence
  if (schedulers.heartbeat !== undefined) heartbeatScheduler = schedulers.heartbeat
}

export function triggerTaskAutomation(): void {
  try {
    automationTrigger?.()
  } catch (err) {
    console.error('[TaskUpdates] Task automation trigger failed:', err)
  }
}

export function afterTaskCreated(task: TaskRecord): void {
  // The scheduler owns next_occurrence_at (timezone, legacy patterns).
  if (task.is_recurring) recurrenceScheduler?.initializeRecurringTask(task.id)
  if (task.auto_start_agent) triggerTaskAutomation()
}

export function afterTaskUpdated(
  db: DatabaseManager,
  agents: TaskLifecycleController | null | undefined,
  previous: TaskRecord,
  data: UpdateTaskData,
  updated: TaskRecord
): void {
  if ((data.is_recurring !== undefined || data.recurrence_pattern !== undefined) && updated.is_recurring && updated.recurrence_pattern) {
    recurrenceScheduler?.initializeRecurringTask(updated.id)
  }

  // Completing a parent does not complete its subtasks (a subtask can stay in
  // ready_for_review), so a subtask heartbeat left on would keep spawning
  // sessions for work the user considers done.
  if (heartbeatScheduler && data.status === TaskStatus.Completed) {
    if (updated.heartbeat_enabled) heartbeatScheduler.disableHeartbeat(updated.id)
    for (const subtask of db.getSubtasks(updated.id)) {
      if (subtask.heartbeat_enabled) heartbeatScheduler.disableHeartbeat(subtask.id)
    }
  }

  // A status move, most importantly into ready_for_review, is exactly when an
  // auto-complete flag has to be honoured.
  if (data.status !== undefined || data.auto_start_agent !== undefined || data.auto_complete_without_review !== undefined) {
    triggerTaskAutomation()
  }

  // Defense in depth for old integrations or source adapters that still write
  // an execution status directly. Command-backed routes remove that status
  // before this point; any remaining mismatch is reconciled synchronously into
  // a durable queue row (or a visible terminal failure) rather than being left
  // as manufactured working state until the next restart.
  if (data.status !== undefined && isExecutionTaskStatus(updated.status)) {
    agents?.reconcileTaskRuntime?.(updated.id, 'uncommanded_status_write')
  }

  // Project event (#57): a task reaching review wakes the project's Captain
  // (the waker skips it when the Captain made the change itself).
  if (data.status !== undefined && previous.status !== updated.status && updated.status === TaskStatus.ReadyForReview) {
    emitTaskEvent(db, 'task_ready_for_review', updated.id)
  }

  // Event-driven coordinator wake-up: a subtask that reaches a terminal state
  // resumes its idle parent instead of the parent polling for child status.
  const parentId = updated.parent_task_id
  if (
    parentId &&
    agents &&
    data.status !== undefined &&
    previous.status !== updated.status &&
    (updated.status === TaskStatus.ReadyForReview || updated.status === TaskStatus.Completed)
  ) {
    agents.notifyParentOfSubtaskCompletion(parentId, updated.id).catch((err) => {
      console.error(`[TaskUpdates] Failed to wake parent ${parentId} after subtask ${updated.id} update:`, err)
    })
  }
}
