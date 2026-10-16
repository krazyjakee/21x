import { AGENT_EVENT_CODECS } from '../shared/agent-desktop-codecs'
import { TASK_LIFECYCLE_EVENT_CODECS } from '../shared/task-lifecycle-codecs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { dirname } from 'node:path'
import { rmSync } from 'node:fs'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from './agent-manager-core'
import type { AgentManagerHost } from './agent-manager/host'
import { SessionStatusType } from './adapters/coding-agent-adapter'
import { PRODUCTION_AGENT_EVENT_CODECS, PRODUCTION_INCOMPATIBLE_SESSION_ERROR } from '../shared/production-agent-events'
import { updateTaskFromUser } from './session-feedback'
import { SyncManager } from './sync-manager'
import { PluginRegistry } from './plugins/registry'
import { TASK_FEEDBACK_EVENT_CODECS, TASK_SOURCE_ACTION_ERROR } from '../shared/task-feedback-event-codecs'

vi.mock('./agent-manager/workspace-docs', async original => ({ ...await original<typeof import('./agent-manager/workspace-docs')>(), writeSkillFiles: vi.fn(async () => undefined) }))
const finishers: Array<() => void> = []
const resources: Array<{ db: ReturnType<typeof createPortableTestDb>; manager: AgentManager; directory: string }> = []
beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }))
afterEach(async () => {
  for (const finish of finishers.splice(0)) finish()
  for (const { db, manager, directory } of resources.splice(0)) { await manager.stopAllSessions(); db.close(); rmSync(directory, { recursive: true, force: true }) }
  vi.useRealTimers(); vi.restoreAllMocks()
})
async function fixture() {
  const db = createPortableTestDb()
  const agent = db.createAgent({ name: 'Approval owner', config: { coding_agent: 'pi' } })!
  const task = db.createTask({ title: 'Approval task' })!
  db.updateTask(task.id, { agent_id: agent.id })
  const adapter = Object.assign(new FakeAdapter({ status: SessionStatusType.BUSY, sessionIds: ['current-native'] }), {
    getPendingRequests: vi.fn(async () => [{ requestId: 'current-request', responseType: 'permission' as 'permission' | 'question' }]),
    respondToApproval: vi.fn(async () => true), respondToQuestion: vi.fn(async () => true)
  })
  const host: AgentManagerHost = { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' },
    configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => adapter, isCodexAppServerAdapter: () => false }
  const manager = new AgentManager(db, host), directory = dirname(dirname(db.getWorkspaceDir(task.id)))
  resources.push({ db, manager, directory })
  await manager.requestSession(agent.id, task.id)
  const input = { sessionId: 'current-native', taskId: task.id, agentId: agent.id, requestId: 'current-request', responseType: 'permission' as const, approved: true }
  return { db, manager, adapter, task, agent, input }
}

it('rejects foreign native/task/request identities without replying or sending a continuation', async () => {
  const f = await fixture()
  for (const change of [{ sessionId: 'retired-native' }, { taskId: 'foreign-task' }, { agentId: 'foreign-agent' }, { requestId: 'retired-request' }])
    expect(await f.manager.respondToScopedPermission({ ...f.input, ...change })).toEqual({ handled: false })
  expect(f.adapter.respondToApproval).not.toHaveBeenCalled()
  expect(f.adapter.sendPrompt).toHaveBeenCalledOnce()
})

it('passes the exact pending request to the adapter and reports actual refusal', async () => {
  const f = await fixture()
  f.adapter.respondToApproval.mockResolvedValue(false)
  expect(await f.manager.respondToScopedPermission(f.input)).toEqual({ handled: false })
  expect(f.adapter.respondToApproval).toHaveBeenCalledWith('current-native', true, undefined, 'current-request')
  expect(f.adapter.sendPrompt).toHaveBeenCalledOnce()
})

it('refuses a question acknowledgement withdrawn by an actual Stop while the raw response is retained', async () => {
  const f = await fixture()
  f.adapter.getPendingRequests.mockResolvedValue([{ requestId: 'current-request', responseType: 'question' }])
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }); finishers.push(release)
  f.adapter.respondToQuestion.mockImplementation(async () => { await gate; return true })
  const response = f.manager.respondToScopedPermission({ ...f.input, responseType: 'question', message: 'Accepted text' })
  const rejected = expect(response).rejects.toThrow('stopped this task')
  await vi.waitFor(() => expect(f.adapter.respondToQuestion).toHaveBeenCalledOnce())
  await f.manager.stopByTaskId(f.task.id)
  release(); await rejected
  expect(f.manager.findSessionByTaskId(f.task.id)).toBeUndefined()
  expect(f.db.getTask(f.task.id)?.status).toBe('not_started')
})

