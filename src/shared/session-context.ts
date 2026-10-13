export type SessionContextScope = { kind: 'commander' | 'captain'; ownerId: string }
export type RolloverMode = 'off' | 'observe' | 'on'
export interface RolloverPolicy {
  mode: RolloverMode
  contextRatio: number
  compactions: number
  wakeups: number
  turns: number
  maxAgeDays: number
}
export const DEFAULT_ROLLOVER_POLICY: Readonly<RolloverPolicy> = {
  mode: 'off', contextRatio: .7, compactions: 2, wakeups: 150, turns: 300, maxAgeDays: 7
}
export type RolloverReason = 'context' | 'compactions' | 'wakeups' | 'turns' | 'age'
export interface SessionContextSummary {
  id: string
  content: string
  kind: 'summary' | 'rollover' | 'recovery'
  createdAt: number
  source: 'model' | 'fallback' | null
}
export interface SessionContextSnapshot {
  scope: SessionContextScope
  generation: { id: string; key: string; engine: 'chat' | 'adapter'; state: string; createdAt: number; backendId: string | null } | null
  usage: { tokens: number | null; source: 'reported' | 'estimated' | 'unknown'; contextWindow: number | null; model: string | null; observedAt: number | null }
  counters: { compactions: number; wakeups: number; turns: number; ageMs: number }
  policy: RolloverPolicy
  reasons: RolloverReason[]
  warnings: string[]
  summaries: SessionContextSummary[]
  handoff?: { id: string; state: string } | null
}
