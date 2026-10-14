import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { open, readFile, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from '../main/agent-manager-core'
import { WorkspaceFileOwner, type WorkspaceFileHandle } from '../main/workspace-file-owner'
import { TaskStatus } from '../renderer/src/types'
import { PROJECT_RUNTIME_CODECS, PROJECT_RUNTIME_OPERATIONS, type ProjectRuntimeCodec, type ProjectRuntimeOperation } from '../shared/project-runtime-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import type { DesktopCallerContext } from './transport/desktop-registry'
import { ProjectRuntimeBackend, type ProjectRuntimeBackendOptions } from './project-runtime-backend'

const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'project-runtime-test', webviewId: 'main', origin: 'app://project-runtime' }
let db: ReturnType<typeof createPortableTestDb>, manager: AgentManager, files: WorkspaceFileOwner, backend: ProjectRuntimeBackend, options: ProjectRuntimeBackendOptions, root: string, workspaceRoot: string, adapter: FakeAdapter
let projectId: string, agentId: string, ownerValid: boolean, globalRead: boolean, globalWrite: boolean, projectRead: Set<string> | null, projectWrite: Set<string> | null, taskRead: Set<string> | null, agentRead: Set<string> | null, agentWrite: Set<string> | null
let afterOpen: ((path: string) => Promise<void>) | null, handles: FileHandle[], releases: Array<() => void>
function held() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
beforeEach(() => {
  db = createPortableTestDb(); workspaceRoot = dirname(db.getWorkspaceDir('fixture')); root = dirname(workspaceRoot); adapter = new FakeAdapter()
  manager = new AgentManager(db, { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => adapter, isCodexAppServerAdapter: () => false })
  projectId = db.getDefaultProject()!.id; db.ensureCoordinatorTask(projectId); agentId = db.createAgent({ name: 'Actual projection agent', config: { coding_agent: 'opencode', concurrency_cap: 2, max_parallel_sessions: 2 } })!.id
  ownerValid = globalRead = globalWrite = true; projectRead = projectWrite = taskRead = agentRead = agentWrite = null; afterOpen = null; handles = []; releases = []
  files = new WorkspaceFileOwner({ workspaceRoot, assertCurrent() { if (!ownerValid || !db.db.open) throw new ServiceProtocolError('DISCONNECTED') }, fs: { open: async (path, flags): Promise<WorkspaceFileHandle> => { const handle = await open(path, flags); handles.push(handle); await afterOpen?.(path); return { stat: () => handle.stat({ bigint: true }), read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position), close: () => handle.close() } } } })
  options = { database: db, manager, files, workspaceRoot, engineEpoch: caller.engineEpoch, assertAvailable() { if (!ownerValid || !db.db.open) throw new ServiceProtocolError('DISCONNECTED') }, assertProjectRuntimeOwners(actual) { if (actual.database !== db || actual.manager !== manager || actual.files !== files || actual.workspaceRoot !== workspaceRoot || !ownerValid) throw new ServiceProtocolError('DISCONNECTED') }, isTrustedDesktop: value => value.origin === caller.origin && value.webviewId === caller.webviewId, canManageGlobalConfiguration: (_caller, access) => access === 'read' ? globalRead : globalWrite, canAccessProject: (id, _caller, access) => { const grants = access === 'read' ? projectRead : projectWrite; return grants === null || grants.has(id) }, canAccessTask: id => taskRead === null || taskRead.has(id), canAccessAgent: (id, _caller, access) => { const grants = access === 'read' ? agentRead : agentWrite; return grants === null || grants.has(id) } }
  backend = new ProjectRuntimeBackend(options)
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  for (const release of releases) release(); ownerValid = true; projectRead = projectWrite = taskRead = agentRead = agentWrite = null; globalRead = globalWrite = true
  vi.restoreAllMocks(); await backend.close(); await files.close()
  // Malformed fixture rows have already been asserted preserved. Restore only
  // invalid JSON before the unrelated legacy manager teardown deserializers.
  db.db.prepare("UPDATE tasks SET next_subtask_ids='[]' WHERE NOT json_valid(next_subtask_ids)").run()
  db.db.prepare("UPDATE agents SET config='{}' WHERE NOT json_valid(config)").run()
  db.db.prepare("UPDATE projects SET settings='{}' WHERE NOT json_valid(settings)").run()
  await manager.stopAllSessions(); await manager.stopServer(); if (db.db.open) db.close(); await rm(root, { recursive: true, force: true })
})
async function call<K extends ProjectRuntimeOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = PROJECT_RUNTIME_CODECS[operation] as ProjectRuntimeCodec<K>, result = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
  expect(codec.validateWireResult(result)).toBe(true); return codec.decodeResult((result as { value?: JsonValue }).value)
}
function task(title: string, status = TaskStatus.NotStarted) { const value = db.createTask({ title, project_id: projectId })!; db.updateTask(value.id, { status, agent_id: agentId }); return value }
async function memory(content: string) { const captain = db.getCoordinatorTask(projectId)!, path = join(db.getWorkspaceDir(captain.id), 'MEMORY.md'); await writeFile(path, content); return { captain, path } }

