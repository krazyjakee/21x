import { describe, expect, it } from 'vitest'
import { ActivityAnnouncementQueue, type AnnouncerTimers } from './announcer'

function fakeTimers() {
  let now = 0
  let id = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  const timers: AnnouncerTimers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      pending.set(++id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (h) => pending.delete(h as number)
  }
  const advance = (ms: number) => {
    const target = now + ms
    for (;;) {
      const next = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > target) break
      pending.delete(next[0])
      now = next[1].at
      next[1].fn()
    }
    now = target
  }
  return { timers, advance }
}

describe('ActivityAnnouncementQueue', () => {
  it('speaks actionable announcements at once and never drops them', () => {
    const { timers, advance } = fakeTimers()
    const spoken: string[] = []
    const q = new ActivityAnnouncementQueue((m) => spoken.push(m), timers)
    q.enqueue({ key: 'a:1', entity: 'a', kind: 'actionable', message: 'A needs approval' })
    q.enqueue({ key: 'b:1', entity: 'b', kind: 'actionable', message: 'B failed' })
    q.enqueue({ key: 'a:2', entity: 'a', kind: 'actionable', message: 'A failed' })
    expect(spoken).toEqual(['A needs approval'])
    advance(5_000)
    expect(spoken).toEqual(['A needs approval', 'B failed', 'A failed'])
  })

  it('deduplicates by key (mirrors, repeated pushes)', () => {
    const { timers, advance } = fakeTimers()
    const spoken: string[] = []
    const q = new ActivityAnnouncementQueue((m) => spoken.push(m), timers)
    q.enqueue({ key: 'a:1', entity: 'a', kind: 'actionable', message: 'A needs approval' })
    q.enqueue({ key: 'a:1', entity: 'a', kind: 'actionable', message: 'A needs approval' })
    advance(5_000)
    expect(spoken).toEqual(['A needs approval'])
  })

  it('coalesces routine completions for 2 s and aggregates them', () => {
    const { timers, advance } = fakeTimers()
    const spoken: string[] = []
    const q = new ActivityAnnouncementQueue((m) => spoken.push(m), timers)
    const aggregate = (n: number) => `${n} tasks ready for review`
    for (const t of ['x', 'y', 'z']) q.enqueue({ key: `${t}:r`, entity: t, kind: 'routine', message: `${t} ready for review`, group: 'review', aggregate })
    advance(1_999)
    expect(spoken).toEqual([])
    advance(1)
    expect(spoken).toEqual(['3 tasks ready for review'])
  })

  it('limits routine announcements to one per entity per 5 s', () => {
    const { timers, advance } = fakeTimers()
    const spoken: string[] = []
    const q = new ActivityAnnouncementQueue((m) => spoken.push(m), timers)
    q.enqueue({ key: 'c:1', entity: 'cap', kind: 'routine', message: 'Captain reply finished' })
    advance(3_000)
    q.enqueue({ key: 'c:2', entity: 'cap', kind: 'routine', message: 'Captain reply finished' })
    advance(3_000)
    q.enqueue({ key: 'c:3', entity: 'cap', kind: 'routine', message: 'Captain reply finished again' })
    advance(3_000)
    expect(spoken).toEqual(['Captain reply finished', 'Captain reply finished again'])
  })
})
