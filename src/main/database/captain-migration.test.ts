import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import RawDatabase from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { DatabaseManager } from '../database'
import { migrateCoordinatorToCaptain } from './captain-migration'

type Raw = InstanceType<typeof RawDatabase>

/**
 * Migration 16 → 17 (#71): the coordinator's persisted Mastermind identifiers
 * become Captain ones, through the real startup path (`initialize()`), from a
 * database put back into its schema-16 shape.
 */
describe('migration 16 → 17: Mastermind → Captain', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), '21x-captain-migration-'))
    vi.mocked(app.getPath).mockReturnValue(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function openRaw(): Raw {
    const raw = new RawDatabase(join(dir, '21x.db'))
    raw.pragma('foreign_keys = ON')
    return raw
  }

  function start(): void {
    const db = new DatabaseManager()
    db.initialize()
    db.close?.()
  }

  function columns(raw: Raw, table: string): { name: string; dflt_value: string | null }[] {
    return raw.pragma(`table_info(${table})`) as { name: string; dflt_value: string | null }[]
  }

  function schemaSql(raw: Raw): string[] {
    return (raw.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'tasks_fts%' ORDER BY name").all() as { sql: string }[])
      .map((r) => r.sql.replace(/"/g, '').replace(/\s+/g, ' ').replace(/\bIF NOT EXISTS\b/gi, '').trim())
  }

  /** Rewrites a current database into the shape a schema-16 install has on disk. */
  function downgradeToSchema16(raw: Raw): void {
    raw.exec(`
      UPDATE tasks SET role = 'mastermind', title = 'Mastermind',
        description = 'The Mastermind conversation. Not a task: never listed, never scheduled.'
        WHERE role = 'captain';
      ALTER TABLE projects RENAME COLUMN captain_agent_id TO mastermind_agent_id;
      DELETE FROM settings WHERE key = 'captain_prewarm';
      INSERT INTO settings (key, value) VALUES ('mastermind_prewarm', 'true');

      CREATE TABLE journal_old AS SELECT * FROM project_status_journal;
      DROP TABLE project_status_journal;
      CREATE TABLE project_status_journal (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        summary TEXT NOT NULL,
        completed TEXT NOT NULL DEFAULT '[]',
        blockers TEXT NOT NULL DEFAULT '[]',
        decisions TEXT NOT NULL DEFAULT '[]',
        next_steps TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'mastermind',
        correlation_id TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO project_status_journal SELECT * FROM journal_old;
      DROP TABLE journal_old;
      CREATE INDEX idx_project_status_journal_project_created
        ON project_status_journal(project_id, created_at DESC, id DESC);
    `)
    raw.prepare("UPDATE projects SET settings = REPLACE(settings, '\"captain_wakeups\"', '\"mastermind_wakeups\"')").run()
    raw.prepare("UPDATE project_status_journal SET source = 'mastermind' WHERE source = 'captain'").run()
    raw.prepare("UPDATE settings SET value = '16' WHERE key = '__schema_version'").run()
  }

  it('keeps the same coordinator row, conversation, project, agent, warm-up and wake-up settings', () => {
    start()
    const fresh = openRaw()
    const freshSchema = schemaSql(fresh)
    const agentId = (fresh.prepare('SELECT id FROM agents LIMIT 1').get() as { id: string }).id
    const now = new Date().toISOString()
    fresh.prepare(`
      INSERT INTO projects (id, name, description, captain_agent_id, settings, sort_order, archived, created_at, updated_at)
      VALUES ('proj-a', 'Alpha', '', ?, ?, 1, 0, ?, ?)
    `).run(agentId, JSON.stringify({ captain_wakeups: { enabled: false, kinds: ['task_failed'] }, other: 1 }), now, now)
    fresh.close()
    start() // seeds Alpha's coordinator row

    const raw = openRaw()
    const coordinator = raw.prepare("SELECT id, project_id FROM tasks WHERE role = 'captain' AND project_id = 'proj-a'").get() as { id: string; project_id: string }
    raw.prepare('UPDATE tasks SET session_id = ? WHERE id = ?').run('sess-alpha', coordinator.id)
    raw.prepare("INSERT INTO transcript_parts (task_id, part_id, seq, role, content) VALUES (?, 'p-1', 1, 'user', 'plan the week')").run(coordinator.id)
    raw.prepare("INSERT INTO project_status_journal (id, project_id, summary, source, created_at) VALUES ('j-1', 'proj-a', 'On track', 'captain', ?)").run(now)
    raw.prepare("INSERT INTO project_status_journal (id, project_id, summary, source, created_at) VALUES ('j-2', 'proj-a', 'Rolled up', 'compaction', ?)").run(now)
    const coordinatorCount = (raw.prepare("SELECT COUNT(*) AS n FROM tasks WHERE role = 'captain'").get() as { n: number }).n
    downgradeToSchema16(raw)
    expect(columns(raw, 'projects').map((c) => c.name)).toContain('mastermind_agent_id')
    raw.close()

    start()

    const after = openRaw()
    expect(after.prepare("SELECT value FROM settings WHERE key = '__schema_version'").get()).toEqual({ value: '32' })
    // Same row: id, session, project and transcript intact; renamed, not re-seeded.
    expect(after.prepare("SELECT COUNT(*) AS n FROM tasks WHERE role = 'captain'").get()).toEqual({ n: coordinatorCount })
    expect(after.prepare("SELECT COUNT(*) AS n FROM tasks WHERE role = 'mastermind'").get()).toEqual({ n: 0 })
    expect(after.prepare('SELECT role, title, session_id, project_id FROM tasks WHERE id = ?').get(coordinator.id))
      .toEqual({ role: 'captain', title: 'Captain', session_id: 'sess-alpha', project_id: 'proj-a' })
    expect(after.prepare('SELECT content FROM transcript_parts WHERE task_id = ?').all(coordinator.id)).toEqual([{ content: 'plan the week' }])
    // Configured agent carried by the renamed column.
    expect(columns(after, 'projects').map((c) => c.name)).not.toContain('mastermind_agent_id')
    expect(after.prepare("SELECT captain_agent_id FROM projects WHERE id = 'proj-a'").get()).toEqual({ captain_agent_id: agentId })
    // Warm-up preference and wake-up settings.
    expect(after.prepare("SELECT key, value FROM settings WHERE key LIKE '%prewarm'").all()).toEqual([{ key: 'captain_prewarm', value: 'true' }])
    const settings = JSON.parse((after.prepare("SELECT settings FROM projects WHERE id = 'proj-a'").get() as { settings: string }).settings)
    expect(settings).toEqual({ captain_wakeups: { enabled: false, kinds: ['task_failed'] }, other: 1 })
    // Journal rows rewritten, compaction rows untouched, default renamed.
    expect(after.prepare('SELECT id, source FROM project_status_journal ORDER BY id').all())
      .toEqual([{ id: 'j-1', source: 'captain' }, { id: 'j-2', source: 'compaction' }])
    expect(columns(after, 'project_status_journal').find((c) => c.name === 'source')?.dflt_value).toBe("'captain'")
    // The upgraded schema is the fresh one.
    expect(schemaSql(after)).toEqual(freshSchema)
    after.close()

    // A later start changes nothing and seeds no second coordinator.
    start()
    const final = openRaw()
    expect(final.prepare("SELECT COUNT(*) AS n FROM tasks WHERE role = 'captain'").get()).toEqual({ n: coordinatorCount })
    final.close()
  })

  it('is idempotent and lets a value already under the new key win', () => {
    start()
    const raw = openRaw()
    const now = new Date().toISOString()
    raw.prepare(`
      INSERT INTO projects (id, name, description, settings, sort_order, archived, created_at, updated_at)
      VALUES ('proj-b', 'Beta', '', ?, 1, 0, ?, ?)
    `).run(JSON.stringify({ mastermind_wakeups: { enabled: false, kinds: [] }, captain_wakeups: { enabled: true, kinds: ['task_failed'] } }), now, now)
    raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('captain_prewarm', 'false'), ('mastermind_prewarm', 'true')").run()

    migrateCoordinatorToCaptain(raw)
    migrateCoordinatorToCaptain(raw)

    expect(raw.prepare("SELECT key, value FROM settings WHERE key LIKE '%prewarm'").all()).toEqual([{ key: 'captain_prewarm', value: 'false' }])
    expect(JSON.parse((raw.prepare("SELECT settings FROM projects WHERE id = 'proj-b'").get() as { settings: string }).settings))
      .toEqual({ captain_wakeups: { enabled: true, kinds: ['task_failed'] } })
    raw.close()
  })

  it('gives a fresh database only Captain-era schema, rows and settings', () => {
    start()
    const raw = openRaw()
    const legacy = /mastermind/i
    for (const sql of schemaSql(raw)) expect(sql).not.toMatch(legacy)
    const tasks = raw.prepare('SELECT role, title, description FROM tasks').all()
    expect(JSON.stringify(tasks)).not.toMatch(legacy)
    expect(raw.prepare("SELECT role, title FROM tasks WHERE role = 'captain'").all()).toEqual([{ role: 'captain', title: 'Captain' }])
    expect(JSON.stringify(raw.prepare('SELECT key, value FROM settings').all())).not.toMatch(legacy)
    expect(JSON.stringify(raw.prepare('SELECT name, content FROM skills').all())).not.toMatch(legacy)
    expect(JSON.stringify(raw.prepare('SELECT settings FROM projects').all())).not.toMatch(legacy)
    raw.close()
  })
})
