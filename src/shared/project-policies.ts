/**
 * Per-project limits (#65) and the escalation policy (#66), both kept in the
 * project's `settings` JSON column (#49) under their own keys:
 *
 * ```json
 * {
 *   "limits": {
 *     "max_concurrent_agents": 3,   // null = unlimited
 *     "daily_session_cap": 40,      // sessions started per local day; null = unlimited
 *     "daily_token_cap": null,      // documented seam: no adapter reports session tokens yet
 *     "paused": false
 *   },
 *   "escalation": {
 *     "create_task": "autonomous",
 *     "start_task": "autonomous",
 *     "stop_task": "tell_commander",
 *     "respond_to_checkpoint": "ask_user",
 *     "change_priority": "autonomous",
 *     "pr": "ask_user"
 *   }
 * }
 * ```
 *
 * Missing or malformed values fall back to the defaults below, so an old
 * project row and a hand-edited one behave the same. The main process reads
 * these through `src/main/project-limits.ts` and `src/main/escalation.ts`;
 * the project editor edits them in its "Limits" and "Escalation" sections.
 */

// ── Limits (#65) ──────────────────────────────────────────────

export interface ProjectLimitsSettings {
  /** Running agent sessions of real tasks in the project; null = unlimited. */
  max_concurrent_agents: number | null
  /** Agent sessions started per local calendar day; null = unlimited. */
  daily_session_cap: number | null
  /**
   * Tokens per local day. Recorded through `recordProjectTokenUsage` when an
   * adapter reports usage; today none report a per-session total, so the cap
   * is stored and shown but never reached. Seam, not a feature.
   */
  daily_token_cap: number | null
  /** New starts wait; running sessions are left alone. */
  paused: boolean
}

export const DEFAULT_PROJECT_LIMITS: ProjectLimitsSettings = {
  max_concurrent_agents: null,
  daily_session_cap: null,
  daily_token_cap: null,
  paused: false
}

/** Why a start waits because of a project or the global pause (#65). */
export type ProjectLimitReason = 'project_limit' | 'project_daily_cap' | 'project_paused' | 'global_pause'

/** A positive integer, else null (unlimited). */
function positiveIntOrNull(value: unknown): number | null {
  const n = typeof value === 'string' ? parseInt(value, 10) : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/** The `limits` block of a project's settings, with defaults for whatever is missing. */
export function projectLimitsFromSettings(settings: Record<string, unknown> | null | undefined): ProjectLimitsSettings {
  const raw = settings?.limits
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_PROJECT_LIMITS }
  const block = raw as Record<string, unknown>
  return {
    max_concurrent_agents: positiveIntOrNull(block.max_concurrent_agents),
    daily_session_cap: positiveIntOrNull(block.daily_session_cap),
    daily_token_cap: positiveIntOrNull(block.daily_token_cap),
    paused: block.paused === true
  }
}

// ── Escalation policy (#66) ───────────────────────────────────

/** The actions a Captain takes through the project-scoped tools that the policy covers. */
export type EscalationAction =
  | 'create_task'
  | 'start_task'
  | 'stop_task'
  | 'respond_to_checkpoint'
  | 'change_priority'
  /** Opening or merging pull requests. No task-management tool does this today, so it is prompt-guidance only. */
  | 'pr'

export type EscalationLevel = 'autonomous' | 'tell_commander' | 'ask_user'

export type EscalationPolicy = Record<EscalationAction, EscalationLevel>

export const ESCALATION_ACTIONS: readonly EscalationAction[] = [
  'create_task',
  'start_task',
  'stop_task',
  'respond_to_checkpoint',
  'change_priority',
  'pr'
]

export const ESCALATION_LEVELS: readonly EscalationLevel[] = ['autonomous', 'tell_commander', 'ask_user']

/**
 * Defaults: routine planning is free; stopping an agent (work is lost) is
 * reported; answering an agent's checkpoint and anything with pull requests
 * waits for the user.
 */
export const DEFAULT_ESCALATION_POLICY: EscalationPolicy = {
  create_task: 'autonomous',
  start_task: 'autonomous',
  stop_task: 'tell_commander',
  respond_to_checkpoint: 'ask_user',
  change_priority: 'autonomous',
  pr: 'ask_user'
}

export const ESCALATION_ACTION_LABELS: Record<EscalationAction, string> = {
  create_task: 'Creating tasks',
  start_task: 'Starting agents',
  stop_task: 'Stopping agents',
  respond_to_checkpoint: 'Answering agent checkpoints',
  change_priority: 'Changing task priority',
  pr: 'Opening or merging pull requests'
}

export const ESCALATION_LEVEL_LABELS: Record<EscalationLevel, string> = {
  autonomous: 'Autonomous',
  tell_commander: 'Do it, tell the Commander',
  ask_user: 'Ask the user first'
}

export function isEscalationLevel(value: unknown): value is EscalationLevel {
  return typeof value === 'string' && (ESCALATION_LEVELS as readonly string[]).includes(value)
}

/** The `escalation` block of a project's settings, defaults filling every gap. */
export function escalationPolicyFromSettings(settings: Record<string, unknown> | null | undefined): EscalationPolicy {
  const raw = settings?.escalation
  const block = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const policy = { ...DEFAULT_ESCALATION_POLICY }
  for (const action of ESCALATION_ACTIONS) {
    if (isEscalationLevel(block[action])) policy[action] = block[action] as EscalationLevel
  }
  return policy
}
