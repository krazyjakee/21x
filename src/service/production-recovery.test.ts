import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { TaskStatus } from '../shared/constants'
import { DurableStartQueueStore } from '../main/sessions/start-queue-store'
import { DeliveryStore, type DeliveryKind } from '../main/sessions/delivery-store'
import { ProviderRecoveryStore, type ProviderRecovery } from '../main/sessions/provider-recovery-store'
import { CaptainRuntimeStore } from '../main/sessions/runtime-store'
import { reconcileProductionRestart, PRODUCTION_RESTART_REVIEW } from './production-recovery'

const databases: ReturnType<typeof createPortableTestDb>[] = []
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close() })
function fixture() {
  const db = createPortableTestDb(); databases.push(db)
  const agent = db.createAgent({ name: 'Controlled adapter', is_default: true })!
  const project = db.createProject({ name: 'Restart fixture' })!
  const task = () => {
    const row = db.createTask({ title: 'Inspect before retry', project_id: project.id })!
    return db.updateTask(row.id, { agent_id: agent.id })!
  }
  const queue = new DurableStartQueueStore(db)
  const enqueue = (id: string) => queue.enqueue({ taskId: id, projectId: project.id, agentId: agent.id, priority: 'medium', reason: 'recovery', queuedAt: new Date().toISOString() }).record
  return { db, agent, project, task, queue, enqueue }
}

