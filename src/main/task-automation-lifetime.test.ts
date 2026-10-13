import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPortableDbFixture } from '../../test/helpers/portable-db-test-helper'
import { makeTask } from '../../test/helpers/task-fixtures'
import { TaskAutomationScheduler } from './task-automation-scheduler'
import type { AgentManager } from './agent-manager'

describe('task automation raw pass ownership', () => {
  let source: ReturnType<typeof createPortableDbFixture>
  const schedulers: TaskAutomationScheduler[] = []
  beforeEach(() => { source = createPortableDbFixture() })
  afterEach(async () => {
    for (const scheduler of schedulers) await scheduler.close()
    schedulers.length = 0
    source.rawDb.close()
  })
  function fixture(startTask = vi.fn().mockResolvedValue({ action: 'task_started' })) {
    const complete = vi.fn().mockResolvedValue(true)
    const scheduler = new TaskAutomationScheduler(source.db, {
      startTask, completeTaskWithoutReview: complete, hasActiveSessionForTask: () => false
    } as unknown as AgentManager)
    schedulers.push(scheduler)
    return { scheduler, startTask, complete }
  }

  it('retains a pending start through failed close, then skips remaining candidates and completion reads', async () => {
    source.db.createTask(makeTask({ auto_start_agent: true }))
    source.db.createTask(makeTask({ auto_start_agent: true }))
    source.db.createTask(makeTask({ status: 'ready_for_review', auto_complete_without_review: true }))
    let finish!: () => void
    const held = new Promise<void>(done => { finish = done })
    const start = vi.fn(async () => { await held; return { action: 'task_started' } })
    const { scheduler, complete } = fixture(start)
    const pass = scheduler.runNow()
    try {
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
      await expect(scheduler.close(5)).rejects.toThrow('TASK_AUTOMATION_SHUTDOWN_INCOMPLETE')
      expect(source.rawDb.open).toBe(true)
      const read = vi.spyOn(source.rawDb, 'prepare')
      let closed = false
      const retry = scheduler.close().then(() => { closed = true })
      await Promise.resolve()
      expect(closed).toBe(false)
      finish()
      await pass
      await retry
      expect(start).toHaveBeenCalledOnce()
      expect(complete).not.toHaveBeenCalled()
      expect(read).not.toHaveBeenCalled()
      read.mockRestore()
      expect(() => scheduler.start()).toThrow('TASK_AUTOMATION_CLOSED')
      await expect(scheduler.runNow()).rejects.toThrow('TASK_AUTOMATION_CLOSED')
    } finally { finish(); await pass }
  })

  it('joins a late completion write before returning from close', async () => {
    const task = source.db.createTask(makeTask({ status: 'ready_for_review', auto_complete_without_review: true }))!
    let finish!: () => void
    const held = new Promise<void>(done => { finish = done })
    const { scheduler, complete } = fixture()
    complete.mockImplementation(async () => {
      await held
      source.db.updateTask(task.id, { status: 'completed' })
      return true
    })
    const pass = scheduler.runNow()
    try {
      await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce())
      await expect(scheduler.close(5)).rejects.toThrow('TASK_AUTOMATION_SHUTDOWN_INCOMPLETE')
      const retry = scheduler.close()
      expect(source.db.getTask(task.id)?.status).toBe('ready_for_review')
      finish()
      await pass
      await retry
      expect(source.db.getTask(task.id)?.status).toBe('completed')
    } finally { finish(); await pass }
  })

  it('cancels a queued pass before any database access', async () => {
    const { scheduler, startTask } = fixture()
    const read = vi.spyOn(source.rawDb, 'prepare')
    const pass = scheduler.runNow()
    scheduler.shutdown()
    await scheduler.close()
    await pass
    expect(read).not.toHaveBeenCalled()
    expect(startTask).not.toHaveBeenCalled()
    read.mockRestore()
  })

  it('coalesces overlapping callers onto the same raw pass without starting twice', async () => {
    source.db.createTask(makeTask({ auto_start_agent: true }))
    let finish!: () => void
    const held = new Promise<void>(done => { finish = done })
    const start = vi.fn(async () => { await held; return { action: 'task_started' } })
    const { scheduler } = fixture(start)
    const first = scheduler.runNow()
    const second = scheduler.runNow()
    let secondDone = false
    void second.then(() => { secondDone = true })
    try {
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
      expect(secondDone).toBe(false)
      finish()
      await Promise.all([first, second])
      expect(start).toHaveBeenCalledOnce()
    } finally { finish(); await Promise.all([first, second]) }
  })

  it('validates the close deadline without closing ordinary admission', async () => {
    source.db.createTask(makeTask({ auto_start_agent: true }))
    const { scheduler, startTask } = fixture()
    await expect(scheduler.close(0)).rejects.toBeInstanceOf(RangeError)
    await scheduler.runNow()
    expect(startTask).toHaveBeenCalledOnce()
  })
})
