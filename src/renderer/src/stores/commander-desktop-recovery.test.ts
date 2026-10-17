import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CommanderEvent, CommanderMessage, CommanderSession } from '@shared/commander'

import type { TauriDesktopApi } from '@/lib/tauri-desktop-transport'

function held<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve } }
async function fixture() {
  const { installDesktopHost } = await import('@/lib/desktop-api')
  const { createNativeDesktopHost } = await import('@/lib/native-desktop-host')
  let epoch = 'engine-1', sequence = 0
  const receivers = new Set<(event: { payload: unknown }) => void>()
  const history: Array<(event: { payload: unknown }) => void> = []
  const api = { listSessions: vi.fn(), listMessages: vi.fn(), markRead: vi.fn(), setActive: vi.fn(), send: vi.fn(), create: vi.fn(), rename: vi.fn(), archive: vi.fn() }
  const dispatch: Record<string, (payload: Record<string, unknown>) => unknown> = {
    'commander:listSessions': value => api.listSessions(value), 'commander:listMessages': value => api.listMessages(value.sessionId),
    'commander:markRead': value => api.markRead(value.sessionId), 'commander:setActiveSession': value => api.setActive(value.sessionId),
    'commander:send': value => api.send(value), 'commander:createSession': value => api.create(value),
    'commander:renameSession': value => api.rename(value.id, value.title), 'commander:archiveSession': value => api.archive(value.id, value.archived)
  }
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'engine_status') return { available: true, protocolVersion: 1, engineEpoch: epoch }
    const handler = dispatch[String(args?.operation)]
    if (!handler) throw new Error('Unexpected operation')
    const value = await handler(args?.payload as Record<string, unknown>)
    return { engineEpoch: epoch, result: value === undefined ? { defined: false } : { defined: true, value } }
  })
  const native = { core: { invoke }, event: { listen: vi.fn(async (_name: string, receive: (event: { payload: unknown }) => void) => {
    receivers.add(receive); history.push(receive); return () => { receivers.delete(receive) }
  }) } } as unknown as TauriDesktopApi
  const host = createNativeDesktopHost(native), release = installDesktopHost(host)
  host.setRehydrator(async () => {})
  await host.reconnect()
  const store = await import('./commander-store')
  const { commanderApi } = await import('@/lib/ipc-client')
  const callbacks: Array<(event: CommanderEvent) => void> = []
  const onEvent = commanderApi.onEvent
  const observe = vi.spyOn(commanderApi, 'onEvent').mockImplementation(callback => { callbacks.push(callback); return onEvent(callback) })
  const frame = (payload: unknown) => ({ payload: { protocolVersion: 1, kind: 'event', engineEpoch: epoch,
    sequence: ++sequence, operation: 'commander:event', payload } })
  return { ...store, ...api, host, invoke, history, receivers, frame, callbacks, observe,
    emit: (payload: unknown) => { for (const receive of [...receivers]) receive(frame(payload)) },
    setEpoch: (value: string) => { epoch = value; sequence = 0 },
    release: () => { store.retireCommanderDesktopState(); release() } }
}
let f: Awaited<ReturnType<typeof fixture>>
const legacy = window.electronAPI
const session: CommanderSession = { id: 'session', title: 'Session', created_at: 1, updated_at: 1, archived: false, last_read_at: null, unread_count: 1 }
const message = (id: string): CommanderMessage => ({ id, session_id: session.id, role: 'report', content: id,
  tool_calls: null, tool_call_id: null, tool_name: null, is_error: false, project_id: null, correlation_id: null, created_at: 1 })
beforeEach(async () => {
  vi.resetModules()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
  f = await fixture()
  f.listSessions.mockResolvedValue([session])
  f.listMessages.mockResolvedValue({ messages: [message('durable-report')], activeTurnId: null })
  f.useCommanderStore.setState({ selectedSessionId: session.id, sessions: [], messages: {}, streaming: {}, search: '', showArchived: false,
    drafts: { [session.id]: 'Keep my unsent instruction' }, error: null })
})

