import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dirname } from 'node:path'
import { rmSync } from 'node:fs'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from '../main/agent-manager-core'
import { SyncManager, SourceMutationBusyError } from '../main/sync-manager'
import { PluginRegistry } from '../main/plugins/registry'
import type { TaskSourcePlugin, PluginContext, PluginSyncResult } from '../main/plugins/types'
import type { TaskRecord } from '../main/database/types'
import { upsertSourcedTask } from '../main/plugins/sourced-tasks'
import { OAuthManager } from '../main/oauth/oauth-manager-core'
import { RecurrenceSchedulerCore } from '../main/recurrence-scheduler-core'
import { HeartbeatSchedulerCore } from '../main/heartbeat-scheduler-core'
import { TaskAutomationScheduler } from '../main/task-automation-scheduler'
import { setTaskSchedulers, setTaskAutomationTrigger } from '../main/task-updates'
import { AuthenticatedSecretStorage } from '../main/platform/authenticated-secret-storage'
import { configureSecretStorage, getSecretStorage, releaseSecretStorage, type SecretStorage } from '../main/platform/secret-storage'
import { ConnectorStore } from '../main/connectors/connector-store'
import { ConnectorCredentialStore } from '../main/connectors/credentials'
import { ConnectorBridgeCore } from '../main/plugins/connector-bridge-core'
import { readCursor } from '../main/connectors/bridge/state'
import { TaskSourceBackend, type TaskSourceBackendOptions, type TaskSourceOwners } from './task-source-backend'
import { TASK_SOURCE_CODECS, TASK_SOURCE_KEY_SET_MARKER as marker, type TaskSourceCodec, type TaskSourceOperation } from '../shared/task-source-codecs'
import { TaskStatus } from '../shared/constants'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import type { DesktopCallerContext } from './transport/desktop-registry'
import type { JsonValue } from '../shared/service-protocol'

/** Explicit local provider fixture. Database/sync/lifecycle owners are real;
 * these tests do not claim a remote API, packaged piece worker or OAuth proof. */
