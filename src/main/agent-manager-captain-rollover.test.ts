/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from './agent-manager-core'
import type { AgentManagerHost } from './agent-manager/host'
import { MessagePartType, SessionStatusType, type SessionConfig } from './adapters/coding-agent-adapter'
import { createChatProviderFromSettings } from './chat/provider-factory'
import type { ChatSettingsSource } from './chat/provider-factory'

vi.mock('./agent-manager/workspace-docs', async (original) => ({
  ...await original<typeof import('./agent-manager/workspace-docs')>(), writeSkillFiles: vi.fn(async () => undefined)
}))
vi.mock('./chat/provider-factory', () => ({ createChatProviderFromSettings: vi.fn((settings: ChatSettingsSource) => ({
  id: 'own-model', model: settings.getAgents()[0].config.model,
  async *stream() { yield { type: 'text_delta', text: 'Original task completed once. Keep its outcomes and wait for the next request.' } }
})) }))

const managers: AgentManager[] = []
const databases: ReturnType<typeof createPortableTestDb>[] = []
const directories: string[] = []
beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }))
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stopAllSessions()
  for (const db of databases.splice(0)) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.useRealTimers(); vi.restoreAllMocks(); vi.mocked(createChatProviderFromSettings).mockClear()
})
async function fixture() {
  const db = createPortableTestDb()
  databases.push(db)
  const directory = mkdtempSync(join(tmpdir(), 'captain-rollover-core-'))
  directories.push(directory)
  db.setSetting('sessions.captain_managed', 'true')
  db.setSetting('sessions.rollover', 'on')
  db.setSetting('sessions.rollover_thresholds', JSON.stringify({ compactions: 1 }))
  const agent = db.createAgent({ name: 'Own agent', config: { coding_agent: 'codex', model: 'gpt-4o' } })!
  const project = db.createProject({ name: 'Rollover project', captain_agent_id: agent.id })!
  const task = db.getCoordinatorTask(project.id)!
  const adapter = new FakeAdapter({ status: SessionStatusType.IDLE, sessionIds: ['old-native', 'new-native', 'must-not-create'] })
  const host: AgentManagerHost = { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' },
    secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => adapter,
    isCodexAppServerAdapter: () => true, captainSummaryProvider: createChatProviderFromSettings }
  function newManager() {
    const manager = new AgentManager(db, host)
    managers.push(manager)
    const internal = manager as any
    vi.spyOn(internal, 'setupWorktreeIfNeeded').mockResolvedValue(directory)
    vi.spyOn(internal, 'buildSessionConfig').mockImplementation(async (): Promise<SessionConfig> => ({ agentId: agent.id, taskId: task.id, workspaceDir: directory, model: 'gpt-4o' }))
    const events = vi.spyOn(internal, 'sendToRenderer')
    return { manager, internal, events }
  }
  const current = newManager()
  const backendId = await current.manager.startSession(agent.id, task.id, directory, true)
  const session = current.manager.findSessionByTaskId(task.id)!.session
  session.status = 'idle'
  current.internal.persistTranscriptEvent('agent:output', { sessionId: backendId, taskId: task.id, type: 'message',
    data: { id: 'original-user', role: 'user', content: 'Original goal', partType: 'text' } })
  await current.internal.captainEngine.observe(task.id, backendId, 'compaction', 'one-compaction', { source: 'reported' })
  return { db, directory, task, agent, adapter, host, backendId, session, ...current, newManager }
}

