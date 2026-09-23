import type Database from 'better-sqlite3'
import { createId } from '@paralleldrive/cuid2'
import type { UsageSource } from './token-estimator'

/**
 * The managed-session ledger (managed sessions B3, #99): the
 * `session_generations`, `session_turns` and `session_summaries` tables
 * (session-ledger-migration.ts). See docs/managed-sessions.md.
 *
 * Every state change is one SQLite transaction. Every write is idempotent:
 * - an event is recorded once per owner and `dedupe_key`; delivering it again
 *   returns the existing turn (`inserted: false`) and changes nothing;
 * - a turn leaves `queued`/`running` exactly once; finishing a finished turn
 *   is a no-op;
 * - a tool call is keyed by its id within its turn;
 * - usage is linked by `session_usage.turn_key` and re-summed, never added;
 * - a summary is keyed by (generation, `dedupe_key`).
 *
 * `runner_id` fences crash recovery: `recoverInterrupted()` only touches
 * turns another process left `queued` or `running`, so it can never interrupt
 * a turn this process has already started.
 */

export type SessionOwnerKind = 'commander' | 'captain' | 'task'
export interface SessionOwner {
  kind: SessionOwnerKind
  /** A Commander session id, or the task id of a Captain or task agent. */
  id: string
}
export type SessionEngine = 'chat' | 'adapter'
export type TurnTrigger = 'user' | 'report' | 'wake' | 'subtask_done' | 'schedule' | 'nudge' | 'start' | 'system'
export type TurnStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'dropped' | 'coalesced'
export type GenerationEndReason = 'rollover' | 'lost' | 'replaced' | 'closed'
export type SummaryKind = 'fold' | 'handoff' | 'failed'
export type SummaryStatus = 'pending' | 'done' | 'degraded'
export type ToolCallStatus = 'running' | 'done' | 'error' | 'interrupted'

/** The turn states that are over. A turn in one of them never changes status again. */
export const TERMINAL_TURN_STATUSES: ReadonlySet<TurnStatus> = new Set(['done', 'failed', 'interrupted', 'dropped', 'coalesced'])

/** This process. Turns it runs carry it, so recovery after a crash can tell them apart. */
export const LEDGER_RUNNER_ID = `runner-${createId()}`

export interface GenerationInfo {
  engine: SessionEngine
  /** The chat provider id or the coding agent type. */
  provider?: string | null
  model?: string | null
  /** The backend's own session id (adapters). A different id than the open generation's opens a new one. */
  backendSessionId?: string | null
}

export interface GenerationRecord {
  id: string
  owner: SessionOwner
  n: number
  engine: SessionEngine
  provider: string | null
  model: string | null
  backendSessionId: string | null
  startedAt: number
  endedAt: number | null
  endReason: GenerationEndReason | null
  seedHandoffId: string | null
}

export interface ToolCallRecord {
  id: string
  name: string
  status: ToolCallStatus
  startedAt: number
  endedAt: number | null
}

export interface TurnRecord {
  id: string
  owner: SessionOwner
  generationId: string
  seq: number
  trigger: TurnTrigger
  dedupeKey: string
  status: TurnStatus
  coalescedInto: string | null
  attempts: number
  runnerId: string | null
  toolCalls: ToolCallRecord[]
  usageKeys: string[]
  inputTokens: number | null
  outputTokens: number | null
  contextTokensAfter: number | null
  usageSource: UsageSource | null
  stopReason: string | null
  errorKind: string | null
  errorDetail: string | null
  queuedAt: number
  startedAt: number | null
  endedAt: number | null
  updatedAt: number
}

export interface SummaryRecord {
  id: string
  generationId: string
  kind: SummaryKind
  status: SummaryStatus
  dedupeKey: string
  coversThroughRef: string | null
  content: unknown
  createdAt: number
  updatedAt: number
}

export interface TurnInput {
  dedupeKey: string
  trigger: TurnTrigger
  generation: GenerationInfo
}

export interface RecordedTurn {
  turn: TurnRecord
  /** False when the event was already recorded: nothing changed. */
  inserted: boolean
}

