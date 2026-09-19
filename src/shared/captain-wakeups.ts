/**
 * Which project events wake a project's Captain (#57).
 *
 * The choice lives in `projects.settings` under {@link CAPTAIN_WAKEUPS_SETTING}
 * so it needs no schema change. An absent or unreadable value means the
 * default: wake-ups on, for every kind. The renderer's project editor and the
 * main-process waker both read it through {@link readCaptainWakeupSettings}.
 */

/** Every kind of event the main process raises for a project, in display order. */
export const PROJECT_EVENT_KINDS = [
  'task_ready_for_review',
  'task_failed',
  'approval_pending',
  'chain_stuck',
  'heartbeat_finding',
  'task_synced'
] as const

export type ProjectEventKind = (typeof PROJECT_EVENT_KINDS)[number]

export const PROJECT_EVENT_KIND_LABELS: Record<ProjectEventKind, string> = {
  task_ready_for_review: 'A task is ready for review',
  task_failed: 'An agent session failed',
  approval_pending: 'An agent is waiting for approval',
  chain_stuck: 'A subtask chain is stuck',
  heartbeat_finding: 'A heartbeat check found something',
  task_synced: 'A new task arrived from a task source'
}

/** Key inside `projects.settings`. */
export const CAPTAIN_WAKEUPS_SETTING = 'captain_wakeups'

export interface CaptainWakeupSettings {
  /** Off entirely when false, whatever `kinds` says. */
  enabled: boolean
  /** The kinds that wake the Captain. */
  kinds: ProjectEventKind[]
}

export function defaultCaptainWakeupSettings(): CaptainWakeupSettings {
  return { enabled: true, kinds: [...PROJECT_EVENT_KINDS] }
}

function isKind(value: unknown): value is ProjectEventKind {
  return typeof value === 'string' && (PROJECT_EVENT_KINDS as readonly string[]).includes(value)
}

/** The project's wake-up settings; anything missing or malformed falls back to the default (on, all kinds). */
export function readCaptainWakeupSettings(settings: Record<string, unknown> | null | undefined): CaptainWakeupSettings {
  const raw = settings?.[CAPTAIN_WAKEUPS_SETTING]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultCaptainWakeupSettings()
  const value = raw as { enabled?: unknown; kinds?: unknown }
  const enabled = typeof value.enabled === 'boolean' ? value.enabled : true
  const kinds = Array.isArray(value.kinds) ? value.kinds.filter(isKind) : [...PROJECT_EVENT_KINDS]
  return { enabled, kinds }
}

/** True when an event of this kind should wake the project's Captain. */
export function wakeupKindEnabled(settings: CaptainWakeupSettings, kind: ProjectEventKind): boolean {
  return settings.enabled && settings.kinds.includes(kind)
}

/** `projects.settings` with the wake-up choice written into it; other keys are kept. */
export function withCaptainWakeupSettings(
  settings: Record<string, unknown> | null | undefined,
  wakeups: CaptainWakeupSettings
): Record<string, unknown> {
  return { ...(settings ?? {}), [CAPTAIN_WAKEUPS_SETTING]: { enabled: wakeups.enabled, kinds: [...wakeups.kinds] } }
}
