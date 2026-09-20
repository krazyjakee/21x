/**
 * The application activity announcer's queue (#95).
 *
 * One polite path for task/Captain transitions. Region indicators are silent.
 * Commander announcements belong to #91's CallAnnouncer and are not sent here.
 *
 * - Actionable announcements (needs approval/answer, failed) are never
 *   dropped. They are spoken in order, one per spacing interval.
 * - Routine announcements (finished) are coalesced for 2 s and aggregated, and
 *   each entity gets at most one routine announcement per 5 s.
 * - Everything is deduplicated by key (entity/turn/request/outcome), so mirrors
 *   and repeated pushes cannot announce the same thing twice.
 */

export const ANNOUNCE_COALESCE_MS = 2_000
export const ANNOUNCE_ROUTINE_ENTITY_LIMIT_MS = 5_000
export const ANNOUNCE_SPACING_MS = 1_000
const MAX_REMEMBERED_KEYS = 500

export interface ActivityAnnouncement {
  /** Deduplication key: entity + turn/request + outcome. */
  key: string
  entity: string
  kind: 'actionable' | 'routine'
  message: string
  /** Routine messages with the same group are aggregated ("3 tasks ready for review"). */
  group?: string
  /** Aggregated wording for `count` items of this group. */
  aggregate?: (count: number) => string
}

export interface AnnouncerTimers {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const defaultTimers: AnnouncerTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

export class ActivityAnnouncementQueue {
  private readonly seen = new Set<string>()
  private readonly lastRoutineAt = new Map<string, number>()
  private actionable: string[] = []
  private routine: ActivityAnnouncement[] = []
  private routineTimer: unknown = null
  private spacingTimer: unknown = null
  private lastSpokenAt = -Infinity

  constructor(
    private readonly speak: (message: string) => void,
    private readonly timers: AnnouncerTimers = defaultTimers
  ) {}

  enqueue(a: ActivityAnnouncement): void {
    if (this.seen.has(a.key)) return
    this.remember(a.key)
    if (a.kind === 'actionable') {
      this.actionable.push(a.message)
      this.pump()
      return
    }
    const now = this.timers.now()
    const last = this.lastRoutineAt.get(a.entity)
    if (last !== undefined && now - last < ANNOUNCE_ROUTINE_ENTITY_LIMIT_MS) return
    this.lastRoutineAt.set(a.entity, now)
    this.routine.push(a)
    if (this.routineTimer == null) {
      this.routineTimer = this.timers.setTimeout(() => this.flushRoutine(), ANNOUNCE_COALESCE_MS)
    }
  }

  dispose(): void {
    if (this.routineTimer != null) this.timers.clearTimeout(this.routineTimer)
    if (this.spacingTimer != null) this.timers.clearTimeout(this.spacingTimer)
    this.routineTimer = null
    this.spacingTimer = null
    this.actionable = []
    this.routine = []
  }

  private remember(key: string): void {
    this.seen.add(key)
    if (this.seen.size > MAX_REMEMBERED_KEYS) {
      const oldest = this.seen.values().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
  }

  private flushRoutine(): void {
    this.routineTimer = null
    const batch = this.routine
    this.routine = []
    const groups = new Map<string, ActivityAnnouncement[]>()
    const singles: string[] = []
    for (const a of batch) {
      if (!a.group) {
        singles.push(a.message)
        continue
      }
      const list = groups.get(a.group) ?? []
      list.push(a)
      groups.set(a.group, list)
    }
    const parts = [...singles]
    for (const list of groups.values()) {
      parts.push(list.length > 1 && list[0].aggregate ? list[0].aggregate(list.length) : list.map((a) => a.message).join('. '))
    }
    if (parts.length > 0) this.actionable.push(parts.join('. '))
    this.pump()
  }

  private pump(): void {
    if (this.spacingTimer != null || this.actionable.length === 0) return
    const now = this.timers.now()
    const wait = this.lastSpokenAt + ANNOUNCE_SPACING_MS - now
    if (wait > 0) {
      this.spacingTimer = this.timers.setTimeout(() => {
        this.spacingTimer = null
        this.pump()
      }, wait)
      return
    }
    const message = this.actionable.shift()
    if (message) {
      this.lastSpokenAt = now
      this.speak(message)
    }
    if (this.actionable.length > 0) {
      this.spacingTimer = this.timers.setTimeout(() => {
        this.spacingTimer = null
        this.pump()
      }, ANNOUNCE_SPACING_MS)
    }
  }
}