it('emits a bounded incompatible notice from actual rejected resume without copying backend diagnostics', async () => {
  const f = await fixture(); await f.manager.stopByTaskId(f.task.id)
  f.db.db.prepare("UPDATE tasks SET session_id='saved-native',status='agent_working' WHERE id=?").run(f.task.id)
  f.adapter.resumeSession.mockRejectedValueOnce(new Error('INCOMPATIBLE_SESSION_ID private token=secret'))
  const events: unknown[] = [], listener = (channel: string, payload: unknown): void => { if (channel === 'agent:incompatible-session') events.push(payload) }
  f.manager.addExternalListener(listener)
  try {
    await expect(f.manager.resumeSession(f.agent.id, f.task.id, 'saved-native')).rejects.toThrow('SESSION_INCOMPATIBLE')
    expect(events).toHaveLength(1)
    const wire = PRODUCTION_AGENT_EVENT_CODECS['agent:incompatible-session'].encodePayload(events[0])
    expect(wire).toEqual({ taskId: f.task.id, agentId: f.agent.id, error: PRODUCTION_INCOMPATIBLE_SESSION_ERROR })
    expect(JSON.stringify(wire)).not.toContain('secret'); expect(f.db.getTask(f.task.id)?.session_id).toBeNull()
  } finally { f.manager.removeExternalListener(listener) }
})

it('preserves a replacement task binding when an older actual resume rejects as incompatible', async () => {
  const f = await fixture(); await f.manager.stopByTaskId(f.task.id)
  f.db.db.prepare("UPDATE tasks SET session_id='saved-native',status='agent_working' WHERE id=?").run(f.task.id)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), accepted = new Promise<void>(resolve => { entered = resolve }); finishers.push(release)
  f.adapter.resumeSession.mockImplementationOnce(async () => { entered(); await gate; throw new Error('INCOMPATIBLE_SESSION_ID') })
  const notice = vi.fn(), listener = (channel: string): void => { if (channel === 'agent:incompatible-session') notice() }
  f.manager.addExternalListener(listener)
  const resume = f.manager.resumeSession(f.agent.id, f.task.id, 'saved-native'), rejected = expect(resume).rejects.toThrow('Resume ownership changed')
  try {
    await accepted; f.db.db.prepare("UPDATE tasks SET session_id='replacement-native' WHERE id=?").run(f.task.id)
    release(); await rejected
    expect(notice).not.toHaveBeenCalled(); expect(f.db.getTask(f.task.id)?.session_id).toBe('replacement-native')
  } finally { release(); await resume.catch(() => {}); f.manager.removeExternalListener(listener) }
})

it.each([true, false])('completes a real registered learning session with source choice %s through actual poll and intent owners', async completeAtSource => {
  const f = await fixture(), registry = new PluginRegistry()
  const executeAction = vi.fn(async () => ({ success: true, taskUpdate: { status: 'completed' } }))
  registry.register({ id: 'owned-feedback-fixture', displayName: 'Owned feedback source', description: 'Disposable controlled source', icon: '',
    getConfigSchema: () => [], resolveOptions: async () => [], getActions: () => [], importTasks: async () => ({ imported: 0, updated: 0, errors: [] }), exportUpdate: async () => {}, executeAction })
  const source = f.db.createTaskSource({ name: 'Current learning source', plugin_id: 'owned-feedback-fixture', mcp_server_id: null, config: {}, project_id: f.task.project_id })!
  f.db.db.prepare('UPDATE tasks SET source_id=? WHERE id=?').run(source.id, f.task.id)
  const sync = new SyncManager(f.db, registry); f.manager.setSyncManager(sync)
  try {
    expect(f.db.getTask(f.task.id)).toMatchObject({ session_id: 'current-native', agent_id: f.agent.id, project_id: f.task.project_id })
    f.adapter.setStatus(SessionStatusType.WAITING_APPROVAL); f.adapter.signalData('current-native')
    await vi.waitFor(() => expect(f.manager.getSessionStatus('current-native')?.status).toBe('waiting_approval'))
    f.adapter.setStatus(SessionStatusType.BUSY); f.adapter.signalData('current-native')
    await vi.waitFor(() => expect(f.manager.getSessionStatus('current-native')?.status).toBe('working'))
    updateTaskFromUser(f.db, f.task.id, { status: 'agent_learning', feedback_rating: 4, complete_at_source: completeAtSource })
    expect(f.db.getSetting(`session-feedback-completion:${f.task.id}`)).toBe(JSON.stringify({ completeAtSource }))
    f.adapter.setStatus(SessionStatusType.IDLE); f.adapter.signalData('current-native')
    await vi.waitFor(() => expect(f.db.getTask(f.task.id)?.status).toBe('completed'))
    expect(f.db.getSetting(`session-feedback-completion:${f.task.id}`)).toBeUndefined()
    expect(f.manager.findSessionByTaskId(f.task.id)?.sessionId).toBe('current-native')
    expect(executeAction).toHaveBeenCalledTimes(completeAtSource ? 1 : 0)
  } finally { await sync.close() }
})

