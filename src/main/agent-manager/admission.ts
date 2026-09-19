/**
 * Admission control for agent sessions (#47).
 *
 * Every session start in the main process goes through
 * `AgentManager.requestSession` (startSession, startTask, the MCP
 * `start_task` / `start_sibling_subtask` tools, the mobile API, the IPC start
 * and the TaskAutomationScheduler all reach it). That one place asks
 * {@link checkAdmission} whether the start fits under the limits; if it does
 * not, the start waits in a FIFO {@link StartQueue} in the main process and is
 * started when a counted session goes idle or stops. The window does not have
 * to be open for any of this.
 *
 * ## What counts
 *
 * Only sessions of real tasks that are working (`working` or
 * `waiting_approval`). Idle sessions have finished their turn and do not hold
 * a slot. These never count and are never queued:
 *  - coordinator sessions (the Captain, `isCoordinatorTask`) — they only
 *    delegate, and queueing the thing that drains the queue would deadlock;
 *  - heartbeat sessions (`heartbeat-*` pseudo tasks) — short checks on
 *    existing work;
 *  - triage sessions — they only classify and assign a task.
 *
 * ## Limits
 *
 *  - per agent: `agent.config.max_parallel_sessions` (default 1, as the agent
 *    form shows it);
 *  - global: the `max_concurrent_agent_sessions` setting; empty or 0 means
 *    unlimited.
 *
 *  - per project (#65, `projects.settings.limits`, read by project-limits.ts):
 *    `max_concurrent_agents` counts the running sessions whose task shares
 *    the project; `daily_session_cap` counts starts since local midnight;
 *    `paused` refuses every start. The `all_projects_paused` setting refuses
 *    starts everywhere. Pauses and the daily cap are checked before the
 *    concurrency limits, so a paused project's starts queue with that reason
 *    and not as "agent limit".
 */
import type { AgentRecord, TaskRecord } from '../database'
import { TaskStatus } from '../../shared/constants'
import { isCoordinatorTask } from '../../shared/task-roles'
import type { ProjectLimitReason } from '../../shared/project-policies'
import type { ProjectLimitState } from '../../shared/project-limit-types'
import { FINDINGS_BEGIN, FINDINGS_END, SYSTEM_MESSAGE_MARKER } from '../../shared/system-authority'
import { buildProjectLimitState, describeQueueReason, isAllProjectsPaused, projectAdmissionLimits, recordProjectSessionStart } from '../project-limits'
import { isTriageSessionTask } from './session-config'
import { taskProjectId } from './project-repos'
import type { SessionHost, SessionStartOutcome } from './types'

type AdmissionHost = Pick<SessionHost,
  'db' | 'sessions' | 'findSessionByTaskId' | 'hasActiveSessionForTask' | 'sendMessage' | 'sendToRenderer' | 'emitSystemError' | 'emitStatus' | 'startSessionNow'>

/** Settings key for the global cap on concurrently working agent sessions. */
export const MAX_CONCURRENT_AGENT_SESSIONS_SETTING = 'max_concurrent_agent_sessions'

/** Everything the admission check may look at for one requested start. */
export interface AdmissionContext {
  agentId: string
  taskId: string
  task: TaskRecord | undefined
  agent: AgentRecord
}

/** A session that holds a slot. */
export interface CountedSession {
  agentId: string
  taskId: string
  /** The task's project; missing on callers that predate #65 (treated as no project). */
  projectId?: string
}

/** The requested task's project limits, resolved by project-limits.ts (#65). */
export interface ProjectAdmissionLimits {
  projectId: string
  /** null = unlimited. */
  maxConcurrent: number | null
  paused: boolean
  /** null = unlimited. */
  dailyCap: number | null
  /** Sessions the project has started since local midnight. */
  startedToday: number
}

export interface AdmissionLimits {
  /** null = unlimited. */
  globalLimit: number | null
  /** The `all_projects_paused` setting (#65). */
  globalPaused?: boolean
  /** Absent when the task has no project row to read (never for real tasks). */
  project?: ProjectAdmissionLimits
}

export type AdmissionReason = 'agent_limit' | 'global_limit' | ProjectLimitReason

/** Reasons that block every start, so a drain can stop at the first one. */
export function isGlobalAdmissionReason(reason: AdmissionReason): boolean {
  return reason === 'global_limit' || reason === 'global_pause'
}

export type AdmissionDecision =
  | { admitted: true }
  | { admitted: false; reason: AdmissionReason; limit: number; running: number }

