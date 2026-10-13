import type Database from 'better-sqlite3'
import { DEFAULT_ROLLOVER_POLICY, type RolloverPolicy, type RolloverReason } from '../../shared/session-context'
export { DEFAULT_ROLLOVER_POLICY, type RolloverPolicy, type RolloverReason } from '../../shared/session-context'
export interface RolloverMetrics {
  contextTokens?: number | null
  contextWindow?: number | null
  compactions: number
  wakeups: number
  turns: number
  generationStartedAt: number
  now?: number
  activeTurn?: boolean
}
export interface RolloverDecision {
  mode: RolloverPolicy['mode']
  reasons: RolloverReason[]
  action: 'none' | 'observe' | 'rollover'
  deferred: 'active_turn' | 'stage_disabled' | null
}

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
export function normalizeRolloverPolicy(input: unknown): RolloverPolicy {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  return {
    mode: value.mode === 'observe' || value.mode === 'on' ? value.mode : 'off',
    contextRatio: positive(value.contextRatio) && value.contextRatio <= 1 ? value.contextRatio : DEFAULT_ROLLOVER_POLICY.contextRatio,
    compactions: positive(value.compactions) && Number.isSafeInteger(value.compactions) ? value.compactions : DEFAULT_ROLLOVER_POLICY.compactions,
    wakeups: positive(value.wakeups) && Number.isSafeInteger(value.wakeups) ? value.wakeups : DEFAULT_ROLLOVER_POLICY.wakeups,
    turns: positive(value.turns) && Number.isSafeInteger(value.turns) ? value.turns : DEFAULT_ROLLOVER_POLICY.turns,
    maxAgeDays: positive(value.maxAgeDays) ? value.maxAgeDays : DEFAULT_ROLLOVER_POLICY.maxAgeDays
  }
}

export function readRolloverPolicy(db: Database.Database): RolloverPolicy {
  const read = (key: string): string | undefined => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value
  let thresholds: unknown
  try { thresholds = JSON.parse(read('sessions.rollover_thresholds') ?? '{}') } catch { thresholds = {} }
  return normalizeRolloverPolicy({ ...(thresholds && typeof thresholds === 'object' ? thresholds : {}), mode: read('sessions.rollover') })
}

/** Staging is explicit: observe can run before either engine is activated;
 * Commander activation requires the Captain stage to have been enabled. */
export function rolloverStageEnabled(db: Database.Database, role: 'captain' | 'commander'): boolean {
  const enabled = (key: string): boolean => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return ['1', 'true', 'on'].includes(row?.value?.trim().toLowerCase() ?? '')
  }
  return enabled('sessions.captain_managed') && (role === 'captain' || enabled('sessions.commander_managed'))
}

export function evaluateRollover(metrics: RolloverMetrics, policy: RolloverPolicy, stageEnabled = true): RolloverDecision {
  const reasons: RolloverReason[] = []
  if (positive(metrics.contextWindow) && positive(metrics.contextTokens) && metrics.contextTokens / metrics.contextWindow >= policy.contextRatio) reasons.push('context')
  if (metrics.compactions >= policy.compactions) reasons.push('compactions')
  if (metrics.wakeups >= policy.wakeups) reasons.push('wakeups')
  if (metrics.turns >= policy.turns) reasons.push('turns')
  const now = metrics.now ?? Date.now()
  if (Number.isFinite(metrics.generationStartedAt) && metrics.generationStartedAt >= 0 && now - metrics.generationStartedAt >= policy.maxAgeDays * 86_400_000) reasons.push('age')
  if (policy.mode === 'off' || !reasons.length) return { mode: policy.mode, reasons, action: 'none', deferred: null }
  if (policy.mode === 'observe') return { mode: policy.mode, reasons, action: 'observe', deferred: null }
  if (!stageEnabled) return { mode: policy.mode, reasons, action: 'observe', deferred: 'stage_disabled' }
  if (metrics.activeTurn) return { mode: policy.mode, reasons, action: 'observe', deferred: 'active_turn' }
  return { mode: policy.mode, reasons, action: 'rollover', deferred: null }
}
