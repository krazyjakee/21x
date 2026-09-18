import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { COORDINATOR_ROLES, TASK_ROLE_MASTERMIND, TASK_ROLE_TASK, isCoordinatorRole, isCoordinatorTask } from './task-roles'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const thisFile = fileURLToPath(import.meta.url)

describe('task roles', () => {
  it('treats only coordinator roles as coordinators', () => {
    expect(isCoordinatorRole(TASK_ROLE_MASTERMIND)).toBe(true)
    expect(isCoordinatorRole(TASK_ROLE_TASK)).toBe(false)
    expect(isCoordinatorRole(null)).toBe(false)
    expect(isCoordinatorRole(undefined)).toBe(false)
    expect(isCoordinatorRole('')).toBe(false)
    expect(COORDINATOR_ROLES).toContain(TASK_ROLE_MASTERMIND)
    expect(COORDINATOR_ROLES).not.toContain(TASK_ROLE_TASK)
  })

  it('answers for a record, a renderer task, or nothing at all', () => {
    expect(isCoordinatorTask({ role: 'mastermind' })).toBe(true)
    expect(isCoordinatorTask({ role: 'task' })).toBe(false)
    // A row from before the column existed, or a partial mock without it.
    expect(isCoordinatorTask({})).toBe(false)
    expect(isCoordinatorTask(null)).toBe(false)
    expect(isCoordinatorTask(undefined)).toBe(false)
  })

  /**
   * The Mastermind used to be a fake task id with no row behind it, so its
   * session_id was never stored and every restart began empty. It is a real
   * row now, found by role. Nothing may special-case the old string again.
   * Test files are skipped: an adapter test may use any string as a task id.
   */
  it("never mentions the retired 'mastermind-session' pseudo task id in src", () => {
    const literal = ['mastermind', 'session'].join('-')
    const tracked = execFileSync('git', ['ls-files', 'src'], { cwd: repoRoot, encoding: 'utf-8' })
      .split('\n')
      .filter(Boolean)
      .filter((file) => /\.(ts|tsx|js|jsx)$/.test(file))
      .filter((file) => !/\.test\.(ts|tsx|js|jsx)$/.test(file))

    const offenders = tracked.filter((file) => {
      const path = join(repoRoot, file)
      if (!existsSync(path) || resolve(path) === thisFile) return false
      return readFileSync(path, 'utf-8').includes(literal)
    })

    expect(
      offenders,
      `The Mastermind is a task row with role '${TASK_ROLE_MASTERMIND}'; use isCoordinatorTask() and ` +
      'DatabaseManager.getCoordinatorTask() instead of a fixed session id.'
    ).toEqual([])
  })
})
