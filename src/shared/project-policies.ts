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
 *     "open_pr": "tell_commander",
 *     "merge_pr": "ask_user",
 *     "issue_write": "tell_commander"
 *   },
 *   "merge_grants": { "enabled": false }   // #137, shared/merge-grants.ts
 * }
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
  /**
   * Opening pull requests (#137). Normal Captain authority: the agent doing
   * the work opens them, so no tool carries it and it is prompt guidance.
   */
  | 'open_pr'
  /**
   * Merging pull requests (#137): the Captain's `merge_pull_request` tool,
   * enforced by the escalation gate. Under `ask_user` a merge is held unless
   * an active merge grant the user gave covers it.
   */
  | 'merge_pr'
  /**
   * Creating, updating and linking GitHub issues in the project's own
   * repositories: the Captain's issue tools, enforced by the escalation gate
   * (main/issue-write-gate.ts). This is *delegated* work, so it needs an
   * originating human instruction but never a per-issue grant — unlike
   * `merge_pr`, which needs its own authority however this policy is set. The
   * level here decides only whether such a write is silent, reported or held.
   */
  | 'issue_write'

export type EscalationLevel = 'autonomous' | 'tell_commander' | 'ask_user'

export type EscalationPolicy = Record<EscalationAction, EscalationLevel>

export const ESCALATION_ACTIONS: readonly EscalationAction[] = [
  'create_task',
  'start_task',
  'stop_task',
  'respond_to_checkpoint',
  'change_priority',
  'open_pr',
  'merge_pr',
  'issue_write'
]

export const ESCALATION_LEVELS: readonly EscalationLevel[] = ['autonomous', 'tell_commander', 'ask_user']

/**
 * Defaults: routine planning is free; stopping an agent (work is lost),
 * opening a pull request and writing a GitHub issue are reported; answering an
 * agent's checkpoint and merging a pull request wait for the user (or, for
 * merges, a merge grant).
 *
 * `issue_write` defaults to `tell_commander` for the reason `open_pr` does: it
 * is ordinary delegated work that leaves a mark outside 21x, so the person
 * hears about it without being asked to approve each one.
 */
export const DEFAULT_ESCALATION_POLICY: EscalationPolicy = {
  create_task: 'autonomous',
  start_task: 'autonomous',
  stop_task: 'tell_commander',
  respond_to_checkpoint: 'ask_user',
  change_priority: 'autonomous',
  open_pr: 'tell_commander',
  merge_pr: 'ask_user',
  issue_write: 'tell_commander'
}

export const ESCALATION_ACTION_LABELS: Record<EscalationAction, string> = {
  create_task: 'Creating tasks',
  start_task: 'Starting agents',
  stop_task: 'Stopping agents',
  respond_to_checkpoint: 'Answering agent checkpoints',
  change_priority: 'Changing task priority',
  open_pr: 'Opening pull requests',
  merge_pr: 'Merging pull requests',
  issue_write: 'Writing GitHub issues'
}

export const ESCALATION_LEVEL_LABELS: Record<EscalationLevel, string> = {
  autonomous: 'Autonomous',
  tell_commander: 'Do it, tell the Commander',
  ask_user: 'Ask the user first'
}

export function isEscalationLevel(value: unknown): value is EscalationLevel {
  return typeof value === 'string' && (ESCALATION_LEVELS as readonly string[]).includes(value)
}

/**
 * The combined pull-request item before #137 split it. Migration v19
 * (`splitPullRequestEscalation` in database/schema.ts) rewrites stored
 * settings; the reader honours it too, so a block written by an older
 * client never loosens the merge rule.
 */
export const LEGACY_PR_ESCALATION_KEY = 'pr'

/** The `escalation` block of a project's settings, defaults filling every gap. */
export function escalationPolicyFromSettings(settings: Record<string, unknown> | null | undefined): EscalationPolicy {
  const raw = settings?.escalation
  const block = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const policy = { ...DEFAULT_ESCALATION_POLICY }
  for (const action of ESCALATION_ACTIONS) {
    if (isEscalationLevel(block[action])) policy[action] = block[action] as EscalationLevel
  }
  if (!isEscalationLevel(block.merge_pr) && isEscalationLevel(block[LEGACY_PR_ESCALATION_KEY])) {
    policy.merge_pr = block[LEGACY_PR_ESCALATION_KEY] as EscalationLevel
  }
  return policy
}

/**
 * Splits a stored `escalation` block's legacy `pr` level (#137): it becomes
 * `merge_pr` (unless one is already set), `open_pr` gets its default unless
 * set, and `pr` is removed. Returns null when there is nothing to change.
 */
export function splitLegacyPullRequestEscalation(settings: Record<string, unknown>): Record<string, unknown> | null {
  const raw = settings.escalation
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const block = raw as Record<string, unknown>
  if (!(LEGACY_PR_ESCALATION_KEY in block)) return null
  const { [LEGACY_PR_ESCALATION_KEY]: legacy, ...rest } = block
  const next: Record<string, unknown> = { ...rest }
  if (!isEscalationLevel(next.merge_pr) && isEscalationLevel(legacy)) next.merge_pr = legacy
  if (!isEscalationLevel(next.open_pr)) next.open_pr = DEFAULT_ESCALATION_POLICY.open_pr
  return { ...settings, escalation: next }
}
