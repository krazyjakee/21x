import { afterEach, expect, it, vi } from 'vitest'
import type { TauriDesktopApi } from './tauri-desktop-transport'
import { createNativeDesktopHost, NATIVE_COMMAND_BINDINGS, type NativeDesktopHost } from './native-desktop-host'
import { PRODUCTION_API_KEY_SET_MARKER } from '@shared/production-settings-codecs'
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
it('uses exact codecs and trusted host metadata; missing binary/file bindings never reach native or Electron', async () => {
  const f = fixture(); releases.push(installDesktopHost(f.host))
  f.host.setRehydrator(async () => {}); await f.host.reconnect()
  expect(await desktopApi.settings.get('theme')).toBe('dark')
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'settings:get', payload: { key: 'theme' }, engineEpoch: 'engine-1' })
  await expect(desktopApi.settings.get('api_key')).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  const before = f.invoke.mock.calls.length
  await expect(desktopApi.voice.pushAudio('turn', new Uint8Array([1, 2]))).rejects.toMatchObject({ code: 'DESKTOP_UNAVAILABLE', capability: 'voice.pushAudio' })
  await expect(desktopApi.shell.openPath('/private')).rejects.toMatchObject({ code: 'DESKTOP_UNAVAILABLE' })
  expect(() => desktopApi.webUtils.getPathForFile(new File([], 'private'))).toThrow('unavailable')
  expect(typeof desktopApi.commander.onEvent).toBe('function'); expect(Reflect.get(desktopApi, 'browser')).toBeUndefined()
  expect(f.host.supports('commander.send')).toBe(true); expect(f.invoke.mock.calls.length).toBe(before)
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

it('binds Commander reads to exact native codecs without entering Electron', async () => {
  const f = fixture(); releases.push(installDesktopHost(f.host))
  f.results.set('commander:listSessions', [])
  f.host.setRehydrator(async () => {}); await f.host.reconnect()
  expect(await desktopApi.commander.listSessions()).toEqual([])
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'commander:listSessions', payload: {}, engineEpoch: 'engine-1' })
})

it('binds the 86 finite production commands including settings effects, secret metadata and terminal ownership', async () => {
  const f = fixture(); releases.push(installDesktopHost(f.host))
  const secret = { id: 'secret-1', name: 'Build credential', description: 'Private integration', env_var_name: 'BUILD_TOKEN', created_at: '2026-10-13', updated_at: '2026-10-13' }
  f.results.set('settings:get', PRODUCTION_API_KEY_SET_MARKER)
  f.results.set('settings:getAll', { theme: 'dark', openai_api_key: PRODUCTION_API_KEY_SET_MARKER })
  f.results.set('env:get', PRODUCTION_API_KEY_SET_MARKER)
  f.results.set('secrets:getAll', [secret]); f.results.set('secrets:create', secret); f.results.set('secrets:update', secret); f.results.set('secrets:delete', true)
  f.results.set('terminal:create', { pid: 4242 }); f.results.set('terminal:getCwd', { cwd: '/selected/workspace' }); f.results.set('terminal:getBuffer', { lines: ['recent output'] })
  f.host.setRehydrator(async () => {}); await f.host.reconnect()
  expect(Object.keys(NATIVE_COMMAND_BINDINGS)).toHaveLength(86)
  expect(await desktopApi.settings.get('openai_api_key')).toBe(PRODUCTION_API_KEY_SET_MARKER)
  await desktopApi.settings.set('max_concurrent_agent_sessions', '2')
  expect(await desktopApi.env.get('OPENAI_API_KEY')).toBe(PRODUCTION_API_KEY_SET_MARKER)
  expect(await desktopApi.secrets.getAll()).toEqual([secret])
  const input = { name: secret.name, description: secret.description, env_var_name: secret.env_var_name, value: 'new credential supplied by user' }
  expect(await desktopApi.secrets.create(input)).toEqual(secret)
  expect(await desktopApi.secrets.update(secret.id, { description: 'Updated metadata' })).toEqual(secret)
  expect(await desktopApi.secrets.delete(secret.id)).toBe(true)
  expect(await desktopApi.terminal.create('panel-1', 80, 24)).toEqual({ pid: 4242 })
  expect(await desktopApi.terminal.getCwd('panel-1', 4242)).toEqual({ cwd: '/selected/workspace' })
  expect(await desktopApi.terminal.getBuffer('panel-1', 200)).toEqual({ lines: ['recent output'] })
  await desktopApi.terminal.write('panel-1', '\x03'); await desktopApi.terminal.resize('panel-1', 100, 40); await desktopApi.terminal.kill('panel-1', 4242)
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'terminal:kill', payload: { id: 'panel-1', expectedPid: 4242 }, engineEpoch: 'engine-1' })
  const before = f.invoke.mock.calls.length
  await expect(desktopApi.env.get('HOME')).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(desktopApi.settings.set('unknown_owner_key', 'yes')).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  expect(f.invoke.mock.calls.length).toBe(before)
})

