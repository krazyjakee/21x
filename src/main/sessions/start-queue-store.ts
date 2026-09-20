import { createId } from '@paralleldrive/cuid2'
import type Database from 'better-sqlite3'
import { orderStartQueue } from '../../shared/concurrency'
import type { AdmissionReason, QueuedStart } from '../agent-manager/admission'

export const START_QUEUE_MAX_RETRIES = 5
export const START_QUEUE_LEASE_MS = 60_000
export const START_QUEUE_RETRY_BASE_MS = 1_000
export const START_QUEUE_RETRY_MAX_MS = 60_000

export type StartQueueState =
  | 'queued'
  | 'retrying'
  | 'claimed'
  | 'starting'
  | 'started'
  | 'recovered'
  | 'failed'
  | 'cancelled'

interface StartQueueRow {
  id: string
  task_id: string
  project_id: string
  agent_id: string
  workspace_dir: string | null
  skip_initial_prompt: number
  priority: string
  fifo_seq: number
  dependency_reason: string | null
  admission_reason: string
  state: StartQueueState
  retry_count: number
  next_retry_at: number | null
  generation: number
  lease_owner: string | null
  lease_expires_at: number | null
  session_id: string | null
  recovery_cause: string | null
  recovery_action: string | null
  recovery_result: string | null
  last_error: string | null
  created_at: number
  queued_at: number
  claimed_at: number | null
  started_at: number | null
  acknowledged_at: number | null
  updated_at: number
}

export interface DurableQueuedStart extends QueuedStart {
  id: string
  state: StartQueueState
  seq: number
  retryCount: number
  nextRetryAt: number | null
  generation: number
  leaseOwner: string | null
  leaseExpiresAt: number | null
  sessionId: string | null
  dependencyReason: string | null
  recoveryCause: string | null
  recoveryAction: string | null
  recoveryResult: string | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface DurableQueuedStartInfo {
  id: string
  taskId: string
  projectId: string
  agentId: string
  reason: AdmissionReason
  queuedAt: string
  position: number
  priority: string | null
  state: StartQueueState
  retryCount: number
  nextRetryAt: string | null
  generation: number
  dependencyReason: string | null
  recoveryCause: string | null
  recoveryAction: string | null
  recoveryResult: string | null
  lastError: string | null
}

const ACTIVE_STATES: StartQueueState[] = ['queued', 'retrying', 'claimed', 'starting']
const DISPATCHABLE_STATES: StartQueueState[] = ['queued', 'retrying']

function fromRow(row: StartQueueRow): DurableQueuedStart {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    workspaceDir: row.workspace_dir ?? undefined,
    skipInitialPrompt: row.skip_initial_prompt === 1,
    priority: row.priority,
    seq: row.fifo_seq,
    reason: row.admission_reason as AdmissionReason,
    queuedAt: new Date(row.queued_at).toISOString(),
    state: row.state,
    retryCount: row.retry_count,
    nextRetryAt: row.next_retry_at,
    generation: row.generation,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    sessionId: row.session_id,
    dependencyReason: row.dependency_reason,
    recoveryCause: row.recovery_cause,
    recoveryAction: row.recovery_action,
    recoveryResult: row.recovery_result,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function retryDelay(id: string, attempt: number): number {
  const exponential = Math.min(START_QUEUE_RETRY_MAX_MS, START_QUEUE_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)))
  let hash = 0
  for (const char of id) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0
  const jitter = (hash % 251) / 1000 // stable 0–25% jitter; tests and restarts agree
  return Math.round(exponential * (1 + jitter))
}

/**
 * SQLite-backed admission queue. Structural DB doubles fall back to the same
 * state machine in memory, but production never reports queued until the SQL
 * transaction that created or refreshed its stable row has committed.
 */
export class DurableStartQueueStore {
  private readonly memory = new Map<string, DurableQueuedStart>()
  private memorySeq = 0
  private memoryServed = new Map<string, number>()
  private memoryServedSeq = 0

