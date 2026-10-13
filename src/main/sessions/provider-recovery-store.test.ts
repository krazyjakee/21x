import { afterEach, describe, expect, it } from 'vitest'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import { classifyProviderFailure } from '../agent-manager/provider-failure'
import { ProviderRecoveryStore } from './provider-recovery-store'

const databases: ReturnType<typeof createPortableTestDb>[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

function fixture() {
  const db = createPortableTestDb()
  databases.push(db)
  const task = db.createTask({ title: 'Provider recovery' })!
  const now = 1_000_000
  const store = new ProviderRecoveryStore(db, () => now)
  const row = store.begin({ taskId: task.id, sessionId: 'thread', agentId: 'agent', prompt: 'Start the next task', remainingAgentIds: ['fallback-1', 'fallback-2'], attemptedAgentIds: ['agent'] })
  return { db, task, store, row, now }
}

describe('durable active-turn recovery', () => {
  it('keeps intent, attempt, deadline, delivery boundary and fallback order across restart', () => {
    const { db, store, row } = fixture()
    const retry = store.schedule(row, classifyProviderFailure('serverOverloaded', 'turn_failed'))!
    const fallback = store.change(retry, { selectedFallback: 'fallback-1', attemptedAgentIds: ['agent', 'fallback-1'], remainingAgentIds: ['fallback-2'] })!
    const reopened = new ProviderRecoveryStore(db)
    expect(reopened.get(row.taskId)).toEqual(fallback)
    expect(reopened.list(['retrying'])).toEqual([fallback])
  })
  it('fences stale acknowledgements and cancel beats an in-flight send', () => {
    const { store, row } = fixture()
    const retry = store.schedule(row, classifyProviderFailure('503', 'rejected'))!
    expect(store.change(row, { state: 'accepted' })).toBeNull()
    store.cancel(row.taskId)
    expect(store.change(retry, { state: 'accepted' })).toBeNull()
    expect(store.get(row.taskId)).toMatchObject({ state: 'cancelled', prompt: '' })
  })
  it('queries only pending states and retires completed prompt payloads', () => {
    const { db, store, row } = fixture()
    store.change(row, { state: 'completed' })
    expect(store.get(row.taskId)?.prompt).toBe('')
    // A deliberately corrupt completed audit row cannot poison retry scheduling.
    db.db.prepare("UPDATE agent_provider_recovery SET record = 'invalid JSON' WHERE task_id = ?").run(row.taskId)
    expect(store.list(['retrying'])).toEqual([])
    expect(() => store.get(row.taskId)).toThrow()
  })
})
