import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { AgentManager } from '../../src/main/agent-manager-core'
import type { AgentManagerHost, AgentWindow } from '../../src/main/agent-manager/host'
import { DatabaseManager } from '../../src/main/database/manager'
import { acquireProfileLock } from '../../src/main/platform/profile-lock'
import { configureSecretStorage } from '../../src/main/platform/secret-storage'
import { MessagePartType, SessionStatusType, type CodingAgentAdapter, type MessagePart, type SessionConfig, type SessionMessage, type SessionStatus } from '../../src/main/adapters/coding-agent-adapter'
import { ACTIVITY_REVALIDATE_MS, ACTIVITY_STALE_MS, readAgentStatusActivityMeta } from '../../src/shared/activity'

type Pending = { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout }
interface OwnedChild {
  child: ChildProcessWithoutNullStreams
  pending: Map<number, Pending>
  exited: boolean
  exit: Promise<void>
  buffer: string
  statusSequence: number
}
interface StatusEvent { at: number; payload: Record<string, unknown> }
export class ActivityProcessProofError extends Error {
  constructor(readonly phase: string) { super('Controlled process activity proof failed') }
}
function disconnected(): Error & { code: string } {
  return Object.assign(new Error('Controlled fixture connection closed'), { code: 'EPIPE' })
}

/** Synthetic protocol only; process/RPC/polling/exit/cleanup are real. No
 * provider SDK or arbitrary executable, prompt or command is accepted. */
class ProcessFixtureAdapter implements CodingAgentAdapter {
  private readonly owned = new Map<string, OwnedChild>()
  private sessionSequence = 0
  private requestSequence = 0
  onDataAvailable?: (sessionId: string) => void
  readonly counts = { created: 0, destroyed: 0, killed: 0, exited: 0, polls: 0, emptyPolls: 0, statuses: 0, starts: 0, aborts: 0, failures: 0 }
  constructor(private readonly directory: string, private readonly workerPath: string) { assert.equal(dirname(workerPath), directory) }
  async initialize(): Promise<void> {}
  async checkHealth(): Promise<{ available: boolean }> { return { available: true } }
  async createSession(_config: SessionConfig): Promise<string> {
    const sessionId = `controlled-session-${++this.sessionSequence}`
    const child = spawn(process.execPath, [this.workerPath, '--synthetic-activity-fixture'], {
      cwd: this.directory, windowsHide: true, detached: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}
    })
    let release!: () => void
    const state: OwnedChild = { child, pending: new Map(), exited: false, exit: new Promise<void>(resolve => { release = resolve }), buffer: '', statusSequence: 0 }
    this.owned.set(sessionId, state)
    this.counts.created++
    const ended = (): void => {
      if (state.exited) return
      state.exited = true
      this.counts.exited++
      for (const pending of state.pending.values()) { clearTimeout(pending.timer); pending.reject(disconnected()) }
      state.pending.clear()
      release()
      this.onDataAvailable?.(sessionId)
    }
    child.once('exit', ended)
    child.once('error', ended)
    child.stdin.on('error', () => {})
    child.stdout.on('data', (chunk: Buffer) => {
      state.buffer += chunk.toString('utf8')
      if (state.buffer.length > 65536) { this.killOwned(sessionId); return }
      while (state.buffer.includes('\n')) {
        const cut = state.buffer.indexOf('\n')
        const line = state.buffer.slice(0, cut); state.buffer = state.buffer.slice(cut + 1)
        let frame: { id: number; result: Record<string, unknown> }
        try { frame = JSON.parse(line) } catch { this.killOwned(sessionId); return }
        if (!Number.isSafeInteger(frame.id) || !frame.result || typeof frame.result !== 'object') { this.killOwned(sessionId); return }
        const pending = state.pending.get(frame.id)
        if (!pending) continue
        state.pending.delete(frame.id); clearTimeout(pending.timer); pending.resolve(frame.result)
      }
    })
    // Drain but never log stderr: neither commands nor native/profile details
    // may escape the report if a runtime fails to launch.
    child.stderr.on('data', () => {})
    await this.rpc(sessionId, 'ping')
    return sessionId
  }
  async resumeSession(sessionId: string, _config: SessionConfig): Promise<SessionMessage[]> { await this.rpc(sessionId, 'ping'); return [] }
  async sendPrompt(sessionId: string, _parts: MessagePart[], _config: SessionConfig): Promise<void> {
    await this.rpc(sessionId, 'start'); this.counts.starts++; this.onDataAvailable?.(sessionId)
  }
  async getStatus(sessionId: string, _config: SessionConfig): Promise<SessionStatus> {
    const result = await this.rpc(sessionId, 'status')
    const child = this.owned.get(sessionId)!
    assert.ok(Number.isSafeInteger(result.observation) && Number(result.observation) > child.statusSequence)
    child.statusSequence = Number(result.observation)
    this.counts.statuses++
    assert.ok(result.type === 'busy' || result.type === 'idle')
    return { type: result.type === 'busy' ? SessionStatusType.BUSY : SessionStatusType.IDLE }
  }
  async pollMessages(sessionId: string, _seenMessages: Set<string>, _seenParts: Set<string>, _lengths: Map<string, string>, _config: SessionConfig): Promise<MessagePart[]> {
    const result = await this.rpc(sessionId, 'poll')
    assert.ok(Array.isArray(result.parts) && result.parts.length <= 2)
    this.counts.polls++
    if (result.parts.length === 0) this.counts.emptyPolls++
    return result.parts as MessagePart[]
  }
  async abortPrompt(sessionId: string, _config: SessionConfig): Promise<void> {
    await this.rpc(sessionId, 'abort'); this.counts.aborts++; this.onDataAvailable?.(sessionId)
  }
  async destroySession(sessionId: string, _config: SessionConfig): Promise<void> {
    const state = this.owned.get(sessionId)
    if (!state) return
    if (!state.exited) {
      try { await this.rpc(sessionId, 'destroy') } catch { if (!state.exited) this.killOwned(sessionId) }
      await this.waitExit(state)
    }
    this.owned.delete(sessionId); this.counts.destroyed++
  }
  async complete(sessionId: string): Promise<void> { await this.rpc(sessionId, 'complete'); this.onDataAvailable?.(sessionId) }
  async ping(sessionId: string): Promise<void> { assert.equal((await this.rpc(sessionId, 'ping')).alive, true) }
  isAlive(sessionId: string): boolean { const child = this.owned.get(sessionId); return Boolean(child && !child.exited) }
  killOwned(sessionId: string): void {
    const state = this.owned.get(sessionId)
    if (!state || state.exited) return
    this.counts.killed++; state.child.kill('SIGKILL')
  }
  async closeOwned(): Promise<void> {
    for (const [sessionId, state] of this.owned) {
      if (!state.exited) this.killOwned(sessionId)
      await this.waitExit(state)
      this.owned.delete(sessionId)
    }
  }
  private async waitExit(state: OwnedChild): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    try { await Promise.race([state.exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owned child cleanup deadline elapsed')), 2000) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  private rpc(sessionId: string, method: string): Promise<Record<string, unknown>> {
    const state = this.owned.get(sessionId)
    if (!state || state.exited || state.child.stdin.destroyed) { this.counts.failures++; return Promise.reject(disconnected()) }
    if (state.pending.size >= 16) return Promise.reject(new Error('Controlled RPC bound exceeded'))
    const id = ++this.requestSequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { state.pending.delete(id); this.counts.failures++; reject(disconnected()) }, 1500)
      state.pending.set(id, { resolve, reject, timer })
      state.child.stdin.write(JSON.stringify({ id, method }) + '\n', error => {
        if (!error) return
        const pending = state.pending.get(id)
        if (pending) { state.pending.delete(id); clearTimeout(timer); this.counts.failures++; pending.reject(disconnected()) }
      })
    })
  }
}

