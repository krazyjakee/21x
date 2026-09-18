import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { ensureProjectMastermind, seedMastermindTasks } from './database/seed'
import { handleTaskRoute } from './task-api/task-routes'
import { DEFAULT_PROJECT_ID } from '../shared/projects'
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
    seedMastermindTasks(db.db)
    mastermindId = db.getCoordinatorTask()!.id
    db.createTask({ title: 'Fix the login bug', labels: ['bug'], priority: 'high' })
    db.createTask({ title: 'Mastermind planning notes', description: 'mastermind', status: 'completed' })
  })

  it('seeds one row for the Default project and finds it by project', () => {
    seedMastermindTasks(db.db)
    seedMastermindTasks(db.db)
    const rows = db.db.prepare("SELECT id FROM tasks WHERE role = 'mastermind'").all()
    expect(rows).toHaveLength(1)
    expect(db.getCoordinatorTask()?.id).toBe(mastermindId)
    expect(db.getCoordinatorTask(DEFAULT_PROJECT_ID)?.id).toBe(mastermindId)
    expect(db.getCoordinatorTask()?.role).toBe('mastermind')
    expect(db.getCoordinatorTask()?.project_id).toBe(DEFAULT_PROJECT_ID)
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

/** One Mastermind per project (#55): born with the project, kept through archive and restore. */
describe('per-project Mastermind rows', () => {
  let db: DatabaseManager

  beforeEach(() => {
    ;({ db } = createTestDb())
    seedMastermindTasks(db.db)
  })

  const mastermindRows = (): Array<{ id: string; project_id: string }> =>
    db.db.prepare("SELECT id, project_id FROM tasks WHERE role = 'mastermind' ORDER BY created_at").all() as Array<{ id: string; project_id: string }>

  it('creates a Mastermind with the project, in that project', () => {
    const project = db.createProject({ name: 'Alpha' })!
    const mastermind = db.getCoordinatorTask(project.id)
    expect(mastermind).toBeDefined()
    expect(mastermind?.project_id).toBe(project.id)
    expect(mastermind?.role).toBe('mastermind')
    expect(mastermind?.id).not.toBe(db.getCoordinatorTask(DEFAULT_PROJECT_ID)?.id)
    // Still hidden from the project's task list.
    expect(db.getTasks({ projectId: project.id })).toEqual([])
  })

  it('seeds one row per existing project and stays idempotent across startups', () => {
    // Projects that predate per-project Masterminds: rows made without the create hook.
    const now = new Date().toISOString()
    for (const id of ['legacy-a', 'legacy-b']) {
      db.db.prepare(`
        INSERT INTO projects (id, name, description, settings, sort_order, archived, created_at, updated_at)
        VALUES (?, ?, '', '{}', 0, 0, ?, ?)
      `).run(id, id, now, now)
    }
    expect(mastermindRows().map((row) => row.project_id)).toEqual([DEFAULT_PROJECT_ID])

    seedMastermindTasks(db.db)
    const afterFirst = mastermindRows()
    expect(afterFirst.map((row) => row.project_id).sort()).toEqual([DEFAULT_PROJECT_ID, 'legacy-a', 'legacy-b'])

    seedMastermindTasks(db.db)
    seedMastermindTasks(db.db)
    expect(mastermindRows()).toEqual(afterFirst)
    expect(db.getCoordinatorTasks()).toHaveLength(3)
  })

  it('adopts a Mastermind row written before projects existed into the Default project', () => {
    const existing = db.getCoordinatorTask(DEFAULT_PROJECT_ID)!.id
    db.db.prepare('UPDATE tasks SET project_id = NULL WHERE id = ?').run(existing)
    seedMastermindTasks(db.db)
    expect(mastermindRows()).toEqual([{ id: existing, project_id: DEFAULT_PROJECT_ID }])
  })

  it('keeps the conversation through archive and restore', () => {
    const project = db.createProject({ name: 'Beta' })!
    const mastermind = db.getCoordinatorTask(project.id)!
    db.updateTask(mastermind.id, { session_id: 'backend-session-beta' })

    db.archiveProject(project.id, true)
    expect(db.getCoordinatorTask(project.id)?.id).toBe(mastermind.id)

    db.archiveProject(project.id, false)
    expect(db.getCoordinatorTask(project.id)?.id).toBe(mastermind.id)
    expect(db.getTask(mastermind.id)?.session_id).toBe('backend-session-beta')
    expect(mastermindRows()).toHaveLength(2)
  })

  it('ensureCoordinatorTask heals a project without one and refuses an unknown project', () => {
    const project = db.createProject({ name: 'Gamma' })!
    const original = db.getCoordinatorTask(project.id)!.id
    expect(db.ensureCoordinatorTask(project.id)?.id).toBe(original)

    db.db.prepare('DELETE FROM tasks WHERE id = ?').run(original)
    const healed = db.ensureCoordinatorTask(project.id)
    expect(healed?.project_id).toBe(project.id)
    expect(healed?.id).not.toBe(original)
    expect(ensureProjectMastermind(db.db, project.id)).toBe(healed?.id)

    expect(db.ensureCoordinatorTask('no-such-project')).toBeUndefined()
    expect(db.getCoordinatorTask('no-such-project')).toBeUndefined()
  })
})
