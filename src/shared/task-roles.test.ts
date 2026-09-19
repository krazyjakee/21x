import { describe, it, expect } from 'vitest'
import { COORDINATOR_ROLES, TASK_ROLE_CAPTAIN, TASK_ROLE_TASK, isCoordinatorRole, isCoordinatorTask } from './task-roles'

describe('task roles', () => {
  it('treats only coordinator roles as coordinators', () => {
    expect(isCoordinatorRole(TASK_ROLE_CAPTAIN)).toBe(true)
    expect(isCoordinatorRole(TASK_ROLE_TASK)).toBe(false)
    expect(isCoordinatorRole(null)).toBe(false)
    expect(isCoordinatorRole(undefined)).toBe(false)
    expect(isCoordinatorRole('')).toBe(false)
    expect(COORDINATOR_ROLES).toContain(TASK_ROLE_CAPTAIN)
    expect(COORDINATOR_ROLES).not.toContain(TASK_ROLE_TASK)
  })

  it('answers for a record, a renderer task, or nothing at all', () => {
    expect(isCoordinatorTask({ role: 'captain' })).toBe(true)
    expect(isCoordinatorTask({ role: 'task' })).toBe(false)
    // A row from before the column existed, or a partial mock without it.
    expect(isCoordinatorTask({})).toBe(false)
    expect(isCoordinatorTask(null)).toBe(false)
    expect(isCoordinatorTask(undefined)).toBe(false)
  })
})
