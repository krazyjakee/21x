import { describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { CaptainDeliveryService, correlationForDeliveryKey } from './captain-delivery'

describe('CaptainDeliveryService', () => {
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
  })
})