describe('production restart effect authority', () => {
  it('leaves an actual unrelated process serving requests even when an old lease contains its PID', async () => {
    const f = fixture(), task = f.task(), row = f.enqueue(task.id)
    const child = spawn(process.execPath, ['-e', 'process.stdin.on("data", () => process.stdout.write("alive"))'], { stdio: ['pipe', 'pipe', 'ignore'] })
    const closed = once(child, 'close')
    try {
      await once(child, 'spawn')
      f.db.db.prepare("UPDATE agent_start_queue SET state='starting', lease_owner=? WHERE id=?").run(`old-process:${child.pid}`, row.id)
      reconcileProductionRestart(f.db)
      const reply = once(child.stdout, 'data'); child.stdin.write('probe')
      expect(String((await reply)[0])).toBe('alive')
      expect(child.exitCode).toBeNull(); expect(child.killed).toBe(false)
      expect(f.queue.get(task.id)?.state).toBe('failed')
    } finally { child.kill(); await closed }
  })

  it.each(['queued', 'retrying', 'claimed', 'starting'])('retires an old %s start without waiting for lease expiry or losing identity', state => {
    const f = fixture(), task = f.task(), row = f.enqueue(task.id)
    f.db.db.prepare('UPDATE agent_start_queue SET state=?, lease_owner=?, lease_expires_at=? WHERE id=?').run(state, 'old-owner', Date.now() + 86_400_000, row.id)
    f.db.updateTask(task.id, { status: TaskStatus.AgentWorking, session_id: 'saved-backend', auto_start_agent: true, auto_complete_without_review: true })
    expect(reconcileProductionRestart(f.db)).toMatchObject({ tasks: 1, starts: 1 })
    expect(f.queue.get(task.id)).toMatchObject({ id: row.id, state: 'failed', recoveryCause: PRODUCTION_RESTART_REVIEW, leaseOwner: null })
    expect(f.queue.acknowledgeStarted(row.id, row.generation, 'late-session')).toBe(false)
    expect(f.db.getTask(task.id)).toMatchObject({ status: TaskStatus.NotStarted, session_id: 'saved-backend', agent_id: f.agent.id, auto_start_agent: false, auto_complete_without_review: false })
    expect(reconcileProductionRestart(f.db)).toEqual({ tasks: 0, starts: 0, providers: 0, deliveries: 0, captains: 0 })
    // An explicit new request can reuse the durable row with a new generation.
    expect(f.enqueue(task.id)).toMatchObject({ id: row.id, state: 'queued' })
    expect(f.queue.get(task.id)!.generation).toBeGreaterThan(row.generation)
  })

  it('pauses a serial parent chain, preserves completed work and leaves unrelated future automation eligible', () => {
    const f = fixture(), parent = f.task(), child = f.task(), complete = f.task(), unrelated = f.task()
    f.db.updateTask(parent.id, { auto_start_agent: true, auto_complete_without_review: true })
    f.db.updateTask(child.id, { parent_task_id: parent.id, status: TaskStatus.Triaging })
    f.db.updateTask(complete.id, { status: TaskStatus.Completed })
    f.db.updateTask(unrelated.id, { auto_start_agent: true })
    f.enqueue(complete.id)
    reconcileProductionRestart(f.db)
    expect(f.db.getTask(parent.id)).toMatchObject({ auto_start_agent: false, auto_complete_without_review: false })
    expect(f.db.getTask(child.id)?.status).toBe(TaskStatus.NotStarted)
    expect(f.queue.get(child.id)?.state).toBe('failed')
    expect(f.db.getTask(complete.id)?.status).toBe(TaskStatus.Completed)
    expect(f.db.getTask(unrelated.id)).toMatchObject({ status: TaskStatus.NotStarted, auto_start_agent: true })
  })

  it.each<DeliveryKind>(['agent_message', 'captain_request', 'captain_report', 'captain_handoff_seed'])('retires old pending/claimed %s, retains accepted receipts and original payloads', kind => {
    const f = fixture(), task = f.task(), store = new DeliveryStore(f.db)
    const rows = ['pending', 'claimed', 'accepted', 'acknowledged'].map(state => {
      const row = store.enqueue({ idempotencyKey: `${kind}:${state}`, kind, taskId: task.id, projectId: f.project.id, payload: `saved ${state} payload` }).record
      f.db.db.prepare('UPDATE delivery_outbox SET state=?, claim_owner=?, claim_expires_at=?, destination_id=? WHERE id=?').run(state, 'old-owner', Date.now() + 86_400_000, 'saved-destination', row.id)
      return row
    })
    expect(reconcileProductionRestart(f.db).deliveries).toBe(2)
    for (const row of rows.slice(0, 2)) {
      expect(store.get(row.id)).toMatchObject({ id: row.id, state: 'cancelled', payload: row.payload, claimOwner: null })
      expect(store.claim(row.id, 'new-owner', 1000)).toBeNull()
      expect(store.enqueue({ idempotencyKey: row.idempotencyKey, kind, taskId: task.id, projectId: f.project.id, payload: row.payload }).record.state).toBe('cancelled')
    }
    expect(store.get(rows[2].id)).toMatchObject({ state: 'accepted', destinationId: 'saved-destination' })
    expect(store.get(rows[3].id)?.state).toBe('acknowledged')
  })

  it.each<ProviderRecovery['state']>(['sending', 'accepted', 'retrying', 'dispatching'])('fences a %s provider intent, keeping its delivery evidence and preventing fallback dispatch', state => {
    const f = fixture(), task = f.task(), store = new ProviderRecoveryStore(f.db)
    const row = store.begin({ taskId: task.id, sessionId: 'saved-thread', agentId: f.agent.id, prompt: 'mutating instruction', remainingAgentIds: ['fallback'], attemptedAgentIds: [f.agent.id] })
    const active = store.change(row, { state, delivery: 'unknown', nextRetryAt: Date.now() + 1000 })!
    expect(reconcileProductionRestart(f.db).providers).toBe(1)
    expect(store.get(task.id)).toMatchObject({ intentId: row.intentId, sessionId: 'saved-thread', state: 'failed', prompt: '', nextRetryAt: null, delivery: 'unknown', remainingAgentIds: ['fallback'] })
    expect(store.change(active, { state: 'accepted' })).toBeNull()
  })

  it('keeps Captain identity/selection evidence while retiring old runtime authority', () => {
    const f = fixture(), captain = f.db.db.prepare("SELECT id FROM tasks WHERE role='captain' AND project_id=?").get(f.project.id) as { id: string }
    const store = new CaptainRuntimeStore(f.db), row = store.begin({ ownerId: captain.id, projectId: f.project.id, agentId: f.agent.id, lastGoodAgentId: f.agent.id, deadlineAt: Date.now() + 86_400_000 })
    store.transition(captain.id, row.generation, 'healthy', { sessionId: 'saved-captain' })
    expect(reconcileProductionRestart(f.db).captains).toBe(1)
    expect(store.get(captain.id)).toMatchObject({ phase: 'failed', sessionId: 'saved-captain', deadlineAt: null, errorCode: 'RESTART_REVIEW_REQUIRED' })
  })

  it('preserves group progress and completed members while retiring the interrupted execution anchor', () => {
    const f = fixture(), first = f.task(), second = f.task()
    const group = f.db.createTaskGroup({ title: 'Interrupted shared run', task_ids: [first.id, second.id] })
    f.db.updateTask(group.execution_task_id, { status: TaskStatus.AgentWorking, session_id: 'saved-group' })
    f.db.setTaskGroupProgress(group.id, first.id, 'done', 'Written before restart')
    f.db.updateTask(first.id, { status: TaskStatus.Completed, complete_at_source: false }, 'task-group')
    reconcileProductionRestart(f.db)
    expect(f.db.getTask(group.execution_task_id)).toMatchObject({ status: TaskStatus.NotStarted, session_id: 'saved-group' })
    expect(f.db.getTask(first.id)?.status).toBe(TaskStatus.Completed)
    expect(f.db.getTask(second.id)?.status).toBe(TaskStatus.NotStarted)
    expect(f.db.getTaskGroup(group.id)?.progress).toEqual(expect.arrayContaining([expect.objectContaining({ task_id: first.id, state: 'done', message: 'Written before restart' })]))
  })

  it('rolls every reconciliation change back if the durable recovery journal cannot commit', () => {
    const f = fixture(), task = f.task(), row = f.enqueue(task.id)
    f.db.updateTask(task.id, { status: TaskStatus.AgentWorking, auto_start_agent: true })
    vi.spyOn(f.db, 'appendProjectStatusJournal').mockImplementation(() => { throw new Error('controlled write refusal') })
    expect(() => reconcileProductionRestart(f.db)).toThrow('controlled write refusal')
    expect(f.queue.get(task.id)).toMatchObject({ id: row.id, state: 'queued' })
    expect(f.db.getTask(task.id)).toMatchObject({ status: TaskStatus.AgentWorking, auto_start_agent: true })
  })
})
