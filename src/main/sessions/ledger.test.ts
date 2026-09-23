import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { SessionLedger, type GenerationInfo, type SessionOwner } from './ledger'
import { SessionUsageStore } from './usage-store'

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

const captain: SessionOwner = { kind: 'captain', id: 'task-1' }
const adapter: GenerationInfo = { engine: 'adapter', provider: 'claude-code', model: 'claude-opus-4-6', backendSessionId: 'backend-a' }

function setup(runnerId = 'runner-1') {
  const { rawDb } = createTestDb()
  let now = 1_000
  const clock = () => now
  const ledger = new SessionLedger({ db: rawDb }, clock, { runnerId })
  return {
    rawDb,
    ledger,
    tick: (ms = 1) => { now += ms },
    /** The same database as seen by the next process (a restart). */
    restart: (nextRunner = 'runner-2') => new SessionLedger({ db: rawDb }, clock, { runnerId: nextRunner })
  }
}

describe('SessionLedger generations', () => {
  it('opens generation 1, keeps it for the same backend session and replaces it for another', () => {
    const { ledger, tick } = setup()
    const first = ledger.ensureGeneration(captain, adapter)
    expect(first).toMatchObject({ n: 1, engine: 'adapter', provider: 'claude-code', backendSessionId: 'backend-a', endedAt: null })
    expect(ledger.ensureGeneration(captain, adapter).id).toBe(first.id)
    // No backend id yet (a chat engine, or a session not created yet) keeps the open one.
    expect(ledger.ensureGeneration(captain, { engine: 'adapter' }).id).toBe(first.id)

    tick()
    const second = ledger.ensureGeneration(captain, { ...adapter, backendSessionId: 'backend-b' })
    expect(second).toMatchObject({ n: 2, backendSessionId: 'backend-b', endedAt: null })
    expect(ledger.getGeneration(first.id)).toMatchObject({ endReason: 'replaced', endedAt: 1_001 })
    expect(ledger.listGenerations(captain).map((g) => g.n)).toEqual([1, 2])
  })

  it('fills a missing backend id and follows a re-key without opening a new generation', () => {
    const { ledger } = setup()
    const open = ledger.ensureGeneration(captain, { engine: 'adapter', provider: 'codex' })
    expect(ledger.ensureGeneration(captain, { ...adapter, backendSessionId: 'temp-1' })).toMatchObject({ id: open.id, backendSessionId: 'temp-1', provider: 'codex' })
    ledger.rekeyBackendSession(captain, 'temp-1', 'real-1')
    expect(ledger.ensureGeneration(captain, { ...adapter, backendSessionId: 'real-1' }).id).toBe(open.id)
  })

  it('closes a generation and opens the next seeded one', () => {
    const { ledger } = setup()
    ledger.ensureGeneration(captain, adapter)
    const next = ledger.closeGeneration(captain, 'rollover', { ...adapter, backendSessionId: 'backend-b', seedHandoffId: 'handoff-1' })
    expect(next).toMatchObject({ n: 2, seedHandoffId: 'handoff-1' })
    expect(ledger.listGenerations(captain)[0]).toMatchObject({ endReason: 'rollover' })
    expect(ledger.closeGeneration(captain, 'closed')).toBeNull()
    expect(ledger.currentGeneration(captain)).toBeNull()
  })

  it('never lets an owner have two open generations', () => {
    const { rawDb, ledger } = setup()
    ledger.ensureGeneration(captain, adapter)
    expect(() => rawDb.prepare(`INSERT INTO session_generations (id, owner_kind, owner_id, n, engine, started_at) VALUES ('x', 'captain', 'task-1', 9, 'adapter', 1)`).run())
      .toThrow(/UNIQUE/)
  })
})

