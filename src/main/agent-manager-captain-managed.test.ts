/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from './agent-manager-core'
import type { AgentManagerHost } from './agent-manager/host'
import { MessageRole, MessagePartType, SessionStatusType, type MessagePart, type SessionConfig } from './adapters/coding-agent-adapter'
import { LOST_SESSION_NOTICE } from './agent-handoff'
import { withSessionOwnerLock } from './sessions/managed-session'

vi.mock('./agent-manager/workspace-docs', async (original) => ({
  ...await original<typeof import('./agent-manager/workspace-docs')>(), writeSkillFiles: vi.fn(async () => undefined)
}))

const managers: AgentManager[] = []
const databases: ReturnType<typeof createPortableTestDb>[] = []
beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }))
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stopAllSessions()
  for (const db of databases.splice(0)) db.close()
  vi.useRealTimers(); vi.restoreAllMocks()
})

function fixture(enabled = true) {
  const db = createPortableTestDb()
  databases.push(db)
  if (enabled) db.setSetting('sessions.captain_managed', 'true')
  const agent = db.createAgent({ name: 'Codex', config: { coding_agent: 'codex', model: 'gpt-4o' } })!
  const project = db.createProject({ name: 'Managed project', captain_agent_id: agent.id })!
  const task = db.getCoordinatorTask(project.id)!
  const adapter = new FakeAdapter({ status: SessionStatusType.IDLE, sessionIds: ['first-backend', 'replacement-backend'] })
  const host: AgentManagerHost = { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' },
    secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => adapter, isCodexAppServerAdapter: () => true }
  function newManager() {
    const manager = new AgentManager(db, host)
    managers.push(manager)
    const internal = manager as any
    vi.spyOn(internal, 'setupWorktreeIfNeeded').mockResolvedValue('/tmp/managed-captain')
    vi.spyOn(internal, 'buildSessionConfig').mockImplementation(async (...args: unknown[]): Promise<SessionConfig> => ({
      agentId: args[0] as string, taskId: args[1] as string, workspaceDir: '/tmp/managed-captain', model: 'gpt-4o' }))
    const events = vi.spyOn(internal, 'sendToRenderer')
    return { manager, internal, events }
  }
  return { db, task, agent, adapter, ...newManager(), newManager }
}

