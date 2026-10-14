import { AGENT_INSTALLER_DETECTION_KEYS } from '@shared/agent-installer-codecs'
import { NATIVE_CLIPBOARD_ERRORS } from '@shared/native-clipboard-codecs'
import { VOICE_MANAGEMENT_UNAVAILABLE } from '@shared/voice-management-codecs'
import { afterEach, expect, it, vi } from 'vitest'
import type { TauriDesktopApi } from './tauri-desktop-transport'
import { createNativeDesktopHost, NATIVE_COMMAND_BINDINGS, type NativeDesktopHost } from './native-desktop-host'
import { PRODUCTION_API_KEY_SET_MARKER } from '@shared/production-settings-codecs'
import { MCP_SECRET_SET_MARKER } from '@shared/mcp-codecs'
import { CONNECTOR_WRITE_ERROR, CONNECTOR_STORAGE_REMEDIATION, CONNECTOR_SYNC_ERROR } from '@shared/connector-codecs'
import type { RolloverPolicy, SessionContextSnapshot } from '@shared/session-context'
import { CLAUDE_PLUGIN_LOCAL_SOURCE } from '@shared/claude-plugin-codecs'
import { CLI_IDS, CLI_LABELS, CLI_CAPABILITIES, MASKED_SECRET, type CliMcpSnapshot } from '@shared/cli-mcp-config'
import { desktopApi, installDesktopHost } from './desktop-api'
import type { ServiceEvent } from '@shared/service-protocol'
const hosts: NativeDesktopHost[] = [], releases: Array<() => void> = []
afterEach(() => { for (const release of releases.splice(0)) release(); for (const host of hosts.splice(0)) host.dispose() })
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve: (value: T) => resolve(value) } }
function fixture(ui = false) {
  let uiLease = 'document-1'
  const progressReceivers = new Set<(event: { payload: unknown }) => void>(), progressHistory: Array<(event: { payload: unknown }) => void> = []
  const uiReceivers = new Set<(event: { payload: unknown }) => void>(), uiHistory: Array<(event: { payload: unknown }) => void> = []
  let epoch = 'engine-1', sequence = 0
  const receivers = new Set<(event: { payload: unknown }) => void>(), history: Array<(event: { payload: unknown }) => void> = []
  const results = new Map<string, unknown>([['settings:get', 'dark'], ['settings:getAll', {}], ['db:getTasks', []], ['project:getAll', []], ['agent:getAll', []], ['agentSession:getTranscriptSnapshot', []], ['agentSession:getTranscriptDelta', { parts: [], maxRev: 0 }], ['agentSession:approve', { success: true }]])
  const unlisten = vi.fn()
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (command === 'engine_status') return { available: true, protocolVersion: 1, engineEpoch: epoch, ...(ui ? { uiLeaseId: uiLease } : {}) }
    const result = results.get(String(args?.operation))
    return { engineEpoch: epoch, result: result === undefined ? { defined: false } : { defined: true, value: result } }
  })
  const listen = vi.fn(async (_name: string, receive: (event: { payload: unknown }) => void) => {
    if (_name === 'desktop:agent-installation-progress') { progressReceivers.add(receive); progressHistory.push(receive); return () => { progressReceivers.delete(receive); unlisten() } }
    if (_name === 'desktop:ui-command') { uiReceivers.add(receive); uiHistory.push(receive); return () => { uiReceivers.delete(receive); unlisten() } }
    receivers.add(receive); history.push(receive); return () => { receivers.delete(receive); unlisten() } })
  const host = createNativeDesktopHost({ core: { invoke }, event: { listen } } as unknown as TauriDesktopApi); hosts.push(host)
  const emit = (operation: ServiceEvent['operation'], payload: ServiceEvent['payload']) => { const event = { protocolVersion: 1, kind: 'event', operation, payload, engineEpoch: epoch, sequence: ++sequence }; for (const receive of [...receivers]) receive({ payload: event }) }
  return { host, invoke, listen, unlisten, results, history, emit, uiHistory, progressHistory,
    emitProgress: (value: unknown) => { for (const receive of [...progressReceivers]) receive({ payload: value }) },
    emitUi: (value: unknown) => { for (const receive of [...uiReceivers]) receive({ payload: value }) },
    changeUiLease: () => { uiLease = 'document-2' }, changeEpoch: () => { epoch = 'engine-2'; sequence = 0 } }
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
function mobileInfo() {
  return { enabled: false, lanAccess: false, sessionIdleDays: 7, url: 'http://127.0.0.1:3210/pair?code=init.fixture:one', port: 3210, lanUrl: null, tunnelUrl: null, tunnelActive: false, remoteMode: 'quick', customUrl: null }
}
function cliSnapshot(): CliMcpSnapshot {
  return {
    clis: CLI_IDS.map(cli => ({ cli, label: CLI_LABELS[cli], files: [{ path: `/approved/${cli}/config`, exists: true, role: 'servers' }], fingerprint: 'a'.repeat(64), capabilities: CLI_CAPABILITIES[cli], notes: [] })),
    servers: [{ cli: 'codex', name: 'docs', definition: { transport: 'http', url: 'https://docs.example/mcp', headers: { Authorization: MASKED_SECRET } }, enabled: true, disabledTools: [], maskedKeys: { env: [], headers: ['Authorization'] }, issues: [] }],
    loadedAt: '2026-10-14T00:00:00Z'
  }
}
const attachmentId = '00000000-0000-4000-8000-000000000001'
const attachmentImage = { name: '../unsafe\0.png', mimeType: 'image/png' as const, data: 'iVBORw0KGgoAAAAA' }
const attachmentMetadata = { id: attachmentId, filename: 'unsafe.png', size: 12, mime_type: 'image/png', added_at: '2026-10-14T00:00:00Z' }
const cliReference = { cli: 'codex' as const, name: 'docs', expectedFingerprint: 'a'.repeat(64) }
const cliUpsert = { targets: ['codex' as const], name: 'docs', definition: { transport: 'http' as const, url: 'https://docs.example/mcp' } }
const cliProbeReply = { status: 'connected' as const, checkedAt: '2026-10-14T00:00:00Z', toolCount: 1, tools: [{ name: 'search', description: 'Find project documentation.' }] }
const cliMutations: Array<{ operation: string; invoke(host: NativeDesktopHost): Promise<unknown>; result: unknown }> = [
  { operation: 'cliMcp:upsert', invoke: host => host.api.cliMcp.upsert(cliUpsert), result: { results: [{ cli: 'codex', ok: true, warnings: [] }], snapshot: cliSnapshot() } },
  { operation: 'cliMcp:remove', invoke: host => host.api.cliMcp.remove(cliReference), result: { results: [{ cli: 'codex', ok: true, warnings: [] }], snapshot: cliSnapshot() } },
  { operation: 'cliMcp:setEnabled', invoke: host => host.api.cliMcp.setEnabled({ ...cliReference, enabled: false }), result: { results: [{ cli: 'codex', ok: true, warnings: [] }], snapshot: cliSnapshot() } },
  { operation: 'cliMcp:setToolEnabled', invoke: host => host.api.cliMcp.setToolEnabled({ ...cliReference, tool: 'search', enabled: false }), result: { results: [{ cli: 'codex', ok: true, warnings: [] }], snapshot: cliSnapshot() } },
  { operation: 'cliMcp:probe', invoke: host => host.api.cliMcp.probe(cliReference), result: cliProbeReply },
  { operation: 'chatImages:saveToTask', invoke: host => host.api.chatImages.saveToTask('task_fixture', [attachmentImage]), result: [attachmentMetadata] },
  { operation: 'attachments:remove', invoke: host => host.api.attachments.remove('task_fixture', attachmentId), result: undefined }
]
it('hydrates CLI snapshots while fencing file mutations, probes and task image effects', async () => {
  const f = fixture(); await f.host.reconnect()
  const snapshot = cliSnapshot(); f.results.set('cliMcp:snapshot', snapshot)
  for (const row of cliMutations) f.results.set(row.operation, row.result)
  const gate = deferred<void>(); f.host.setRehydrator(() => gate.promise); const recovery = f.host.rehydrate()
  expect(await f.host.api.cliMcp.snapshot()).toEqual(snapshot)
  const before = f.invoke.mock.calls.length
  for (const row of cliMutations) await expect(row.invoke(f.host)).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(f.invoke.mock.calls.length).toBe(before)
  gate.resolve(); await recovery
  for (const row of cliMutations) expect(await row.invoke(f.host)).toEqual(row.result)
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'cliMcp:probe', payload: { ref: cliReference }, engineEpoch: 'engine-1' })
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'chatImages:saveToTask', payload: { taskId: 'task_fixture', images: [attachmentImage] }, engineEpoch: 'engine-1' })
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'attachments:remove', payload: { taskId: 'task_fixture', attachmentId }, engineEpoch: 'engine-1' })
})
it.each(cliMutations)('never replays accepted $operation after reconnect or exports its late result', async row => {
  const f = fixture(); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  const pending = deferred<unknown>(), original = f.invoke.getMockImplementation()!
  f.invoke.mockImplementation((command, args) => command === 'desktop_invoke' && args?.operation === row.operation ? pending.promise : original(command, args))
  const mutation = row.invoke(f.host), rejected = expect(mutation).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  f.changeEpoch(); await f.host.reconnect(); await rejected
  pending.resolve({ engineEpoch: 'engine-1', result: row.result === undefined ? { defined: false } : { defined: true, value: row.result } }); await Promise.resolve()
  expect(f.invoke.mock.calls.filter(([command, args]) => command === 'desktop_invoke' && args?.operation === row.operation)).toHaveLength(1)
})
it('rejects malformed CLI and attachment results rather than forwarding private or ambiguous data', async () => {
  const f = fixture(); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  for (const snapshot of [{ ...cliSnapshot(), credentials: 'private' }, { ...cliSnapshot(), clis: [cliSnapshot().clis[0], cliSnapshot().clis[0], cliSnapshot().clis[2]] }]) {
    f.results.set('cliMcp:snapshot', snapshot); await expect(f.host.api.cliMcp.snapshot()).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  }
  f.results.set('cliMcp:probe', { ...cliProbeReply, tools: [{ name: 'search', description: 'Public', environment: { PRIVATE: 'private' } }] })
  await expect(f.host.api.cliMcp.probe(cliReference)).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  f.results.set('cliMcp:upsert', { results: [{ cli: 'codex', ok: true, warnings: [], config: 'private' }], snapshot: cliSnapshot() })
  await expect(f.host.api.cliMcp.upsert(cliUpsert)).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  for (const records of [[{ ...attachmentMetadata, path: '/private/file' }], [{ ...attachmentMetadata, filename: '../unsafe.png' }], [{ ...attachmentMetadata, id: '00000000-0000-0000-8000-000000000001' }], [attachmentMetadata, attachmentMetadata], null]) {
    f.results.set('chatImages:saveToTask', records); await expect(f.host.api.chatImages.saveToTask('task_fixture', [attachmentImage])).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  }
  f.results.set('attachments:remove', true)
  await expect(f.host.api.attachments.remove('task_fixture', attachmentId)).rejects.toMatchObject({ code: 'INVALID_RESULT' })
})
it('routes project reads during hydration and fences real group, pin and pause writes without replay', async () => {
  const f = fixture(); await f.host.reconnect()
  f.results.set('taskGroups:list', [])
  f.results.set('project:getStatusHistory', { entries: [], has_more: false, next_cursor: null })
  f.results.set('projectLimits:isAllPaused', false); f.results.set('projectLimits:pauseAll', true)
  f.results.set('concurrency:pin', { success: true })
  const gate = deferred<void>(); f.host.setRehydrator(() => gate.promise)
  const recovery = f.host.rehydrate()
  expect(await f.host.api.taskGroups.list('project_fixture')).toEqual([])
  expect(await f.host.api.projects.getStatusHistory('project_fixture', { limit: 1.5 })).toEqual({ entries: [], has_more: false, next_cursor: null })
  expect(await f.host.api.projectLimits.isAllPaused()).toBe(false)
  const before = f.invoke.mock.calls.length
  await expect(f.host.api.projectLimits.pauseAll(true)).rejects.toMatchObject({ code: 'DISCONNECTED' })
  await expect(f.host.api.concurrency.pin('project_fixture', 'agent_fixture', 2)).rejects.toMatchObject({ code: 'DISCONNECTED' })
  await expect(f.host.api.taskGroups.create({ title: 'Group', task_ids: ['task_a', 'task_b'] })).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(f.invoke.mock.calls.length).toBe(before)
  gate.resolve(); await recovery
  expect(await f.host.api.projectLimits.pauseAll(true)).toBe(true)
  expect(await f.host.api.concurrency.pin('project_fixture', 'agent_fixture', null)).toEqual({ success: true })
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'concurrency:pin', payload: { projectId: 'project_fixture', agentId: 'agent_fixture', level: null }, engineEpoch: 'engine-1' })
})
it('routes heartbeat and worktree reads while fencing admission, file writes and cleanup until hydration completes', async () => {
  const f = fixture(); await f.host.reconnect()
  f.results.set('heartbeat:getStatus', { enabled: false, intervalMinutes: null, lastCheckAt: null, nextCheckAt: null, hasHeartbeatFile: true })
  f.results.set('heartbeat:readFile', '# Check local work')
  f.results.set('worktree:files', [])
  f.results.set('worktree:readFile', { content: '', size: 200000, binary: false, truncated: true })
  f.results.set('heartbeat:writeFile', true); f.results.set('heartbeat:runNow', 'no_file')
  f.results.set('workspace:runCleanupNow', { cleaned: 0, errors: [], nodeModulesCleaned: 0 })
  const gate = deferred<void>(); f.host.setRehydrator(() => gate.promise); const recovery = f.host.rehydrate()
  expect(await f.host.api.heartbeat.readFile('task_fixture')).toBe('# Check local work')
  expect(await f.host.api.heartbeat.getStatus('task_fixture')).toMatchObject({ enabled: false, hasHeartbeatFile: true })
  expect(await f.host.api.worktree.files('task_fixture', [])).toEqual([])
  expect(await f.host.api.worktree.readFile('task_fixture', null, 'large.txt')).toMatchObject({ truncated: true, size: 200000 })
  const before = f.invoke.mock.calls.length
  await expect(f.host.api.heartbeat.runNow('task_fixture')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  await expect(f.host.api.heartbeat.writeFile('task_fixture', '# New check')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  await expect(f.host.api.worktree.cleanup('task_fixture', [], '')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  await expect(f.host.api.worktree.runCleanupNow()).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(f.invoke.mock.calls.length).toBe(before)
  gate.resolve(); await recovery
  expect(await f.host.api.heartbeat.writeFile('task_fixture', '# New check')).toBe(true)
  expect(await f.host.api.heartbeat.runNow('task_fixture')).toBe('no_file')
  expect(await f.host.api.worktree.runCleanupNow()).toEqual({ cleaned: 0, errors: [], nodeModulesCleaned: 0 })
  const progress = vi.fn(); f.host.api.onWorktreeProgress(progress)
  f.emit('worktree:progress', { taskId: 'task_fixture', repo: 'fixture/repo', step: 'done', done: true })
  expect(progress).toHaveBeenCalledWith({ taskId: 'task_fixture', repo: 'fixture/repo', step: 'done', done: true })
  const cleanup = vi.fn(); f.host.api.onWorkspaceCleanupProgress(cleanup)
  f.emit('workspace:cleanup-progress', { phase: 'done', current: 0, total: 0, cleaned: 0, errors: [] })
  expect(cleanup).toHaveBeenCalledOnce()
  const alert = vi.fn(), disabled = vi.fn(); f.host.api.onHeartbeatAlert(alert); f.host.api.onHeartbeatDisabled(disabled)
  f.emit('heartbeat:alert', { taskId: 'task_fixture', title: 'Local task', summary: 'Review the new result 🌱' })
  f.emit('heartbeat:disabled', { taskId: 'task_fixture', reason: '3 consecutive errors' })
  expect(alert).toHaveBeenCalledWith({ taskId: 'task_fixture', title: 'Local task', summary: 'Review the new result 🌱' })
  expect(disabled).toHaveBeenCalledOnce()
})
it('uses exact codecs and trusted host metadata; missing binary/file bindings never reach native or Electron', async () => {
  const f = fixture(); releases.push(installDesktopHost(f.host))
  f.host.setRehydrator(async () => {}); await f.host.reconnect()
  expect(await desktopApi.settings.get('theme')).toBe('dark')
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'settings:get', payload: { key: 'theme' }, engineEpoch: 'engine-1' })
  await expect(desktopApi.settings.get('api_key')).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  const before = f.invoke.mock.calls.length
  await expect(desktopApi.voice.pushAudio('turn', new Uint8Array([1, 2]))).rejects.toMatchObject({ code: 'DESKTOP_UNAVAILABLE', capability: 'voice.pushAudio' })
  await expect(desktopApi.attachments.pick()).rejects.toMatchObject({ code: 'DESKTOP_UNAVAILABLE' })
  expect(() => desktopApi.webUtils.getPathForFile(new File([], 'private'))).toThrow('unavailable')
  expect(typeof desktopApi.commander.onEvent).toBe('function'); expect(Reflect.get(desktopApi, 'browser')).toBeUndefined()
  expect(f.host.supports('commander.send')).toBe(true); expect(f.invoke.mock.calls.length).toBe(before)
})
it('binds finite voice management while capture, audio and hosted services remain unavailable', async () => {
  const f = fixture(), snapshot = { enabled: false, state: 'disabled', turnId: null, partial: '', final: '', engine: { state: 'engine_missing', message: VOICE_MANAGEMENT_UNAVAILABLE }, models: [], shortcut: '', runtime: { installed: false, version: null, modulePath: null, sizeBytes: 0 } }
  f.results.set('voice:getSnapshot', snapshot); f.results.set('voice:setEndpointSilence', { success: true })
  await f.host.reconnect()
  expect(await f.host.api.voice.getSnapshot()).toEqual(snapshot)
  await expect(f.host.api.voice.setEndpointSilence(1.5)).rejects.toMatchObject({ code: 'DISCONNECTED' })
  f.host.setRehydrator(async () => {}); await f.host.rehydrate()
  expect(await f.host.api.voice.setEndpointSilence(1.5)).toEqual({ success: true })
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'voice:setEndpointSilence', payload: { seconds: 1.5 }, engineEpoch: 'engine-1' })
  const status = vi.fn(), dispose = f.host.api.voice.onStatus(status)
  const event = { enabled: snapshot.enabled, engine: snapshot.engine, models: snapshot.models, shortcut: snapshot.shortcut, runtime: snapshot.runtime }
  f.emit('voice:status', event)
  expect(status).toHaveBeenCalledWith(event); dispose()
  expect(f.host.supports('voice.startTurn')).toBe(false); expect(f.host.supports('voice.tts.speak')).toBe(false)
  const before = f.invoke.mock.calls.length
  await expect(f.host.api.voice.tts.setEngine('elevenlabs')).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.voice.getPermission()).rejects.toMatchObject({ code: 'DESKTOP_UNAVAILABLE' })
  expect(f.invoke.mock.calls.length).toBe(before)
})
it('keeps workspace reads available during recovery, fences filesystem effects and reports absent native callbacks', async () => {
  const f = fixture(), path = '/workspace/task_fixture/report.md'
  f.results.set('shell:readTextFile', { content: 'Owned report', size: 12 })
  f.results.set('tasks:getWorkspaceDir', '/workspace/task_fixture')
  await f.host.reconnect()
  expect(await f.host.api.shell.readTextFile(path)).toEqual({ content: 'Owned report', size: 12 })
  await expect(f.host.api.tasks.getWorkspaceDir('task_fixture')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  await expect(f.host.api.shell.openPath(path)).rejects.toMatchObject({ code: 'DISCONNECTED' })
  await expect(f.host.api.shell.showItemInFolder(path)).rejects.toMatchObject({ code: 'DISCONNECTED' })
  f.host.setRehydrator(async () => {}); await f.host.rehydrate()
  expect(await f.host.api.tasks.getWorkspaceDir('task_fixture')).toBe('/workspace/task_fixture')
  await f.host.api.shell.openPath(path); await f.host.api.shell.showItemInFolder(path)
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'shell:openPath', payload: { filePath: path }, engineEpoch: 'engine-1' })
  const original = f.invoke.getMockImplementation()!
  f.invoke.mockImplementation((command, args) => args?.operation === 'shell:openPath' ? Promise.reject({ code: 'UNKNOWN_OPERATION' }) : original(command, args))
  await expect(f.host.api.shell.openPath(path)).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
  expect(f.host.unavailableCapability).toBe('shell.openPath')
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
  expect(typeof f.host.api.onWorktreeProgress).toBe('function')
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

it('binds the 232 finite production commands including settings effects, secret metadata and terminal ownership', async () => {
  const f = fixture(); releases.push(installDesktopHost(f.host))
  const secret = { id: 'secret-1', name: 'Build credential', description: 'Private integration', env_var_name: 'BUILD_TOKEN', created_at: '2026-10-13', updated_at: '2026-10-13' }
  f.results.set('settings:get', PRODUCTION_API_KEY_SET_MARKER)
  f.results.set('settings:getAll', { theme: 'dark', openai_api_key: PRODUCTION_API_KEY_SET_MARKER })
  f.results.set('env:get', PRODUCTION_API_KEY_SET_MARKER)
  f.results.set('secrets:getAll', [secret]); f.results.set('secrets:create', secret); f.results.set('secrets:update', secret); f.results.set('secrets:delete', true)
  f.results.set('terminal:create', { pid: 4242 }); f.results.set('terminal:getCwd', { cwd: '/selected/workspace' }); f.results.set('terminal:getBuffer', { lines: ['recent output'] })
  f.host.setRehydrator(async () => {}); await f.host.reconnect()
  expect(Object.keys(NATIVE_COMMAND_BINDINGS)).toHaveLength(232)
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
  expect(f.host.supports('cliMcp.upsert')).toBe(true)
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

it('binds mobile controls and fences one-time pairing code creation during recovery', async () => {
  const f = fixture(), info = mobileInfo(), pin = { pin: '123456', pairCodeId: 'pair.fixture:one', expiresAt: 1000 }
  const sessions = [{ id: 'mobile.fixture:one', device_name: 'Fixture Phone', paired_at: 1000, last_seen: 1001 }]
  f.results.set('mobile:getInfo', info); f.results.set('mobile:getPendingPin', pin); f.results.set('mobile:getSessions', sessions)
  f.results.set('mobile:setAccess', { enabled: false, lanAccess: false, sessionIdleDays: 7, listening: false })
  f.results.set('mobile:startTunnel', { tunnelUrl: 'https://mobile.example.test/pair?code=init.fixture:one' }); f.results.set('mobile:stopTunnel', { success: true })
  f.results.set('mobile:setCustomUrl', { url: 'https://mobile.example.test/access/pair?code=init.fixture:one' }); f.results.set('mobile:clearCustomUrl', { success: true })
  f.results.set('mobile:revokeSession', { success: false }); f.results.set('mobile:revokeAllSessions', { success: true })
  await f.host.reconnect()
  expect(await f.host.api.mobile.getSessions()).toEqual(sessions)
  expect(await f.host.api.mobile.getPendingPin()).toEqual(pin)
  const before = f.invoke.mock.calls.length
  await expect(f.host.api.mobile.getInfo()).rejects.toMatchObject({ code: 'DISCONNECTED' })
  await expect(f.host.api.mobile.setAccess({ enabled: true })).rejects.toMatchObject({ code: 'DISCONNECTED' })
  await expect(f.host.api.mobile.startTunnel()).rejects.toMatchObject({ code: 'DISCONNECTED' })
  await expect(f.host.api.mobile.revokeSession(sessions[0].id)).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(f.invoke.mock.calls.length).toBe(before)
  f.host.setRehydrator(async () => {}); await f.host.rehydrate()
  expect(await f.host.api.mobile.getInfo()).toEqual(info)
  expect(await f.host.api.mobile.setAccess({ enabled: false, lanAccess: undefined })).toMatchObject({ listening: false })
  expect(await f.host.api.mobile.startTunnel()).toEqual({ tunnelUrl: 'https://mobile.example.test/pair?code=init.fixture:one' })
  expect(await f.host.api.mobile.stopTunnel()).toEqual({ success: true })
  expect(await f.host.api.mobile.setCustomUrl('https://mobile.example.test/access')).toEqual({ url: 'https://mobile.example.test/access/pair?code=init.fixture:one' })
  expect(await f.host.api.mobile.clearCustomUrl()).toEqual({ success: true })
  expect(await f.host.api.mobile.revokeSession(sessions[0].id)).toEqual({ success: false })
  expect(await f.host.api.mobile.revokeAllSessions()).toEqual({ success: true })
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'mobile:setAccess', payload: { options: { enabled: false } }, engineEpoch: 'engine-1' })
  const beforeInvalid = f.invoke.mock.calls.length
  await expect(f.host.api.mobile.setCustomUrl('https://user:pass@example.test')).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.mobile.setAccess({ enabled: true, profileRoot: '/private' } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.mobile.setAccess({ enabled: undefined })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  expect(f.invoke.mock.calls.length).toBe(beforeInvalid)
  f.results.set('mobile:getInfo', { ...info, sessionToken: 'private' }); await expect(f.host.api.mobile.getInfo()).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  f.results.set('mobile:getSessions', [{ ...sessions[0], token_hash: 'private' }]); await expect(f.host.api.mobile.getSessions()).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  f.results.set('mobile:getPendingPin', null); expect(await f.host.api.mobile.getPendingPin()).toBeNull()
})

it('retains mobile event listeners through epochs without inventing connected devices during recovery', async () => {
  const f = fixture(), pairing = vi.fn(), connected = vi.fn(), pin = { pin: '123456', pairCodeId: 'pair.fixture:one', expiresAt: 1000 }
  const offPairing = f.host.api.mobile.onPairingInitiated(pairing), offConnected = f.host.api.mobile.onDeviceConnected(connected)
  f.host.setRehydrator(async () => {}); await f.host.reconnect()
  expect(pairing).not.toHaveBeenCalled(); expect(connected).not.toHaveBeenCalled()
  f.emit('mobile:pairing-initiated', pin); f.emit('mobile:device-connected', { sessionId: 'mobile.fixture:one', deviceName: 'Fixture Phone' })
  expect(pairing).toHaveBeenCalledExactlyOnceWith(pin); expect(connected).toHaveBeenCalledExactlyOnceWith({ sessionId: 'mobile.fixture:one', deviceName: 'Fixture Phone' })
  f.changeEpoch(); await f.host.reconnect()
  f.history[0]?.({ payload: { protocolVersion: 1, kind: 'event', operation: 'mobile:device-connected', payload: { sessionId: 'retired', deviceName: 'Retired' }, engineEpoch: 'engine-1', sequence: 3 } })
  expect(connected).toHaveBeenCalledOnce()
  f.emit('mobile:device-connected', { sessionId: 'mobile.fixture:two', deviceName: 'Fixture Tablet' }); expect(connected).toHaveBeenCalledTimes(2)
  offPairing(); offConnected()
  f.emit('mobile:pairing-initiated', pin); expect(pairing).toHaveBeenCalledOnce()
})

it('refuses secret-bearing or caller-grant mobile event payloads before notifying listeners', async () => {
  const f = fixture(), connected = vi.fn(); f.host.api.mobile.onDeviceConnected(connected)
  f.host.setRehydrator(async () => {}); await f.host.reconnect()
  f.emit('mobile:device-connected', { sessionId: 'mobile.fixture:one', deviceName: 'Fixture Phone', sessionToken: 'private' })
  expect(connected).not.toHaveBeenCalled(); expect(f.host.connection.status).toBe('disconnected')
})

it('reports an unavailable native quick tunnel without falling back to a hosted service', async () => {
  const f = fixture(); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  const original = f.invoke.getMockImplementation()!
  f.invoke.mockImplementation((command, args) => command === 'desktop_invoke' && args?.operation === 'mobile:startTunnel' ? Promise.reject({ code: 'UNKNOWN_OPERATION', privateDetail: 'No native tunnel owner' }) : original(command, args))
  await expect(f.host.api.mobile.startTunnel()).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
  expect(f.host.unavailableCapability).toBe('mobile.startTunnel')
  expect(f.invoke.mock.calls.filter(([command, args]) => command === 'desktop_invoke' && args?.operation === 'mobile:startTunnel')).toHaveLength(1)
})

const mobileMutations: Array<{ operation: string; invoke(host: NativeDesktopHost): Promise<unknown>; result: unknown }> = [
  { operation: 'mobile:getInfo', invoke: host => host.api.mobile.getInfo(), result: mobileInfo() },
  { operation: 'mobile:setAccess', invoke: host => host.api.mobile.setAccess({ enabled: false }), result: { enabled: false, lanAccess: false, sessionIdleDays: 7, listening: false } },
  { operation: 'mobile:startTunnel', invoke: host => host.api.mobile.startTunnel(), result: { tunnelUrl: 'https://mobile.example.test/pair?code=init.fixture:one' } },
  { operation: 'mobile:stopTunnel', invoke: host => host.api.mobile.stopTunnel(), result: { success: true } },
  { operation: 'mobile:setCustomUrl', invoke: host => host.api.mobile.setCustomUrl('https://mobile.example.test/access'), result: { url: 'https://mobile.example.test/access/pair?code=init.fixture:one' } },
  { operation: 'mobile:clearCustomUrl', invoke: host => host.api.mobile.clearCustomUrl(), result: { success: true } },
  { operation: 'mobile:revokeSession', invoke: host => host.api.mobile.revokeSession('mobile.fixture:one'), result: { success: true } },
  { operation: 'mobile:revokeAllSessions', invoke: host => host.api.mobile.revokeAllSessions(), result: { success: true } }
]
it.each(mobileMutations)('never replays accepted $operation after a native disconnect', async row => {
  const f = fixture(); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  const pending = deferred<unknown>(), original = f.invoke.getMockImplementation()!
  f.invoke.mockImplementation((command, args) => command === 'desktop_invoke' && args?.operation === row.operation ? pending.promise : original(command, args))
  const mutation = row.invoke(f.host), rejected = expect(mutation).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  f.changeEpoch(); await f.host.reconnect(); await rejected
  pending.resolve({ engineEpoch: 'engine-1', result: { defined: true, value: row.result } }); await Promise.resolve()
  expect(f.invoke.mock.calls.filter(([command, args]) => command === 'desktop_invoke' && args?.operation === row.operation)).toHaveLength(1)
})


it('routes reviewed native URLs with a hydration fence and validates native version replies', async () => {
  const f = fixture()
  f.results.set('app:getVersion', '0.1.0')
  await f.host.reconnect()
  expect(await f.host.api.app.getVersion()).toBe('0.1.0')
  const before = f.invoke.mock.calls.length
  await expect(f.host.api.shell.openExternal('https://example.test/help')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(f.invoke.mock.calls.length).toBe(before)
  f.host.setRehydrator(async () => {}); await f.host.rehydrate()
  await f.host.api.shell.openExternal('https://example.test/help')
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'shell:openExternal', payload: { url: 'https://example.test/help' }, engineEpoch: 'engine-1' })
  const accepted = f.invoke.mock.calls.length
  for (const url of ['file:///private', 'javascript:alert(1)', 'https://user:secret@example.test', 'https://example.test/\n']) {
    await expect(f.host.api.shell.openExternal(url)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  }
  expect(f.invoke.mock.calls.length).toBe(accepted)
  f.results.set('app:getVersion', { version: '0.1.0', privatePath: '/private' })
  await expect(f.host.api.app.getVersion()).rejects.toMatchObject({ code: 'INVALID_RESULT' })
})

it('never replays an accepted native URL opening after an epoch change', async () => {
  const f = fixture(); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  const raw = deferred<unknown>(), original = f.invoke.getMockImplementation()!
  f.invoke.mockImplementation((command, args) => command === 'desktop_invoke' && args?.operation === 'shell:openExternal' ? raw.promise : original(command, args))
  const opening = f.host.api.shell.openExternal('https://example.test/help'), rejected = expect(opening).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  f.changeEpoch(); await f.host.reconnect(); await rejected
  raw.resolve({ engineEpoch: 'engine-1', result: { defined: false } }); await Promise.resolve()
  expect(f.invoke.mock.calls.filter(([command, args]) => command === 'desktop_invoke' && args?.operation === 'shell:openExternal')).toHaveLength(1)
})

it('binds bounded artifact reads while clipboard requires current document authority', async () => {
  const f = fixture()
  f.results.set('artifacts:scan', [{ path: 'report.md', title: 'report.md', type: 'markdown', updatedAt: 100, size: 10 }])
  f.results.set('artifacts:read', { kind: 'text', content: 'Owned report\n', mimeType: 'text/markdown' })
  f.host.setRehydrator(async () => {}); await f.host.reconnect()
  expect(await f.host.api.artifacts.scan('task_fixture')).toEqual(f.results.get('artifacts:scan'))
  expect(await f.host.api.artifacts.read('task_fixture', 'report.md')).toEqual(f.results.get('artifacts:read'))
  const before = f.invoke.mock.calls.length
  await expect(f.host.api.artifacts.read('task_fixture', '../private.txt')).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.artifacts.copyFile!('task_fixture', 'report.md')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(f.invoke.mock.calls.length).toBe(before)
})


it('routes exact CLI detection and refuses installation without a current native document', async () => {
  const f = fixture()
  const snapshot = Object.fromEntries(AGENT_INSTALLER_DETECTION_KEYS.map(key => [key, { installed: false, version: null }]))
  Object.assign(snapshot, { pi: { installed: false, version: null, supported: false, reason: 'Pi CLI is not installed.' },
    rtk: { installed: false, version: null, configured: false, integrations: { claudeCode: false, opencode: false, codex: false, cursor: false, pi: false } } })
  f.results.set('agent-installer:detect', snapshot)
  await f.host.reconnect()
  expect(await f.host.api.agentInstaller.detect()).toEqual(snapshot)
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'agent-installer:detect', payload: {}, engineEpoch: 'engine-1' })
  f.host.setRehydrator(async () => {}); await f.host.rehydrate()
  const before = f.invoke.mock.calls.length
  await expect(f.host.api.agentInstaller.install('codex')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(f.invoke.mock.calls.length).toBe(before)
  f.results.set('agent-installer:detect', { ...snapshot, codex: { installed: false, version: null, stdout: 'Private inherited output' } })
  await expect(f.host.api.agentInstaller.detect()).rejects.toMatchObject({ code: 'INVALID_RESULT' })
})

function gitRepoRow() {
  return { name: 'repo', fullName: 'fixture/repo', defaultBranch: 'release/main', cloneUrl: 'https://git.example/fixture/repo.git', description: 'Public repository\nDescription', isPrivate: true }
}
function gitPullRequest() {
  return { url: 'https://github.com/fixture/repo/pull/42', repository: 'fixture/repo', number: 42, title: 'Public change', body: 'Human\nbody', state: 'open', isDraft: false, reviewDecision: 'review_required', author: { login: 'fixture', avatarUrl: 'https://git.example/avatar' }, baseRefName: 'main', headRefName: 'feature/change', additions: 1, deletions: 0, changedFiles: 1, commentsCount: 0, reviewsCount: 0, createdAt: '2026-10-14', updatedAt: '2026-10-14', checks: [{ name: 'CI', state: 'pending', url: 'https://git.example/checks/42' }] }
}
it('binds all fifteen provider operations to finite codecs and preserves actual status, repository, PR and void results', async () => {
  const f = fixture(), cli = { installed: true, authenticated: true, username: 'fixture' }, tea = { installed: false, authenticated: false, logins: [], code: 'not-installed', message: 'The tea CLI is unavailable.' }, repo = gitRepoRow(), pr = gitPullRequest()
  f.host.setRehydrator(async () => {}); await f.host.reconnect()
  const cases: Array<[string, () => Promise<unknown>, Record<string, unknown>, unknown]> = [
    ['github:checkCli', () => f.host.api.github.checkCli(), {}, cli],
    ['github:fetchOrgs', () => f.host.api.github.fetchOrgs(), {}, ['fixture']],
    ['github:fetchOrgRepos', () => f.host.api.github.fetchOrgRepos('fixture'), { org: 'fixture' }, [repo]],
    ['github:fetchUserRepos', () => f.host.api.github.fetchUserRepos(), {}, [repo]],
    ['github:fetchPullRequestDetails', () => f.host.api.github.fetchPullRequestDetails(pr.url), { url: pr.url }, pr],
    ['gitlab:checkCli', () => f.host.api.gitlab.checkCli(), {}, cli],
    ['gitlab:fetchOrgs', () => f.host.api.gitlab.fetchOrgs(), {}, ['fixture/subgroup']],
    ['gitlab:fetchOrgRepos', () => f.host.api.gitlab.fetchOrgRepos('fixture/subgroup'), { org: 'fixture/subgroup' }, [repo]],
    ['gitlab:fetchUserRepos', () => f.host.api.gitlab.fetchUserRepos(), {}, [repo]],
    ['forgejo:checkCli', () => f.host.api.forgejo.checkCli(), {}, tea],
    ['forgejo:setLogin', () => f.host.api.forgejo.setLogin(null), { loginName: null }, tea],
    ['forgejo:fetchOrgs', () => f.host.api.forgejo.fetchOrgs(), {}, ['fixture']],
    ['forgejo:fetchOrgRepos', () => f.host.api.forgejo.fetchOrgRepos('fixture'), { org: 'fixture' }, [repo]],
    ['forgejo:fetchUserRepos', () => f.host.api.forgejo.fetchUserRepos(), {}, [repo]],
    ['git:recordRepoProviders', () => f.host.api.git.recordRepoProviders(['fixture/repo'], 'forgejo'), { repoFullNames: ['fixture/repo'], provider: 'forgejo' }, undefined]
  ]
  for (const [operation, call, payload, result] of cases) {
    f.results.set(operation, result)
    expect(await call()).toEqual(result)
    expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation, payload, engineEpoch: 'engine-1' })
  }
  expect(f.host.unavailableCapability).toBeNull()
})
it('allows provider reads during recovery but fences login and provider-map writes until hydration', async () => {
  const f = fixture(); f.results.set('github:fetchOrgs', [])
  await f.host.reconnect()
  expect(await f.host.api.github.fetchOrgs()).toEqual([])
  const before = f.invoke.mock.calls.length
  await expect(f.host.api.forgejo.setLogin('Work login')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  await expect(f.host.api.git.recordRepoProviders([], 'github')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(f.invoke.mock.calls.length).toBe(before)
})
it('refuses provider URL credentials, namespaces, secret markers and extra scope fields before transport', async () => {
  const f = fixture(); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  const before = f.invoke.mock.calls.length
  for (const org of ['fixture/subgroup', '--help', '../private', 'ghp_private', 'fixture\u0000']) await expect(f.host.api.github.fetchOrgRepos(org)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  for (const url of ['https://user:secret@github.com/fixture/repo/pull/42', 'https://github.com/fixture/repo/pull/42?token=private', 'file:///private', 'http://github.com/fixture/repo/pull/42']) await expect(f.host.api.github.fetchPullRequestDetails(url)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.forgejo.setLogin({ loginName: 'Work', caller: 'trusted-desktop-main' } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.forgejo.setLogin('__21x_api_key_set__')).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.git.recordRepoProviders(['fixture/repo', 'fixture/repo'], 'github')).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  await expect(f.host.api.git.recordRepoProviders(['fixture/repo'], 'program' as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  expect(f.invoke.mock.calls.length).toBe(before)
})
it.each(['forgejo:setLogin', 'git:recordRepoProviders'] as const)('never replays accepted %s when its epoch disconnects', async operation => {
  const f = fixture(), pending = deferred<unknown>(); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  const original = f.invoke.getMockImplementation()!
  f.invoke.mockImplementation((command, args) => command === 'desktop_invoke' && args?.operation === operation ? pending.promise : original(command, args))
  const writing = operation === 'forgejo:setLogin' ? f.host.api.forgejo.setLogin('Work') : f.host.api.git.recordRepoProviders(['fixture/repo'], 'github')
  const rejected = expect(writing).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  f.changeEpoch(); await f.host.reconnect(); await rejected
  pending.resolve({ engineEpoch: 'engine-1', result: operation === 'forgejo:setLogin' ? { defined: true, value: { installed: true, authenticated: false, logins: [], code: 'no-login' } } : { defined: false } }); await Promise.resolve()
  expect(f.invoke.mock.calls.filter(([command, args]) => command === 'desktop_invoke' && args?.operation === operation)).toHaveLength(1)
})
it('records explicitly unavailable provider capability without replacing it with fabricated CLI success', async () => {
  const f = fixture(); await f.host.reconnect(); const original = f.invoke.getMockImplementation()!
  f.invoke.mockImplementation((command, args) => command === 'desktop_invoke' && args?.operation === 'forgejo:checkCli' ? Promise.reject({ code: 'UNKNOWN_OPERATION' }) : original(command, args))
  await expect(f.host.api.forgejo.checkCli()).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
  expect(f.host.unavailableCapability).toBe('forgejo.checkCli')
})
it.each([
  { rows: [{ ...gitRepoRow(), cloneUrl: 'https://user:secret@git.example/fixture/repo.git' }] },
  { rows: [{ ...gitRepoRow(), credential: '__21x_api_key_set__' }] },
  { rows: [{ ...gitRepoRow(), description: 'x'.repeat(4097) }] },
  { rows: [gitRepoRow(), gitRepoRow()] }
])('rejects unprojected or oversized repository wire results', async ({ rows }) => {
  const f = fixture(); f.results.set('github:fetchUserRepos', rows); await f.host.reconnect()
  await expect(f.host.api.github.fetchUserRepos()).rejects.toMatchObject({ code: 'INVALID_RESULT' })
})
it('rejects raw Tea errors and private pull request author fields on the wire', async () => {
  const f = fixture(); await f.host.reconnect()
  f.results.set('forgejo:checkCli', { installed: true, authenticated: false, logins: [], code: 'error', message: 'private subprocess stderr' })
  await expect(f.host.api.forgejo.checkCli()).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  f.results.set('github:fetchPullRequestDetails', { ...gitPullRequest(), author: { login: 'fixture', token: 'private' } })
  await expect(f.host.api.github.fetchPullRequestDetails('https://github.com/fixture/repo/pull/42')).rejects.toMatchObject({ code: 'INVALID_RESULT' })
})

const publishedUi = { view: 'commander', projectId: 'project_fixture', modal: null, selectedTaskId: null, selectedTaskTitle: null, dashboardPreviewTaskId: null, captainOpen: false, settingsTab: null, waitingForYou: false, visibleTaskIds: [], canvas: { viewport: { x: 0, y: 0, zoom: 1 }, panels: [] } }
it('captures native document authority separately from published state and filters retired UI intents', async () => {
  const f = fixture(true); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  const received = vi.fn(), cleanup = f.host.api.ui.onCommand(received)
  await f.host.api.ui.publishState(publishedUi)
  expect(f.invoke).toHaveBeenCalledWith('desktop_invoke', { operation: 'ui:publishState', payload: { state: publishedUi }, engineEpoch: 'engine-1', uiLease: 'document-1' })
  const intent = { engineEpoch: 'engine-1', leaseId: 'document-1', command: { kind: 'navigate', view: 'tasks' } }
  f.emitUi(intent); expect(received).toHaveBeenCalledTimes(1)
  for (const invalid of [{ ...intent, leaseId: 'foreign' }, { ...intent, engineEpoch: 'foreign' }, { ...intent, authority: '*' }, { ...intent, command: { kind: 'navigate', view: 'commander' } }]) f.emitUi(invalid)
  expect(received).toHaveBeenCalledTimes(1)
  const retired = f.uiHistory[0]; f.changeUiLease(); await f.host.reconnect()
  retired({ payload: intent }); f.emitUi(intent); expect(received).toHaveBeenCalledTimes(1)
  f.emitUi({ ...intent, leaseId: 'document-2' }); expect(received).toHaveBeenCalledTimes(2)
  await f.host.api.ui.publishState(publishedUi)
  expect(f.invoke.mock.calls.at(-1)?.[1]).toMatchObject({ uiLease: 'document-2' })
  cleanup(); f.emitUi({ ...intent, leaseId: 'document-2' }); expect(received).toHaveBeenCalledTimes(2)
})
it('does not publish UI state without native document authority or replay an old publication', async () => {
  const absent = fixture(); absent.host.setRehydrator(async () => {}); await absent.host.reconnect()
  const count = absent.invoke.mock.calls.length
  await expect(absent.host.api.ui.publishState(publishedUi)).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(absent.invoke.mock.calls.length).toBe(count)
  const f = fixture(true); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  const pending = deferred<unknown>(), original = f.invoke.getMockImplementation()!
  f.invoke.mockImplementation((command, args) => args?.operation === 'ui:publishState' ? pending.promise : original(command, args))
  const old = f.host.api.ui.publishState(publishedUi), rejected = expect(old).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  f.changeEpoch(); f.changeUiLease(); await f.host.reconnect(); await rejected
  pending.resolve({ engineEpoch: 'engine-1', result: { defined: false } })
  expect(f.invoke.mock.calls.filter(([, args]) => args?.operation === 'ui:publishState')).toHaveLength(1)
})

it('uses finite leased installer receipts and refuses retired or private progress payloads', async () => {
  const f = fixture(true); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  const progress = vi.fn(), off = f.host.api.agentInstaller.onProgress(progress)
  const detection = Object.fromEntries(['nodejs','npm','pnpm','git','gh','glab','tea','rtk','claudeCode','opencode','codex','cursor','pi'].map(key => [key, key === 'pi' ? { installed: false, version: null, supported: false, reason: 'Pi CLI is not installed.' } : key === 'rtk' ? { installed: false, version: null, configured: false, integrations: { claudeCode: false, opencode: false, codex: false, cursor: false, pi: false } } : { installed: false, version: null }]))
  f.results.set('agent-installer:install', { success: false, error: 'This CLI does not have a portable installation plan.', newStatus: detection })
  await f.host.api.agentInstaller.install('cursor')
  expect(f.invoke.mock.calls.at(-1)?.[1]).toEqual({ operation: 'agent-installer:install', payload: { agentName: 'cursor' }, engineEpoch: 'engine-1', uiLease: 'document-1' })
  const receipt = { engineEpoch: 'engine-1', leaseId: 'document-1', progress: { agentName: 'opencode', stage: 'starting', output: 'Preparing CLI installation.', percent: 5 } }
  f.emitProgress(receipt); expect(progress).toHaveBeenCalledTimes(1)
  for (const invalid of [{ ...receipt, leaseId: 'retired' }, { ...receipt, caller: '*' }, { ...receipt, progress: { ...receipt.progress, output: 'private stderr' } }]) f.emitProgress(invalid)
  expect(progress).toHaveBeenCalledTimes(1)
  const retired = f.progressHistory[0]; f.changeUiLease(); await f.host.reconnect()
  retired({ payload: receipt }); f.emitProgress(receipt); expect(progress).toHaveBeenCalledTimes(1)
  f.emitProgress({ ...receipt, leaseId: 'document-2' }); expect(progress).toHaveBeenCalledTimes(2)
  off(); f.emitProgress({ ...receipt, leaseId: 'document-2' }); expect(progress).toHaveBeenCalledTimes(2)
})
it('does not let a late bootstrap response replace a newer document or dispose its listeners', async () => {
  const f = fixture(true); f.host.setRehydrator(async () => {})
  const gate = deferred<unknown>(), original = f.invoke.getMockImplementation()!; let first = true
  f.invoke.mockImplementation((command, args) => { if (command === 'engine_status' && first) { first = false; return gate.promise } return original(command, args) })
  const old = f.host.reconnect(), failure = expect(old).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  await f.host.reconnect(); gate.resolve({ available: true, protocolVersion: 1, engineEpoch: 'engine-old', uiLeaseId: 'document-old' }); await failure
  expect(f.host.connection.status).toBe('ready')
  const commands = vi.fn(); f.host.api.ui.onCommand(commands)
  f.emitUi({ engineEpoch: 'engine-1', leaseId: 'document-1', command: { kind: 'navigate', view: 'tasks' } })
  expect(commands).toHaveBeenCalledOnce()
  await f.host.api.ui.publishState(publishedUi)
  expect(f.invoke.mock.calls.at(-1)?.[1]).toMatchObject({ engineEpoch: 'engine-1', uiLease: 'document-1' })
})


it.each(['open', 'download'] as const)('uses attachment %s with current native document receipt and refuses absent or invalid authority before invocation', async method => {
  const f = fixture(true); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  await expect(f.host.api.attachments[method]('task_fixture', attachmentId)).resolves.toBeUndefined()
  expect(f.invoke.mock.calls.at(-1)?.[1]).toEqual({ operation: `attachments:${method}`, payload: { taskId: 'task_fixture', attachmentId }, engineEpoch: 'engine-1', uiLease: 'document-1' })
  const before = f.invoke.mock.calls.length
  await expect(f.host.api.attachments[method]('task_fixture', '../private-file')).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  expect(f.invoke.mock.calls.length).toBe(before)
  f.changeUiLease(); await f.host.reconnect()
  await f.host.api.attachments[method]('task_fixture', attachmentId)
  expect(f.invoke.mock.calls.at(-1)?.[1]).toMatchObject({ uiLease: 'document-2' })
  const absent = fixture(); absent.host.setRehydrator(async () => {}); await absent.host.reconnect()
  const calls = absent.invoke.mock.calls.length
  await expect(absent.host.api.attachments[method]('task_fixture', attachmentId)).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(absent.invoke.mock.calls.length).toBe(calls)
})
it.each(['open', 'download'] as const)('joins accepted attachment %s after disconnect without replaying it into a replacement document', async method => {
  const f = fixture(true); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  const held = deferred<unknown>(), original = f.invoke.getMockImplementation()!
  f.invoke.mockImplementation((command, args) => args?.operation === `attachments:${method}` ? held.promise : original(command, args))
  const work = f.host.api.attachments[method]('task_fixture', attachmentId), failure = expect(work).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  f.changeEpoch(); f.changeUiLease(); await f.host.reconnect(); await failure
  held.resolve({ engineEpoch: 'engine-1', result: { defined: false } })
  expect(f.invoke.mock.calls.filter(([, args]) => args?.operation === `attachments:${method}`)).toHaveLength(1)
})

it('reads finite clipboard images only with a current document after hydration', async () => {
  const f = fixture(true); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  const value = { images: [{ name: 'image.png', mimeType: 'image/png', data: 'iVBORw0KGgoAAAAA' }], errors: [] }
  f.results.set('chatImages:readClipboard', value)
  expect(await f.host.api.chatImages.readClipboard()).toEqual(value)
  expect(f.invoke.mock.calls.at(-1)?.[1]).toEqual({ operation: 'chatImages:readClipboard', payload: {}, engineEpoch: 'engine-1', uiLease: 'document-1' })
  const gate = deferred<void>(); f.host.setRehydrator(() => gate.promise); const recovery = f.host.rehydrate()
  const before = f.invoke.mock.calls.length
  await expect(f.host.api.chatImages.readClipboard()).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(f.invoke.mock.calls.length).toBe(before)
  gate.resolve(); await recovery
  f.results.set('chatImages:readClipboard', { images: [], errors: [NATIVE_CLIPBOARD_ERRORS.copiedFiles] })
  expect(await f.host.api.chatImages.readClipboard()).toEqual({ images: [], errors: [NATIVE_CLIPBOARD_ERRORS.copiedFiles] })
  const absent = fixture(); absent.host.setRehydrator(async () => {}); await absent.host.reconnect()
  const calls = absent.invoke.mock.calls.length
  await expect(absent.host.api.chatImages.readClipboard()).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(absent.invoke.mock.calls.length).toBe(calls)
})
it('refuses private clipboard results and does not export or replay old document results', async () => {
  const f = fixture(true); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  for (const value of [undefined, { images: [], errors: ['private stderr /profile'] }, { images: [], errors: [], path: '/private' },
    { images: [{ name: 'image.png', mimeType: 'image/png', data: 'iVBORw0KGgoAAAAA', path: '/private' }], errors: [] }]) {
    f.results.set('chatImages:readClipboard', value)
    await expect(f.host.api.chatImages.readClipboard()).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  }
  const held = deferred<unknown>(), original = f.invoke.getMockImplementation()!
  f.invoke.mockImplementation((command, args) => args?.operation === 'chatImages:readClipboard' ? held.promise : original(command, args))
  const count = f.invoke.mock.calls.filter(([, args]) => args?.operation === 'chatImages:readClipboard').length
  const work = f.host.api.chatImages.readClipboard(), failure = expect(work).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  f.changeUiLease(); await f.host.reconnect(); await failure
  held.resolve({ engineEpoch: 'engine-1', result: { defined: true, value: { images: [], errors: [] } } })
  expect(f.invoke.mock.calls.filter(([, args]) => args?.operation === 'chatImages:readClipboard')).toHaveLength(count + 1)
})

it('binds artifact file copy to the current document and fences hydration without replay', async () => {
  const f = fixture(true); releases.push(installDesktopHost(f.host)); f.results.set('artifacts:copyFile', { mode: 'file' })
  await expect(desktopApi.artifacts.copyFile('task_1', 'report.md')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  f.host.setRehydrator(async () => {}); await f.host.reconnect()
  expect(await desktopApi.artifacts.copyFile('task_1', 'report.md')).toEqual({ mode: 'file' })
  expect(f.invoke).toHaveBeenLastCalledWith('desktop_invoke', { operation: 'artifacts:copyFile', payload: { taskId: 'task_1', relativePath: 'report.md' }, engineEpoch: 'engine-1', uiLease: 'document-1' })
  const before = f.invoke.mock.calls.length
  await expect(desktopApi.artifacts.copyFile('task_1', '../private')).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  expect(f.invoke).toHaveBeenCalledTimes(before)
  f.results.set('artifacts:copyFile', { mode: 'file', filePath: '/private' })
  await expect(desktopApi.artifacts.copyFile('task_1', 'report.md')).rejects.toMatchObject({ code: 'INVALID_RESULT' })
})

it('uses exact native notification arguments and current document while keeping permission reads available for hydration', async () => {
  const f = fixture(true); releases.push(installDesktopHost(f.host)); f.results.set('app:getNotificationPermission', 'granted'); f.results.set('app:requestNotificationPermission', 'denied')
  f.host.setRehydrator(async () => {}); await f.host.reconnect()
  expect(await desktopApi.app.getNotificationPermission()).toBe('granted')
  expect(await desktopApi.app.requestNotificationPermission()).toBe('denied')
  await desktopApi.notifications.show('Review ready', 'Task ready\nReview')
  expect(f.invoke).toHaveBeenLastCalledWith('desktop_invoke', { operation: 'notifications:show', payload: { title: 'Review ready', body: 'Task ready\nReview' }, engineEpoch: 'engine-1', uiLease: 'document-1' })
  const before = f.invoke.mock.calls.length
  await expect(desktopApi.notifications.show('x'.repeat(161), '')).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' }); expect(f.invoke).toHaveBeenCalledTimes(before)
  f.results.set('app:getNotificationPermission', { status: 'granted', server: ':1.0' })
  await expect(desktopApi.app.getNotificationPermission()).rejects.toMatchObject({ code: 'INVALID_RESULT' })
})
it('refuses notification permission and display effects without physical document authority', async () => {
  const f = fixture(); releases.push(installDesktopHost(f.host)); f.host.setRehydrator(async () => {}); await f.host.reconnect()
  const before = f.invoke.mock.calls.length
  await expect(desktopApi.app.getNotificationPermission()).rejects.toMatchObject({ code: 'DISCONNECTED' })
  await expect(desktopApi.app.requestNotificationPermission()).rejects.toMatchObject({ code: 'DISCONNECTED' })
  await expect(desktopApi.notifications.show('Review', '')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(f.invoke).toHaveBeenCalledTimes(before)
})

it('hydrates permission availability through the captured document while fencing permission requests and display', async () => {
  const f = fixture(true); f.results.set('app:getNotificationPermission', 'granted'); let observed: unknown
  f.host.setRehydrator(async () => {
    observed = await f.host.api.app.getNotificationPermission()
    await expect(f.host.api.app.requestNotificationPermission()).rejects.toMatchObject({ code: 'DISCONNECTED' })
    await expect(f.host.api.notifications.show('Review', '')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  })
  await f.host.reconnect(); expect(observed).toBe('granted')
  expect(f.invoke.mock.calls.filter(([command]) => command === 'desktop_invoke')).toEqual([['desktop_invoke', { operation: 'app:getNotificationPermission', payload: {}, engineEpoch: 'engine-1', uiLease: 'document-1' }]])
})
