import { create } from 'zustand'

/**
 * The one deadline scheduler for every activity indicator (#95).
 *
 * Indicators never own timers. Each one derives its state from evidence and
 * the current monotonic time, then registers the moment that state stops
 * being true (a freshness expiry, the end of a completion accent). This module
 * keeps a single timeout armed for the earliest registered moment; when it
 * fires, `tick` advances and subscribed indicators re-derive.
 *
 * Time is monotonic (`performance.now()`), so wall-clock changes cannot make
 * old evidence look fresh. When the window becomes visible again the tick
 * advances at once, so indicators re-check their age before any motion resumes.
 */

let timeSource: () => number = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()

/** Current monotonic time in ms. All activity evidence is stamped with this. */
export function activityNow(): number {
  return timeSource()
}

/** Test-only: replace the time source (pass null to restore). */
export function __setActivityTimeSource(fn: (() => number) | null): void {
  timeSource = fn ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()))
}

interface ActivityClockState {
  /** Advances whenever a deadline passes or the window becomes visible. */
  tick: number
}

export const useActivityClock = create<ActivityClockState>(() => ({ tick: 0 }))

const deadlines = new Set<number>()
let timer: ReturnType<typeof setTimeout> | null = null
/** Small margin so the re-derive happens just after the boundary, not just before. */
const FIRE_MARGIN_MS = 25
/**
 * The monotonic time of the latest tick. Every subscriber re-derives after a
 * tick at a time no earlier than this, so any deadline at or before it has
 * already been observed as passed and must not be armed again. Without this, a
 * caller that re-registers an expired deadline on every tick (as the announcer
 * once did) turns one stale observation into a self-sustaining 25 ms loop that
 * wakes every subscribed indicator (#95).
 */
let observedThrough = -Infinity

function bump(): void {
  observedThrough = Math.max(observedThrough, activityNow())
  useActivityClock.setState((s) => ({ tick: s.tick + 1 }))
}

function arm(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (deadlines.size === 0) return
  let earliest = Infinity
  for (const d of deadlines) if (d < earliest) earliest = d
  const delay = Math.max(0, earliest - activityNow()) + FIRE_MARGIN_MS
  timer = setTimeout(fire, delay)
}

function fire(): void {
  timer = null
  const now = activityNow()
  for (const d of [...deadlines]) if (d <= now) deadlines.delete(d)
  bump()
  arm()
}

/**
 * Re-derive indicators at `at` (monotonic ms). Null does nothing, and so does a
 * moment the clock has already ticked past: that expiry has been observed.
 */
export function scheduleActivityDeadline(at: number | null | undefined): void {
  if (at == null || !Number.isFinite(at)) return
  if (at <= observedThrough) return
  if (deadlines.has(at)) return
  deadlines.add(at)
  arm()
}

/** Forces every subscribed indicator to re-derive now. */
export function revalidateActivityNow(): void {
  bump()
}

/** Test-only: drop every pending deadline and reset the tick. */
export function __resetActivityClock(): void {
  deadlines.clear()
  if (timer) clearTimeout(timer)
  timer = null
  observedThrough = -Infinity
  useActivityClock.setState({ tick: 0 })
}

/** Test/diagnostic: the number of pending deadlines (there is only ever one timer). */
export function pendingActivityDeadlines(): number {
  return deadlines.size
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      bump()
      arm()
    }
  })
}