it('emits an actual learning source failure followed by only finite codec-valid persisted status updates', async () => {
  const f = await fixture(), registry = new PluginRegistry()
  registry.register({ id: 'failure-fixture', displayName: 'Failure source', description: 'Controlled failure', icon: '',
    getConfigSchema: () => [], resolveOptions: async () => [], getActions: () => [], importTasks: async () => ({ imported: 0, updated: 0, errors: [] }), exportUpdate: async () => {},
    executeAction: async () => ({ success: false, error: 'Private backend/source response' }) })
  const source = f.db.createTaskSource({ name: 'Failed source', plugin_id: 'failure-fixture', mcp_server_id: null, config: {}, project_id: f.task.project_id })!
  f.db.db.prepare('UPDATE tasks SET source_id=?,title=? WHERE id=?').run(source.id, '🧪'.repeat(180), f.task.id)
  const sync = new SyncManager(f.db, registry); f.manager.setSyncManager(sync)
  const events: Array<{ channel: string; payload: unknown }> = [], listener = (channel: string, payload: unknown): void => { events.push({ channel, payload }) }
  f.manager.addExternalListener(listener)
  try {
    f.adapter.setStatus(SessionStatusType.WAITING_APPROVAL); f.adapter.signalData('current-native')
    await vi.waitFor(() => expect(f.manager.getSessionStatus('current-native')?.status).toBe('waiting_approval'))
    f.adapter.setStatus(SessionStatusType.BUSY); f.adapter.signalData('current-native')
    await vi.waitFor(() => expect(f.manager.getSessionStatus('current-native')?.status).toBe('working'))
    updateTaskFromUser(f.db, f.task.id, { status: 'agent_learning', feedback_rating: 4, complete_at_source: true })
    f.adapter.setStatus(SessionStatusType.IDLE); f.adapter.signalData('current-native')
    await vi.waitFor(() => expect(events.some(event => event.channel === 'task:source-action-failed')).toBe(true))
    await vi.waitFor(() => expect(events.some(event => event.channel === 'task:updated')).toBe(true))
    const failure = events.find(event => event.channel === 'task:source-action-failed')!
    const wire = TASK_FEEDBACK_EVENT_CODECS['task:source-action-failed'].encodePayload(failure.payload)
    expect(wire).toEqual({ taskId: f.task.id, taskTitle: '🧪'.repeat(128), error: TASK_SOURCE_ACTION_ERROR })
    const saved = f.db.getTask(f.task.id)!
    expect(saved.status).toBe('ready_for_review'); expect(saved).toHaveProperty('checklist'); expect(saved).toHaveProperty('mcp_scope_nonce')
    const updates = events.filter(event => event.channel === 'task:updated')
    expect(updates).toEqual([{ channel: 'task:updated', payload: { taskId: f.task.id, updates: { status: saved.status, updated_at: saved.updated_at, last_activity_at: saved.last_activity_at ?? null } } }])
    for (const update of updates) expect(TASK_LIFECYCLE_EVENT_CODECS['task:updated'].validatePayload(update.payload)).toBe(true)
    const idle = events.filter(event => event.channel === 'agent:status').at(-1)!
    expect(AGENT_EVENT_CODECS['agent:status'].validatePayload(idle.payload)).toBe(true)
    expect(f.manager.findSessionByTaskId(f.task.id)?.sessionId).toBe('current-native')
  } finally { f.manager.removeExternalListener(listener); await sync.close() }
})