describe('Captain rollover binding and pending continuity', () => {
  it('creates and durably binds one native generation without an automatic model turn, then acknowledges seed on the next accepted intent', async () => {
    const h = await fixture()
    await h.internal.maybeRolloverCaptain(h.backendId, h.session)
    expect(h.adapter.createSession).toHaveBeenCalledTimes(2)
    expect(h.adapter.sendPrompt).not.toHaveBeenCalled()
    expect(h.db.getTask(h.task.id)?.session_id).toBe('new-native')
    const metadata = h.db.db.prepare("SELECT state, payload FROM delivery_outbox WHERE kind='captain_handoff_seed'").get() as { state: string; payload: string }
    expect(metadata.state).toBe('pending')
    expect(metadata.payload).toContain('Original task completed once')
    const notes = h.db.getTranscriptParts(h.task.id).filter((part) => part.partType === MessagePartType.GENERATION)
    expect(notes).toHaveLength(1)
    expect(JSON.parse(notes[0].content)).toMatchObject({ kind: 'rollover', source: 'model', title: expect.any(String) })
    expect(h.events.mock.calls.some((call: unknown[]) => JSON.stringify(call).includes('"partType":"generation"'))).toBe(true)
    await h.manager.sendMessage('new-native', 'Next explicit request', h.task.id, h.agent.id, undefined, 'human-after-rollover')
    expect(h.adapter.sendPrompt).toHaveBeenCalledOnce()
    expect(h.adapter.sendPrompt.mock.calls[0][1][0].text).toContain('Original task completed once')
    expect(h.adapter.sendPrompt.mock.calls[0][1][0].text).toContain('Next explicit request')
    expect(h.db.db.prepare("SELECT state FROM delivery_outbox WHERE kind='captain_handoff_seed'").get()).toEqual({ state: 'acknowledged' })
  })

  it('restores pending recap after restart and never dispatches it as a standalone recovered delivery', async () => {
    const h = await fixture()
    await h.internal.maybeRolloverCaptain(h.backendId, h.session)
    await h.manager.stopAllSessions()
    const restarted = h.newManager()
    expect(await restarted.manager.startSession(h.agent.id, h.task.id, h.directory, true)).toBe('new-native')
    expect(h.adapter.createSession).toHaveBeenCalledTimes(2)
    expect(h.adapter.sendPrompt).not.toHaveBeenCalled()
    const pending = restarted.manager.findSessionByTaskId(h.task.id)!.session
    expect(pending.pendingRecap).toContain('Original task completed once')
    await restarted.manager.sendMessage('new-native', 'Continue with this new goal', h.task.id, h.agent.id, undefined, 'after-restart')
    expect(h.adapter.sendPrompt).toHaveBeenCalledOnce()
    expect(h.adapter.sendPrompt.mock.calls[0][1][0].text).toContain('Continue with this new goal')
  })

  it('retains accepted identity on failed binding and includes later source outcomes on retry without creating again', async () => {
    const h = await fixture()
    h.adapter.destroySession.mockRejectedValueOnce(new Error('Source runtime still owns its session'))
    await h.internal.maybeRolloverCaptain(h.backendId, h.session)
    expect(h.db.db.prepare('SELECT state, target_backend_id FROM session_handoffs').get()).toEqual({ state: 'created', target_backend_id: 'new-native' })
    expect(h.db.getTask(h.task.id)?.session_id).toBe('old-native')
    expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM delivery_outbox WHERE kind='captain_handoff_seed'").get()).toEqual({ count: 0 })
    await h.manager.sendMessage('old-native', 'A newer instruction after cancellation', h.task.id, h.agent.id, undefined, 'later-user')
    h.internal.persistTranscriptEvent('agent:output', { sessionId: 'old-native', taskId: h.task.id, type: 'message',
      data: { id: 'newer-outcome', role: 'assistant', content: 'Newer task completed once', partType: 'text' } })
    h.session.status = 'idle'
    h.internal.emitStatus('old-native', h.session, 'idle')
    await h.internal.maybeRolloverCaptain('old-native', h.session)
    expect(h.adapter.createSession).toHaveBeenCalledTimes(2)
    expect(h.adapter.sendPrompt).toHaveBeenCalledOnce()
    const seed = h.db.db.prepare("SELECT payload FROM delivery_outbox WHERE kind='captain_handoff_seed'").get() as { payload: string }
    expect(seed.payload).toContain('A newer instruction after cancellation')
    expect(seed.payload).toContain('Newer task completed once')
    expect(h.db.getTask(h.task.id)?.session_id).toBe('new-native')
  })

  it('does not complete a handoff when its generation divider cannot be persisted', async () => {
    const h = await fixture()
    const original = h.internal.persistTranscriptEvent.bind(h.internal)
    vi.spyOn(h.internal, 'persistTranscriptEvent').mockImplementation((...args: unknown[]) => {
      const [channel, data] = args as [string, any]
      if (data?.data?.partType === MessagePartType.GENERATION) throw new Error('Divider write failed')
      return original(channel, data)
    })
    await h.internal.maybeRolloverCaptain(h.backendId, h.session)
    expect(h.db.db.prepare('SELECT state FROM session_handoffs').get()).toEqual({ state: 'created' })
    expect(h.adapter.createSession).toHaveBeenCalledTimes(2)
    expect(h.adapter.sendPrompt).not.toHaveBeenCalled()
    expect(h.db.getTranscriptParts(h.task.id).some((part) => part.partType === MessagePartType.GENERATION)).toBe(false)
  })

  it('retains a create accepted after manual stop without binding, seed delivery or prompt replay', async () => {
    const h = await fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const entered = vi.fn()
    h.adapter.createSession.mockImplementationOnce(async () => { entered(); await gate; return 'accepted-after-stop' })
    const attempt = h.internal.maybeRolloverCaptain(h.backendId, h.session)
    try {
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
      await h.manager.stopByTaskId(h.task.id)
      release(); await attempt
      expect(h.db.db.prepare('SELECT state, target_backend_id FROM session_handoffs').get()).toEqual({ state: 'created', target_backend_id: 'accepted-after-stop' })
      expect(h.manager.findSessionByTaskId(h.task.id)).toBeUndefined()
      expect(h.adapter.sendPrompt).not.toHaveBeenCalled()
      expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM delivery_outbox WHERE kind='captain_handoff_seed'").get()).toEqual({ count: 0 })
      expect(h.adapter.createSession).toHaveBeenCalledTimes(2)
    } finally { release(); await attempt }
  })

  it('recovers the saved native target after teardown succeeded but binding failed, without recreating or summarizing', async () => {
    const h = await fixture()
    const update = h.internal.updateTaskFromLocalAgent.bind(h.internal)
    const brokenBinding = vi.spyOn(h.internal, 'updateTaskFromLocalAgent').mockImplementation((...args: unknown[]) => {
      const [taskId, fields, origin] = args as [string, any, string?]
      if (fields.session_id === 'new-native') throw new Error('Binding write failed')
      return update(taskId, fields, origin)
    })
    await h.internal.maybeRolloverCaptain(h.backendId, h.session)
    expect(h.adapter.destroySession).toHaveBeenCalledOnce()
    expect(h.manager.findSessionByTaskId(h.task.id)).toBeUndefined()
    expect(h.db.getTask(h.task.id)?.session_id).toBe('old-native')
    expect(h.db.db.prepare('SELECT state, target_backend_id FROM session_handoffs').get()).toEqual({ state: 'created', target_backend_id: 'new-native' })
    brokenBinding.mockRestore()
    await h.manager.stopAllSessions()
    h.adapter.resumeSession.mockImplementation(async (id) => {
      if (id === 'old-native') throw new Error('SESSION_FILE_NOT_FOUND')
      return []
    })
    const restarted = h.newManager()
    const summaryCalls = vi.mocked(createChatProviderFromSettings).mock.calls.length
    expect(await restarted.manager.resumeSession(h.agent.id, h.task.id, 'old-native')).toBe('new-native')
    expect(h.adapter.createSession).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createChatProviderFromSettings)).toHaveBeenCalledTimes(summaryCalls)
    expect(h.adapter.resumeSession.mock.calls.every(([id]) => id !== 'old-native')).toBe(true)
    expect(h.db.getTask(h.task.id)?.session_id).toBe('new-native')
    expect(h.db.db.prepare('SELECT state FROM session_handoffs').get()).toEqual({ state: 'completed' })
    expect(h.db.db.prepare("SELECT state FROM delivery_outbox WHERE kind='captain_handoff_seed'").get()).toEqual({ state: 'pending' })
    expect(h.db.getTranscriptParts(h.task.id).filter((part) => part.partType === MessagePartType.GENERATION)).toHaveLength(1)
    expect(h.adapter.sendPrompt).not.toHaveBeenCalled()
  })

  it('reuses an existing target token on bind retry and refuses foreign live or durable target ownership before resume', async () => {
    const h = await fixture()
    const original = h.internal.persistTranscriptEvent.bind(h.internal)
    const brokenDivider = vi.spyOn(h.internal, 'persistTranscriptEvent').mockImplementation((...args: unknown[]) => {
      const [channel, data] = args as [string, any]
      if (data?.data?.partType === MessagePartType.GENERATION) throw new Error('Divider write failed')
      return original(channel, data)
    })
    await h.internal.maybeRolloverCaptain(h.backendId, h.session)
    brokenDivider.mockRestore()
    const target = h.manager.findSessionByTaskId(h.task.id)!.session
    target.secretSessionToken = 'owned-target-token'
    const unregister = vi.fn()
    h.host.secrets = { kind: 'broker', getPort: () => 1234, register: () => {}, unregister, writeShellWrapper: () => '/tmp/fixture-shell' }
    const allocate = vi.spyOn(h.internal, 'setupSecretSession').mockReturnValue('new-token-must-not-be-consumed')
    const record = h.internal.captainRollover.pendingCreated(h.task.id)
    await h.internal.bindCaptainRollover('new-native', target, record, new AbortController().signal)
    expect(allocate).not.toHaveBeenCalled()
    expect(h.adapter.resumeSession.mock.calls.at(-1)?.[1].secretSessionToken).toBe('owned-target-token')
    expect(target.secretSessionToken).toBe('owned-target-token')
    expect(unregister).not.toHaveBeenCalled()
    const calls = h.adapter.resumeSession.mock.calls.length
    const foreign = h.db.createTask({ title: 'Foreign owner' })!
    h.internal.sessions.set('new-native', { ...target, taskId: foreign.id })
    await expect(h.internal.bindCaptainRollover('new-native', target, record, new AbortController().signal)).rejects.toThrow('another task or agent')
    expect(h.adapter.resumeSession).toHaveBeenCalledTimes(calls)
    h.internal.sessions.set('new-native', target)
    h.db.updateTask(foreign.id, { session_id: 'new-native' })
    await expect(h.internal.bindCaptainRollover('new-native', target, record, new AbortController().signal)).rejects.toThrow('durably bound to another task')
    expect(h.adapter.resumeSession).toHaveBeenCalledTimes(calls)
  })
})