/** Coordinator, heartbeat and triage sessions neither count nor queue. */
export function isExemptFromAdmission(taskId: string, task: TaskRecord | undefined | null): boolean {
  if (taskId.startsWith('heartbeat-')) return true
  if (isCoordinatorTask(task)) return true
  return isTriageSessionTask(taskId, task)
}

/** The agent's own cap; unset or invalid values fall back to 1. */
export function agentSessionLimit(agent: Pick<AgentRecord, 'config'>): number {
  const config = agent.config as unknown as { max_parallel_sessions?: unknown } | undefined
  const raw = Number(config?.max_parallel_sessions)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1
}

/** Parses the global setting; empty, 0 or garbage means unlimited. */
export function parseGlobalSessionLimit(raw: string | null | undefined): number | null {
  const value = parseInt(String(raw ?? '').trim(), 10)
  return Number.isFinite(value) && value > 0 ? value : null
}

export function checkAdmission(
  ctx: AdmissionContext,
  running: CountedSession[],
  limits: AdmissionLimits
): AdmissionDecision {
  const others = running.filter((s) => s.taskId !== ctx.taskId)

  // #65: pauses and the daily cap first. They are not "no slot right now" but
  // "do not start", and the queued reason should say so.
  if (limits.globalPaused) {
    return { admitted: false, reason: 'global_pause', limit: 0, running: others.length }
  }
  const project = limits.project
  if (project?.paused) {
    return { admitted: false, reason: 'project_paused', limit: 0, running: others.length }
  }
  if (project && project.dailyCap !== null && project.startedToday >= project.dailyCap) {
    return { admitted: false, reason: 'project_daily_cap', limit: project.dailyCap, running: project.startedToday }
  }

  if (limits.globalLimit !== null && others.length >= limits.globalLimit) {
    return { admitted: false, reason: 'global_limit', limit: limits.globalLimit, running: others.length }
  }

  const agentLimit = agentSessionLimit(ctx.agent)
  const agentRunning = others.filter((s) => s.agentId === ctx.agentId).length
  if (agentRunning >= agentLimit) {
    return { admitted: false, reason: 'agent_limit', limit: agentLimit, running: agentRunning }
  }

  if (project && project.maxConcurrent !== null) {
    const projectRunning = others.filter((s) => s.projectId === project.projectId).length
    if (projectRunning >= project.maxConcurrent) {
      return { admitted: false, reason: 'project_limit', limit: project.maxConcurrent, running: projectRunning }
    }
  }
  return { admitted: true }
}

export interface QueuedStart {
  taskId: string
  agentId: string
  workspaceDir?: string
  skipInitialPrompt?: boolean
  reason: AdmissionReason
  queuedAt: string
}

/** What clients see: a queued start and its 1-based place in line. */
export interface QueuedStartInfo {
  taskId: string
  agentId: string
  reason: AdmissionReason
  queuedAt: string
  position: number
}

/**
 * The start queue and the admission check around every session start: FIFO,
 * at most one entry per task, drained whenever a counted session goes idle or
 * stops (and on the reaper's sweep, as a safety net for raised limits).
 */
export class SessionAdmission {
  private queue: QueuedStart[] = []
  /** taskId -> agentId of admitted starts whose session is not registered yet.
   *  They hold their slot so concurrent requests cannot all slip past. */
  private admittedStarts = new Map<string, string>()
  private drainScheduled = false
  /** `projectId:reason` pairs the project's Captain has been told about (#65),
   *  cleared when one of the project's queued starts runs. */
  private projectLimitNotices = new Set<string>()

  constructor(private readonly host: AdmissionHost) {}

  list(): QueuedStartInfo[] {
    return this.queue.map((e, i) => ({
      taskId: e.taskId,
      agentId: e.agentId,
      reason: e.reason,
      queuedAt: e.queuedAt,
      position: i + 1
    }))
  }

