import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPortableDbFixture } from '../../../test/helpers/portable-db-test-helper'
import { CommanderService } from './commander-service'
import { CommanderStore } from './commander-store'
import { CaptainDeliveryService } from './captain-delivery'
import type { ChatProvider, ChatProviderEvent } from '../chat/providers/types'

function held() {
  let finish!: () => void
  const promise = new Promise<void>(resolve => { finish = resolve })
  return { promise, finish }
}
function provider(stream: ChatProvider['stream']): ChatProvider {
  return { id: 'fixture', model: 'fixture', stream }
}

describe('Commander raw work and durable delivery ownership', () => {
  let source: ReturnType<typeof createPortableDbFixture>
  let store: CommanderStore
  const owners: Array<CommanderService | CaptainDeliveryService> = []
  beforeEach(() => { source = createPortableDbFixture(); store = new CommanderStore(source.db) })
  afterEach(async () => {
    for (const owner of owners.splice(0)) await owner.close()
    vi.useRealTimers(); vi.restoreAllMocks(); source.rawDb.close()
  })
  function commander(model: ChatProvider) {
    const emit = vi.fn(), createProvider = vi.fn(() => model)
    const owner = new CommanderService({ store, emit, createProvider, budget: { keepTurns: 1, maxChars: 40 } })
    owners.push(owner)
    return { owner, emit, createProvider }
  }

  it('joins an accepted turn, preserves its partial reply and skips title, summary and queued report relay', async () => {
    const gate = held(), entered = vi.fn()
    const model = provider(async function* () {
      yield { type: 'text_delta', text: 'accepted partial reply' }
      entered()
      await gate.promise
    })
    const { owner, emit, createProvider } = commander(model)
    const session = store.createSession()
    owner.setActiveSession(session.id)
    const turn = owner.sendUserMessage(session.id, 'fixture')
    try {
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
      owner.deliverReport({ sessionId: session.id, content: 'accepted report' })
      await expect(owner.close(5)).rejects.toThrow(/SHUTDOWN_INCOMPLETE/)
      emit.mockClear()
      const retry = owner.close()
      gate.finish()
      await turn.done
      await retry
      expect(store.listMessages(session.id).map(message => message.content)).toEqual(['fixture', 'accepted report', 'accepted partial reply'])
      expect(store.getSession(session.id)?.title).toBe('')
      expect(createProvider).toHaveBeenCalledOnce()
      expect(emit).not.toHaveBeenCalled()
      expect(owner.activeSessions()).toEqual([])
    } finally { gate.finish(); await turn.done; await owner.close() }
  })

  it('retains an ignored-abort title and iterator cleanup without late SQL or fallback rename', async () => {
    const gate = held(), cleanup = held(), entered = vi.fn(), finalizing = vi.fn()
    const { owner } = commander(provider(async function* () {
      entered()
      try { await gate.promise; yield { type: 'text_delta', text: 'late title' } }
      finally { finalizing(); await cleanup.promise }
    }))
    const session = store.createSession()
    const first = store.appendMessage(session.id, { role: 'user', content: 'fixture' })
    store.appendMessage(session.id, { role: 'assistant', content: 'reply' })
    source.rawDb.prepare('UPDATE commander_messages SET created_at = ? WHERE id = ?').run(1, first.id)
    const naming = owner.generateTitle(session.id)
    try {
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
      await expect(owner.close(5)).rejects.toThrow('COMMANDER_SHUTDOWN_INCOMPLETE')
      gate.finish()
      await vi.waitFor(() => expect(finalizing).toHaveBeenCalledOnce())
      await expect(owner.close(5)).rejects.toThrow('COMMANDER_SHUTDOWN_INCOMPLETE')
      const sql = vi.spyOn(source.rawDb, 'prepare')
      const retry = owner.close()
      cleanup.finish()
      expect(await naming).toBeNull()
      await retry
      expect(sql).not.toHaveBeenCalled()
      sql.mockRestore()
      expect(store.getSession(session.id)?.title).toBe('')
    } finally { gate.finish(); cleanup.finish(); await naming; await owner.close() }
  })

  it('retains an accepted summary without advancing the durable fold cursor or starting another chunk', async () => {
    const gate = held(), entered = vi.fn()
    const { owner } = commander(provider(async function* () {
      entered(); await gate.promise
      yield { type: 'text_delta', text: 'late summary' }
    }))
    const session = store.createSession('Fixture')
    for (let n = 0; n < 3; n++) {
      store.appendMessage(session.id, { role: 'user', content: 'x'.repeat(100) })
      store.appendMessage(session.id, { role: 'assistant', content: 'reply' })
    }
    const folding = owner.foldHistory(session.id)
    try {
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
      await expect(owner.close(5)).rejects.toThrow('COMMANDER_SHUTDOWN_INCOMPLETE')
      const sql = vi.spyOn(source.rawDb, 'prepare')
      const retry = owner.close()
      gate.finish()
      expect(await folding).toBeNull()
      await retry
      expect(sql).not.toHaveBeenCalled()
      sql.mockRestore()
      expect(store.listMessages(session.id).some(message => message.role === 'summary')).toBe(false)
      expect(owner.foldFailure(session.id)).toBeNull()
    } finally { gate.finish(); await folding; await owner.close() }
  })

  it('cancels queued auxiliary work and rejects closed public writes before SQLite access', async () => {
    const stream = vi.fn(async function* (): AsyncGenerator<ChatProviderEvent> { yield { type: 'text_delta', text: 'unexpected' } })
    const { owner } = commander(provider(stream))
    const session = store.createSession()
    const sql = vi.spyOn(source.rawDb, 'prepare')
    const title = owner.generateTitle(session.id), fold = owner.foldHistory(session.id)
    owner.shutdown()
    await owner.close()
    expect(await title).toBeNull(); expect(await fold).toBeNull()
    expect(() => owner.sendUserMessage(session.id, 'late')).toThrow('COMMANDER_SERVICE_CLOSED')
    expect(() => owner.appendReport({ sessionId: session.id, content: 'late' })).toThrow('COMMANDER_SERVICE_CLOSED')
    await expect(owner.generateTitle(session.id)).rejects.toThrow('COMMANDER_SERVICE_CLOSED')
    expect(sql).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled()
  })

  it('joins a raw Captain send and durably accepts it before database close without replaying it', async () => {
    const gate = held()
    const sendMessage = vi.fn(async () => { await gate.promise; source.db.setSetting('fixture_captain_send', 'settled'); return { newSessionId: 'fixture-session' } })
    const terminal = vi.fn()
    const owner = new CaptainDeliveryService({ db: source.db, agents: { sendMessage }, onTerminalFailure: terminal })
    owners.push(owner)
    const row = owner.store.enqueue({ idempotencyKey: 'fixture', kind: 'captain_request', payload: 'fixture' }).record
    const request = owner.dispatch(row)
    try {
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce())
      await expect(owner.close(5)).rejects.toThrow('CAPTAIN_DELIVERY_SHUTDOWN_INCOMPLETE')
      const retry = owner.close()
      gate.finish()
      await request; await retry
      expect(owner.store.get(row.id)?.state).toBe('accepted')
      expect(source.db.getSetting('fixture_captain_send')).toBe('settled')
      expect(terminal).not.toHaveBeenCalled()
      await expect(owner.dispatch(row)).rejects.toThrow('CAPTAIN_DELIVERY_CLOSED')
    } finally { gate.finish(); await request; await owner.close() }
  })

  it('retains a failed late Captain outcome for next startup without invoking a closed report sink', async () => {
    const gate = held(), entered = vi.fn(), terminal = vi.fn()
    const owner = new CaptainDeliveryService({ db: source.db, agents: { sendMessage: async () => { entered(); await gate.promise; throw new Error('fixture send failed') } }, onTerminalFailure: terminal })
    owners.push(owner)
    const row = owner.store.enqueue({ idempotencyKey: 'failure', kind: 'captain_request', payload: 'fixture' }).record
    const request = owner.dispatch(row)
    try {
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
      owner.shutdown()
      const retry = owner.close()
      gate.finish()
      await request; await retry
      expect(owner.store.get(row.id)?.state).toBe('failed')
      expect(terminal).not.toHaveBeenCalled()
    } finally { gate.finish(); await request; await owner.close() }
  })

  it('cancels queued delivery/recovery and sweep timers without database access', async () => {
    vi.useFakeTimers()
    const owner = new CaptainDeliveryService({ db: source.db, agents: { sendMessage: vi.fn() }, onTerminalFailure: vi.fn() })
    owners.push(owner)
    await owner.reconcile()
    expect(vi.getTimerCount()).toBe(1)
    const row = owner.store.enqueue({ idempotencyKey: 'queued', kind: 'captain_request', payload: 'fixture' }).record
    const sql = vi.spyOn(source.rawDb, 'prepare')
    const request = owner.dispatch(row), recovery = owner.reconcile()
    owner.shutdown()
    await owner.close(); await request; await recovery
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sql).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    await expect(owner.reconcile()).rejects.toThrow('CAPTAIN_DELIVERY_CLOSED')
  })
})
