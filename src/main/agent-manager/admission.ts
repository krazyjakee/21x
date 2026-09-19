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
 *
 *  - per project and agent (#150, shared/concurrency.ts): the agent's
 *    user-set hard cap (`config.concurrency_cap`) bounds its jobs across
 *    every project and replaces `max_parallel_sessions` as the agent limit;
 *    within it, the project's working level (set by its Captain, or pinned
 *    by the user) bounds that project's jobs of the agent
 *    (`concurrency_level`). A start whose declared touched files overlap a
 *    running job of the same project waits (`file_overlap`). Lowering a level
 *    only defers new starts: running sessions are never stopped by it.
 *
 * ## Queue order
 *
 * The queue is not FIFO: {@link orderStartQueue} tries starts by priority
 * within a project (FIFO within the same priority) and round robin across
 * projects, so an urgent ticket jumps its project's queue without starving
 * another project.
 */
import type { AgentRecord, TaskRecord } from '../database'
import { isCoordinatorTask } from '../../shared/task-roles'
import type { ProjectLimitReason } from '../../shared/project-policies'
import { isTriageSessionTask } from './session-config'
import { agentHardCap, orderStartQueue } from '../../shared/concurrency'

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
  /**
   * #150: the project's working level for the requested agent. Absent for a
   * task with no project, which only the hard cap bounds.
   */
  concurrencyLevel?: number
  /**
   * #150: a running job of the same project that touches the same files,
   * found by the caller (it owns the touches and branch diffs).
   */
  fileOverlap?: { taskId: string; path: string } | null
}

/** Why a start waits because of the project's working level or file overlap (#150). */
export type ConcurrencyReason = 'concurrency_level' | 'file_overlap'

export type AdmissionReason = 'agent_limit' | 'global_limit' | ProjectLimitReason | ConcurrencyReason

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

/**
 * The agent's hard cap (#150): `config.concurrency_cap`, or for an agent
 * that has none yet min(max_parallel_sessions, 5).
 */
export function agentSessionLimit(agent: Pick<AgentRecord, 'config'>): number {
  return agentHardCap(agent.config as unknown as { concurrency_cap?: unknown; max_parallel_sessions?: unknown } | undefined)
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

  // #150: the project's working level for this agent, then hot files.
  if (project && limits.concurrencyLevel !== undefined) {
    const level = Math.max(1, Math.min(limits.concurrencyLevel, agentLimit))
    const levelRunning = others.filter((s) => s.agentId === ctx.agentId && s.projectId === project.projectId).length
    if (levelRunning >= level) {
      return { admitted: false, reason: 'concurrency_level', limit: level, running: levelRunning }
    }
  }
  if (limits.fileOverlap) {
    return { admitted: false, reason: 'file_overlap', limit: 1, running: 1 }
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
  /** The task's project and priority, refreshed before every drain (#150). */
  projectId?: string
  priority?: string | null
}

/** What clients see: a queued start and its 1-based place in line. */
export interface QueuedStartInfo {
  taskId: string
  agentId: string
  reason: AdmissionReason
  queuedAt: string
  position: number
  priority?: string | null
}

/**
 * Starts waiting for a slot, at most one entry per task, in the order
 * {@link orderStartQueue} gives them: priority within a project, round
 * robin across projects (#150).
 */
export class StartQueue {
  private entries: Array<QueuedStart & { seq: number }> = []
  private seq = 0
  /** projectId → when it last had a start admitted, as a counter (#150 fairness). */
  private served = new Map<string, number>()
  private servedSeq = 0

  get size(): number {
    return this.entries.length
  }

  private ordered(): Array<QueuedStart & { seq: number }> {
    return orderStartQueue(this.entries, (projectId) => this.served.get(projectId) ?? 0)
  }

  /** Records an admitted start of the project, queued or not: it goes to the back of the round. */
  markServed(projectId: string | undefined): void {
    this.served.set(projectId ?? '', ++this.servedSeq)
  }

  /** Adds the start unless the task is already waiting; returns its position. */
  enqueue(entry: QueuedStart): { position: number; added: boolean } {
    const existing = this.positionOf(entry.taskId)
    if (existing) return { position: existing, added: false }
    this.entries.push({ ...entry, seq: ++this.seq })
    return { position: this.positionOf(entry.taskId), added: true }
  }

  remove(taskId: string): boolean {
    const index = this.entries.findIndex((e) => e.taskId === taskId)
    if (index === -1) return false
    this.entries.splice(index, 1)
    return true
  }

  /** 1-based position in drain order, or 0 when the task is not queued. */
  positionOf(taskId: string): number {
    return this.ordered().findIndex((e) => e.taskId === taskId) + 1
  }

  /**
   * Updates the project and priority of every entry (a task's priority may
   * change while it waits; a critical bump moves it up at the next drain).
   */
  refresh(lookup: (taskId: string) => { projectId?: string; priority?: string | null } | undefined): void {
    for (const entry of this.entries) {
      const found = lookup(entry.taskId)
      if (!found) continue
      entry.projectId = found.projectId
      entry.priority = found.priority
    }
  }

  /** The live entries in drain order. Iterating it while removing is safe. */
  snapshot(): QueuedStart[] {
    return this.ordered()
  }

  list(): QueuedStartInfo[] {
    return this.ordered().map((e, i) => ({
      taskId: e.taskId,
      agentId: e.agentId,
      reason: e.reason,
      queuedAt: e.queuedAt,
      position: i + 1,
      priority: e.priority ?? null
    }))
  }

  clear(): void {
    this.entries = []
    this.served.clear()
  }
}
