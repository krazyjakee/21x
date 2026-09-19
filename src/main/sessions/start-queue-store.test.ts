import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { makeAgent, makeTask } from '../../../test/helpers/task-fixtures'
import type { DatabaseManager, TaskRecord } from '../database'
import { DurableStartQueueStore, START_QUEUE_MAX_RETRIES } from './start-queue-store'

describe('DurableStartQueueStore (#148)', () => {
  let db: DatabaseManager
  let now: number
  let store: DurableStartQueueStore
  let agentId: string
  let alpha: string

  beforeEach(() => {
    ;({ db } = createTestDb())
    now = Date.parse('2026-09-19T12:00:00.000Z')
    store = new DurableStartQueueStore(db, () => now)
    agentId = db.createAgent(makeAgent())!.id
    alpha = db.createProject({ name: 'Alpha' })!.id
  })

  const task = (title: string, priority: TaskRecord['priority'] = 'medium', projectId = alpha): TaskRecord => {
    const created = db.createTask(makeTask({ title, priority, project_id: projectId }))!
    return db.updateTask(created.id, { agent_id: agentId })!
  }

  const enqueue = (record: TaskRecord, reason: 'agent_limit' | 'recovery' = 'agent_limit') => store.enqueue({
    taskId: record.id,
    projectId: record.project_id,
    agentId,
    priority: record.priority,
    reason,
    queuedAt: new Date(now).toISOString(),
    dependencyReason: null
  })

  it('commits a stable, complete row before reporting the queue position', () => {
    const work = task('Work', 'high')
    const first = enqueue(work)
    const restored = new DurableStartQueueStore(db, () => now).info(work.id)

    expect(first.position).toBe(1)
    expect(restored).toMatchObject({
      id: first.record.id,
      taskId: work.id,
      projectId: alpha,
      agentId,
      priority: 'high',
      reason: 'agent_limit',
      state: 'queued',
      retryCount: 0,
      generation: 1
    })
    expect(restored?.queuedAt).toBe(new Date(now).toISOString())
  })

  it('deduplicates repeated enqueue and keeps the stable id and FIFO sequence', () => {
    const work = task('Once')
    const first = enqueue(work)
    now += 10_000
    const duplicate = enqueue(work, 'recovery')

    expect(duplicate.added).toBe(false)
    expect(duplicate.record.id).toBe(first.record.id)
    expect(duplicate.record.seq).toBe(first.record.seq)
    expect(store.list()).toHaveLength(1)
  })

  it('preserves priority/FIFO within projects and round-robin fairness across projects', () => {
    const beta = db.createProject({ name: 'Beta' })!.id
    const aMedium = task('A medium', 'medium')
    enqueue(aMedium)
    now += 1
    const aCritical = task('A critical', 'critical')
    enqueue(aCritical)
    now += 1
    const bLow = task('B low', 'low', beta)
    enqueue(bLow)

    expect(store.snapshot().map((row) => row.taskId)).toEqual([aCritical.id, bLow.id, aMedium.id])

    store.markServed(alpha)
    const afterRestart = new DurableStartQueueStore(db, () => now)
    expect(afterRestart.snapshot().map((row) => row.taskId)).toEqual([bLow.id, aCritical.id, aMedium.id])
  })

  it('generation-fences claim, start and acknowledgement boundaries', () => {
    const work = task('Fenced')
    const queued = enqueue(work).record
    const claim = store.claim(work.id, 'process-a')!

    expect(claim.generation).toBe(queued.generation + 1)
    expect(store.claim(work.id, 'process-b')).toBeNull()
    expect(store.markStarting(claim.id, claim.generation - 1)).toBe(false)
    expect(store.markStarting(claim.id, claim.generation)).toBe(true)
    expect(store.acknowledgeStarted(claim.id, claim.generation - 1, 'late')).toBe(false)
    expect(store.acknowledgeStarted(claim.id, claim.generation, 'session-1')).toBe(true)
    expect(store.info(work.id)).toMatchObject({ state: 'started', recoveryResult: 'session_acknowledged' })
  })

  it('restores an interrupted claim on restart without creating another row', () => {
    const work = task('Crash boundary')
    const stableId = enqueue(work).record.id
    const claim = store.claim(work.id, 'dead-process')!
    expect(store.markStarting(claim.id, claim.generation)).toBe(true)

    const restarted = new DurableStartQueueStore(db, () => now)
    const interrupted = restarted.interruptedClaims('new-process')
    expect(interrupted).toHaveLength(1)
    const restored = restarted.requeueInterrupted(interrupted[0], 'crash_after_start')!

    expect(restored.id).toBe(stableId)
    expect(restored).toMatchObject({ state: 'retrying', retryCount: 1, recoveryCause: 'crash_after_start' })
  })

  it('retries recoverable failures with bounded exponential backoff then terminates', () => {
    const work = task('Retry')
    enqueue(work, 'recovery')

    let previousDelay = 0
    for (let attempt = 1; attempt <= START_QUEUE_MAX_RETRIES + 1; attempt++) {
      const claim = store.claim(work.id, 'process')!
      store.markStarting(claim.id, claim.generation)
      const outcome = store.failOrRetry(claim.id, claim.generation, `failure ${attempt}`)!
      if (attempt <= START_QUEUE_MAX_RETRIES) {
        expect(outcome.state).toBe('retrying')
        const delay = outcome.record.nextRetryAt! - now
        expect(delay).toBeGreaterThan(previousDelay)
        previousDelay = delay
        now = outcome.record.nextRetryAt!
      } else {
        expect(outcome.state).toBe('failed')
        expect(outcome.record.recoveryResult).toBe(`retry_exhausted_after_${START_QUEUE_MAX_RETRIES}`)
      }
    }
    expect(store.snapshot()).toEqual([])
  })

  it('persists manual-stop exclusion and never dispatches it again', () => {
    const work = task('Stopped')
    enqueue(work)
    expect(store.cancel(work.id, 'manual_stop', 'manual_stop_not_retried')).toBe(true)

    const restarted = new DurableStartQueueStore(db, () => now)
    expect(restarted.snapshot()).toEqual([])
    expect(restarted.info(work.id)).toMatchObject({
      state: 'cancelled',
      recoveryCause: 'manual_stop',
      recoveryAction: 'exclude_from_retry',
      recoveryResult: 'manual_stop_not_retried'
    })
  })

  it('cannot restore a queue row after its task is deleted', () => {
    const work = task('Deleted')
    enqueue(work)
    db.deleteTask(work.id)

    const restarted = new DurableStartQueueStore(db, () => now)
    expect(restarted.info(work.id)).toBeNull()
    expect(restarted.snapshot()).toEqual([])
  })

  it('reclaims a live reconnect and removes it from dispatch order', () => {
    const work = task('Reconnect')
    enqueue(work, 'recovery')
    expect(store.markRecovered(work.id, 'session-live', 'restart_live_reconnect')).toBe(true)
    expect(store.snapshot()).toEqual([])
    expect(store.info(work.id)).toMatchObject({ state: 'recovered', recoveryResult: 'live_session_reclaimed' })
    expect(store.get(work.id)?.sessionId).toBe('session-live')
  })

  it('keeps unavailable-agent work durable and starts it when the agent returns after backoff', () => {
    const work = task('Agent returns')
    enqueue(work, 'recovery')
    const firstClaim = store.claim(work.id, 'process')!
    store.markStarting(firstClaim.id, firstClaim.generation)
    const retry = store.failOrRetry(firstClaim.id, firstClaim.generation, 'agent unavailable', 'agent_unavailable')!

    expect(store.claim(work.id, 'process')).toBeNull()
    now = retry.record.nextRetryAt!
    const recoveredClaim = store.claim(work.id, 'process')!
    expect(store.markStarting(recoveredClaim.id, recoveredClaim.generation)).toBe(true)
    expect(store.acknowledgeStarted(recoveredClaim.id, recoveredClaim.generation, 'session-returned')).toBe(true)

    const restarted = new DurableStartQueueStore(db, () => now)
    expect(restarted.interruptedClaims('another-process')).toEqual([])
    expect(restarted.info(work.id)).toMatchObject({ state: 'started', retryCount: 1, recoveryResult: 'session_acknowledged' })
  })
})