  constructor(
    private readonly source: { db: Database.Database },
    private readonly now: () => number = Date.now
  ) {}

  private get persistent(): boolean {
    return Boolean(this.source.db && typeof this.source.db.prepare === 'function')
  }

  get size(): number {
    return this.active().length
  }

  get(taskId: string): DurableQueuedStart | null {
    if (!this.persistent) return this.memory.get(taskId) ?? null
    const row = this.source.db.prepare('SELECT * FROM agent_start_queue WHERE task_id = ?').get(taskId) as StartQueueRow | undefined
    return row ? fromRow(row) : null
  }

  active(): DurableQueuedStart[] {
    if (!this.persistent) return [...this.memory.values()].filter((row) => ACTIVE_STATES.includes(row.state))
    const rows = this.source.db.prepare(`
      SELECT * FROM agent_start_queue
      WHERE state IN ('queued', 'retrying', 'claimed', 'starting')
    `).all() as StartQueueRow[]
    return rows.map(fromRow)
  }

  private served(projectId: string): number {
    if (!this.persistent) return this.memoryServed.get(projectId) ?? 0
    const row = this.source.db.prepare('SELECT served_seq FROM agent_start_queue_fairness WHERE project_id = ?')
      .get(projectId) as { served_seq: number } | undefined
    return row?.served_seq ?? 0
  }

  private ordered(rows = this.active()): DurableQueuedStart[] {
    return orderStartQueue(rows, (projectId) => this.served(projectId))
  }

  list(): DurableQueuedStartInfo[] {
    return this.ordered().map((row, index) => this.toInfo(row, index + 1))
  }

  info(taskId: string): DurableQueuedStartInfo | null {
    const row = this.get(taskId)
    return row ? this.toInfo(row, ACTIVE_STATES.includes(row.state) ? this.positionOf(taskId) : 0) : null
  }

  private toInfo(row: DurableQueuedStart, position: number): DurableQueuedStartInfo {
    return {
      id: row.id,
      taskId: row.taskId,
      projectId: row.projectId ?? '',
      agentId: row.agentId,
      reason: row.reason,
      queuedAt: row.queuedAt,
      position,
      priority: row.priority ?? null,
      state: row.state,
      retryCount: row.retryCount,
      nextRetryAt: row.nextRetryAt === null ? null : new Date(row.nextRetryAt).toISOString(),
      generation: row.generation,
      dependencyReason: row.dependencyReason,
      recoveryCause: row.recoveryCause,
      recoveryAction: row.recoveryAction,
      recoveryResult: row.recoveryResult,
      lastError: row.lastError
    }
  }

  snapshot(): DurableQueuedStart[] {
    return this.ordered(this.active().filter((row) => DISPATCHABLE_STATES.includes(row.state)))
  }

  positionOf(taskId: string): number {
    return this.ordered().findIndex((row) => row.taskId === taskId) + 1
  }

