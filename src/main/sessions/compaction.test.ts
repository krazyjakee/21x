import { afterEach, describe, expect, it } from 'vitest'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import { AdapterCompactionTracker, CompactionNormalizer, promptContextTokens, type CompactionScope } from './compaction'
import { ManagedSessionObserver } from './managed-session'

const scope: CompactionScope = { ownerId: 'task', generationKey: 'adapter:session', backendSessionId: 'session', backend: 'codex' }
const databases: ReturnType<typeof createPortableTestDb>[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

describe('backend-session compaction evidence', () => {
  it('requires a strictly greater than 40% drop, ignoring unknown counters and duplicate samples', () => {
    const tracker = new AdapterCompactionTracker('cursor', () => 10)
    tracker.observeContext('session', 'a', 1000)
    tracker.observeContext('session', 'unknown', null)
    tracker.observeContext('session', 'zero', 0)
    tracker.observeContext('session', 'b', 600)
    expect(tracker.snapshot('session')).toEqual([])
    tracker.observeContext('session', 'c', 359, 'turn')
    tracker.observeContext('session', 'c', 359, 'turn')
    expect(tracker.snapshot('session')).toMatchObject([{ source: 'context_drop', beforeTokens: 600, afterTokens: 359 }])
  })

  it('combines explicit evidence and the associated context drop in either arrival order', () => {
    const explicitFirst = new AdapterCompactionTracker('codex', () => 10)
    explicitFirst.observeContext('session', 'a', 1000, 'turn')
    explicitFirst.observeExplicit('session', 'native-item', 'contextCompaction', { turnId: 'turn' })
    explicitFirst.observeExplicit('session', 'native-item', 'contextCompaction', { turnId: 'turn' })
    explicitFirst.observeContext('session', 'b', 300, 'turn')
    expect(explicitFirst.snapshot('session')).toMatchObject([{ source: 'explicit', beforeTokens: 1000, afterTokens: 300 }])
    const dropFirst = new AdapterCompactionTracker('codex', () => 10)
    dropFirst.observeContext('session', 'a', 1000, 'turn')
    dropFirst.observeContext('session', 'b', 300, 'turn')
    dropFirst.observeExplicit('session', 'native-item', 'contextCompaction', { turnId: 'turn', beforeTokens: 1000, afterTokens: 300 })
    expect(dropFirst.snapshot('session')).toMatchObject([{ source: 'context_drop', signal: 'contextCompaction' }])
    expect(dropFirst.snapshot('session')).toHaveLength(1)
  })

  it('does not compare different backend sessions or suppress an unrelated later drop', () => {
    const tracker = new AdapterCompactionTracker('codex')
    tracker.observeContext('old', 'a', 1000)
    tracker.observeContext('new', 'b', 100)
    expect(tracker.snapshot('old')).toEqual([])
    expect(tracker.snapshot('new')).toEqual([])
    tracker.observeExplicit('new', 'explicit', 'contextCompaction', { turnId: 'one' })
    tracker.observeContext('new', 'c', 200, 'one')
    tracker.observeContext('new', 'd', 90, 'two')
    expect(tracker.snapshot('new')).toHaveLength(2)
  })

  it('uses prompt occupancy including backend-specific cache accounting, never billing totals', () => {
    expect(promptContextTokens({ input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 }, 'claude-code')).toBe(1000)
    expect(promptContextTokens({ input: 100, cache: { read: 800, write: 100 }, output: 50000 }, 'opencode')).toBe(1000)
    expect(promptContextTokens({ input: 100, cacheRead: 800, cacheWrite: 100 }, 'pi')).toBe(1000)
    expect(promptContextTokens({ inputTokens: 1000, cachedInputTokens: 800 }, 'codex')).toBe(1000)
    expect(promptContextTokens({ totalTokens: 1000, outputTokens: 1000 }, 'codex')).toBeNull()
  })

  it('retries a frozen pending effect after failed persistence and acknowledges only successful projections', () => {
    const tracker = new AdapterCompactionTracker('codex', () => 10)
    tracker.observeContext('session', 'a', 1000, 'turn')
    tracker.observeExplicit('session', 'native', 'contextCompaction', { turnId: 'turn' })
    const normalizer = new CompactionNormalizer()
    const first = normalizer.observe(tracker.snapshot('session')[0], scope)!
    // Simulate a failed DB write: no acknowledgement. Later usage enriches the
    // adapter observation but the retried inbox payload must remain identical.
    tracker.observeContext('session', 'b', 300, 'turn')
    const retry = normalizer.observe(tracker.snapshot('session')[0], scope)!
    expect(retry).toEqual(first)
    expect(retry.payload.afterTokens).toBeUndefined()
    retry.payload.signal = 'caller mutation'
    retry.part.text = 'caller mutation'
    expect(normalizer.observe(tracker.snapshot('session')[0], scope)).toEqual(first)
    normalizer.acknowledge(first.idempotencyKey)
    expect(normalizer.observe(tracker.snapshot('session')[0], scope)).toBeNull()
  })

  it('freezes late corroboration and rejects stale, foreign and cross-generation observations', () => {
    const tracker = new AdapterCompactionTracker('codex', () => 10)
    tracker.observeContext('session', 'a', 1000, 'turn')
    tracker.observeContext('session', 'b', 300, 'turn')
    const normalizer = new CompactionNormalizer()
    const observation = tracker.snapshot('session')[0]
    expect(normalizer.observe(observation, { ...scope, backendSessionId: 'foreign' })).toBeNull()
    expect(normalizer.observe(observation, { ...scope, backend: 'pi' })).toBeNull()
    expect(normalizer.observe(observation, { ...scope, generationStartedAt: 11 })).toBeNull()
    const first = normalizer.observe(observation, scope)
    tracker.observeExplicit('session', 'late', 'contextCompaction', { turnId: 'turn' })
    expect(normalizer.observe(tracker.snapshot('session')[0], scope)).toEqual(first)
    expect(normalizer.observe(observation, { ...scope, generationKey: 'next-generation' })).toBeNull()
    expect(normalizer.observe(observation, { ...scope, ownerId: 'another-task' })?.idempotencyKey).not.toBe(first?.idempotencyKey)
    expect(new CompactionNormalizer().observe(observation, scope)?.idempotencyKey).toBe(first?.idempotencyKey)
  })

  it('records one lifecycle event without creating a durable handoff, summary or new generation', async () => {
    const db = createPortableTestDb()
    databases.push(db)
    db.setSetting('sessions.ledger', 'observe')
    const observer = new ManagedSessionObserver(db.db, 'test')
    const tracker = new AdapterCompactionTracker('codex', () => 10)
    tracker.observeExplicit('session', 'native', 'contextCompaction')
    const normalizer = new CompactionNormalizer()
    const effect = normalizer.observe(tracker.snapshot('session')[0], scope)!
    const event = { ownerId: scope.ownerId, engine: 'adapter' as const, backendId: 'codex', generationKey: scope.generationKey,
      eventType: effect.eventType, idempotencyKey: effect.idempotencyKey, payload: effect.payload }
    await observer.observe(event)
    await observer.observe(event)
    normalizer.acknowledge(effect.idempotencyKey)
    expect(effect.part).toMatchObject({ type: 'compaction', role: 'system', receivedAt: 10 })
    expect(db.db.prepare("SELECT event_type FROM session_lifecycle_events").all()).toEqual([{ event_type: 'compaction' }])
    expect(db.db.prepare('SELECT generation_key FROM session_generations').all()).toEqual([{ generation_key: scope.generationKey }])
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM session_summaries').get()).toEqual({ count: 0 })
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM session_turns').get()).toEqual({ count: 0 })
    observer.shutdown()
  })
})
