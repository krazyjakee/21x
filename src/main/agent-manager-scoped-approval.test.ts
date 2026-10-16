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
