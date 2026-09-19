/**
 * Scheduled coordination (#67): settings shapes shared by the main-process
 * scheduler (src/main/scheduled-coordination.ts), the project editor and the
 * Commander briefing settings section.
 *
 * - A scheduled Captain review lives in the project's `settings` JSON under
 *   {@link SCHEDULED_REVIEW_SETTING}: `{ "enabled": false, "cron": "0 9 * * 1-5" }`.
 * - The Commander briefing is one app setting, {@link COMMANDER_BRIEFING_SETTING},
 *   holding JSON: `{ "enabled": false, "cron": "0 8 * * 1-5", "speak": false }`.
 *
 * Both are off by default. Missing or malformed values fall back to the
 * defaults, so an old row and a hand-edited one behave the same.
 */
import { splitCron, parseCronToState } from './recurrence-cron'

// ── Per-project scheduled review ──────────────────────────────

/** Key inside `projects.settings`. */
export const SCHEDULED_REVIEW_SETTING = 'scheduled_review'

export interface ScheduledReviewSettings {
  enabled: boolean
  /** 5-field cron, local time. */
  cron: string
}

export const DEFAULT_SCHEDULED_REVIEW: ScheduledReviewSettings = { enabled: false, cron: '0 9 * * 1-5' }

function cronOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

export function readScheduledReviewSettings(settings: Record<string, unknown> | null | undefined): ScheduledReviewSettings {
  const raw = settings?.[SCHEDULED_REVIEW_SETTING]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_SCHEDULED_REVIEW }
  const value = raw as { enabled?: unknown; cron?: unknown }
  return { enabled: value.enabled === true, cron: cronOr(value.cron, DEFAULT_SCHEDULED_REVIEW.cron) }
}

/** `projects.settings` with the review schedule written in; other keys are kept. */
export function withScheduledReviewSettings(
  settings: Record<string, unknown> | null | undefined,
  review: ScheduledReviewSettings
): Record<string, unknown> {
  return { ...(settings ?? {}), [SCHEDULED_REVIEW_SETTING]: { enabled: review.enabled, cron: review.cron.trim() } }
}

// ── Commander briefing ────────────────────────────────────────

/** App setting key; the value is JSON. */
export const COMMANDER_BRIEFING_SETTING = 'commander_briefing'

export interface CommanderBriefingSettings {
  enabled: boolean
  /** 5-field cron, local time. */
  cron: string
  /** Read the briefing aloud when spoken answers can play (a window is open and an engine is ready). */
  speak: boolean
}

export const DEFAULT_COMMANDER_BRIEFING: CommanderBriefingSettings = { enabled: false, cron: '0 8 * * 1-5', speak: false }

export function parseCommanderBriefingSettings(raw: string | null | undefined): CommanderBriefingSettings {
  if (!raw) return { ...DEFAULT_COMMANDER_BRIEFING }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_COMMANDER_BRIEFING }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_COMMANDER_BRIEFING }
  const value = parsed as { enabled?: unknown; cron?: unknown; speak?: unknown }
  return {
    enabled: value.enabled === true,
    cron: cronOr(value.cron, DEFAULT_COMMANDER_BRIEFING.cron),
    speak: value.speak === true
  }
}

export function serializeCommanderBriefingSettings(settings: CommanderBriefingSettings): string {
  return JSON.stringify({ enabled: settings.enabled, cron: settings.cron.trim(), speak: settings.speak })
}

// ── Cron helpers for the editors ──────────────────────────────

const CRON_FIELD = /^[\d*/,-]+$/

/**
 * A cheap shape check for the editors: five fields of digits, `*`, `/`, `,`
 * and `-`. The scheduler parses with cron-parser and skips (and logs) what
 * it cannot read.
 */
export function isCronShape(cron: string): boolean {
  const parts = cron.trim().split(/\s+/)
  return parts.length === 5 && parts.every((part) => CRON_FIELD.test(part))
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "Weekdays at 09:00" and the like; the raw cron when it is not a simple shape. */
export function describeCron(cron: string): string {
  if (!isCronShape(cron)) return 'Not a valid 5-field cron expression'
  const fields = splitCron(cron)
  const [minute, hour, , month] = cron.trim().split(/\s+/)
  if (!fields || !/^\d+$/.test(minute) || !/^\d+$/.test(hour) || month !== '*') return `Custom schedule (${cron.trim()})`
  const state = parseCronToState(cron)
  if (state.type === 'monthly') return `Monthly on day ${state.monthDay} at ${state.time}`
  if (state.type === 'weekly') {
    const days = [...new Set(state.weekdays.map((d) => d % 7))].sort((a, b) => a - b)
    if (days.join(',') === '1,2,3,4,5') return `Weekdays at ${state.time}`
    if (days.length === 7) return `Every day at ${state.time}`
    return `${days.map((d) => DAY_NAMES[d]).join(', ')} at ${state.time}`
  }
  return state.interval > 1 ? `Every ${state.interval} days at ${state.time}` : `Every day at ${state.time}`
}
