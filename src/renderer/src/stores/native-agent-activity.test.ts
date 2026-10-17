import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TauriDesktopApi } from '@/lib/tauri-desktop-transport'

function held<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve } }
async function fixture() {
  // Match production: install the native host before importing the store owners.
  const { installDesktopHost } = await import('@/lib/desktop-api')
  const { createNativeDesktopHost } = await import('@/lib/native-desktop-host')
  let epoch = 'engine-1', sequence = 0
  let bootstrap: (() => Promise<unknown>) | undefined
  const receivers = new Set<(event: { payload: unknown }) => void>()
  const history: Array<(event: { payload: unknown }) => void> = []
  const handlers = new Map<string, (payload: Record<string, unknown>) => Promise<unknown>>()
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'engine_status') return bootstrap ? bootstrap() : { available: true, protocolVersion: 1, engineEpoch: epoch }
    const handler = handlers.get(String(args?.operation))
    if (!handler) throw new Error('A freshness observation must not invoke a command')
    const value = await handler(args?.payload as Record<string, unknown>)
    return { engineEpoch: epoch, result: value === undefined ? { defined: false } : { defined: true, value } }
  })
  const native = { core: { invoke }, event: { listen: vi.fn(async (_name: string, receive: (event: { payload: unknown }) => void) => {
    receivers.add(receive); history.push(receive); return () => { receivers.delete(receive) }
  }) } } as unknown as TauriDesktopApi
  const host = createNativeDesktopHost(native)
  const release = installDesktopHost(host)
  host.setRehydrator(async () => {})
  await host.reconnect()
  const { useAgentStore, rehydrateDesktopAgentState, initializeAgentDesktopState } = await import('./agent-store')
  let retireAgents = initializeAgentDesktopState()
  const initializeAgents = () => { retireAgents = initializeAgentDesktopState(); return retireAgents }
  const activity = await import('@/lib/activity/session-activity-adapter')
  const { useArtifactStore } = await import('./artifact-store')
  const projectParts = vi.spyOn(useArtifactStore.getState(), 'projectTranscriptParts')
  const begin = vi.spyOn(useArtifactStore.getState(), 'beginTurn')
  const end = vi.spyOn(useArtifactStore.getState(), 'endTurn')
  const transitions = vi.fn()
  const retireTransitions = activity.onSessionTransition(transitions)
  const status = (seq = 1, extra: Record<string, unknown> = {}) => ({
    taskId: 'task-1', sessionId: 'session-1', agentId: 'agent-1', status: 'working', epoch: 'source-1', seq, ...extra
  })
  const frame = (payload: unknown, operation = 'agent:status') => ({ payload: { protocolVersion: 1, kind: 'event', engineEpoch: epoch,
    sequence: ++sequence, operation, payload } })
  const emit = (payload: unknown) => { const event = frame(payload); for (const receive of [...receivers]) receive(event) }
  return { host, invoke, useAgentStore, activity, begin, end, transitions, history, receivers, emit, frame, status, handlers, projectParts, rehydrateDesktopAgentState, initializeAgentDesktopState: initializeAgents,
    calls: (operation: string) => invoke.mock.calls.filter(([, args]) => args?.operation === operation).length,
    setBootstrap: (read: (() => Promise<unknown>) | undefined) => { bootstrap = read },
    setEpoch: (value: string) => { epoch = value; sequence = 0 },
    release: () => { retireTransitions(); retireAgents(); release() } }
}
let f: Awaited<ReturnType<typeof fixture>>
const legacy = window.electronAPI
beforeEach(async () => {
  vi.resetModules()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
  f = await fixture()
})
afterEach(() => {
  f.release(); vi.restoreAllMocks()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: legacy })
})