it('restores durable history and preserves typing without marking quiet reports read or dispatching a model turn', async () => {
  await f.rehydrateCommanderDesktopState()
  const state = f.useCommanderStore.getState()
  expect(state.messages[session.id]).toEqual([message('durable-report')])
  expect(state.sessions[0].unread_count).toBe(1)
  expect(state.drafts[session.id]).toBe('Keep my unsent instruction')
  expect(f.markRead).not.toHaveBeenCalled(); expect(f.setActive).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
})

it('clears stale cached messages and streaming state before restoring the actual active turn', async () => {
  f.useCommanderStore.setState({ messages: { [session.id]: [message('stale-report')] }, streaming: { [session.id]: { turnId: 'retired-turn', text: 'old reply', toolCalls: [] } } })
  f.listMessages.mockResolvedValue({ messages: [], activeTurnId: 'current-turn' })
  await f.rehydrateCommanderDesktopState()
  expect(f.useCommanderStore.getState().messages[session.id]).toEqual([])
  expect(f.useCommanderStore.getState().streaming[session.id]).toEqual({ turnId: 'current-turn', text: '', toolCalls: [] })
})

it('refuses an older read and a retired epoch without overwriting the current durable recovery', async () => {
  let finish!: (value: unknown) => void
  f.listMessages.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const old = f.rehydrateCommanderDesktopState(), rejected = expect(old).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  f.setEpoch('engine-2'); await f.host.reconnect()
  f.listMessages.mockResolvedValue({ messages: [message('current-report')], activeTurnId: null })
  await f.rehydrateCommanderDesktopState()
  finish({ messages: [message('old-report')], activeTurnId: 'old-turn' }); await rejected
  expect(f.useCommanderStore.getState().messages[session.id]).toEqual([message('current-report')])
  expect(f.useCommanderStore.getState().streaming).toEqual({})
})

it('merges messages and unread observations arriving during recovery without reviving their completed turn', async () => {
  let finish!: (value: unknown) => void
  f.listMessages.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const recovery = f.rehydrateCommanderDesktopState(), store = f.useCommanderStore.getState()
  store.handleEvent({ type: 'messages_appended', sessionId: session.id, messages: [message('live-report')] })
  f.listSessions.mockResolvedValue([{ ...session, unread_count: 2, updated_at: 2, is_report_inbox: true }])
  store.handleEvent({ type: 'session_updated', session: { ...session, unread_count: 2, updated_at: 2, is_report_inbox: true } })
  store.handleEvent({ type: 'turn_event', sessionId: session.id, turnId: 'finished-turn', event: { type: 'done', stopReason: 'end_turn' } })
  finish({ messages: [message('durable-report')], activeTurnId: 'finished-turn' }); await recovery
  const state = f.useCommanderStore.getState()
  expect(state.messages[session.id].map(row => row.id)).toEqual(['durable-report', 'live-report'])
  expect(state.streaming[session.id]).toBeUndefined()
  expect(state.sessions[0].unread_count).toBe(2)
  expect(state.reportInbox?.unread_count).toBe(2)
})