describe('project runtime bindings borrowing actual SQLite/manager/filesystem owners', () => {
  it('registers ten existing operations and reads actual counts, narrative, limits and overview without full deserializers', async () => {
    expect(Object.keys(backend.operationSchemas(caller))).toEqual([...PROJECT_RUNTIME_OPERATIONS])
    task('Running', TaskStatus.AgentWorking); task('Review', TaskStatus.ReadyForReview)
    const blocked = db.createTask({ title: 'Blocked', project_id: projectId })!
    db.recordProjectStatus(projectId, { summary: 'Captain reports delivery', blockers: ['Approval needed'] })
    db.db.prepare('UPDATE tasks SET output_fields=?,attachments=? WHERE id=?').run('unrelated malformed output', 'unrelated malformed attachment', blocked.id)
    const fullTasks = vi.spyOn(db, 'getTasks').mockImplementation(() => { throw new Error('Full task deserialize forbidden') }), fullTask = vi.spyOn(db, 'getTask').mockImplementation(() => { throw new Error('Full task deserialize forbidden') }), fullAgents = vi.spyOn(db, 'getAgent').mockImplementation(() => { throw new Error('Full credential deserialize forbidden') })
    const status = await call('project:getStatus', [projectId]); expect(status).toMatchObject({ summary: 'Captain reports delivery', counts: { running: 1, awaiting_review: 1, blocked: 1 }, limits: { projectId, paused: false } })
    const all = await call('project:getAllStatuses', []); expect(all.find(row => row.project_id === projectId)).toMatchObject({ name: 'Default', needs_attention: true, status: { counts: { running: 1 } } })
    expect(await call('projectLimits:getState', [projectId])).toMatchObject({ runningAgents: 0, queued: [] }); expect(await call('concurrency:getState', [projectId])).toMatchObject({ agents: [{ agentId, cap: 2, level: 1 }] })
    expect(fullTasks).not.toHaveBeenCalled(); expect(fullTask).not.toHaveBeenCalled(); expect(fullAgents).not.toHaveBeenCalled()
    expect(JSON.stringify(all)).not.toContain('malformed')
  })
  it('uses real live session and queue facts and returns only public queue summaries', async () => {
    db.updateProject(projectId, { settings: { concurrency: { captain_control: false, levels: {}, pinned: {} } } }); db.updateAgent(agentId, { config: { coding_agent: 'opencode', concurrency_cap: 1, max_parallel_sessions: 1 } })
    const first = task('Live first'), second = task('Queued second'), outcome = await manager.requestSession(agentId, first.id)
    expect(outcome.status).toBe('started'); if (!('sessionId' in outcome)) throw new Error('Missing actual fixture session')
    const session = manager.getSession(outcome.sessionId)!; session.status = 'waiting_approval'
    const queued = await manager.requestSession(agentId, second.id); expect(queued.status).toBe('queued')
    db.db.prepare("UPDATE agent_start_queue SET last_error='saved-secret-private-error' WHERE task_id=?").run(second.id)
    const state = await call('projectLimits:getState', [projectId]); expect(state.runningAgents).toBe(1); expect(state.queued).toHaveLength(1); expect(Object.keys(state.queued[0]!)).toEqual(['taskId', 'agentId', 'reason', 'queuedAt', 'position'])
    const status = await call('project:getStatus', [projectId]); expect(status.counts.awaiting_approval).toBe(1); expect(status.counts.queued).toBe(1); expect(JSON.stringify(status)).not.toContain('saved-secret')
    const concurrency = await call('concurrency:getState', [projectId]); expect(concurrency.agents[0]).toMatchObject({ runningInProject: 1, runningTotal: 1, queuedInProject: 1 })
  })
  it('preserves history paging/recovery sources and current global pause through real manager writes', async () => {
    for (const summary of ['First', 'Second']) db.recordProjectStatus(projectId, { summary, decisions: ['Keep original decisions'] })
    db.appendProjectStatusJournal(projectId, { summary: 'Recovery preserved', decisions: ['Keep original decisions'] }, { source: 'system_recovery' })
    const page = await call('project:getStatusHistory', [projectId, { limit: 2 }]); expect(page.entries).toHaveLength(2); expect(page.has_more).toBe(true); expect(page.next_cursor).not.toBeNull()
    const tail = await call('project:getStatusHistory', [projectId, { limit: 2, cursor: page.next_cursor }]); expect(tail.entries).toHaveLength(1); expect(new Set([...page.entries, ...tail.entries].map(entry => entry.id)).size).toBe(3)
    expect([...page.entries, ...tail.entries].find(entry => entry.summary === 'Recovery preserved')?.source).toBe('system_recovery')
    await expect(call('project:getStatusHistory', [projectId, { cursor: 'malformed-cursor' }])).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(await call('projectLimits:pauseAll', [true])).toBe(true); expect(db.getSetting('all_projects_paused')).toBe('1'); expect(await call('projectLimits:isAllPaused', [])).toBe(true)
    expect(await call('projectLimits:pauseAll', [false])).toBe(false); expect(db.getSetting('all_projects_paused')).toBe('0')
  })
  it('uses actual concurrency pin/control writes, caps, audit and scheduling without reading agent credentials', async () => {
    task('Selected agent task'); db.db.prepare('UPDATE agents SET config=? WHERE id=?').run(JSON.stringify({ concurrency_cap: 2, max_parallel_sessions: 2, api_keys: { openai: 'retained-private-key' } }), agentId)
    const deserialize = vi.spyOn(db, 'getAgent').mockImplementation(() => { throw new Error('Secret must not deserialize') })
    expect(await call('concurrency:pin', [projectId, agentId, 2])).toEqual({ success: true }); expect(await call('concurrency:pin', [projectId, agentId, 3])).toHaveProperty('error')
    expect(await call('concurrency:setCaptainControl', [projectId, false])).toEqual({ success: true }); expect(await call('concurrency:pin', [projectId, agentId, null])).toEqual({ success: true })
    const state = await call('concurrency:getState', [projectId]); expect(state.captainControl).toBe(false); expect(state.agents[0]).toMatchObject({ agentId, source: 'cap', level: 2 }); expect(state.recentChanges.map(row => row.kind)).toEqual(['unpin', 'control_off', 'pin'])
    expect(deserialize).not.toHaveBeenCalled(); expect(JSON.stringify(state)).not.toContain('retained-private-key'); expect(db.listConcurrencyAudit(projectId)).toHaveLength(3)
  })
  it('requires every current global project grant including archived projects and exact pin agent write permission', async () => {
    const foreign = db.createProject({ name: 'Foreign archived project' })!; db.archiveProject(foreign.id)
    projectRead = new Set([projectId]); await expect(call('project:getAllStatuses', [])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); await expect(call('projectLimits:isAllPaused', [])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    projectRead = null; projectWrite = new Set([projectId]); await expect(call('projectLimits:pauseAll', [true])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(db.getSetting('all_projects_paused')).not.toBe('1')
    projectWrite = null; globalWrite = false; await expect(call('projectLimits:pauseAll', [true])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); globalWrite = true
    agentWrite = new Set(); await expect(call('concurrency:pin', [projectId, agentId, 1])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(db.listConcurrencyAudit(projectId)).toEqual([])
    await expect(call('project:getStatus', [projectId], undefined, { ...caller, engineEpoch: 'old' })).rejects.toMatchObject({ code: 'STALE_EPOCH' }); await expect(call('project:getStatus', [projectId], undefined, { ...caller, origin: 'https://foreign.example' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(() => new ProjectRuntimeBackend({ ...options, manager: Object.create(AgentManager.prototype) as AgentManager })).toThrow('service is unavailable')
  })
  it('reads only literal Captain memory, preserves terminology/truncation and refuses symlink disclosure', async () => {
    const value = await memory('  Captain notes 🦀\nKeep original choices.  ')
    expect(await call('project:getCaptainMemory', [projectId])).toEqual({ path: value.path, content: 'Captain notes 🦀\nKeep original choices.', truncated: false })
    await writeFile(value.path, 'Large actual memory prefix\n' + 'x'.repeat(160000))
    const large = await call('project:getCaptainMemory', [projectId]); expect(large!.content).toHaveLength(12000); expect(large!.content.startsWith('Large actual memory prefix')).toBe(true); expect(large!.truncated).toBe(true)
    await writeFile(value.path, 'x'.repeat(11999) + '🦀'); expect(await call('project:getCaptainMemory', [projectId])).toEqual({ path: value.path, content: 'x'.repeat(11999), truncated: true })
    taskRead = new Set(); await expect(call('project:getCaptainMemory', [projectId])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); taskRead = null
    await rm(value.path); const privatePath = join(root, 'private-file'); await writeFile(privatePath, 'Private preserved bytes'); await symlink(privatePath, value.path)
    await expect(call('project:getCaptainMemory', [projectId])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(await readFile(privatePath, 'utf8')).toBe('Private preserved bytes')
  })
  it('keeps project-only history/memory reads independent of unrelated foreign queue records', async () => {
    const value = await memory('Only selected project memory'), foreign = db.createProject({ name: 'Foreign queued work' })!, foreignTask = db.createTask({ title: 'Foreign task', project_id: foreign.id })!
    db.db.prepare("INSERT INTO agent_start_queue(id,task_id,project_id,agent_id,priority,fifo_seq,admission_reason,state,created_at,queued_at,updated_at) VALUES(?,?,?,?,?,?,'agent_limit','queued',?,?,?)").run('foreign-queue', foreignTask.id, foreign.id, agentId, 'medium', 1, Date.now(), Date.now(), Date.now())
    projectRead = new Set([projectId]); taskRead = new Set([value.captain.id]); const queue = vi.spyOn(manager, 'getStartQueue').mockImplementation(() => { throw new Error('Foreign queue materialization forbidden') })
    expect(await call('project:getCaptainMemory', [projectId])).toEqual({ path: value.path, content: 'Only selected project memory', truncated: false }); expect(await call('project:getStatusHistory', [projectId])).toEqual({ entries: [], has_more: false, next_cursor: null }); expect(queue).not.toHaveBeenCalled()
  })
  it('preserves null Captain and missing/empty memory semantics without creating a read-only workspace', async () => {
    const captain = db.getCoordinatorTask(projectId)!, path = join(workspaceRoot, captain.id, 'MEMORY.md')
    const createDirectory = vi.spyOn(files, 'getWorkspaceDir')
    expect(await call('project:getCaptainMemory', [projectId])).toEqual({ path, content: '', truncated: false }); expect(createDirectory).not.toHaveBeenCalled()
    const value = await memory(''); expect(await call('project:getCaptainMemory', [projectId])).toEqual({ path: value.path, content: '', truncated: false })
    db.db.prepare('DELETE FROM tasks WHERE id=?').run(captain.id); expect(await call('project:getCaptainMemory', [projectId])).toBeNull()
  })
  it.each(['task', 'project', 'agent', 'session', 'repository', 'owner'])('fences %s replacement/withdrawal after accepted actual memory open', async kind => {
    const value = await memory('Preserved actual memory'), gate = held(), entered = held(); releases.push(gate.release); afterOpen = async path => { if (path === value.path) { entered.release(); await gate.promise } }
    const pending = call('project:getCaptainMemory', [projectId]), failed = pending.catch(error => error); await entered.promise
    if (kind === 'task') taskRead = new Set()
    if (kind === 'project') projectRead = new Set()
    if (kind === 'agent') { db.updateProject(projectId, { captain_agent_id: agentId }); agentRead = new Set() }
    if (kind === 'session') db.db.prepare('UPDATE tasks SET session_id=? WHERE id=?').run('replacement-session', value.captain.id)
    if (kind === 'repository') db.addProjectRepo(projectId, { provider: 'github', org: 'changed', name: 'repository' })
    if (kind === 'owner') ownerValid = false
    gate.release(); expect(await failed).toMatchObject({ code: kind === 'owner' ? 'DISCONNECTED' : 'INVALID_REQUEST' }); expect(handles.every(handle => handle.fd === -1)).toBe(true); expect(await readFile(value.path, 'utf8')).toBe('Preserved actual memory')
  })
  it('retains accepted actual memory reads and descriptors through abort and public shutdown timeout', async () => {
    const value = await memory('Raw receipt stays owned'), gate = held(), entered = held(), controller = new AbortController(); releases.push(gate.release); afterOpen = async path => { if (path === value.path) { entered.release(); await gate.promise } }
    const pending = call('project:getCaptainMemory', [projectId], controller.signal), failed = pending.catch(error => error); await entered.promise; controller.abort()
    await expect(backend.close(5)).rejects.toMatchObject({ code: 'TIMEOUT' }); expect(backend.inflightCount).toBeGreaterThan(0); expect(handles[0]!.fd).not.toBe(-1); expect(db.db.open).toBe(true)
    gate.release(); expect(await failed).toMatchObject({ code: 'CANCELLED' }); await backend.close(); expect(handles[0]!.fd).toBe(-1)
  })
  it('bounds sixteen accepted actual memory reads and preserves the borrowed shared filesystem owner after domain drain', async () => {
    const value = await memory('Finite owned reads'), gate = held(), entered = held(); releases.push(gate.release); let opened = 0
    afterOpen = async path => { if (path === value.path) { if (++opened === 16) entered.release(); await gate.promise } }
    const pending = Array.from({ length: 16 }, () => call('project:getCaptainMemory', [projectId]).catch(error => error)); await entered.promise
    await expect(call('project:getCaptainMemory', [projectId])).rejects.toMatchObject({ code: 'BACKPRESSURE' }); expect(handles).toHaveLength(16)
    backend.shutdown(); gate.release(); for (const result of await Promise.all(pending)) expect(result).toMatchObject({ code: 'CANCELLED' }); await backend.close(); expect(handles.every(handle => handle.fd === -1)).toBe(true)
    // Domain close must not globally fence the shared workspace control owner.
    expect(await files.readTextFile(value.captain.id, value.path, { beforeEffect() {}, signal: new AbortController().signal })).toEqual({ content: 'Finite owned reads', size: 18 })
  })
  it('refuses unknown durable admission reasons instead of exporting raw saved error material', async () => {
    const value = task('Private durable queue reason')
    db.db.prepare("INSERT INTO agent_start_queue(id,task_id,project_id,agent_id,priority,fifo_seq,admission_reason,state,created_at,queued_at,updated_at) VALUES(?,?,?,?,?,?,'saved-private-token-reason','queued',?,?,?)").run('invalid-reason', value.id, projectId, agentId, 'medium', 1, Date.now(), Date.now(), Date.now())
    const materialize = vi.spyOn(manager, 'getStartQueue')
    await expect(call('projectLimits:getState', [projectId])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(materialize).not.toHaveBeenCalled()
    expect((db.db.prepare('SELECT admission_reason FROM agent_start_queue WHERE task_id=?').get(value.id) as { admission_reason: string }).admission_reason).toBe('saved-private-token-reason')
  })
  it.each(['settings', 'task-json', 'status', 'history', 'agent-config', 'queue'])('preflights oversized %s before core deserialization/materialization without altering retained data', async kind => {
    const value = task('Bounded task'), oversized = 'x'.repeat(70000)
    let operation: ProjectRuntimeOperation = 'project:getStatus'
    const args: unknown[] = [projectId]
    if (kind === 'settings') db.db.prepare('UPDATE projects SET settings=? WHERE id=?').run(oversized, projectId)
    if (kind === 'task-json') db.db.prepare('UPDATE tasks SET next_subtask_ids=? WHERE id=?').run(oversized, value.id)
    if (kind === 'status') { db.recordProjectStatus(projectId, { summary: 'Original' }); db.db.prepare('UPDATE project_status SET top_blockers=? WHERE project_id=?').run(oversized, projectId) }
    if (kind === 'history') { db.recordProjectStatus(projectId, { summary: 'Original' }); db.db.prepare('UPDATE project_status_journal SET decisions=? WHERE project_id=?').run(oversized, projectId); operation = 'project:getStatusHistory' }
    if (kind === 'agent-config') { db.db.prepare('UPDATE agents SET config=? WHERE id=?').run(oversized, agentId); operation = 'concurrency:getState' }
    if (kind === 'queue') { db.db.prepare("INSERT INTO agent_start_queue(id,task_id,project_id,agent_id,priority,fifo_seq,admission_reason,state,created_at,queued_at,updated_at,last_error) VALUES(?,?,?,?,?,?,'agent_limit','queued',?,?,?,?)").run('bounded-queue', value.id, projectId, agentId, 'medium', 1, Date.now(), Date.now(), Date.now(), oversized); operation = 'projectLimits:getState' }
    const codec = PROJECT_RUNTIME_CODECS[operation] as ProjectRuntimeCodec<ProjectRuntimeOperation>, parse = vi.spyOn(JSON, 'parse')
    await expect(backend.registry.invoke(operation, codec.encodeArguments(args as never), caller, new AbortController().signal)).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' }); expect(parse).not.toHaveBeenCalledWith(oversized)
    if (kind === 'settings') expect((db.db.prepare('SELECT settings FROM projects WHERE id=?').get(projectId) as { settings: string }).settings).toBe(oversized)
  })
})