export async function runActivityProcessFixture(directory: string, workerPath: string) {
  assert.equal(process.versions.electron, undefined)
  configureSecretStorage({ isEncryptionAvailable: () => false,
    encryptString(): never { throw new Error('Controlled fixture credential access denied') },
    decryptString(): never { throw new Error('Controlled fixture credential access denied') } })
  const profileRoot = join(directory, 'profile'); mkdirSync(profileRoot)
  const lock = acquireProfileLock(profileRoot)
  const db = new DatabaseManager({ paths: { profileRoot: lock.profileRoot, workspaceRoot: join(directory, 'workspaces'), attachmentRoot: join(directory, 'attachments') },
    managedTaskMcp: { disabled: true }, logger: { log() {}, error() {} } })
  const adapter = new ProcessFixtureAdapter(directory, workerPath)
  const unrelated = new ProcessFixtureAdapter(directory, workerPath)
  let manager: AgentManager | undefined
  let phase = 'initialize'
  const deadline = Date.now() + 55000
  const native: StatusEvent[] = []
  const external: Record<string, unknown>[] = []
  const mobile: Record<string, unknown>[] = []
  const wait = async (ready: () => boolean): Promise<void> => { while (!ready()) { if (Date.now() >= deadline) throw new ActivityProcessProofError(phase); await delay(25) } }
  const config: SessionConfig = { agentId: 'controlled', taskId: 'unregistered', workspaceDir: directory }
  const host: AgentManagerHost = {
    renderer: { kind: 'native', send(target, channel, ...args) { target.send(channel, ...args); return true } },
    notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' },
    configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' },
    createAdapter: backend => backend === 'opencode' ? adapter : null, isCodexAppServerAdapter: () => false
  }
  const window: AgentWindow = { isDestroyed: () => false, isFocused: () => true, show() {}, focus() {}, webContents: {
    send(channel, ...args) { if (channel === 'agent:status') { assert.ok(native.length < 256); native.push({ at: Date.now(), payload: args[0] as Record<string, unknown> }) } }
  } }
  try {
    db.initialize(); lock.assertHeld()
    assert.equal(db.getMcpServers().some(server => server.name === 'task-management'), false)
    const agent = db.createAgent({ name: 'Controlled process fixture', config: { coding_agent: 'opencode', max_parallel_sessions: 4, mcp_servers: [], secret_ids: [], skill_ids: [] } })!
    const task = db.createTask({ title: 'Controlled silent operation' })!
    db.updateTask(task.id, { agent_id: agent.id })
    const unregistered = await unrelated.createSession(config)
    manager = new AgentManager(db, host); manager.setMainWindow(window)
    manager.addExternalListener((channel, payload) => { if (channel === 'agent:status') { assert.ok(external.length < 256); external.push(payload as Record<string, unknown>) } })
    manager.addExternalListener((channel, payload) => { if (channel === 'agent:status') { assert.ok(mobile.length < 256); mobile.push(payload as Record<string, unknown>) } })
    phase = 'silent-operation-start'
    const started = await manager.requestSession(agent.id, task.id)
    assert.equal(started.status, 'started'); assert.ok('sessionId' in started)
    const sessionId = started.sessionId
    await wait(() => manager!.getSession(sessionId)?.status === 'working' && db.getTranscriptParts(task.id).some(part => part.partType === MessagePartType.TOOL))
    const transcriptBefore = db.getTranscriptParts(task.id)
    const pollsBefore = adapter.counts.polls
    const statusesBefore = adapter.counts.statuses
    const quietStart = Date.now()
    phase = 'silent-fresh-heartbeats'
    await delay(16500)
    const quietElapsedMs = Date.now() - quietStart
    assert.ok(quietElapsedMs > ACTIVITY_STALE_MS)
    assert.deepEqual(db.getTranscriptParts(task.id), transcriptBefore)
    const sourcePollCountDuringSilence = adapter.counts.polls - pollsBefore
    const sourceStatusCountDuringSilence = adapter.counts.statuses - statusesBefore
    assert.ok(sourcePollCountDuringSilence >= 5 && sourceStatusCountDuringSilence >= 5)
    const heartbeats = native.filter(event => event.payload.sessionId === sessionId && event.payload.heartbeat === true && event.payload.disconnected !== true)
    assert.ok(heartbeats.length >= 3)
    for (let index = 1; index < heartbeats.length; index++) assert.ok(heartbeats[index].at - heartbeats[index - 1].at >= ACTIVITY_REVALIDATE_MS)
    assert.ok(Date.now() - heartbeats.at(-1)!.at < ACTIVITY_STALE_MS)
    assert.equal(external.some(event => event.heartbeat === true), false)
    assert.equal(mobile.some(event => event.heartbeat === true), false)
    const metadata = native.map(event => readAgentStatusActivityMeta(event.payload))
    assert.ok(metadata.every(value => value !== null))
    assert.equal(new Set(metadata.map(value => value!.epoch)).size, 1)
    for (let index = 1; index < metadata.length; index++) assert.ok(metadata[index]!.seq > metadata[index - 1]!.seq)
    phase = 'owned-process-death'
    const deathAt = Date.now()
    const lastAliveSequence = readAgentStatusActivityMeta(native.at(-1)!.payload)!.seq
    adapter.killOwned(sessionId)
    await wait(() => !adapter.isAlive(sessionId) && native.some(event => event.payload.sessionId === sessionId &&
      Number(event.payload.seq) > lastAliveSequence && (event.payload.disconnected === true || event.payload.status === 'error')))
    const disconnectedEvent = native.find(event => event.payload.sessionId === sessionId && Number(event.payload.seq) > lastAliveSequence &&
      (event.payload.disconnected === true || event.payload.status === 'error'))!
    const disconnectLatencyMs = disconnectedEvent.at - deathAt
    assert.ok(disconnectLatencyMs <= 4000)
    assert.equal((await adapter.checkHealth()).available, true)
    await assert.rejects(adapter.getStatus(sessionId, config), error => (error as { code?: string }).code === 'EPIPE')
    await delay(6000)
    assert.equal(native.some(event => event.payload.sessionId === sessionId && Number(event.payload.seq) > lastAliveSequence &&
      event.payload.heartbeat === true && event.payload.disconnected !== true && event.payload.status === 'working'), false)
    assert.equal(external.some(event => event.disconnected === true || event.heartbeat === true), false)
    assert.equal(mobile.some(event => event.disconnected === true || event.heartbeat === true), false)
    assert.equal(adapter.counts.created, 1)
    assert.equal(adapter.counts.starts, 1)
    await unrelated.ping(unregistered)
    await manager.stopSession(sessionId)

    phase = 'captain-observed-success-and-abort'
    const captain = db.getCoordinatorTask()!
    db.updateTask(captain.id, { agent_id: agent.id })
    const captainStart = await manager.requestSession(agent.id, captain.id)
    assert.equal(captainStart.status, 'started'); assert.ok('sessionId' in captainStart)
    const captainId = captainStart.sessionId
    await wait(() => db.getTranscriptParts(captain.id).some(part => part.partId === 'synthetic-tool-1') && manager!.getSession(captainId)?.status === 'working')
    await adapter.complete(captainId)
    await wait(() => native.some(event => event.payload.sessionId === captainId && event.payload.activityOutcome === 'completed') && manager!.getSession(captainId)?.status === 'idle')
    const completed = native.filter(event => event.payload.sessionId === captainId && event.payload.activityOutcome === 'completed')
    assert.equal(completed.length, 1); assert.equal(completed[0].payload.heartbeat, undefined)
    assert.ok(db.getTranscriptParts(captain.id).some(part => part.partId === 'synthetic-answer-1'))
    await manager.sendMessage(captainId, 'Second controlled turn', captain.id, agent.id)
    await wait(() => db.getTranscriptParts(captain.id).some(part => part.partId === 'synthetic-tool-2') && manager!.getSession(captainId)?.status === 'working')
    const abortSequence = Number(native.at(-1)!.payload.seq)
    await manager.abortSession(captainId)
    assert.ok(native.some(event => event.payload.sessionId === captainId && Number(event.payload.seq) > abortSequence && event.payload.activityOutcome === 'cancelled' && event.payload.heartbeat !== true))
    assert.equal(native.some(event => event.payload.sessionId === captainId && Number(event.payload.seq) > abortSequence && event.payload.activityOutcome === 'completed'), false)
    assert.equal(adapter.isAlive(captainId), true)
    phase = 'owned-stop-and-shutdown'
    await manager.stopSession(captainId)
    assert.equal(adapter.isAlive(captainId), false)
    await unrelated.ping(unregistered)
    const finalTask = db.createTask({ title: 'Controlled shutdown operation' })!
    db.updateTask(finalTask.id, { agent_id: agent.id })
    const finalStart = await manager.requestSession(agent.id, finalTask.id)
    assert.equal(finalStart.status, 'started'); assert.ok('sessionId' in finalStart)
    await wait(() => adapter.isAlive(finalStart.sessionId))
    await manager.stopAllSessions()
    assert.equal(adapter.isAlive(finalStart.sessionId), false)
    assert.equal(adapter.counts.exited, adapter.counts.created)
    await unrelated.ping(unregistered)
    assert.equal(unrelated.counts.killed, 0)
    const finalMetadata = native.map(event => readAgentStatusActivityMeta(event.payload))
    assert.ok(finalMetadata.every(value => value !== null))
    assert.equal(new Set(finalMetadata.map(value => value!.epoch)).size, 1)
    for (let index = 1; index < finalMetadata.length; index++) assert.ok(finalMetadata[index]!.seq > finalMetadata[index - 1]!.seq)
    lock.assertHeld()
    return { ok: true, actualLifecycleOwner: true, realSqlite: true, standaloneNode: true, canonicalLockedProfile: true,
      controlledBackend: true, noSdkParityClaim: true, realChildRpc: true, quietOperationMs: quietElapsedMs,
      nativeWindowOnlyHeartbeats: true, externalHeartbeatCount: 0, mobileHeartbeatCount: 0, heartbeatCount: heartbeats.length,
      minimumHeartbeatIntervalMs: Math.min(...heartbeats.slice(1).map((event, index) => event.at - heartbeats[index].at)),
      sourcePollCountDuringSilence, sourceStatusCountDuringSilence,
      capturedMetadata: { epochCount: 1, firstSequence: metadata[0]!.seq, lastSequence: Number(native.at(-1)!.payload.seq), heartbeatSequences: heartbeats.map(event => Number(event.payload.seq)) },
      disconnectLatencyMs, freshWorkingHeartbeatsStoppedAfterDeath: true, healthyBridgeDidNotBlessDeadOwner: true,
      completedCaptainTurnObserved: true, manualAbortCancelled: true, stopCleansOwnedChild: true, shutdownCleansOwnedChild: true,
      unregisteredChildSurvivedManagerTeardown: true, ownedProcessCounts: adapter.counts, noSecretsMcpNetworkOrNativeEffects: true }
  } catch { throw new ActivityProcessProofError(phase) }
  finally {
    try { await manager?.stopAllSessions() }
    finally {
      try { await adapter.closeOwned(); await unrelated.closeOwned() }
      finally { db.close(); lock.release() }
    }
  }
}