it('preserves a newer live turn and error while rejecting a read for changed filters', async () => {
  let finish!: (value: unknown) => void
  f.listMessages.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const recovery = f.rehydrateCommanderDesktopState(), store = f.useCommanderStore.getState()
  store.handleEvent({ type: 'turn_started', sessionId: session.id, turnId: 'new-turn' })
  store.handleEvent({ type: 'turn_event', sessionId: session.id, turnId: 'new-turn', event: { type: 'error', message: 'The provider stopped.' } })
  finish({ messages: [], activeTurnId: 'older-turn' }); await recovery
  expect(f.useCommanderStore.getState().streaming[session.id]?.turnId).toBe('new-turn')
  expect(f.useCommanderStore.getState().turnErrors[session.id]).toBe('The provider stopped.')
  f.listMessages.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const list = held<unknown>(); f.listSessions.mockImplementationOnce(() => list.promise)
  const old = f.rehydrateCommanderDesktopState(), rejected = expect(old).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  await vi.waitFor(() => expect(f.listSessions).toHaveBeenCalledTimes(2))
  f.useCommanderStore.setState({ search: 'New search', sessions: [{ ...session, title: 'New search' }] })
  list.resolve([session]); finish({ messages: [], activeTurnId: null }); await rejected
  expect(f.useCommanderStore.getState().sessions[0].title).toBe('New search')
})

afterEach(() => {
  f.release(); vi.restoreAllMocks()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: legacy })
})

it('coalesces duplicate reads and retries changed filters using authoritative body search results', async () => {
  const first = held<unknown>(), bodyMatch = { ...session, id: 'body-match', title: 'Other title' }
  f.listSessions.mockImplementationOnce(() => first.promise).mockImplementation(async options => options.search === 'body' ? [bodyMatch] : [])
  const old = f.useCommanderStore.getState().fetchSessions()
  await vi.waitFor(() => expect(f.listSessions).toHaveBeenCalledTimes(1))
  const duplicate = f.useCommanderStore.getState().fetchSessions()
  const next = f.useCommanderStore.getState().setSearch('body')
  const archived = f.useCommanderStore.getState().setShowArchived(true)
  expect(f.listSessions).toHaveBeenCalledTimes(1)
  first.resolve([session]); await Promise.all([old, duplicate, next, archived])
  expect(f.useCommanderStore.getState().sessions).toEqual([bodyMatch])
  expect(f.listSessions).toHaveBeenCalledWith({ search: 'body', includeArchived: true })
  expect(f.listSessions).toHaveBeenCalledTimes(3) // current query plus independent inbox read
  expect(f.markRead).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
})

it.each(['create', 'rename', 'archive'] as const)('preserves accepted %s across a held session snapshot without replay', async operation => {
  const first = held<unknown>(), changed = { ...session, title: 'Renamed', archived: operation === 'archive' }
  let current = [session]
  f.listSessions.mockImplementationOnce(() => first.promise).mockImplementation(async () => current)
  f.create.mockImplementation(async () => { current = [{ ...session, id: 'new-session' }, session]; return current[0] })
  f.rename.mockImplementation(async () => { current = [changed]; return changed })
  f.archive.mockImplementation(async () => { current = []; return changed })
  const read = f.useCommanderStore.getState().fetchSessions()
  await vi.waitFor(() => expect(f.listSessions).toHaveBeenCalledTimes(1))
  if (operation === 'create') await f.useCommanderStore.getState().createSession()
  if (operation === 'rename') await f.useCommanderStore.getState().renameSession(session.id, 'Renamed')
  if (operation === 'archive') await f.useCommanderStore.getState().archiveSession(session.id, true)
  first.resolve([session]); await read
  expect(f.useCommanderStore.getState().sessions).toEqual(current)
  expect(f[operation]).toHaveBeenCalledTimes(1)
  expect(f.listSessions).toHaveBeenCalledTimes(2)
})

it('retains session updates delivered while a typed list is in flight', async () => {
  const first = held<unknown>(), updated = { ...session, unread_count: 2, is_report_inbox: true }
  const unsubscribe = f.useCommanderStore.getState().subscribe()
  f.listSessions.mockImplementationOnce(() => first.promise).mockResolvedValue([updated])
  const read = f.useCommanderStore.getState().fetchSessions()
  await vi.waitFor(() => expect(f.listSessions).toHaveBeenCalledTimes(1))
  f.emit({ type: 'session_updated', session: updated })
  first.resolve([session]); await read
  expect(f.useCommanderStore.getState().sessions).toEqual([updated])
  expect(f.useCommanderStore.getState().reportInbox).toEqual(updated)
  unsubscribe()
})

