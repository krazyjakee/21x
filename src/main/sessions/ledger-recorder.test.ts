import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { SESSION_FLAG_KEYS, isLedgerEnabled } from './flags'
import { AdapterLedgerTracker, SessionLedgerRecorder } from './ledger-recorder'
import type { SessionOwner } from './ledger'
import { SessionUsageStore } from './usage-store'

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

const captain: SessionOwner = { kind: 'captain', id: 'task-1' }
const generation = { engine: 'adapter' as const, provider: 'claude-code', model: 'claude-opus-4-6' }

describe('the sessions.ledger flag', () => {
  it('is on unless switched off', () => {
    expect(isLedgerEnabled(() => undefined)).toBe(true)
    expect(isLedgerEnabled(() => 'on')).toBe(true)
    for (const off of ['off', 'false', '0', 'no', ' OFF ']) expect(isLedgerEnabled(() => off)).toBe(false)
    expect(isLedgerEnabled(() => { throw new Error('locked') })).toBe(true)
  })

  it('stops recording new turns when the setting says off', () => {
    const { db, rawDb } = createTestDb()
    const recorder = new SessionLedgerRecorder({ db: rawDb })
    db.setSetting(SESSION_FLAG_KEYS.ledger, 'off')
    expect(recorder.turnStarted(captain, { dedupeKey: 'wake:1', trigger: 'wake', generation })).toBeNull()
    expect(recorder.ledger.listTurns(captain)).toEqual([])
    db.setSetting(SESSION_FLAG_KEYS.ledger, 'on')
    expect(recorder.turnStarted(captain, { dedupeKey: 'wake:1', trigger: 'wake', generation })).not.toBeNull()
  })

  it('records nothing and never throws over a DB double without SQLite', () => {
    const recorder = new SessionLedgerRecorder({ db: {} as never })
    expect(recorder.isEnabled()).toBe(false)
    expect(recorder.turnStarted(captain, { dedupeKey: 'k', trigger: 'wake', generation })).toBeNull()
  })
})

describe('AdapterLedgerTracker', () => {
  function setup() {
    const { rawDb } = createTestDb()
    const recorder = new SessionLedgerRecorder({ db: rawDb }, { enabled: () => true })
    return { rawDb, ledger: recorder.ledger, tracker: new AdapterLedgerTracker(recorder) }
  }

  it('records a Captain turn from prompt to idle: generation, tool calls and usage', () => {
    const { rawDb, ledger, tracker } = setup()
    tracker.beginTurn('temp-1', captain, { trigger: 'start', dedupeKey: 'start:temp-1', generation })
    tracker.rekey('temp-1', 'backend-1', captain)
    tracker.addOutput('backend-1', [
      { id: 'text-1', partType: 'text' },
      { id: 'tool-1', partType: 'tool', tool: { name: 'Bash', status: 'running' } },
      { id: 'tool-2', partType: 'tool', tool: { name: 'Read', status: 'pending' } }
    ])
    tracker.addOutput('backend-1', [
      { id: 'tool-1', partType: 'tool', tool: { name: 'Bash', status: 'completed' } },
      { id: 'tool-1', partType: 'tool', tool: { name: 'Bash', status: 'running' } },
      { id: 'tool-2', partType: 'tool', tool: { name: 'Read', status: 'error' } }
    ])
    new SessionUsageStore({ db: rawDb }).record({
      ownerKind: 'captain', ownerId: 'task-1', turnKey: 'result-1', engine: 'adapter', backend: 'claude-code',
      source: 'reported', inputTokens: 100, outputTokens: 20, contextTokens: 5_000
    })
    tracker.usage('backend-1', 'result-1')
    tracker.endTurn('backend-1', { status: 'done', stopReason: 'idle' })

    const [turn] = ledger.listTurns(captain)
    expect(turn).toMatchObject({ trigger: 'start', status: 'done', stopReason: 'idle', inputTokens: 100, outputTokens: 20, contextTokensAfter: 5_000, usageSource: 'reported' })
    expect(turn.toolCalls.map((c) => [c.id, c.name, c.status])).toEqual([['tool-1', 'Bash', 'done'], ['tool-2', 'Read', 'error']])
    expect(ledger.currentGeneration(captain)).toMatchObject({ n: 1, backendSessionId: 'backend-1' })
    expect(tracker.openTurn('backend-1')).toBeNull()
  })

  it('ends an open turn when the next prompt arrives, and opens a generation for a new backend session', () => {
    const { ledger, tracker } = setup()
    tracker.beginTurn('backend-1', captain, { trigger: 'user', generation })
    tracker.beginTurn('backend-1', captain, { trigger: 'nudge', generation })
    tracker.endTurn('backend-1', { status: 'done' })
    tracker.beginTurn('backend-2', captain, { trigger: 'system', generation })
    tracker.endTurn('backend-2', { status: 'failed', errorKind: 'session_error' })

    const turns = ledger.listTurns(captain).reverse()
    expect(turns.map((t) => [t.trigger, t.status, t.stopReason])).toEqual([
      ['user', 'done', 'superseded'],
      ['nudge', 'done', null],
      ['system', 'failed', null]
    ])
    expect(ledger.listGenerations(captain).map((g) => [g.n, g.backendSessionId, g.endReason])).toEqual([
      [1, 'backend-1', 'replaced'],
      [2, 'backend-2', null]
    ])
  })

  it('records a durable delivery once, and again only as a retry after it failed', () => {
    const { ledger, tracker } = setup()
    tracker.beginTurn('backend-1', captain, { trigger: 'system', dedupeKey: 'delivery:d1', generation })
    tracker.endTurn('backend-1', { status: 'failed', errorKind: 'session_error' })
    tracker.beginTurn('backend-1', captain, { trigger: 'system', dedupeKey: 'delivery:d1', generation })
    tracker.endTurn('backend-1', { status: 'done' })
    // Delivered once more after it succeeded: nothing is recorded.
    tracker.beginTurn('backend-1', captain, { trigger: 'system', dedupeKey: 'delivery:d1', generation })
    expect(tracker.openTurn('backend-1')).toBeNull()

    expect(ledger.listTurns(captain)).toMatchObject([{ dedupeKey: 'delivery:d1', status: 'done', attempts: 2 }])
  })
})