  enqueue(entry: QueuedStart & { projectId: string; dependencyReason?: string | null }): { position: number; added: boolean; record: DurableQueuedStart } {
    const existing = this.get(entry.taskId)
    if (existing && ACTIVE_STATES.includes(existing.state)) {
      return { position: this.positionOf(entry.taskId), added: false, record: existing }
    }
    const ts = this.now()
    const queuedAt = Date.parse(entry.queuedAt) || ts
    if (!this.persistent) {
      const record: DurableQueuedStart = {
        id: existing?.id ?? createId(),
        ...entry,
        seq: ++this.memorySeq,
        state: 'queued',
        retryCount: 0,
        nextRetryAt: null,
        generation: (existing?.generation ?? 0) + 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        sessionId: null,
        dependencyReason: entry.dependencyReason ?? null,
        recoveryCause: null,
        recoveryAction: null,
        recoveryResult: null,
        lastError: null,
        createdAt: existing?.createdAt ?? ts,
        updatedAt: ts
      }
      this.memory.set(entry.taskId, record)
      return { position: this.positionOf(entry.taskId), added: true, record }
    }
    const write = this.source.db.transaction(() => {
      const seq = ((this.source.db.prepare('SELECT COALESCE(MAX(fifo_seq), 0) AS value FROM agent_start_queue').get() as { value: number }).value ?? 0) + 1
      const id = existing?.id ?? createId()
      this.source.db.prepare(`
        INSERT INTO agent_start_queue
          (id, task_id, project_id, agent_id, workspace_dir, skip_initial_prompt,
           priority, fifo_seq, dependency_reason, admission_reason, state,
           retry_count, next_retry_at, generation, lease_owner, lease_expires_at,
           session_id, recovery_cause, recovery_action, recovery_result, last_error,
           created_at, queued_at, claimed_at, started_at, acknowledged_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, ?, NULL, NULL,
                NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          project_id = excluded.project_id,
          agent_id = excluded.agent_id,
          workspace_dir = excluded.workspace_dir,
          skip_initial_prompt = excluded.skip_initial_prompt,
          priority = excluded.priority,
          fifo_seq = excluded.fifo_seq,
          dependency_reason = excluded.dependency_reason,
          admission_reason = excluded.admission_reason,
          state = 'queued', retry_count = 0, next_retry_at = NULL,
          generation = excluded.generation, lease_owner = NULL,
          lease_expires_at = NULL, session_id = NULL,
          recovery_cause = NULL, recovery_action = NULL, recovery_result = NULL,
          last_error = NULL, queued_at = excluded.queued_at, claimed_at = NULL,
          started_at = NULL, acknowledged_at = NULL, updated_at = excluded.updated_at
      `).run(
        id, entry.taskId, entry.projectId, entry.agentId, entry.workspaceDir ?? null,
        entry.skipInitialPrompt ? 1 : 0, entry.priority ?? 'medium', seq,
        entry.dependencyReason ?? null, entry.reason, (existing?.generation ?? 0) + 1,
        existing?.createdAt ?? ts, queuedAt, ts
      )
    })
    write()
    const record = this.get(entry.taskId)!
    return { position: this.positionOf(entry.taskId), added: true, record }
  }

  refresh(lookup: (taskId: string) => { projectId?: string; priority?: string | null } | undefined): void {
    for (const row of this.active()) {
      const found = lookup(row.taskId)
      if (!found) continue
      const projectId = found.projectId ?? row.projectId
      const priority = found.priority ?? row.priority ?? 'medium'
      if (!this.persistent) {
        this.memory.set(row.taskId, { ...row, projectId, priority })
      } else {
        this.source.db.prepare('UPDATE agent_start_queue SET project_id = ?, priority = ?, updated_at = ? WHERE id = ?')
          .run(projectId, priority, this.now(), row.id)
      }
    }
  }

  updateReason(id: string, reason: AdmissionReason, dependencyReason: string | null = null): boolean {
    const row = this.active().find((item) => item.id === id)
    if (!row || row.reason === reason && row.dependencyReason === dependencyReason) return false
    if (!this.persistent) this.memory.set(row.taskId, { ...row, reason, dependencyReason, updatedAt: this.now() })
    else this.source.db.prepare('UPDATE agent_start_queue SET admission_reason = ?, dependency_reason = ?, updated_at = ? WHERE id = ?')
      .run(reason, dependencyReason, this.now(), id)
    return true
  }

  markServed(projectId: string | undefined): void {
    const key = projectId ?? ''
    const ts = this.now()
    if (!this.persistent) {
      this.memoryServed.set(key, ++this.memoryServedSeq)
      return
    }
    const seq = ((this.source.db.prepare('SELECT COALESCE(MAX(served_seq), 0) AS value FROM agent_start_queue_fairness').get() as { value: number }).value ?? 0) + 1
    this.source.db.prepare(`
      INSERT INTO agent_start_queue_fairness (project_id, served_seq, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET served_seq = excluded.served_seq, updated_at = excluded.updated_at
    `).run(key, seq, ts)
  }

