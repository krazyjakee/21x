import type Database from 'better-sqlite3'
import { createId } from '@paralleldrive/cuid2'
import type { ContextWindowSource } from './model-windows'
import { calibrationRatio, type UsageSource } from './token-estimator'

/**
 * Per-turn token usage (managed sessions B1, #97): the `session_usage` table
 * (session-usage-migration.ts) and its log line.
 *
 * Recording is instrumentation only. A failure to record is logged and
 * swallowed by the callers, so it can never break a turn.
 */

export type UsageOwnerKind = 'commander' | 'captain' | 'task'
export type UsageEngine = 'chat' | 'adapter'

export interface SessionUsageInput {
  ownerKind: UsageOwnerKind
  ownerId: string
  /** The backend session id (adapters) or the Commander session id. */
  sessionId?: string | null
  /** Identifies the turn within its owner; recording the same key again replaces the row. */
  turnKey: string
  engine: UsageEngine
  /** The chat provider id (`anthropic`, `claude-code-subscription`, …) or the coding agent (`claude-code`, `codex`, `opencode`). */
  backend: string
  model?: string | null
  /** Whether the token counts below came from the backend or from the estimator. */
  source: UsageSource
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  /** Prompt size of the turn's last model call. */
  contextTokens?: number | null
  contextSource?: UsageSource | null
  contextWindow?: number | null
  windowSource?: ContextWindowSource | null
  /** 21x's estimate of a prompt whose size was also reported (calibration pair). */
  estimatedPromptTokens?: number | null
  modelCalls?: number | null
  costUsd?: number | null
  stopReason?: string | null
}

export interface SessionUsageRecord extends Required<Omit<SessionUsageInput, 'sessionId' | 'model' | 'contextTokens' | 'contextSource' | 'contextWindow' | 'windowSource' | 'estimatedPromptTokens' | 'modelCalls' | 'costUsd' | 'stopReason'>> {
  id: string
  sessionId: string | null
  model: string | null
  contextTokens: number | null
  contextSource: UsageSource | null
  contextWindow: number | null
  windowSource: ContextWindowSource | null
  estimatedPromptTokens: number | null
  modelCalls: number | null
  costUsd: number | null
  stopReason: string | null
  createdAt: number
  updatedAt: number
}

interface UsageRow {
  id: string
  owner_kind: UsageOwnerKind
  owner_id: string
  session_id: string | null
  turn_key: string
  engine: UsageEngine
  backend: string
  model: string | null
  usage_source: UsageSource
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  context_tokens: number | null
  context_source: UsageSource | null
  context_window: number | null
  window_source: ContextWindowSource | null
  estimated_prompt_tokens: number | null
  model_calls: number | null
  cost_usd: number | null
  stop_reason: string | null
  created_at: number
  updated_at: number
}