it('does not publish a retired list into the next subscriber cohort', async () => {
  const first = held<unknown>(), updated = { ...session, title: 'Current' }
  const unsubscribe = f.useCommanderStore.getState().subscribe()
  f.listSessions.mockImplementationOnce(() => first.promise).mockResolvedValue([updated])
  const old = f.useCommanderStore.getState().fetchSessions()
  await vi.waitFor(() => expect(f.listSessions).toHaveBeenCalledTimes(1))
  unsubscribe()
  const next = f.useCommanderStore.getState().subscribe()
  await f.useCommanderStore.getState().fetchSessions()
  first.resolve([session]); await old
  expect(f.useCommanderStore.getState().sessions).toEqual([updated])
  expect(f.useCommanderStore.getState().error).toBeNull()
  next()
})

it('marks only the still-selected thread read when a prior history response is delayed', async () => {
  const first = held<unknown>()
  f.setActive.mockResolvedValue(undefined); f.markRead.mockResolvedValue(null)
  f.listMessages.mockImplementationOnce(() => first.promise).mockResolvedValue({ messages: [], activeTurnId: null })
  const old = f.useCommanderStore.getState().selectSession('old')
  await f.useCommanderStore.getState().selectSession('new')
  first.resolve({ messages: [message('late')], activeTurnId: 'old-turn' }); await old
  expect(f.useCommanderStore.getState().selectedSessionId).toBe('new')
  expect(f.useCommanderStore.getState().messages.old).toBeUndefined()
  expect(f.markRead.mock.calls).toEqual([['new']])
  expect(f.setActive.mock.calls).toEqual([['old'], ['new']]) // explicit intents only
})

it('joins subscriber retirement and ignores held history or queued old events after pagehide', async () => {
  const first = held<unknown>()
  const one = f.useCommanderStore.getState().subscribe(), two = f.useCommanderStore.getState().subscribe()
  f.listMessages.mockImplementationOnce(() => first.promise)
  const selecting = f.useCommanderStore.getState().selectSession(session.id)
  one(); one()
  f.emit({ type: 'session_updated', session })
  expect(f.useCommanderStore.getState().sessions).toEqual([session])
  expect(f.observe).toHaveBeenCalledTimes(1)
  const retired = f.callbacks[0]
  window.dispatchEvent(new Event('pagehide'))
  retired({ type: 'session_updated', session: { ...session, title: 'Queued retired callback' } })
  f.emit({ type: 'session_updated', session: { ...session, title: 'Retired' } })
  first.resolve({ messages: [message('late')], activeTurnId: 'old-turn' }); await selecting
  expect(f.useCommanderStore.getState().sessions).toEqual([session])
  expect(f.useCommanderStore.getState().messages[session.id]).toBeUndefined()
  expect(f.markRead).not.toHaveBeenCalled()
  const next = f.useCommanderStore.getState().subscribe()
  expect(f.observe).toHaveBeenCalledTimes(2)
  two() // an old unsubscriber cannot release the replacement cohort
  f.emit({ type: 'session_updated', session: { ...session, title: 'Replacement' } })
  expect(f.useCommanderStore.getState().sessions[0].title).toBe('Replacement')
  next()
  f.emit({ type: 'session_updated', session: { ...session, title: 'Late' } })
  expect(f.useCommanderStore.getState().sessions[0].title).toBe('Replacement')
})

