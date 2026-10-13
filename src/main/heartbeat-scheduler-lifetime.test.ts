import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPortableDbFixture } from '../../test/helpers/portable-db-test-helper'
import { makeAgent, makeTask } from '../../test/helpers/task-fixtures'
import type { AgentManager } from './agent-manager'
import { HeartbeatSchedulerCore } from './heartbeat-scheduler-core'

describe('heartbeat raw work ownership', () => {
  let source: ReturnType<typeof createPortableDbFixture>
  const owners: HeartbeatSchedulerCore[] = []
  beforeEach(() => { source = createPortableDbFixture() })
  afterEach(async () => {
    for (const owner of owners.splice(0)) await owner.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
    source.rawDb.close()
  })
  function held() {
    let finish!: () => void
    const promise = new Promise<void>(resolve => { finish = resolve })
    return { promise, finish }
  }
  function fixture(options: ConstructorParameters<typeof HeartbeatSchedulerCore>[2] = {}) {
    const agent = source.db.createAgent(makeAgent({ is_default: true }))!
    const task = source.db.createTask(makeTask({ status: 'ready_for_review' }))!
    source.db.updateTask(task.id, { agent_id: agent.id, heartbeat_enabled: true, heartbeat_next_check_at: new Date(Date.now() - 60_000).toISOString() })
    const manager = {
      sendHeartbeatViaCaptain: vi.fn().mockResolvedValue('fixture-captain'),
      startHeartbeatSession: vi.fn().mockResolvedValue('fixture-task-session'),
      cleanupHeartbeatSession: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockReturnValue({ status: 'working' }),
      findSessionByTaskId: vi.fn(), getLastAssistantMessage: vi.fn(),
      hasActiveSessionForTask: vi.fn().mockReturnValue(false)
    }
    const owner = new HeartbeatSchedulerCore(source.db, manager as unknown as AgentManager, options)
    vi.spyOn(owner, 'readHeartbeatFile').mockReturnValue('Check fixture state')
    vi.spyOn(owner, 'hasHeartbeatFile').mockReturnValue(true)
    owners.push(owner)
    return { owner, manager, task }
  }

  it('retains a pending manual send and its late cleanup write through failed-close/retry', async () => {
    const send = held(), cleanup = held()
    const { owner, manager, task } = fixture()
    manager.sendHeartbeatViaCaptain.mockImplementation(async () => { await send.promise; return 'fixture-captain' })
    manager.cleanupHeartbeatSession.mockImplementation(async () => {
      await cleanup.promise
      source.db.setSetting('fixture_heartbeat_cleanup', 'settled')
    })
    const request = owner.runNow(task.id)
    try {
      await vi.waitFor(() => expect(manager.sendHeartbeatViaCaptain).toHaveBeenCalledOnce())
      await expect(owner.close(5)).rejects.toThrow('HEARTBEAT_SHUTDOWN_INCOMPLETE')
      send.finish()
      await vi.waitFor(() => expect(manager.cleanupHeartbeatSession).toHaveBeenCalledOnce())
      await expect(owner.close(5)).rejects.toThrow('HEARTBEAT_SHUTDOWN_INCOMPLETE')
      const retry = owner.close()
      cleanup.finish()
      expect(await request).toBe('error')
      await retry
      expect(source.db.getSetting('fixture_heartbeat_cleanup')).toBe('settled')
      expect(manager.getSession).not.toHaveBeenCalled()
      expect(manager.startHeartbeatSession).not.toHaveBeenCalled()
    } finally { send.finish(); cleanup.finish(); await request }
  })

  it('cancels detached session polling and joins cleanup without logging shutdown as a heartbeat error', async () => {
    vi.useFakeTimers()
    const { owner, manager, task } = fixture()
    expect(await owner.runNow(task.id)).toBe('sent')
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(1)
    const write = vi.spyOn(source.db, 'createHeartbeatLog')
    await owner.close()
    expect(vi.getTimerCount()).toBe(0)
    expect(manager.cleanupHeartbeatSession).toHaveBeenCalledOnce()
    expect(manager.getSession).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('retains raw preflight and skips its late result, next task and agent launch', async () => {
    const gate = held()
    const preflight = vi.fn(async () => { await gate.promise; return 'no_changes' as const })
    const { owner, manager } = fixture({ preflight })
    owner.start()
    try {
      await vi.waitFor(() => expect(preflight).toHaveBeenCalledOnce())
      await expect(owner.close(5)).rejects.toThrow('HEARTBEAT_SHUTDOWN_INCOMPLETE')
      const sql = vi.spyOn(source.rawDb, 'prepare')
      const retry = owner.close()
      gate.finish()
      await retry
      expect(sql).not.toHaveBeenCalled()
      expect(manager.sendHeartbeatViaCaptain).not.toHaveBeenCalled()
      expect(manager.cleanupHeartbeatSession).toHaveBeenCalledOnce()
      sql.mockRestore()
    } finally { gate.finish(); await owner.close() }
  })

  it('joins detached forwarding accepted before shutdown without scheduling another check', async () => {
    const gate = held()
    const { owner, manager, task } = fixture()
    manager.getSession.mockReturnValue({ status: 'idle' })
    manager.getLastAssistantMessage.mockReturnValue('Fixture needs attention')
    manager.startHeartbeatSession.mockImplementation(async () => { await gate.promise; return 'fixture-task-session' })
    expect(await owner.runNow(task.id)).toBe('sent')
    try {
      await vi.waitFor(() => expect(manager.startHeartbeatSession).toHaveBeenCalledOnce(), { timeout: 4000 })
      await expect(owner.close(5)).rejects.toThrow('HEARTBEAT_SHUTDOWN_INCOMPLETE')
      const update = vi.spyOn(source.db, 'updateTask')
      const retry = owner.close()
      gate.finish()
      await retry
      expect(update).not.toHaveBeenCalled()
      expect(manager.cleanupHeartbeatSession).toHaveBeenCalledOnce()
      update.mockRestore()
    } finally { gate.finish(); await owner.close() }
  })

  it('cancels queued manual and scheduled work and rejects late direct database operations', async () => {
    const { owner, task } = fixture()
    const sql = vi.spyOn(source.rawDb, 'prepare')
    owner.start()
    const request = owner.runNow(task.id)
    owner.shutdown()
    await owner.close()
    expect(await request).toBe('error')
    expect(sql).not.toHaveBeenCalled()
    expect(() => owner.start()).toThrow('HEARTBEAT_SCHEDULER_CLOSED')
    expect(() => owner.enableHeartbeat(task.id)).toThrow('HEARTBEAT_SCHEDULER_CLOSED')
    expect(() => owner.writeHeartbeatFile(task.id, 'late')).toThrow('HEARTBEAT_SCHEDULER_CLOSED')
    await expect(owner.runNow(task.id)).rejects.toThrow('HEARTBEAT_SCHEDULER_CLOSED')
    sql.mockRestore()
  })

  it('validates deadlines before closing normal admission', async () => {
    const { owner, task } = fixture()
    await expect(owner.close(0)).rejects.toBeInstanceOf(RangeError)
    owner.enableHeartbeat(task.id)
    expect(source.db.getTask(task.id)?.heartbeat_enabled).toBe(true)
  })

  it('keeps a task busy until its previous heartbeat session cleanup settles', async () => {
    vi.useFakeTimers()
    const gate = held()
    const { owner, manager, task } = fixture()
    manager.getSession.mockReturnValue({ status: 'idle' })
    manager.getLastAssistantMessage.mockReturnValue('HEARTBEAT_OK')
    manager.cleanupHeartbeatSession.mockImplementation(() => gate.promise)
    try {
      expect(await owner.runNow(task.id)).toBe('sent')
      await vi.advanceTimersByTimeAsync(3000)
      expect(manager.cleanupHeartbeatSession).toHaveBeenCalledOnce()
      expect(await owner.runNow(task.id)).toBe('in_progress')
      expect(manager.sendHeartbeatViaCaptain).toHaveBeenCalledOnce()
      gate.finish()
      await owner.close()
    } finally { gate.finish() }
  })
})