it.each(['failure', 'stopped-failure', 'replacement-choice-success'] as const)('keeps learning skill outcome %s finite and refuses withdrawn fallback writes', async outcome => {
  const f = await fixture()
  f.adapter.setStatus(SessionStatusType.WAITING_APPROVAL); f.adapter.signalData('current-native')
  await vi.waitFor(() => expect(f.manager.getSessionStatus('current-native')?.status).toBe('waiting_approval'))
  f.adapter.setStatus(SessionStatusType.BUSY); f.adapter.signalData('current-native')
  await vi.waitFor(() => expect(f.manager.getSessionStatus('current-native')?.status).toBe('working'))
  updateTaskFromUser(f.db, f.task.id, { status: 'agent_learning', feedback_rating: 4, complete_at_source: false })
  let stopping: Promise<{ sessionId: string | null }> | undefined
  const replacement = JSON.stringify({ completeAtSource: true })
  const skills = vi.spyOn(f.manager, 'syncSkillsFromWorkspace').mockImplementation(() => {
    if (outcome === 'replacement-choice-success') {
      // The real skill method is synchronous; its caller awaits it. Replace
      // intent in that actual await continuation window without type tricks.
      queueMicrotask(() => f.db.setSetting(`session-feedback-completion:${f.task.id}`, replacement))
      return { created: [], updated: [], unchanged: [] }
    }
    if (outcome === 'stopped-failure') stopping = f.manager.stopByTaskId(f.task.id)
    throw new Error('Actual controlled skill scan failure')
  })
  const events: Array<{ channel: string; payload: unknown }> = [], listener = (channel: string, payload: unknown): void => { events.push({ channel, payload }) }
  f.manager.addExternalListener(listener)
  try {
    f.adapter.setStatus(SessionStatusType.IDLE); f.adapter.signalData('current-native')
    await vi.waitFor(() => expect(skills).toHaveBeenCalledOnce())
    if (outcome === 'stopped-failure') {
      if (!stopping) throw new Error('Actual Stop was not admitted')
      await stopping
      const newer = f.db.getTask(f.task.id)
      await vi.advanceTimersByTimeAsync(100)
      expect(f.manager.findSessionByTaskId(f.task.id)).toBeUndefined()
      expect(f.db.getTask(f.task.id)?.status).not.toBe('ready_for_review')
      expect(f.db.getTask(f.task.id)).toEqual(newer)
    } else if (outcome === 'replacement-choice-success') {
      await vi.waitFor(() => expect(f.db.getSetting(`session-feedback-completion:${f.task.id}`)).toBe(replacement))
      await vi.advanceTimersByTimeAsync(100)
      expect(f.db.getTask(f.task.id)?.status).toBe('agent_learning')
      expect(f.db.getSetting(`session-feedback-completion:${f.task.id}`)).toBe(replacement)
      expect(events.filter(event => event.channel === 'task:updated')).toEqual([])
    } else {
      await vi.waitFor(() => expect(f.db.getTask(f.task.id)?.status).toBe('ready_for_review'))
      const saved = f.db.getTask(f.task.id)!
      const update = events.find(event => event.channel === 'task:updated')!
      expect(update.payload).toEqual({ taskId: f.task.id, updates: { status: saved.status, updated_at: saved.updated_at, last_activity_at: saved.last_activity_at ?? null } })
      expect(TASK_LIFECYCLE_EVENT_CODECS['task:updated'].validatePayload(update.payload)).toBe(true)
    }
    expect(events.filter(event => event.channel === 'task:source-action-failed')).toEqual([])
  } finally { f.manager.removeExternalListener(listener); skills.mockRestore() }
})

it('prevents concurrent responses to one pending request while its raw callback remains owned', async () => {
  const f = await fixture()
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  finishers.push(finish)
  f.adapter.respondToApproval.mockImplementation(async () => { await gate; return true })
  const response = f.manager.respondToScopedPermission(f.input)
  await vi.waitFor(() => expect(f.adapter.respondToApproval).toHaveBeenCalledOnce())
  await expect(f.manager.respondToScopedPermission(f.input)).rejects.toThrow('in progress')
  finish(); expect(await response).toEqual({ handled: true })
})

