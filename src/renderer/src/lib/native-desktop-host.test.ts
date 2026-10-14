import { afterEach, expect, it, vi } from 'vitest'
import type { TauriDesktopApi } from './tauri-desktop-transport'
import { createNativeDesktopHost, NATIVE_COMMAND_BINDINGS, type NativeDesktopHost } from './native-desktop-host'
import { PRODUCTION_API_KEY_SET_MARKER } from '@shared/production-settings-codecs'
import { MCP_SECRET_SET_MARKER } from '@shared/mcp-codecs'
import { CONNECTOR_WRITE_ERROR, CONNECTOR_STORAGE_REMEDIATION, CONNECTOR_SYNC_ERROR } from '@shared/connector-codecs'
import type { RolloverPolicy, SessionContextSnapshot } from '@shared/session-context'
import { CLAUDE_PLUGIN_LOCAL_SOURCE } from '@shared/claude-plugin-codecs'
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
function mcpRow() {
  return { id: 'mcp.fixture:one', name: 'Fixture MCP', type: 'local', command: 'fixture-mcp', args: [], url: '', headers: { Authorization: MCP_SECRET_SET_MARKER }, environment: { FIXTURE_TOKEN: MCP_SECRET_SET_MARKER }, tools: [], oauth_metadata: { client_secret: MCP_SECRET_SET_MARKER }, source: 'user', created_at: '2026-10-14', updated_at: '2026-10-14' }
}
function sourceRow() {
  return { id: 'source_fixture', mcp_server_id: null, name: 'Fixture Notion', plugin_id: 'notion', config: { api_token: PRODUCTION_API_KEY_SET_MARKER }, list_tool: 'legacy_list', list_tool_args: {}, update_tool: 'legacy_update', update_tool_args: {}, last_synced_at: null, enabled: false, project_id: 'project_fixture', created_at: '2026-10-14', updated_at: '2026-10-14' }
}
const rolloverPolicy: RolloverPolicy = { mode: 'observe', contextRatio: 0.6, compactions: 3, wakeups: 20, turns: 10, maxAgeDays: 7 }
function contextSnapshot(): SessionContextSnapshot {
  return { scope: { kind: 'captain', ownerId: 'project_fixture' }, generation: { id: 'generation:fixture', key: 'adapter:native_fixture', engine: 'adapter', state: 'running', createdAt: 100, backendId: 'native_fixture' }, usage: { tokens: 1200, source: 'reported', contextWindow: 16000, model: 'fixture/model', observedAt: 110 }, counters: { compactions: 1, wakeups: 2, turns: 3, ageMs: 10 }, policy: rolloverPolicy, reasons: ['context'], warnings: ['Human\nwarning'], summaries: [{ id: 'summary:fixture', content: 'Human\nsummary', kind: 'rollover', createdAt: 105, source: 'model' }], handoff: { id: 'handoff:fixture', state: 'creation_unconfirmed' } }
}
function claudeInstalledRow() {
  return { id: 'plugin.fixture:one', name: 'fixture-plugin', marketplace_id: 'marketplace.fixture:one', manifest: { name: 'fixture-plugin', author: { name: 'Fixture Author' }, description: 'Fixture public manifest' }, source: { source: 'github', repo: 'fixture/marketplace#main', path: 'plugins/fixture-plugin' }, scope: 'user', enabled: true, version: '1.0', installed_at: '2026-10-14', updated_at: '2026-10-14' }
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

it('binds the 127 finite production commands including settings effects, secret metadata and terminal ownership', async () => {
  const f = fixture(); releases.push(installDesktopHost(f.host))
  const secret = { id: 'secret-1', name: 'Build credential', description: 'Private integration', env_var_name: 'BUILD_TOKEN', created_at: '2026-10-13', updated_at: '2026-10-13' }
  f.results.set('settings:get', PRODUCTION_API_KEY_SET_MARKER)
  f.results.set('settings:getAll', { theme: 'dark', openai_api_key: PRODUCTION_API_KEY_SET_MARKER })
  f.results.set('env:get', PRODUCTION_API_KEY_SET_MARKER)
  f.results.set('secrets:getAll', [secret]); f.results.set('secrets:create', secret); f.results.set('secrets:update', secret); f.results.set('secrets:delete', true)
  f.results.set('terminal:create', { pid: 4242 }); f.results.set('terminal:getCwd', { cwd: '/selected/workspace' }); f.results.set('terminal:getBuffer', { lines: ['recent output'] })
  f.host.setRehydrator(async () => {}); await f.host.reconnect()
  expect(Object.keys(NATIVE_COMMAND_BINDINGS)).toHaveLength(127)
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

it('binds finite MCP CRUD, scoped OAuth and probes to their actual wire schemas', async () => {
  const f = fixture(), row = mcpRow()
  f.results.set('mcp:getAll', [row]); f.results.set('mcp:create', row); f.results.set('mcp:update', row); f.results.set('mcp:delete', true)
  f.results.set('mcp:testConnection', { status: 'connected', toolCount: 1, tools: [{ name: 'fixture_tool', description: 'Fixture tool' }] })
  f.results.set('mcp:startOAuthFlow', { needsManualClientId: true }); f.results.set('mcp:getOAuthStatus', { connected: true, expiresAt: '2026-10-15' })
  f.results.set('mcp:probeForAuth', { requiresAuth: true }); f.results.set('mcp:submitManualClientId', {})
  await f.host.reconnect()
  expect(await f.host.api.mcpServers.getAll()).toEqual([row])
  expect(await f.host.api.mcpServers.getOAuthStatus(row.id)).toEqual({ connected: true, expiresAt: '2026-10-15' })
  expect(await f.host.api.mcpServers.probeForAuth('https://mcp.example.test/api')).toEqual({ requiresAuth: true })
  await expect(f.host.api.mcpServers.testConnection({ name: 'Fixture' })).rejects.toMatchObject({ code: 'DISCONNECTED' })
  await expect(f.host.api.mcpServers.startOAuthFlow(row.id)).rejects.toMatchObject({ code: 'DISCONNECTED' })
  f.host.setRehydrator(async () => {}); await f.host.rehydrate()
  const data = { name: 'Fixture MCP', type: 'remote' as const, url: 'https://mcp.example.test/api', headers: { Authorization: 'synthetic-user-input' } }
  expect(await f.host.api.mcpServers.create(data)).toEqual(row)
  expect(await f.host.api.mcpServers.update(row.id, { headers: { Authorization: MCP_SECRET_SET_MARKER } })).toEqual(row)
  expect(await f.host.api.mcpServers.testConnection({ id: row.id, name: row.name })).toMatchObject({ status: 'connected', toolCount: 1 })
  expect(await f.host.api.mcpServers.startOAuthFlow(row.id)).toEqual({ needsManualClientId: true })
  expect(await f.host.api.mcpServers.submitManualClientId(row.id, 'fixture-client')).toEqual({})
  await f.host.api.mcpServers.revokeOAuthToken(row.id)
  expect(await f.host.api.mcpServers.delete(row.id)).toBe(true)
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'mcp:create', payload: { data }, engineEpoch: 'engine-1' })
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'mcp:submitManualClientId', payload: { id: row.id, clientId: 'fixture-client' }, engineEpoch: 'engine-1' })
  const before = f.invoke.mock.calls.length
  await expect(f.host.api.mcpServers.update(row.id, { oauth_metadata: { client_secret: 'foreign' } } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.mcpServers.create({ name: 'Fixture', source: 'plugin' } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.mcpServers.probeForAuth('https://user:pass@mcp.example.test')).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  expect(f.invoke.mock.calls.length).toBe(before)
  expect(f.host.supports('cliMcp.upsert')).toBe(false)
})

it('binds project source metadata, sync, export and users while fencing mutations during recovery', async () => {
  const f = fixture(), row = sourceRow(), sync = { source_id: row.id, imported: 2, updated: 1, errors: ['Explicit import failure'] }
  const users = [{ id: 'external:user', name: 'Fixture User', email: 'fixture@example.test' }]
  f.results.set('taskSource:getAll', [row]); f.results.set('taskSource:create', row); f.results.set('taskSource:update', row)
  f.results.set('taskSource:delete', true); f.results.set('taskSource:sync', sync); f.results.set('taskSource:getUsers', users); f.results.set('taskSource:reassign', { success: false, error: 'Explicit source refusal' })
  await f.host.reconnect()
  expect(await f.host.api.taskSources.getAll('project_fixture')).toEqual([row])
  expect(await f.host.api.taskSources.getUsers(row.id)).toEqual(users)
  await expect(f.host.api.taskSources.sync(row.id)).rejects.toMatchObject({ code: 'DISCONNECTED' })
  await expect(f.host.api.taskSources.exportUpdate('task_fixture', { status: 'completed' })).rejects.toMatchObject({ code: 'DISCONNECTED' })
  f.host.setRehydrator(async () => {}); await f.host.rehydrate()
  const data = { name: row.name, mcp_server_id: null, plugin_id: row.plugin_id, project_id: row.project_id, config: { api_token: 'synthetic\nfixture-input', data_source_id: 'external:database' } }
  expect(await f.host.api.taskSources.create(data)).toEqual(row)
  expect(await f.host.api.taskSources.update(row.id, { enabled: false, config: { api_token: PRODUCTION_API_KEY_SET_MARKER } })).toEqual(row)
  expect(await f.host.api.taskSources.sync(row.id)).toEqual(sync)
  await f.host.api.taskSources.exportUpdate('task_fixture', { status: 'completed', priority: 'urgent', description: 'Multiline\ncontext' })
  expect(await f.host.api.taskSources.reassign('task_fixture', ['external:user'], 'Fixture User')).toEqual({ success: false, error: 'Explicit source refusal' })
  expect(await f.host.api.taskSources.delete(row.id)).toBe(true)
  f.results.delete('taskSource:update'); expect(await f.host.api.taskSources.update(row.id, { name: 'Missing source' })).toBeUndefined()
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'taskSource:create', payload: { data }, engineEpoch: 'engine-1' })
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'taskSource:reassign', payload: { taskId: 'task_fixture', userIds: ['external:user'], assigneeDisplay: 'Fixture User' }, engineEpoch: 'engine-1' })
  const before = f.invoke.mock.calls.length
  await expect(f.host.api.taskSources.update(row.id, { project_id: 'foreign_project' } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.taskSources.create({ name: 'Fixture', mcp_server_id: null, plugin_id: 'unknown-plugin' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.taskSources.update(row.id, { list_tool_args: { command: 'foreign' } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.taskSources.reassign('task_fixture', ['same', 'same'], '')).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  expect(f.invoke.mock.calls.length).toBe(before)
})

it('does not repeat an accepted source sync when its result is lost across native epochs', async () => {
  const f = fixture(); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  const pending = deferred<unknown>(), original = f.invoke.getMockImplementation()!
  f.invoke.mockImplementation((command, args) => command === 'desktop_invoke' && args?.operation === 'taskSource:sync' ? pending.promise : original(command, args))
  const syncing = f.host.api.taskSources.sync('source_fixture'), rejected = expect(syncing).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  f.changeEpoch(); await f.host.reconnect(); await rejected
  pending.resolve({ engineEpoch: 'engine-1', result: { defined: true, value: { source_id: 'source_fixture', imported: 1, updated: 0, errors: [] } } }); await Promise.resolve()
  expect(f.invoke.mock.calls.filter(([command, args]) => command === 'desktop_invoke' && args?.operation === 'taskSource:sync')).toHaveLength(1)
})

it('retains source task invalidations across epochs without granting new event namespaces', async () => {
  const f = fixture(), deleted = vi.fn(), refresh = vi.fn()
  const offDeleted = f.host.api.onTaskDeleted(deleted), offRefresh = f.host.api.onTasksRefresh(refresh)
  f.host.setRehydrator(async () => {}); await f.host.reconnect()
  f.emit('task:deleted', { taskId: 'imported_task' }); f.emit('tasks:refresh', {})
  expect(deleted).toHaveBeenCalledExactlyOnceWith({ taskId: 'imported_task' })
  expect(refresh).toHaveBeenCalledTimes(2)
  f.changeEpoch(); await f.host.reconnect()
  f.history[0]?.({ payload: { protocolVersion: 1, kind: 'event', operation: 'task:deleted', payload: { taskId: 'retired_import' }, engineEpoch: 'engine-1', sequence: 3 } })
  expect(deleted).toHaveBeenCalledOnce()
  f.emit('task:deleted', { taskId: 'current_import' }); expect(deleted).toHaveBeenCalledTimes(2)
  expect(f.host.supports('mcpServers.onCredentials')).toBe(false)
  offDeleted(); offRefresh()
})

it('retains unavailable source metadata while refusing credential or legacy private payload results', async () => {
  const f = fixture(); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  f.results.set('taskSource:getAll', [{ ...sourceRow(), plugin_id: 'uninstalled.plugin', config: {} }])
  expect(await f.host.api.taskSources.getAll()).toMatchObject([{ plugin_id: 'uninstalled.plugin', config: {} }])
  f.results.set('taskSource:getAll', [{ ...sourceRow(), config: { api_token: 'synthetic-private-stored-value' } }])
  await expect(f.host.api.taskSources.getAll()).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  f.results.set('mcp:getAll', [{ ...mcpRow(), headers: { Authorization: 'synthetic-private-stored-value' } }])
  await expect(f.host.api.mcpServers.getAll()).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  f.results.delete('taskSource:create')
  await expect(f.host.api.taskSources.create({ name: 'Fixture', mcp_server_id: null, plugin_id: 'notion' })).rejects.toMatchObject({ code: 'INVALID_RESULT' })
})

it('admits finite agent key writes while masking configuration results and denying injected vendors', async () => {
  const f = fixture(), row = { id: 'agent_fixture', name: 'Fixture', server_url: 'http://localhost:4096', config: { coding_agent: 'pi', api_keys: { openai: PRODUCTION_API_KEY_SET_MARKER } }, is_default: false, created_at: '2026-10-14', updated_at: '2026-10-14' }
  f.results.set('agent:update', row); f.results.set('agent:getAll', [row]); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  const config = { api_keys: { openai: 'synthetic-input', anthropic: '', cursor: PRODUCTION_API_KEY_SET_MARKER } }
  expect(await f.host.api.agents.update(row.id, { config })).toEqual(row)
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'agent:update', payload: { id: row.id, data: { config } }, engineEpoch: 'engine-1' })
  const before = f.invoke.mock.calls.length
  await expect(f.host.api.agents.update(row.id, { config: { api_keys: { foreign: 'value' } } } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  expect(f.invoke.mock.calls.length).toBe(before)
  f.results.set('agent:getAll', [{ ...row, config: { api_keys: { openai: 'synthetic-private-stored-value' } } }])
  await expect(f.host.api.agents.getAll()).rejects.toMatchObject({ code: 'INVALID_RESULT' })
})

it('binds connector instances and credential operations without inventing ownership or leaking secrets', async () => {
  const f = fixture(), id = 'connector.fixture:one', pieceName = '@activepieces/piece-todoist'
  const pieces = [{ pieceName, label: 'Todoist', authType: 'oauth2', authLabels: { clientId: 'Client ID', clientSecret: 'Client secret' }, configProps: [{ key: 'filter_query', label: 'Filter' }], oauth: { mode: 'user-supplied', pkce: true, clientSecretRequired: false, scopes: ['data:read'], redirectUriHint: 'twentyonex://oauth/callback' } }]
  f.results.set('connectors:bridgePieces', pieces); f.results.set('connectors:ensureInstance', { instanceId: id, pieceName })
  f.results.set('connectors:credentialStatus', { storage: null, persistentAvailable: false, oauth: { state: 'none', expiresAt: null } })
  f.results.set('connectors:setCredentials', { ok: true, storage: 'session' })
  f.results.set('connectors:oauthConnect', { ok: false, error: CONNECTOR_WRITE_ERROR, remediation: CONNECTOR_STORAGE_REMEDIATION, sessionOnlyAvailable: true })
  const sync = { lastError: CONNECTOR_SYNC_ERROR, lastSyncedAt: null, attemptCount: 1, nextRetryAt: 1000, deadLetterCount: 0 }
  f.results.set('connectors:syncStatus', sync)
  await f.host.reconnect()
  expect(await f.host.api.connectors.bridgePieces()).toEqual(pieces)
  expect(await f.host.api.connectors.credentialStatus(id)).toMatchObject({ storage: null, persistentAvailable: false })
  expect(await f.host.api.connectors.syncStatus(id)).toEqual(sync)
  await expect(f.host.api.connectors.ensureInstance(pieceName)).rejects.toMatchObject({ code: 'DISCONNECTED' })
  await expect(f.host.api.connectors.setCredentials(id, { secret: 'synthetic' })).rejects.toMatchObject({ code: 'DISCONNECTED' })
  f.host.setRehydrator(async () => {}); await f.host.rehydrate()
  expect(await f.host.api.connectors.ensureInstance(pieceName, id)).toEqual({ instanceId: id, pieceName })
  expect(await f.host.api.connectors.setCredentials(id, { secret: 'synthetic-fixture-secret' }, 'session')).toEqual({ ok: true, storage: 'session' })
  expect(await f.host.api.connectors.oauthConnect(id, { clientId: 'fixture-client', clientSecret: undefined }, 'persistent')).toEqual({ ok: false, error: CONNECTOR_WRITE_ERROR, remediation: CONNECTOR_STORAGE_REMEDIATION, sessionOnlyAvailable: true })
  await f.host.api.connectors.clearCredentials(id)
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'connectors:oauthConnect', payload: { instanceId: id, input: { clientId: 'fixture-client' }, storage: 'persistent' }, engineEpoch: 'engine-1' })
  const before = f.invoke.mock.calls.length
  for (const secret of [PRODUCTION_API_KEY_SET_MARKER, MCP_SECRET_SET_MARKER, 'bad\0value', 'bad\nvalue', 'x'.repeat(4097)]) await expect(f.host.api.connectors.setCredentials(id, { secret })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.connectors.ensureInstance('@activepieces/piece-foreign')).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.connectors.oauthConnect(id, { accessToken: 'foreign' } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  expect(f.invoke.mock.calls.length).toBe(before)
  f.results.set('connectors:credentialStatus', { storage: 'session', persistentAvailable: true, accessToken: 'private' })
  await expect(f.host.api.connectors.credentialStatus(id)).rejects.toMatchObject({ code: 'INVALID_RESULT' })
})

it('marks disabled connector capabilities unavailable while preserving the exact native error without fallback', async () => {
  const f = fixture(); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  const original = f.invoke.getMockImplementation()!
  f.invoke.mockImplementation((command, args) => command === 'desktop_invoke' && String(args?.operation).startsWith('connectors:') ? Promise.reject({ code: 'UNKNOWN_OPERATION', privateDetail: 'runtime disabled' }) : original(command, args))
  await expect(f.host.api.connectors.ensureInstance('@activepieces/piece-trello')).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
  expect(f.host.unavailableCapability).toBe('connectors.ensureInstance')
  expect(f.invoke.mock.calls.filter(([command, args]) => command === 'desktop_invoke' && args?.operation === 'connectors:ensureInstance')).toHaveLength(1)
  expect(f.host.connection.status).toBe('ready')
})

it('never replays an accepted connector OAuth mutation after a lost native result', async () => {
  const f = fixture(); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  const pending = deferred<unknown>(), original = f.invoke.getMockImplementation()!
  f.invoke.mockImplementation((command, args) => command === 'desktop_invoke' && args?.operation === 'connectors:oauthConnect' ? pending.promise : original(command, args))
  const oauth = f.host.api.connectors.oauthConnect('connector.fixture:one', { clientId: 'fixture-client' }), rejected = expect(oauth).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  f.changeEpoch(); await f.host.reconnect(); await rejected
  pending.resolve({ engineEpoch: 'engine-1', result: { defined: true, value: { ok: true, storage: 'session' } } }); await Promise.resolve()
  expect(f.invoke.mock.calls.filter(([command, args]) => command === 'desktop_invoke' && args?.operation === 'connectors:oauthConnect')).toHaveLength(1)
})

it('binds plugin metadata and finite resolver scopes with the fifth argument preserved during hydration', async () => {
  const f = fixture(), metadata = [{ id: 'linear', displayName: 'Linear', description: 'Fixture\nmetadata', icon: 'linear' }]
  const options = [{ value: 'external:user-one', label: 'Fixture User' }]
  f.results.set('plugin:list', metadata); f.results.set('plugin:getDocumentation', 'Fixture\nsetup documentation'); f.results.set('plugin:resolveOptions', options)
  await f.host.reconnect()
  expect(await f.host.api.plugins.list()).toEqual(metadata)
  expect(await f.host.api.plugins.getDocumentation('linear')).toBe('Fixture\nsetup documentation')
  expect(await f.host.api.plugins.resolveOptions('linear', 'users', {}, undefined, 'source_fixture')).toEqual(options)
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'plugin:resolveOptions', payload: { pluginId: 'linear', resolverKey: 'users', config: {}, sourceId: 'source_fixture' }, engineEpoch: 'engine-1' })
  expect(Object.keys(NATIVE_COMMAND_BINDINGS).filter(operation => operation === 'plugin:executeAction')).toHaveLength(1)
  await expect(f.host.api.plugins.executeAction('fixture_action', 'task_fixture', 'source_fixture')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  f.results.set('plugin:getDocumentation', null); expect(await f.host.api.plugins.getDocumentation('notion')).toBeNull()
  const before = f.invoke.mock.calls.length
  await expect(f.host.api.plugins.getDocumentation('unknown-plugin')).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.plugins.resolveOptions('notion', 'owners', {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.plugins.resolveOptions('linear', 'users', { path: '/foreign/path' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.plugins.resolveOptions('notion', 'data_sources', { api_token: 'bad\0secret' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  expect(f.invoke.mock.calls.length).toBe(before)
  f.results.set('plugin:resolveOptions', [{ value: 'external:user', label: 'Fixture', config: { api_token: 'private' } }])
  await expect(f.host.api.plugins.resolveOptions('linear', 'users', {})).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  f.results.set('plugin:list', [...metadata, ...metadata])
  await expect(f.host.api.plugins.list()).rejects.toMatchObject({ code: 'INVALID_RESULT' })
})

it('reads complete context snapshots during recovery and fences finite rollover policy writes', async () => {
  const f = fixture(), snapshot = contextSnapshot()
  f.results.set('sessionContext:getSnapshot', snapshot); f.results.set('sessionContext:setPolicy', rolloverPolicy)
  await f.host.reconnect()
  expect(await f.host.api.sessionContext.getSnapshot(snapshot.scope)).toEqual(snapshot)
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'sessionContext:getSnapshot', payload: { scope: snapshot.scope }, engineEpoch: 'engine-1' })
  await expect(f.host.api.sessionContext.setPolicy(rolloverPolicy)).rejects.toMatchObject({ code: 'DISCONNECTED' })
  f.host.setRehydrator(async () => {}); await f.host.rehydrate()
  expect(await f.host.api.sessionContext.setPolicy(rolloverPolicy)).toEqual(rolloverPolicy)
  const before = f.invoke.mock.calls.length
  await expect(f.host.api.sessionContext.getSnapshot({ kind: 'task', ownerId: 'task_fixture' } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.sessionContext.getSnapshot({ kind: 'captain', ownerId: 'project_fixture', profileRoot: '/foreign' } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.sessionContext.setPolicy({ ...rolloverPolicy, contextRatio: 0 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.sessionContext.setPolicy({ ...rolloverPolicy, turns: 1000001 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  expect(f.invoke.mock.calls.length).toBe(before)
  f.results.set('sessionContext:getSnapshot', { ...snapshot, usage: { ...snapshot.usage, source: 'unknown' } })
  await expect(f.host.api.sessionContext.getSnapshot(snapshot.scope)).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  f.results.set('sessionContext:getSnapshot', { ...snapshot, summaries: [{ ...snapshot.summaries[0], profilePath: '/private' }] })
  await expect(f.host.api.sessionContext.getSnapshot(snapshot.scope)).rejects.toMatchObject({ code: 'INVALID_RESULT' })
})

it('binds Claude marketplace/plugin lifecycle using public projections and user-only install scope', async () => {
  const f = fixture(), installed = claudeInstalledRow()
  const source = { id: 'marketplace.fixture:one', name: 'Fixture local', source_type: 'local', source_url: CLAUDE_PLUGIN_LOCAL_SOURCE, metadata: {}, auto_update: false, created_at: '2026-10-14', updated_at: '2026-10-14' }
  const catalog = { name: 'Fixture catalog', owner: { name: 'Fixture Author' }, plugins: [{ name: installed.name, source: './plugins/fixture-plugin', author: { name: 'Fixture Author' } }] }
  const discovery = { name: installed.name, description: 'Fixture', version: '1.0', author: 'Fixture Author', category: '', tags: [], homepage: '', repository: '', license: '', marketplace_id: source.id, marketplace_name: source.name, source: './plugins/fixture-plugin', installed: false }
  const resources = { skills: [{ id: 'skill:fixture', name: 'Fixture skill', description: 'Public description' }], mcpServers: [{ id: 'mcp:fixture', name: 'Fixture MCP', command: '', args: [] }], agents: [{ id: 'agent:fixture', name: 'Fixture agent', description: '' }], commands: ['commands/fixture.md'] }
  f.results.set('claudePlugin:getMarketplaceSources', [source]); f.results.set('claudePlugin:addMarketplaceSource', source); f.results.set('claudePlugin:removeMarketplaceSource', true)
  f.results.set('claudePlugin:fetchCatalog', catalog); f.results.set('claudePlugin:discoverPlugins', [discovery]); f.results.set('claudePlugin:getInstalledPlugins', [installed])
  f.results.set('claudePlugin:installPlugin', installed); f.results.set('claudePlugin:uninstallPlugin', true); f.results.set('claudePlugin:enablePlugin', installed); f.results.set('claudePlugin:disablePlugin', { ...installed, enabled: false }); f.results.set('claudePlugin:getPluginResources', resources)
  await f.host.reconnect()
  expect(await f.host.api.claudePlugins.getMarketplaceSources()).toEqual([source])
  expect(await f.host.api.claudePlugins.fetchCatalog(source.id)).toEqual(catalog)
  expect(await f.host.api.claudePlugins.discoverPlugins('fixture')).toEqual([discovery])
  expect(await f.host.api.claudePlugins.getInstalledPlugins()).toEqual([installed])
  expect(await f.host.api.claudePlugins.getPluginResources(installed.id)).toEqual(resources)
  await expect(f.host.api.claudePlugins.installPlugin(installed.name, source.id)).rejects.toMatchObject({ code: 'DISCONNECTED' })
  f.host.setRehydrator(async () => {}); await f.host.rehydrate()
  const data = { name: source.name, source_type: 'local', source_url: '/synthetic-fixture/catalog', auto_update: false }
  expect(await f.host.api.claudePlugins.addMarketplaceSource(data)).toEqual(source)
  expect(await f.host.api.claudePlugins.installPlugin(installed.name, source.id, 'user')).toEqual(installed)
  expect(await f.host.api.claudePlugins.disablePlugin(installed.id)).toMatchObject({ enabled: false })
  expect(await f.host.api.claudePlugins.enablePlugin(installed.id)).toEqual(installed)
  expect(await f.host.api.claudePlugins.uninstallPlugin(installed.id)).toBe(true)
  expect(await f.host.api.claudePlugins.removeMarketplaceSource(source.id)).toBe(true)
  f.results.delete('claudePlugin:enablePlugin'); expect(await f.host.api.claudePlugins.enablePlugin(installed.id)).toBeUndefined()
  f.results.set('claudePlugin:fetchCatalog', null); expect(await f.host.api.claudePlugins.fetchCatalog(source.id)).toBeNull()
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'claudePlugin:installPlugin', payload: { pluginName: installed.name, marketplaceId: source.id, scope: 'user' }, engineEpoch: 'engine-1' })
  const before = f.invoke.mock.calls.length
  await expect(f.host.api.claudePlugins.installPlugin('../foreign', source.id)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.claudePlugins.installPlugin(installed.name, source.id, 'project')).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.claudePlugins.addMarketplaceSource({ ...data, source_url: CLAUDE_PLUGIN_LOCAL_SOURCE })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  expect(f.invoke.mock.calls.length).toBe(before)
  f.results.set('claudePlugin:getMarketplaceSources', [{ ...source, source_url: '/private/profile/catalog' }])
  await expect(f.host.api.claudePlugins.getMarketplaceSources()).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  f.results.set('claudePlugin:getPluginResources', { ...resources, mcpServers: [{ id: 'mcp:fixture', name: 'Fixture MCP', command: '/private/tool', args: [] }] })
  await expect(f.host.api.claudePlugins.getPluginResources(installed.id)).rejects.toMatchObject({ code: 'INVALID_RESULT' })
})

it('never repeats an accepted Claude plugin install after a lost network/native result', async () => {
  const f = fixture(); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  const pending = deferred<unknown>(), original = f.invoke.getMockImplementation()!
  f.invoke.mockImplementation((command, args) => command === 'desktop_invoke' && args?.operation === 'claudePlugin:installPlugin' ? pending.promise : original(command, args))
  const installing = f.host.api.claudePlugins.installPlugin('fixture-plugin', 'marketplace.fixture:one'), rejected = expect(installing).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  f.changeEpoch(); await f.host.reconnect(); await rejected
  pending.resolve({ engineEpoch: 'engine-1', result: { defined: true, value: claudeInstalledRow() } }); await Promise.resolve()
  expect(f.invoke.mock.calls.filter(([command, args]) => command === 'desktop_invoke' && args?.operation === 'claudePlugin:installPlugin')).toHaveLength(1)
})