it('preserves terminal subscriptions through reconnect and drops retired-epoch output', async () => {
  const f = fixture(), data = vi.fn(), exit = vi.fn()
  const offData = f.host.api.terminal.onData(data), offExit = f.host.api.terminal.onExit(exit)
  f.host.setRehydrator(async () => {}); await f.host.reconnect()
  f.emit('terminal:data', { id: 'panel-1', data: '\x1b[31mfirst\x1b[0m' })
  expect(data).toHaveBeenCalledExactlyOnceWith({ id: 'panel-1', data: '\x1b[31mfirst\x1b[0m' })
  f.changeEpoch(); await f.host.reconnect()
  f.history[0]?.({ payload: { protocolVersion: 1, kind: 'event', operation: 'terminal:data', payload: { id: 'panel-1', data: 'retired' }, engineEpoch: 'engine-1', sequence: 2 } })
  expect(data).toHaveBeenCalledOnce()
  f.emit('terminal:exit', { id: 'panel-1' }); expect(exit).toHaveBeenCalledExactlyOnceWith({ id: 'panel-1' })
  offData(); offExit()
})

it('keeps native terminal mutation fenced during recovery and refuses secret value exposure', async () => {
  const f = fixture(); await f.host.reconnect()
  await expect(f.host.api.terminal.create('panel-1', 80, 24)).rejects.toMatchObject({ code: 'DISCONNECTED' })
  await expect(f.host.api.secrets.create({ name: 'Secret', description: '', env_var_name: 'TOKEN', value: 'private' })).rejects.toMatchObject({ code: 'DISCONNECTED' })
  f.host.setRehydrator(async () => {}); await f.host.rehydrate()
  f.results.set('secrets:getAll', [{ id: 'secret-1', name: 'Secret', description: '', env_var_name: 'TOKEN', created_at: '2026-10-13', updated_at: '2026-10-13', value: 'private stored value' }])
  await expect(f.host.api.secrets.getAll()).rejects.toMatchObject({ code: 'INVALID_RESULT' })
})

it('shows a fixed bootstrap failure, disconnects an earlier client and keeps mutations fenced without retry', async () => {
  const f = fixture(); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  const original = f.invoke.getMockImplementation()
  if (!original) throw new Error('Missing native transport fixture')
  f.invoke.mockImplementation((command, args) => command === 'engine_status' ? Promise.resolve({ available: false, production: true, protocolVersion: 1,
    startupFailure: { code: 'PRODUCTION_CONTAINMENT_UNAVAILABLE', phase: 'production-delegation-missing', path: '/private/profile', credential: 'private value' }
  }) : original(command, args))
  const before = f.invoke.mock.calls.length
  await expect(f.host.reconnect()).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(f.host.bootstrapFailure).toBe('Desktop process supervision is unavailable. Provision the native environment and relaunch the app. Changes are paused.')
  expect(f.host.connection.status).toBe('disconnected'); expect(f.host.hydrationPending).toBe(true)
  await expect(f.host.api.settings.set('theme', 'light')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(f.invoke.mock.calls.length).toBe(before + 1)
  expect(f.unlisten).toHaveBeenCalledOnce()
  expect(f.host.bootstrapFailure).not.toContain('/private/profile')
})