it.each(['done', 'new-turn'] as const)('does not revive a stale history turn after %s during selection', async mode => {
  const first = held<unknown>()
  const unsubscribe = f.useCommanderStore.getState().subscribe()
  f.listMessages.mockImplementationOnce(() => first.promise); f.markRead.mockResolvedValue(null)
  const selecting = f.useCommanderStore.getState().selectSession(session.id)
  if (mode === 'done') f.emit({ type: 'turn_event', sessionId: session.id, turnId: 'old-turn', event: { type: 'done', stopReason: 'end_turn' } })
  else f.emit({ type: 'turn_started', sessionId: session.id, turnId: 'new-turn' })
  first.resolve({ messages: [], activeTurnId: 'old-turn' }); await selecting
  expect(f.useCommanderStore.getState().streaming[session.id]?.turnId).toBe(mode === 'done' ? undefined : 'new-turn')
  unsubscribe()
})

it('rejects a same-epoch history result from before reconnect without marking reports read', async () => {
  const first = held<unknown>()
  f.listMessages.mockImplementationOnce(() => first.promise)
  const selecting = f.useCommanderStore.getState().selectSession(session.id)
  await f.host.reconnect()
  first.resolve({ messages: [message('retired')], activeTurnId: 'old-turn' }); await selecting
  expect(f.useCommanderStore.getState().messages[session.id]).toBeUndefined()
  expect(f.markRead).not.toHaveBeenCalled()
})

it('keeps native mutations fenced after failed strict list recovery and allows explicit successful retry', async () => {
  f.useCommanderStore.setState({ selectedSessionId: null })
  f.host.setRehydrator(f.rehydrateCommanderDesktopState)
  f.listSessions.mockRejectedValueOnce(new Error('Do not expose this detail'))
  await expect(f.host.reconnect()).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(f.host.hydrationPending).toBe(true)
  await expect(f.host.api.commander.createSession()).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(f.create).not.toHaveBeenCalled()
  await f.host.reconnect()
  expect(f.host.hydrationPending).toBe(false)
  expect(f.useCommanderStore.getState().error).toBeNull()
})

it('bounds continuous session invalidation without replaying explicit rename mutations', async () => {
  f.useCommanderStore.setState({ selectedSessionId: null })
  f.rename.mockResolvedValue(session)
  f.listSessions.mockImplementation(async () => {
    await f.useCommanderStore.getState().renameSession(session.id, 'Session')
    return [session]
  })
  await expect(f.rehydrateCommanderDesktopState()).rejects.toMatchObject({ code: 'BACKPRESSURE' })
  expect(f.listSessions).toHaveBeenCalledTimes(8)
  expect(f.rename).toHaveBeenCalledTimes(8)
})

it('rejects a held recovery history when the same thread is explicitly selected again', async () => {
  const first = held<unknown>()
  f.listMessages.mockImplementationOnce(() => first.promise).mockResolvedValue({ messages: [message('current')], activeTurnId: null })
  f.markRead.mockResolvedValue(null)
  const old = f.rehydrateCommanderDesktopState(), rejected = expect(old).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  await f.useCommanderStore.getState().selectSession(session.id)
  first.resolve({ messages: [message('old')], activeTurnId: 'retired-turn' }); await rejected
  expect(f.useCommanderStore.getState().messages[session.id]).toEqual([message('current')])
  expect(f.useCommanderStore.getState().streaming[session.id]).toBeUndefined()
  expect(f.markRead).toHaveBeenCalledTimes(1) // explicit selection only
})

it('keeps a newer observed turn running when an older turn terminal arrives late', () => {
  const unsubscribe = f.useCommanderStore.getState().subscribe()
  f.emit({ type: 'turn_started', sessionId: session.id, turnId: 'current-turn' })
  f.emit({ type: 'turn_event', sessionId: session.id, turnId: 'old-turn', event: { type: 'done', stopReason: 'end_turn' } })
  expect(f.useCommanderStore.getState().streaming[session.id]?.turnId).toBe('current-turn')
  f.emit({ type: 'turn_event', sessionId: session.id, turnId: 'current-turn', event: { type: 'done', stopReason: 'end_turn' } })
  expect(f.useCommanderStore.getState().streaming[session.id]).toBeUndefined()
  unsubscribe()
})
