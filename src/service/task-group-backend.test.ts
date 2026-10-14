import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dirname } from 'node:path'
import { rmSync } from 'node:fs'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from '../main/agent-manager-core'
import type { AgentManagerHost } from '../main/agent-manager/host'
import { SyncManager } from '../main/sync-manager'
import { PluginRegistry } from '../main/plugins/registry'
import type { ActionResult, TaskSourcePlugin } from '../main/plugins/types'
import { OAuthManager } from '../main/oauth/oauth-manager-core'
import { TaskGroupService } from '../main/task-groups/service'
import { TaskStatus, PluginActionId } from '../shared/constants'
import { SessionStatusType } from '../main/adapters/coding-agent-adapter'
import { TASK_GROUP_CODECS, type TaskGroupCodec, type TaskGroupOperation } from '../shared/task-group-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import type { JsonValue } from '../shared/service-protocol'
import type { DesktopCallerContext } from './transport/desktop-registry'
import { TaskGroupBackend, type TaskGroupBackendOptions } from './task-group-backend'

vi.mock('../main/agent-manager/workspace-docs', async original => ({ ...await original<typeof import('../main/agent-manager/workspace-docs')>(), writeSkillFiles: vi.fn(async () => undefined) }))
let db: ReturnType<typeof createPortableTestDb>, manager: AgentManager, adapter: FakeAdapter, sync: SyncManager, plugins: PluginRegistry, oauth: OAuthManager
let groups: TaskGroupService, backend: TaskGroupBackend, options: TaskGroupBackendOptions, execute: ReturnType<typeof vi.fn<TaskSourcePlugin['executeAction']>>
let gates: Array<() => void>
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'group-epoch', webviewId: 'main', origin: 'app://groups' }
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); gates.push(release); return { promise, release } }
beforeEach(() => {
  gates = []; db = createPortableTestDb(); adapter = new FakeAdapter()
  const host: AgentManagerHost = { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' },
    configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => adapter, isCodexAppServerAdapter: () => false }
  manager = new AgentManager(db, host)
  plugins = new PluginRegistry()
  execute = vi.fn(async (): Promise<ActionResult> => ({ success: true, taskUpdate: { status: TaskStatus.Completed } }))
  const plugin: TaskSourcePlugin = { id: 'controlled-group-source', displayName: 'Controlled group source', description: 'Local fixture only', icon: 'test', getConfigSchema: () => [],
    getActions: () => [{ id: PluginActionId.Complete, label: 'Complete' }], resolveOptions: async () => [], importTasks: async () => ({ imported: 0, updated: 0, errors: [] }), exportUpdate: async () => {}, executeAction: execute }
  plugins.register(plugin)
  oauth = new OAuthManager(db, { openExternal: async () => { throw new Error('Fixture has no native browser') }, notify: () => {} })
  sync = new SyncManager(db, plugins, oauth); manager.setSyncManager(sync)
  groups = new TaskGroupService(db, manager, sync)
  options = { database: db, groups, manager, sync, plugins, oauth, engineEpoch: caller.engineEpoch,
    assertAvailable() { if (!db.db.open) throw new Error('Closed group profile') },
    assertTaskGroupOwners(actual) { if (actual.database !== db || actual.groups !== groups || actual.manager !== manager || actual.sync !== sync || actual.plugins !== plugins || actual.oauth !== oauth) throw new Error('Foreign group owner') },
    isTrustedDesktop: identity => identity.webviewId === 'main' && identity.origin === caller.origin,
    canAccessTask: () => true, canAccessProject: () => true, canAccessAgent: () => true, canAccessSource: () => true, canAccessSkill: () => true,
    canAccessSecret: () => true, canAccessMcpServer: () => true, canAccessConnector: () => true, canUseSourcePlugin: id => !!plugins.get(id) }
  backend = new TaskGroupBackend(options)
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  for (const release of gates) release()
  await backend.close(); await groups.close(); await manager.stopAllSessions(); await sync.close(); await oauth.close()
  const root = dirname(dirname(db.getWorkspaceDir('cleanup')))
  db.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks()
})
async function call<K extends TaskGroupOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = TASK_GROUP_CODECS[operation] as TaskGroupCodec<K>
  const wire = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
  expect(codec.validateWireResult(wire)).toBe(true)
  return codec.decodeResult((wire as { value?: JsonValue }).value)
}
function work(withSource = false) {
  const agent = db.createAgent({ name: 'Actual group owner', config: { coding_agent: 'opencode', model: 'controlled-fixture' } })!
  const project = db.createProject({ name: 'Group project', default_agent_id: agent.id })!
  const source = withSource ? db.createTaskSource({ name: 'Fixture source', plugin_id: 'controlled-group-source', mcp_server_id: null, project_id: project.id })! : undefined
  const members = ['First change', 'Second change', 'Third change'].map((title, index) => {
    const task = db.createTask({ title, description: `Instructions for ${title}`, project_id: project.id, ...(source ? { source_id: source.id, external_id: `source-item-${index}` } : {}) })!
    db.updateTask(task.id, { agent_id: agent.id }); return db.getTask(task.id)!
  })
  return { agent, project, members, source }
}
async function created(withSource = false) {
  const h = work(withSource), group = await call('taskGroups:create', [{ title: 'Shared small changes', task_ids: h.members.slice(0, 2).map(task => task.id) }])
  return { ...h, group }
}
function ready(h: Awaited<ReturnType<typeof created>>) {
  for (const task of h.members.slice(0, 2)) db.updateTask(task.id, { status: TaskStatus.ReadyForReview }, 'task-group')
  db.updateTask(h.group.execution_task_id, { status: TaskStatus.ReadyForReview }, 'task-group')
}