describe('SessionLedger turns are idempotent', () => {
  it('records an event once: a repeated key is a no-op', () => {
    const { ledger } = setup()
    const first = ledger.beginTurn(captain, { dedupeKey: 'wake:1', trigger: 'wake', generation: adapter })
    expect(first).toMatchObject({ inserted: true, started: true, turn: { seq: 1, status: 'running', attempts: 1, runnerId: 'runner-1' } })

    const again = ledger.beginTurn(captain, { dedupeKey: 'wake:1', trigger: 'wake', generation: adapter })
    expect(again).toMatchObject({ inserted: false, started: false, turn: { id: first.turn.id, status: 'running', attempts: 1 } })
    expect(ledger.enqueueTurn(captain, { dedupeKey: 'wake:1', trigger: 'wake', generation: adapter }).inserted).toBe(false)
    expect(ledger.listTurns(captain)).toHaveLength(1)

    // The key is unique per owner, not globally.
    expect(ledger.beginTurn({ kind: 'task', id: 'task-2' }, { dedupeKey: 'wake:1', trigger: 'wake', generation: adapter }).inserted).toBe(true)
  })

  it('finishes a turn once and closes its unfinished tool calls', () => {
    const { ledger, tick } = setup()
    const { turn } = ledger.beginTurn(captain, { dedupeKey: 'user:m1', trigger: 'user', generation: adapter })
    ledger.toolCallStarted(turn.id, { id: 'call-1', name: 'list_tasks' })
    ledger.toolCallStarted(turn.id, { id: 'call-1', name: 'list_tasks' })
    ledger.toolCallStarted(turn.id, { id: 'call-2', name: 'update_task' })
    tick()
    ledger.toolCallFinished(turn.id, { id: 'call-1', isError: false })
    ledger.toolCallFinished(turn.id, { id: 'call-1', isError: true })
    tick()

    const finished = ledger.finishTurn(turn.id, { status: 'done', stopReason: 'end_turn' })
    expect(finished).toMatchObject({ status: 'done', stopReason: 'end_turn', endedAt: 1_002 })
    expect(finished!.toolCalls.map((c) => [c.id, c.status])).toEqual([['call-1', 'done'], ['call-2', 'interrupted']])

    // Over is over: a second finish, a late tool result or a retry-less repeat change nothing.
    expect(ledger.finishTurn(turn.id, { status: 'failed' })).toBeNull()
    ledger.toolCallFinished(turn.id, { id: 'call-2' })
    expect(ledger.getTurn(turn.id)).toEqual(finished)
  })

  it('runs a failed delivery again only when asked to retry it', () => {
    const { ledger } = setup()
    const { turn } = ledger.beginTurn(captain, { dedupeKey: 'delivery:d1', trigger: 'system', generation: adapter })
    ledger.finishTurn(turn.id, { status: 'failed', errorKind: 'send_failed', errorDetail: 'x'.repeat(5_000) })
    expect(ledger.getTurn(turn.id)!.errorDetail).toHaveLength(2_000)

    expect(ledger.beginTurn(captain, { dedupeKey: 'delivery:d1', trigger: 'system', generation: adapter }).started).toBe(false)
    const retried = ledger.beginTurn(captain, { dedupeKey: 'delivery:d1', trigger: 'system', generation: adapter, retry: true })
    expect(retried).toMatchObject({ retried: true, started: true, turn: { id: turn.id, status: 'running', attempts: 2, errorKind: null } })
    ledger.finishTurn(turn.id, { status: 'done' })
    // A done turn is never retried.
    expect(ledger.beginTurn(captain, { dedupeKey: 'delivery:d1', trigger: 'system', generation: adapter, retry: true }).started).toBe(false)
  })

  it('promotes a queued turn once, and orders turns by seq across generations', () => {
    const { ledger } = setup()
    const queued = ledger.enqueueTurn(captain, { dedupeKey: 'report:r1', trigger: 'report', generation: adapter })
    expect(queued.turn).toMatchObject({ status: 'queued', attempts: 0, startedAt: null })
    expect(ledger.startTurn(queued.turn.id)).toMatchObject({ status: 'running', attempts: 1 })
    expect(ledger.startTurn(queued.turn.id)).toBeNull()
    ledger.finishTurn(queued.turn.id, { status: 'done' })

    const next = ledger.beginTurn(captain, { dedupeKey: 'wake:2', trigger: 'wake', generation: { ...adapter, backendSessionId: 'backend-b' } })
    expect(next.turn.seq).toBe(2)
    expect(next.turn.generationId).not.toBe(queued.turn.generationId)
    expect(ledger.listTurns(captain).map((t) => t.seq)).toEqual([2, 1])
  })

  it('records dropped and coalesced events once', () => {
    const { ledger } = setup()
    const into = ledger.enqueueTurn(captain, { dedupeKey: 'wake:1', trigger: 'wake', generation: adapter }).turn
    expect(ledger.recordCoalesced(captain, { dedupeKey: 'wake:2', trigger: 'wake', generation: adapter, into: into.id }).turn)
      .toMatchObject({ status: 'coalesced', coalescedInto: into.id })
    expect(ledger.recordCoalesced(captain, { dedupeKey: 'wake:2', trigger: 'wake', generation: adapter, into: into.id }).inserted).toBe(false)
    expect(ledger.recordDropped(captain, { dedupeKey: 'wake:3', trigger: 'wake', generation: adapter, reason: 'stale' }).turn)
      .toMatchObject({ status: 'dropped', errorKind: 'dropped', errorDetail: 'stale' })
    expect(ledger.dropQueued(into.id, 'cancelled')).toMatchObject({ status: 'dropped' })
    expect(ledger.dropQueued(into.id, 'again')).toBeNull()
  })
})

