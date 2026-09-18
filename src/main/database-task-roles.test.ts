import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { seedMastermindTask } from './database/seed'
import { handleTaskRoute } from './task-api/task-routes'
import type { DatabaseManager } from './database'

/**
 * A coordinator row (the Mastermind) is a conversation, not work. It must be
 * reachable by id — that is what makes its session and transcript persist —
 * and absent from everything that lists, counts or searches tasks.
 */
describe('coordinator task rows', () => {
  let db: DatabaseManager
  let mastermindId: string

  beforeEach(() => {
    ;({ db } = createTestDb())
    seedMastermindTask(db.db)
    mastermindId = db.getCoordinatorTask()!.id
    db.createTask({ title: 'Fix the login bug', labels: ['bug'], priority: 'high' })
    db.createTask({ title: 'Mastermind planning notes', description: 'mastermind', status: 'completed' })
  })

  it('seeds one row per install and finds it by role', () => {
    seedMastermindTask(db.db)
    seedMastermindTask(db.db)
    const rows = db.db.prepare("SELECT id FROM tasks WHERE role = 'mastermind'").all()
    expect(rows).toHaveLength(1)
    expect(db.getCoordinatorTask()?.id).toBe(mastermindId)
    expect(db.getCoordinatorTask()?.role).toBe('mastermind')
  })

  it('is fetched by id like any task, so a session id can be stored on it', () => {
    db.updateTask(mastermindId, { session_id: 'backend-session-1' })
    const row = db.getTask(mastermindId)
    expect(row?.session_id).toBe('backend-session-1')
    expect(row?.role).toBe('mastermind')
  })

  it('creates ordinary tasks with role task', () => {
    const task = db.createTask({ title: 'Ordinary' })!
    expect(task.role).toBe('task')
  })

  it('is left out of getTasks unless asked for', () => {
    const ids = db.getTasks().map((t) => t.id)
    expect(ids).not.toContain(mastermindId)
    expect(ids).toHaveLength(2)

    const all = db.getTasks({ includeCoordinators: true }).map((t) => t.id)
    expect(all).toContain(mastermindId)
    expect(all).toHaveLength(3)
  })

  it('is left out of list_tasks, find_similar_tasks and statistics', async () => {
    const listed = await handleTaskRoute(db, '/list_tasks', {}) as Array<{ id: string }>
    expect(listed.map((t) => t.id)).not.toContain(mastermindId)
    expect(listed).toHaveLength(2)

    // Its title says "Mastermind", so a keyword search would otherwise find it.
    const similar = await handleTaskRoute(db, '/find_similar_tasks', { title_keywords: 'mastermind', completed_only: false }) as Array<{ id: string; title: string }>
    expect(similar.map((t) => t.id)).not.toContain(mastermindId)
    expect(similar.map((t) => t.title)).toEqual(['Mastermind planning notes'])

    const recent = await handleTaskRoute(db, '/find_similar_tasks', {}) as Array<{ id: string }>
    expect(recent.map((t) => t.id)).not.toContain(mastermindId)
    expect(recent).toHaveLength(2)

    const completion = await handleTaskRoute(db, '/get_task_statistics', { metric: 'completion_rate' }) as { total: number; completed: number }
    expect(completion.total).toBe(2)
    expect(completion.completed).toBe(1)

    const priorities = await handleTaskRoute(db, '/get_task_statistics', { metric: 'priority_distribution' }) as Record<string, number>
    expect(Object.values(priorities).reduce((a, b) => a + b, 0)).toBe(2)

    const labels = await handleTaskRoute(db, '/get_task_statistics', { metric: 'label_usage' }) as Record<string, number>
    expect(labels).toEqual({ bug: 1 })
  })
})
