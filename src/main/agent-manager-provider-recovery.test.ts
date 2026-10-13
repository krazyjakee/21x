/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { AgentManager } from './agent-manager-core'
import type { AgentManagerHost } from './agent-manager/host'
import { classifyProviderFailure, PROVIDER_MAX_RETRIES, providerFailureError } from './agent-manager/provider-failure'
import { MessagePartType, SessionStatusType, type CodingAgentAdapter, type MessagePart, type SessionConfig, type SessionStatus } from './adapters/coding-agent-adapter'
import type { ProviderRecovery } from './sessions/provider-recovery-store'

vi.mock('./agent-manager/workspace-docs', async (original) => ({
  ...await original<typeof import('./agent-manager/workspace-docs')>(),
  writeSkillFiles: vi.fn(async () => undefined)
}))

const managers: AgentManager[] = []
const databases: ReturnType<typeof createPortableTestDb>[] = []
beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }))
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stopAllSessions()
  for (const db of databases.splice(0)) db.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function fixture(captain = false) {
  const db = createPortableTestDb()
  databases.push(db)
  const agent = db.createAgent({ name: 'Codex', config: { coding_agent: 'codex' } })!
  const task = db.createTask({ title: captain ? 'Captain' : 'Task', role: captain ? 'captain' : 'task' })!
  db.updateTask(task.id, { agent_id: agent.id })
  const adapter = {
    initialize: vi.fn(async () => undefined),
    checkHealth: vi.fn(async () => ({ available: true })),
    createSession: vi.fn(async () => 'thread'),
    resumeSession: vi.fn(async () => []),
    sendPrompt: vi.fn(async (_id: string, _parts: MessagePart[], _config: SessionConfig) => undefined),
    getStatus: vi.fn(async (): Promise<SessionStatus> => ({ type: SessionStatusType.IDLE })),
    pollMessages: vi.fn(async (): Promise<MessagePart[]> => []),
    abortPrompt: vi.fn(async () => undefined),
    destroySession: vi.fn(async () => undefined)
  }
  const host: AgentManagerHost = {
    renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' },
    secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' },
    createAdapter: () => adapter as CodingAgentAdapter, isCodexAppServerAdapter: () => true
  }
  function newManager() {
    const manager = new AgentManager(db, host)
    managers.push(manager)
    vi.spyOn(manager as any, 'buildSessionConfig').mockImplementation(async (...args: unknown[]) => ({
      agentId: args[0], taskId: args[1], workspaceDir: '/tmp/provider-recovery'
    }))
    const events = vi.spyOn(manager as any, 'sendToRenderer')
    vi.spyOn(db, 'getTranscriptParts').mockReturnValue([])
    return { manager, internal: manager as any, events }
  }
  const { manager, internal, events } = newManager()
  const config: SessionConfig = { agentId: agent.id, taskId: task.id, workspaceDir: '/tmp/provider-recovery' }
  function register(target = internal, id = 'thread', forAgent = agent.id) {
    const session = { id, agentId: forAgent, taskId: task.id, workspaceDir: config.workspaceDir,
      status: 'working', createdAt: new Date(), seenMessageIds: new Set(), seenPartIds: new Set(),
      partContentLengths: new Map(), assistantTextKeys: new Set(), adapter,
      fallbackAgentIds: [] as string[], attemptedAgentIds: new Set([forAgent]) }
    target.sessions.set(id, session)
    db.updateTask(task.id, { session_id: id, status: 'agent_working' })
    return session
  }
  const session = register()
  const row = (): ProviderRecovery => internal.providerRecoveries.get(task.id)
  async function seed() { await internal.sendTrackedPrompt(session, 'thread', 'Work through the backlog', config) }
  async function failTurn() {
    const failure = { ...classifyProviderFailure('Selected model is at capacity (serverOverloaded)', 'turn_failed'), intentId: row().intentId }
    await internal.handleErrorStatus('thread', session, config, { type: SessionStatusType.ERROR, message: failure.message, providerFailure: failure }, [])
  }
  async function retry(target = internal) {
    const pending = target.providerRecoveries.get(task.id)
    vi.setSystemTime(pending.nextRetryAt)
    await target.dispatchProviderRecovery(pending)
  }
  return { db, task, agent, adapter, manager, internal, session, config, events, row, seed, failTurn, retry, register, newManager }
}

