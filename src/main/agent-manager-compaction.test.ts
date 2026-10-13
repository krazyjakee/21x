import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { AgentManager } from './agent-manager-core'
import type { AgentManagerHost } from './agent-manager/host'
import { SessionStatusType, type CodingAgentAdapter, type SessionConfig } from './adapters/coding-agent-adapter'
import type { AdapterCompactionObservation } from './sessions/compaction'

const databases: ReturnType<typeof createPortableTestDb>[] = []
const managers: AgentManager[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stopAllSessions()
  for (const db of databases.splice(0)) db.close()
  vi.restoreAllMocks()
})

function fixture() {
  const db = createPortableTestDb()
  databases.push(db)
  db.setSetting('sessions.ledger', 'observe')
  const agent = db.createAgent({ name: 'Codex', config: { coding_agent: 'codex' } })!
  const task = db.createTask({ title: 'Review checkout' })!
  db.updateTask(task.id, { agent_id: agent.id })
  const observation: AdapterCompactionObservation = { backendSessionId: 'backend-1', backend: 'codex', eventKey: 'compaction-item-1',
    source: 'explicit', signal: 'contextCompaction', observedAt: Date.now() }
  const adapter = {
    initialize: vi.fn(async () => {}), checkHealth: vi.fn(async () => ({ available: true })),
    createSession: vi.fn(async () => 'backend-1'), resumeSession: vi.fn(async () => []), sendPrompt: vi.fn(async () => {}),
    pollMessages: vi.fn(async () => []), getStatus: vi.fn(async () => ({ type: SessionStatusType.BUSY })),
    getCompactionObservations: vi.fn(async () => [observation]), abortPrompt: vi.fn(async () => {}), destroySession: vi.fn(async () => {})
  }
  const host: AgentManagerHost = {
    renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' },
    secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' },
    createAdapter: () => adapter as CodingAgentAdapter, isCodexAppServerAdapter: () => true
  }
  const config: SessionConfig = { taskId: task.id, agentId: agent.id, workspaceDir: '/tmp/compaction-proof' }
  function register() {
    const manager = new AgentManager(db, host)
    managers.push(manager)
    const internal = manager as unknown as {
      sessions: Map<string, unknown>; pollingEntries: Map<string, unknown>;
      startAdapterPolling(id: string, adapter: unknown, config: SessionConfig, session: unknown): void;
      ensurePollingCoordinator(): void; handleBusyStatus(): Promise<void>;
      pollSingleSession(entry: unknown): Promise<void>; pollCompactions(id: string, session: unknown, adapter: unknown, config: SessionConfig): Promise<void>
    }
    vi.spyOn(internal, 'ensurePollingCoordinator').mockImplementation(() => {})
    vi.spyOn(internal, 'handleBusyStatus').mockResolvedValue()
    const session = { id: 'backend-1', agentId: agent.id, taskId: task.id, status: 'working', createdAt: new Date(),
      seenMessageIds: new Set<string>(), seenPartIds: new Set<string>(), partContentLengths: new Map<string, string>(), adapter }
    internal.sessions.set('backend-1', session)
    internal.startAdapterPolling('backend-1', adapter, config, session)
    const poll = () => internal.pollSingleSession(internal.pollingEntries.get('backend-1'))
    return { manager, internal, session, poll }
  }
  return { db, task, observation, adapter, config, register, ...register() }
}

describe('compaction projection through the production agent poll', () => {
  it('records one durable divider and ledger event without replacing or sending into the backend', async () => {
    const h = fixture()
    h.db.setSetting('sessions.ledger', 'false')
    await h.poll()
    await h.poll()
    expect(h.db.getTranscriptParts(h.task.id).filter(p => p.partType === 'compaction')).toHaveLength(1)
    expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM session_lifecycle_events WHERE event_type='compaction'").get()).toEqual({ count: 1 })
    expect(h.internal.sessions.get('backend-1')).toBe(h.session)
    expect(h.adapter.createSession).not.toHaveBeenCalled()
    expect(h.adapter.sendPrompt).not.toHaveBeenCalled()
  })

  it('retries failed durable projection and preserves its original divider across reconnect', async () => {
    const h = fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(h.db, 'upsertTranscriptParts').mockImplementationOnce(() => { throw new Error('SQLite write failed') })
    await h.poll()
    expect(h.db.getTranscriptParts(h.task.id)).toHaveLength(0)
    await h.poll()
    const original = h.db.getTranscriptParts(h.task.id)
    expect(original).toHaveLength(1)
    await h.manager.stopAllSessions()
    const restarted = h.register()
    h.adapter.getCompactionObservations.mockResolvedValue([{ ...h.observation, observedAt: h.observation.observedAt + 1000, afterTokens: 100 }])
    await restarted.poll()
    expect(h.db.getTranscriptParts(h.task.id)).toEqual(original)
    expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM session_lifecycle_events WHERE event_type='compaction'").get()).toEqual({ count: 1 })
  })

  it('rejects another backend session and fences late snapshot reads after runtime replacement', async () => {
    const h = fixture()
    h.adapter.getCompactionObservations.mockResolvedValue([{ ...h.observation, backendSessionId: 'old-session' }])
    await h.poll()
    expect(h.db.getTranscriptParts(h.task.id)).toHaveLength(0)
    let finish!: (observations: AdapterCompactionObservation[]) => void
    h.adapter.getCompactionObservations.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = h.internal.pollCompactions('backend-1', h.session, h.adapter, h.config)
    h.internal.sessions.set('backend-1', { ...h.session, createdAt: new Date() })
    const sql = vi.spyOn(h.db.db, 'prepare')
    finish([h.observation])
    await pending
    expect(sql).not.toHaveBeenCalled()
    sql.mockRestore()
    expect(h.db.getTranscriptParts(h.task.id)).toHaveLength(0)
  })
})
