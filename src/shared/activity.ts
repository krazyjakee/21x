/**
 * Shared activity vocabulary and freshness contract (GitHub #95,
 * docs/activity-indicators.md).
 *
 * Live activity ("is something happening right now?") is kept apart from the
 * durable task lifecycle (`TaskStatus`). A lifecycle value alone never proves
 * that a process is running, and missing or old evidence is reported as
 * `unknown`, never as `idle`.
 */

/** The eleven states every activity indicator can show. */
export type ActivityState =
  | 'running'
  | 'thinking'
  | 'tool'
  | 'waiting-for-user'
  | 'queued'
  | 'speaking'
  | 'listening'
  | 'finished'
  | 'failed'
  | 'idle'
  | 'unknown'

export const ACTIVITY_STATES: readonly ActivityState[] = [
  'running',
  'thinking',
  'tool',
  'waiting-for-user',
  'queued',
  'speaking',
  'listening',
  'finished',
  'failed',
  'idle',
  'unknown'
]

/** Sources are re-read (or heartbeats published) at most this often. */
export const ACTIVITY_REVALIDATE_MS = 5_000
/** A live claim older than this is no longer shown: it becomes `unknown`. */
export const ACTIVITY_STALE_MS = 15_000
/** How long the completion accent stays before it settles. */
export const ACTIVITY_FINISH_ACCENT_MS = 3_000

/** States that describe work in progress. Only these may ever animate. */
export const ACTIVE_ACTIVITY_STATES: ReadonlySet<ActivityState> = new Set<ActivityState>([
  'running',
  'thinking',
  'tool'
])

/** States that count as "running" in summaries such as the status bar. */
export function isRunningActivity(state: ActivityState): boolean {
  return ACTIVE_ACTIVITY_STATES.has(state)
}

// ── Queue reasons ───────────────────────────────────────────

/** Every reason main's StartQueue can hold a start for. */
export type ActivityQueueReason =
  | 'global_limit'
  | 'agent_limit'
  | 'project_limit'
  | 'global_pause'
  | 'project_paused'
  | 'project_daily_cap'

const QUEUE_REASON_LABELS: Record<ActivityQueueReason, string> = {
  global_limit: 'global session limit reached',
  agent_limit: 'agent session limit reached',
  project_limit: 'project session limit reached',
  global_pause: 'all projects paused',
  project_paused: 'project paused',
  project_daily_cap: 'daily budget reached'
}

/** Short, user-facing wording for a queue reason. Unknown reasons stay generic. */
export function describeActivityQueueReason(reason: string | undefined): string {
  if (reason && reason in QUEUE_REASON_LABELS) return QUEUE_REASON_LABELS[reason as ActivityQueueReason]
  return 'waiting for a free slot'
}

// ── agent:status observation metadata ───────────────────────

/**
 * Extra fields main stamps on every `agent:status` push.
 *
 * `epoch` identifies one main-process lifetime; `seq` increases with every
 * push in that lifetime, so a late or replayed event can be recognised and
 * dropped. `heartbeat` marks a push that reports an unchanged status after a
 * successful adapter poll: it refreshes freshness and nothing else. Consumers
 * that react to transitions must ignore heartbeats.
 */
export interface AgentStatusActivityMeta {
  epoch: string
  seq: number
  heartbeat?: boolean
}

/** Reads and validates the observation metadata of an `agent:status` payload. */
export function readAgentStatusActivityMeta(event: unknown): AgentStatusActivityMeta | null {
  if (!event || typeof event !== 'object') return null
  const e = event as Record<string, unknown>
  if (typeof e.epoch !== 'string' || !e.epoch) return null
  if (typeof e.seq !== 'number' || !Number.isFinite(e.seq)) return null
  return { epoch: e.epoch, seq: e.seq, ...(e.heartbeat === true ? { heartbeat: true } : {}) }
}

/** True for a freshness-only heartbeat push, which carries no transition. */
export function isAgentStatusHeartbeat(event: unknown): boolean {
  return Boolean(event && typeof event === 'object' && (event as { heartbeat?: unknown }).heartbeat === true)
}
