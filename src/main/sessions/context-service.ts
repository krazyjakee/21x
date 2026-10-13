import type { DatabaseManager } from '../database/manager'
import { DEFAULT_ROLLOVER_POLICY, type RolloverPolicy, type SessionContextScope, type SessionContextSnapshot, type SessionContextSummary } from '../../shared/session-context'
import { isCoordinatorTask } from '../../shared/task-roles'
import { evaluateRollover, readRolloverPolicy, rolloverStageEnabled } from './compaction-policy'
import { modelContextWindow } from './model-windows'

type Source = Pick<DatabaseManager, 'db' | 'getTask' | 'getAgent'>
interface GenerationRow { id: string; generation_key: string; engine: 'chat' | 'adapter'; state: string; created_at: number; backend_id: string | null }
interface UsageRow { tokens: number; source: 'reported' | 'estimated'; context_window: number | null; model: string; observed_at: number }

export function parseSessionContextScope(value: unknown): SessionContextScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A conversation scope is required')
  const scope = value as Record<string, unknown>
  if ((scope.kind !== 'captain' && scope.kind !== 'commander') || typeof scope.ownerId !== 'string' || !scope.ownerId || scope.ownerId.length > 256)
    throw new Error('Invalid conversation scope')
  return { kind: scope.kind, ownerId: scope.ownerId }
}

export function parseRolloverPolicy(value: unknown): RolloverPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid rollover settings')
  const policy = value as Record<string, unknown>
  if (typeof policy.mode !== 'string' || !['off', 'observe', 'on'].includes(policy.mode)) throw new Error('Invalid rollover mode')
  for (const key of ['contextRatio', 'compactions', 'wakeups', 'turns', 'maxAgeDays'] as const) {
    const number = policy[key]
    if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0
      || (key === 'contextRatio' ? number > 1 : key === 'maxAgeDays' ? number > 3650 : !Number.isSafeInteger(number) || number > 1_000_000))
      throw new Error(`Invalid rollover threshold: ${key}`)
  }
  return Object.fromEntries(Object.keys(DEFAULT_ROLLOVER_POLICY).map(key => [key, policy[key]])) as unknown as RolloverPolicy
}

/** Read-only context projection. No provider calls, transcript hydration,
 * generation changes or polling liveness claims occur in these reads. */
export class SessionContextService {
  constructor(private readonly source: Source, private readonly now: () => number = Date.now) {}

  setPolicy(value: unknown): RolloverPolicy {
    const policy = parseRolloverPolicy(value)
    const { mode, ...thresholds } = policy
    this.source.db.transaction(() => {
      const write = this.source.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      write.run('sessions.rollover', mode)
      write.run('sessions.rollover_thresholds', JSON.stringify(thresholds))
    })()
    return policy
  }

