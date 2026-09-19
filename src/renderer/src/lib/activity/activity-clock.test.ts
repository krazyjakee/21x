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