it('retains working ownership and polling when the native adapter refuses an acknowledged abort', async () => {
  const f = await fixture()
  f.adapter.abortPrompt.mockRejectedValueOnce(new Error('Native abort refused'))
  await expect(f.manager.abortSession('current-native', { requireAcknowledgement: true })).rejects.toThrow('Native abort refused')
  expect(f.manager.getSessionStatus('current-native')?.status).toBe('working')
  expect(f.manager.findSessionByTaskId(f.task.id)?.sessionId).toBe('current-native')
  await expect(f.manager.abortSession('retired-native', { requireAcknowledgement: true })).rejects.toThrow('no longer owned')
})

it('does not manufacture idle or cancellation completion from an accepted interrupt whose native turn remains busy', async () => {
  const f = await fixture()
  await expect(f.manager.abortSession('current-native', { requireAcknowledgement: true })).rejects.toThrow('cancellation settled')
  expect(f.manager.getSessionStatus('current-native')?.status).toBe('working')
  f.adapter.setStatus(SessionStatusType.IDLE)
  await f.manager.abortSession('current-native', { requireAcknowledgement: true })
  expect(f.manager.getSessionStatus('current-native')?.status).toBe('idle')
})

it('fences new task dispatch while an actual task mutation joins accepted work', async () => {
  const f = await fixture()
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  finishers.push(finish)
  const entered = vi.fn()
  const mutation = f.manager.runTaskLifecycleMutation([f.task.id], async () => { entered(); await gate; f.db.updateTask(f.task.id, { title: 'Saved after acknowledgement' }) })
  await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
  await expect(f.manager.sendByTaskId(f.task.id, 'Race')).rejects.toThrow('task is being updated')
  await expect(f.manager.runTaskGroupMutation([f.task.id], async () => undefined)).rejects.toThrow('already being updated')
  finish(); await mutation
  expect(f.db.getTask(f.task.id)?.title).toBe('Saved after acknowledgement')
})

it('refuses overlapping task and agent configuration writers in either order', async () => {
  const f = await fixture()
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  finishers.push(finish)
  const taskMutation = f.manager.runTaskLifecycleMutation([f.task.id], async () => { await gate })
  await expect(f.manager.runAgentConfigurationMutation(f.agent.id, 'update', () => undefined, { name: 'Metadata' })).rejects.toThrow('task changes')
  finish(); await taskMutation
  const configurationGate = new Promise<void>(resolve => { finish = resolve })
  finishers.push(() => finish())
  const configuration = f.manager.runAgentConfigurationMutation(f.agent.id, 'update', async () => { await configurationGate }, { name: 'Metadata' })
  await expect(f.manager.runTaskLifecycleMutation([f.task.id], async () => undefined)).rejects.toThrow('configuration')
  finish(); await configuration
})


it('holds global cleanup admission across cross-task, heartbeat, resume and model entry paths', async () => {
  const f = await fixture(); await f.manager.stopByTaskId(f.task.id)
  const other = f.db.createTask({ title: 'Foreign workspace admission' })!
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }); finishers.push(release)
  const entered = vi.fn()
  const cleanup = f.manager.runTaskLifecycleMutation([f.task.id], () => f.manager.withWorkspaceCleanupExclusion([f.task.id], async () => { entered(); await gate }))
  await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
  const created = f.adapter.createSession.mock.calls.length
  await expect(f.manager.requestSession(f.agent.id, other.id, f.db.getWorkspaceDir(f.task.id))).rejects.toThrow('WORKSPACE_CLEANUP_BUSY')
  await expect(f.manager.resumeSession(f.agent.id, other.id, 'foreign-native')).rejects.toThrow('WORKSPACE_CLEANUP_BUSY')
  await expect(f.manager.sendHeartbeatViaCaptain(f.agent.id, other.id, 'blocked heartbeat')).rejects.toThrow('WORKSPACE_CLEANUP_BUSY')
  await expect(f.manager.startHeartbeatSession(f.agent.id, other.id, 'blocked followup')).rejects.toThrow('WORKSPACE_CLEANUP_BUSY')
  await expect(f.manager.getProviders(undefined, undefined, 'pi')).rejects.toThrow('WORKSPACE_CLEANUP_BUSY')
  await expect(f.manager.listModels('pi')).rejects.toThrow('WORKSPACE_CLEANUP_BUSY')
  expect(f.adapter.createSession.mock.calls.length).toBe(created)
  release(); await cleanup
  await expect(f.manager.runTaskLifecycleMutation([f.task.id], () => f.manager.withWorkspaceCleanupExclusion([f.task.id], async () => 'retired'))).resolves.toBe('retired')
})

