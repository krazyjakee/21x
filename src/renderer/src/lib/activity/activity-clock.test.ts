import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetActivityClock,
  __setActivityTimeSource,
  pendingActivityDeadlines,
  scheduleActivityDeadline,
  useActivityClock
} from './activity-clock'

let now = 0

beforeEach(() => {
  vi.useFakeTimers()
  now = 0
  __setActivityTimeSource(() => now)
  __resetActivityClock()
})

afterEach(() => {
  __resetActivityClock()
  __setActivityTimeSource(null)
  vi.useRealTimers()
})

const advance = (ms: number) => {
  now += ms
  vi.advanceTimersByTime(ms)
}

describe('activity clock', () => {
  it('uses one timer for many deadlines and ticks as each passes', () => {
    scheduleActivityDeadline(15_000)
    scheduleActivityDeadline(3_000)
    scheduleActivityDeadline(15_000)
    expect(pendingActivityDeadlines()).toBe(2)
    expect(vi.getTimerCount()).toBe(1)
    advance(2_999)
    expect(useActivityClock.getState().tick).toBe(0)
    advance(100)
    expect(useActivityClock.getState().tick).toBe(1)
    expect(pendingActivityDeadlines()).toBe(1)
    advance(12_000)
    expect(useActivityClock.getState().tick).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles a passed deadline once, even when a subscriber keeps re-registering it', () => {
    // THE LOOP. A subscriber that re-registers the same past deadline on every
    // tick re-armed the clock at its 25 ms margin forever, waking every
    // indicator at ~40 Hz after one stale observation.
    const expiry = 15_000
    const unsubscribe = useActivityClock.subscribe(() => scheduleActivityDeadline(expiry))
    try {
      scheduleActivityDeadline(expiry)
      advance(15_025)
      expect(useActivityClock.getState().tick).toBe(1)

      for (let i = 0; i < 40; i++) advance(25)
      expect(useActivityClock.getState().tick).toBe(1)
      expect(pendingActivityDeadlines()).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      unsubscribe()
    }
  })

  it('still arms a future deadline after a tick', () => {
    scheduleActivityDeadline(1_000)
    advance(1_025)
    expect(useActivityClock.getState().tick).toBe(1)
    scheduleActivityDeadline(900) // already observed as passed
    expect(vi.getTimerCount()).toBe(0)
    scheduleActivityDeadline(5_000)
    expect(vi.getTimerCount()).toBe(1)
    advance(4_000)
    expect(useActivityClock.getState().tick).toBe(2)
  })

  it('ignores null deadlines', () => {
    scheduleActivityDeadline(null)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('re-derives immediately when the window becomes visible again', () => {
    const before = useActivityClock.getState().tick
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(useActivityClock.getState().tick).toBe(before + 1)
  })
})
