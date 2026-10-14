import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { dirname } from 'node:path'
import { rmSync } from 'node:fs'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager, AGENT_SESSION_START_TIMEOUT_MS } from './agent-manager-core'
import type { AgentManagerHost } from './agent-manager/host'
import { DeliveryStore } from './sessions/delivery-store'
import { SessionStatusType } from './adapters/coding-agent-adapter'
vi.mock('./agent-manager/workspace-docs', async original => ({ ...await original<typeof import('./agent-manager/workspace-docs')>(), writeSkillFiles: vi.fn(async () => undefined) }))
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const finishers: Array<() => void> = []
const resources: Array<{ db: ReturnType<typeof createPortableTestDb>; manager: AgentManager; directory: string }> = []
beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }))
afterEach(async () => {
  for (const finish of finishers.splice(0)) finish()
  for (const { db, manager, directory } of resources.splice(0)) { await manager.stopAllSessions(); db.close(); rmSync(directory, { recursive: true, force: true }) }
  vi.useRealTimers(); vi.restoreAllMocks()
})
function fixture() {
  const db = createPortableTestDb(), agent = db.createAgent({ name: 'Group owner', config: { coding_agent: 'pi' } })!
  const members = [db.createTask({ title: 'Member one' })!, db.createTask({ title: 'Member two' })!]
  for (const task of members) db.updateTask(task.id, { agent_id: agent.id })
  const group = db.createTaskGroup({ title: 'Shared work', task_ids: members.map(task => task.id) }), taskId = group.execution_task_id
  const adapter = new FakeAdapter({ status: SessionStatusType.IDLE, sessionIds: ['group-native'] })
  const ready = vi.fn(async (): Promise<number | null> => null)
  const host: AgentManagerHost = { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' }, configuredMcp: 'disabled',
    managedTaskMcp: { kind: 'server', waitUntilReady: ready, buildConfig: () => null }, createAdapter: () => adapter, isCodexAppServerAdapter: () => false }
  const manager = new AgentManager(db, host), directory = dirname(dirname(db.getWorkspaceDir(taskId)))
  resources.push({ db, manager, directory })
  const controller = new AbortController(), authorityError = new Error('Caller scope withdrawn'); let allowed = true
  const beforeEffect = (): void => { if (!allowed) throw authorityError }
  const revoke = (): void => { allowed = false }
  return { db, manager, adapter, agent, group, taskId, members, ready, controller, beforeEffect, revoke, authorityError }
}
it('blocks session creation after a delayed accepted adapter initialization loses caller scope', async () => {
  const f = fixture(), gate = deferred<void>(), entered = deferred<void>(); finishers.push(() => gate.resolve())
  f.adapter.initialize.mockImplementation(async () => { entered.resolve(); await gate.promise })
  const start = f.manager.withTaskGroupRequestGuard(() => f.manager.startTask(f.taskId), f.beforeEffect, f.controller.signal)
  const rejected = expect(start).rejects.toBe(f.authorityError)
  await entered.promise; f.revoke(); gate.resolve(); await rejected
  expect(f.adapter.checkHealth).not.toHaveBeenCalled(); expect(f.adapter.createSession).not.toHaveBeenCalled(); expect(f.adapter.sendPrompt).not.toHaveBeenCalled()
  expect(f.db.getTask(f.taskId)?.session_id).toBeNull()
  expect(f.manager.getStartRecoveryState(f.taskId)?.state).toBe('cancelled')
})
it('carries heartbeat admission authority through delayed initialization without sending after revocation', async () => {
  const f = fixture(), gate = deferred<void>(), entered = deferred<void>(); finishers.push(() => gate.resolve())
  f.adapter.initialize.mockImplementation(async () => { entered.resolve(); await gate.promise })
  const admission = f.manager.withHeartbeatRequestGuard(() => f.manager.sendHeartbeatViaCaptain(f.agent.id, f.members[0].id, 'Check the current task'), f.beforeEffect, f.controller.signal)
  const rejected = expect(admission).rejects.toBe(f.authorityError)
  await entered.promise; f.revoke(); gate.resolve(); await rejected
  expect(f.adapter.createSession).not.toHaveBeenCalled(); expect(f.adapter.sendPrompt).not.toHaveBeenCalled()
  expect(f.manager.findSessionByTaskId(`heartbeat-${f.members[0].id}`)).toBeUndefined()
})
it('allows accepted heartbeat monitoring to run outside a completed caller guard', async () => {
  const f = fixture(), gate = deferred<void>(); finishers.push(() => gate.resolve())
  let detached!: Promise<string>, inherited!: Promise<string>
  await f.manager.withHeartbeatRequestGuard(async () => {
    detached = f.manager.detachedHeartbeatWork(async () => { await gate.promise; return f.manager.withHeartbeatRequestGuard(async () => 'owned monitoring', () => {}, new AbortController().signal) })
    inherited = (async () => { await gate.promise; return f.manager.withHeartbeatRequestGuard(async () => 'expired caller', f.beforeEffect, f.controller.signal) })()
  }, f.beforeEffect, f.controller.signal)
  const refused = expect(inherited).rejects.toMatchObject({ code: 'CANCELLED' })
  gate.resolve(); expect(await detached).toBe('owned monitoring'); await refused
})
it('holds a cancelled request until accepted native creation and acknowledged teardown both settle', async () => {
  const f = fixture(), created = deferred<string>(), entered = deferred<void>(), destroyed = deferred<void>(), destroying = deferred<void>()
  finishers.push(() => { created.resolve('group-native'); destroyed.resolve() })
  f.adapter.createSession.mockImplementation(async () => { entered.resolve(); return created.promise })
  f.adapter.destroySession.mockImplementation(async () => { destroying.resolve(); await destroyed.promise })
  const done = vi.fn(), start = f.manager.withTaskGroupRequestGuard(() => f.manager.startTask(f.taskId), f.beforeEffect, f.controller.signal)
  void start.then(done, done); const rejected = expect(start).rejects.toMatchObject({ code: 'CANCELLED' })
  await entered.promise; f.controller.abort(); created.resolve('group-native'); await destroying.promise
  expect(done).not.toHaveBeenCalled(); expect(f.adapter.sendPrompt).not.toHaveBeenCalled(); expect(f.db.getTask(f.taskId)?.session_id).toBeNull()
  destroyed.resolve(); await rejected; expect(f.adapter.destroySession).toHaveBeenCalledOnce(); expect(f.manager.findSessionByTaskId(f.taskId)).toBeUndefined()
})
it('keeps failed accepted native cleanup owned and refuses a new prompt or duplicate start until cleanup succeeds', async () => {
  const f = fixture(), created = deferred<string>(), entered = deferred<void>(); finishers.push(() => created.resolve('group-native'))
  f.adapter.createSession.mockImplementation(async () => { entered.resolve(); return created.promise })
  f.adapter.destroySession.mockRejectedValueOnce(new Error('Native teardown refused'))
  const start = f.manager.withTaskGroupRequestGuard(() => f.manager.startTask(f.taskId), f.beforeEffect, f.controller.signal)
  const rejected = expect(start).rejects.toThrow('Native teardown refused')
  await entered.promise; f.controller.abort(); created.resolve('group-native'); await rejected
  expect(f.manager.findSessionByTaskId(f.taskId)?.sessionId).toBe('group-native')
  await expect(f.manager.sendByTaskId(f.taskId, 'Do not act')).rejects.toThrow('cleanup must finish')
  await expect(f.manager.startTask(f.taskId)).rejects.toThrow('cleanup must finish')
  expect(f.adapter.createSession).toHaveBeenCalledOnce(); expect(f.adapter.sendPrompt).not.toHaveBeenCalled()
  await f.manager.stopSession('group-native', false, true)
})
it('does not bind or dispatch after an ignored-cancellation native resume finishes', async () => {
  const f = fixture(), gate = deferred<void>(), entered = deferred<void>(); finishers.push(() => gate.resolve())
  f.db.updateTask(f.taskId, { session_id: 'saved-group-native' })
  f.adapter.resumeSession.mockImplementation(async () => { entered.resolve(); await gate.promise; return [] })
  const resume = f.manager.withTaskGroupRequestGuard(() => f.manager.resumeSession(f.agent.id, f.taskId, 'saved-group-native'), f.beforeEffect, f.controller.signal)
  const rejected = expect(resume).rejects.toMatchObject({ code: 'CANCELLED' })
  await entered.promise; f.controller.abort(); gate.resolve(); await rejected
  expect(f.adapter.createSession).not.toHaveBeenCalled(); expect(f.adapter.sendPrompt).not.toHaveBeenCalled(); expect(f.adapter.destroySession).toHaveBeenCalledWith('saved-group-native', expect.any(Object))
  expect(f.manager.findSessionByTaskId(f.taskId)).toBeUndefined()
})
it('terminates the durable group message without replay when config readiness loses scope before send', async () => {
  const f = fixture(); await f.manager.requestSession(f.agent.id, f.taskId, undefined, true)
  const gate = deferred<void>(), entered = deferred<void>(); finishers.push(() => gate.resolve())
  f.ready.mockImplementation(async () => { entered.resolve(); await gate.promise; return null })
  const send = f.manager.withTaskGroupRequestGuard(() => f.manager.sendByTaskId(f.members[0].id, 'Review this member', undefined, 'scoped-send'), f.beforeEffect, f.controller.signal)
  const rejected = expect(send).rejects.toBe(f.authorityError)
  await entered.promise; f.revoke(); gate.resolve(); await rejected
  expect(f.adapter.sendPrompt).not.toHaveBeenCalled()
  const state = f.db.db.prepare("SELECT state FROM delivery_outbox WHERE idempotency_key='scoped-send'").get() as { state: string }
  expect(state.state).toBe('cancelled')
})
it('keeps accepted polling and later independent requests free of a completed caller scope', async () => {
  const f = fixture(), late = deferred<void>(); finishers.push(() => late.resolve())
  let buffered!: Promise<void>
  f.adapter.sendPrompt.mockImplementation(async () => { buffered = late.promise.then(() => f.adapter.signalData('group-native')) })
  await f.manager.withTaskGroupRequestGuard(() => f.manager.startTask(f.taskId), f.beforeEffect, f.controller.signal)
  f.controller.abort(); late.resolve(); await buffered
  await vi.advanceTimersByTimeAsync(100)
  f.adapter.sendPrompt.mockResolvedValue(undefined)
  await f.manager.sendByTaskId(f.taskId, 'Independent continuation')
  expect(f.adapter.createSession).toHaveBeenCalledOnce(); expect(f.adapter.sendPrompt).toHaveBeenCalledTimes(2)
})

