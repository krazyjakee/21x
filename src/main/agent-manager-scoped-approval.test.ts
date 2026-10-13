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
