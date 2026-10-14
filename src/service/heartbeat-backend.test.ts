import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dirname, join } from 'node:path'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from '../main/agent-manager-core'
import type { AgentManagerHost } from '../main/agent-manager/host'
import { HeartbeatFileOwner } from '../main/heartbeat-file-owner'
import { HeartbeatSchedulerCore } from '../main/heartbeat-scheduler-core'
import { TaskGroupService } from '../main/task-groups/service'
import { SyncManager } from '../main/sync-manager'
import { PluginRegistry } from '../main/plugins/registry'
import { OAuthManager } from '../main/oauth/oauth-manager-core'
import { HEARTBEAT_CODECS, HEARTBEAT_EVENT_CODECS, type HeartbeatCodec, type HeartbeatOperation } from '../shared/heartbeat-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import type { JsonValue } from '../shared/service-protocol'
import type { DesktopCallerContext } from './transport/desktop-registry'
import { HeartbeatBackend, assertHeartbeatTaskEffects, captureHeartbeatTaskEffects, type HeartbeatBackendOptions, type HeartbeatTaskAuthority } from './heartbeat-backend'

vi.mock('../main/agent-manager/workspace-docs', async original => ({ ...await original<typeof import('../main/agent-manager/workspace-docs')>(), writeSkillFiles: vi.fn(async () => undefined) }))
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'heartbeat-epoch', webviewId: 'main', origin: 'app://heartbeat' }
let db: ReturnType<typeof createPortableTestDb>, manager: AgentManager, adapter: FakeAdapter, scheduler: HeartbeatSchedulerCore, files: HeartbeatFileOwner
let options: HeartbeatBackendOptions, backend: HeartbeatBackend, workspaceRoot: string, releases: Array<() => void>, system: HeartbeatTaskAuthority
let sync: SyncManager, oauth: OAuthManager, groups: TaskGroupService
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); releases.push(release); return { promise, release } }
beforeEach(() => {
  releases = []; db = createPortableTestDb(); workspaceRoot = dirname(db.getWorkspaceDir('owner-proof')); mkdirSync(workspaceRoot, { recursive: true })
  adapter = new FakeAdapter()
  const host: AgentManagerHost = { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => adapter, isCodexAppServerAdapter: () => false }
  manager = new AgentManager(db, host)
  const plugins = new PluginRegistry(); oauth = new OAuthManager(db, { openExternal: async () => { throw new Error('Fixture has no browser') }, notify: () => {} }); sync = new SyncManager(db, plugins, oauth); manager.setSyncManager(sync); groups = new TaskGroupService(db, manager, sync)
  files = new HeartbeatFileOwner({ workspaceRoot, assertCurrent: () => { if (!db.db.open) throw new Error('Profile closed') } })
  system = { database: db, manager, assertAvailable: () => { if (!db.db.open) throw new Error('Profile closed') }, canAccessTask: () => true, canAccessProject: () => true, canAccessAgent: () => true, canAccessSkill: () => true, canAccessSecret: () => true, canAccessMcpServer: () => true, canAccessSource: () => true, canAccessConnector: () => true }
  scheduler = new HeartbeatSchedulerCore(db, manager, { fileOwner: files, beforeTaskEffect: id => assertHeartbeatTaskEffects(system, id, caller), captureTaskBinding: id => captureHeartbeatTaskEffects(system, id, caller), preflightTask: async () => 'no_changes' })
  options = { ...system, heartbeat: scheduler, files, workspaceRoot, engineEpoch: caller.engineEpoch,
    isTrustedDesktop: identity => identity.webviewId === caller.webviewId && identity.origin === caller.origin,
    assertHeartbeatOwners(actual) { if (actual.database !== db || actual.manager !== manager || actual.heartbeat !== scheduler || actual.files !== files || actual.workspaceRoot !== workspaceRoot) throw new Error('Foreign heartbeat owner') } }
  backend = new HeartbeatBackend(options)
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  for (const release of releases) release()
  await backend.close(); await scheduler.close(); await files.close(); await groups.close(); await manager.stopAllSessions(); await sync.close(); await oauth.close()
  db.close(); rmSync(dirname(workspaceRoot), { recursive: true, force: true }); vi.useRealTimers(); vi.restoreAllMocks()
})
function task(assigned = true) {
  const agent = db.createAgent({ name: 'Owned heartbeat agent', is_default: true, config: { coding_agent: 'opencode', model: 'controlled-fixture' } })!
  const project = db.createProject({ name: 'Heartbeat project' })!
  const task = db.createTask({ title: 'Verify the shipped change', description: 'Read current PR checks.', project_id: project.id, status: 'ready_for_review' })!
  if (assigned) db.updateTask(task.id, { agent_id: agent.id })
  return { task: db.getTask(task.id)!, agent, project }
}
async function call<K extends HeartbeatOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = HEARTBEAT_CODECS[operation] as HeartbeatCodec<K>, wire = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
  expect(codec.validateWireResult(wire)).toBe(true)
  return codec.decodeResult((wire as { value?: JsonValue }).value)
}