it('keeps task-addressable ownership and Stop pending beyond a public SDK startup deadline', async () => {
  const f = fixture(), created = deferred<string>(), entered = deferred<void>(), destroyed = deferred<void>(), destroying = deferred<void>()
  finishers.push(() => { created.resolve('late-group-native'); destroyed.resolve() })
  f.adapter.createSession.mockImplementation(async () => { entered.resolve(); return created.promise })
  f.adapter.destroySession.mockImplementation(async () => { destroying.resolve(); await destroyed.promise })
  let bounded!: ReturnType<AgentManager['startTask']>
  const guarded = f.manager.withTaskGroupRequestGuard(() => { bounded = f.manager.startTask(f.taskId); return bounded }, f.beforeEffect, f.controller.signal)
  const rejected = expect(guarded).rejects.toThrow('timed out')
  await entered.promise; const boundedRejected = expect(bounded).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(AGENT_SESSION_START_TIMEOUT_MS); await boundedRejected
  expect(f.manager.hasTaskStartOwnership(f.taskId)).toBe(true)
  const stopped = vi.fn(), stop = f.manager.stopByTaskId(f.taskId).then(stopped)
  await Promise.resolve(); expect(stopped).not.toHaveBeenCalled(); expect(f.adapter.createSession).toHaveBeenCalledOnce()
  created.resolve('late-group-native'); await destroying.promise; expect(stopped).not.toHaveBeenCalled()
  destroyed.resolve(); await rejected; await stop
  expect(f.adapter.sendPrompt).not.toHaveBeenCalled(); expect(f.manager.hasTaskStartOwnership(f.taskId)).toBe(false)
})

