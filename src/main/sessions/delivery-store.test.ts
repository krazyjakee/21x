import { describe, expect, it } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { DeliveryStore } from './delivery-store'

describe('DeliveryStore', () => {
  it('deduplicates enqueue and application acknowledgements by stable key', () => {
    const { db } = createTestDb()
    let now = 1_000
    const store = new DeliveryStore(db, () => now)

    const first = store.enqueue({ idempotencyKey: 'message:one', kind: 'agent_message', payload: 'hello' })
    const duplicate = store.enqueue({ idempotencyKey: 'message:one', kind: 'agent_message', payload: 'changed' })

    expect(first.inserted).toBe(true)
    expect(duplicate.inserted).toBe(false)
    expect(duplicate.record).toEqual(first.record)
    const claim = store.claim(first.record.id, 'owner-a', 100)!
    expect(claim).toMatchObject({ state: 'claimed', attemptCount: 1, claimOwner: 'owner-a' })
    expect(store.claim(first.record.id, 'owner-b', 100)).toBeNull()
    expect(store.accept(first.record.id, 'owner-a', 'provider-turn-1')).toMatchObject({ state: 'accepted' })
    now++
    expect(store.acknowledge(first.record.id, 'owner-a')).toMatchObject({ state: 'acknowledged', destinationId: 'provider-turn-1' })
    expect(store.acknowledge(first.record.id, 'owner-a')).toMatchObject({ state: 'acknowledged' })
  })

  it('reclaims an expired crash lease but never resends an accepted handoff', () => {
    const { db } = createTestDb()
    let now = 2_000
    const store = new DeliveryStore(db, () => now)
    const row = store.enqueue({ idempotencyKey: 'request:crash', kind: 'captain_request', payload: 'ask' }).record
    store.claim(row.id, 'dead-process', 50)
    expect(store.listRecoverable()).toEqual([])

    now = 2_051
    expect(store.listRecoverable()).toMatchObject([{ id: row.id, state: 'claimed' }])
    expect(store.claim(row.id, 'new-process', 50)).toMatchObject({ attemptCount: 2, claimOwner: 'new-process' })
    store.accept(row.id, 'new-process', 'captain-session')
    now = 20_000
    expect(store.listRecoverable('captain_request')).toMatchObject([{ id: row.id, state: 'accepted' }])
    expect(store.claim(row.id, 'third-process', 50)).toBeNull()
  })

  it('expires a silent accepted request exactly once and preserves terminal state against a late race', () => {
    const { db } = createTestDb()
    let now = 3_000
    const store = new DeliveryStore(db, () => now)
    const row = store.enqueue({
      idempotencyKey: 'request:timeout',
      kind: 'captain_request',
      payload: 'ask',
      deadlineAt: 3_100
    }).record
    store.claim(row.id, 'owner', 50)
    store.accept(row.id, 'owner', 'captain-session')

    now = 3_100
    expect(store.expireDeadlines()).toMatchObject([{ id: row.id, state: 'timed_out' }])
    expect(store.expireDeadlines()).toEqual([])
    expect(store.acknowledge(row.id)).toBeNull()
    expect(store.get(row.id)).toMatchObject({ state: 'timed_out' })
  })
  it('refuses reusing a delivery key across projects, tasks, kinds, or source sessions', () => {
    const { db } = createTestDb()
    const store = new DeliveryStore(db)
    const a = db.createProject({ name: 'A' })!
    const b = db.createProject({ name: 'B' })!
    const input = { idempotencyKey: 'collision', kind: 'agent_message' as const, payload: 'first', taskId: db.getCoordinatorTask(a.id)!.id, sourceSessionId: 'origin-a', projectId: a.id }
    store.enqueue(input)
    for (const changed of [{ taskId: db.getCoordinatorTask(b.id)!.id }, { projectId: b.id }, { sourceSessionId: 'origin-b' }, { kind: 'captain_request' as const }]) {
      expect(() => store.enqueue({ ...input, ...changed })).toThrow('different destination')
    }
    expect(store.getByKey('collision')?.payload).toBe('first')
  })

  it('retains pre-Stop rows as cancelled while leaving later rows enqueueable', () => {
    const { db } = createTestDb()
    const store = new DeliveryStore(db)
    const task = db.createTask({ title: 'Stopped task' })!
    const before = store.enqueue({ idempotencyKey: 'before-stop', kind: 'agent_message', taskId: task.id, payload: '{}' }).record
    store.claim(before.id, 'owner', 1_000)
    const cancelled = store.cancelUnacceptedForTask(task.id, 'stopped by user')
    expect(cancelled.map((row) => row.id)).toEqual([before.id])
    expect(store.get(before.id)).toMatchObject({ state: 'cancelled', lastError: 'stopped by user', claimOwner: null })

    const after = store.enqueue({ idempotencyKey: 'after-stop', kind: 'agent_message', taskId: task.id, payload: '{}' }).record
    expect(store.claim(after.id, 'owner', 1_000)).toMatchObject({ state: 'claimed' })
  })

})