class LocalSourcePlugin implements TaskSourcePlugin {
  displayName = 'Controlled source'; description = 'Local fixture'; icon = 'Test'
  constructor(readonly id = 'github-issues') {}
  getConfigSchema() { return [] }
  resolveOptions = vi.fn(async () => [])
  getActions() { return [] }
  importNow(sourceId: string, config: Record<string, unknown>, context: PluginContext): PluginSyncResult {
    const result = upsertSourcedTask(context, sourceId, 'remote-one', { title: `Imported ${String(config.repo ?? 'item')}`, status: TaskStatus.NotStarted }, { title: 'Imported item', source: 'Controlled fixture' })
    return { imported: result?.created ? 1 : 0, updated: result && !result.created ? 1 : 0, errors: [] }
  }
  importTasks = vi.fn(async (id: string, config: Record<string, unknown>, context: PluginContext) => this.importNow(id, config, context))
  exportUpdate = vi.fn(async (_task: TaskRecord, _fields: Record<string, unknown>, _config: Record<string, unknown>, _context: PluginContext): Promise<void> => {})
  executeAction = vi.fn(async () => ({ success: false, error: 'Fixture has no actions' }))
  getUsers = vi.fn(async () => [{ id: 'remote-user', email: 'fixture@example.test', name: 'Fixture User' }])
  reassignTask = vi.fn(async (_task: TaskRecord, _ids: string[], _config: Record<string, unknown>, _context: PluginContext) => ({ success: true }))
}
let db: ReturnType<typeof createPortableTestDb>, manager: AgentManager, sync: SyncManager, plugins: PluginRegistry, plugin: LocalSourcePlugin
let oauth: OAuthManager, recurrence: RecurrenceSchedulerCore, heartbeat: HeartbeatSchedulerCore, automation: TaskAutomationScheduler
let adapter: FakeAdapter, backend: TaskSourceBackend, options: TaskSourceBackendOptions
let storage: AuthenticatedSecretStorage, priorStorage: SecretStorage, events: Array<{ operation: string; payload: JsonValue }>
let bridges: ConnectorBridgeCore[], credentials: ConnectorCredentialStore[], gates: Array<() => void>
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'source-epoch', webviewId: 'main', origin: 'app://sources' }
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve }); gates.push(release)
  return { promise, release }
}
beforeEach(() => {
  gates = []; bridges = []; credentials = []; events = []
  priorStorage = getSecretStorage(); releaseSecretStorage(priorStorage)
  storage = new AuthenticatedSecretStorage(Buffer.alloc(32, 43), 'source-unit-profile'); configureSecretStorage(storage)
  db = createPortableTestDb(); adapter = new FakeAdapter()
  manager = new AgentManager(db, { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' },
    configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => adapter, isCodexAppServerAdapter: () => false })
  oauth = new OAuthManager(db, { openExternal: async () => { throw new Error('Native browser is not enabled in this fixture') }, notify: () => { throw new Error('Native notification is not enabled in this fixture') } })
  plugins = new PluginRegistry(); plugin = new LocalSourcePlugin(); plugins.register(plugin)
  sync = new SyncManager(db, plugins, oauth); manager.setSyncManager(sync)
  recurrence = new RecurrenceSchedulerCore(db, 'UTC'); heartbeat = new HeartbeatSchedulerCore(db, manager); automation = new TaskAutomationScheduler(db, manager)
  setTaskSchedulers({ recurrence, heartbeat }); setTaskAutomationTrigger(() => { void automation.runNow() }, automation)
  const owners: TaskSourceOwners = { database: db, manager, sync, plugins, oauth, secretStorage: storage }
  options = { ...owners, recurrence, heartbeat, automation, engineEpoch: caller.engineEpoch,
    assertAvailable() { if (!db.db.open) throw new Error('Closed fixture profile') },
    assertOwners(actual) { for (const key of Object.keys(owners) as Array<keyof TaskSourceOwners>) if (actual[key] !== owners[key]) throw new Error('Wrong source owner') },
    isTrustedDesktop: identity => identity.webviewId === 'main' && identity.origin === caller.origin,
    canAccessProject: () => true, canAccessTask: () => true, canAccessSource: () => true, canAccessMcpServer: () => true, canAccessConnector: () => true,
    canUseSourcePlugin: id => !!plugins.get(id), emit: (operation, payload) => { events.push({ operation, payload }) }, onFatalEvent: vi.fn() }
  backend = new TaskSourceBackend(options)
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  for (const release of gates) release()
  for (const bridge of bridges) bridge.stopPolling()
  await backend.close(); await sync.close(); for (const bridge of bridges) await bridge.close()
  await oauth.close(); await automation.close(); await recurrence.close(); await heartbeat.close(); await manager.stopAllSessions()
  for (const credential of credentials) credential.close()
  setTaskSchedulers({ recurrence: null, heartbeat: null }); setTaskAutomationTrigger(null)
  const root = dirname(dirname(db.getWorkspaceDir('fixture')))
  db.close(); releaseSecretStorage(storage); storage.dispose(); configureSecretStorage(priorStorage); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks()
})
async function call<K extends TaskSourceOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = TASK_SOURCE_CODECS[operation] as TaskSourceCodec<K>
  const result = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
  expect(codec.validateWireResult(result)).toBe(true)
  return codec.decodeResult((result as { defined: boolean; value?: JsonValue }).value)
}
function source(project_id?: string, config: Record<string, unknown> = { owner: 'fixture', repo: 'repo' }) { return db.createTaskSource({ name: 'Fixture', plugin_id: plugin.id, mcp_server_id: null, project_id, config })! }
function task(sourceId: string, title = 'Source task') { return db.createTask({ title, source_id: sourceId, external_id: title })! }
async function live(taskId: string) {
  const owner = db.createAgent({ name: 'Source worker', config: { coding_agent: 'opencode' } })!
  db.updateTask(taskId, { agent_id: owner.id })
  const started = await manager.requestSession(owner.id, taskId)
  expect(started.status).toBe('started'); if (started.status !== 'started') throw new Error('Fixture did not start')
  return started.sessionId
}