function record(row: UsageRow): SessionUsageRecord {
  return {
    id: row.id,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    sessionId: row.session_id,
    turnKey: row.turn_key,
    engine: row.engine,
    backend: row.backend,
    model: row.model,
    source: row.usage_source,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    reasoningTokens: row.reasoning_tokens,
    contextTokens: row.context_tokens,
    contextSource: row.context_source,
    contextWindow: row.context_window,
    windowSource: row.window_source,
    estimatedPromptTokens: row.estimated_prompt_tokens,
    modelCalls: row.model_calls,
    costUsd: row.cost_usd,
    stopReason: row.stop_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** A non-negative integer; anything else (NaN, negative, missing) is 0. */
export function tokenCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

function optionalCount(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}

/** The structured log line for one recorded turn. `≈` marks an estimated figure. */
export function formatUsageLog(usage: SessionUsageRecord | SessionUsageInput): string {
  const approx = (source: UsageSource | null | undefined): string => (source === 'estimated' ? '≈' : '')
  const parts = [
    `owner=${usage.ownerKind}:${usage.ownerId}`,
    `turn=${usage.turnKey}`,
    `backend=${usage.backend}`,
    `model=${usage.model || 'unknown'}`,
    `source=${usage.source}`,
    `in=${approx(usage.source)}${tokenCount(usage.inputTokens)}`,
    `out=${approx(usage.source)}${tokenCount(usage.outputTokens)}`
  ]
  const cacheRead = tokenCount(usage.cacheReadTokens)
  const cacheWrite = tokenCount(usage.cacheWriteTokens)
  if (cacheRead || cacheWrite) parts.push(`cache=${cacheRead}r/${cacheWrite}w`)
  const reasoning = tokenCount(usage.reasoningTokens)
  if (reasoning) parts.push(`reasoning=${reasoning}`)
  if (usage.contextTokens !== null && usage.contextTokens !== undefined) {
    const window = usage.contextWindow ? `/${usage.contextWindow}` : ''
    const pct = usage.contextWindow ? ` (${Math.round((usage.contextTokens / usage.contextWindow) * 1000) / 10}%)` : ''
    parts.push(`context=${approx(usage.contextSource)}${usage.contextTokens}${window}${pct}`)
  }
  if (usage.windowSource) parts.push(`window=${usage.windowSource}`)
  if (usage.modelCalls) parts.push(`calls=${usage.modelCalls}`)
  if (typeof usage.costUsd === 'number') parts.push(`cost=$${usage.costUsd.toFixed(4)}`)
  if (usage.stopReason) parts.push(`stop=${usage.stopReason}`)
  return `[SessionUsage] ${parts.join(' ')}`
}

export class SessionUsageStore {
  constructor(
    private readonly source: { db: Database.Database },
    private readonly now: () => number = Date.now
  ) {}

  private get db(): Database.Database {
    return this.source.db
  }

  /**
   * Stores one turn's usage, replacing the row an earlier report of the same
   * turn wrote (its `created_at` is kept), and logs it.
   */
  record(input: SessionUsageInput): SessionUsageRecord {
    const ts = this.now()
    const row = this.db.prepare(`
      INSERT INTO session_usage (
        id, owner_kind, owner_id, session_id, turn_key, engine, backend, model, usage_source,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
        context_tokens, context_source, context_window, window_source, estimated_prompt_tokens,
        model_calls, cost_usd, stop_reason, created_at, updated_at
      ) VALUES (
        @id, @owner_kind, @owner_id, @session_id, @turn_key, @engine, @backend, @model, @usage_source,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens, @reasoning_tokens,
        @context_tokens, @context_source, @context_window, @window_source, @estimated_prompt_tokens,
        @model_calls, @cost_usd, @stop_reason, @ts, @ts
      )
      ON CONFLICT (owner_kind, owner_id, turn_key) DO UPDATE SET
        session_id = COALESCE(excluded.session_id, session_usage.session_id),
        engine = excluded.engine,
        backend = excluded.backend,
        model = COALESCE(excluded.model, session_usage.model),
        usage_source = excluded.usage_source,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        context_tokens = excluded.context_tokens,
        context_source = excluded.context_source,
        context_window = COALESCE(excluded.context_window, session_usage.context_window),
        window_source = COALESCE(excluded.window_source, session_usage.window_source),
        estimated_prompt_tokens = excluded.estimated_prompt_tokens,
        model_calls = excluded.model_calls,
        cost_usd = excluded.cost_usd,
        stop_reason = COALESCE(excluded.stop_reason, session_usage.stop_reason),
        updated_at = excluded.updated_at
      RETURNING *
    `).get({
      id: createId(),
      owner_kind: input.ownerKind,
      owner_id: input.ownerId,
      session_id: input.sessionId ?? null,
      turn_key: input.turnKey,
      engine: input.engine,
      backend: input.backend,
      model: input.model || null,
      usage_source: input.source,
      input_tokens: tokenCount(input.inputTokens),
      output_tokens: tokenCount(input.outputTokens),
      cache_read_tokens: tokenCount(input.cacheReadTokens),
      cache_write_tokens: tokenCount(input.cacheWriteTokens),
      reasoning_tokens: tokenCount(input.reasoningTokens),
      context_tokens: optionalCount(input.contextTokens),
      context_source: optionalCount(input.contextTokens) === null ? null : (input.contextSource ?? input.source),
      context_window: optionalCount(input.contextWindow) || null,
      window_source: input.windowSource ?? null,
      estimated_prompt_tokens: optionalCount(input.estimatedPromptTokens),
      model_calls: optionalCount(input.modelCalls),
      cost_usd: typeof input.costUsd === 'number' && Number.isFinite(input.costUsd) ? input.costUsd : null,
      stop_reason: input.stopReason ?? null,
      ts
    }) as UsageRow
    const stored = record(row)
    console.log(formatUsageLog(stored))
    return stored
  }

  /** Newest first. */
  list(ownerKind: UsageOwnerKind, ownerId: string, limit = 100): SessionUsageRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM session_usage
      WHERE owner_kind = ? AND owner_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(ownerKind, ownerId, Math.max(1, Math.min(1000, Math.floor(limit)))) as UsageRow[]
    return rows.map(record)
  }

  /** The newest turn whose context size the backend reported, or null. */
  latestReported(ownerKind: UsageOwnerKind, ownerId: string): SessionUsageRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM session_usage
      WHERE owner_kind = ? AND owner_id = ? AND context_source = 'reported' AND context_tokens IS NOT NULL
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(ownerKind, ownerId) as UsageRow | undefined
    return row ? record(row) : null
  }

  /**
   * The calibration ratio (reported ÷ estimated prompt size) from the newest
   * turn that has both figures, or null when there is none (or it is unusable).
   */
  calibration(ownerKind: UsageOwnerKind, ownerId: string): number | null {
    const row = this.db.prepare(`
      SELECT context_tokens, estimated_prompt_tokens FROM session_usage
      WHERE owner_kind = ? AND owner_id = ? AND context_source = 'reported'
        AND context_tokens IS NOT NULL AND estimated_prompt_tokens IS NOT NULL
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(ownerKind, ownerId) as { context_tokens: number; estimated_prompt_tokens: number } | undefined
    return row ? calibrationRatio(row.context_tokens, row.estimated_prompt_tokens) : null
  }
}
