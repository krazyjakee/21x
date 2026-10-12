import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { AgentManager } from '../../src/main/agent-manager-core'
import type { AgentManagerHost } from '../../src/main/agent-manager/host'
import { DatabaseManager } from '../../src/main/database/manager'
import { acquireProfileLock } from '../../src/main/platform/profile-lock'
import { configureSecretStorage } from '../../src/main/platform/secret-storage'
import { DeterministicAgentAdapter } from '../../src/service/fixtures/deterministic-agent-adapter'
import { AgentBackend } from '../../src/service/agent-backend'
import { AGENT_COMMAND_CODECS, AGENT_EVENT_CODECS, type AgentDesktopOperation } from '../../src/shared/agent-desktop-codecs'
import { ServiceProtocolError, isRecord, type JsonValue } from '../../src/shared/service-protocol'
import type { DesktopCallerContext } from '../../src/service/transport/desktop-registry'

export class AgentDesktopProofError extends Error {
  constructor(readonly phase: string, readonly boundaryCode = 'ASSERTION_FAILED', readonly criticalEvent = 'none') { super('Agent desktop proof failed') }
}

/** Public command/event bridge proof with actual manager, SQLite and adapter. */
export async function runAgentDesktopFixture(directory: string) {
  assert.equal(process.versions.electron, undefined)
  configureSecretStorage({
    isEncryptionAvailable: () => false,
    encryptString(): never { throw new Error('Fixture credential access denied') },
    decryptString(): never { throw new Error('Fixture credential access denied') }
  })
  const profileRoot = join(directory, 'profile')
  mkdirSync(profileRoot)
  const lock = acquireProfileLock(profileRoot)
  const runtime = { paths: { profileRoot: lock.profileRoot, workspaceRoot: join(directory, 'workspaces'), attachmentRoot: join(directory, 'attachments') }, managedTaskMcp: { disabled: true } as const, logger: { log() {}, error() {} } }
  let db = new DatabaseManager(runtime)
  let manager: AgentManager | undefined
  let backend: AgentBackend | undefined
  let phase = 'initialize'
  const deadline = Date.now() + 35_000
  const events: Array<{ operation: string; payload: JsonValue; sequence: number }> = []
  const fatalCodes: string[] = []
  const fatalOperations: string[] = []
  let sequence = 0
  const host = (adapter: DeterministicAgentAdapter): AgentManagerHost => ({
    renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' },
    secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' },
    createAdapter: type => type === 'opencode' ? adapter : null, isCodexAppServerAdapter: () => false
  })
  const wait = async (ready: () => boolean): Promise<void> => {
    while (!ready()) { if (Date.now() >= deadline) throw new AgentDesktopProofError(phase); await delay(25) }
  }
  const controller = new AbortController()
  try {
    db.initialize()
    const agent = db.createAgent({ name: 'Approved fixture agent', config: { coding_agent: 'opencode', permission_mode: 'ask', mcp_servers: [], secret_ids: [], skill_ids: [] } })!
    const unrelatedAgent = db.getAgents().find(row => row.id !== agent.id)!
    const task = db.createTask({ title: 'Approved fixture task' })!
    const foreignProject = db.createProject({ name: 'Foreign fixture project' })!
    const foreignTask = db.createTask({ title: 'Foreign fixture task', project_id: foreignProject.id })!
    let adapter = new DeterministicAgentAdapter({ fixtureMode: 'synthetic-only', profileRoot: lock.profileRoot })
    const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'desktop:1', webviewId: 'main', origin: 'app://fixture' }
    const setup = (epoch: string): AgentBackend => {
      manager = new AgentManager(db, host(adapter))
      return new AgentBackend({
        fixtureMode: 'synthetic-only', database: db, manager, fixtureAdapter: adapter,
        fixtureAgentId: agent.id, fixtureTaskId: task.id, engineEpoch: epoch,
        assertAvailable() { lock.assertHeld(); if (!db.db.open) throw new ServiceProtocolError('DISCONNECTED') },
        isTrustedDesktop: value => value.webviewId === 'main' && value.origin === caller.origin,
        canAccessProject: project => project === task.project_id,
        emit(operation, payload) {
          assert.ok(++sequence <= 256)
          assert.equal(AGENT_EVENT_CODECS[operation].validatePayload(payload), true)
          events.push({ operation, payload, sequence })
        },
        onFatalEvent: (error, operation) => { fatalCodes.push(error.code); fatalOperations.push(operation) }
      })
    }
    backend = setup(caller.engineEpoch)
    async function call(operation: AgentDesktopOperation, args: unknown[], identity = caller, signal = controller.signal): Promise<JsonValue> {
      const payload = AGENT_COMMAND_CODECS[operation].encodeArguments(args as never)
      const result = await backend!.registry.invoke(operation, payload, identity, signal)
      assert.equal(AGENT_COMMAND_CODECS[operation].validateWireResult(result), true)
      assert.ok(isRecord(result) && result.defined === true)
      return result.value as JsonValue
    }
    const reject = (action: Promise<unknown>, code: string) => assert.rejects(action, error => error instanceof ServiceProtocolError && error.code === code)
    phase = 'public-agent-and-scope'
    const publicAgents = await call('agent:getAll', []) as Array<Record<string, JsonValue>>
    assert.deepEqual(publicAgents.map(row => row.id), [agent.id])
    assert.equal(JSON.stringify(publicAgents).includes('api_keys'), false)
    await reject(call('agentSession:start', [unrelatedAgent.id, task.id]), 'INVALID_REQUEST')
    await reject(call('agentSession:start', [agent.id, foreignTask.id]), 'INVALID_REQUEST')
    await reject(call('agentSession:start', [agent.id, task.id, '/untrusted']), 'INVALID_ARGUMENTS')
    await reject(call('agentSession:start', [agent.id, task.id, undefined, true]), 'INVALID_REQUEST')
    const aborted = new AbortController()
    aborted.abort()
    await reject(call('agentSession:start', [agent.id, task.id], caller, aborted.signal), 'CANCELLED')
    assert.equal(db.getTask(task.id)?.agent_id, null)
    phase = 'actual-start-result'
    const started = await call('agentSession:start', [agent.id, task.id]) as { sessionId: string }
    const sessionId = started.sessionId
    assert.equal(db.getTask(task.id)?.agent_id, agent.id)
    assert.equal(db.getTask(task.id)?.session_id, sessionId)
    phase = 'actual-start-and-projection'
    await wait(() => manager!.getSession(sessionId)?.status === 'waiting_approval' &&
      db.getTranscriptParts(task.id).some(part => isRecord(part.tool) && part.tool.requestId === 'fixture-approval-1' && part.tool.status === 'running') &&
      events.some(event => event.operation === 'transcript:changed'))
    assert.equal(fatalCodes.length, 0)
    assert.ok(events.some(event => event.operation === 'agent:status' && isRecord(event.payload) && event.payload.status === 'waiting_approval'))
    assert.ok(events.some(event => event.operation === 'transcript:changed'))
    phase = 'live-resume-status-snapshot'
    const statusCount = events.filter(event => event.operation === 'agent:status').length
    assert.deepEqual(await call('agentSession:resume', [agent.id, task.id, sessionId]), { sessionId })
    assert.equal(adapter.resumes, 0) // Existing owner returns without provider reconnection.
    const statuses = events.filter(event => event.operation === 'agent:status')
    assert.equal(statuses.length, statusCount + 1)
    assert.deepEqual(statuses.at(-1)?.payload, { sessionId, agentId: agent.id, taskId: task.id, status: 'waiting_approval' })
    assert.equal(adapter.getPendingApprovalIdentity(sessionId)?.requestId, 'fixture-approval-1')
    phase = 'approval-identity-and-duplicate'
    await reject(backend.registry.invoke('agentSession:approve', { sessionId, approved: true }, caller, controller.signal), 'INVALID_ARGUMENTS')
    await reject(call('agentSession:approve', ['foreign-session', true, undefined, 'permission', 'fixture-approval-1']), 'INVALID_REQUEST')
    await reject(call('agentSession:approve', [sessionId, true, undefined, 'permission', 'stale-request']), 'INVALID_REQUEST')
    await reject(call('agentSession:approve', [sessionId, true, undefined, 'question', 'fixture-approval-1']), 'INVALID_REQUEST')
    assert.deepEqual(adapter.decisions(), [])
    // Pause before the real adapter identity gate, keeping its pending request
    // visible while the owner awaits. The duplicate must reject while that
    // pause is held, rather than sharing the first caller's decision afterward.
    let releaseApproval!: () => void
    let enteredApproval!: () => void
    const approvalGate = new Promise<void>(resolve => { releaseApproval = resolve })
    const approvalEntered = new Promise<void>(resolve => { enteredApproval = resolve })
    const respond = adapter.respondToApproval
    let adapterCalls = 0
    adapter.respondToApproval = async function (...args) {
      adapterCalls++
      enteredApproval()
      await approvalGate
      return respond.apply(this, args)
    }
    const first = call('agentSession:approve', [sessionId, true, undefined, 'permission', 'fixture-approval-1'])
    await approvalEntered
    const duplicate = call('agentSession:approve', [sessionId, true, undefined, 'permission', 'fixture-approval-1'])
    const settled = Promise.allSettled([first, duplicate])
    try {
      const rejectedDuplicate = duplicate.then(() => { throw new AgentDesktopProofError(phase) }, error => error)
      const error = await Promise.race([rejectedDuplicate, delay(1000).then(() => { throw new AgentDesktopProofError(phase) })])
      assert.ok(error instanceof ServiceProtocolError && error.code === 'INVALID_REQUEST')
      assert.equal(adapterCalls, 1)
      assert.deepEqual(adapter.decisions(), [])
    } finally {
      releaseApproval()
      adapter.respondToApproval = respond
    }
    const responses = await settled
    assert.equal(responses.filter(response => response.status === 'fulfilled').length, 1)
    assert.ok(responses.some(response => response.status === 'rejected' && response.reason instanceof ServiceProtocolError && response.reason.code === 'INVALID_REQUEST'))
    assert.deepEqual(adapter.decisions(), [{ requestId: 'fixture-approval-1', approved: true }])
    await wait(() => db.getTask(task.id)?.status === 'ready_for_review' && db.getTranscriptParts(task.id).some(part => part.partId === 'result-fixture-approval-1'))
    const cursor = db.getTranscriptMaxRev(task.id)
    phase = 'pending-stop-and-recreate'
    // Only the internal fixture starts a second turn; no send command is granted.
    await manager!.sendMessage(sessionId, 'Second synthetic turn', task.id, agent.id)
    await wait(() => manager!.getSession(sessionId)?.status === 'waiting_approval' &&
      db.getTranscriptParts(task.id).some(part => isRecord(part.tool) && part.tool.requestId === 'fixture-approval-2' && part.tool.status === 'running'))
    assert.deepEqual(await call('agentSession:stop', [sessionId]), { success: true })
    assert.equal(adapter.destroyed, 1)
    await reject(call('agentSession:approve', [sessionId, true, undefined, 'permission', 'fixture-approval-2']), 'INVALID_REQUEST')
    await manager!.stopAllSessions()
    await delay(200)
    backend.dispose()
    backend.dispose()
    const snapshot = db.getTranscriptParts(task.id)
    db.close()
    db = new DatabaseManager(runtime)
    db.initialize()
    assert.deepEqual(db.getTranscriptParts(task.id), snapshot)
    adapter = new DeterministicAgentAdapter({ fixtureMode: 'synthetic-only', profileRoot: lock.profileRoot })
    caller.engineEpoch = 'desktop:2'
    backend = setup(caller.engineEpoch)
    phase = 'resume-and-stale-callback'
    await reject(call('agentSession:resume', [agent.id, foreignTask.id, sessionId]), 'INVALID_REQUEST')
    await reject(call('agentSession:resume', [agent.id, task.id, 'foreign-session']), 'INVALID_REQUEST')
    assert.deepEqual(await call('agentSession:resume', [agent.id, task.id, sessionId]), { sessionId })
    assert.equal(adapter.resumes, 1)
    await reject(call('agentSession:approve', [sessionId, true, undefined, 'permission', 'fixture-approval-2']), 'INVALID_REQUEST')
    assert.deepEqual(adapter.decisions(), [{ requestId: 'fixture-approval-1', approved: true }])
    phase = 'actual-rejected-approval'
    await manager!.sendMessage(sessionId, 'Third synthetic turn', task.id, agent.id)
    await wait(() => manager!.getSession(sessionId)?.status === 'waiting_approval' &&
      db.getTranscriptParts(task.id).some(part => isRecord(part.tool) && part.tool.requestId === 'fixture-approval-3' && part.tool.status === 'running'))
    assert.deepEqual(await call('agentSession:approve', [sessionId, false, undefined, 'permission', 'fixture-approval-3']), { success: true })
    await wait(() => db.getTask(task.id)?.status === 'ready_for_review' && db.getTranscriptParts(task.id).some(part => part.partId === 'result-fixture-approval-3'))
    assert.deepEqual(adapter.decisions(), [{ requestId: 'fixture-approval-1', approved: true }, { requestId: 'fixture-approval-3', approved: false }])
    assert.ok(db.getTranscriptDelta(task.id, cursor).parts.some(part => part.partId === 'question-fixture-approval-3' && isRecord(part.tool) && part.tool.status === 'cancelled'))
    assert.equal(fatalCodes.length, 0)
    await call('agentSession:stop', [sessionId])
    await reject(call('agentSession:stop', [sessionId]), 'INVALID_REQUEST')
    await reject(call('agent:getAll', [], { ...caller, engineEpoch: 'desktop:1' }), 'STALE_EPOCH')
    await reject(call('agent:getAll', [], { ...caller, principal: 'service' }), 'INVALID_REQUEST')
    phase = 'fatal-event-and-listener-disposal'
    // Fault injection at the same internal ingress used by the real listener;
    // no fake lifecycle or approval result. Consumer errors need an explicit latch.
    backend.acceptOwnerEvent('unreviewed:critical', { taskId: task.id })
    assert.deepEqual(fatalCodes, ['INVALID_FRAME'])
    await reject(call('agent:getAll', []), 'INVALID_REQUEST')
    const remove = manager!.removeExternalListener
    let removals = 0
    manager!.removeExternalListener = function (listener) { removals++; remove.call(this, listener) }
    backend.dispose()
    backend.dispose()
    assert.equal(removals, 1)
    return {
      ok: true, actualLifecycleOwner: true, actualAdapterIdentityGate: true, realSqlite: true, standaloneNode: true,
      publicFixtureAgentOnly: true, requestIdRequired: true, scopedTaskAndSession: true, staleApprovalDenied: true,
      duplicateApprovalDenied: true, approvalAccepted: true, approvalRejected: true, acknowledgedStop: true,
      approvalInFlightClaimVerified: true,
      ownerRecreated: true, staleRestoredCallbackDenied: true, durableProjectionAndDelta: true,
      liveResumeStatusSnapshot: true,
      criticalEventFailureExplicit: true, noAgentCrudOrSendGranted: true, noSdkParityClaim: true, eventCount: events.length
    }
  } catch (error) { throw new AgentDesktopProofError(phase, error instanceof ServiceProtocolError ? error.code : 'ASSERTION_FAILED', fatalOperations[0] ?? 'none') }
  finally {
    await manager?.stopAllSessions()
    await delay(200)
    backend?.dispose()
    db.close()
    lock.release()
  }
}