  /** Starts the session when it fits under the limits, otherwise queues it once per task. */
  async request(agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean): Promise<SessionStartOutcome> {
    const { db } = this.host
    const agent = db.getAgent(agentId)
    if (!agent) throw new Error(`Agent not found: ${agentId}`)

    const task = db.getTask(taskId)
    if (!isExemptFromAdmission(taskId, task)) {
      const alreadyQueued = this.list().find((entry) => entry.taskId === taskId)
      if (alreadyQueued) return { status: 'queued', position: alreadyQueued.position, reason: alreadyQueued.reason }

      const decision = checkAdmission({ agentId, taskId, task, agent }, this.countedSessions(), this.limits(task))
      if (!decision.admitted) {
        this.queue.push({ taskId, agentId, workspaceDir, skipInitialPrompt, reason: decision.reason, queuedAt: new Date().toISOString() })
        const position = this.queue.length
        console.log(
          `[AgentManager] Start of task ${taskId} queued at position ${position}: ${decision.reason} ` +
          `(${decision.running}/${decision.limit} running)`
        )
        this.emitChanged()
        this.tellCaptainAboutLimit(task, decision)
        return { status: 'queued', position, reason: decision.reason }
      }
      this.recordCountedStart(task)
    }

    this.admittedStarts.set(taskId, agentId)
    try {
      return { status: 'started', sessionId: await this.host.startSessionNow(agentId, taskId, workspaceDir, skipInitialPrompt) }
    } catch (error) {
      // The reserved slot is released in finally, before the deferred drain runs.
      this.scheduleDrain()
      // The renderer pre-registered a "starting" session and other bound views
      // only learn of the failure from these, instead of sitting on
      // "Agent is starting..." forever.
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[AgentManager] Failed to start ${agent.name} for task ${taskId}:`, error)
      this.host.emitSystemError('', taskId, `session-start-failed-${Date.now()}`, `Could not start ${agent.name}: ${message}`)
      this.host.emitStatus('', { agentId, taskId }, 'error')
      throw error
    } finally {
      this.admittedStarts.delete(taskId)
    }
  }

  /** Withdraws a queued start; true when one was waiting. */
  cancel(taskId: string): boolean {
    if (!this.remove(taskId)) return false
    console.log(`[AgentManager] Queued start of task ${taskId} cancelled`)
    this.emitChanged()
    return true
  }

  /** Shutdown: the stops that follow free slots, which must not start queued work. */
  clear(): void {
    this.queue = []
  }

  projectLimitState(projectId: string): ProjectLimitState {
    const { db } = this.host
    const queued = this.list().filter((entry) => taskProjectId(db.getTask(entry.taskId)) === projectId)
    return buildProjectLimitState(db, projectId, this.countedSessions(), queued)
  }

  /** Deferred so the transition that freed the slot finishes first. */
  scheduleDrain(): void {
    if (this.queue.length === 0 || this.drainScheduled) return
    this.drainScheduled = true
    setImmediate(() => {
      this.drainScheduled = false
      this.drain()
    })
  }

  /**
   * Starts every queued entry that now fits, in FIFO order. An entry blocked
   * by its own agent's limit does not hold back entries for other agents.
   * Entries whose task is gone, finished, reassigned or already running are
   * dropped.
   */
  drain(): void {
    const { db } = this.host
    let changed = false
    for (const entry of [...this.queue]) {
      const agent = db.getAgent(entry.agentId)
      const task = db.getTask(entry.taskId)
      const stale =
        !agent ? 'agent deleted'
        : !task ? 'task deleted'
        : task.status === TaskStatus.Completed ? 'task completed'
        : task.agent_id && task.agent_id !== entry.agentId ? 'task reassigned'
        : this.host.hasActiveSessionForTask(entry.taskId) ? 'task already running'
        : null
      if (stale) {
        console.log(`[AgentManager] Dropping queued start of task ${entry.taskId}: ${stale}`)
        this.remove(entry.taskId)
        changed = true
        continue
      }

      const decision = checkAdmission(
        { agentId: entry.agentId, taskId: entry.taskId, task, agent: agent! },
        this.countedSessions(),
        this.limits(task)
      )
      if (!decision.admitted) {
        // A project may have gone from "at its limit" to "paused" while its start waited.
        if (entry.reason !== decision.reason) {
          entry.reason = decision.reason
          changed = true
        }
        if (isGlobalAdmissionReason(decision.reason)) break
        continue
      }

      this.remove(entry.taskId)
      changed = true
      this.recordCountedStart(task)
      for (const key of this.projectLimitNotices) {
        if (key.startsWith(`${taskProjectId(task)}:`)) this.projectLimitNotices.delete(key)
      }
      // Reserve the slot now: the start below is async and the next entry's
      // check must already see it.
      this.admittedStarts.set(entry.taskId, entry.agentId)
      console.log(`[AgentManager] Starting queued task ${entry.taskId} (agent ${entry.agentId})`)
      void this.host.startSessionNow(entry.agentId, entry.taskId, entry.workspaceDir, entry.skipInitialPrompt)
        .catch((error) => {
          // Not re-queued: a start that throws would throw again. The task
          // stays not_started, so the automation sweep or the user can retry.
          console.error(`[AgentManager] Queued start of task ${entry.taskId} failed:`, error)
          this.host.sendToRenderer('agent:startQueueChanged', {
            queue: this.list(),
            failed: { taskId: entry.taskId, error: error instanceof Error ? error.message : String(error) }
          })
        })
        .finally(() => {
          this.admittedStarts.delete(entry.taskId)
          this.scheduleDrain()
        })
    }
    if (changed) this.emitChanged()
  }

  private remove(taskId: string): boolean {
    const index = this.queue.findIndex((e) => e.taskId === taskId)
    if (index === -1) return false
    this.queue.splice(index, 1)
    return true
  }

  private emitChanged(): void {
    this.host.sendToRenderer('agent:startQueueChanged', { queue: this.list() })
  }

  /** Sessions holding a slot: working real-task sessions plus admitted starts in flight. */
  private countedSessions(): CountedSession[] {
    const { db } = this.host
    const counted = new Map<string, CountedSession>()
    for (const session of this.host.sessions.values()) {
      if (session.status !== 'working' && session.status !== 'waiting_approval') continue
      if (session.isTriageSession) continue
      const task = db.getTask(session.taskId)
      if (isExemptFromAdmission(session.taskId, task)) continue
      counted.set(session.taskId, { taskId: session.taskId, agentId: session.agentId, projectId: taskProjectId(task) })
    }
    for (const [taskId, agentId] of this.admittedStarts) {
      if (!counted.has(taskId)) counted.set(taskId, { taskId, agentId, projectId: taskProjectId(db.getTask(taskId)) })
    }
    return [...counted.values()]
  }

  /** The global cap and pause, plus the requested task's project limits (#65). */
  private limits(task: TaskRecord | undefined): AdmissionLimits {
    const { db } = this.host
    return {
      globalLimit: parseGlobalSessionLimit(db.getSetting(MAX_CONCURRENT_AGENT_SESSIONS_SETTING)),
      globalPaused: isAllProjectsPaused(db),
      project: task ? projectAdmissionLimits(db, taskProjectId(task)) : undefined
    }
  }

  /** Counts an admitted start of a real task against its project's day (#65). */
  private recordCountedStart(task: TaskRecord | undefined): void {
    if (!task) return
    try {
      recordProjectSessionStart(this.host.db, taskProjectId(task))
    } catch (error) {
      console.warn(`[AgentManager] Could not record the daily session count for task ${task.id}:`, error)
    }
  }

  /**
   * Tells the project's Captain why a start waits (#65): a short fenced
   * system message to its live, idle coordinator session. A Captain
   * mid-turn already sees the reason in its start_task result; one with no
   * live session is told nothing (the queue entry and the project's limit
   * state carry it). Once per project and reason until a queued start runs.
   */
  private tellCaptainAboutLimit(task: TaskRecord | undefined, decision: AdmissionDecision): void {
    if (!task || decision.admitted) return
    if (decision.reason === 'agent_limit' || decision.reason === 'global_limit') return
    const projectId = taskProjectId(task)
    const key = `${projectId}:${decision.reason}`
    if (this.projectLimitNotices.has(key)) return
    const coordinator = this.host.db.getCoordinatorTask(projectId)
    if (!coordinator) return
    const live = this.host.findSessionByTaskId(coordinator.id)
    if (!live || live.session.status !== 'idle') return
    this.projectLimitNotices.add(key)
    const message = [
      SYSTEM_MESSAGE_MARKER,
      `provenance: origin=admission-control project=${projectId} human_authored=false authorizes_actions=false`,
      '',
      'A start in your project was queued by admission control. No action is required; the queue drains by itself.',
      '',
      FINDINGS_BEGIN,
      `Task "${task.title}" (${task.id}) is waiting to start: ${describeQueueReason(decision.reason, decision.limit, decision.running)}`,
      FINDINGS_END
    ].join('\n')
    this.host.sendMessage(live.sessionId, message, coordinator.id, live.session.agentId).catch((error) => {
      console.warn(`[AgentManager] Could not tell the Captain of project ${projectId} about the queued start:`, error)
      this.projectLimitNotices.delete(key)
    })
  }
}
