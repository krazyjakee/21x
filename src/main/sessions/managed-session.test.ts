import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { EventInbox, type InboxBatch } from './event-inbox'
import { SessionLedger, type SessionOwner } from './ledger'
import { ManagedSession, OwnerLocks, recoverSessionLedger, type TurnOutcome } from './managed-session'

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

const captain: SessionOwner = { kind: 'captain', id: 'task-1' }
const commander: SessionOwner = { kind: 'commander', id: 'session-1' }

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('OwnerLocks', () => {
  it('runs one holder per owner at a time, in call order, and never blocks other owners', async () => {
    const locks = new OwnerLocks()
    const order: string[] = []
    const gate = deferred()
    const first = locks.run('captain:a', async () => {
      order.push('a1 start')
      await gate.promise
      order.push('a1 end')
    })
    const second = locks.run('captain:a', () => { order.push('a2') })
    const other = locks.run('captain:b', () => { order.push('b1') })
    await other
    expect(order).toEqual(['a1 start', 'b1'])
    expect(locks.isHeld('captain:a')).toBe(true)
    gate.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['a1 start', 'b1', 'a1 end', 'a2'])
    expect(locks.isBusy('captain:a')).toBe(false)
  })

  it('releases the lock when a holder fails', async () => {
    const locks = new OwnerLocks()
    await expect(locks.run('k', () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(locks.run('k', () => 'next')).resolves.toBe('next')
  })
})

describe('EventInbox', () => {
  it('dedupes by key, coalesces waiting batches and records every event in the ledger', () => {
    const { rawDb } = createTestDb()
    const ledger = new SessionLedger({ db: rawDb })
    const inbox = new EventInbox({ ledger: () => ledger })

    const first = inbox.push({ owner: captain, kind: 'wake', dedupeKey: 'wake:1', payload: 'a', coalesce: true })
    expect(first.status).toBe('queued')
    expect(inbox.push({ owner: captain, kind: 'wake', dedupeKey: 'wake:2', payload: 'b', coalesce: true }).status).toBe('coalesced')
    expect(inbox.push({ owner: captain, kind: 'wake', dedupeKey: 'wake:1', payload: 'a' }).status).toBe('duplicate')
    expect(inbox.push({ owner: captain, kind: 'user', dedupeKey: 'user:1', payload: 'hi' }).status).toBe('queued')

    const batches = inbox.pending(captain)
    expect(batches.map((b) => [b.kind, b.payload, b.events.length])).toEqual([['wake', 'a\n\nb', 2], ['user', 'hi', 1]])
    const turns = ledger.listTurns(captain).reverse()
    expect(turns.map((t) => [t.dedupeKey, t.status])).toEqual([['wake:1', 'queued'], ['wake:2', 'coalesced'], ['user:1', 'queued']])
    expect(turns[1].coalescedInto).toBe(turns[0].id)

    expect(inbox.take(captain)?.dedupeKey).toBe('wake:1')
    expect(inbox.size(captain)).toBe(1)
  })

  it('treats an event the ledger already has as a duplicate after a restart', () => {
    const { rawDb } = createTestDb()
    const before = new EventInbox({ ledger: () => new SessionLedger({ db: rawDb }) })
    before.push({ owner: captain, kind: 'report', dedupeKey: 'report:r1', payload: 'done' })
    const after = new EventInbox({ ledger: () => new SessionLedger({ db: rawDb }) })
    expect(after.push({ owner: captain, kind: 'report', dedupeKey: 'report:r1', payload: 'done' }).status).toBe('duplicate')
    expect(after.size(captain)).toBe(0)
  })

  it('dedupes in memory when no ledger is attached, and records dropped batches when one is', () => {
    const plain = new EventInbox({ recentKeys: 2 })
    expect(plain.push({ owner: captain, kind: 'wake', dedupeKey: 'k1', payload: '' }).status).toBe('queued')
    expect(plain.push({ owner: captain, kind: 'wake', dedupeKey: 'k1', payload: '' }).status).toBe('duplicate')
    expect(() => plain.push({ owner: captain, kind: 'wake', dedupeKey: '', payload: '' })).toThrow(/dedupe key/)

    const { rawDb } = createTestDb()
    const ledger = new SessionLedger({ db: rawDb })
    const inbox = new EventInbox({ ledger: () => ledger })
    inbox.push({ owner: captain, kind: 'wake', dedupeKey: 'wake:old', payload: 'stale' })
    inbox.push({ owner: captain, kind: 'user', dedupeKey: 'user:1', payload: 'keep' })
    const dropped = inbox.drop(captain, 'stale wake-up', (b) => b.kind === 'wake')
    expect(dropped.map((b) => b.dedupeKey)).toEqual(['wake:old'])
    expect(inbox.pending(captain).map((b) => b.dedupeKey)).toEqual(['user:1'])
    expect(ledger.getTurnByKey(captain, 'wake:old')).toMatchObject({ status: 'dropped', errorDetail: 'stale wake-up' })
  })
})

describe('ManagedSession', () => {
  function session(options: { ledgerOn?: () => boolean; run?: (batch: InboxBatch) => Promise<TurnOutcome> } = {}) {
    const { rawDb } = createTestDb()
    const ledger = new SessionLedger({ db: rawDb })
    const current = () => (options.ledgerOn?.() ?? true ? ledger : null)
    const inbox = new EventInbox({ ledger: current })
    const locks = new OwnerLocks()
    const ran: string[] = []
    let running = 0
    let maxRunning = 0
    const managed = new ManagedSession(captain, {
      inbox,
      locks,
      ledger: current,
      run: async (batch, context) => {
        running++
        maxRunning = Math.max(maxRunning, running)
        ran.push(batch.dedupeKey)
        context.toolCallStarted({ id: `${batch.dedupeKey}:tool`, name: 'list_tasks' })
        try {
          return options.run ? await options.run(batch) : { status: 'done', stopReason: 'end_turn' }
        } finally {
          running--
        }
      }
    })
    return { rawDb, ledger, inbox, managed, ran, maxRunning: () => maxRunning }
  }

  it('runs delivered events one at a time, in order, and records each turn', async () => {
    const gate = deferred()
    const { managed, ledger, ran, maxRunning } = session({
      run: async (batch) => {
        if (batch.dedupeKey === 'user:1') await gate.promise
        return { status: 'done', stopReason: 'end_turn' }
      }
    })
    const first = managed.deliver({ kind: 'user', dedupeKey: 'user:1', payload: 'first' })
    const second = managed.deliver({ kind: 'report', dedupeKey: 'report:1', payload: 'second' })
    await Promise.resolve()
    expect(managed.state()).toMatchObject({ busy: true, queued: 1, generation: { n: 1, engine: 'adapter' } })
    gate.resolve()
    await Promise.all([first.done, second.done])

    expect(ran).toEqual(['user:1', 'report:1'])
    expect(maxRunning()).toBe(1)
    const turns = ledger.listTurns(captain).reverse()
    expect(turns.map((t) => [t.dedupeKey, t.status, t.stopReason])).toEqual([['user:1', 'done', 'end_turn'], ['report:1', 'done', 'end_turn']])
    // A tool call the turn left open is closed when the turn ends.
    expect(turns[0].toolCalls).toMatchObject([{ id: 'user:1:tool', status: 'interrupted' }])
    expect(managed.state()).toMatchObject({ busy: false, queued: 0 })
  })

  it('makes a repeated event a no-op, also after a restart', async () => {
    const { rawDb, managed, ran } = session()
    await managed.deliver({ kind: 'wake', dedupeKey: 'wake:1', payload: 'x' }).done
    const repeat = managed.deliver({ kind: 'wake', dedupeKey: 'wake:1', payload: 'x' })
    expect(repeat.status).toBe('duplicate')
    await repeat.done

    // A new process: new inbox, new session, same database.
    const ledger = new SessionLedger({ db: rawDb }, Date.now, { runnerId: 'next' })
    const restarted = new ManagedSession(captain, {
      inbox: new EventInbox({ ledger: () => ledger }),
      locks: new OwnerLocks(),
      ledger: () => ledger,
      run: async (batch) => { ran.push(`again:${batch.dedupeKey}`); return { status: 'done' } }
    })
    expect(restarted.deliver({ kind: 'wake', dedupeKey: 'wake:1', payload: 'x' }).status).toBe('duplicate')
    await restarted.idle()
    expect(ran).toEqual(['wake:1'])
    expect(ledger.listTurns(captain)).toHaveLength(1)
  })

  it('records a turn whose runner throws as failed and keeps going', async () => {
    const { managed, ledger } = session({
      run: async (batch) => {
        if (batch.dedupeKey === 'user:bad') throw new Error('provider exploded')
        return { status: 'done' }
      }
    })
    managed.deliver({ kind: 'user', dedupeKey: 'user:bad', payload: '' })
    await managed.deliver({ kind: 'user', dedupeKey: 'user:good', payload: '' }).done
    expect(ledger.getTurnByKey(captain, 'user:bad')).toMatchObject({ status: 'failed', errorKind: 'exception', errorDetail: 'provider exploded' })
    expect(ledger.getTurnByKey(captain, 'user:good')).toMatchObject({ status: 'done' })
  })

  it('skips a batch dropped from the ledger before it ran', async () => {
    const gate = deferred()
    const { managed, ledger, ran } = session({
      run: async (batch) => {
        if (batch.dedupeKey === 'user:1') await gate.promise
        return { status: 'done' }
      }
    })
    const first = managed.deliver({ kind: 'user', dedupeKey: 'user:1', payload: '' })
    managed.deliver({ kind: 'wake', dedupeKey: 'wake:stale', payload: '' })
    ledger.dropQueued(ledger.getTurnByKey(captain, 'wake:stale')!.id, 'stale')
    gate.resolve()
    await first.done
    await managed.idle()
    expect(ran).toEqual(['user:1'])
  })

  it('runs turns without recording anything when the flag is off', async () => {
    const { managed, ledger, ran } = session({ ledgerOn: () => false })
    await managed.deliver({ kind: 'user', dedupeKey: 'user:1', payload: '' }).done
    expect(ran).toEqual(['user:1'])
    expect(ledger.listTurns(captain)).toEqual([])
    expect(managed.state().generation).toBeNull()
  })
})

describe('recoverSessionLedger', () => {
  it('interrupts the turns a crashed process left running, once', () => {
    const { rawDb } = createTestDb()
    const crashed = new SessionLedger({ db: rawDb }, Date.now, { runnerId: 'crashed' })
    const turn = crashed.beginTurn(commander, { dedupeKey: 'user:m1', trigger: 'user', generation: { engine: 'chat', provider: 'anthropic' } }).turn
    crashed.toolCallStarted(turn.id, { id: 'toolu_1', name: 'create_task' })

    const report = recoverSessionLedger({ db: rawDb })
    expect(report).toMatchObject({ closedToolCalls: 1, interrupted: [{ id: turn.id, status: 'interrupted', errorKind: 'crash_during_turn' }] })
    expect(recoverSessionLedger({ db: rawDb })).toEqual({ interrupted: [], closedToolCalls: 0 })
  })

  it('never throws, even without the ledger tables', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { rawDb } = createTestDb()
    rawDb.exec('DROP TABLE session_summaries; DROP TABLE session_turns')
    expect(recoverSessionLedger({ db: rawDb })).toBeNull()
  })
})
