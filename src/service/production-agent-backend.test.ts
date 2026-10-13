import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { SessionStatusType } from '../main/adapters/coding-agent-adapter'
import { AgentManager } from '../main/agent-manager-core'
import type { AgentManagerHost } from '../main/agent-manager/host'
import { MessageRole, MessagePartType, type SessionMessage } from '../main/adapters/coding-agent-adapter'
import { ProductionAgentBackend, type ProductionAgentBackendOptions } from './production-agent-backend'
import { PRODUCTION_AGENT_CODECS, type ProductionAgentCodec, type ProductionAgentOperation } from '../shared/production-agent-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import type { DesktopCallerContext } from './transport/desktop-registry'
import type { JsonValue } from '../shared/service-protocol'
import { DeliveryStore } from '../main/sessions/delivery-store'

function held() {
  let finish!: () => void
  const promise = new Promise<void>(resolve => { finish = resolve })
  return { promise, finish }
}
class LifecycleAdapter extends FakeAdapter {
  readonly pending = new Map<string, Array<{ requestId: string; responseType: 'permission' | 'question' }>>()
  readonly getPendingRequests = vi.fn(async (id: string) => this.pending.get(id) ?? [])
  readonly getAllMessages = vi.fn(async (): Promise<SessionMessage[]> => [{ id: 'native-history', role: MessageRole.ASSISTANT,
    parts: [{ id: 'native-part', type: MessagePartType.TEXT, content: 'actual controlled adapter reply' }] }])
  constructor() {
    super({ questions: true })
    this.respondToApproval!.mockImplementation(async (sid, _approved, _option, requestId) => this.consume(sid, requestId, 'permission'))
    this.respondToQuestion!.mockImplementation(async (sid, _answers, _config, requestId) => this.consume(sid, requestId, 'question'))
  }
  private consume(id: string, requestId: string | undefined, type: 'permission' | 'question'): boolean {
    const queue = this.pending.get(id) ?? []
    const index = queue.findIndex(request => request.requestId === requestId && request.responseType === type)
    if (index < 0) return false
    queue.splice(index, 1)
    return true
  }
}
let db: ReturnType<typeof createPortableTestDb>, manager: AgentManager, backend: ProductionAgentBackend, adapter: LifecycleAdapter
let options: ProductionAgentBackendOptions
let allowedTasks: Set<string> | null, allowedAgents: Set<string> | null
const finishers: Array<() => void> = []
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'production-agent-epoch', webviewId: 'main', origin: 'app://production-fixture' }
beforeEach(() => {
  db = createPortableTestDb(); adapter = new LifecycleAdapter(); allowedTasks = null; allowedAgents = null
  const host: AgentManagerHost = { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' },
    configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => adapter, isCodexAppServerAdapter: () => false }
  manager = new AgentManager(db, host)
  options = { database: db, manager, engineEpoch: caller.engineEpoch, assertAvailable() { if (!db.db.open) throw new Error('Closed fixture') },
    isTrustedDesktop: identity => identity.webviewId === 'main' && identity.origin === caller.origin,
    canAccessTask: id => allowedTasks === null || allowedTasks.has(id), canAccessProject: () => true,
    canAccessAgent: id => allowedAgents === null || allowedAgents.has(id) }
  backend = new ProductionAgentBackend(options)
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  for (const finish of finishers.splice(0)) finish()
  await backend.close(); await manager.stopAllSessions()
  const root = dirname(dirname(db.getWorkspaceDir('fixture')))
  db.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks()
})
async function call<K extends ProductionAgentOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = PRODUCTION_AGENT_CODECS[operation] as ProductionAgentCodec<K>
  const wire = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
  expect(codec.validateWireResult(wire)).toBe(true)
  return codec.decodeResult((wire as { value?: JsonValue }).value)
}
function task(title = 'Owned task', agentId?: string) {
  const agent = agentId ? db.getAgent(agentId)! : db.createAgent({ name: 'Controlled agent', is_default: true, config: { coding_agent: 'pi', max_parallel_sessions: 1 } })!
  const task = db.createTask({ title })!
  db.updateTask(task.id, { agent_id: agent.id })
  return { agent, task }
}
async function live() {
  const f = task()
  const started = await call('agentSession:start', [f.agent.id, f.task.id])
  if (!started.sessionId) throw new Error('Fixture did not start')
  return { ...f, sessionId: started.sessionId }
}

