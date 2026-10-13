import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { createPortableDbFixture } from '../../test/helpers/portable-db-test-helper'
import { makeTask } from '../../test/helpers/task-fixtures'
import { RecurrenceScheduler } from './recurrence-scheduler'

describe('recurrence Electron event adapter', () => {
  const source = createPortableDbFixture()
  const scheduler = new RecurrenceScheduler(source.db, 'UTC')
  afterEach(async () => {
    await scheduler.close()
    source.rawDb.close()
  })
  it('rebinds the recreated window and uses guarded task event payloads', async () => {
    const first = { isDestroyed: () => false, webContents: { send: vi.fn() } }
    const current = { isDestroyed: () => false, webContents: { send: vi.fn() } }
    scheduler.start(first as unknown as BrowserWindow)
    await scheduler.runNow()
    const project = source.db.createProject({ name: 'Window owner' })!
    const template = source.db.createTask(makeTask({ project_id: project.id, is_recurring: true, recurrence_pattern: '0 9 * * *' }))!
    source.db.updateTask(template.id, { next_occurrence_at: new Date(Date.now() - 60_000).toISOString() })
    scheduler.start(current as unknown as BrowserWindow)
    await scheduler.runNow()
    expect(first.webContents.send).not.toHaveBeenCalled()
    expect(current.webContents.send).toHaveBeenCalledWith('task:created', {
      task: expect.objectContaining({ project_id: project.id, recurrence_parent_id: template.id })
    })
    expect(current.webContents.send).toHaveBeenCalledWith('tasks:refresh')
  })
})
