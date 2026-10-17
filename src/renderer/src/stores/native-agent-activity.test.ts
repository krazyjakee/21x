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
  const invoke = vi.fn(async (command: string) => {
    if (command === 'engine_status') return bootstrap ? bootstrap() : { available: true, protocolVersion: 1, engineEpoch: epoch }
    throw new Error('A freshness observation must not invoke a command')
  })
  const native = { core: { invoke }, event: { listen: vi.fn(async (_name: string, receive: (event: { payload: unknown }) => void) => {
    receivers.add(receive); history.push(receive); return () => { receivers.delete(receive) }
  }) } } as unknown as TauriDesktopApi
  const host = createNativeDesktopHost(native)
  const release = installDesktopHost(host)
  host.setRehydrator(async () => {})
  await host.reconnect()
  const { useAgentStore } = await import('./agent-store')
  const activity = await import('@/lib/activity/session-activity-adapter')
  const { useArtifactStore } = await import('./artifact-store')
  const begin = vi.spyOn(useArtifactStore.getState(), 'beginTurn')
  const end = vi.spyOn(useArtifactStore.getState(), 'endTurn')
  const transitions = vi.fn()
  const retireTransitions = activity.onSessionTransition(transitions)
  const status = (seq = 1, extra: Record<string, unknown> = {}) => ({
    taskId: 'task-1', sessionId: 'session-1', agentId: 'agent-1', status: 'working', epoch: 'source-1', seq, ...extra
  })
  const frame = (payload: unknown) => ({ payload: { protocolVersion: 1, kind: 'event', engineEpoch: epoch,
    sequence: ++sequence, operation: 'agent:status', payload } })
  const emit = (payload: unknown) => { const event = frame(payload); for (const receive of [...receivers]) receive(event) }
  return { host, invoke, useAgentStore, activity, begin, end, transitions, history, receivers, emit, frame, status,
    setBootstrap: (read: (() => Promise<unknown>) | undefined) => { bootstrap = read },
    setEpoch: (value: string) => { epoch = value; sequence = 0 },
    release: () => { retireTransitions(); release() } }
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