export interface RecoveryReport {
  /** The turns another process left queued or running, now `interrupted`. */
  interrupted: TurnRecord[]
  /** Tool calls of those turns that never finished, now `interrupted`. */
  closedToolCalls: number
}

interface GenerationRow {
  id: string
  owner_kind: SessionOwnerKind
  owner_id: string
  n: number
  engine: SessionEngine
  provider: string | null
  model: string | null
  backend_session_id: string | null
  started_at: number
  ended_at: number | null
  end_reason: GenerationEndReason | null
  seed_handoff_id: string | null
}

interface TurnRow {
  id: string
  owner_kind: SessionOwnerKind
  owner_id: string
  generation_id: string
  seq: number
  trigger_kind: TurnTrigger
  dedupe_key: string
  status: TurnStatus
  coalesced_into: string | null
  attempts: number
  runner_id: string | null
  tool_calls: string
  usage_keys: string
  input_tokens: number | null
  output_tokens: number | null
  context_tokens_after: number | null
  usage_source: UsageSource | null
  stop_reason: string | null
  error_kind: string | null
  error_detail: string | null
  queued_at: number
  started_at: number | null
  ended_at: number | null
  updated_at: number
}

interface SummaryRow {
  id: string
  generation_id: string
  kind: SummaryKind
  status: SummaryStatus
  dedupe_key: string
  covers_through_ref: string | null
  content_json: string
  created_at: number
  updated_at: number
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

function generation(row: GenerationRow): GenerationRecord {
  return {
    id: row.id,
    owner: { kind: row.owner_kind, id: row.owner_id },
    n: row.n,
    engine: row.engine,
    provider: row.provider,
    model: row.model,
    backendSessionId: row.backend_session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    seedHandoffId: row.seed_handoff_id
  }
}

function turn(row: TurnRow): TurnRecord {
  return {
    id: row.id,
    owner: { kind: row.owner_kind, id: row.owner_id },
    generationId: row.generation_id,
    seq: row.seq,
    trigger: row.trigger_kind,
    dedupeKey: row.dedupe_key,
    status: row.status,
    coalescedInto: row.coalesced_into,
    attempts: row.attempts,
    runnerId: row.runner_id,
    toolCalls: parseJson<ToolCallRecord[]>(row.tool_calls, []),
    usageKeys: parseJson<string[]>(row.usage_keys, []),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    contextTokensAfter: row.context_tokens_after,
    usageSource: row.usage_source,
    stopReason: row.stop_reason,
    errorKind: row.error_kind,
    errorDetail: row.error_detail,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    updatedAt: row.updated_at
  }
}

function summary(row: SummaryRow): SummaryRecord {
  return {
    id: row.id,
    generationId: row.generation_id,
    kind: row.kind,
    status: row.status,
    dedupeKey: row.dedupe_key,
    coversThroughRef: row.covers_through_ref,
    content: parseJson<unknown>(row.content_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** `captain:task-1`: the key a lock, a queue or a log line uses for an owner. */
export function ownerKey(owner: SessionOwner): string {
  return `${owner.kind}:${owner.id}`
}

/** Error text stored on a turn is bounded; provider errors can be long. */
const MAX_ERROR_DETAIL = 2_000

function isUnfinished(status: TurnStatus): boolean {
  return status === 'queued' || status === 'running'
}

export class SessionLedger {
  private readonly runnerId: string

  constructor(
    private readonly source: { db: Database.Database },
    private readonly now: () => number = Date.now,
    options: { runnerId?: string } = {}
  ) {
    this.runnerId = options.runnerId ?? LEDGER_RUNNER_ID
  }

  private get db(): Database.Database {
    return this.source.db
  }

  // ── Generations ─────────────────────────────────────────────

  currentGeneration(owner: SessionOwner): GenerationRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM session_generations WHERE owner_kind = ? AND owner_id = ? AND ended_at IS NULL
    `).get(owner.kind, owner.id) as GenerationRow | undefined
    return row ? generation(row) : null
  }

  getGeneration(id: string): GenerationRecord | null {
    const row = this.db.prepare('SELECT * FROM session_generations WHERE id = ?').get(id) as GenerationRow | undefined
    return row ? generation(row) : null
  }

  /** Oldest first. */
  listGenerations(owner: SessionOwner): GenerationRecord[] {
    return (this.db.prepare(`
      SELECT * FROM session_generations WHERE owner_kind = ? AND owner_id = ? ORDER BY n
    `).all(owner.kind, owner.id) as GenerationRow[]).map(generation)
  }

  /**
   * The owner's open generation, opening generation 1 (or n+1) when there is
   * none. A backend session id different from the open generation's means
   * the backend conversation was replaced: the open generation ends
   * (`replaced`) and a new one starts. An open generation without a backend
   * id takes the one given; a provider or model it lacks is filled in.
   */
  ensureGeneration(owner: SessionOwner, info: GenerationInfo): GenerationRecord {
    return this.db.transaction(() => this.ensureGenerationNow(owner, info))()
  }

  private ensureGenerationNow(owner: SessionOwner, info: GenerationInfo): GenerationRecord {
    const ts = this.now()
    const open = this.currentGeneration(owner)
    const backendId = info.backendSessionId || null
    if (open) {
      if (!backendId || !open.backendSessionId || open.backendSessionId === backendId) {
        if ((backendId && !open.backendSessionId) || (info.provider && !open.provider) || (info.model && !open.model)) {
          this.db.prepare(`
            UPDATE session_generations SET
              backend_session_id = COALESCE(backend_session_id, ?),
              provider = COALESCE(provider, ?),
              model = COALESCE(model, ?)
            WHERE id = ?
          `).run(backendId, info.provider || null, info.model || null, open.id)
          return this.getGeneration(open.id)!
        }
        return open
      }
      this.endGeneration(open.id, 'replaced', ts)
    }
    return this.openGeneration(owner, info, ts)
  }

  private openGeneration(owner: SessionOwner, info: GenerationInfo, ts: number, seedHandoffId: string | null = null): GenerationRecord {
    const next = (this.db.prepare(`
      SELECT COALESCE(MAX(n), 0) + 1 AS n FROM session_generations WHERE owner_kind = ? AND owner_id = ?
    `).get(owner.kind, owner.id) as { n: number }).n
    const row = this.db.prepare(`
      INSERT INTO session_generations (id, owner_kind, owner_id, n, engine, provider, model, backend_session_id, started_at, seed_handoff_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(createId(), owner.kind, owner.id, next, info.engine, info.provider || null, info.model || null, info.backendSessionId || null, ts, seedHandoffId) as GenerationRow
    console.log(`[ManagedSession] owner=${ownerKey(owner)} gen=${next} event=generation_opened engine=${info.engine}${info.backendSessionId ? ` backend=${info.backendSessionId}` : ''}`)
    return generation(row)
  }

  private endGeneration(id: string, reason: GenerationEndReason, ts: number): void {
    const row = this.db.prepare(`
      UPDATE session_generations SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL RETURNING *
    `).get(ts, reason, id) as GenerationRow | undefined
    if (row) console.log(`[ManagedSession] owner=${row.owner_kind}:${row.owner_id} gen=${row.n} event=generation_closed reason=${reason}`)
  }

  /**
   * Ends the owner's open generation and, unless `next` is null, opens the
   * following one (optionally seeded by a handoff summary). Returns the new
   * generation, or null when none was opened.
   */
  closeGeneration(owner: SessionOwner, reason: GenerationEndReason, next: (GenerationInfo & { seedHandoffId?: string | null }) | null = null): GenerationRecord | null {
    return this.db.transaction(() => {
      const ts = this.now()
      const open = this.currentGeneration(owner)
      if (open) this.endGeneration(open.id, reason, ts)
      return next ? this.openGeneration(owner, next, ts, next.seedHandoffId ?? null) : null
    })()
  }

  /** The backend gave a temporary session its real id: the open generation follows it. */
  rekeyBackendSession(owner: SessionOwner, oldId: string, newId: string): void {
    if (!oldId || !newId || oldId === newId) return
    this.db.prepare(`
      UPDATE session_generations SET backend_session_id = ?
      WHERE owner_kind = ? AND owner_id = ? AND ended_at IS NULL AND backend_session_id = ?
    `).run(newId, owner.kind, owner.id, oldId)
  }

  // ── Turns ───────────────────────────────────────────────────

  getTurn(id: string): TurnRecord | null {
    const row = this.db.prepare('SELECT * FROM session_turns WHERE id = ?').get(id) as TurnRow | undefined
    return row ? turn(row) : null
  }

  getTurnByKey(owner: SessionOwner, dedupeKey: string): TurnRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM session_turns WHERE owner_kind = ? AND owner_id = ? AND dedupe_key = ?
    `).get(owner.kind, owner.id, dedupeKey) as TurnRow | undefined
    return row ? turn(row) : null
  }

  /** Newest first, by `seq`. */
  listTurns(owner: SessionOwner, limit = 100): TurnRecord[] {
    return (this.db.prepare(`
      SELECT * FROM session_turns WHERE owner_kind = ? AND owner_id = ? ORDER BY seq DESC LIMIT ?
    `).all(owner.kind, owner.id, Math.max(1, Math.min(1000, Math.floor(limit)))) as TurnRow[]).map(turn)
  }

  /** Records an event in `status`, unless its key was already recorded for the owner. */
  private insertTurn(owner: SessionOwner, input: TurnInput, status: TurnStatus, extra: { coalescedInto?: string | null; errorKind?: string | null; errorDetail?: string | null } = {}): RecordedTurn {
    const existing = this.getTurnByKey(owner, input.dedupeKey)
    if (existing) return { turn: existing, inserted: false }
    const ts = this.now()
    const gen = this.ensureGenerationNow(owner, input.generation)
    const seq = (this.db.prepare(`
      SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM session_turns WHERE owner_kind = ? AND owner_id = ?
    `).get(owner.kind, owner.id) as { seq: number }).seq
    const running = status === 'running'
    const terminal = TERMINAL_TURN_STATUSES.has(status)
    const row = this.db.prepare(`
      INSERT INTO session_turns (
        id, owner_kind, owner_id, generation_id, seq, trigger_kind, dedupe_key, status, coalesced_into,
        attempts, runner_id, error_kind, error_detail, queued_at, started_at, ended_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      createId(), owner.kind, owner.id, gen.id, seq, input.trigger, input.dedupeKey, status, extra.coalescedInto ?? null,
      running ? 1 : 0, this.runnerId, extra.errorKind ?? null, extra.errorDetail?.slice(0, MAX_ERROR_DETAIL) ?? null,
      ts, running ? ts : null, terminal ? ts : null, ts
    ) as TurnRow
    return { turn: turn(row), inserted: true }
  }

  /** An event is waiting for its turn (the inbox). */
  enqueueTurn(owner: SessionOwner, input: TurnInput): RecordedTurn {
    return this.db.transaction(() => this.insertTurn(owner, input, 'queued'))()
  }

  /**
   * A turn starts now. A queued turn with the same key is promoted. With
   * `retry`, a failed or interrupted turn with the same key runs again (its
   * `attempts` grows): the same event, delivered once more after a failure.
   * Any other existing turn is left as it is (`inserted: false`,
   * `started: false`): a repeated event is a no-op.
   */
  beginTurn(owner: SessionOwner, input: TurnInput & { retry?: boolean }): RecordedTurn & { retried: boolean; started: boolean } {
    return this.db.transaction(() => {
      const existing = this.getTurnByKey(owner, input.dedupeKey)
      if (!existing) return { ...this.insertTurn(owner, input, 'running'), retried: false, started: true }
      if (existing.status === 'queued') {
        const started = this.startTurnNow(existing.id)
        return { turn: started ?? existing, inserted: false, retried: false, started: started !== null }
      }
      if (input.retry && (existing.status === 'failed' || existing.status === 'interrupted')) {
        const ts = this.now()
        const gen = this.ensureGenerationNow(owner, input.generation)
        const row = this.db.prepare(`
          UPDATE session_turns SET status = 'running', generation_id = ?, attempts = attempts + 1, runner_id = ?,
            started_at = ?, ended_at = NULL, error_kind = NULL, error_detail = NULL, stop_reason = NULL, updated_at = ?
          WHERE id = ? RETURNING *
        `).get(gen.id, this.runnerId, ts, ts, existing.id) as TurnRow
        return { turn: turn(row), inserted: false, retried: true, started: true }
      }
      return { turn: existing, inserted: false, retried: false, started: false }
    })()
  }

  private startTurnNow(id: string): TurnRecord | null {
    const ts = this.now()
    const row = this.db.prepare(`
      UPDATE session_turns SET status = 'running', attempts = attempts + 1, runner_id = ?, started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'queued' RETURNING *
    `).get(this.runnerId, ts, ts, id) as TurnRow | undefined
    return row ? turn(row) : null
  }

  /** A queued turn starts. Null when it is not queued (already started or over). */
  startTurn(id: string): TurnRecord | null {
    return this.startTurnNow(id)
  }

  /** An event that will not run (a stale wake-up, a cancelled delivery). Recorded once. */
  recordDropped(owner: SessionOwner, input: TurnInput & { reason: string }): RecordedTurn {
    return this.db.transaction(() => this.insertTurn(owner, input, 'dropped', { errorKind: 'dropped', errorDetail: input.reason }))()
  }

  /** An event merged into another queued turn (`into`). Recorded once. */
  recordCoalesced(owner: SessionOwner, input: TurnInput & { into: string }): RecordedTurn {
    return this.db.transaction(() => this.insertTurn(owner, input, 'coalesced', { coalescedInto: input.into }))()
  }

  /** Drops a queued turn that will not run. Null when it is not queued. */
  dropQueued(id: string, reason: string): TurnRecord | null {
    const ts = this.now()
    const row = this.db.prepare(`
      UPDATE session_turns SET status = 'dropped', error_kind = 'dropped', error_detail = ?, ended_at = ?, updated_at = ?
      WHERE id = ? AND status = 'queued' RETURNING *
    `).get(reason.slice(0, MAX_ERROR_DETAIL), ts, ts, id) as TurnRow | undefined
    return row ? turn(row) : null
  }

  private writeToolCalls(id: string, calls: ToolCallRecord[]): void {
    this.db.prepare('UPDATE session_turns SET tool_calls = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(calls), this.now(), id)
  }

  /** A tool call of a running turn started. A call already recorded is left alone. */
  toolCallStarted(turnId: string, call: { id: string; name: string }): void {
    this.db.transaction(() => {
      const current = this.getTurn(turnId)
      if (!current || !isUnfinished(current.status)) return
      if (current.toolCalls.some((c) => c.id === call.id)) return
      this.writeToolCalls(turnId, [...current.toolCalls, { id: call.id, name: call.name, status: 'running', startedAt: this.now(), endedAt: null }])
    })()
  }

  /** A tool call of a running turn finished. A call already finished is left alone; an unseen one is added. */
  toolCallFinished(turnId: string, call: { id: string; name?: string; isError?: boolean }): void {
    this.db.transaction(() => {
      const current = this.getTurn(turnId)
      if (!current || !isUnfinished(current.status)) return
      const ts = this.now()
      const status: ToolCallStatus = call.isError ? 'error' : 'done'
      const known = current.toolCalls.find((c) => c.id === call.id)
      if (known && known.status !== 'running') return
      const calls = known
        ? current.toolCalls.map((c) => (c.id === call.id ? { ...c, status, endedAt: ts } : c))
        : [...current.toolCalls, { id: call.id, name: call.name ?? 'unknown', status, startedAt: ts, endedAt: ts }]
      this.writeToolCalls(turnId, calls)
    })()
  }

  /**
   * A queued or running turn ends. Tool calls still running are closed as
   * `interrupted`. Null (and nothing changes) when the turn was already over.
   */
  finishTurn(turnId: string, outcome: { status: 'done' | 'failed' | 'interrupted'; stopReason?: string | null; errorKind?: string | null; errorDetail?: string | null }): TurnRecord | null {
    const finished = this.db.transaction(() => {
      const current = this.getTurn(turnId)
      if (!current || !isUnfinished(current.status)) return null
      const ts = this.now()
      const calls = current.toolCalls.map((c) => (c.status === 'running' ? { ...c, status: 'interrupted' as const, endedAt: ts } : c))
      const row = this.db.prepare(`
        UPDATE session_turns SET status = ?, stop_reason = ?, error_kind = ?, error_detail = ?, tool_calls = ?, ended_at = ?, updated_at = ?
        WHERE id = ? RETURNING *
      `).get(
        outcome.status, outcome.stopReason ?? null, outcome.errorKind ?? null, outcome.errorDetail?.slice(0, MAX_ERROR_DETAIL) ?? null,
        JSON.stringify(calls), ts, ts, turnId
      ) as TurnRow
      return turn(row)
    })()
    if (finished) console.log(formatTurnLog(finished))
    return finished
  }

  /**
   * Links a `session_usage` row (by its `turn_key`) to the turn and re-sums
   * the turn's token figures from every linked row. Linking the same key
   * again only re-reads it, so a replayed or updated report is never counted
   * twice. Allowed after the turn ended: usage can arrive late.
   */
  attachUsage(turnId: string, usageTurnKey: string): TurnRecord | null {
    if (!usageTurnKey) return this.getTurn(turnId)
    return this.db.transaction(() => {
      const current = this.getTurn(turnId)
      if (!current) return null
      const keys = current.usageKeys.includes(usageTurnKey) ? current.usageKeys : [...current.usageKeys, usageTurnKey]
      const rows = this.db.prepare(`
        SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, context_tokens, usage_source
        FROM session_usage
        WHERE owner_kind = ? AND owner_id = ? AND turn_key IN (SELECT value FROM json_each(?))
        ORDER BY updated_at, rowid
      `).all(current.owner.kind, current.owner.id, JSON.stringify(keys)) as Array<{
        input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number
        context_tokens: number | null; usage_source: UsageSource
      }>
      let input: number | null = null
      let output: number | null = null
      let context: number | null = current.contextTokensAfter
      let source: UsageSource | null = null
      for (const r of rows) {
        // Everything the model read, cache included: the figure a budget compares.
        input = (input ?? 0) + r.input_tokens + r.cache_read_tokens + r.cache_write_tokens
        output = (output ?? 0) + r.output_tokens
        if (r.context_tokens !== null) context = r.context_tokens
        source = source === 'estimated' || r.usage_source === 'estimated' ? 'estimated' : 'reported'
      }
      const row = this.db.prepare(`
        UPDATE session_turns SET usage_keys = ?, input_tokens = ?, output_tokens = ?, context_tokens_after = ?, usage_source = ?, updated_at = ?
        WHERE id = ? RETURNING *
      `).get(JSON.stringify(keys), input, output, context, source, this.now(), turnId) as TurnRow
      return turn(row)
    })()
  }

  // ── Summaries ───────────────────────────────────────────────

  /** Records a summary of a generation, once per (generation, `dedupeKey`). */
  recordSummary(generationId: string, input: { kind: SummaryKind; dedupeKey: string; status?: SummaryStatus; coversThroughRef?: string | null; content: unknown }): { summary: SummaryRecord; inserted: boolean } {
    return this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT * FROM session_summaries WHERE generation_id = ? AND dedupe_key = ?
      `).get(generationId, input.dedupeKey) as SummaryRow | undefined
      if (existing) return { summary: summary(existing), inserted: false }
      const ts = this.now()
      const row = this.db.prepare(`
        INSERT INTO session_summaries (id, generation_id, kind, status, dedupe_key, covers_through_ref, content_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
      `).get(createId(), generationId, input.kind, input.status ?? 'done', input.dedupeKey, input.coversThroughRef ?? null,
        JSON.stringify(input.content ?? {}), ts, ts) as SummaryRow
      return { summary: summary(row), inserted: true }
    })()
  }

  /** A pending summary (a handoff in progress) is finished or degraded. Null when it is not pending. */
  completeSummary(id: string, status: Exclude<SummaryStatus, 'pending'>, content?: unknown): SummaryRecord | null {
    const row = this.db.prepare(`
      UPDATE session_summaries SET status = ?, content_json = COALESCE(?, content_json), updated_at = ?
      WHERE id = ? AND status = 'pending' RETURNING *
    `).get(status, content === undefined ? null : JSON.stringify(content), this.now(), id) as SummaryRow | undefined
    return row ? summary(row) : null
  }

  /** Oldest first. */
  listSummaries(generationId: string): SummaryRecord[] {
    return (this.db.prepare(`
      SELECT * FROM session_summaries WHERE generation_id = ? ORDER BY created_at, rowid
    `).all(generationId) as SummaryRow[]).map(summary)
  }

  // ── Crash recovery ──────────────────────────────────────────

  /**
   * Startup recovery. Every turn another process left `queued` or `running`
   * becomes `interrupted` (`error_kind`: `crash_before_start` or
   * `crash_during_turn`), and each of its tool calls still running is closed
   * as `interrupted`. Turns of this process are never touched, so running it
   * again, or late, is harmless.
   *
   * Nothing is re-run here: the owner's role decides (B4/B5) whether an
   * interrupted event is retried, re-queued or only shown.
   */
  recoverInterrupted(): RecoveryReport {
    const report = this.db.transaction((): RecoveryReport => {
      const ts = this.now()
      const rows = this.db.prepare(`
        SELECT * FROM session_turns
        WHERE status IN ('queued', 'running') AND (runner_id IS NULL OR runner_id != ?)
        ORDER BY owner_kind, owner_id, seq
      `).all(this.runnerId) as TurnRow[]
      const update = this.db.prepare(`
        UPDATE session_turns SET status = 'interrupted', error_kind = ?, error_detail = ?, tool_calls = ?, ended_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running') RETURNING *
      `)
      const interrupted: TurnRecord[] = []
      let closedToolCalls = 0
      for (const row of rows) {
        const current = turn(row)
        const calls = current.toolCalls.map((c) => {
          if (c.status !== 'running') return c
          closedToolCalls++
          return { ...c, status: 'interrupted' as const, endedAt: ts }
        })
        const kind = current.status === 'queued' ? 'crash_before_start' : 'crash_during_turn'
        const detail = current.status === 'queued'
          ? '21x stopped before this event ran.'
          : '21x stopped while this turn was running.'
        const updated = update.get(kind, detail, JSON.stringify(calls), ts, ts, current.id) as TurnRow | undefined
        if (updated) interrupted.push(turn(updated))
      }
      return { interrupted, closedToolCalls }
    })()
    for (const t of report.interrupted) console.log(formatTurnLog(t))
    if (report.interrupted.length > 0) {
      console.log(`[ManagedSession] recovery: ${report.interrupted.length} unfinished turn(s) marked interrupted, ${report.closedToolCalls} tool call(s) closed`)
    }
    return report
  }
}

/** The structured log line for a turn that ended. */
export function formatTurnLog(t: TurnRecord): string {
  const parts = [
    `owner=${ownerKey(t.owner)}`,
    `turn=${t.seq}`,
    `event=${t.status}`,
    `trigger=${t.trigger}`,
    `key=${t.dedupeKey}`
  ]
  if (t.attempts > 1) parts.push(`attempts=${t.attempts}`)
  if (t.toolCalls.length) parts.push(`tools=${t.toolCalls.length}`)
  const tokens = (t.inputTokens ?? 0) + (t.outputTokens ?? 0)
  if (tokens) parts.push(`tokens=${t.usageSource === 'estimated' ? '≈' : ''}${tokens}`)
  if (t.stopReason) parts.push(`stop=${t.stopReason}`)
  if (t.errorKind) parts.push(`error=${t.errorKind}`)
  return `[ManagedSession] ${parts.join(' ')}`
}