describe('actual production task source owner boundary', () => {
  it('creates, filters, updates and deletes actual sources with independent project/read grants and exact missing results', async () => {
    const project = db.createProject({ name: 'Source project' })!, other = db.createProject({ name: 'Other' })!
    const saved = await call('taskSource:create', [{ name: 'Owned', plugin_id: plugin.id, mcp_server_id: null, project_id: project.id, config: { owner: 'fixture', repo: 'repo' } }])
    const foreign = source(other.id)
    options.canAccessProject = (id, _caller, access) => id === project.id && access === 'read'
    expect(await call('taskSource:getAll', [''])).toEqual([saved])
    await expect(call('taskSource:update', [saved.id, { name: 'Denied' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('taskSource:getAll', [other.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canAccessProject = () => true
    expect((await call('taskSource:update', [saved.id, { name: 'Renamed', enabled: false }]))?.name).toBe('Renamed')
    expect(db.getTaskSource(saved.id)?.enabled).toBe(false)
    expect(await call('taskSource:update', ['missing-source', { name: 'Missing' }])).toBeUndefined()
    expect(await call('taskSource:delete', ['missing-source'])).toBe(false)
    expect(await call('taskSource:delete', [saved.id])).toBe(true)
    expect(db.getTaskSource(foreign.id)).toBeDefined()
  })

  it('writes only finite encrypted source credentials, preserves marker ciphertext/checkpoint and masks every reply', async () => {
    plugins.register(new LocalSourcePlugin('notion'))
    const value = '\uFEFFsource-private-雪\nsecond-line'
    const saved = await call('taskSource:create', [{ name: 'Secure Notion', mcp_server_id: null, plugin_id: 'notion', config: { data_source_id: 'database-one', api_token: value } }])
    expect(saved.config).toEqual({ data_source_id: 'database-one', api_token: marker })
    const raw = (db.db.prepare('SELECT config FROM task_sources WHERE id=?').get(saved.id) as { config: string }).config
    expect(raw).not.toContain('source-private'); expect(db.getTaskSource(saved.id)?.config.api_token).toBe(value)
    db.updateTaskSourceLastSynced(saved.id)
    const checkpoint = db.getTaskSource(saved.id)?.last_synced_at
    await call('taskSource:update', [saved.id, { config: { api_token: marker } }])
    expect((db.db.prepare('SELECT config FROM task_sources WHERE id=?').get(saved.id) as { config: string }).config).toBe(raw)
    expect(db.getTaskSource(saved.id)?.last_synced_at).toBe(checkpoint)
    const cipher = JSON.parse(raw).api_token
    await call('taskSource:update', [saved.id, { config: { data_source_id: 'database-two', api_token: marker } }])
    expect(JSON.parse((db.db.prepare('SELECT config FROM task_sources WHERE id=?').get(saved.id) as { config: string }).config).api_token).toBe(cipher)
    expect(db.getTaskSource(saved.id)?.last_synced_at).toBeNull()
    await call('taskSource:update', [saved.id, { config: { api_token: '' } }])
    expect(db.getTaskSource(saved.id)?.config.api_token).toBe('')
    expect((await call('taskSource:getAll', [])).find(row => row.id === saved.id)?.config).toEqual({ data_source_id: 'database-two' })
    await expect(call('taskSource:create', [{ name: 'No saved key', mcp_server_id: null, plugin_id: 'notion', config: { api_token: marker } }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(JSON.stringify(events)).not.toContain('source-private')
  })

  it('keeps unavailable saved-source metadata while refusing native/plugin effects and unknown config writes', async () => {
    const saved = db.createTaskSource({ name: 'Retired', plugin_id: 'retired-plugin', mcp_server_id: null, config: { retained_private: 'private-legacy-value' }, list_tool_args: { token: 'private-legacy-args' } })!
    expect((await call('taskSource:getAll', []))[0].config).toEqual({})
    expect((await call('taskSource:update', [saved.id, { name: 'Retained metadata', enabled: false }]))?.name).toBe('Retained metadata')
    await expect(call('taskSource:sync', [saved.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('taskSource:getUsers', [saved.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const known = source(); options.canUseSourcePlugin = () => false
    await expect(call('taskSource:sync', [known.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('taskSource:update', [known.id, { config: { repo: 'new' } }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(plugin.importTasks).not.toHaveBeenCalled(); expect(db.getTaskSource(saved.id)?.config.retained_private).toBe('private-legacy-value')
  })

  it('performs actual import/export/users/reassignment and respects the existing source-completion policy', async () => {
    const saved = source()
    expect(await call('taskSource:sync', [saved.id])).toEqual({ source_id: saved.id, imported: 1, updated: 0, errors: [] })
    const imported = db.getTaskByExternalId(saved.id, 'remote-one')!
    expect(imported.project_id).toBe(saved.project_id); expect(db.getTaskSource(saved.id)?.last_synced_at).not.toBeNull()
    expect(await call('taskSource:sync', [saved.id])).toEqual({ source_id: saved.id, imported: 0, updated: 1, errors: [] })
    expect(await call('taskSource:getUsers', [saved.id])).toEqual([{ id: 'remote-user', email: 'fixture@example.test', name: 'Fixture User' }])
    db.updateTask(imported.id, { complete_at_source: false })
    await call('taskSource:exportUpdate', [imported.id, { title: 'Export title', status: TaskStatus.Completed, complete_at_source: false }])
    expect(plugin.exportUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: imported.id }), { title: 'Export title' }, expect.any(Object), expect.any(Object))
    expect(await call('taskSource:reassign', [imported.id, ['remote-user'], 'Fixture User'])).toEqual({ success: true })
    expect(db.getTask(imported.id)?.assignee).toBe('Fixture User')
    expect(events.some(event => event.operation === 'task:updated' && (event.payload as { taskId: string }).taskId === imported.id)).toBe(true)
  })

  it('preflights source and every before/after task project scope before network or cascade Stop', async () => {
    const saved = source(), foreign = db.createProject({ name: 'Foreign moved task' })!, item = task(saved.id)
    db.db.prepare('UPDATE tasks SET project_id=? WHERE id=?').run(foreign.id, item.id)
    const active = await live(item.id)
    options.canAccessProject = id => id !== foreign.id
    for (const operation of ['taskSource:sync', 'taskSource:delete'] as const) await expect(call(operation, [saved.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('taskSource:reassign', [item.id, [], ''])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(plugin.importTasks).not.toHaveBeenCalled(); expect(plugin.reassignTask).not.toHaveBeenCalled(); expect(adapter.destroySession).not.toHaveBeenCalled()
    expect(manager.getSession(active)).toBeDefined(); expect(db.getTask(item.id)).toBeDefined()
  })

  it('blocks grouped/coordinator/cross-source descendant cascades and retires exact real owners before normal source deletion', async () => {
    const captainProject = db.createProject({ name: 'Captain guard' })!, captainSource = source(captainProject.id), captain = db.getCoordinatorTask(captainProject.id)!
    expect(captain.role).toBe('captain')
    db.db.prepare('UPDATE tasks SET source_id=? WHERE id=?').run(captainSource.id, captain.id)
    await expect(call('taskSource:delete', [captainSource.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(db.getTask(captain.id)).toBeDefined(); expect(adapter.destroySession).not.toHaveBeenCalled()
    const saved = source(), first = task(saved.id, 'First'), second = task(saved.id, 'Second'), worker = db.createAgent({ name: 'Group worker' })!
    db.updateTask(first.id, { agent_id: worker.id }); db.updateTask(second.id, { agent_id: worker.id })
    const group = db.createTaskGroup({ title: 'Shared work', task_ids: [first.id, second.id], agent_id: worker.id })
    await expect(call('taskSource:delete', [saved.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('taskSource:exportUpdate', [first.id, { title: 'No direct group export' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(adapter.destroySession).not.toHaveBeenCalled(); db.dissolveTaskGroup(group.id)
    const other = source(), child = db.createTask({ title: 'Other source descendant', parent_task_id: first.id, source_id: other.id, external_id: 'child' })!
    await expect(call('taskSource:delete', [saved.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    db.deleteTask(child.id)
    const session = await live(first.id), deleted = vi.spyOn(db, 'deleteTask')
    expect(await call('taskSource:delete', [saved.id])).toBe(true)
    expect(manager.getSession(session)).toBeUndefined(); expect(adapter.destroySession).toHaveBeenCalledWith(session, expect.any(Object))
    expect(deleted).toHaveBeenCalledWith(first.id); expect(deleted).toHaveBeenCalledWith(second.id)
    expect(db.getTask(first.id)).toBeUndefined(); expect(db.getTask(second.id)).toBeUndefined(); expect(db.getTaskSource(other.id)).toBeDefined()
  })

  it('fences new jobs and joins raw import plus its checkpoint before changing the source', async () => {
    const saved = source(), hold = gate(), entered = gate()
    plugin.importTasks.mockImplementationOnce(async (...args) => { entered.release(); await hold.promise; return plugin.importNow(...args) })
    const active = call('taskSource:sync', [saved.id]); await entered.promise
    const mutationOwner = vi.spyOn(sync, 'runSourceMutation')
    const mutation = call('taskSource:update', [saved.id, { config: { repo: 'replacement' } }])
    await vi.waitFor(() => expect(mutationOwner).toHaveBeenCalledOnce())
    expect(db.getTaskSource(saved.id)?.config.repo).toBe('repo')
    await expect(sync.importTasks(saved.id)).rejects.toBeInstanceOf(SourceMutationBusyError)
    hold.release(); expect((await active).imported).toBe(1); await mutation
    expect(db.getTaskByExternalId(saved.id, 'remote-one')?.title).toBe('Imported repo')
    expect(db.getTaskSource(saved.id)?.config.repo).toBe('replacement'); expect(db.getTaskSource(saved.id)?.last_synced_at).toBeNull()
    expect(plugin.importTasks).toHaveBeenCalledOnce()
  })

  it('retains ignored-cancel import through shutdown and persists its accepted task/checkpoint without replay', async () => {
    const saved = source(), hold = gate(), entered = gate(), controller = new AbortController()
    plugin.importTasks.mockImplementationOnce(async (...args) => { entered.release(); await hold.promise; return plugin.importNow(...args) })
    const active = call('taskSource:sync', [saved.id], controller.signal); await entered.promise; controller.abort()
    await expect(backend.close(10)).rejects.toMatchObject({ code: 'TIMEOUT' })
    await expect(sync.close(10)).rejects.toThrow('not finished')
    expect(db.db.open).toBe(true); expect(backend.inflightCount).toBe(1)
    hold.release(); await expect(active).rejects.toMatchObject({ code: 'CANCELLED' }); await backend.close(); await sync.close()
    expect(db.getTaskByExternalId(saved.id, 'remote-one')).toBeDefined(); expect(db.getTaskSource(saved.id)?.last_synced_at).not.toBeNull()
    expect(plugin.importTasks).toHaveBeenCalledOnce(); expect(events.filter(event => event.operation === 'tasks:refresh')).toHaveLength(1)
  })

  it('joins accepted export before source config mutation and keeps the real task lease until the remote call finishes', async () => {
    const saved = source(), item = task(saved.id), hold = gate(), entered = gate()
    plugin.exportUpdate.mockImplementationOnce(async () => { entered.release(); await hold.promise })
    const active = call('taskSource:exportUpdate', [item.id, { title: 'Accepted export' }]); await entered.promise
    await expect(manager.runTaskLifecycleMutation([item.id], async () => db.deleteTask(item.id))).rejects.toThrow('already being updated')
    const mutationOwner = vi.spyOn(sync, 'runSourceMutation')
    const update = call('taskSource:update', [saved.id, { config: { repo: 'after-export' } }])
    await vi.waitFor(() => expect(mutationOwner).toHaveBeenCalledOnce())
    expect(db.getTaskSource(saved.id)?.config.repo).toBe('repo')
    hold.release(); await active; await update
    expect(plugin.exportUpdate).toHaveBeenCalledOnce(); expect(db.getTaskSource(saved.id)?.config.repo).toBe('after-export')
    expect(db.getTask(item.id)).toBeDefined()
  })

  it('retains an accepted Stop but prevents source/task deletion after cancellation before the database effect', async () => {
    const saved = source(), item = task(saved.id); await live(item.id)
    const hold = gate(), entered = gate(), controller = new AbortController()
    adapter.destroySession.mockImplementationOnce(async () => { entered.release(); await hold.promise })
    const active = call('taskSource:delete', [saved.id], controller.signal); await entered.promise; controller.abort()
    await expect(backend.close(10)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(db.db.open).toBe(true); expect(db.getTaskSource(saved.id)).toBeDefined(); expect(db.getTask(item.id)).toBeDefined()
    hold.release(); await expect(active).rejects.toMatchObject({ code: 'CANCELLED' }); await backend.close()
    expect(adapter.destroySession).toHaveBeenCalledOnce(); expect(db.getTaskSource(saved.id)).toBeDefined(); expect(db.getTask(item.id)).toBeDefined()
    expect(events).toEqual([])
  })

  it('keeps the task mutation lease through accepted reassignment/cancellation and rejects competing lifecycle writes', async () => {
    const saved = source(), item = task(saved.id), hold = gate(), entered = gate(), controller = new AbortController()
    plugin.reassignTask.mockImplementationOnce(async () => { entered.release(); await hold.promise; return { success: true } })
    const active = call('taskSource:reassign', [item.id, ['remote-user'], 'Accepted User'], controller.signal); await entered.promise
    await expect(manager.runTaskLifecycleMutation([item.id], async () => db.deleteTask(item.id))).rejects.toThrow('already being updated')
    controller.abort(); await expect(backend.close(10)).rejects.toMatchObject({ code: 'TIMEOUT' })
    hold.release(); await expect(active).rejects.toMatchObject({ code: 'CANCELLED' }); await backend.close()
    expect(db.getTask(item.id)?.assignee).toBe('Accepted User'); expect(plugin.reassignTask).toHaveBeenCalledOnce()
    expect(events.filter(event => event.operation === 'task:updated')).toHaveLength(1)
  })

  it('rejects a foreign raw task binding replacement after accepted remote reassignment without a foreign local write', async () => {
    const saved = source(), other = source(), item = task(saved.id), hold = gate(), entered = gate()
    plugin.reassignTask.mockImplementationOnce(async () => { entered.release(); await hold.promise; return { success: true } })
    const active = call('taskSource:reassign', [item.id, ['remote-user'], 'Must not reach replacement']); await entered.promise
    db.db.prepare('UPDATE tasks SET source_id=?,external_id=? WHERE id=?').run(other.id, 'replacement-external', item.id)
    hold.release(); await expect(active).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(db.getTask(item.id)?.assignee).toBe(''); expect(plugin.reassignTask).toHaveBeenCalledOnce(); expect(events).toEqual([])
  })

  it('rechecks newly imported affected tasks before deletion rather than cascading an unauthorized late row', async () => {
    const saved = source(), hold = gate(), entered = gate()
    plugin.importTasks.mockImplementationOnce(async (...args) => { entered.release(); await hold.promise; return plugin.importNow(...args) })
    const active = sync.importTasks(saved.id); await entered.promise
    const deletion = call('taskSource:delete', [saved.id]); options.canAccessTask = () => false
    hold.release(); await active; await expect(deletion).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(db.getTaskSource(saved.id)).toBeDefined(); expect(db.getTaskByExternalId(saved.id, 'remote-one')).toBeDefined(); expect(adapter.destroySession).not.toHaveBeenCalled()
  })

  it('bounds huge legacy source/task rows before their actual getters and leaves stored bytes untouched', async () => {
    const saved = source(), huge = JSON.stringify({ legacy_private: 'x'.repeat(600_000) })
    db.db.prepare('UPDATE task_sources SET config=? WHERE id=?').run(huge, saved.id)
    const readSource = vi.spyOn(db, 'getTaskSource')
    await expect(call('taskSource:getAll', [])).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    expect(readSource).not.toHaveBeenCalled(); expect((db.db.prepare('SELECT config FROM task_sources WHERE id=?').get(saved.id) as { config: string }).config).toBe(huge)
    db.db.prepare('UPDATE task_sources SET config=? WHERE id=?').run('{}', saved.id)
    const item = task(saved.id); db.db.prepare('UPDATE tasks SET description=? WHERE id=?').run('x'.repeat(600_000), item.id)
    const readTask = vi.spyOn(db, 'getTask')
    await expect(call('taskSource:reassign', [item.id, [], ''])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('taskSource:delete', [saved.id])).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    expect(readTask).not.toHaveBeenCalled(); expect(adapter.destroySession).not.toHaveBeenCalled(); expect(plugin.reassignTask).not.toHaveBeenCalled()
  })

  it('redacts provider failures from DTOs and actual sync diagnostics, and never repeats accepted effects after sink failure', async () => {
    const saved = source()
    plugin.importTasks.mockRejectedValueOnce(new Error('private-provider-secret'))
    expect((await call('taskSource:sync', [saved.id])).errors).toEqual(['Source synchronization reported an error.'])
    const diagnostics = [...vi.mocked(console.error).mock.calls, ...vi.mocked(console.log).mock.calls]
    expect(JSON.stringify(diagnostics)).not.toContain('private-provider-secret')
    plugin.importTasks.mockResolvedValueOnce({ imported: 0, updated: 0, errors: ['private-error-in-result'] })
    db.updateTaskSourceLastSynced(saved.id)
    const checkpoint = db.getTaskSource(saved.id)?.last_synced_at
    expect((await call('taskSource:sync', [saved.id])).errors).toHaveLength(1)
    expect(db.getTaskSource(saved.id)?.last_synced_at).toBe(checkpoint)
    expect(JSON.stringify([...vi.mocked(console.error).mock.calls, ...vi.mocked(console.log).mock.calls])).not.toContain('private-error-in-result')
    options.emit = () => { throw new Error('Native sink closed') }
    await expect(call('taskSource:update', [saved.id, { name: 'Accepted once' }])).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(db.getTaskSource(saved.id)?.name).toBe('Accepted once'); expect(options.onFatalEvent).toHaveBeenCalledOnce()
    await expect(call('taskSource:update', [saved.id, { name: 'No replay' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(db.getTaskSource(saved.id)?.name).toBe('Accepted once')
  })

  it('rejects pre-cancelled/stale/foreign calls and lost actual owner identities before effects', async () => {
    const saved = source(), controller = new AbortController(); controller.abort()
    await expect(call('taskSource:sync', [saved.id], controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(call('taskSource:sync', [saved.id], undefined, { ...caller, engineEpoch: 'stale' })).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    await expect(call('taskSource:sync', [saved.id], undefined, { ...caller, origin: 'foreign://source' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(plugin.importTasks).not.toHaveBeenCalled()
    expect(() => new TaskSourceBackend({ ...options, sync: new SyncManager(db, new PluginRegistry(), oauth) })).toThrow('owner')
    setTaskAutomationTrigger(null); expect(() => new TaskSourceBackend(options)).toThrow('owners')
  })

  it('shares the real connector background/manual source fence and preserves durable cursor state across owner reconstruction', async () => {
    // Rebuild the actual sync/registry owner before polling begins, as startup
    // does. Only the allowlisted piece call is a controlled local fixture.
    await backend.close(); await sync.close()
    const store = new ConnectorStore(db), credential = new ConnectorCredentialStore(store); credentials.push(credential)
    const instance = store.createInstance({ pieceName: '@activepieces/piece-trello', pieceVersion: '0.6.0' })
    credential.set(instance.id, { type: 'basic', username: 'fixture-key', password: 'fixture-token' })
    const hold = gate(), entered = gate(), run = vi.fn(async () => { entered.release(); await hold.promise; return { cards: [{ id: 'card-one', name: 'Background card', closed: false }] } })
    const bridge = new ConnectorBridgeCore({ runtime: () => ({ store, credentials: credential, client: { call: run } }) }); bridges.push(bridge)
    plugins.register(bridge); sync = new SyncManager(db, plugins, oauth); manager.setSyncManager(sync)
    options.sync = sync; options.assertOwners = actual => { if (actual.database !== db || actual.manager !== manager || actual.sync !== sync || actual.plugins !== plugins || actual.oauth !== oauth || actual.secretStorage !== storage) throw new Error('Wrong actual source owner') }
    backend = new TaskSourceBackend(options)
    const saved = await call('taskSource:create', [{ name: 'Trello', plugin_id: bridge.id, mcp_server_id: null, config: { piece_name: instance.pieceName, connector_instance_id: instance.id, props: { board_id: 'board-one' }, poll_interval_minutes: 15 } }])
    const observe = vi.spyOn(bridge.engineFor(db), 'sync'), mutationOwner = vi.spyOn(sync, 'runSourceMutation')
    let checkpoint: unknown
    bridge.startPolling({ db, tickMs: 60_000, onSynced: () => { checkpoint = structuredClone(store.getSyncState(instance.id)?.cursor) } })
    await entered.promise
    const update = call('taskSource:update', [saved.id, { config: { props: { board_id: 'board-two' } } }])
    await vi.waitFor(() => expect(mutationOwner).toHaveBeenCalledOnce())
    await expect(sync.importTasks(saved.id)).rejects.toBeInstanceOf(SourceMutationBusyError)
    hold.release(); await update; bridge.stopPolling()
    expect(observe).toHaveBeenCalledWith(saved.id, expect.any(Object), expect.any(Object), { manual: false })
    expect(run).toHaveBeenCalledOnce(); expect(db.getTaskByExternalId(saved.id, 'card-one')?.title).toBe('Background card')
    expect(readCursor(store.getSyncState(instance.id)?.cursor).lastRunAt).toBeGreaterThan(0)
    expect(store.getSyncState(instance.id)?.cursor).toEqual(checkpoint)
    const reconstructedStore = new ConnectorStore(db)
    expect(reconstructedStore.getSyncState(instance.id)?.cursor).toEqual(checkpoint)
    expect(db.getTaskSource(saved.id)?.config.props).toEqual({ board_id: 'board-two' })
    expect(credential.getStorage(instance.id)).toBe('persistent')
    expect(JSON.stringify(events)).not.toMatch(/fixture-token|fixture-key/)
  })

  it('preserves the legacy timer-before-sync construction order while refusing a second lifecycle owner', async () => {
    const store = new ConnectorStore(db), credential = new ConnectorCredentialStore(store); credentials.push(credential)
    const instance = store.createInstance({ pieceName: '@activepieces/piece-trello', pieceVersion: '0.6.0' })
    credential.set(instance.id, { type: 'basic', username: 'fixture-key', password: 'fixture-token' })
    const run = vi.fn(async () => ({ cards: [] })), onSynced = vi.fn()
    const bridge = new ConnectorBridgeCore({ runtime: () => ({ store, credentials: credential, client: { call: run } }) }); bridges.push(bridge)
    plugins.register(bridge)
    const saved = db.createTaskSource({ name: 'Legacy timer order', plugin_id: bridge.id, mcp_server_id: null, config: { piece_name: instance.pieceName, connector_instance_id: instance.id, props: { board_id: 'board-one' }, poll_interval_minutes: '15' } })!
    bridge.startPolling({ db, tickMs: 60_000, onSynced })
    const owner = new SyncManager(db, plugins, oauth), admitted = vi.spyOn(owner, 'runSourceWork')
    try {
      await vi.waitFor(() => expect(onSynced).toHaveBeenCalledOnce())
      expect(admitted).toHaveBeenCalledWith(saved.id, expect.any(Function)); expect(run).toHaveBeenCalledOnce()
      expect(() => new SyncManager(db, plugins, oauth)).toThrow('lifecycle owner')
    } finally { bridge.stopPolling(); await owner.close() }
  })
})
