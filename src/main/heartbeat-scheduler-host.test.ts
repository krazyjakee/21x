import { afterEach, describe, expect, it, vi } from 'vitest'
import { Notification, type BrowserWindow } from 'electron'
import { createPortableDbFixture } from '../../test/helpers/portable-db-test-helper'
import { makeTask } from '../../test/helpers/task-fixtures'
import { HeartbeatScheduler } from './heartbeat-scheduler'
import type { AgentManager } from './agent-manager'

describe('heartbeat native host adapter', () => {
  const source = createPortableDbFixture()
  const owner = new HeartbeatScheduler(source.db, {} as AgentManager)
  afterEach(async () => { await owner.close(); vi.restoreAllMocks(); source.rawDb.close() })

  it('rebinds guarded renderer events and preserves native notification dispatch', () => {
    const first = { isDestroyed: () => false, webContents: { send: vi.fn() } }
    const current = { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } }
    owner.start(first as unknown as BrowserWindow)
    owner.start(current as unknown as BrowserWindow)
    const task = source.db.createTask(makeTask())!
    owner.enableHeartbeat(task.id)
    expect(first.webContents.send).not.toHaveBeenCalled()
    expect(current.webContents.send).toHaveBeenCalledWith('task:updated', expect.objectContaining({ taskId: task.id }))
    const notification = vi.mocked(Notification)
    notification.mockClear()
    const show = vi.fn()
    notification.mockImplementation(function () { return { show } } as never)
    ;(owner as unknown as { notifyAttentionNeeded(value: typeof task, summary: string): void }).notifyAttentionNeeded(task, 'Fixture alert')
    expect(notification).toHaveBeenCalledWith({ title: `Heartbeat Alert: ${task.title}`, body: 'Fixture alert' })
    expect(show).toHaveBeenCalledOnce()
    expect(current.webContents.send).toHaveBeenCalledWith('heartbeat:alert', expect.objectContaining({ taskId: task.id }))
    current.webContents.send.mockClear()
    current.isDestroyed.mockReturnValue(true)
    owner.disableHeartbeat(task.id)
    expect(current.webContents.send).not.toHaveBeenCalled()
  })
})