describe('SessionLedger usage', () => {
  it('sums linked usage rows and never counts a replayed report twice', () => {
    const { rawDb, ledger } = setup()
    const usage = new SessionUsageStore({ db: rawDb })
    const base = { ownerKind: 'captain' as const, ownerId: 'task-1', engine: 'adapter' as const, backend: 'claude-code', source: 'reported' as const }
    usage.record({ ...base, turnKey: 'u1', inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, contextTokens: 115 })
    usage.record({ ...base, turnKey: 'u2', inputTokens: 20, outputTokens: 7, contextTokens: 140 })

    const { turn } = ledger.beginTurn(captain, { dedupeKey: 'wake:1', trigger: 'wake', generation: adapter })
    ledger.attachUsage(turn.id, 'u1')
    ledger.attachUsage(turn.id, 'u1')
    expect(ledger.attachUsage(turn.id, 'u2')).toMatchObject({ usageKeys: ['u1', 'u2'], inputTokens: 130, outputTokens: 12, contextTokensAfter: 140, usageSource: 'reported' })

    // The backend re-reports u2 (a cumulative update): the row is replaced, the sum follows.
    usage.record({ ...base, turnKey: 'u2', inputTokens: 25, outputTokens: 9, contextTokens: 150 })
    expect(ledger.attachUsage(turn.id, 'u2')).toMatchObject({ inputTokens: 135, outputTokens: 14, contextTokensAfter: 150 })

    usage.record({ ...base, turnKey: 'estimated:x', source: 'estimated', inputTokens: 1, outputTokens: 1 })
    expect(ledger.attachUsage(turn.id, 'estimated:x')).toMatchObject({ usageSource: 'estimated' })
  })
})

describe('SessionLedger summaries', () => {
  it('records a summary once per generation and key, and completes a pending one once', () => {
    const { ledger } = setup()
    const gen = ledger.ensureGeneration(captain, adapter)
    const first = ledger.recordSummary(gen.id, { kind: 'fold', dedupeKey: 'fold:m9', coversThroughRef: 'm8', content: { messageId: 'm9' } })
    expect(first).toMatchObject({ inserted: true, summary: { kind: 'fold', status: 'done', coversThroughRef: 'm8', content: { messageId: 'm9' } } })
    expect(ledger.recordSummary(gen.id, { kind: 'fold', dedupeKey: 'fold:m9', content: { other: true } })).toMatchObject({ inserted: false, summary: { id: first.summary.id, content: { messageId: 'm9' } } })

    const handoff = ledger.recordSummary(gen.id, { kind: 'handoff', dedupeKey: 'handoff:1', status: 'pending', content: {} }).summary
    expect(ledger.completeSummary(handoff.id, 'degraded', { goals: [] })).toMatchObject({ status: 'degraded', content: { goals: [] } })
    expect(ledger.completeSummary(handoff.id, 'done')).toBeNull()
    expect(ledger.listSummaries(gen.id).map((s) => s.kind)).toEqual(['fold', 'handoff'])
  })
})

describe('SessionLedger crash recovery', () => {
  it('marks the unfinished turns of a previous process interrupted and closes their tool calls', () => {
    const { ledger, restart, tick } = setup('runner-old')
    const running = ledger.beginTurn(captain, { dedupeKey: 'wake:1', trigger: 'wake', generation: adapter }).turn
    ledger.toolCallStarted(running.id, { id: 'call-1', name: 'Bash' })
    ledger.toolCallStarted(running.id, { id: 'call-2', name: 'Read' })
    ledger.toolCallFinished(running.id, { id: 'call-2' })
    const queued = ledger.enqueueTurn({ kind: 'commander', id: 's1' }, { dedupeKey: 'report:r1', trigger: 'report', generation: { engine: 'chat' } }).turn
    const done = ledger.beginTurn(captain, { dedupeKey: 'wake:0', trigger: 'wake', generation: adapter }).turn
    ledger.finishTurn(done.id, { status: 'done' })

    tick(10)
    const next = restart('runner-new')
    // A turn the new process already started is its own: recovery leaves it alone.
    const fresh = next.beginTurn({ kind: 'task', id: 'task-9' }, { dedupeKey: 'start:x', trigger: 'start', generation: adapter }).turn

    const report = next.recoverInterrupted()
    expect(report.closedToolCalls).toBe(1)
    expect(report.interrupted.map((t) => [t.dedupeKey, t.errorKind])).toEqual([
      ['wake:1', 'crash_during_turn'],
      ['report:r1', 'crash_before_start']
    ])
    const recovered = next.getTurn(running.id)!
    expect(recovered).toMatchObject({ status: 'interrupted', endedAt: 1_010 })
    expect(recovered.toolCalls.map((c) => [c.id, c.status])).toEqual([['call-1', 'interrupted'], ['call-2', 'done']])
    expect(next.getTurn(queued.id)).toMatchObject({ status: 'interrupted', startedAt: null })
    expect(next.getTurn(done.id)).toMatchObject({ status: 'done' })
    expect(next.getTurn(fresh.id)).toMatchObject({ status: 'running' })

    // Recovery is idempotent, and an interrupted turn is never finished late.
    expect(next.recoverInterrupted()).toEqual({ interrupted: [], closedToolCalls: 0 })
    expect(ledger.finishTurn(running.id, { status: 'done' })).toBeNull()
    // The interrupted event is still recorded once; retrying it is explicit.
    expect(next.beginTurn(captain, { dedupeKey: 'wake:1', trigger: 'wake', generation: adapter }).started).toBe(false)
    expect(next.beginTurn(captain, { dedupeKey: 'wake:1', trigger: 'wake', generation: adapter, retry: true }).turn).toMatchObject({ status: 'running', attempts: 2, runnerId: 'runner-new' })
  })
})