describe('active-turn provider recovery', () => {
  it('automatically recovers an injected Codex failed capacity turn in the same thread', async () => {
    const h = fixture()
    await h.seed()
    await h.failTurn()
    expect(h.row()).toMatchObject({ state: 'retrying', attempt: 1, delivery: 'turn_failed' })
    expect(h.manager.findSessionByTaskId(h.task.id)?.session.status).toBe('working')
    expect(h.events.mock.calls.some((call) => JSON.stringify(call).includes('Retrying…'))).toBe(true)
    await vi.advanceTimersByTimeAsync(h.row().nextRetryAt! - Date.now())
    expect(h.adapter.sendPrompt).toHaveBeenCalledTimes(2)
    expect(h.adapter.sendPrompt.mock.calls[1][1][0].text).toContain('Do not repeat completed tool calls')
    expect(h.row().state).toBe('accepted')
  })

  it('handles rejected direct send exactly once through the outbox and never resets its budget', async () => {
    const h = fixture()
    h.adapter.sendPrompt.mockRejectedValueOnce(providerFailureError('serverOverloaded', 'rejected'))
    await h.manager.sendMessage('thread', 'Next task', h.task.id, h.agent.id, undefined, 'direct-intent')
    expect(h.row()).toMatchObject({ state: 'retrying', delivery: 'rejected', attempt: 1 })
    expect(h.db.db.prepare("SELECT state FROM delivery_outbox WHERE idempotency_key = 'direct-intent'").get()).toEqual({ state: 'acknowledged' })
    await h.retry()
    expect(h.adapter.sendPrompt.mock.calls[1][1][0].text).toBe('Next task')
    expect(h.row().attempt).toBe(1)
    await h.manager.sendMessage('thread', 'Next task', h.task.id, h.agent.id, undefined, 'direct-intent')
    expect(h.adapter.sendPrompt).toHaveBeenCalledTimes(2)
  })

  it('keeps a failed initial prompt owned until its confirmed rejection is retried', async () => {
    const h = fixture()
    h.internal.sessions.clear()
    h.adapter.sendPrompt.mockRejectedValueOnce(providerFailureError('serverOverloaded', 'rejected'))
    const sessionId = await h.internal.startAdapterSession(h.adapter, h.agent.id, h.task.id, h.config.workspaceDir, false)
    expect(sessionId).toBe('thread')
    expect(h.row()).toMatchObject({ state: 'retrying', delivery: 'rejected' })
    await h.retry()
    expect(h.adapter.createSession).toHaveBeenCalledOnce()
    expect(h.adapter.sendPrompt).toHaveBeenCalledTimes(2)
    expect(h.adapter.sendPrompt.mock.calls[1][1][0].text).toBe(h.adapter.sendPrompt.mock.calls[0][1][0].text)
  })

  it('continues Captain orchestration after streaming failure without repeating the completed task start', async () => {
    const h = fixture(true)
    let taskStarts = 0
    h.adapter.sendPrompt.mockImplementation(async (_id, parts) => {
      if (!parts[0].text?.includes('Do not repeat completed tool calls')) taskStarts++
    })
    await h.seed()
    const failed = { ...classifyProviderFailure('serverOverloaded', 'turn_failed'), intentId: h.row().intentId }
    h.adapter.pollMessages.mockResolvedValueOnce([{ id: 'task-start-completed', type: MessagePartType.TOOL, tool: { name: 'start_task', status: 'completed' } }] as never)
    h.adapter.getStatus.mockResolvedValueOnce({ type: SessionStatusType.ERROR, message: failed.message, providerFailure: failed } as never)
    h.internal.startAdapterPolling('thread', h.adapter, h.config, h.session)
    await h.internal.pollSingleSession(h.internal.pollingEntries.get('thread'))
    await h.retry()
    expect(taskStarts).toBe(1)
    expect(h.adapter.createSession).not.toHaveBeenCalled()
    expect(h.adapter.sendPrompt).toHaveBeenCalledTimes(2)
  })

  it('recovers ECONNRESET status reads without replay or a continuation', async () => {
    const h = fixture()
    await h.seed()
    h.adapter.pollMessages.mockRejectedValueOnce(new Error('ECONNRESET'))
    h.internal.startAdapterPolling('thread', h.adapter, h.config, h.session)
    await h.internal.pollSingleSession(h.internal.pollingEntries.get('thread'))
    expect(h.row()).toMatchObject({ state: 'retrying', mode: 'poll', delivery: 'unknown' })
    h.adapter.getStatus.mockResolvedValue({ type: SessionStatusType.BUSY })
    await h.retry()
    expect(h.adapter.sendPrompt).toHaveBeenCalledOnce()
    expect(h.row().state).toBe('accepted')
    expect(h.manager.findSessionByTaskId(h.task.id)?.session.status).toBe('working')
  })

  it('restores backoff on startup, resumes the saved thread and dispatches one continuation', async () => {
    const h = fixture()
    await h.seed()
    await h.failTurn()
    const saved = h.row()
    await h.manager.stopAllSessions()
    const restarted = h.newManager()
    vi.spyOn(restarted.internal, 'resumeAdapterSession').mockImplementation(async () => {
      h.register(restarted.internal)
      return 'thread'
    })
    await restarted.manager.reconcileStartup()
    expect(restarted.internal.providerRecoveries.get(h.task.id)).toEqual(saved)
    expect(h.adapter.sendPrompt).toHaveBeenCalledOnce()
    await h.retry(restarted.internal)
    expect(restarted.internal.resumeAdapterSession).toHaveBeenCalledOnce()
    expect(h.adapter.sendPrompt).toHaveBeenCalledTimes(2)
    expect(restarted.internal.providerRecoveries.get(h.task.id).attempt).toBe(1)
  })

  it('marks crash during wire dispatch unknown and never replays on startup', async () => {
    const h = fixture()
    await h.seed()
    const original = h.row()
    h.internal.providerRecoveries.change(original, { state: 'dispatching' })
    await h.manager.stopAllSessions()
    const restarted = h.newManager()
    await restarted.manager.reconcileStartup()
    expect(restarted.internal.providerRecoveries.get(h.task.id)).toMatchObject({ state: 'failed', prompt: '' })
    expect(h.adapter.sendPrompt).toHaveBeenCalledOnce()
  })

  it('attempts configured fallbacks in order, skips failed creation, preserves recap and remaining intent', async () => {
    const h = fixture()
    const first = h.db.createAgent({ name: 'Unavailable fallback' })!
    const second = h.db.createAgent({ name: 'Working fallback' })!
    h.session.fallbackAgentIds = [first.id, second.id]
    await h.seed()
    await h.failTurn()
    h.internal.providerRecoveries.change(h.row(), { attempt: PROVIDER_MAX_RETRIES + 1 })
    vi.spyOn(h.internal, 'startAdapterSession').mockImplementation(async (...args: unknown[]) => {
      const id = args[1] as string
      if (id === first.id) throw new Error('Agent adapter unavailable')
      h.register(h.internal, 'fallback-thread', id)
      return 'fallback-thread'
    })
    await h.retry()
    expect(h.row().selectedFallback).toBe(first.id)
    await h.retry()
    expect(h.row()).toMatchObject({ state: 'accepted', selectedFallback: second.id, agentId: second.id, attemptedAgentIds: [h.agent.id, first.id, second.id] })
    expect(h.adapter.sendPrompt.mock.calls[1][1][0].text).toContain('Remaining intent:\nWork through the backlog')
    expect(h.internal.startAdapterSession.mock.calls.map((args: unknown[]) => args[1])).toEqual([first.id, second.id])
  })

  it('selects a configured fallback immediately for confirmed account exhaustion', async () => {
    const h = fixture()
    const fallback = h.db.createAgent({ name: 'Fallback' })!
    h.session.fallbackAgentIds = [fallback.id]
    await h.seed()
    const failure = { ...classifyProviderFailure('Credits exhausted', 'turn_failed'), intentId: h.row().intentId }
    await h.internal.tryProviderRecovery('thread', h.session, failure)
    expect(h.row().nextRetryAt).toBe(Date.now())
    vi.spyOn(h.internal, 'startAdapterSession').mockImplementation(async () => {
      h.register(h.internal, 'fallback-thread', fallback.id)
      return 'fallback-thread'
    })
    await h.retry()
    expect(h.row().agentId).toBe(fallback.id)
    expect(h.adapter.sendPrompt).toHaveBeenCalledTimes(2)
  })

  it.each(['unsafe', 'irreversible', 'manual-stop', 'approval-required'])('does not replay work labelled %s', async (label) => {
    const h = fixture()
    await h.seed()
    h.db.updateTask(h.task.id, { labels: [label] })
    await h.failTurn()
    expect(h.row().state).toBe('failed')
    expect(h.adapter.sendPrompt).toHaveBeenCalledOnce()
  })

  it('cancels backoff on manual abort, and fences a stale retry', async () => {
    const h = fixture()
    await h.seed()
    await h.failTurn()
    const stale = h.row()
    await h.manager.abortSession('thread')
    await h.internal.dispatchProviderRecovery(stale)
    expect(h.row().state).toBe('cancelled')
    expect(h.adapter.sendPrompt).toHaveBeenCalledOnce()
  })

  it('does not replay unknown send effects, pending tools, or a stale prior intent', async () => {
    const h = fixture()
    await h.seed()
    const previous = h.row()
    h.adapter.sendPrompt.mockRejectedValueOnce(new Error('connection reset after dispatch'))
    await expect(h.manager.sendMessage('thread', 'Write next task', h.task.id, h.agent.id)).rejects.toThrow('connection reset')
    expect(h.row().state).toBe('failed')
    expect(h.db.db.prepare("SELECT state FROM delivery_outbox WHERE task_id = ?").get(h.task.id)).toEqual({ state: 'failed' })
    await h.internal.sendTrackedPrompt(h.session, 'thread', 'New explicit intent', h.config)
    const current = h.row()
    expect(await h.internal.tryProviderRecovery('thread', h.session, { ...classifyProviderFailure('serverOverloaded', 'turn_failed'), intentId: previous.intentId })).toBe(false)
    expect(h.row()).toEqual(current)
    vi.mocked(h.db.getTranscriptParts).mockReturnValue([{ partType: 'tool', tool: { name: 'write_file', status: 'running' } }] as never)
    await h.failTurn()
    expect(h.row().state).toBe('failed')
    expect(h.adapter.sendPrompt).toHaveBeenCalledTimes(3)
  })

  it('does not recover a previous accepted intent from a rejected config RPC', async () => {
    const h = fixture()
    await h.seed()
    const previous = h.row()
    vi.mocked(h.internal.buildSessionConfig).mockRejectedValueOnce(providerFailureError('serverOverloaded', 'rejected'))
    await expect(h.manager.sendMessage('thread', 'New request', h.task.id, h.agent.id)).rejects.toThrow()
    expect(h.row()).toEqual(previous)
    expect(h.adapter.sendPrompt).toHaveBeenCalledOnce()
  })
})
