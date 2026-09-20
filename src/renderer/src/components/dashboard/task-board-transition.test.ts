import { describe, expect, it, vi } from 'vitest'
import { TaskStatus } from '@/types'
import type { Task } from '@/types'
import { transitionTaskFromBoard } from './task-board-transition'

function task(overrides: Partial<Task> = {}): Task {
  return { id: 'task-1', title: 'Board task', status: TaskStatus.NotStarted, ...overrides } as Task
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    startTask: vi.fn().mockResolvedValue({ action: 'task_started', sessionId: 'session-1' }),
    stopByTaskId: vi.fn().mockResolvedValue({ success: true }),
    getStartRecoveryState: vi.fn().mockResolvedValue(null),
    updateTask: vi.fn().mockResolvedValue(undefined),
    completeTask: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }
}

describe('transitionTaskFromBoard', () => {
  it('starts through admission without first writing agent_working', async () => {
    const d = deps()
    await expect(transitionTaskFromBoard(task({ agent_id: 'agent-1' }), TaskStatus.AgentWorking, d)).resolves.toEqual({ phase: 'working' })
    expect(d.startTask).toHaveBeenCalledTimes(1)
    expect(d.updateTask).not.toHaveBeenCalled()
  })

  it('reports a durable queued acknowledgement without manufacturing working state', async () => {
    const d = deps({ startTask: vi.fn().mockResolvedValue({ action: 'queued', queuePosition: 3, queueReason: 'agent_limit' }) })
    await expect(transitionTaskFromBoard(task({ agent_id: 'agent-1' }), TaskStatus.AgentWorking, d)).resolves.toEqual({ phase: 'queued', queuePosition: 3 })
    expect(d.updateTask).not.toHaveBeenCalled()
  })

  it('rolls back visibly on start failure and never writes the destination', async () => {
    const error = new Error('backend did not come up')
    const d = deps({ startTask: vi.fn().mockRejectedValue(error) })
    await expect(transitionTaskFromBoard(task({ agent_id: 'agent-1' }), TaskStatus.AgentWorking, d)).rejects.toBe(error)
    expect(d.updateTask).not.toHaveBeenCalled()
  })

  it('withdraws a queued start before moving the card away', async () => {
    const order: string[] = []
    const d = deps({
      getStartRecoveryState: vi.fn().mockResolvedValue({ state: 'queued' }),
      stopByTaskId: vi.fn(async () => { order.push('stop') }),
      updateTask: vi.fn(async () => { order.push('update') })
    })
    await transitionTaskFromBoard(task(), TaskStatus.ReadyForReview, d as never)
    expect(order).toEqual(['stop', 'update'])
  })

  it('stops a live task before completing it', async () => {
    const order: string[] = []
    const d = deps({
      stopByTaskId: vi.fn(async () => { order.push('stop') }),
      completeTask: vi.fn(async () => { order.push('complete') })
    })
    await transitionTaskFromBoard(task({ status: TaskStatus.AgentWorking }), TaskStatus.Completed, d)
    expect(order).toEqual(['stop', 'complete'])
  })
})
