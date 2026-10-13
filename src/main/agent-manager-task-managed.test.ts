/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from './agent-manager-core'
import type { AgentManagerHost } from './agent-manager/host'
import { MessagePartType, SessionStatusType, type AdapterContextUsage, type AdapterTokenUsage, type SessionConfig } from './adapters/coding-agent-adapter'
import type { AdapterCompactionObservation } from './sessions/compaction'
import { isManagedTask } from './sessions/roles/task'
import { TaskStatus } from '../shared/constants'

vi.mock('./agent-manager/workspace-docs', async original => ({
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
  const db = createPortableTestDb(); databases.push(db)
  if (enabled) db.setSetting('sessions.task_managed', 'true')
  const agent = db.createAgent({ name: 'Task agent', config: { coding_agent: 'codex', model: 'gpt-4o' } })!
  const task = db.createTask({ title: 'Continue existing work' })!
  db.updateTask(task.id, { agent_id: agent.id })
  const adapter = Object.assign(new FakeAdapter({ status: SessionStatusType.BUSY, sessionIds: ['backend-one', 'backend-two'] }), {
    getUsage: vi.fn(async (): Promise<AdapterTokenUsage | null> => null),
    getContextUsage: vi.fn(async (): Promise<AdapterContextUsage | null> => null),
    getCompactionObservations: vi.fn(async (): Promise<AdapterCompactionObservation[]> => [])
  })
  const host: AgentManagerHost = { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' },
    secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => adapter, isCodexAppServerAdapter: () => true }
  function newManager() {
    const manager = new AgentManager(db, host); managers.push(manager)
    const internal = manager as any
    vi.spyOn(internal, 'setupWorktreeIfNeeded').mockResolvedValue('/tmp/task-managed')
    vi.spyOn(internal, 'buildSessionConfig').mockImplementation(async (...args: unknown[]): Promise<SessionConfig> => ({
      agentId: args[0] as string, taskId: args[1] as string, workspaceDir: '/tmp/task-managed', model: 'gpt-4o' }))
    return { manager, internal, poll: () => internal.pollSingleSession(internal.pollingEntries.get(db.getTask(task.id)!.session_id)) }
  }
  return { db, task, agent, adapter, ...newManager(), newManager }
}

describe('optional managed task lifecycle', () => {
  it.each([false, true])('gates task turns and usage independently of Captain management (enabled=%s)', async enabled => {
    const h = fixture(enabled)
    const backend = await h.manager.startSession(h.agent.id, h.task.id, '/tmp/task-managed', true)
    await h.manager.sendMessage(backend, 'Inspect completed actions and continue', h.task.id, h.agent.id)
    h.adapter.enqueueParts({ id: 'answer', type: MessagePartType.TEXT, role: 'assistant', text: 'Partial answer' })
    await h.poll()
    expect(h.adapter.sendPrompt).toHaveBeenCalledOnce()
    expect(h.db.db.prepare('SELECT COUNT(*) AS count FROM session_turn_usage').get()).toEqual({ count: enabled ? 1 : 0 })
    if (enabled) expect(h.db.db.prepare('SELECT input_source, output_source, output_tokens FROM session_turn_usage').get())
      .toMatchObject({ input_source: 'estimated', output_source: 'estimated', output_tokens: 4 })
    expect(h.adapter.getUsage).toHaveBeenCalledTimes(enabled ? 1 : 0)
    await h.manager.abortSession(backend)
    if (enabled) {
      expect(h.db.db.prepare('SELECT state FROM session_turn_usage').get()).toEqual({ state: 'cancelled' })
      expect(h.db.db.prepare('SELECT state FROM session_turns').get()).toEqual({ state: 'cancelled' })
    }
  })

  it('records actual context occupancy separately from aggregate billing and keeps compaction on the same native generation', async () => {
    const h = fixture()
    const backend = await h.manager.startSession(h.agent.id, h.task.id, '/tmp/task-managed', true)
    await h.manager.sendMessage(backend, 'Continue safely', h.task.id, h.agent.id)
    const config = h.adapter.sendPrompt.mock.calls[0][2]
    const intent = config.providerIntentId!
    h.adapter.getUsage.mockResolvedValue({ inputTokens: 10_000, outputTokens: 30, provenance: 'reported', turnId: intent })
    h.adapter.getContextUsage.mockResolvedValue({ backendSessionId: backend, eventKey: 'input-one', tokens: 500,
      provenance: 'reported', observedAt: Date.now(), turnId: intent })
    h.adapter.getCompactionObservations.mockResolvedValue([{ backendSessionId: backend, backend: 'codex', eventKey: 'compact-one',
      source: 'explicit', signal: 'contextCompaction', observedAt: Date.now(), beforeTokens: 2000, afterTokens: 500 }])
    await h.poll(); await h.poll()
    expect(h.db.db.prepare('SELECT input_tokens, output_tokens, input_source FROM session_turn_usage').get())
      .toEqual({ input_tokens: 10_000, output_tokens: 30, input_source: 'reported' })
    const occupancy = h.db.db.prepare("SELECT payload FROM session_lifecycle_events WHERE event_type='context_usage'").get() as { payload: string }
    expect(JSON.parse(occupancy.payload)).toMatchObject({ tokens: 500, source: 'reported' })
    expect(h.db.getTranscriptParts(h.task.id).filter(part => part.partType === 'compaction')).toHaveLength(1)
    expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM session_lifecycle_events WHERE event_type='compaction'").get()).toEqual({ count: 1 })
    expect(h.adapter.createSession).toHaveBeenCalledOnce()
    expect(h.adapter.sendPrompt).toHaveBeenCalledOnce()
  })

  it('reconnects persisted task context without replay and preserves unknown transport failure as a recovery boundary', async () => {
    const h = fixture()
    const backend = await h.manager.startSession(h.agent.id, h.task.id, '/tmp/task-managed', true)
    await h.manager.sendMessage(backend, 'Do not replay completed work', h.task.id, h.agent.id)
    await h.manager.stopAllSessions()
    const restarted = h.newManager()
    await restarted.manager.resumeSession(h.agent.id, h.task.id, backend)
    expect(h.adapter.createSession).toHaveBeenCalledOnce()
    expect(h.adapter.sendPrompt).toHaveBeenCalledOnce()
    expect(h.db.db.prepare('SELECT state FROM session_turn_usage').get()).toEqual({ state: 'interrupted' })
    h.adapter.sendPrompt.mockRejectedValueOnce(new Error('ECONNRESET after unknown delivery'))
    await expect(restarted.manager.sendMessage(backend, 'A new explicit instruction', h.task.id, h.agent.id)).rejects.toThrow()
    expect(h.adapter.sendPrompt).toHaveBeenCalledTimes(2)
    expect(restarted.internal.providerRecoveries.get(h.task.id))
      .toMatchObject({ state: 'failed', delivery: 'unknown' })
  })

  it('retains lost-session continuity and seeds only the next accepted human instruction', async () => {
    const h = fixture()
    h.db.updateTask(h.task.id, { session_id: 'lost-backend' })
    h.internal.persistTranscriptEvent('agent:output', { sessionId: 'lost-backend', taskId: h.task.id, type: 'message',
      data: { id: 'completed-action', role: 'assistant', content: 'The file was written. Inspect it before repeating the operation.', partType: 'text' } })
    h.adapter.resumeSession.mockRejectedValueOnce(new Error('SESSION_FILE_NOT_FOUND'))
    await expect(h.manager.resumeSession(h.agent.id, h.task.id, 'lost-backend')).rejects.toThrow('SESSION_INCOMPATIBLE')
    expect(h.adapter.createSession).not.toHaveBeenCalled()
    expect(h.adapter.sendPrompt).not.toHaveBeenCalled()
    const backend = await h.manager.startSession(h.agent.id, h.task.id, '/tmp/task-managed', true)
    expect(h.db.getTranscriptParts(h.task.id).some(part => part.partId.startsWith('session-loss-ack-'))).toBe(false)
    expect(h.adapter.sendPrompt).not.toHaveBeenCalled()
    await h.manager.sendMessage(backend, 'Verify the file and continue unfinished work', h.task.id, h.agent.id)
    expect(h.adapter.sendPrompt).toHaveBeenCalledOnce()
    const sent = h.adapter.sendPrompt.mock.calls[0][1][0].text!
    expect(sent).toContain('The file was written')
    expect(sent).toContain('Verify the file and continue unfinished work')
    expect(sent).toContain('do not repeat completed actions')
    expect(h.db.getTranscriptParts(h.task.id).some(part => part.partId.startsWith('session-loss-ack-'))).toBe(true)
    const source = h.db.db.prepare("SELECT payload FROM session_lifecycle_events WHERE event_type='recap_prepared' LIMIT 1").get() as { payload: string }
    expect(JSON.parse(source.payload)).toMatchObject({ source: 'estimated', losslessSource: 'transcript_parts', sourcePartIds: ['completed-action'] })
  })

  it('refuses an oversized protected switch instruction before stopping the outgoing session', async () => {
    const h = fixture()
    const backend = await h.manager.startSession(h.agent.id, h.task.id, '/tmp/task-managed', true)
    h.internal.persistTranscriptEvent('agent:output', { sessionId: backend, taskId: h.task.id, type: 'message',
      data: { id: 'protected', role: 'user', content: 'Exact protected instruction '.repeat(3000), partType: 'text' } })
    const other = h.db.createAgent({ name: 'Other', config: { coding_agent: 'codex', model: 'gpt-4o' } })!
    await expect(h.manager.switchAgent(h.task.id, other.id)).rejects.toThrow('TASK_RECAP_INSTRUCTION_TOO_LARGE')
    expect(h.db.getTask(h.task.id)?.agent_id).toBe(h.agent.id)
    expect(h.db.getTask(h.task.id)?.session_id).toBe(backend)
    expect(h.adapter.destroySession).not.toHaveBeenCalled()
    expect(h.adapter.createSession).toHaveBeenCalledOnce()
    expect(h.db.getTranscriptParts(h.task.id).find(part => part.partId === 'protected')?.content).toBe('Exact protected instruction '.repeat(3000))
  })

  it('does not charge a stale poll batch to a newer intent on the same native session', async () => {
    const h = fixture()
    const backend = await h.manager.startSession(h.agent.id, h.task.id, '/tmp/task-managed', true)
    await h.manager.sendMessage(backend, 'First intent', h.task.id, h.agent.id)
    let finish!: (parts: Array<{ id: string; type: MessagePartType; role: 'assistant'; text: string }>) => void
    h.adapter.pollMessages.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = h.poll()
    await h.manager.sendMessage(backend, 'Second intent', h.task.id, h.agent.id)
    finish([{ id: 'previous-turn-answer', type: MessagePartType.TEXT, role: 'assistant', text: 'Old output must not become new billed output' }])
    await pending
    expect(h.adapter.getUsage).not.toHaveBeenCalled()
    expect(h.db.db.prepare('SELECT output_tokens, output_source FROM session_turn_usage').all())
      .toEqual([{ output_tokens: 0, output_source: 'estimated' }, { output_tokens: 0, output_source: 'estimated' }])
    expect(h.db.getTranscriptParts(h.task.id).some(part => part.partId === 'previous-turn-answer')).toBe(true)
    expect(h.adapter.sendPrompt).toHaveBeenCalledTimes(2)
  })

  it('never opts Captain, heartbeat, missing or triage rows into the real-task role', () => {
    const h = fixture()
    const row = h.db.getTask(h.task.id)!
    expect(isManagedTask(row.id, row, true)).toBe(true)
    expect(isManagedTask(row.id, { ...row, role: 'captain' }, true)).toBe(false)
    expect(isManagedTask(row.id, { ...row, status: TaskStatus.Triaging }, true)).toBe(false)
    expect(isManagedTask(row.id, { ...row, agent_id: null }, true)).toBe(false)
    expect(isManagedTask(`heartbeat-${row.id}`, row, true)).toBe(false)
    expect(isManagedTask(`triage-${row.id}`, row, true)).toBe(false)
    expect(isManagedTask('missing', undefined, true)).toBe(false)
    expect(isManagedTask(row.id, row, false)).toBe(false)
  })
})
