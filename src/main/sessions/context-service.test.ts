import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPortableDbFixture } from '../../../test/helpers/portable-db-test-helper'
import { CommanderStore } from '../commander/commander-store'
import { SessionLedger } from './ledger'
import { SessionContextService } from './context-service'
import { TokenAccounting } from './token-accounting'
import { DEFAULT_ROLLOVER_POLICY } from '../../shared/session-context'

let fixture: ReturnType<typeof createPortableDbFixture>
let service: SessionContextService
let ownerId: string
beforeEach(() => {
  fixture = createPortableDbFixture()
  ownerId = new CommanderStore(fixture.db).createSession('Context').id
  service = new SessionContextService(fixture.db, () => 1000)
})
afterEach(() => fixture.rawDb.close())

describe('read-only session context', () => {
  it('shows only latest model input, distinguishes estimated occupancy and excludes billing totals and summary calls', () => {
    const accounting = new TokenAccounting(fixture.rawDb, () => {}, 'run', () => 1)
    const provider = { id: 'test', model: 'private-model', contextWindow: 100_000, async *stream() {} }
    accounting.beginTurn('user', ownerId, 'user', provider, 350)
    fixture.rawDb.prepare(`INSERT INTO session_usage_calls
      (turn_id, call_index, input_chars, estimated_input_tokens, reported_input_tokens, reported_output_tokens, state)
      VALUES ('user', 1, 350, 100, 80000, 4000, 'completed'), ('user', 2, 700, 200, 1200, 4000, 'completed')`).run()
    accounting.finishTurn('user', 'completed')
    accounting.beginTurn('summary', ownerId, 'summary', provider, 35000)
    fixture.rawDb.prepare(`INSERT INTO session_usage_calls
      (turn_id, call_index, input_chars, estimated_input_tokens, reported_input_tokens, state)
      VALUES ('summary', 1, 35000, 10000, 50000, 'completed')`).run()
    expect(service.getSnapshot({ kind: 'commander', ownerId }).usage).toMatchObject({ tokens: 1200, source: 'reported', contextWindow: 100000 })
    fixture.rawDb.prepare("UPDATE session_usage_calls SET reported_input_tokens = NULL WHERE turn_id = 'user' AND call_index = 2").run()
    expect(service.getSnapshot({ kind: 'commander', ownerId }).usage).toMatchObject({ tokens: 200, source: 'estimated' })
  })

  it('keeps unobserved context unknown, derives deduplicated generation counters and reads policy without sending effects', () => {
    const ledger = new SessionLedger(fixture.rawDb, () => 100)
    const observation = { ownerId, generationKey: 'run', engine: 'chat' as const, eventType: 'compaction', idempotencyKey: 'one-compaction', payload: {} }
    ledger.apply(observation, 'process'); ledger.apply(observation, 'process')
    ledger.apply({ ...observation, eventType: 'wake_received', idempotencyKey: 'wake' }, 'process')
    const before = fixture.rawDb.prepare('SELECT COUNT(*) AS count FROM session_lifecycle_events').get()
    const snapshot = service.getSnapshot({ kind: 'commander', ownerId })
    expect(snapshot.usage).toMatchObject({ tokens: null, source: 'unknown' })
    expect(snapshot.counters).toEqual({ compactions: 1, wakeups: 1, turns: 0, ageMs: 900 })
    expect(snapshot.policy).toEqual(DEFAULT_ROLLOVER_POLICY)
    expect(fixture.rawDb.prepare('SELECT COUNT(*) AS count FROM session_lifecycle_events').get()).toEqual(before)
    expect(service.setPolicy({ ...DEFAULT_ROLLOVER_POLICY, mode: 'observe', compactions: 1 })).toMatchObject({ mode: 'observe', compactions: 1 })
    expect(service.getSnapshot({ kind: 'commander', ownerId }).reasons).toEqual(['compactions'])
    expect(() => service.setPolicy({ ...DEFAULT_ROLLOVER_POLICY, contextRatio: NaN })).toThrow('threshold')
    expect(fixture.db.getSetting('sessions.rollover')).toBe('observe')
  })

  it('rejects foreign or ordinary-task scopes instead of exposing their context as Captain data', () => {
    const task = fixture.db.createTask({ title: 'Ordinary task' })!
    expect(() => service.getSnapshot({ kind: 'captain', ownerId: task.id })).toThrow('Captain session not found')
    expect(() => service.getSnapshot({ kind: 'commander', ownerId: 'missing' })).toThrow('Commander session not found')
    expect(() => service.getSnapshot({ kind: 'project', ownerId })).toThrow('scope')
  })

  it('keeps new-generation occupancy unknown and ignores late calls belonging to an older generation', () => {
    let clock = 100
    const ledger = new SessionLedger(fixture.rawDb, () => clock)
    const accounting = new TokenAccounting(fixture.rawDb, () => {}, 'process', () => clock)
    const provider = { id: 'test', model: 'private-model', contextWindow: 100000, async *stream() {} }
    const turn = (turnKey: string, generationKey: string, reported: number | null, estimated = 10) => {
      ledger.apply({ ownerId, generationKey, engine: 'chat', turnKey, eventType: 'turn_started', idempotencyKey: `${turnKey}:start`, payload: { kind: 'user', input: turnKey } }, 'process')
      accounting.beginTurn(turnKey, ownerId, 'user', provider, estimated * 3.5)
      fixture.rawDb.prepare(`INSERT INTO session_usage_calls
        (turn_id, call_index, input_chars, estimated_input_tokens, reported_input_tokens, state) VALUES (?, 1, ?, ?, ?, 'completed')`)
        .run(turnKey, estimated * 3.5, estimated, reported)
      accounting.finishTurn(turnKey, 'completed')
    }
    turn('old-turn', 'old-generation', 99000)
    expect(service.getSnapshot({ kind: 'commander', ownerId }).usage.tokens).toBe(99000)
    clock = 200
    ledger.apply({ ownerId, generationKey: 'next-generation', engine: 'chat', eventType: 'generation_started', idempotencyKey: 'next:start', payload: {} }, 'process')
    const empty = service.getSnapshot({ kind: 'commander', ownerId })
    expect(empty.generation?.key).toBe('next-generation')
    expect(empty.usage).toMatchObject({ tokens: null, source: 'unknown' })
    expect(empty.reasons).not.toContain('context')
    clock = 300
    turn('new-turn', 'next-generation', null, 200)
    fixture.rawDb.prepare(`INSERT INTO session_usage_calls
      (turn_id, call_index, input_chars, estimated_input_tokens, reported_input_tokens, state) VALUES ('new-turn', 2, 2450, 700, 800, 'completed')`).run()
    clock = 400
    turn('late-old-turn', 'old-generation', 100000)
    const current = service.getSnapshot({ kind: 'commander', ownerId })
    expect(current.generation?.key).toBe('next-generation')
    expect(current.usage).toMatchObject({ tokens: 800, source: 'reported', model: 'private-model', contextWindow: 100000 })
    expect(current.counters.turns).toBe(1)
    expect(current.reasons).not.toContain('context')
    accounting.shutdown()
  })

  it('shows Captain reported context and current-generation counters without estimating billing as context', () => {
    const captain = fixture.db.createTask({ title: 'Context Captain', role: 'captain' })!
    const agent = fixture.db.createAgent({ name: 'Configured Captain', config: { coding_agent: 'codex', model: 'gpt-4o' } })!
    fixture.rawDb.prepare('UPDATE tasks SET agent_id = ? WHERE id = ?').run(agent.id, captain.id)
    let clock = 100
    const ledger = new SessionLedger(fixture.rawDb, () => clock)
    const observe = (generationKey: string, eventType: string, key: string, payload: unknown, turnKey?: string) => ledger.apply({ ownerId: captain.id,
      generationKey, engine: 'adapter', backendId: generationKey, eventType, idempotencyKey: key, payload, turnKey }, 'process')
    observe('old-backend', 'context_usage', 'old-context', { tokens: 100000, source: 'reported', model: 'gpt-4o', contextWindow: 128000, observedAt: 100 })
    observe('old-backend', 'compaction', 'old-compaction', {})
    clock = 200
    observe('new-backend', 'session_started', 'new-start', {})
    expect(service.getSnapshot({ kind: 'captain', ownerId: captain.id }).usage).toMatchObject({ tokens: null, source: 'unknown', model: 'gpt-4o', contextWindow: 128000 })
    observe('new-backend', 'turn_usage', 'billing', { inputTokens: 1000000, outputTokens: 1000000 })
    expect(service.getSnapshot({ kind: 'captain', ownerId: captain.id }).usage.tokens).toBeNull()
    observe('new-backend', 'context_usage', 'new-context', { tokens: 72000, source: 'reported', model: 'deployment-model', contextWindow: 100000, observedAt: 210 })
    observe('new-backend', 'compaction', 'compaction', {})
    observe('new-backend', 'compaction', 'compaction', {})
    observe('new-backend', 'wake_disposition', 'delivered-wake', { disposition: 'delivered' })
    observe('new-backend', 'wake_disposition', 'stale-wake', { disposition: 'stale' })
    observe('new-backend', 'wake_received', 'received-only', {})
    observe('new-backend', 'turn_started', 'captain-turn', { kind: 'captain', input: 'Wake instruction' }, 'captain-turn')
    const before = fixture.rawDb.prepare('SELECT COUNT(*) AS count FROM session_lifecycle_events').get()
    const snapshot = service.getSnapshot({ kind: 'captain', ownerId: captain.id })
    expect(snapshot.usage).toEqual({ tokens: 72000, source: 'reported', model: 'deployment-model', contextWindow: 100000, observedAt: 210 })
    expect(snapshot.counters).toEqual({ compactions: 1, wakeups: 1, turns: 1, ageMs: 800 })
    expect(snapshot.reasons).toContain('context')
    expect(fixture.rawDb.prepare('SELECT COUNT(*) AS count FROM session_lifecycle_events').get()).toEqual(before)
    clock = 300
    observe('old-backend', 'context_usage', 'late-old-context', { tokens: 1, source: 'reported', model: 'old-model', observedAt: 300 })
    expect(service.getSnapshot({ kind: 'captain', ownerId: captain.id }).usage.tokens).toBe(72000)
  })

  it('retains truthful estimated/zero Captain occupancy and keeps malformed native evidence unknown', () => {
    const captain = fixture.db.createTask({ title: 'Unknown-model Captain', role: 'captain' })!
    const ledger = new SessionLedger(fixture.rawDb, () => 100)
    const observe = (key: string, payload: unknown) => ledger.apply({ ownerId: captain.id, generationKey: 'backend', engine: 'adapter', eventType: 'context_usage',
      idempotencyKey: key, payload }, 'process')
    observe('estimate', { tokens: 42, source: 'estimated', model: 'unknown-deployment' })
    expect(service.getSnapshot({ kind: 'captain', ownerId: captain.id }).usage).toMatchObject({ tokens: 42, source: 'estimated', contextWindow: null })
    observe('zero', { tokens: 0, source: 'reported', contextWindow: 2000, observedAt: 200 })
    expect(service.getSnapshot({ kind: 'captain', ownerId: captain.id }).usage).toMatchObject({ tokens: 0, source: 'reported', contextWindow: 2000 })
    observe('invalid', { tokens: -1, source: 'reported', contextWindow: 2000 })
    expect(service.getSnapshot({ kind: 'captain', ownerId: captain.id }).usage).toMatchObject({ tokens: null, source: 'unknown' })
  })
})
