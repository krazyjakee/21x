import { afterEach, expect, it, vi } from 'vitest'
import type { TauriDesktopApi } from './tauri-desktop-transport'
import { createNativeDesktopHost, type NativeDesktopHost } from './native-desktop-host'
import { desktopApi, installDesktopHost } from './desktop-api'
import type { ServiceEvent } from '@shared/service-protocol'
const hosts: NativeDesktopHost[] = [], releases: Array<() => void> = []
afterEach(() => { for (const release of releases.splice(0)) release(); for (const host of hosts.splice(0)) host.dispose() })
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve: (value: T) => resolve(value) } }
function fixture() {
  let epoch = 'engine-1', sequence = 0
  const receivers = new Set<(event: { payload: unknown }) => void>(), history: Array<(event: { payload: unknown }) => void> = []
  const results = new Map<string, unknown>([['settings:get', 'dark'], ['settings:getAll', {}], ['db:getTasks', []], ['project:getAll', []], ['agent:getAll', []], ['agentSession:getTranscriptSnapshot', []], ['agentSession:getTranscriptDelta', { parts: [], maxRev: 0 }], ['agentSession:approve', { success: true }]])
  const unlisten = vi.fn()
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (command === 'engine_status') return { available: true, protocolVersion: 1, engineEpoch: epoch }
    const result = results.get(String(args?.operation))
    return { engineEpoch: epoch, result: result === undefined ? { defined: false } : { defined: true, value: result } }
  })
  const listen = vi.fn(async (_name: string, receive: (event: { payload: unknown }) => void) => { receivers.add(receive); history.push(receive); return () => { receivers.delete(receive); unlisten() } })
  const host = createNativeDesktopHost({ core: { invoke }, event: { listen } } as unknown as TauriDesktopApi); hosts.push(host)
  const emit = (operation: ServiceEvent['operation'], payload: ServiceEvent['payload']) => { const event = { protocolVersion: 1, kind: 'event', operation, payload, engineEpoch: epoch, sequence: ++sequence }; for (const receive of [...receivers]) receive({ payload: event }) }
  return { host, invoke, listen, unlisten, results, history, emit, changeEpoch: () => { epoch = 'engine-2'; sequence = 0 } }
}
it('uses exact codecs and trusted host metadata; missing binary/files/Commander bindings never reach native or Electron', async () => {
  const f = fixture(); releases.push(installDesktopHost(f.host))
  f.host.setRehydrator(async () => {}); await f.host.reconnect()
  expect(await desktopApi.settings.get('theme')).toBe('dark')
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'settings:get', payload: { key: 'theme' }, engineEpoch: 'engine-1' })
  await expect(desktopApi.settings.get('api_key')).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  const before = f.invoke.mock.calls.length
  await expect(desktopApi.voice.pushAudio('turn', new Uint8Array([1, 2]))).rejects.toMatchObject({ code: 'DESKTOP_UNAVAILABLE', capability: 'voice.pushAudio' })
  await expect(desktopApi.commander.send('session', 'hello')).rejects.toMatchObject({ code: 'DESKTOP_UNAVAILABLE' })
  await expect(desktopApi.shell.openPath('/private')).rejects.toMatchObject({ code: 'DESKTOP_UNAVAILABLE' })
  expect(() => desktopApi.webUtils.getPathForFile(new File([], 'private'))).toThrow('unavailable')
  expect(desktopApi.commander.onEvent).toBeUndefined(); expect(Reflect.get(desktopApi, 'browser')).toBeUndefined()
  expect(f.host.supports('commander.send')).toBe(false); expect(f.invoke.mock.calls.length).toBe(before)
})
it('fences writes until durable recovery finishes and never replays a mutation interrupted by reconnect', async () => {
  const f = fixture(), hydration = deferred<void>()
  await f.host.reconnect()
  await expect(f.host.api.settings.set('theme', 'light')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  f.host.setRehydrator(() => hydration.promise)
  const restoring = f.host.rehydrate()
  await expect(f.host.api.settings.set('theme', 'light')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  hydration.resolve(); await restoring
  const pending = deferred<unknown>(), original = f.invoke.getMockImplementation()!
  f.invoke.mockImplementation((command, args) => command === 'desktop_invoke' && args?.operation === 'settings:set' ? pending.promise : original(command, args))
  const writing = f.host.api.settings.set('theme', 'light'), rejected = expect(writing).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  f.changeEpoch(); await f.host.reconnect(); await rejected
  pending.resolve({ engineEpoch: 'engine-1', result: { defined: false } }); await Promise.resolve()
  expect(f.invoke.mock.calls.filter(([command, args]) => command === 'desktop_invoke' && args?.operation === 'settings:set')).toHaveLength(1)
})
it('keeps native subscriptions across reconnect, releases old owners, and emits only local recovery invalidation', async () => {
  const f = fixture(), callback = vi.fn(), refreshed = vi.fn()
  const off = f.host.api.onTaskDeleted(callback), offRefresh = f.host.api.onTasksRefresh(refreshed)
  expect(f.host.api.onWorktreeProgress).toBeUndefined()
  f.host.setRehydrator(async () => {}); await f.host.reconnect(); expect(refreshed).toHaveBeenCalledOnce()
  f.emit('task:deleted', { taskId: 'task-1' }); expect(callback).toHaveBeenCalledWith({ taskId: 'task-1' })
  f.changeEpoch(); await f.host.reconnect(); expect(f.unlisten).toHaveBeenCalledOnce(); expect(refreshed).toHaveBeenCalledTimes(2)
  f.history[0]?.({ payload: { protocolVersion: 1, kind: 'event', operation: 'task:deleted', payload: { taskId: 'late' }, engineEpoch: 'engine-1', sequence: 2 } })
  expect(callback).toHaveBeenCalledOnce()
  f.emit('task:deleted', { taskId: 'task-2' }); expect(callback).toHaveBeenCalledTimes(2)
  f.emit('tasks:refresh', {}); expect(refreshed).toHaveBeenCalledTimes(3)
  off(); offRefresh(); f.host.dispose(); expect(f.unlisten).toHaveBeenCalledTimes(2)
})
it('does not let a delayed older recovery enable writes after the current recovery failed', async () => {
  const f = fixture(), old = deferred<void>()
  await f.host.reconnect()
  const restore = vi.fn().mockReturnValueOnce(old.promise).mockRejectedValueOnce(new Error('Snapshot unavailable'))
  f.host.setRehydrator(restore)
  const first = f.host.rehydrate(), firstRejected = expect(first).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  await expect(f.host.rehydrate()).rejects.toThrow('Snapshot unavailable')
  expect(f.host.recoveryFailed).toBe(true)
  old.resolve(); await firstRejected
  expect(f.host.hydrationPending).toBe(true)
  await expect(f.host.api.settings.set('theme', 'light')).rejects.toMatchObject({ code: 'DISCONNECTED' })
})
it('blocks approval until matching-session durable reads cover the observed transcript revision', async () => {
  const f = fixture(); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  f.emit('agent:status', { sessionId: 'session-1', taskId: 'task-1', agentId: 'agent-1', status: 'waiting_approval' })
  f.emit('transcript:changed', { taskId: 'task-1', parts: [], maxRev: 4, reloadRequired: true })
  await expect(f.host.api.agentSession.approve('session-1', true, undefined, 'permission', 'request-1')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  await f.host.api.agentSession.getTranscriptSnapshot('task-1')
  await expect(f.host.api.agentSession.approve('session-1', true, undefined, 'permission', 'request-1')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  f.results.set('agentSession:getTranscriptDelta', { parts: [], maxRev: 4 })
  await f.host.api.agentSession.getTranscriptDelta('task-1', 0)
  await expect(f.host.api.agentSession.approve('session-1', true, undefined, 'permission', 'request-1')).resolves.toEqual({ success: true })
  await expect(f.host.api.agentSession.approve('different-session', true, undefined, 'permission', 'request-1')).rejects.toMatchObject({ code: 'DISCONNECTED' })
})
