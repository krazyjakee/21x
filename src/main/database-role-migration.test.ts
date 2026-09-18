import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import RawDatabase from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import { DatabaseManager } from './database'

/**
 * Exercises the real startup path — `initialize()` — for the `tasks.role`
 * column and the seeded Mastermind row, in the manner of
 * docs/database-migrations.md: a returning user whose stored schema version is
 * one behind must get the column, and the seed must run exactly once.
 */
describe('tasks.role migration and the Mastermind row', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), '20x-role-migration-'))
    vi.mocked(app.getPath).mockReturnValue(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function openRaw() {
    return new RawDatabase(join(dir, '21x.db'))
  }

  function taskColumns(raw: InstanceType<typeof RawDatabase>): string[] {
    return (raw.pragma('table_info(tasks)') as { name: string }[]).map((c) => c.name)
  }

  function mastermindRows(raw: InstanceType<typeof RawDatabase>): { id: string; title: string }[] {
    return raw.prepare("SELECT id, title FROM tasks WHERE role = 'mastermind'").all() as { id: string; title: string }[]
  }

  it('creates a fresh database with the role column and one Mastermind row', () => {
    const db = new DatabaseManager()
    db.initialize()
    db.close?.()

    const raw = openRaw()
    expect(taskColumns(raw)).toContain('role')
    expect(mastermindRows(raw)).toHaveLength(1)
    // Every ordinary row defaults to 'task'.
    const column = (raw.pragma('table_info(tasks)') as { name: string; dflt_value: string | null }[])
      .find((c) => c.name === 'role')
    expect(column?.dflt_value).toBe("'task'")
    raw.close()
  })

  it('adds role for a database from schema version 12 and seeds the Mastermind once', () => {
    const first = new DatabaseManager()
    first.initialize()
    first.close?.()

    // Roll back to the previous release: no Mastermind row, no role column.
    const raw = openRaw()
    raw.prepare("DELETE FROM tasks WHERE role = 'mastermind'").run()
    raw.exec('ALTER TABLE tasks DROP COLUMN role')
    raw.prepare("UPDATE settings SET value = ? WHERE key = '__schema_version'").run('12')
    expect(taskColumns(raw)).not.toContain('role')
    raw.close()

    const second = new DatabaseManager()
    second.initialize()
    second.close?.()

    const after = openRaw()
    expect(taskColumns(after)).toContain('role')
    const seeded = mastermindRows(after)
    expect(seeded).toHaveLength(1)
    after.close()

    // Every later start finds the row and leaves it alone.
    const third = new DatabaseManager()
    third.initialize()
    third.close?.()

    const final = openRaw()
    expect(mastermindRows(final)).toEqual(seeded)
    final.close()
  })

  /**
   * docs/database-migrations.md: a column added only by ALTER is dropped the
   * next time the table is rebuilt (rebuildTasksTable copies the columns the
   * new table declares). The Mastermind would then become a visible task.
   */
  it('declares role in the rebuild template as well as in createTables', () => {
    const schema = readFileSync(fileURLToPath(new URL('./database/schema.ts', import.meta.url)), 'utf-8')
    const rebuild = schema.slice(schema.indexOf('CREATE TABLE tasks_new ('), schema.indexOf('Dynamically find columns shared'))
    expect(rebuild).toContain("role TEXT NOT NULL DEFAULT 'task'")
    const create = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS tasks ('), schema.indexOf('CREATE TABLE IF NOT EXISTS agents ('))
    expect(create).toContain("role TEXT NOT NULL DEFAULT 'task'")
  })
})