it('records typed poll/disconnect freshness without session, turn, transcript or mutation transitions', () => {
  f.emit(f.status())
  const session = f.useAgentStore.getState().sessions.get('task-1')
  f.begin.mockClear(); f.end.mockClear()
  f.emit(f.status(2, { heartbeat: true }))
  f.emit(f.status(3, { heartbeat: true, disconnected: true }))
  expect(f.activity.useSessionActivityStore.getState().sessions['task-1']).toMatchObject({ status: 'working', disconnected: true })
  f.emit(f.status(4, { heartbeat: true }))
  expect(f.activity.useSessionActivityStore.getState().sessions['task-1'].disconnected).toBeUndefined()
  expect(f.useAgentStore.getState().sessions.get('task-1')).toBe(session)
  expect(f.transitions).not.toHaveBeenCalled(); expect(f.begin).not.toHaveBeenCalled(); expect(f.end).not.toHaveBeenCalled()
  expect(f.invoke.mock.calls.every(([command]) => command === 'engine_status')).toBe(true)
})

it('rejects replayed source sequence and foreign session heartbeats without refreshing observed evidence', () => {
  f.emit(f.status(4, { heartbeat: true }))
  const observed = f.activity.useSessionActivityStore.getState().sessions['task-1']
  f.emit(f.status(4, { heartbeat: true, disconnected: true }))
  f.emit(f.status(3, { heartbeat: true }))
  f.emit(f.status(5, { heartbeat: true, sessionId: 'foreign-session' }))
  expect(f.activity.useSessionActivityStore.getState().sessions['task-1']).toBe(observed)
  expect(f.useAgentStore.getState().sessions.size).toBe(0)
  expect(f.host.connection.status).toBe('ready')
})

it('retires the physical event callback before same-epoch bootstrap and resumes one native listener', async () => {
  f.emit(f.status(1, { heartbeat: true }))
  const oldReceive = f.history[0], observed = f.activity.useSessionActivityStore.getState().sessions['task-1']
  const boot = held<unknown>(); f.setBootstrap(() => boot.promise)
  const reconnect = f.host.reconnect()
  oldReceive(f.frame(f.status(2, { heartbeat: true, disconnected: true })))
  expect(f.receivers.size).toBe(0)
  expect(f.activity.useSessionActivityStore.getState().sessions['task-1']).toBe(observed)
  boot.resolve({ available: true, protocolVersion: 1, engineEpoch: 'engine-1' }); await reconnect
  expect(f.receivers.size).toBe(1)
  oldReceive(f.frame(f.status(3, { heartbeat: true, disconnected: true })))
  expect(f.activity.useSessionActivityStore.getState().sessions['task-1']).toBe(observed)
  f.emit(f.status(4, { heartbeat: true }))
  expect(f.activity.useSessionActivityStore.getState().seq).toBe(4)
  expect(f.useAgentStore.getState().sessions.size).toBe(0)
  expect(f.transitions).not.toHaveBeenCalled()
})

it('accepts a new source epoch after reconnect and refuses resurrection of the retired source', async () => {
  f.emit(f.status(10, { heartbeat: true }))
  f.setEpoch('engine-2'); await f.host.reconnect()
  f.emit(f.status(1, { heartbeat: true, epoch: 'source-2', sessionId: 'session-2' }))
  const current = f.activity.useSessionActivityStore.getState().sessions['task-1']
  f.emit(f.status(11, { heartbeat: true, disconnected: true }))
  expect(f.activity.useSessionActivityStore.getState().sessions['task-1']).toBe(current)
  expect(current.sessionId).toBe('session-2')
  expect(f.activity.useSessionActivityStore.getState().epoch).toBe('source-2')
  expect(f.useAgentStore.getState().sessions.size).toBe(0)
})

it.each([
  { disconnected: true },
  { heartbeat: true, disconnected: true, activityOutcome: 'failed', status: 'error' },
  { heartbeat: true, disconnected: false }
])('refuses malformed disconnect metadata at the native boundary: %j', extra => {
  f.emit(f.status(1, extra))
  expect(f.host.connection.status).toBe('disconnected')
  expect(f.activity.useSessionActivityStore.getState().sessions).toEqual({})
  expect(f.useAgentStore.getState().sessions.size).toBe(0)
})

