import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dirname } from 'node:path'
import { rmSync } from 'node:fs'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from './agent-manager-core'
import type { AgentManagerHost } from './agent-manager/host'
import { SessionStatusType } from './adapters/coding-agent-adapter'

vi.mock('./agent-manager/workspace-docs', async original => ({ ...await original<typeof import('./agent-manager/workspace-docs')>(), writeSkillFiles: vi.fn(async () => undefined) }))
const resources: Array<{ db: ReturnType<typeof createPortableTestDb>; manager: AgentManager; directory: string }> = []
beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }))
afterEach(async () => {
  for (const { db, manager, directory } of resources.splice(0)) { await manager.stopAllSessions(); db.close(); rmSync(directory, { recursive: true, force: true }) }
  vi.useRealTimers(); vi.restoreAllMocks()
})
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function fixture() {
  const db = createPortableTestDb()
  const agent = db.createAgent({ name: 'Configuration owner', config: { coding_agent: 'codex', model: 'old-model', max_parallel_sessions: 1 } })!
  const project = db.createProject({ name: 'Configuration fixture', default_agent_id: agent.id })!
  const tasks = ['First', 'Second'].map(title => { const task = db.createTask({ title, project_id: project.id })!; db.updateTask(task.id, { agent_id: agent.id }); return db.getTask(task.id)! })
  const adapter = Object.assign(new FakeAdapter({ status: SessionStatusType.BUSY, sessionIds: ['configuration-one', 'configuration-two', 'configuration-three'] }), { notifyConfigChanged: vi.fn(async () => {}) })
  const host: AgentManagerHost = { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' },
    configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => adapter, isCodexAppServerAdapter: () => true }
  const manager = new AgentManager(db, host), directory = dirname(dirname(db.getWorkspaceDir(tasks[0].id)))
  resources.push({ db, manager, directory }); return { db, manager, adapter, agent, project, tasks }
}