describe('Captain managed lifecycle integration', () => {
  it.each([false, true])('routes Captain starts and wake deliveries behind the flag (enabled=%s)', async (enabled) => {
    const h = fixture(enabled)
    const backendId = await h.manager.startSession(h.agent.id, h.task.id, '/tmp/managed-captain', true)
    expect(backendId).toBe('first-backend')
    await h.manager.deliverCaptainWake(backendId, 'Review the new project event', h.task.id, h.agent.id, 'stable-wake', 1)
    if (enabled) await h.manager.deliverCaptainWake(backendId, 'Review the new project event', h.task.id, h.agent.id, 'stable-wake', 1)
    expect(h.adapter.sendPrompt).toHaveBeenCalledOnce()
    await h.manager.stopAllSessions()
    expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM session_lifecycle_events WHERE event_type='session_started'").get()).toEqual({ count: enabled ? 1 : 0 })
    expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM session_lifecycle_events WHERE event_type='wake_received'").get()).toEqual({ count: enabled ? 1 : 0 })
    if (enabled) {
      expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM delivery_outbox WHERE idempotency_key='stable-wake' AND state='acknowledged'").get()).toEqual({ count: 1 })
      expect(h.db.db.prepare('SELECT state FROM session_turns').get()).toEqual({ state: 'interrupted' })
    }
  })

  it('reconnects a Captain with its native backend history and no prompt replay', async () => {
    const h = fixture()
    const backendId = await h.manager.startSession(h.agent.id, h.task.id, '/tmp/managed-captain', true)
    await h.manager.stopAllSessions()
    const restarted = h.newManager()
    const history = [{ id: 'saved-answer', role: MessageRole.ASSISTANT, parts: [{ id: 'saved-part', type: MessagePartType.TEXT, text: 'Saved work' }] }]
    h.adapter.setHistory(history)
    expect(await restarted.manager.startSession(h.agent.id, h.task.id, '/tmp/managed-captain', true)).toBe(backendId)
    expect(h.adapter.createSession).toHaveBeenCalledOnce()
    expect(h.adapter.resumeSession).toHaveBeenCalledOnce()
    expect(h.adapter.sendPrompt).not.toHaveBeenCalled()
    expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM session_lifecycle_events WHERE event_type='session_resumed'").get()).toEqual({ count: 1 })
  })

  it('seeds a replacement from lost-session history and acknowledges its recap only after accepted wake delivery', async () => {
    const h = fixture()
    h.db.updateTask(h.task.id, { session_id: 'lost-backend' })
    h.db.setSetting(`captain_session_agent:${h.task.id}`, h.agent.id)
    h.internal.persistTranscriptEvent('agent:output', { sessionId: 'lost-backend', taskId: h.task.id, type: 'message',
      data: { id: 'completed-action', role: 'assistant', content: 'The previous task was started. Inspect it before starting anything again.', partType: 'text' } })
    h.adapter.resumeSession.mockRejectedValueOnce(new Error('SESSION_FILE_NOT_FOUND'))
    const replacement = await h.manager.startSession(h.agent.id, h.task.id, '/tmp/managed-captain', true)
    expect(replacement).toBe('first-backend')
    expect(h.adapter.sendPrompt).not.toHaveBeenCalled()
    expect(h.events.mock.calls.some((call: unknown[]) => JSON.stringify(call).includes(LOST_SESSION_NOTICE))).toBe(true)
    const before = h.db.getTranscriptParts(h.task.id)
    expect(before.some((part) => part.partId.startsWith('session-loss-ack-'))).toBe(false)
    await h.manager.deliverCaptainWake(replacement, 'Review the current state', h.task.id, h.agent.id, 'after-loss', 1)
    expect(h.adapter.sendPrompt.mock.calls[0][1][0].text).toContain('The previous task was started')
    expect(h.adapter.sendPrompt.mock.calls[0][1][0].text).toContain('Review the current state')
    expect(h.db.getTranscriptParts(h.task.id).some((part) => part.partId.startsWith('session-loss-ack-'))).toBe(true)
    expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM session_lifecycle_events WHERE event_type='replacement_seeded'").get()).toEqual({ count: 1 })
  })

  it('preserves a transport-failed resume binding rather than manufacturing a blank replacement', async () => {
    const h = fixture()
    h.db.updateTask(h.task.id, { session_id: 'saved-backend' })
    h.db.setSetting(`captain_session_agent:${h.task.id}`, h.agent.id)
    h.adapter.resumeSession.mockRejectedValueOnce(new Error('ECONNRESET'))
    await expect(h.manager.startSession(h.agent.id, h.task.id, '/tmp/managed-captain', true)).rejects.toThrow('ECONNRESET')
    expect(h.db.getTask(h.task.id)?.session_id).toBe('saved-backend')
    expect(h.adapter.createSession).not.toHaveBeenCalled()
    expect(h.adapter.sendPrompt).not.toHaveBeenCalled()
  })

  it('drops and audits an in-flight batch after a manual stop, without publishing its tool output', async () => {
    const h = fixture()
    const backendId = await h.manager.startSession(h.agent.id, h.task.id, '/tmp/managed-captain', true)
    let resolve!: (parts: MessagePart[]) => void
    h.adapter.pollMessages.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const entry = h.internal.pollingEntries.get(backendId)
    const polling = h.internal.pollSingleSession(entry)
    try {
      await Promise.resolve()
      await h.manager.stopSession(backendId)
      h.events.mockClear()
      resolve([{ id: 'late-tool', type: MessagePartType.TOOL, tool: { name: 'start_task', status: 'completed', output: 'Old output' } }])
      await polling
      expect(h.events.mock.calls.some((call: unknown[]) => JSON.stringify(call).includes('Old output'))).toBe(false)
      const row = h.db.db.prepare("SELECT payload FROM session_lifecycle_events WHERE event_type='stale_batch_dropped'").get() as { payload: string }
      expect(JSON.parse(row.payload)).toMatchObject({ disposition: 'superseded_or_stopped', count: 1, partIds: ['late-tool'] })
      expect(h.manager.findSessionByTaskId(h.task.id)).toBeUndefined()
    } finally { resolve?.([]); await polling }
  })

  it('records actual context occupancy once without treating cumulative billing as context', async () => {
    const h = fixture()
    const backendId = await h.manager.startSession(h.agent.id, h.task.id, '/tmp/managed-captain', true)
    const context = { backendSessionId: backendId, eventKey: 'input-1', tokens: 1024, provenance: 'reported' as const, observedAt: Date.now() }
    const getContextUsage = vi.fn(async () => context)
    const adapter = Object.assign(h.adapter, { getContextUsage, getUsage: vi.fn(async () => ({ inputTokens: 99999, outputTokens: 100, provenance: 'reported' as const })) })
    const session = h.manager.findSessionByTaskId(h.task.id)!.session
    const config: SessionConfig = { agentId: h.agent.id, taskId: h.task.id, workspaceDir: '/tmp/managed-captain', model: 'gpt-4o' }
    await h.internal.pollCaptainContextUsage(backendId, session, adapter, config)
    await h.internal.pollCaptainContextUsage(backendId, session, adapter, config)
    const rows = h.db.db.prepare("SELECT payload FROM session_lifecycle_events WHERE event_type='context_usage'").all() as Array<{ payload: string }>
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0].payload)).toMatchObject({ tokens: 1024, source: 'reported', contextWindow: 128000 })
    expect(adapter.getUsage).not.toHaveBeenCalled()
  })

  it('records a wake as excluded after manual stop and never reopens its backend', async () => {
    const h = fixture()
    const backendId = await h.manager.startSession(h.agent.id, h.task.id, '/tmp/managed-captain', true)
    await h.manager.stopByTaskId(h.task.id)
    await h.manager.deliverCaptainWake('', 'Automatic project update', h.task.id, h.agent.id, 'wake-after-stop', 1)
    expect(h.adapter.createSession).toHaveBeenCalledOnce()
    expect(h.adapter.sendPrompt).not.toHaveBeenCalled()
    expect(h.manager.findSessionByTaskId(h.task.id)).toBeUndefined()
    expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM session_lifecycle_events WHERE event_type='wake_disposition' AND payload LIKE '%excluded%'").get()).toEqual({ count: 1 })
    expect(h.db.getTask(h.task.id)?.session_id).toBe(backendId)
  })

  it('keeps manual abort terminal state cancelled rather than counting it as completed', async () => {
    const h = fixture()
    const backendId = await h.manager.startSession(h.agent.id, h.task.id, '/tmp/managed-captain', true)
    await h.manager.deliverCaptainWake(backendId, 'Handle this event', h.task.id, h.agent.id, 'abort-wake', 1)
    await h.manager.abortSession(backendId)
    expect(h.db.db.prepare('SELECT state, stop_reason FROM session_turns').get()).toEqual({ state: 'cancelled', stop_reason: 'cancelled' })
    expect(h.adapter.abortPrompt).toHaveBeenCalledOnce()
    expect(h.adapter.sendPrompt).toHaveBeenCalledOnce()
  })

  it('commits wake receipt and send intent atomically before projection, then fences a stop during that wait', async () => {
    const h = fixture()
    const backendId = await h.manager.startSession(h.agent.id, h.task.id, '/tmp/managed-captain', true)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const blocking = withSessionOwnerLock(h.db.db, h.task.id, () => gate)
    const wake = h.manager.deliverCaptainWake(backendId, 'Do not lose this wake', h.task.id, h.agent.id, 'atomic-wake', 1)
    try {
      expect(h.db.db.prepare("SELECT state FROM session_event_inbox WHERE idempotency_key='atomic-wake:received'").get()).toEqual({ state: 'pending' })
      expect(h.db.db.prepare("SELECT state FROM delivery_outbox WHERE idempotency_key='atomic-wake'").get()).toEqual({ state: 'pending' })
      const stopping = h.manager.stopByTaskId(h.task.id)
      release(); await blocking; await stopping; await wake
      expect(h.adapter.sendPrompt).not.toHaveBeenCalled()
      expect(h.db.db.prepare("SELECT state FROM delivery_outbox WHERE idempotency_key='atomic-wake'").get()).toEqual({ state: 'cancelled' })
    } finally { release(); await blocking; await wake }
  })
})
