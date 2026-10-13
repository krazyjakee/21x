import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from '../main/agent-manager-core'
import type { AgentManagerHost } from '../main/agent-manager/host'
import { RecurrenceSchedulerCore } from '../main/recurrence-scheduler-core'
import { HeartbeatSchedulerCore } from '../main/heartbeat-scheduler-core'
import { TaskAutomationScheduler } from '../main/task-automation-scheduler'
import { SyncManager } from '../main/sync-manager'
import { PluginRegistry } from '../main/plugins/registry'
import type { ActionResult, TaskSourcePlugin } from '../main/plugins/types'
import { setTaskAutomationTrigger, setTaskSchedulers } from '../main/task-updates'
import { projectEvents } from '../main/project-events'
import { TaskStatus, PluginActionId } from '../shared/constants'
import { TaskLifecycleBackend, type TaskLifecycleBackendOptions } from './task-lifecycle-backend'
import { TASK_LIFECYCLE_CODECS, type TaskLifecycleCodec, type TaskLifecycleOperation } from '../shared/task-lifecycle-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import type { DesktopCallerContext } from './transport/desktop-registry'
import type { JsonValue } from '../shared/service-protocol'

let db: ReturnType<typeof createPortableTestDb>
let manager: AgentManager
let adapter: FakeAdapter
let recurrence: RecurrenceSchedulerCore
let heartbeat: HeartbeatSchedulerCore
let automation: TaskAutomationScheduler
let sync: SyncManager
let backend: TaskLifecycleBackend
let options: TaskLifecycleBackendOptions
let events: Array<{ operation: string; payload: JsonValue }>
let plugin: TaskSourcePlugin
let execute: ReturnType<typeof vi.fn<TaskSourcePlugin['executeAction']>>
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'task-epoch', webviewId: 'main', origin: 'app://tasks' }
beforeEach(() => {
  db = createPortableTestDb(); adapter = new FakeAdapter(); events = []
  const host: AgentManagerHost = { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' },
    configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => adapter, isCodexAppServerAdapter: () => false }
  manager = new AgentManager(db, host)
  recurrence = new RecurrenceSchedulerCore(db, 'UTC'); heartbeat = new HeartbeatSchedulerCore(db, manager); automation = new TaskAutomationScheduler(db, manager)
  setTaskSchedulers({ recurrence, heartbeat }); setTaskAutomationTrigger(() => { void automation.runNow() }, automation)
  const registry = new PluginRegistry()
  execute = vi.fn(async (): Promise<ActionResult> => ({ success: true, taskUpdate: { status: TaskStatus.Completed } }))
  plugin = { id: 'controlled-source', displayName: 'Controlled source', description: 'Fixture only', icon: 'test', getConfigSchema: () => [],
    getActions: () => [{ id: PluginActionId.Complete, label: 'Complete' }], resolveOptions: async () => [], importTasks: async () => ({ imported: 0, updated: 0, errors: [] }), exportUpdate: async () => {}, executeAction: execute }
  registry.register(plugin); sync = new SyncManager(db, registry)
  options = { database: db, manager, sync, registry, recurrence, heartbeat, automation, engineEpoch: caller.engineEpoch,
    assertAvailable() { if (!db.db.open) throw new Error('Closed profile') }, isTrustedDesktop: value => value.webviewId === 'main' && value.origin === caller.origin,
    canAccessTask: () => true, canAccessProject: () => true, canAccessAgent: () => true, canAccessSource: () => true,
    emit(operation, payload) { events.push({ operation, payload }) }, onFatalEvent: vi.fn() }
  backend = new TaskLifecycleBackend(options)
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  await backend.close(); await automation.close(); await recurrence.close(); await heartbeat.close(); await sync.close(); await manager.stopAllSessions()
  setTaskSchedulers({ recurrence: null, heartbeat: null }); setTaskAutomationTrigger(null)
  const root = dirname(dirname(db.getWorkspaceDir('cleanup-fixture')))
  db.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks()
})
async function call<K extends TaskLifecycleOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = TASK_LIFECYCLE_CODECS[operation] as TaskLifecycleCodec<K>
  const result = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
  expect(codec.validateWireResult(result)).toBe(true)
  return codec.decodeResult((result as { defined: boolean; value?: JsonValue }).value)
}
function agent(name = 'Task owner') { return db.createAgent({ name, config: { coding_agent: 'opencode' } })! }
async function live(taskId: string, agentId: string) {
  db.updateTask(taskId, { agent_id: agentId })
  const result = await manager.requestSession(agentId, taskId)
  expect(result.status).toBe('started')
  if (result.status !== 'started') throw new Error('Fixture task did not start')
  return result.sessionId
}
function sourced() {
  const source = db.createTaskSource({ name: 'Source', mcp_server_id: null, plugin_id: plugin.id, config: { private_token: 'source-private-token' } })!
  const task = db.createTask({ title: 'Source work', source: 'Controlled source', source_id: source.id, external_id: 'external-one', status: TaskStatus.ReadyForReview })!
  return { source, task }
}
describe('actual owner task lifecycle bindings', () => {
  it('persists complete public task data and invokes the real recurrence owner', async () => {
    const task = await call('db:createTask', [{ title: 'Recurring work', description: 'Full description', type: 'coding', priority: 'high', is_recurring: true,
      recurrence_pattern: '0 9 * * 1', due_date: '2026-11-01', labels: ['weekly'], output_fields: [{ id: 'notes', name: 'Notes', type: 'text', value: { nested: ['kept'] } }], complete_at_source: false }])
    expect(task).toMatchObject({ is_recurring: true, recurrence_pattern: '0 9 * * 1', complete_at_source: false, role: 'task' })
    expect(task.next_occurrence_at).not.toBeNull()
    expect(await call('db:getTask', [task.id])).toEqual(task)
    expect(events.filter(event => event.operation === 'task:created')).toHaveLength(1)
    const updated = await call('db:updateTask', [task.id, { snoozed_until: '2026-11-01T10:00:00Z', resolution: 'Deferred', labels: ['later'], recurrence_pattern: '0 10 * * 1' }])
    expect(updated).toMatchObject({ snoozed_until: '2026-11-01T10:00:00Z', resolution: 'Deferred', recurrence_pattern: '0 10 * * 1' })
    expect(updated?.next_occurrence_at).not.toEqual(task.next_occurrence_at)
  })

  it('uses actual admission for requested execution and acknowledges Stop for nonexecution moves', async () => {
    const owner = agent()
    const task = await call('db:createTask', [{ title: 'Explicit start', status: TaskStatus.AgentWorking }])
    expect(task.status).toBe(TaskStatus.Triaging)
    const current = manager.findSessionByTaskId(task.id)!
    expect(current.session.agentId).toBe(owner.id)
    expect(adapter.createSession).toHaveBeenCalledOnce()
    expect((await call('db:updateTask', [task.id, { status: TaskStatus.NotStarted }]))?.status).toBe(TaskStatus.NotStarted)
    expect(manager.findSessionByTaskId(task.id)).toBeUndefined()
    expect(adapter.destroySession).toHaveBeenCalledWith(current.sessionId, expect.any(Object))
  })

  it('stops the previous actual owner before assignment changes without starting replacement work', async () => {
    const oldOwner = agent(), nextOwner = agent('Replacement')
    const task = db.createTask({ title: 'Reassign work' })!
    const sessionId = await live(task.id, oldOwner.id)
    const updated = await call('db:updateTask', [task.id, { agent_id: nextOwner.id }])
    expect(updated?.agent_id).toBe(nextOwner.id)
    expect(manager.getSession(sessionId)).toBeUndefined(); expect(adapter.destroySession).toHaveBeenCalledWith(sessionId, expect.any(Object))
    expect(adapter.createSession).toHaveBeenCalledOnce()
  })

  it('runs user feedback validation and stores the real completion choice without inventing approval', async () => {
    const owner = agent(), { source, task } = sourced()
    db.updateTask(task.id, { agent_id: owner.id })
    options.canAccessSource = id => id === source.id
    await expect(call('db:updateTask', [task.id, { status: TaskStatus.AgentLearning, feedback_rating: 4 }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const updated = await call('db:updateTask', [task.id, { status: TaskStatus.AgentLearning, feedback_rating: 4, feedback_comment: 'Keep this approach', complete_at_source: false }])
    expect(updated).toMatchObject({ status: TaskStatus.AgentLearning, feedback_rating: 4, complete_at_source: false })
    expect(JSON.parse(db.getSetting(`session-feedback-completion:${task.id}`)!)).toEqual({ completeAtSource: false })
    expect(execute).not.toHaveBeenCalled()
    expect(adapter.sendPrompt).not.toHaveBeenCalled()
  })

  it('requires source acceptance, preserves review on failure, and supports explicit local-only completion', async () => {
    const { source, task } = sourced()
    execute.mockResolvedValueOnce({ success: false, error: 'Controlled source refused completion' })
    const failure = await call('plugin:executeAction', [PluginActionId.Complete, task.id, source.id])
    expect(failure).toEqual({ success: false, error: 'Controlled source refused completion' })
    expect(db.getTask(task.id)?.status).toBe(TaskStatus.ReadyForReview)
    await expect(call('db:updateTask', [task.id, { status: TaskStatus.Completed, complete_at_source: true }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(execute).toHaveBeenCalledOnce()
    const result = await call('plugin:executeAction', [PluginActionId.Complete, task.id, source.id])
    expect(result).toMatchObject({ success: true, taskUpdate: { status: TaskStatus.Completed } })
    expect(db.getTask(task.id)?.status).toBe(TaskStatus.Completed)
    const manual = sourced()
    expect((await call('db:updateTask', [manual.task.id, { status: TaskStatus.Completed, complete_at_source: false }]))?.status).toBe(TaskStatus.Completed)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(events)).not.toContain('source-private-token')
  })

  it('keeps cancelled accepted source work owned until drain and never replays it', async () => {
    const { source, task } = sourced()
    let release!: (value: ActionResult) => void, entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const pending = new Promise<ActionResult>(resolve => { release = resolve })
    execute.mockImplementationOnce(async () => { entered(); return pending })
    const abort = new AbortController()
    const flight = call('plugin:executeAction', [PluginActionId.Complete, task.id, source.id], abort.signal)
    await started; abort.abort()
    await expect(backend.close(20)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(backend.inflightCount).toBe(1); expect(db.db.open).toBe(true)
    release({ success: true, taskUpdate: { status: TaskStatus.Completed } })
    await expect(flight).rejects.toMatchObject({ code: 'CANCELLED' })
    await backend.close()
    expect(backend.inflightCount).toBe(0); expect(execute).toHaveBeenCalledOnce()
    expect(db.getTask(task.id)?.status).toBe(TaskStatus.Completed)
    expect(events.some(event => event.operation === 'task:updated')).toBe(true)
    await expect(call('db:getTasks', [])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('checks exact source and destination references before stopping an actual live owner', async () => {
    const owner = agent(), { source, task } = sourced()
    const session = await live(task.id, owner.id)
    const otherSource = db.createTaskSource({ name: 'Other source', mcp_server_id: null, plugin_id: plugin.id })!
    await expect(call('plugin:executeAction', ['unlisted-action', task.id, source.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('plugin:executeAction', [PluginActionId.Complete, task.id, otherSource.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canAccessSource = () => false
    await expect(call('plugin:executeAction', [PluginActionId.Complete, task.id, source.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(execute).not.toHaveBeenCalled(); expect(adapter.destroySession).not.toHaveBeenCalled(); expect(manager.getSession(session)).toBeDefined()
    const otherProject = db.createProject({ name: 'Other scope' })!, parent = db.createTask({ title: 'Scoped parent' })!
    await expect(call('db:createTask', [{ title: 'Conflicting parent scope', parent_task_id: parent.id, project_id: otherProject.id }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const skill = db.createSkill({ name: 'Foreign skill', description: '', content: 'Scoped content', project_id: otherProject.id })!
    await expect(call('db:updateTask', [parent.id, { skill_ids: [skill.id] }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(db.getTask(parent.id)?.skill_ids).toBeNull()
  })

  it('orders only exact current children and emits correlated subtree updates', async () => {
    const parent = await call('db:createTask', [{ title: 'Parent' }])
    const first = await call('db:createTask', [{ title: 'First', parent_task_id: parent.id }])
    const second = await call('db:createTask', [{ title: 'Second', parent_task_id: parent.id }])
    await expect(call('db:reorderSubtasks', [parent.id, [first.id]])).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(await call('db:reorderSubtasks', [parent.id, [second.id, first.id]])).toBe(true)
    expect((await call('db:getSubtasks', [parent.id])).map(task => task.id)).toEqual([second.id, first.id])
    expect(events.find(event => event.operation === 'task:subtasks-reordered')?.payload).toEqual({ parentId: parent.id, orderedIds: [second.id, first.id] })
    await call('db:updateTask', [first.id, { next_subtask_ids: [second.id] }])
    await expect(call('db:updateTask', [parent.id, { status: TaskStatus.Completed }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await call('db:updateTask', [first.id, { status: TaskStatus.ReadyForReview }]); await call('db:updateTask', [second.id, { status: TaskStatus.ReadyForReview }])
    heartbeat.enableHeartbeat(first.id)
    expect((await call('db:updateTask', [parent.id, { status: TaskStatus.Completed }]))?.status).toBe(TaskStatus.Completed)
    expect(db.getTask(first.id)?.heartbeat_enabled).toBe(false)
  })

  it('raises the real project review event and preserves subtask successor guards', async () => {
    const parent = db.createTask({ title: 'Parent' })!, child = db.createTask({ title: 'Child', parent_task_id: parent.id })!
    const foreign = db.createTask({ title: 'Foreign root' })!
    await expect(call('db:updateTask', [child.id, { next_subtask_ids: [foreign.id] }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const onReview = vi.fn(), remove = projectEvents.onEvent(onReview)
    try { await call('db:updateTask', [child.id, { status: TaskStatus.ReadyForReview }]) }
    finally { remove() }
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ kind: 'task_ready_for_review', taskId: child.id, projectId: child.project_id }))
  })

  it('uses the actual heartbeat owner and preflights the default execution agent', async () => {
    const task = db.createTask({ title: 'Heartbeat work' })!
    expect((await call('db:updateTask', [task.id, { heartbeat_enabled: true, heartbeat_interval_minutes: 15 }]))?.heartbeat_interval_minutes).toBe(15)
    expect(db.getTask(task.id)?.heartbeat_next_check_at).not.toBeNull()
    expect((await call('db:updateTask', [task.id, { heartbeat_enabled: false }]))?.heartbeat_enabled).toBe(false)
    expect(db.getTask(task.id)?.heartbeat_next_check_at).toBeNull()
    agent()
    options.canAccessAgent = () => false
    await expect(call('db:createTask', [{ title: 'Denied default owner', status: TaskStatus.AgentWorking }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(adapter.createSession).not.toHaveBeenCalled()
    expect(db.getTasks().map(task => task.title)).toEqual(['Heartbeat work'])
  })

  it('preflights every affected task and both projects before owned Stop or subtree moves', async () => {
    const owner = agent(), destination = db.createProject({ name: 'Destination' })!
    const parent = db.createTask({ title: 'Moving root' })!, child = db.createTask({ title: 'Nested task', parent_task_id: parent.id })!
    const session = await live(child.id, owner.id)
    options.canAccessProject = id => id !== destination.id
    await expect(call('project:moveTask', [parent.id, destination.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(manager.getSession(session)).toBeDefined(); expect(adapter.destroySession).not.toHaveBeenCalled()
    options.canAccessProject = () => true; options.canAccessTask = id => id !== child.id
    await expect(call('db:deleteTask', [parent.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(adapter.destroySession).not.toHaveBeenCalled()
    options.canAccessTask = () => true
    const moved = await call('project:moveTask', [parent.id, destination.id])
    expect(moved?.map(task => task.project_id)).toEqual([destination.id, destination.id])
    expect(manager.getSession(session)).toBeUndefined()
    expect(adapter.destroySession).toHaveBeenCalledWith(session, expect.any(Object))
  })

  it('acknowledges descendants and queues before deletion and cleans every owned attachment/transcript', async () => {
    const owner = agent()
    const child = db.createTask({ title: 'Earlier child' })!, parent = db.createTask({ title: 'Later parent' })!
    db.updateTask(child.id, { parent_task_id: parent.id })
    const session = await live(child.id, owner.id)
    const queued = db.createTask({ title: 'Queued descendant', parent_task_id: parent.id })!; db.updateTask(queued.id, { agent_id: owner.id })
    expect((await manager.requestSession(owner.id, queued.id)).status).toBe('queued')
    const attachment = { id: 'owned-attachment', filename: 'note.txt', size: 4, mime_type: 'text/plain', added_at: new Date().toISOString() }
    const file = join(db.getAttachmentsDir(child.id), `${attachment.id}-${attachment.filename}`)
    writeFileSync(file, 'kept'); db.updateTask(child.id, { attachments: [attachment] }); db.upsertTranscriptParts(child.id, [{ id: 'part', role: 'assistant', content: 'Preserved until delete' }])
    expect(await call('db:deleteTask', [parent.id])).toBe(true)
    expect(db.getTask(parent.id)).toBeUndefined(); expect(db.getTask(child.id)).toBeUndefined(); expect(db.getTask(queued.id)).toBeUndefined()
    expect(manager.getSession(session)).toBeUndefined(); expect(manager.getStartQueue().some(row => row.taskId === queued.id)).toBe(false)
    expect(existsSync(file)).toBe(false); expect(db.getTranscriptParts(child.id)).toEqual([])
    expect(events.filter(event => event.operation === 'task:deleted')).toHaveLength(3)
  })

  it('protects Captain/group rows and rejects unsafe reparenting, references and caller authority', async () => {
    const owner = agent(), first = db.createTask({ title: 'One' })!, second = db.createTask({ title: 'Two' })!
    const group = db.createTaskGroup({ title: 'Shared work', task_ids: [first.id, second.id], agent_id: owner.id })
    const captain = db.ensureCoordinatorTask(first.project_id)!
    await expect(call('db:deleteTask', [captain.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('db:updateTask', [first.id, { status: TaskStatus.Completed }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('db:deleteTask', [group.execution_task_id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const root = db.createTask({ title: 'Root' })!, child = db.createTask({ title: 'Child', parent_task_id: root.id })!
    const foreignProject = db.createProject({ name: 'Other' })!, foreignParent = db.createTask({ title: 'Foreign parent', project_id: foreignProject.id })!
    await expect(call('db:updateTask', [root.id, { parent_task_id: foreignParent.id }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('db:updateTask', [root.id, { parent_task_id: child.id }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('db:updateTask', [root.id, { agent_id: 'missing-agent' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('db:updateTask', [root.id, { skill_ids: ['missing-skill'] }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('db:createTask', [{ title: 'Foreign repository', repos: ['foreign/private'] }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    for (const identity of [{ ...caller, webviewId: 'foreign' }, { ...caller, engineEpoch: 'old' }]) await expect(call('db:createTask', [{ title: 'Forbidden' }], new AbortController().signal, identity)).rejects.toBeDefined()
    expect(adapter.destroySession).not.toHaveBeenCalled()
  })

  it('preserves missing results, rejects pre-cancelled writes and latches accepted invalidation failure', async () => {
    expect(await call('db:getTask', ['missing-task'])).toBeUndefined()
    expect(await call('db:updateTask', ['missing-task', { title: 'Missing' }])).toBeUndefined()
    expect(await call('db:deleteTask', ['missing-task'])).toBe(false)
    const abort = new AbortController(); abort.abort()
    await expect(call('db:createTask', [{ title: 'Cancelled' }], abort.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(db.getTasks()).toEqual([])
    options.emit = () => { throw new Error('Sink disconnected') }
    await expect(call('db:createTask', [{ title: 'Accepted once' }])).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(db.getTasks().map(task => task.title)).toEqual(['Accepted once'])
    expect(options.onFatalEvent).toHaveBeenCalledOnce()
    await expect(call('db:createTask', [{ title: 'Must not replay' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(db.getTasks()).toHaveLength(1)
  })

  it('fails closed when the actual lifecycle owners are not the registered application owners', () => {
    setTaskAutomationTrigger(null)
    expect(() => new TaskLifecycleBackend(options)).toThrow('owners')
  })
})