describe('production session commands on the actual manager', () => {
  it('routes real starts through admission, exposes durable queue/recovery, and cancels queued work without creating a second backend', async () => {
    const first = await live(), second = task('Queued work', first.agent.id)
    const queued = await call('agentSession:start', [first.agent.id, second.task.id])
    expect(queued).toMatchObject({ sessionId: '', queued: true, queuePosition: 1, queueReason: 'agent_limit' })
    expect(await call('agent:getStartQueue', [])).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: second.task.id, agentId: first.agent.id })]))
    expect(await call('agent:getStartRecoveryState', [second.task.id])).toMatchObject({ state: 'queued', position: 1 })
    expect(await call('agentSession:stopByTaskId', [second.task.id])).toEqual({ success: true, sessionId: null })
    expect(await call('agent:getStartRecoveryState', [second.task.id])).toMatchObject({ state: 'cancelled', position: 0 })
    expect(adapter.createSession).toHaveBeenCalledOnce()
    expect(adapter.sendPrompt).toHaveBeenCalledOnce()
  })

  it('preserves high-level subtask/triage selection and rejects inaccessible candidates before any effect', async () => {
    const f = task('Parent'), child = db.createTask({ title: 'Selected child', parent_task_id: f.task.id })!
    db.updateTask(child.id, { agent_id: f.agent.id })
    allowedTasks = new Set([f.task.id])
    await expect(call('agentSession:startTask', [f.task.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(adapter.createSession).not.toHaveBeenCalled()
    allowedTasks.add(child.id)
    expect(await call('agentSession:startTask', [f.task.id])).toMatchObject({ action: 'subtask_started', startedTaskId: child.id, agentId: f.agent.id })
    const unassigned = db.createTask({ title: 'Needs real triage' })!
    allowedTasks = null
    expect(await call('agentSession:startTask', [unassigned.id])).toMatchObject({ action: 'triage_started', startedTaskId: unassigned.id, agentId: f.agent.id })
    expect(adapter.createSession).toHaveBeenCalledTimes(2)
  })

  it('maps members to one counted task-group owner and rejects a partial member authority or foreign attachment', async () => {
    const f = task('First member'), second = task('Second member', f.agent.id)
    const group = db.createTaskGroup({ title: 'Shared execution', task_ids: [f.task.id, second.task.id] })
    allowedTasks = new Set([f.task.id, group.execution_task_id])
    await expect(call('agentSession:start', [f.agent.id, f.task.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(adapter.createSession).not.toHaveBeenCalled()
    allowedTasks.add(second.task.id)
    const started = await call('agentSession:start', [f.agent.id, f.task.id])
    expect(manager.getSession(started.sessionId)?.taskId).toBe(group.execution_task_id)
    const sent = await call('agentSession:sendByTaskId', [second.task.id, 'Only the second member', undefined, 'group-message'])
    expect(sent.success).toBe(true)
    expect(adapter.sendPrompt.mock.calls[1][1][0].text).toContain(second.task.id)
    await expect(call('agentSession:sendByTaskId', [second.task.id, 'Foreign file', [{ id: 'foreign', filename: 'foreign.txt', size: 1, mime_type: 'text/plain' }]])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(adapter.createSession).toHaveBeenCalledOnce()
  })

  it('rejects untrusted callers, foreign task/session/agent IDs and client workspace paths before native effects', async () => {
    const f = await live(), foreign = task('Foreign task')
    await expect(call('agentSession:send', [f.sessionId, 'Wrong task', foreign.task.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('agentSession:send', [f.sessionId, 'Wrong agent', f.task.id, foreign.agent.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('agentSession:stop', ['missing-native'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('agentSession:abort', [f.sessionId], undefined, { ...caller, webviewId: 'untrusted' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(backend.registry.invoke('agentSession:start', { agentId: f.agent.id, taskId: foreign.task.id, workspaceDir: '/client/chosen/path' }, caller, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(adapter.abortPrompt).not.toHaveBeenCalled(); expect(adapter.destroySession).not.toHaveBeenCalled()
    expect(adapter.sendPrompt).toHaveBeenCalledOnce()
  })

  it('accepts a real send once after caller cancellation, keeps the raw work, and reuses the durable nonce after backend replacement', async () => {
    const f = await live(), gate = held(), entered = held(), cancel = new AbortController()
    finishers.push(gate.finish)
    adapter.sendPrompt.mockImplementationOnce(async () => { entered.finish(); await gate.promise })
    const sending = call('agentSession:send', [f.sessionId, 'Accepted instruction', f.task.id, f.agent.id, undefined, 'stable-intent'], cancel.signal)
    const cancelled = expect(sending).rejects.toMatchObject({ code: 'CANCELLED' })
    await entered.promise; cancel.abort()
    await expect(backend.close(5)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(db.db.open).toBe(true); expect(backend.inflightCount).toBeGreaterThan(0)
    gate.finish(); await cancelled; await backend.close()
    backend = new ProductionAgentBackend({ ...options, engineEpoch: 'next-agent-epoch' })
    const nextCaller = { ...caller, engineEpoch: 'next-agent-epoch' }
    expect(await call('agentSession:send', [f.sessionId, 'Accepted instruction', f.task.id, f.agent.id, undefined, 'stable-intent'], undefined, nextCaller)).toMatchObject({ success: true })
    expect(adapter.sendPrompt).toHaveBeenCalledTimes(2) // Initial work + exactly one accepted instruction.
    await expect(call('agentSession:send', [f.sessionId, 'Changed instruction', f.task.id, f.agent.id, undefined, 'stable-intent'], undefined, nextCaller)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(adapter.sendPrompt).toHaveBeenCalledTimes(2)
    expect(new DeliveryStore(db).listRecoverable('agent_message')).toEqual([])
  })

  it('preserves an unknown transport delivery boundary and never replays the same durable intent', async () => {
    const f = await live()
    adapter.sendPrompt.mockRejectedValueOnce(new Error('ECONNRESET unknown prompt delivery'))
    await expect(call('agentSession:sendByTaskId', [f.task.id, 'Unconfirmed instruction', undefined, 'uncertain-intent'])).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await expect(call('agentSession:sendByTaskId', [f.task.id, 'Unconfirmed instruction', undefined, 'uncertain-intent'])).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(adapter.sendPrompt).toHaveBeenCalledTimes(2)
    expect(adapter.createSession).toHaveBeenCalledOnce()
  })

  it('uses actual pending native request identity, rejects stale/foreign answers and supports permission and question outcomes', async () => {
    const f = await live()
    adapter.pending.set(f.sessionId, [{ requestId: 'native-permission', responseType: 'permission' }, { requestId: 'native-question', responseType: 'question' }])
    await expect(call('agentSession:approve', [f.sessionId, true, undefined, 'permission', 'stale-request'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(adapter.respondToApproval).not.toHaveBeenCalled()
    expect(await call('agentSession:approve', [f.sessionId, true, 'Yes', 'permission', 'native-permission'])).toEqual({ success: true })
    expect(adapter.respondToApproval).toHaveBeenCalledWith(f.sessionId, true, 'approved', 'native-permission')
    await expect(call('agentSession:approve', [f.sessionId, true, undefined, 'permission', 'native-permission'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await call('agentSession:approve', [f.sessionId, true, 'Answer: accepted', 'question', 'native-question'])).toEqual({ success: true })
    expect(adapter.respondToQuestion).toHaveBeenCalledWith(f.sessionId, { Answer: 'accepted' }, expect.any(Object), 'native-question')
    expect(adapter.respondToApproval).toHaveBeenCalledOnce()
    expect(adapter.sendPrompt).toHaveBeenCalledOnce()
  })

  it('claims an exact native decision once during overlapping confirmations and never substitutes a transcript request', async () => {
    const f = await live(), gate = held(), entered = held()
    finishers.push(gate.finish)
    adapter.pending.set(f.sessionId, [{ requestId: 'exact-decision', responseType: 'permission' }])
    adapter.respondToApproval!.mockImplementationOnce(async (sid, _approved, _option, requestId) => {
      entered.finish(); await gate.promise
      const queue = adapter.pending.get(sid) ?? []
      const index = queue.findIndex(row => row.requestId === requestId)
      if (index < 0) return false
      queue.splice(index, 1)
      return true
    })
    const first = call('agentSession:approve', [f.sessionId, true, undefined, 'permission', 'exact-decision'])
    await entered.promise
    await expect(call('agentSession:approve', [f.sessionId, true, undefined, 'permission', 'exact-decision'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(adapter.respondToApproval).toHaveBeenCalledOnce()
    gate.finish(); expect(await first).toEqual({ success: true })
    db.upsertTranscriptParts(f.task.id, [{ id: 'old-request', role: 'assistant', content: 'Old approval', partType: 'question',
      tool: { name: 'permission', status: 'pending', requestId: 'no-live-callback' } }])
    await expect(call('agentSession:approve', [f.sessionId, true, undefined, 'permission', 'no-live-callback'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(adapter.respondToApproval).toHaveBeenCalledOnce()
  })

  it('retains ignored pending-request reads through close and never dispatches their late approval', async () => {
    const f = await live(), gate = held(), entered = held()
    finishers.push(gate.finish)
    adapter.getPendingRequests.mockImplementationOnce(async () => { entered.finish(); await gate.promise; return [{ requestId: 'late', responseType: 'permission' }] })
    const approval = call('agentSession:approve', [f.sessionId, true, undefined, 'permission', 'late'])
    const denied = expect(approval).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await entered.promise
    await expect(backend.close(5)).rejects.toMatchObject({ code: 'TIMEOUT' })
    gate.finish(); await denied; await backend.close()
    expect(adapter.respondToApproval).not.toHaveBeenCalled()
    expect(db.db.open).toBe(true)
  })

  it('requires acknowledged abort/stop, keeps a refused owner, and resumes the exact persisted native session', async () => {
    const f = await live()
    expect(await call('agentSession:resume', [f.agent.id, f.task.id, f.sessionId])).toEqual({ sessionId: f.sessionId })
    expect(adapter.createSession).toHaveBeenCalledOnce()
    adapter.abortPrompt.mockRejectedValueOnce(new Error('controlled abort refusal'))
    await expect(call('agentSession:abort', [f.sessionId])).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(manager.getSession(f.sessionId)?.status).toBe('working')
    adapter.abortPrompt.mockImplementationOnce(async () => { adapter.setStatus(SessionStatusType.IDLE) })
    expect(await call('agentSession:abort', [f.sessionId])).toEqual({ success: true })
    adapter.destroySession.mockRejectedValueOnce(new Error('controlled destroy refusal'))
    await expect(call('agentSession:stop', [f.sessionId])).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(manager.getSession(f.sessionId)).toBeDefined()
    expect(await call('agentSession:stop', [f.sessionId])).toEqual({ success: true })
    expect(manager.getSession(f.sessionId)).toBeUndefined()
  })

  it('switches through the durable recap path and exposes bounded actual native transcript reads, without swallowing read errors', async () => {
    const f = await live()
    db.upsertTranscriptParts(f.task.id, [{ id: 'prior-work', role: 'assistant', content: 'Persisted result before switch', partType: 'text' }])
    const next = db.createAgent({ name: 'Next agent', config: { coding_agent: 'pi', max_parallel_sessions: 1 } })!
    const switched = await call('agentSession:switchAgent', [f.task.id, next.id])
    expect(switched.sessionId).not.toBe(f.sessionId)
    expect(adapter.destroySession).toHaveBeenCalledWith(f.sessionId, expect.any(Object))
    expect(adapter.sendPrompt.mock.calls.at(-1)![1][0].text).toContain('Persisted result before switch')
    expect(await call('agentSession:getRawTranscript', [f.task.id])).toEqual([{ role: 'assistant', parts: [{ type: 'text', content: 'actual controlled adapter reply' }] }])
    adapter.getAllMessages.mockRejectedValueOnce(new Error('controlled read refusal'))
    await expect(call('agentSession:getRawTranscript', [f.task.id])).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await expect(call('agentSession:send', [f.sessionId, 'Stale redirected identity'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('rechecks task authority before releasing a delayed raw diagnostic result', async () => {
    const f = await live(), gate = held(), entered = held()
    finishers.push(gate.finish)
    adapter.getAllMessages.mockImplementationOnce(async () => {
      entered.finish(); await gate.promise
      return [{ id: 'late-private', role: MessageRole.ASSISTANT, parts: [{ type: MessagePartType.TEXT, content: 'revoked task reply' }] }]
    })
    const read = call('agentSession:getRawTranscript', [f.task.id])
    const denied = expect(read).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await entered.promise; allowedTasks = new Set()
    gate.finish(); await denied
    expect(adapter.getAllMessages).toHaveBeenCalledOnce()
    expect(adapter.sendPrompt).toHaveBeenCalledOnce()
  })

  it('uses real per-project Captain switching and scopes runtime recovery/rollback to all involved agents', async () => {
    const f = task(), project = db.createProject({ name: 'Captain project', captain_agent_id: f.agent.id })!
    expect(await call('captainRuntime:get', [project.id])).toBeNull()
    const next = db.createAgent({ name: 'Candidate', config: { coding_agent: 'pi' } })!
    allowedAgents = new Set([f.agent.id])
    await expect(call('captainRuntime:switch', [project.id, next.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(adapter.createSession).not.toHaveBeenCalled()
    allowedAgents.add(next.id)
    adapter.createSession.mockRejectedValueOnce(new Error('controlled candidate startup failure'))
    expect(await call('captainRuntime:switch', [project.id, next.id])).toMatchObject({ projectId: project.id, agentId: f.agent.id, phase: 'rolled_back', errorCode: 'STARTUP_FAILED' })
    expect(await call('captainRuntime:rollback', [project.id])).toMatchObject({ phase: 'rolled_back', agentId: f.agent.id })
    expect(db.getProject(project.id)?.captain_agent_id).toBe(f.agent.id)
    const retried = await call('captainRuntime:retry', [project.id])
    expect(retried).toMatchObject({ projectId: project.id, agentId: next.id, phase: 'healthy' })
    expect(db.getProject(project.id)?.captain_agent_id).toBe(next.id)
  })
})
