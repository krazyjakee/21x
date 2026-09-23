import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { AdapterUsageTracker, type UsageOwner } from './adapter-usage'
import { SessionUsageStore } from './usage-store'

afterEach(() => vi.restoreAllMocks())

const captain: UsageOwner = { ownerKind: 'captain', ownerId: 'task-c', backend: 'claude-code', model: 'claude-opus-4-6' }

function setup(): { tracker: AdapterUsageTracker; usage: SessionUsageStore } {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const { rawDb } = createTestDb()
  let now = 1_000
  const usage = new SessionUsageStore({ db: rawDb }, () => ++now)
  return { tracker: new AdapterUsageTracker(usage), usage }
}

describe('AdapterUsageTracker', () => {
  it('records reported usage and adds no estimate for that turn', () => {
    const { tracker, usage } = setup()
    tracker.beginTurn('s1', 'Plan the release')
    tracker.report(captain, {
      sessionId: 's1', turnKey: 'result-1', inputTokens: 20, outputTokens: 400, cacheReadTokens: 30_000, cacheWriteTokens: 500,
      contextTokens: 30_520, contextWindow: 1_000_000, costUsd: 0.05, modelCalls: 3, stopReason: 'end_turn'
    })
    tracker.endTurn('s1', captain, 'idle')
    const rows = usage.list('captain', 'task-c')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      turnKey: 'result-1', source: 'reported', engine: 'adapter', backend: 'claude-code', model: 'claude-opus-4-6',
      contextTokens: 30_520, contextSource: 'reported', contextWindow: 1_000_000, windowSource: 'reported', sessionId: 's1'
    })
  })

  it('estimates a turn the backend reported nothing for, anchored on the last reported context', () => {
    const { tracker, usage } = setup()
    tracker.report(captain, { sessionId: 's1', turnKey: 'r1', inputTokens: 10, outputTokens: 10, contextTokens: 40_000, contextWindow: 1_000_000 })

    tracker.beginTurn('s1', 'p'.repeat(700))
    tracker.addOutput('s1', [
      { id: 'part-1', role: 'assistant', content: 'a'.repeat(100) },
      // The same part streamed again, grown: counted once at its final length.
      { id: 'part-1', role: 'assistant', content: 'a'.repeat(350) },
      { id: 'user-echo', role: 'user', content: 'u'.repeat(10_000) }
    ])
    tracker.endTurn('s1', captain, 'idle')

    const [estimated] = usage.list('captain', 'task-c')
    expect(estimated).toMatchObject({
      source: 'estimated', contextSource: 'estimated', stopReason: 'idle',
      outputTokens: 100, contextTokens: 40_000 + 200 + 100, inputTokens: 40_300,
      contextWindow: 1_000_000, windowSource: 'reported'
    })
    expect(estimated.turnKey).toMatch(/^estimated:/)
  })

  it('leaves the context unknown when nothing was reported for this backend session', () => {
    const { tracker, usage } = setup()
    tracker.report(captain, { sessionId: 'old-session', turnKey: 'r1', inputTokens: 10, outputTokens: 10, contextTokens: 90_000 })
    tracker.beginTurn('new-session', 'p'.repeat(35))
    tracker.endTurn('new-session', { ...captain, ownerKind: 'captain' }, 'error')
    const [row] = usage.list('captain', 'task-c')
    expect(row).toMatchObject({ source: 'estimated', inputTokens: 10, contextTokens: null, contextSource: null, windowSource: 'known', stopReason: 'error' })
  })

  it('follows a session re-keyed to the id the backend gave it', () => {
    const { tracker, usage } = setup()
    tracker.beginTurn('temp-id', 'p'.repeat(35))
    tracker.rekey('temp-id', 'real-id')
    tracker.report(captain, { sessionId: 'real-id', turnKey: 'r1', inputTokens: 5, outputTokens: 5 })
    tracker.endTurn('real-id', captain, 'idle')
    tracker.endTurn('temp-id', captain, 'idle')
    expect(usage.list('captain', 'task-c').map((row) => row.source)).toEqual(['reported'])
  })

  it('records nothing for a session that never sent a prompt, and never throws', () => {
    const { tracker, usage } = setup()
    tracker.endTurn('ghost', captain, 'idle')
    expect(usage.list('captain', 'task-c')).toEqual([])
    const broken = new AdapterUsageTracker({
      record: () => { throw new Error('no table') },
      latestReported: () => null,
      calibration: () => null
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    broken.beginTurn('s', 'x')
    expect(() => broken.report(captain, { sessionId: 's', turnKey: 'k', inputTokens: 1, outputTokens: 1 })).not.toThrow()
    broken.beginTurn('s', 'x')
    expect(() => broken.endTurn('s', captain, 'idle')).not.toThrow()
    expect(warn).toHaveBeenCalled()
  })
})