it('disposes the native event lease so a queued callback cannot mutate activity after document retirement', () => {
  f.emit(f.status(1, { heartbeat: true }))
  const receive = f.history[0], observed = f.activity.useSessionActivityStore.getState().sessions['task-1']
  f.host.dispose()
  receive(f.frame(f.status(2, { heartbeat: true, disconnected: true })))
  expect(f.receivers.size).toBe(0)
  expect(f.activity.useSessionActivityStore.getState().sessions['task-1']).toBe(observed)
  expect(f.useAgentStore.getState().sessions.size).toBe(0)
})


const agent = (id = 'agent-1', name = id) => ({ id, name, server_url: 'http://localhost:4096', config: {},
  is_default: true, created_at: '2026-10-17', updated_at: '2026-10-17' })
it.each(['create', 'update', 'delete'] as const)('preserves accepted agent %s across a delayed native list snapshot', async operation => {
  const pending = held<unknown>(), original = agent(), changed = agent('agent-1', 'Renamed'), added = agent('agent-2')
  let current = [original], first = true
  f.handlers.set('agent:getAll', () => { if (first) { first = false; return pending.promise }; return Promise.resolve(current) })
  f.handlers.set('agent:create', async () => { current = [original, added]; return added })
  f.handlers.set('agent:update', async () => { current = [changed]; return changed })
  f.handlers.set('agent:delete', async () => { current = []; return true })
  f.useAgentStore.setState({ agents: [original] })
  const recovery = f.rehydrateDesktopAgentState()
  await vi.waitFor(() => expect(f.calls('agent:getAll')).toBe(1))
  if (operation === 'create') await f.useAgentStore.getState().createAgent({ name: 'agent-2', config: {} })
  else if (operation === 'update') await f.useAgentStore.getState().updateAgent('agent-1', { name: 'Renamed' })
  else await f.useAgentStore.getState().deleteAgent('agent-1')
  pending.resolve([original]); await recovery
  expect(f.useAgentStore.getState().agents).toEqual(current)
  expect(f.calls('agent:getAll')).toBe(2)
  expect(f.calls(`agent:${operation}`)).toBe(1)
})
it('coalesces native agent recovery reads without duplicating configuration commands', async () => {
  const pending = held<unknown>(); f.handlers.set('agent:getAll', () => pending.promise)
  const first = f.rehydrateDesktopAgentState(), second = f.rehydrateDesktopAgentState()
  await vi.waitFor(() => expect(f.calls('agent:getAll')).toBe(1))
  pending.resolve([agent()]); await Promise.all([first, second])
  expect(f.useAgentStore.getState().agents).toEqual([agent()])
})
it('ignores old same-epoch agent reads without poisoning a replacement recovery', async () => {
  const pending = held<unknown>(), boot = held<unknown>()
  f.handlers.set('agent:getAll', () => pending.promise)
  const old = f.rehydrateDesktopAgentState(), refused = expect(old).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  await vi.waitFor(() => expect(f.calls('agent:getAll')).toBe(1))
  f.setBootstrap(() => boot.promise)
  const reconnect = f.host.reconnect()
  pending.resolve([agent('stale')]); await refused
  expect(f.useAgentStore.getState().agents).toEqual([])
  f.handlers.set('agent:getAll', async () => [agent('current')])
  boot.resolve({ available: true, protocolVersion: 1, engineEpoch: 'engine-1' }); await reconnect
  await f.rehydrateDesktopAgentState()
  expect(f.useAgentStore.getState()).toMatchObject({ agents: [agent('current')], error: null, isLoading: false })
})
it('keeps failed native agent recovery fenced and clears its error only after a successful read', async () => {
  f.handlers.set('agent:getAll', async () => { throw new Error('credential-canary') })
  f.host.setRehydrator(f.rehydrateDesktopAgentState)
  await expect(f.host.rehydrate()).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(f.host.hydrationPending).toBe(true)
  expect(f.useAgentStore.getState().error).not.toContain('credential-canary')
  await expect(f.host.api.agents.create({ name: 'Blocked' })).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(f.calls('agent:create')).toBe(0)
  f.handlers.set('agent:getAll', async () => [agent()])
  await f.host.rehydrate()
  expect(f.host.hydrationPending).toBe(false)
  expect(f.useAgentStore.getState()).toMatchObject({ agents: [agent()], error: null, isLoading: false })
})
it('retires pending agent snapshots with the document listener cohort', async () => {
  const pending = held<unknown>(); f.handlers.set('agent:getAll', () => pending.promise)
  const recovery = f.rehydrateDesktopAgentState(), refused = expect(recovery).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  await vi.waitFor(() => expect(f.calls('agent:getAll')).toBe(1))
  f.initializeAgentDesktopState()()
  pending.resolve([agent('retired')]); await refused
  expect(f.useAgentStore.getState().agents).toEqual([])
})
it('owns one status/transcript subscription cohort and disposes queued callbacks at pagehide', () => {
  const release = f.initializeAgentDesktopState()
  expect(f.initializeAgentDesktopState()).toBe(release)
  window.dispatchEvent(new Event('pagehide'))
  f.emit(f.status(1))
  for (const receive of [...f.receivers]) receive(f.frame({ taskId: 'task-1', parts: [], maxRev: 0 }, 'transcript:changed'))
  expect(f.useAgentStore.getState().sessions.size).toBe(0)
  expect(f.projectParts).not.toHaveBeenCalled()
  f.initializeAgentDesktopState()
  for (const receive of [...f.receivers]) receive(f.frame({ taskId: 'task-1', parts: [], maxRev: 0 }, 'transcript:changed'))
  expect(f.projectParts).toHaveBeenCalledOnce()
  f.emit(f.status(2))
  expect(f.useAgentStore.getState().sessions.get('task-1')).toMatchObject({ sessionId: 'session-1', status: 'working' })
  expect(f.receivers.size).toBe(1)
})
it('does not publish a pending transcript page or artifacts after its document cohort retires', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const pending = held<unknown>(); f.handlers.set('agentSession:getTranscriptPage', payload => {
    const page = payload.page as { mode: string; after: number }
    return page.mode === 'snapshot' ? pending.promise : Promise.resolve({ version: 1, taskId: 'task-1', mode: 'delta', after: page.after, parts: [], cursor: page.after, watermark: page.after, hasMore: false })
  })
  const unbind = f.useAgentStore.getState().bindTranscript('task-1')
  const hydration = f.useAgentStore.getState().hydrateTranscript('task-1')
  await vi.waitFor(() => expect(f.calls('agentSession:getTranscriptPage')).toBe(1))
  f.initializeAgentDesktopState()()
  pending.resolve({ version: 1, taskId: 'task-1', mode: 'snapshot', after: 0, parts: [
    { taskId: 'task-1', partId: 'part-1', seq: 1, rev: 1, role: 'assistant', content: 'retired-content', createdAt: 1, updatedAt: 1 }
  ], cursor: 1, watermark: 1, hasMore: false })
  await hydration
  expect(f.calls('agentSession:getTranscriptPage')).toBe(1)
  expect(errors).not.toHaveBeenCalled()
  expect(f.projectParts).not.toHaveBeenCalled()
  expect(f.useAgentStore.getState().sessions.size).toBe(0)
  unbind()
})

it('bounds an agent snapshot continuously crossed by accepted user edits without replaying those writes', async () => {
  let edits = 0
  f.handlers.set('agent:update', async () => agent('agent-1', `Edit ${++edits}`))
  f.handlers.set('agent:getAll', async () => {
    await f.useAgentStore.getState().updateAgent('agent-1', { name: `Edit ${edits + 1}` })
    return [agent()]
  })
  await expect(f.rehydrateDesktopAgentState()).rejects.toMatchObject({ code: 'BACKPRESSURE' })
  expect(f.calls('agent:getAll')).toBe(8); expect(f.calls('agent:update')).toBe(8)
  expect(f.useAgentStore.getState().isLoading).toBe(false)
  expect(f.useAgentStore.getState().error).toBeTruthy()
})
