import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import { EventInbox, type SessionObservation } from './event-inbox'
import { ManagedSessionObserver, withSessionOwnerLock } from './managed-session'

const databases: ReturnType<typeof createPortableTestDb>[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function fixture(enabled = true) {
  const db = createPortableTestDb()
  databases.push(db)
  if (enabled) db.setSetting('sessions.ledger', 'observe')
  const observer = new ManagedSessionObserver(db.db, 'process-1')
  const event: SessionObservation = { ownerId: 'commander-1', engine: 'chat', generationKey: 'generation-1', turnKey: 'turn-1',
    eventType: 'turn_started', idempotencyKey: 'turn-1:start', payload: { kind: 'user', input: 'Keep this intent' } }
  return { db, observer, event }
}

describe('observe-only managed session ledger', () => {
  it('is gated off by default and cannot introduce session behavior', async () => {
    const { db, observer, event } = fixture(false)
    await observer.observe(event)
    expect(await observer.reconcileStartup()).toEqual([])
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM session_event_inbox').get()).toEqual({ count: 0 })
    db.setSetting('sessions.ledger', 'true')
    await observer.observe(event)
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM session_turns').get()).toEqual({ count: 1 })
  })

  it('durably records generations, turns, summaries, and lifecycle events once', async () => {
    const { db, observer, event } = fixture()
    await Promise.all([observer.observe(event), observer.observe(event)])
    const done = { ...event, eventType: 'turn_done', idempotencyKey: 'turn-1:done', payload: { stopReason: 'end_turn' } }
    await observer.observe(done)
    await observer.observe(done)
    const summary = { ...event, turnKey: undefined, eventType: 'summary_saved', idempotencyKey: 'summary-1', payload: { content: 'Remember completed work', lastFoldedId: 'message-5' } }
    await observer.observe(summary)
    await observer.observe(summary)
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM session_generations').get()).toEqual({ count: 1 })
    expect(db.db.prepare('SELECT state, input, stop_reason FROM session_turns').get()).toEqual({ state: 'completed', input: 'Keep this intent', stop_reason: 'end_turn' })
    expect(db.db.prepare('SELECT content, last_folded_id FROM session_summaries').get()).toEqual({ content: 'Remember completed work', last_folded_id: 'message-5' })
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM session_lifecycle_events').get()).toEqual({ count: 3 })
    expect(() => observer.observe({ ...event, ownerId: 'wrong-owner' })).toThrow('idempotency')
    expect(() => observer.observe({ ...event, engine: 'adapter' })).toThrow('idempotency')
    expect(() => observer.observe({ ...event, backendId: 'another-provider' })).toThrow('idempotency')
  })

  it('serializes one owner across engine instances while letting other owners proceed', async () => {
    const { db } = fixture()
    const order: string[] = []
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    const first = withSessionOwnerLock(db.db, 'same-owner', async () => { order.push('first-start'); await hold; order.push('first-end') })
    const second = withSessionOwnerLock(db.db, 'same-owner', () => { order.push('second') })
    await withSessionOwnerLock(db.db, 'other-owner', () => { order.push('independent') })
    expect(order).toEqual(['first-start', 'independent'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'independent', 'first-end', 'second'])
  })

  it('reconciles a crash after durable reception without dropping intent or replaying completed tools', async () => {
    const { db, event } = fixture()
    const inbox = new EventInbox(db.db)
    inbox.enqueue(event, 'crashed-process')
    inbox.enqueue({ ...event, eventType: 'tool_call_result', idempotencyKey: 'tool-result-1', payload: { id: 'tool-1', content: 'Task started once', isError: false } }, 'crashed-process')
    db.db.prepare("UPDATE session_event_inbox SET state = 'processing', claim_owner = 'crashed-process' WHERE idempotency_key = ?").run(event.idempotencyKey)
    const restarted = new ManagedSessionObserver(db.db, 'new-process')
    expect(await restarted.reconcileStartup()).toEqual(['turn-1'])
    expect(db.db.prepare('SELECT state, input FROM session_turns').get()).toEqual({ state: 'interrupted', input: 'Keep this intent' })
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM session_lifecycle_events WHERE event_type = 'tool_call_result'").get()).toEqual({ count: 1 })
    expect(await restarted.reconcileStartup()).toEqual([])
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM session_lifecycle_events WHERE event_type = 'crash_reconciled'").get()).toEqual({ count: 1 })
  })

  it('uses the same durable projection for adapter lifecycle observations', async () => {
    const { db, observer, event } = fixture()
    await observer.observe({ ...event, ownerId: 'task-1', engine: 'adapter', backendId: 'codex', generationKey: 'adapter-generation' })
    expect(db.db.prepare('SELECT engine, backend_id FROM session_generations').get()).toEqual({ engine: 'adapter', backend_id: 'codex' })
  })

  it.each([
    ['end_turn', 'completed'], ['cancelled', 'cancelled'], ['error', 'failed'], ['shutdown', 'interrupted']
  ])('retains truthful %s terminal state across crash reconciliation', async (reason, state) => {
    const { db, observer, event } = fixture()
    await observer.observe(event)
    await observer.observe({ ...event, eventType: 'turn_done', idempotencyKey: 'turn-1:done', payload: { stopReason: reason } })
    expect(db.db.prepare('SELECT state, stop_reason FROM session_turns').get()).toEqual({ state, stop_reason: reason })
    expect(await new ManagedSessionObserver(db.db, 'restarted-process').reconcileStartup()).toEqual([])
    expect(db.db.prepare('SELECT state, stop_reason FROM session_turns').get()).toEqual({ state, stop_reason: reason })
  })

  it('projects only owned shutdown work and fences queued observers from late SQLite access', async () => {
    const { db, observer, event } = fixture()
    const sibling = new ManagedSessionObserver(db.db, 'process-1')
    await sibling.observe({ ...event, turnKey: 'sibling-turn', idempotencyKey: 'sibling:start' })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const lock = withSessionOwnerLock(db.db, event.ownerId, () => gate)
    const queued = observer.observe(event)
    const partial = observer.observe({ ...event, eventType: 'text_delta', idempotencyKey: 'partial:1', payload: { text: 'Retained partial' } })
    observer.shutdown()
    expect(db.db.prepare('SELECT state, stop_reason FROM session_turns WHERE turn_key = ?').get(event.turnKey))
      .toEqual({ state: 'interrupted', stop_reason: 'shutdown' })
    expect(db.db.prepare('SELECT state FROM session_turns WHERE turn_key = ?').get('sibling-turn')).toEqual({ state: 'running' })
    const sql = vi.spyOn(db.db, 'prepare')
    release()
    await Promise.all([lock, queued, partial, observer.observe(event), observer.reconcileStartup()])
    observer.shutdown()
    expect(sql).not.toHaveBeenCalled()
    sql.mockRestore()
    await sibling.observe({ ...event, turnKey: 'sibling-turn', eventType: 'turn_done', idempotencyKey: 'sibling:done', payload: { stopReason: 'end_turn' } })
    expect(db.db.prepare('SELECT state FROM session_turns WHERE turn_key = ?').get('sibling-turn')).toEqual({ state: 'completed' })
  })

  it('drains owned non-turn and released terminal observations synchronously on shutdown', async () => {
    const { db, observer, event } = fixture()
    await observer.observe(event)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const lock = withSessionOwnerLock(db.db, event.ownerId, () => gate)
    const queued = [
      observer.observe({ ...event, eventType: 'turn_done', idempotencyKey: 'own:done', payload: { stopReason: 'end_turn' } }),
      observer.observe({ ...event, turnKey: undefined, eventType: 'session_updated', idempotencyKey: 'own:projection:1', payload: { unread: 0 } }),
      observer.observe({ ...event, turnKey: undefined, eventType: 'session_updated', idempotencyKey: 'own:projection:2', payload: { unread: 1 } }),
      observer.observe({ ...event, turnKey: undefined, eventType: 'message_saved', idempotencyKey: 'own:message', payload: { content: 'Retained report' } }),
      observer.observe({ ...event, turnKey: undefined, eventType: 'summary_saved', idempotencyKey: 'own:summary', payload: { content: 'Retained summary' } })
    ]
    // An independently received sibling event retains its own exact key.
    observer.inbox.enqueue({ ...event, turnKey: undefined, eventType: 'message_saved', idempotencyKey: 'sibling:message', payload: { content: 'Sibling report' } }, 'process-1')
    observer.shutdown()
    expect(db.db.prepare('SELECT state, stop_reason FROM session_turns').get()).toEqual({ state: 'completed', stop_reason: 'end_turn' })
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM session_lifecycle_events WHERE event_type = 'session_updated'").get()).toEqual({ count: 2 })
    expect(db.db.prepare('SELECT content FROM session_summaries').get()).toEqual({ content: 'Retained summary' })
    expect(db.db.prepare('SELECT state FROM session_event_inbox WHERE idempotency_key = ?').get('sibling:message')).toEqual({ state: 'pending' })
    expect((observer as unknown as { ownedObservations: Map<string, unknown> }).ownedObservations.size).toBe(0)
    const sql = vi.spyOn(db.db, 'prepare')
    release()
    await Promise.all([lock, ...queued])
    expect(sql).not.toHaveBeenCalled()
    sql.mockRestore()
  })

  it('scopes a reused backend turn key to its exact generation', async () => {
    const { db, observer, event } = fixture()
    await observer.observe(event)
    await observer.observe({ ...event, generationKey: 'generation-2', idempotencyKey: 'generation-2:start' })
    await observer.observe({ ...event, eventType: 'turn_done', idempotencyKey: 'generation-1:done', payload: { stopReason: 'end_turn' } })
    expect(db.db.prepare(`SELECT g.generation_key, t.state FROM session_turns t
      JOIN session_generations g ON g.id = t.generation_id ORDER BY g.generation_key`).all())
      .toEqual([{ generation_key: 'generation-1', state: 'completed' }, { generation_key: 'generation-2', state: 'running' }])
  })

  it('seals distinct owners that use the same backend turn key without losing either intent', async () => {
    const { db, observer, event } = fixture()
    await observer.observe(event)
    await observer.observe({ ...event, ownerId: 'second-owner', idempotencyKey: 'second-owner:start',
      engine: 'adapter', backendId: 'codex' })
    observer.shutdown()
    const turns = db.db.prepare('SELECT owner_id, state, input FROM session_turns ORDER BY owner_id').all()
    expect(turns).toEqual([
      { owner_id: event.ownerId, state: 'interrupted', input: 'Keep this intent' },
      { owner_id: 'second-owner', state: 'interrupted', input: 'Keep this intent' }
    ].sort((a, b) => a.owner_id.localeCompare(b.owner_id)))
  })
})
