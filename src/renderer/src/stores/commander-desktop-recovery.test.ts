import { beforeEach, expect, it, vi } from 'vitest'
import type { CommanderMessage, CommanderSession } from '@shared/commander'

const mocks = vi.hoisted(() => ({ epoch: 'engine-1', listSessions: vi.fn(), listMessages: vi.fn(), markRead: vi.fn(), setActive: vi.fn(), send: vi.fn() }))
vi.mock('@/lib/desktop-api', () => ({ getDesktopHost: () => ({ connection: { engineEpoch: mocks.epoch } }) }))
vi.mock('@/lib/ipc-client', () => ({ commanderApi: {
  listSessions: mocks.listSessions, listMessages: mocks.listMessages, markRead: mocks.markRead,
  setActiveSession: mocks.setActive, send: mocks.send
} }))
import { rehydrateCommanderDesktopState, useCommanderStore } from './commander-store'

const session: CommanderSession = { id: 'session', title: 'Session', created_at: 1, updated_at: 1, archived: false, last_read_at: null, unread_count: 1 }
const message = (id: string): CommanderMessage => ({ id, session_id: session.id, role: 'report', content: id,
  tool_calls: null, tool_call_id: null, tool_name: null, is_error: false, project_id: null, correlation_id: null, created_at: 1 })
beforeEach(() => {
  vi.resetAllMocks(); mocks.epoch = 'engine-1'
  mocks.listSessions.mockResolvedValue([session])
  mocks.listMessages.mockResolvedValue({ messages: [message('durable-report')], activeTurnId: null })
  useCommanderStore.setState({ selectedSessionId: session.id, sessions: [], messages: {}, streaming: {}, search: '', showArchived: false,
    drafts: { [session.id]: 'Keep my unsent instruction' }, error: null })
})

it('restores durable history and preserves typing without marking quiet reports read or dispatching a model turn', async () => {
  await rehydrateCommanderDesktopState()
  const state = useCommanderStore.getState()
  expect(state.messages[session.id]).toEqual([message('durable-report')])
  expect(state.sessions[0].unread_count).toBe(1)
  expect(state.drafts[session.id]).toBe('Keep my unsent instruction')
  expect(mocks.markRead).not.toHaveBeenCalled(); expect(mocks.setActive).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
})

it('clears stale cached messages and streaming state before restoring the actual active turn', async () => {
  useCommanderStore.setState({ messages: { [session.id]: [message('stale-report')] }, streaming: { [session.id]: { turnId: 'retired-turn', text: 'old reply', toolCalls: [] } } })
  mocks.listMessages.mockResolvedValue({ messages: [], activeTurnId: 'current-turn' })
  await rehydrateCommanderDesktopState()
  expect(useCommanderStore.getState().messages[session.id]).toEqual([])
  expect(useCommanderStore.getState().streaming[session.id]).toEqual({ turnId: 'current-turn', text: '', toolCalls: [] })
})

it('refuses an older read and a retired epoch without overwriting the current durable recovery', async () => {
  let finish!: (value: unknown) => void
  mocks.listMessages.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const old = rehydrateCommanderDesktopState(), rejected = expect(old).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  mocks.epoch = 'engine-2'
  mocks.listMessages.mockResolvedValue({ messages: [message('current-report')], activeTurnId: null })
  await rehydrateCommanderDesktopState()
  finish({ messages: [message('old-report')], activeTurnId: 'old-turn' }); await rejected
  expect(useCommanderStore.getState().messages[session.id]).toEqual([message('current-report')])
  expect(useCommanderStore.getState().streaming).toEqual({})
})

it('merges messages and unread observations arriving during recovery without reviving their completed turn', async () => {
  let finish!: (value: unknown) => void
  mocks.listMessages.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const recovery = rehydrateCommanderDesktopState(), store = useCommanderStore.getState()
  store.handleEvent({ type: 'messages_appended', sessionId: session.id, messages: [message('live-report')] })
  store.handleEvent({ type: 'session_updated', session: { ...session, unread_count: 2, updated_at: 2, is_report_inbox: true } })
  store.handleEvent({ type: 'turn_event', sessionId: session.id, turnId: 'finished-turn', event: { type: 'done', stopReason: 'end_turn' } })
  finish({ messages: [message('durable-report')], activeTurnId: 'finished-turn' }); await recovery
  const state = useCommanderStore.getState()
  expect(state.messages[session.id].map(row => row.id)).toEqual(['durable-report', 'live-report'])
  expect(state.streaming[session.id]).toBeUndefined()
  expect(state.sessions[0].unread_count).toBe(2)
  expect(state.reportInbox?.unread_count).toBe(2)
})

it('preserves a newer live turn and error while rejecting a read for changed filters', async () => {
  let finish!: (value: unknown) => void
  mocks.listMessages.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const recovery = rehydrateCommanderDesktopState(), store = useCommanderStore.getState()
  store.handleEvent({ type: 'turn_started', sessionId: session.id, turnId: 'new-turn' })
  store.handleEvent({ type: 'turn_event', sessionId: session.id, turnId: 'new-turn', event: { type: 'error', message: 'The provider stopped.' } })
  finish({ messages: [], activeTurnId: 'older-turn' }); await recovery
  expect(useCommanderStore.getState().streaming[session.id]?.turnId).toBe('new-turn')
  expect(useCommanderStore.getState().turnErrors[session.id]).toBe('The provider stopped.')
  mocks.listMessages.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const old = rehydrateCommanderDesktopState(), rejected = expect(old).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  useCommanderStore.setState({ search: 'New search', sessions: [{ ...session, title: 'New search' }] })
  finish({ messages: [], activeTurnId: null }); await rejected
  expect(useCommanderStore.getState().sessions[0].title).toBe('New search')
})