  claim(taskId: string, leaseOwner: string): DurableQueuedStart | null {
    const row = this.get(taskId)
    const ts = this.now()
    if (!row || !DISPATCHABLE_STATES.includes(row.state) || (row.nextRetryAt !== null && row.nextRetryAt > ts)) return null
    const generation = row.generation + 1
    if (!this.persistent) {
      const next = { ...row, state: 'claimed' as const, generation, leaseOwner, leaseExpiresAt: ts + START_QUEUE_LEASE_MS, updatedAt: ts }
      this.memory.set(taskId, next)
      return next
    }
    const result = this.source.db.prepare(`
      UPDATE agent_start_queue SET state = 'claimed', generation = ?, lease_owner = ?,
        lease_expires_at = ?, claimed_at = ?, updated_at = ?
      WHERE id = ? AND generation = ? AND state IN ('queued', 'retrying')
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
    `).run(generation, leaseOwner, ts + START_QUEUE_LEASE_MS, ts, ts, row.id, row.generation, ts)
    return result.changes ? this.get(taskId) : null
  }

  markStarting(id: string, generation: number): boolean {
    return this.transitionClaim(id, generation, 'starting', { action: 'start_session', result: 'start_invoked' })
  }

  acknowledgeStarted(id: string, generation: number, sessionId: string): boolean {
    const ts = this.now()
    if (!this.persistent) {
      const row = [...this.memory.values()].find((item) => item.id === id)
      if (!row || row.generation !== generation || !['claimed', 'starting'].includes(row.state)) return false
      this.memory.set(row.taskId, { ...row, state: 'started', sessionId, leaseOwner: null, leaseExpiresAt: null, recoveryResult: 'session_acknowledged', updatedAt: ts })
      return true
    }
    return this.source.db.prepare(`
      UPDATE agent_start_queue SET state = 'started', session_id = ?, lease_owner = NULL,
        lease_expires_at = NULL, started_at = COALESCE(started_at, ?), acknowledged_at = ?,
        recovery_result = 'session_acknowledged', updated_at = ?
      WHERE id = ? AND generation = ? AND state IN ('claimed', 'starting')
    `).run(sessionId, ts, ts, ts, id, generation).changes === 1
  }

  markRecovered(taskId: string, sessionId: string, cause: string, result = 'live_session_reclaimed'): boolean {
    const row = this.get(taskId)
    if (!row || !ACTIVE_STATES.includes(row.state) && row.state !== 'started') return false
    const ts = this.now()
    if (!this.persistent) {
      this.memory.set(taskId, { ...row, state: 'recovered', sessionId, leaseOwner: null, leaseExpiresAt: null, recoveryCause: cause, recoveryAction: 'resume_session', recoveryResult: result, updatedAt: ts })
      return true
    }
    return this.source.db.prepare(`
      UPDATE agent_start_queue SET state = 'recovered', session_id = ?, lease_owner = NULL,
        lease_expires_at = NULL, recovery_cause = ?, recovery_action = 'resume_session',
        recovery_result = ?, acknowledged_at = ?, updated_at = ? WHERE id = ?
    `).run(sessionId, cause, result, ts, ts, row.id).changes === 1
  }