// Observe the complete real guarded startup without replacing adapter or owner work.
async function admitted(taskId: string, signal?: AbortSignal): Promise<unknown> {
  let settled = false, failure: unknown, result: unknown
  void call('heartbeat:runNow', [taskId], signal).then(value => { result = value; settled = true }, cause => { failure = cause; settled = true })
  await vi.waitFor(() => expect(settled).toBe(true), { timeout: 15000, interval: 20 })
  if (failure) throw failure
  return result
}
describe('actual SQLite/scheduler heartbeat controls', () => {
  it('runs all eight controls and preserves missing/header-only file semantics without a model turn', async () => {
    const h = task()
    expect(await call('heartbeat:readFile', [h.task.id])).toBeNull()
    expect(await call('heartbeat:runNow', [h.task.id])).toBe('no_file')
    expect(await call('heartbeat:writeFile', [h.task.id, '# Checks\n'])).toBe(true)
    expect(await call('heartbeat:readFile', [h.task.id])).toBeNull()
    expect(await call('heartbeat:writeFile', [h.task.id, '# Checks\nCheck the latest CI status 🚀'])).toBe(true)
    expect(await call('heartbeat:readFile', [h.task.id])).toBe('# Checks\nCheck the latest CI status 🚀')
    expect((await call('heartbeat:enable', [h.task.id, 30]) as { heartbeat_enabled: boolean }).heartbeat_enabled).toBe(true)
    expect((await call('heartbeat:updateInterval', [h.task.id, 120]) as { heartbeat_interval_minutes: number }).heartbeat_interval_minutes).toBe(120)
    expect(await call('heartbeat:getStatus', [h.task.id])).toMatchObject({ enabled: true, intervalMinutes: 120, hasHeartbeatFile: true, lastCheckAt: null })
    db.createHeartbeatLog({ task_id: h.task.id, status: 'info', summary: 'Approval recorded; no changes requested.', session_id: null })
    expect(await call('heartbeat:getLogs', [h.task.id])).toEqual([expect.objectContaining({ summary: 'Approval recorded; no changes requested.' })])
    expect((await call('heartbeat:disable', [h.task.id]) as { heartbeat_enabled: boolean }).heartbeat_enabled).toBe(false)
    expect(adapter.createSession).not.toHaveBeenCalled(); expect(adapter.sendPrompt).not.toHaveBeenCalled()
    expect(await call('heartbeat:getStatus', ['missing_task'])).toBeNull(); expect(await call('heartbeat:getLogs', ['missing_task'])).toEqual([])
  })
  it('checks distinct read/write grants, epoch, actual owners and coordinator protection before writes', async () => {
    const h = task(); options.canAccessTask = (_id, _caller, access) => access === 'read'
    expect(await call('heartbeat:getStatus', [h.task.id])).toMatchObject({ enabled: false })
    await expect(call('heartbeat:enable', [h.task.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canAccessTask = () => true; options.canAccessProject = () => false
    await expect(call('heartbeat:writeFile', [h.task.id, 'new'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('heartbeat:getStatus', [h.task.id], undefined, { ...caller, engineEpoch: 'foreign' })).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    options.canAccessProject = () => true
    const captain = (db.db.prepare("SELECT id FROM tasks WHERE project_id=? AND role='captain'").get(h.project.id) as { id: string }).id
    await expect(call('heartbeat:enable', [captain])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(() => scheduler.assertOwners({ database: db, manager, files, workspaceRoot: dirname(workspaceRoot) })).toThrow('HEARTBEAT_FILE_INVALID')
    expect(db.getTask(h.task.id)?.heartbeat_enabled).toBe(false)
  })
  it('checks actual anchor/current/former workspace grants and never aliases member files', async () => {
    const h = task(), other = db.createTask({ title: 'Second member', project_id: h.project.id })!, former = db.createTask({ title: 'Former member', project_id: h.project.id })!
    for (const id of [other.id, former.id]) db.updateTask(id, { agent_id: h.agent.id })
    // Group eligibility requires pending ordinary rows; use actual service.
    db.updateTask(h.task.id, { status: 'not_started' })
    const group = await groups.create({ title: 'Small related changes', task_ids: [h.task.id, other.id, former.id] })
    await groups.remove(group.id, former.id)
    files.writeFile(h.task.id, 'Member literal instructions'); files.writeFile(group.execution_task_id, 'Anchor literal instructions')
    expect(await call('heartbeat:readFile', [h.task.id])).toBe('Member literal instructions')
    options.canAccessTask = id => id !== group.execution_task_id
    await expect(call('heartbeat:readFile', [h.task.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canAccessTask = id => id !== former.id
    await expect(call('heartbeat:readFile', [group.execution_task_id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canAccessTask = () => true
    await expect(call('heartbeat:enable', [h.task.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(readFileSync(join(workspaceRoot, group.execution_task_id, 'heartbeat.md'), 'utf8')).toBe('Anchor literal instructions')
  })
  it('preflights huge saved task/log rows before getters and keeps legacy bytes intact', async () => {
    const h = task(), huge = 'x'.repeat(2_000_000)
    db.db.prepare('UPDATE tasks SET description=? WHERE id=?').run(huge, h.task.id)
    const getter = vi.spyOn(db, 'getTask'), logs = vi.spyOn(db, 'getHeartbeatLogs')
    await expect(call('heartbeat:getStatus', [h.task.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(getter).not.toHaveBeenCalled()
    db.db.prepare('UPDATE tasks SET description=? WHERE id=?').run('bounded instructions', h.task.id)
    db.createHeartbeatLog({ task_id: h.task.id, status: 'info', summary: huge, session_id: null })
    await expect(call('heartbeat:getLogs', [h.task.id])).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' }); expect(logs).not.toHaveBeenCalled()
    expect((db.db.prepare('SELECT length(summary) AS bytes FROM heartbeat_logs WHERE task_id=?').get(h.task.id) as { bytes: number }).bytes).toBe(huge.length)
  })
  it('uses selected/fallback resource grants and scalar defaults without decrypting unrelated agents', async () => {
    const h = task(false), foreign = db.createAgent({ name: 'Unrelated huge protected config', config: {} })!
    db.db.prepare('UPDATE agents SET config=? WHERE id=?').run(JSON.stringify({ api_keys: { openai: 'x'.repeat(2_000_000) } }), foreign.id)
    const all = vi.spyOn(db, 'getAgents'); expect(await call('heartbeat:runNow', [h.task.id])).toBe('no_file'); expect(all).not.toHaveBeenCalled()
    db.updateAgent(h.agent.id, { config: { coding_agent: 'opencode', secret_ids: ['missing-secret'] } }); options.canAccessSecret = () => false
    await expect(call('heartbeat:runNow', [h.task.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(adapter.createSession).not.toHaveBeenCalled()
  })
  it('retains raw adapter initialization through cancelled backend close and refuses late creation/send', async () => {
    const h = task(), held = gate(), entered = gate(), controller = new AbortController()
    await call('heartbeat:writeFile', [h.task.id, 'Check current state'])
    adapter.initialize.mockImplementation(async () => { entered.release(); await held.promise })
    const pending = call('heartbeat:runNow', [h.task.id], controller.signal).catch(cause => cause)
    await entered.promise; controller.abort()
    await expect(backend.close(10)).rejects.toMatchObject({ code: 'TIMEOUT' }); expect(backend.inflightCount).toBe(1)
    held.release(); await pending; await backend.close()
    expect(adapter.createSession).not.toHaveBeenCalled(); expect(adapter.sendPrompt).not.toHaveBeenCalled(); expect(db.getHeartbeatLogs(h.task.id)).toEqual([])
  })
  it('runs periodic preflight with the same owned file and bounded SQL selection', async () => {
    const h = task(false); await call('heartbeat:writeFile', [h.task.id, 'Check owned instructions'])
    await call('heartbeat:enable', [h.task.id, 60]); db.updateTask(h.task.id, { heartbeat_next_check_at: new Date(Date.now() - 1000).toISOString() })
    const broadTasks = vi.spyOn(db, 'getHeartbeatDueTasks'), broadAgents = vi.spyOn(db, 'getAgents'), read = vi.spyOn(files, 'readFile')
    scheduler.start()
    await vi.waitFor(() => expect(db.getHeartbeatLogs(h.task.id)).toEqual([expect.objectContaining({ status: 'ok', summary: 'Pre-flight: no changes detected (LLM skipped)' })]))
    expect(read).toHaveBeenCalledWith(h.task.id, expect.any(Function)); expect(broadTasks).not.toHaveBeenCalled(); expect(broadAgents).not.toHaveBeenCalled(); expect(adapter.createSession).not.toHaveBeenCalled()
    await scheduler.close()
  })
  it('rejects a completed inherited scheduler request without reusing its current grants', async () => {
    const h = task(), later = gate(), completed = gate()
    let inherited!: Promise<unknown>
    await scheduler.withRequestGuard(async () => {
      inherited = later.promise.then(() => scheduler.writeHeartbeatFile(h.task.id, 'late callback')).catch(cause => cause)
      completed.release(); return undefined
    }, () => assertHeartbeatTaskEffects(options, h.task.id, caller), new AbortController().signal)
    await completed.promise; later.release()
    expect((await inherited as Error).message).toBe('HEARTBEAT_REQUEST_CANCELLED')
    expect(await call('heartbeat:readFile', [h.task.id])).toBeNull()
  })
  it('keeps accepted monitoring detached from the settled caller and owned through application shutdown', async () => {
    const h = task(), controller = new AbortController()
    await call('heartbeat:writeFile', [h.task.id, 'Check the fixture'])
    expect(await admitted(h.task.id, controller.signal)).toBe('sent')
    expect(db.db.prepare('SELECT task_id,state FROM delivery_outbox WHERE kind=?').all('agent_message')).toEqual([{ task_id: h.task.id, state: 'acknowledged' }])
    controller.abort(); await backend.close()
    expect(scheduler.inflightCount).toBeGreaterThan(0)
    expect(scheduler.hasTaskOwnership(h.task.id)).toBe(true)
    const assistant = vi.spyOn(manager, 'getLastAssistantMessage').mockReturnValue('HEARTBEAT_INFO: Review was approved; no adjustment is needed.')
    vi.spyOn(manager, 'getSession').mockReturnValue({ status: 'idle' } as never)
    await vi.waitFor(() => expect(db.getHeartbeatLogs(h.task.id)).toEqual([expect.objectContaining({ status: 'info', summary: 'Review was approved; no adjustment is needed.' })]), { timeout: 4000 })
    expect(assistant).toHaveBeenCalled(); expect(adapter.sendPrompt).toHaveBeenCalledTimes(1)
    await scheduler.close(); expect(scheduler.inflightCount).toBe(0); expect(scheduler.hasTaskOwnership(h.task.id)).toBe(false)
  }, 20000)
  it('refuses stale accepted findings after task reassignment while joining exact session cleanup', async () => {
    const h = task(); await call('heartbeat:writeFile', [h.task.id, 'Check state'])
    expect(await admitted(h.task.id)).toBe('sent')
    const replacement = db.createAgent({ name: 'Replacement', config: { coding_agent: 'opencode' } })!
    db.updateTask(h.task.id, { agent_id: replacement.id })
    vi.spyOn(manager, 'getSession').mockReturnValue({ status: 'idle' } as never); vi.spyOn(manager, 'getLastAssistantMessage').mockReturnValue('Action needed on stale work')
    const forward = vi.spyOn(manager, 'startHeartbeatSession'), cleanup = vi.spyOn(manager, 'cleanupHeartbeatSession')
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledWith(h.task.id, true), { timeout: 4000 })
    expect(forward).not.toHaveBeenCalled(); expect(db.getHeartbeatLogs(h.task.id)).toEqual([])
  }, 20000)
  it('retains uncertain accepted send cleanup and blocks duplicate sends until acknowledgement', async () => {
    const h = task(), held = gate(), entered = gate()
    await call('heartbeat:writeFile', [h.task.id, 'Check state'])
    const originalSend = manager.sendHeartbeatViaCaptain.bind(manager), originalCleanup = manager.cleanupHeartbeatSession.bind(manager)
    vi.spyOn(manager, 'sendHeartbeatViaCaptain').mockImplementation(async (...args) => { const id = await originalSend(...args); options.canAccessTask = () => false; return id })
    vi.spyOn(manager, 'cleanupHeartbeatSession').mockImplementation(async (...args) => { entered.release(); await held.promise; await originalCleanup(...args) })
    const pending = call('heartbeat:runNow', [h.task.id]).catch(cause => cause)
    await entered.promise; await expect(backend.close(10)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(scheduler.inflightCount).toBeGreaterThan(0); expect(adapter.sendPrompt).toHaveBeenCalledTimes(1)
    held.release(); await pending; await backend.close(); expect(db.getHeartbeatLogs(h.task.id)).toEqual([])
  }, 20000)
  it('preserves failed acknowledgement receipt for explicit shutdown retry and emits bounded genuine summaries', async () => {
    const h = task(); await call('heartbeat:writeFile', [h.task.id, 'Check state'])
    const original = manager.cleanupHeartbeatSession.bind(manager)
    const cleanup = vi.spyOn(manager, 'cleanupHeartbeatSession').mockRejectedValueOnce(new Error('private cleanup failure'))
    expect(await admitted(h.task.id)).toBe('sent')
    vi.spyOn(manager, 'getSession').mockReturnValue({ status: 'idle' } as never); vi.spyOn(manager, 'getLastAssistantMessage').mockReturnValue('HEARTBEAT_OK')
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce(), { timeout: 4000 })
    expect(scheduler.hasTaskOwnership(h.task.id)).toBe(true)
    expect(await call('heartbeat:runNow', [h.task.id])).toBe('in_progress')
    cleanup.mockImplementation(original); await scheduler.close(); expect(cleanup).toHaveBeenLastCalledWith(h.task.id, true); expect(scheduler.inflightCount).toBe(0); expect(scheduler.hasTaskOwnership(h.task.id)).toBe(false)
    const alert = { taskId: h.task.id, title: h.task.title, summary: 'Check the newly failed CI job.' }
    expect(HEARTBEAT_EVENT_CODECS['heartbeat:alert'].decodePayload(HEARTBEAT_EVENT_CODECS['heartbeat:alert'].encodePayload(alert))).toEqual(alert)
  }, 20000)
})