describe('actual retained task group owner bindings', () => {
  it('runs all definition/history/read controls against actual SQLite and preserves former membership', async () => {
    const h = await created()
    expect(await call('taskGroups:list', [h.project.id])).toEqual([h.group])
    expect((await call('taskGroups:get', [h.group.id])).task.id).toBe(h.group.execution_task_id)
    expect(await call('taskGroups:history', [h.members[0].id])).toEqual([h.group])
    const added = await call('taskGroups:add', [h.group.id, [h.members[2].id]])
    expect(added.task_ids).toContain(h.members[2].id)
    const removed = await call('taskGroups:remove', [h.group.id, h.members[0].id])
    expect(removed.former_task_ids).toContain(h.members[0].id)
    expect((await call('taskGroups:get', [h.group.id])).members.map(task => task.id)).toContain(h.members[0].id)
    const dissolved = await call('taskGroups:dissolve', [h.group.id])
    expect(dissolved.state).toBe('dissolved'); expect(dissolved.task_ids).toEqual([])
    expect(await call('taskGroups:list', [h.project.id])).toEqual([])
    expect(await call('taskGroups:list', [h.project.id, true])).toEqual([dissolved])
    expect(db.getTask(h.members[1].id)?.group_id).toBeNull()
  })
  it('distinguishes read/write grants and checks anchor/current/former members, epoch and exact owners', async () => {
    const h = await created()
    options.canAccessTask = (_id, _caller, access) => access === 'read'
    expect(await call('taskGroups:history', [h.members[0].id])).toHaveLength(1)
    await expect(call('taskGroups:remove', [h.group.id, h.members[0].id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canAccessTask = id => id !== h.group.execution_task_id
    await expect(call('taskGroups:list', [h.project.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canAccessTask = () => true
    await call('taskGroups:remove', [h.group.id, h.members[0].id])
    options.canAccessTask = id => id !== h.members[0].id
    await expect(call('taskGroups:get', [h.group.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('taskGroups:get', [h.group.id], undefined, { ...caller, engineEpoch: 'foreign-epoch' })).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    expect(() => groups.assertOwners({ database: db, manager, sync: new SyncManager(db, plugins, oauth) })).toThrow('OWNER_UNAVAILABLE')
  })
  it('refuses huge legacy rows before any group/task getter and preserves stored bytes', async () => {
    const h = await created(), huge = 'x'.repeat(40_000_000)
    db.db.prepare('UPDATE tasks SET description=? WHERE id=?').run(huge, h.group.execution_task_id)
    const getTask = vi.spyOn(db, 'getTask'), getGroup = vi.spyOn(db, 'getTaskGroup')
    await expect(call('taskGroups:get', [h.group.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(getTask).not.toHaveBeenCalled(); expect(getGroup).not.toHaveBeenCalled()
    expect((db.db.prepare('SELECT length(description) AS size FROM tasks WHERE id=?').get(h.group.execution_task_id) as { size: number }).size).toBe(huge.length)
  })
  it('does not deserialize unrelated saved agent credentials to choose a default', async () => {
    const h = work()
    const unrelated = db.createAgent({ name: 'Unrelated', config: {} })!
    db.db.prepare('UPDATE agents SET config=? WHERE id=?').run(JSON.stringify({ api_keys: { openai: 'x'.repeat(2_000_000) } }), unrelated.id)
    const getAgents = vi.spyOn(db, 'getAgents')
    const group = await call('taskGroups:create', [{ title: 'Scoped agent selection', task_ids: h.members.slice(0, 2).map(task => task.id) }])
    expect(group.agent_id).toBe(h.agent.id); expect(getAgents).not.toHaveBeenCalled()
  })
  it('budgets generated anchor growth before retiring or committing added members', async () => {
    const h = await created()
    db.db.prepare('UPDATE tasks SET description=? WHERE id=?').run('x'.repeat(65_000), h.members[2].id)
    const retire = vi.spyOn(manager, 'retireTaskGroupContext')
    await expect(call('taskGroups:add', [h.group.id, [h.members[2].id]])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(retire).not.toHaveBeenCalled()
    expect(db.getTaskGroup(h.group.id)?.task_ids).not.toContain(h.members[2].id)
    expect((db.db.prepare('SELECT length(description) AS size FROM tasks WHERE id=?').get(h.members[2].id) as { size: number }).size).toBe(65_000)
  })
  it('checks configured skills/secrets/MCP and exact source capabilities before starts or source effects', async () => {
    const h = await created(true)
    db.updateAgent(h.agent.id, { config: { coding_agent: 'opencode', secret_ids: ['ungranted-secret'] } })
    options.canAccessSecret = () => false
    await expect(call('taskGroups:move', [h.group.id, TaskStatus.AgentWorking])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(adapter.createSession).not.toHaveBeenCalled()
    ready(h); options.canUseSourcePlugin = () => false
    await expect(call('taskGroups:review', [{ group_id: h.group.id, action: 'approve' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(execute).not.toHaveBeenCalled()
    options.canAccessSource = (_id, _caller, access) => access === 'read'
    const local = await call('taskGroups:review', [{ group_id: h.group.id, action: 'approve', complete_at_source: false }])
    expect(local.completed_task_ids).toHaveLength(2); expect(execute).not.toHaveBeenCalled()
  })
  it('uses actual per-source completion results and returns fixed useful failures', async () => {
    const h = await created(true); ready(h)
    execute.mockImplementation(async (_action, task) => task.id === h.members[0].id ? { success: true, taskUpdate: { status: TaskStatus.Completed } } : { success: false, error: 'private provider token and URL' })
    const result = await call('taskGroups:review', [{ group_id: h.group.id, action: 'approve' }])
    expect(execute).toHaveBeenCalledTimes(2); expect(result.completed_task_ids).toEqual([h.members[0].id])
    expect(result.failures).toEqual([{ task_id: h.members[1].id, message: 'Source completion failed.' }])
    expect(db.getTask(h.members[1].id)?.status).toBe(TaskStatus.ReadyForReview)
    expect(JSON.stringify(result)).not.toContain('private provider')
  })
  it('holds actual group mutation fencing and raw source work through caller cancellation/failed close', async () => {
    const h = await created(true); ready(h)
    const held = gate(), entered = gate(), controller = new AbortController()
    execute.mockImplementation(async () => { entered.release(); await held.promise; return { success: true, taskUpdate: { status: TaskStatus.Completed } } })
    const pending = call('taskGroups:review', [{ group_id: h.group.id, action: 'approve' }], controller.signal).catch(cause => cause)
    await entered.promise
    await expect(manager.runTaskLifecycleMutation([h.members[0].id], async () => true)).rejects.toThrow('already being updated')
    controller.abort(); await expect(backend.close(10)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(backend.inflightCount).toBe(1); expect(db.db.open).toBe(true)
    held.release(); expect((await pending).code).toBe('CANCELLED')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(db.getTask(h.members[0].id)?.status).toBe(TaskStatus.ReadyForReview)
    expect(db.getTask(h.members[1].id)?.status).toBe(TaskStatus.ReadyForReview)
    await backend.close(); expect(backend.inflightCount).toBe(0)
  })
  it('prevents local completion and later members after source bindings or grants change', async () => {
    const h = await created(true); ready(h)
    const held = gate(), entered = gate()
    execute.mockImplementation(async () => { entered.release(); await held.promise; return { success: true, taskUpdate: { status: TaskStatus.Completed } } })
    const pending = call('taskGroups:review', [{ group_id: h.group.id, action: 'approve' }]).catch(cause => cause)
    await entered.promise
    db.db.prepare('UPDATE tasks SET external_id=? WHERE id=?').run('changed-external-owner', h.members[0].id)
    held.release(); expect((await pending).code).toBe('INVALID_REQUEST')
    expect(execute).toHaveBeenCalledTimes(1); expect(db.getTask(h.members[0].id)?.status).toBe(TaskStatus.ReadyForReview)
    const second = await created(true); ready(second)
    const blocked = gate(), accepting = gate()
    execute.mockImplementation(async () => { accepting.release(); await blocked.promise; return { success: true, taskUpdate: { status: TaskStatus.Completed } } })
    const revoked = call('taskGroups:review', [{ group_id: second.group.id, action: 'approve' }]).catch(cause => cause)
    await accepting.promise; options.canAccessSource = () => false; blocked.release()
    expect((await revoked).code).toBe('INVALID_REQUEST'); expect(db.getTask(second.members[0].id)?.status).toBe(TaskStatus.ReadyForReview)
  })
  it('prevents definition writes after acknowledged retirement returns into revoked caller scope', async () => {
    const h = await created(), held = gate(), entered = gate()
    const original = manager.retireTaskGroupContext.bind(manager)
    vi.spyOn(manager, 'retireTaskGroupContext').mockImplementation(async id => { await original(id); entered.release(); await held.promise })
    const pending = call('taskGroups:add', [h.group.id, [h.members[2].id]]).catch(cause => cause)
    await entered.promise; options.canAccessTask = id => id !== h.members[2].id; held.release()
    expect((await pending).code).toBe('INVALID_REQUEST')
    expect(db.getTaskGroup(h.group.id)?.task_ids).not.toContain(h.members[2].id)
    expect(db.getTask(h.members[2].id)?.group_id).toBeNull()
  })
  it('withdraws actual pending Working authority before backend creation or prompt admission', async () => {
    const h = await created(), held = gate(), entered = gate()
    adapter.initialize.mockImplementation(async () => { entered.release(); await held.promise })
    const pending = call('taskGroups:move', [h.group.id, TaskStatus.AgentWorking]).catch(cause => cause)
    await entered.promise
    options.canAccessTask = id => id !== h.group.execution_task_id
    held.release(); expect((await pending).code).toBe('INVALID_REQUEST')
    expect(adapter.createSession).not.toHaveBeenCalled(); expect(adapter.sendPrompt).not.toHaveBeenCalled()
    expect(manager.findSessionByTaskId(h.group.execution_task_id)).toBeUndefined()
  })
  it('routes Working and send-back through actual one-anchor admission and durable send', async () => {
    const h = await created()
    const moving = await call('taskGroups:move', [h.group.id, TaskStatus.AgentWorking])
    expect(moving.status).toBe(TaskStatus.AgentWorking); expect(adapter.createSession).toHaveBeenCalledTimes(1)
    const live = manager.findSessionByTaskId(h.group.execution_task_id)!
    adapter.setStatus(SessionStatusType.IDLE)
    await (manager as unknown as { transitionToIdle(id: string, session: typeof live.session): Promise<void> }).transitionToIdle(live.sessionId, live.session)
    const sent = await call('taskGroups:review', [{ group_id: h.group.id, action: 'send_back', task_ids: [h.members[0].id], message: 'Adjust the first label' }])
    expect(sent.completed_task_ids).toEqual([]); expect(adapter.createSession).toHaveBeenCalledTimes(1)
    expect(adapter.sendPrompt.mock.calls.at(-1)![1][0].text).toContain('Adjust the first label')
    expect(db.getTask(h.members[1].id)?.status).toBe(TaskStatus.ReadyForReview)
    await call('taskGroups:move', [h.group.id, TaskStatus.NotStarted])
    expect(manager.findSessionByTaskId(h.group.execution_task_id)).toBeUndefined()
  })
})