it('never replays abandoned or expired heartbeat intents while acknowledging accepted receipts', async () => {
  const f = fixture(), taskId = f.members[0].id, deliveries = new DeliveryStore(f.db)
  const enqueue = (id: string) => deliveries.enqueue({ idempotencyKey: id, kind: 'agent_message', taskId, agentId: f.agent.id,
    payload: JSON.stringify({ sessionId: 'old-heartbeat', message: 'Old instructions', taskId: `heartbeat-${taskId}`, agentId: f.agent.id }) }).record
  const pending = enqueue('pending-heartbeat'), expired = enqueue('expired-heartbeat'), accepted = enqueue('accepted-heartbeat')
  deliveries.claim(expired.id, 'retired-process', 1)
  deliveries.claim(accepted.id, 'retired-process', 1000); deliveries.accept(accepted.id, 'retired-process', 'old-heartbeat')
  await vi.advanceTimersByTimeAsync(2)
  await Reflect.get(f.manager, 'recoverAgentMessages').call(f.manager)
  expect(deliveries.get(pending.id)?.state).toBe('cancelled'); expect(deliveries.get(expired.id)?.state).toBe('cancelled')
  expect(deliveries.get(accepted.id)?.state).toBe('acknowledged')
  expect(f.adapter.createSession).not.toHaveBeenCalled(); expect(f.adapter.sendPrompt).not.toHaveBeenCalled()
})
it('records an uncertain heartbeat send against its actual task and never retries the old check', async () => {
  const f = fixture(), taskId = f.members[0].id
  f.adapter.sendPrompt.mockRejectedValueOnce(new Error('Controlled acceptance uncertainty'))
  await expect(f.manager.withHeartbeatRequestGuard(() => f.manager.sendHeartbeatViaCaptain(f.agent.id, taskId, 'Current check'),
    f.beforeEffect, f.controller.signal)).rejects.toThrow('Controlled acceptance uncertainty')
  expect(f.db.db.prepare('SELECT task_id,state FROM delivery_outbox WHERE kind=?').all('agent_message')).toEqual([{ task_id: taskId, state: 'cancelled' }])
  await Reflect.get(f.manager, 'recoverAgentMessages').call(f.manager)
  expect(f.adapter.sendPrompt).toHaveBeenCalledOnce()
  await f.manager.cleanupHeartbeatSession(taskId, true)
})
