import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { AgentManager } from '../../src/main/agent-manager-core'
import type { AgentManagerHost } from '../../src/main/agent-manager/host'
import { assembleSessionConfig, buildMcpServers } from '../../src/main/agent-manager/session-config-core'
import { DatabaseManager } from '../../src/main/database/manager'
import { configureSecretStorage } from '../../src/main/platform/secret-storage'
import { DeterministicAgentAdapter } from '../../src/service/fixtures/deterministic-agent-adapter'
import { TaskStatus } from '../../src/shared/constants'

// The fixture needs no credential access; any accidental access fails closed.
const deniedStorage = {
  isEncryptionAvailable: () => false,
  encryptString(): never { throw new Error('Fixture credential access forbidden') },
  decryptString(): never { throw new Error('Fixture credential access forbidden') }
}

export class AgentLifecycleProofError extends Error {
  constructor(public readonly phase: string) { super('Synthetic agent lifecycle proof failed') }
}

export async function runAgentLifecycleFixture(directory: string) {
  assert.equal(process.versions.electron, undefined)
  configureSecretStorage(deniedStorage)
  const paths = { profileRoot: join(directory, 'profile'), workspaceRoot: join(directory, 'workspaces'), attachmentRoot: join(directory, 'attachments') }
  mkdirSync(paths.profileRoot)
  const options = { paths, managedTaskMcp: { disabled: true } as const, logger: { log() {}, error() {} } }
  const deadline = Date.now() + 30_000
  let phase = 'initialize'
  let db: DatabaseManager | undefined
  let manager: AgentManager | undefined
  let durableEventObserved = false
  let eventPersistedBeforeDelivery = true
  let waitingEventObserved = false
  let eventCount = 0
  let ownershipRestored = false
  let removedListenerCalls = 0
  const host = (adapter: DeterministicAgentAdapter): AgentManagerHost => ({
    renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' },
    secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' },
    createAdapter: backend => backend === 'opencode' ? adapter : null,
    isCodexAppServerAdapter: () => false
  })
  const listen = (owner: AgentManager, database: DatabaseManager): void => {
    owner.addExternalListener((channel, payload) => {
      assert.ok(++eventCount < 512, 'Fixture event bound')
      if (channel === 'agent:status' && payload && typeof payload === 'object' &&
          'status' in payload && payload.status === 'waiting_approval') waitingEventObserved = true
      if (channel !== 'transcript:changed' || !payload || typeof payload !== 'object') return
      const event = payload as { taskId: string; parts: Array<{ partId: string }>; maxRev: number }
      durableEventObserved = true
      eventPersistedBeforeDelivery &&= database.getTranscriptMaxRev(event.taskId) >= event.maxRev &&
        event.parts.every(part => database.getTranscriptParts(event.taskId).some(saved => saved.partId === part.partId))
    })
  }
  const wait = async (ready: () => boolean): Promise<void> => {
    while (!ready()) {
      if (Date.now() >= deadline) throw new AgentLifecycleProofError(phase)
      await delay(25)
    }
  }
  try {
    db = new DatabaseManager(options)
    db.initialize()
    assert.equal(db.getMcpServers().some(server => server.name === 'task-management'), false)
    const agent = db.createAgent({ name: 'Synthetic deterministic agent', config: { coding_agent: 'opencode', permission_mode: 'ask', mcp_servers: [], secret_ids: [] } })!
    const task = db.createTask({ title: 'Synthetic lifecycle fixture', status: TaskStatus.NotStarted })!
    // Assignment uses the actual update API; createTask does not set agent_id.
    db.updateTask(task.id, { agent_id: agent.id })
    const adapter = new DeterministicAgentAdapter({ fixtureMode: 'synthetic-only', profileRoot: paths.profileRoot })
    assert.throws(() => new AgentManager(db!, undefined as never))
    const policy = host(adapter)
    assert.throws(() => assembleSessionConfig(db!, { ...agent, config: { ...agent.config, api_keys: { openai: 'synthetic-denied' } } }, {
      agentId: agent.id, taskId: task.id, workspaceDir: db!.getWorkspaceDir(task.id), mcpServers: {}
    }, policy))
    const configured = db.createAgent({ name: 'Synthetic disallowed MCP agent', config: { mcp_servers: ['synthetic-server'] } })!
    await assert.rejects(buildMcpServers(db, null, configured.id, undefined, policy))
    manager = new AgentManager(db, policy)
    const detached = (): void => { removedListenerCalls++ }
    manager.addExternalListener(detached)
    manager.removeExternalListener(detached)
    manager.removeExternalListener(detached)
    listen(manager, db)
    phase = 'start'
    const start = await manager.requestSession(agent.id, task.id)
    assert.equal(start.status, 'started')
    assert.ok('sessionId' in start)
    const sessionId = start.sessionId
    assert.equal(db.getTask(task.id)?.session_id, sessionId)

    phase = 'approval-request'
    const requestOne = 'fixture-approval-1'
    await wait(() => manager!.getSessionStatus(sessionId)?.status === 'waiting_approval' &&
      db!.getTranscriptParts(task.id).some(part => part.partId === `question-${requestOne}` &&
        (part.tool as { requestId?: string; status?: string })?.requestId === requestOne && (part.tool as { status?: string }).status === 'running'))
    assert.equal(waitingEventObserved, true)
    assert.deepEqual(adapter.getPendingApprovalIdentity(sessionId), { requestId: requestOne, taskId: task.id, agentId: agent.id })
    phase = 'stale-approval'
    await manager.respondToPermission(sessionId, true, undefined, 'approved', 'permission', 'fixture-stale-request')
    assert.deepEqual(adapter.decisions(), [])
    assert.deepEqual(adapter.getPendingApprovalIdentity(sessionId), { requestId: requestOne, taskId: task.id, agentId: agent.id })
    assert.equal(manager.getSessionStatus(sessionId)?.status, 'waiting_approval')
    assert.equal((db.getTranscriptParts(task.id).find(part => part.partId === `question-${requestOne}`)?.tool as { status?: string }).status, 'running')

    phase = 'approved-branch'
    await manager.respondToPermission(sessionId, true, undefined, 'approved', 'permission', requestOne)
    await wait(() => db!.getTask(task.id)?.status === TaskStatus.ReadyForReview &&
      db!.getTranscriptParts(task.id).some(part => part.partId === `result-${requestOne}` && part.content === 'Applied the approved synthetic change.'))
    assert.deepEqual(adapter.decisions(), [{ requestId: requestOne, approved: true }])
    const before = await manager.getTranscriptSnapshot(task.id)
    const cursor = db.getTranscriptMaxRev(task.id)
    assert.ok(cursor > 0)
    assert.ok(before.some(part => part.partId === `question-${requestOne}` && (part.tool as { status?: string })?.status === 'completed'))

    phase = 'recreate-owner'
    await manager.stopAllSessions()
    assert.equal(adapter.destroyed, 1)
    // The manager's projection flush is intentionally coalesced for 125ms.
    await delay(200)
    db.close()
    db = new DatabaseManager(options)
    db.initialize()
    assert.equal(db.getTask(task.id)?.session_id, sessionId)
    assert.deepEqual(db.getTranscriptParts(task.id), before)
    const resumedAdapter = new DeterministicAgentAdapter({ fixtureMode: 'synthetic-only', profileRoot: paths.profileRoot })
    manager = new AgentManager(db, host(resumedAdapter))
    listen(manager, db)
    assert.equal(await manager.resumeSession(agent.id, task.id, sessionId), sessionId)
    assert.equal(resumedAdapter.resumes, 1)
    ownershipRestored = manager.getSessionStatus(sessionId)?.taskId === task.id
    assert.deepEqual(await manager.getTranscriptSnapshot(task.id), before)
    assert.deepEqual((await manager.getTranscriptDelta(task.id, cursor)).parts, [])

    phase = 'rejected-branch'
    await manager.sendMessage(sessionId, 'Try a second synthetic action', task.id)
    const requestTwo = 'fixture-approval-2'
    await wait(() => manager!.getSessionStatus(sessionId)?.status === 'waiting_approval' &&
      db!.getTranscriptParts(task.id).some(part => part.partId === `question-${requestTwo}` && (part.tool as { requestId?: string })?.requestId === requestTwo))
    await manager.respondToPermission(sessionId, false, undefined, 'abort', 'permission', requestTwo)
    await wait(() => db!.getTask(task.id)?.status === TaskStatus.ReadyForReview &&
      db!.getTranscriptParts(task.id).some(part => part.partId === `result-${requestTwo}` && part.content === 'Did not apply the rejected synthetic change.'))
    assert.deepEqual(resumedAdapter.decisions(), [{ requestId: requestOne, approved: true }, { requestId: requestTwo, approved: false }])
    const delta = await manager.getTranscriptDelta(task.id, cursor)
    assert.ok(delta.maxRev > cursor)
    assert.ok(delta.parts.some(part => part.partId === `question-${requestTwo}` && (part.tool as { status?: string })?.status === 'cancelled'))
    assert.equal(delta.parts.some(part => part.partId === `result-${requestOne}`), false)
    assert.equal(new Set(db.getTranscriptParts(task.id).map(part => part.partId)).size, db.getTranscriptParts(task.id).length)
    assert.equal(durableEventObserved, true)
    assert.equal(eventPersistedBeforeDelivery, true)
    assert.ok(eventCount < 512)
    assert.equal(removedListenerCalls, 0)
    phase = 'shutdown'
    await manager.stopAllSessions()
    await delay(200)
    assert.equal(resumedAdapter.destroyed, 1)
    assert.equal(manager.getActiveSessionsForTask(task.id).length, 0)
    return { ok: true, actualLifecycleOwner: true, realSqlite: true, standaloneNode: true,
      approvalRequestObserved: true, staleApprovalDenied: true, approvalAccepted: true, approvalRejected: true,
      durableEventsWithoutGui: durableEventObserved, persistedBeforeDelivery: eventPersistedBeforeDelivery,
      databaseReopened: true, ownerRestored: ownershipRestored, transcriptRehydrated: true,
      transcriptDeltaAfterResume: true, sessionStopped: true, noManagedBrowserOrTaskApi: true,
      noBackendSdkParityClaim: true, eventCount }
  } catch { throw new AgentLifecycleProofError(phase) }
  finally {
    await manager?.stopAllSessions()
    await delay(200)
    db?.close()
  }
}
