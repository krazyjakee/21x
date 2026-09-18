import { describe, it, expect } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { DEFAULT_PROJECT_ID } from '../shared/projects'

const NOW = '2026-01-01T00:00:00.000Z'

describe('moveTaskToProject', () => {
  it('moves a task with its subtasks (at any depth) and recurrence instances', () => {
    const { db, rawDb } = createTestDb()
    const p = db.createProject({ name: 'P' })!
    const parent = db.createTask({ title: 'parent' })!
    const child = db.createTask({ title: 'child', parent_task_id: parent.id })!
    const grandchild = db.createTask({ title: 'grandchild', parent_task_id: child.id })!
    rawDb.prepare('INSERT INTO tasks (id, title, recurrence_parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('instance', 'instance', parent.id, NOW, NOW)
    const bystander = db.createTask({ title: 'bystander' })!

    const moved = db.moveTaskToProject(parent.id, p.id)

    expect(moved?.map((t) => t.id).sort()).toEqual([parent.id, child.id, grandchild.id, 'instance'].sort())
    for (const id of [parent.id, child.id, grandchild.id, 'instance']) {
      expect(db.getTask(id)!.project_id).toBe(p.id)
    }
    expect(db.getTask(bystander.id)!.project_id).toBe(DEFAULT_PROJECT_ID)
    expect(db.getTasks({ projectId: DEFAULT_PROJECT_ID }).map((t) => t.id)).toEqual([bystander.id])
  })

  it('refuses a subtask on its own, an unknown task and an unknown project', () => {
    const { db } = createTestDb()
    const p = db.createProject({ name: 'P' })!
    const parent = db.createTask({ title: 'parent' })!
    const child = db.createTask({ title: 'child', parent_task_id: parent.id })!

    expect(db.moveTaskToProject(child.id, p.id)).toBeUndefined()
    expect(db.getTask(child.id)!.project_id).toBe(DEFAULT_PROJECT_ID)
    expect(db.moveTaskToProject('missing', p.id)).toBeUndefined()
    expect(db.moveTaskToProject(parent.id, 'no-such-project')).toBeUndefined()
    expect(db.getTask(parent.id)!.project_id).toBe(DEFAULT_PROJECT_ID)
  })

  it('moves back again', () => {
    const { db } = createTestDb()
    const p = db.createProject({ name: 'P' })!
    const task = db.createTask({ title: 'task', project_id: p.id })!
    db.createTask({ title: 'sub', parent_task_id: task.id })

    const moved = db.moveTaskToProject(task.id, DEFAULT_PROJECT_ID)
    expect(moved).toHaveLength(2)
    expect(moved!.every((t) => t.project_id === DEFAULT_PROJECT_ID)).toBe(true)
  })
})
