/**
 * Per-project limits (#65), kept in the project's `settings` JSON column
 * (#49) under the `limits` key:
 *
 * ```json
 * {
 *   "limits": {
 *     "max_concurrent_agents": 3,   // null = unlimited
 *     "daily_session_cap": 40,      // sessions started per local day; null = unlimited
 *     "daily_token_cap": null,      // documented seam: no adapter reports session tokens yet
 *     "paused": false
 *   }
 * }
 * ```
 *
 * Missing or malformed values fall back to the defaults below, so an old
 * project row and a hand-edited one behave the same. The main process reads
 * these through `src/main/project-limits.ts`; the project editor edits them
 * in its "Limits" section.
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
