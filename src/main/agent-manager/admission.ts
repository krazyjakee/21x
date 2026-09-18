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
 *  - coordinator sessions (the Mastermind, `isCoordinatorTask`) — they only
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
 * Per-project limits (#65) slot into {@link checkAdmission}: the context
 * carries the task, so a project cap only needs the running sessions' tasks.
 */
import type { AgentRecord, TaskRecord } from '../database'
import { isCoordinatorTask } from '../../shared/task-roles'
import { isTriageSessionTask } from './session-config'

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
}

export interface AdmissionLimits {
  /** null = unlimited. */
  globalLimit: number | null
}

export type AdmissionReason = 'agent_limit' | 'global_limit'

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

  if (limits.globalLimit !== null && others.length >= limits.globalLimit) {
    return { admitted: false, reason: 'global_limit', limit: limits.globalLimit, running: others.length }
  }

  const agentLimit = agentSessionLimit(ctx.agent)
  const agentRunning = others.filter((s) => s.agentId === ctx.agentId).length
  if (agentRunning >= agentLimit) {
    return { admitted: false, reason: 'agent_limit', limit: agentLimit, running: agentRunning }
  }

  // #65: a per-project cap goes here, counting `others` whose task shares
  // ctx.task's project.
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

/** FIFO of starts waiting for a slot, at most one entry per task. */
export class StartQueue {
  private entries: QueuedStart[] = []

  get size(): number {
    return this.entries.length
  }

  /** Adds the start unless the task is already waiting; returns its position. */
  enqueue(entry: QueuedStart): { position: number; added: boolean } {
    const existing = this.positionOf(entry.taskId)
    if (existing) return { position: existing, added: false }
    this.entries.push(entry)
    return { position: this.entries.length, added: true }
  }

  remove(taskId: string): boolean {
    const index = this.entries.findIndex((e) => e.taskId === taskId)
    if (index === -1) return false
    this.entries.splice(index, 1)
    return true
  }

  /** 1-based position, or 0 when the task is not queued. */
  positionOf(taskId: string): number {
    return this.entries.findIndex((e) => e.taskId === taskId) + 1
  }

  /** A copy in queue order, safe to iterate while removing. */
  snapshot(): QueuedStart[] {
    return [...this.entries]
  }

  list(): QueuedStartInfo[] {
    return this.entries.map((e, i) => ({
      taskId: e.taskId,
      agentId: e.agentId,
      reason: e.reason,
      queuedAt: e.queuedAt,
      position: i + 1
    }))
  }

  clear(): void {
    this.entries = []
  }
}