describe('actual AgentManager configuration ownership', () => {
  it('raises a cap and starts queued work without destroying a live session or refreshing provider config', async () => {
    const h = fixture()
    h.db.updateProject(h.project.id, { settings: { concurrency: { captain_control: false } } })
    await h.manager.startTask(h.tasks[0].id)
    expect((await h.manager.startTask(h.tasks[1].id)).action).toBe('queued')
    const changes = { config: { ...h.agent.config, max_parallel_sessions: 2, concurrency_cap: 2 } }
    await h.manager.runAgentConfigurationMutation(h.agent.id, 'update', () => h.db.updateAgent(h.agent.id, changes), changes)
    await vi.waitFor(() => expect(h.adapter.createSession).toHaveBeenCalledTimes(2))
    expect(h.adapter.destroySession).not.toHaveBeenCalled(); expect(h.adapter.notifyConfigChanged).not.toHaveBeenCalled()
    expect(h.manager.findSessionByTaskId(h.tasks[0].id)?.sessionId).toBe('configuration-one')
  })
  it('keeps the old config and fences starts/sends until runtime Stop is acknowledged', async () => {
    const h = fixture(); await h.manager.startTask(h.tasks[0].id)
    const entered = deferred(), stopped = deferred()
    h.adapter.destroySession.mockImplementationOnce(async () => { entered.resolve(); await stopped.promise })
    const changes = { config: { ...h.agent.config, model: 'new-model' } }
    const updating = h.manager.runAgentConfigurationMutation(h.agent.id, 'update', () => h.db.updateAgent(h.agent.id, changes), changes)
    await entered.promise
    expect(h.db.getAgent(h.agent.id)?.config.model).toBe('old-model')
    await expect(h.manager.startTask(h.tasks[1].id)).rejects.toThrow('configuration is being updated')
    await expect(h.manager.sendByTaskId(h.tasks[0].id, 'Do more')).rejects.toThrow('configuration is being updated')
    stopped.resolve(); await updating
    expect(h.db.getAgent(h.agent.id)?.config.model).toBe('new-model'); expect(h.adapter.notifyConfigChanged).toHaveBeenCalledOnce()
    expect(h.manager.findSessionByTaskId(h.tasks[0].id)).toBeUndefined()
  })
  it('refuses a failed Stop before committing and preserves the original owner for retry', async () => {
    const h = fixture(); await h.manager.startTask(h.tasks[0].id)
    h.adapter.destroySession.mockRejectedValueOnce(new Error('Fixture teardown refused'))
    const changes = { config: { ...h.agent.config, model: 'new-model' } }, mutation = vi.fn(() => h.db.updateAgent(h.agent.id, changes))
    await expect(h.manager.runAgentConfigurationMutation(h.agent.id, 'update', mutation, changes)).rejects.toThrow('teardown refused')
    expect(mutation).not.toHaveBeenCalled(); expect(h.db.getAgent(h.agent.id)?.config.model).toBe('old-model')
    expect(h.manager.findSessionByTaskId(h.tasks[0].id)?.sessionId).toBe('configuration-one'); expect(h.adapter.notifyConfigChanged).not.toHaveBeenCalled()
  })
  it('cancels queued ownership and acknowledges native destruction before deleting the agent', async () => {
    const h = fixture(); await h.manager.startTask(h.tasks[0].id); await h.manager.startTask(h.tasks[1].id)
    const mutation = vi.fn(() => { expect(h.manager.getStartQueue()).toHaveLength(0); expect(h.manager.findSessionByTaskId(h.tasks[0].id)).toBeUndefined(); return h.db.deleteAgent(h.agent.id) })
    expect(await h.manager.runAgentConfigurationMutation(h.agent.id, 'delete', mutation)).toBe(true)
    expect(h.adapter.destroySession).toHaveBeenCalledOnce(); expect(h.adapter.createSession).toHaveBeenCalledOnce()
    expect(h.db.getTask(h.tasks[1].id)?.agent_id).toBeNull(); expect(h.db.getAgent(h.agent.id)).toBeUndefined()
  })
  it('protects an unrelated agent using the same cached backend before side effects', async () => {
    const h = fixture(), other = h.db.createAgent({ name: 'Other', config: { coding_agent: 'codex', model: 'other-model' } })!
    h.db.updateTask(h.tasks[1].id, { agent_id: other.id }); await h.manager.startTask(h.tasks[1].id)
    const changes = { config: { ...h.agent.config, model: 'new-model' } }, mutation = vi.fn(() => h.db.updateAgent(h.agent.id, changes))
    await expect(h.manager.runAgentConfigurationMutation(h.agent.id, 'update', mutation, changes)).rejects.toThrow('Stop other agents')
    expect(mutation).not.toHaveBeenCalled(); expect(h.adapter.destroySession).not.toHaveBeenCalled()
    expect(h.manager.findSessionByTaskId(h.tasks[1].id)?.session.agentId).toBe(other.id)
  })
  it('blocks new dispatch after a committed refresh failure until an actual successful retry', async () => {
    const h = fixture(); await h.manager.startTask(h.tasks[0].id)
    h.adapter.notifyConfigChanged.mockRejectedValueOnce(new Error('Fixture refresh failed'))
    const changes = { config: { ...h.agent.config, model: 'new-model' } }
    await expect(h.manager.runAgentConfigurationMutation(h.agent.id, 'update', () => h.db.updateAgent(h.agent.id, changes), changes)).rejects.toThrow('refresh failed')
    expect(h.db.getAgent(h.agent.id)?.config.model).toBe('new-model')
    await expect(h.manager.startTask(h.tasks[1].id)).rejects.toThrow('could not be refreshed')
    await h.manager.runAgentConfigurationMutation(h.agent.id, 'update', () => h.db.updateAgent(h.agent.id, changes), changes)
    await h.manager.startTask(h.tasks[1].id); expect(h.adapter.notifyConfigChanged).toHaveBeenCalledTimes(2)
  })
})