it.each(['providers', 'models'] as const)('refuses cleanup until an already admitted raw %s listing settles', async kind => {
  const f = await fixture(); await f.manager.stopByTaskId(f.task.id)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }); finishers.push(release)
  const entered = vi.fn()
  Object.assign(f.adapter, { getProviders: async () => { entered(); await gate; return { providers: [], default: {} } }, listModels: async () => { entered(); await gate; return [] } })
  const listing = kind === 'providers' ? f.manager.getProviders(undefined, undefined, 'pi') : f.manager.listModels('pi')
  await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
  const effect = vi.fn(async () => {})
  await expect(f.manager.runTaskLifecycleMutation([f.task.id], () => f.manager.withWorkspaceCleanupExclusion([f.task.id], effect))).rejects.toThrow('WORKSPACE_CLEANUP_BUSY')
  expect(effect).not.toHaveBeenCalled()
  release(); await listing
  await f.manager.runTaskLifecycleMutation([f.task.id], () => f.manager.withWorkspaceCleanupExclusion([f.task.id], effect))
  expect(effect).toHaveBeenCalledOnce()
})

it('keeps global admission closed after failed native cleanup retirement', async () => {
  const f = await fixture(); await f.manager.stopByTaskId(f.task.id)
  const other = f.db.createTask({ title: 'After uncertain native release' })!
  await expect(f.manager.runTaskLifecycleMutation([f.task.id], () => f.manager.withWorkspaceCleanupExclusion([f.task.id], async () => { throw new Error('native release unacknowledged') }, () => false))).rejects.toThrow('native release unacknowledged')
  await expect(f.manager.requestSession(f.agent.id, other.id)).rejects.toThrow('WORKSPACE_CLEANUP_BUSY')
  await expect(f.manager.listModels('pi')).rejects.toThrow('WORKSPACE_CLEANUP_BUSY')
})


it('routes withdrawn pre-session startup failure through a durable task error and valid task invalidation', async () => {
  const f = await fixture(); await f.manager.stopByTaskId(f.task.id)
  const task = f.db.createTask({ title: 'Withdrawn startup keeps truthful task error' })!
  f.db.updateTask(task.id, { agent_id: f.agent.id })
  let entered!: () => void, release!: () => void
  const accepted = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve }); finishers.push(release)
  f.adapter.createSession.mockImplementationOnce(async () => { entered(); await gate; return 'withdrawn-native' })
  const events: Array<{ channel: string; payload: unknown }> = []
  const listener = (channel: string, payload: unknown): void => { events.push({ channel, payload }) }
  f.manager.addExternalListener(listener)
  const start = f.manager.requestSession(f.agent.id, task.id, undefined, true)
  const rejected = expect(start).rejects.toThrow('Start ownership was withdrawn before session registration.')
  try {
    await accepted
    f.db.db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(task.id)
    release(); await rejected
    expect(f.adapter.destroySession.mock.calls.filter(([id]) => id === 'withdrawn-native')).toHaveLength(1)
    expect(f.manager.getSessionStatus('withdrawn-native')).toBeNull()
    expect(f.db.getTask(task.id)?.status).toBe('completed')
    const error = f.db.getTranscriptParts(task.id).find(part => part.partType === 'error' && part.content?.includes('Start ownership was withdrawn before session registration.'))
    expect(error).toBeDefined()
    expect(error?.role).toBe('system')
    expect(f.manager.getStartRecoveryState(task.id)).toMatchObject({ state: 'cancelled', recoveryResult: 'excluded_failure_not_retried' })
    const invalidations = events.filter(event => event.channel === 'task:updated' && TASK_LIFECYCLE_EVENT_CODECS['task:updated'].validatePayload(event.payload))
    expect(invalidations).toContainEqual({ channel: 'task:updated', payload: { taskId: task.id, updates: {} } })
    const statuses = events.filter(event => event.channel === 'agent:status')
    expect(statuses.length).toBeGreaterThan(0) // actual acknowledged Stop remains observable
    for (const event of statuses) expect(AGENT_EVENT_CODECS['agent:status'].validatePayload(event.payload)).toBe(true)
    expect(statuses.some(event => typeof event.payload === 'object' && event.payload !== null && 'sessionId' in event.payload && event.payload.sessionId === '')).toBe(false)
    await f.manager.stopByTaskId(task.id)
    expect(f.manager.hasTaskStartOwnership(task.id)).toBe(false)
  } finally { release(); await start.catch(() => {}); f.manager.removeExternalListener(listener) }
})
