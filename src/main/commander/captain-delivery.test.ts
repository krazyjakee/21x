import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { CaptainDeliveryService, correlationForDeliveryKey } from './captain-delivery'

describe('CaptainDeliveryService', () => {
  afterEach(() => vi.useRealTimers())
  it('routes startup failure to the durable originating session and exact correlation', async () => {
    const { db } = createTestDb()
    const agent = db.createAgent({ name: 'Captain' })!
    const project = db.createProject({ name: 'Origin' })!
    const task = db.getCoordinatorTask(project.id)!
    const terminal = vi.fn()
    const service = new CaptainDeliveryService({
      db,
      agents: { sendMessage: vi.fn(async () => { throw new Error('server exited during startup') }) },
      onTerminalFailure: terminal
    })
    const key = 'commander:session-origin:tool:tool-call-7'

    const accepted = service.enqueueRequest({
      idempotencyKey: key,
      sourceSessionId: 'session-origin',
      projectId: project.id,
      taskId: task.id,
      agentId: agent.id,
      payload: 'request'
    })

    await vi.waitFor(() => expect(terminal).toHaveBeenCalledTimes(1))
    expect(service.store.get(accepted.id)).toMatchObject({
      state: 'failed',
      sourceSessionId: 'session-origin',
      correlationId: correlationForDeliveryKey(key),
      lastError: 'server exited during startup'
    })
    expect(terminal).toHaveBeenCalledWith(
      expect.objectContaining({ id: accepted.id, sourceSessionId: 'session-origin' }),
      'server exited during startup',
      false
    )
  })

  it('does not dispatch the same accepted request again after reconnect', async () => {
    const { db } = createTestDb()
    const agent = db.createAgent({ name: 'Captain' })!
    const project = db.createProject({ name: 'Reconnect' })!
    const task = db.getCoordinatorTask(project.id)!
    const sendMessage = vi.fn(async () => ({ newSessionId: 'captain-session' }))
    const service = new CaptainDeliveryService({ db, agents: { sendMessage }, onTerminalFailure: vi.fn() })
    const input = {
      idempotencyKey: 'commander:session:tool:stable',
      sourceSessionId: 'session',
      projectId: project.id,
      taskId: task.id,
      agentId: agent.id,
      payload: 'request'
    }

    const first = service.enqueueRequest(input)
    await vi.waitFor(() => expect(service.store.get(first.id)?.state).toBe('accepted'))
    const duplicate = service.enqueueRequest(input)
    await service.reconcile()

    expect(duplicate.id).toBe(first.id)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(service.store.get(first.id)).toMatchObject({ state: 'accepted', destinationId: 'captain-session' })
    service.dispose()
  })
  it('recovers an unexpired crash claim on a later sweep without a second app restart', async () => {
    vi.useFakeTimers()
    const { db } = createTestDb()
    const sendMessage = vi.fn(async () => ({}))
    const service = new CaptainDeliveryService({ db, agents: { sendMessage }, onTerminalFailure: vi.fn() })
    const row = service.store.enqueue({ idempotencyKey: 'crashed', kind: 'captain_request', payload: 'ask', deadlineAt: Date.now() + 900_000 }).record
    service.store.claim(row.id, 'dead-process', 60_000)
    await service.reconcile()
    expect(sendMessage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(service.store.get(row.id)?.state).toBe('accepted')
    service.dispose()
  })

  it('does not duplicate a live slow handoff after its lease expires', async () => {
    vi.useFakeTimers()
    const { db } = createTestDb()
    let finish!: () => void
    const sendMessage = vi.fn(() => new Promise<{ newSessionId?: string }>((resolve) => { finish = () => resolve({}) }))
    const service = new CaptainDeliveryService({ db, agents: { sendMessage }, onTerminalFailure: vi.fn() })
    const row = service.store.enqueue({ idempotencyKey: 'slow', kind: 'captain_request', payload: 'ask' }).record
    const first = service.dispatch(row)
    await vi.advanceTimersByTimeAsync(61_000)
    const duplicate = service.dispatch(service.store.get(row.id)!)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    finish()
    await Promise.all([first, duplicate])
    expect(service.store.get(row.id)?.state).toBe('accepted')
    service.dispose()
  })

  it('replays a terminal failure lost between the durable transition and report insertion', async () => {
    const { db } = createTestDb()
    const terminal = vi.fn()
    const service = new CaptainDeliveryService({ db, agents: { sendMessage: vi.fn() }, onTerminalFailure: terminal })
    const row = service.store.enqueue({ idempotencyKey: 'failed-before-report', kind: 'captain_request', payload: 'ask' }).record
    service.store.terminal(row.id, 'failed', 'server exited')
    await service.reconcile()
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ id: row.id }), 'server exited', false)
    service.dispose()
  })

  it('cancels the queued Captain message when its request passes the deadline', async () => {
    vi.useFakeTimers()
    const { db } = createTestDb()
    const sendMessage = vi.fn()
    const service = new CaptainDeliveryService({ db, agents: { sendMessage }, onTerminalFailure: vi.fn() })
    const row = service.store.enqueue({ idempotencyKey: 'late', kind: 'captain_request', payload: 'ask', deadlineAt: Date.now() + 1_000 }).record
    const message = service.store.enqueue({ idempotencyKey: `captain-request-message:${row.id}`, kind: 'agent_message', payload: '{}' }).record

    await vi.advanceTimersByTimeAsync(2_000)
    await service.reconcile()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(service.store.get(row.id)?.state).toBe('timed_out')
    expect(service.store.get(message.id)).toMatchObject({ state: 'cancelled', lastError: 'The originating Captain request timed out.' })
    service.dispose()
  })

})
