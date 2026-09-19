import { describe, it, expect } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { buildProjectOverview } from './project-overview'

describe('buildProjectOverview', () => {
  it('takes the last activity from the newest task or the status write, ignoring the Captain row', () => {
    const { db, rawDb } = createTestDb()
    const project = db.createProject({ name: 'Alpha' })!
    const task = db.createTask({ title: 'Work', project_id: project.id })!
    rawDb.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run('2026-01-02T00:00:00.000Z', task.id)
    rawDb.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run('2027-01-01T00:00:00.000Z', db.getCoordinatorTask(project.id)!.id)

    const entry = () => buildProjectOverview(db, null).find((e) => e.project_id === project.id)!
    expect(entry().last_activity_at).toBe('2026-01-02T00:00:00.000Z')

    const status = db.setProjectStatusSummary(project.id, 'Quiet')!
    expect(entry().last_activity_at).toBe(status.updated_at)
  })
})