  getSnapshot(value: unknown): SessionContextSnapshot {
    const scope = parseSessionContextScope(value)
    const db = this.source.db
    let configuredModel: string | null = null
    if (scope.kind === 'commander') {
      if (!db.prepare('SELECT 1 FROM commander_sessions WHERE id = ?').get(scope.ownerId)) throw new Error('Commander session not found')
    } else {
      const task = this.source.getTask(scope.ownerId)
      if (!task || !isCoordinatorTask(task)) throw new Error('Captain session not found')
      configuredModel = task.agent_id ? this.source.getAgent(task.agent_id)?.config.model ?? null : null
    }
    const generation = db.prepare('SELECT * FROM session_generations WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(scope.ownerId) as GenerationRow | undefined
    if (scope.kind === 'captain' && generation) {
      const started = db.prepare("SELECT payload FROM session_lifecycle_events WHERE generation_id = ? AND event_type IN ('session_started', 'session_resumed') ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get(generation.id) as { payload: string } | undefined
      const model = started ? this.parse(started.payload).model : null
      if (typeof model === 'string' && model) configuredModel = model
    }
    const policy = readRolloverPolicy(db)
    let usage: SessionContextSnapshot['usage'] = { tokens: null, source: 'unknown', contextWindow: modelContextWindow(configuredModel ?? ''), model: configuredModel, observedAt: null }
    if (scope.kind === 'commander') {
      // The latest single model request is context occupancy. Summed turn
      // input/output figures are billing and must never drive this meter.
      const last = db.prepare(`SELECT COALESCE(c.reported_input_tokens, c.estimated_input_tokens) AS tokens,
        CASE WHEN c.reported_input_tokens IS NULL THEN 'estimated' ELSE 'reported' END AS source,
        t.context_window, t.model, COALESCE(t.finished_at, t.started_at) AS observed_at
        FROM session_usage_calls c JOIN session_turn_usage t ON t.turn_id = c.turn_id
        WHERE t.owner_id = ? AND t.kind IN ('user', 'report') AND (? IS NULL OR EXISTS
          (SELECT 1 FROM session_turns st WHERE st.turn_key = t.turn_id AND st.generation_id = ?))
        ORDER BY t.started_at DESC, t.rowid DESC, c.call_index DESC LIMIT 1`)
        .get(scope.ownerId, generation?.id ?? null, generation?.id ?? null) as UsageRow | undefined
      if (last)
        usage = { tokens: last.tokens, source: last.source, contextWindow: last.context_window, model: last.model, observedAt: last.observed_at }
    } else if (generation) {
      const last = db.prepare("SELECT payload FROM session_lifecycle_events WHERE generation_id = ? AND event_type = 'context_usage' ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get(generation.id) as { payload: string } | undefined
      if (last) {
        const context = this.parse(last.payload)
        if (typeof context.tokens === 'number' && Number.isSafeInteger(context.tokens) && context.tokens >= 0
          && (context.source === 'reported' || context.source === 'estimated')) {
          const model = typeof context.model === 'string' ? context.model : configuredModel
          const window = typeof context.contextWindow === 'number' && Number.isSafeInteger(context.contextWindow) && context.contextWindow > 0
            ? context.contextWindow : modelContextWindow(model ?? '')
          usage = { tokens: context.tokens, source: context.source, contextWindow: window, model,
            observedAt: typeof context.observedAt === 'number' ? context.observedAt : null }
        }
      }
    }
    const counts = generation ? db.prepare(`SELECT
      SUM(CASE WHEN event_type = 'compaction' THEN 1 ELSE 0 END) AS compactions,
      SUM(CASE WHEN (? = 'captain' AND event_type = 'wake_disposition' AND json_extract(payload, '$.disposition') = 'delivered')
        OR (? = 'commander' AND event_type = 'wake_received') THEN 1 ELSE 0 END) AS wakeups
      FROM session_lifecycle_events WHERE generation_id = ?`).get(scope.kind, scope.kind, generation.id) as { compactions: number | null; wakeups: number | null } : null
    const turns = generation ? (db.prepare("SELECT COUNT(*) AS count FROM session_turns WHERE generation_id = ? AND kind IN ('user', 'report', 'captain')").get(generation.id) as { count: number }).count : 0
    const counters = { compactions: counts?.compactions ?? 0, wakeups: counts?.wakeups ?? 0, turns,
      ageMs: generation ? Math.max(0, this.now() - generation.created_at) : 0 }
    const decision = evaluateRollover({ contextTokens: usage.tokens, contextWindow: usage.contextWindow,
      ...counters, generationStartedAt: generation?.created_at ?? this.now(), now: this.now() }, policy, rolloverStageEnabled(db, scope.kind))
    const warnings: string[] = []
    if (usage.source === 'unknown') warnings.push('Context usage is unavailable until the model reports its input size.')
    if (policy.mode === 'on' && !rolloverStageEnabled(db, scope.kind)) warnings.push('Automatic context continuation is not enabled for this conversation yet.')
    const pending = db.prepare("SELECT id, state FROM session_handoffs WHERE owner_id = ? AND state != 'completed' ORDER BY created_at DESC LIMIT 1")
      .get(scope.ownerId) as { id: string; state: string } | undefined
    if (pending) warnings.push(pending.state === 'creation_unconfirmed' || pending.state === 'creating'
      ? 'A new session may have been created. Its identity needs reconciliation before continuation; the source history is retained.'
      : 'A durable session handoff is pending. Source history is retained.')
    const summaries: SessionContextSummary[] = (db.prepare("SELECT id, content, created_at FROM session_summaries WHERE owner_id = ? AND idempotency_key NOT LIKE 'handoff:%' AND idempotency_key NOT LIKE 'summary:rollover-summary:%' ORDER BY created_at DESC, rowid DESC LIMIT 10")
      .all(scope.ownerId) as Array<{ id: string; content: string; created_at: number }>).map(row => {
      const content = this.parse(row.content)
      return { id: row.id, content: typeof content.text === 'string' ? content.text : row.content, kind: 'summary', createdAt: row.created_at,
        source: content.source === 'model' || content.source === 'fallback' ? content.source : null }
    })
    for (const row of db.prepare("SELECT id, summary, summary_source, created_at FROM session_handoffs WHERE owner_id = ? AND summary IS NOT NULL ORDER BY created_at DESC LIMIT 10")
      .all(scope.ownerId) as Array<{ id: string; summary: string; summary_source: 'model' | 'fallback'; created_at: number }>) {
      const content = this.parse(row.summary)
      if (typeof content.text === 'string') summaries.push({ id: row.id, content: content.text, kind: 'rollover', source: row.summary_source, createdAt: row.created_at })
    }
    for (const row of db.prepare("SELECT idempotency_key, payload, created_at FROM session_lifecycle_events WHERE owner_id = ? AND event_type = 'replacement_seeded' ORDER BY created_at DESC LIMIT 10")
      .all(scope.ownerId) as Array<{ idempotency_key: string; payload: string; created_at: number }>) {
      const content = this.parse(row.payload)
      const text = typeof content.summary === 'string' ? content.summary : typeof content.recap === 'string' ? content.recap : null
      if (text) summaries.push({ id: row.idempotency_key, content: text, kind: 'recovery', source: 'fallback', createdAt: row.created_at })
    }
    return { scope, generation: generation ? { id: generation.id, key: generation.generation_key, engine: generation.engine, state: generation.state,
      createdAt: generation.created_at, backendId: generation.backend_id } : null, usage, counters, policy, reasons: decision.reasons, warnings,
      summaries: summaries.sort((a, b) => b.createdAt - a.createdAt).slice(0, 10), handoff: pending ?? null }
  }

  private parse(text: string): Record<string, unknown> {
    try { const value: unknown = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
    catch { return {} }
  }
}