  failOrRetry(id: string, generation: number, error: string, cause = 'recoverable_start_failure'):
    { state: 'retrying' | 'failed'; record: DurableQueuedStart } | null {
    const row = this.active().find((item) => item.id === id)
    if (!row || row.generation !== generation || !['claimed', 'starting'].includes(row.state)) return null
    const attempt = row.retryCount + 1
    const exhausted = attempt > START_QUEUE_MAX_RETRIES
    const ts = this.now()
    const state = exhausted ? 'failed' : 'retrying'
    const nextRetryAt = exhausted ? null : ts + retryDelay(row.id, attempt)
    const result = exhausted ? `retry_exhausted_after_${START_QUEUE_MAX_RETRIES}` : `retry_scheduled_${attempt}_of_${START_QUEUE_MAX_RETRIES}`
    if (!this.persistent) {
      this.memory.set(row.taskId, {
        ...row, state, retryCount: attempt, nextRetryAt, leaseOwner: null,
        leaseExpiresAt: null, recoveryCause: cause, recoveryAction: exhausted ? 'terminal_failure' : 'retry',
        recoveryResult: result, lastError: error, updatedAt: ts
      })
    } else {
      this.source.db.prepare(`
        UPDATE agent_start_queue SET state = ?, retry_count = ?, next_retry_at = ?,
          lease_owner = NULL, lease_expires_at = NULL, recovery_cause = ?,
          recovery_action = ?, recovery_result = ?, last_error = ?, updated_at = ?
        WHERE id = ? AND generation = ? AND state IN ('claimed', 'starting')
      `).run(state, attempt, nextRetryAt, cause, exhausted ? 'terminal_failure' : 'retry', result, error, ts, id, generation)
    }
    return { state, record: this.get(row.taskId)! }
  }

  requeueInterrupted(record: DurableQueuedStart, cause: string): DurableQueuedStart | null {
    if (!['claimed', 'starting'].includes(record.state)) return null
    return this.failOrRetry(record.id, record.generation, 'The previous process ended before the start was acknowledged.', cause)?.record ?? null
  }

  interruptedClaims(leaseOwner: string): DurableQueuedStart[] {
    const ts = this.now()
    return this.active().filter((row) =>
      ['claimed', 'starting'].includes(row.state)
      && (row.leaseOwner !== leaseOwner || (row.leaseExpiresAt ?? 0) <= ts)
    )
  }

  cancel(taskId: string, cause: string, result: string, error?: string): boolean {
    return this.terminal(taskId, 'cancelled', cause, 'exclude_from_retry', result, error)
  }

  fail(taskId: string, cause: string, result: string, error?: string): boolean {
    return this.terminal(taskId, 'failed', cause, 'terminal_failure', result, error)
  }

  private terminal(taskId: string, state: 'cancelled' | 'failed', cause: string, action: string, result: string, error?: string): boolean {
    const row = this.get(taskId)
    if (!row || ![...ACTIVE_STATES, 'started', 'recovered'].includes(row.state)) return false
    const ts = this.now()
    if (!this.persistent) {
      this.memory.set(taskId, { ...row, state, leaseOwner: null, leaseExpiresAt: null, recoveryCause: cause, recoveryAction: action, recoveryResult: result, lastError: error ?? row.lastError, updatedAt: ts })
      return true
    }
    return this.source.db.prepare(`
      UPDATE agent_start_queue SET state = ?, lease_owner = NULL, lease_expires_at = NULL,
        recovery_cause = ?, recovery_action = ?, recovery_result = ?, last_error = ?,
        acknowledged_at = ?, updated_at = ?
      WHERE id = ? AND state IN ('queued', 'retrying', 'claimed', 'starting', 'started', 'recovered')
    `).run(state, cause, action, result, error ?? row.lastError, ts, ts, row.id).changes === 1
  }

  private transitionClaim(id: string, generation: number, state: 'starting', audit: { action: string; result: string }): boolean {
    const ts = this.now()
    if (!this.persistent) {
      const row = [...this.memory.values()].find((item) => item.id === id)
      if (!row || row.generation !== generation || row.state !== 'claimed') return false
      this.memory.set(row.taskId, { ...row, state, recoveryAction: audit.action, recoveryResult: audit.result, updatedAt: ts })
      return true
    }
    return this.source.db.prepare(`
      UPDATE agent_start_queue SET state = ?, recovery_action = ?, recovery_result = ?,
        started_at = ?, updated_at = ? WHERE id = ? AND generation = ? AND state = 'claimed'
    `).run(state, audit.action, audit.result, ts, ts, id, generation).changes === 1
  }
}
