import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import RawDatabase from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { DatabaseManager } from './database'

/**
 * These tests exercise the REAL startup path — `initialize()` — instead of the
 * injected in-memory schema used by `createTestDb()`.
 *
 * That distinction matters. `createTestDb()` always runs every migration on an
 * empty database, so it proves nothing about the version gate on an existing
 * install. A column added to `runMigrations()` without bumping
 * `SCHEMA_VERSION` passed every other test in this repo and still shipped
 * broken: `applySchema()` only calls `runMigrations()` when the stored version
 * is LOWER than `SCHEMA_VERSION`, so returning users never got it.
 */
describe('DatabaseManager migrations on an existing install', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), '20x-migration-'))
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

  const integratedTables = [
    'managed_agent_runtimes', 'delivery_outbox',
    'concurrency_audit', 'task_touches',
    'agent_start_queue', 'agent_start_queue_fairness'
  ]

  function integratedSchema(raw: InstanceType<typeof RawDatabase>): Array<{ type: string; name: string; tbl_name: string; sql: string }> {
    const placeholders = integratedTables.map(() => '?').join(', ')
    return raw.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE tbl_name IN (${placeholders}) AND sql IS NOT NULL
      ORDER BY type, name
    `).all(...integratedTables) as Array<{ type: string; name: string; tbl_name: string; sql: string }>
  }

  it('creates a fresh database that already has every task column', () => {
    const db = new DatabaseManager()
    db.initialize()
    db.close?.()

    const raw = openRaw()
    expect(taskColumns(raw)).toContain('complete_at_source')
    // First-run seed: a default agent wired to the built-in MCP server. The
    // Captain persona is a built-in system prompt, so no skill is seeded.
    const agents = raw.prepare('SELECT config FROM agents WHERE is_default = 1').all() as { config: string }[]
    expect(agents).toHaveLength(1)
    const config = JSON.parse(agents[0].config) as { skill_ids?: string[]; mcp_servers: string[] }
    const server = raw.prepare("SELECT id FROM mcp_servers WHERE name = 'task-management'").get() as { id: string }
    expect(config.skill_ids ?? []).toEqual([])
    expect(raw.prepare("SELECT id FROM skills WHERE name = 'Captain'").get()).toBeUndefined()
    expect(config.mcp_servers).toEqual([server.id])
    raw.close()
  })

  /**
   * The regression this file exists for. Simulates a returning user: the column
   * is missing and the stored schema version is one behind. Startup must add it.
   */
  it('adds a column that a returning user is missing', () => {
    const first = new DatabaseManager()
    first.initialize()
    first.close?.()

    // Roll the database back to the previous release's shape.
    const raw = openRaw()
    raw.exec('ALTER TABLE tasks DROP COLUMN complete_at_source')
    raw.prepare("UPDATE settings SET value = ? WHERE key = '__schema_version'").run('8')
    expect(taskColumns(raw)).not.toContain('complete_at_source')
    raw.close()

    const second = new DatabaseManager()
    second.initialize()
    second.close?.()

    const after = openRaw()
    expect(taskColumns(after)).toContain('complete_at_source')
    after.close()
  })

  it('adds next_subtask_ids for a database from schema version 10', () => {
    const first = new DatabaseManager()
    first.initialize()
    first.close?.()

    const raw = openRaw()
    raw.exec('ALTER TABLE tasks DROP COLUMN next_subtask_ids')
    raw.prepare("UPDATE settings SET value = ? WHERE key = '__schema_version'").run('10')
    expect(taskColumns(raw)).not.toContain('next_subtask_ids')
    raw.close()

    const second = new DatabaseManager()
    second.initialize()
    second.close?.()

    const after = openRaw()
    expect(taskColumns(after)).toContain('next_subtask_ids')
    after.close()
  })

  /**
   * Migration 21 (#150): every agent gets a hard cap of
   * min(existing max_parallel_sessions, 5); an explicit cap is kept, the old
   * field is left as it was, and the concurrency tables appear.
   */
  it('gives existing agents a hard cap and the unified recovery schema on upgrade to 24', () => {
    const first = new DatabaseManager()
    first.initialize()
    first.close?.()

    const raw = openRaw()
    const now = new Date().toISOString()
    const insert = raw.prepare('INSERT INTO agents (id, name, server_url, config, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
    insert.run('a-eight', 'Eight', 'http://localhost:4096', JSON.stringify({ max_parallel_sessions: 8 }), now, now)
    insert.run('a-three', 'Three', 'http://localhost:4096', JSON.stringify({ max_parallel_sessions: 3 }), now, now)
    insert.run('a-unset', 'Unset', 'http://localhost:4096', JSON.stringify({}), now, now)
    insert.run('a-explicit', 'Explicit', 'http://localhost:4096', JSON.stringify({ max_parallel_sessions: 9, concurrency_cap: 7 }), now, now)
    raw.exec('DROP TABLE concurrency_audit')
    raw.exec('DROP TABLE task_touches')
    raw.prepare("UPDATE settings SET value = ? WHERE key = '__schema_version'").run('17')
    raw.close()

    const second = new DatabaseManager()
    second.initialize()
    second.close?.()

    const after = openRaw()
    const config = (id: string) => JSON.parse((after.prepare('SELECT config FROM agents WHERE id = ?').get(id) as { config: string }).config)
    expect(config('a-eight')).toMatchObject({ concurrency_cap: 5, max_parallel_sessions: 8 })
    expect(config('a-three')).toMatchObject({ concurrency_cap: 3, max_parallel_sessions: 3 })
    expect(config('a-unset').concurrency_cap).toBe(1)
    expect(config('a-explicit').concurrency_cap).toBe(7)
    const tables = (after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)
    expect(tables).toEqual(expect.arrayContaining([
      'managed_agent_runtimes', 'delivery_outbox',
      'concurrency_audit', 'task_touches',
      'agent_start_queue', 'agent_start_queue_fairness'
    ]))
    expect((after.prepare("SELECT value FROM settings WHERE key = '__schema_version'").get() as { value: string }).value).toBe('24')
    after.close()
  })

  it.each([
    { name: 'main v19', version: '19', drop: ['managed_agent_runtimes', 'delivery_outbox', 'concurrency_audit', 'task_touches', 'agent_start_queue', 'agent_start_queue_fairness'] },
    { name: '#151-only v20', version: '20', drop: ['concurrency_audit', 'task_touches', 'agent_start_queue', 'agent_start_queue_fairness'] },
    { name: '#152-only v20', version: '20', drop: ['managed_agent_runtimes', 'delivery_outbox', 'agent_start_queue', 'agent_start_queue_fairness'] },
    { name: 'integrated v21', version: '21', drop: ['agent_start_queue', 'agent_start_queue_fairness'] },
    { name: 'authorization-chain v23', version: '23', drop: ['issue_writes'] }
  ])('produces schema-equivalent v24 from $name', ({ version, drop }) => {
    const fresh = new DatabaseManager()
    fresh.initialize()
    fresh.close?.()

    const raw = openRaw()
    const canonicalSchema = integratedSchema(raw)
    for (const table of drop) raw.exec(`DROP TABLE IF EXISTS ${table}`)
    raw.prepare("UPDATE settings SET value = ? WHERE key = '__schema_version'").run(version)
    raw.close()

    const upgraded = new DatabaseManager()
    upgraded.initialize()
    upgraded.close?.()

    const after = openRaw()
    expect(integratedSchema(after)).toEqual(canonicalSchema)
    const columns = (table: string) => (after.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name)
    expect(columns('managed_agent_runtimes')).toEqual(expect.arrayContaining(['owner_id', 'generation', 'session_id', 'phase']))
    expect(columns('delivery_outbox')).toEqual(expect.arrayContaining(['idempotency_key', 'state', 'claim_owner', 'acknowledged_at']))
    expect(columns('concurrency_audit')).toEqual(expect.arrayContaining(['project_id', 'kind', 'actor', 'reason']))
    expect(columns('agent_start_queue')).toEqual(expect.arrayContaining([
      'id', 'task_id', 'project_id', 'agent_id', 'priority', 'fifo_seq',
      'dependency_reason', 'admission_reason', 'retry_count', 'next_retry_at',
      'generation', 'lease_owner', 'lease_expires_at', 'recovery_cause',
      'recovery_action', 'recovery_result', 'queued_at', 'acknowledged_at'
    ]))
    expect((after.prepare("SELECT value FROM settings WHERE key = '__schema_version'").get() as { value: string }).value).toBe('24')
    after.close()
  })

  /**
   * Guards the gate itself. If someone adds an `ALTER TABLE` to
   * `runMigrations()` but leaves `SCHEMA_VERSION` alone, a returning user whose
   * stored version already equals `SCHEMA_VERSION` gets nothing — which is
   * exactly how `complete_at_source` shipped missing.
   */
  it('does not run migrations when the stored version already matches', () => {
    const first = new DatabaseManager()
    first.initialize()
    first.close?.()

    const raw = openRaw()
    const stored = raw
      .prepare("SELECT value FROM settings WHERE key = '__schema_version'")
      .get() as { value: string }
    // Drop the column WITHOUT lowering the version — the gate must skip it.
    raw.exec('ALTER TABLE tasks DROP COLUMN complete_at_source')
    raw.close()

    const second = new DatabaseManager()
    second.initialize()
    second.close?.()

    const after = openRaw()
    expect(taskColumns(after)).not.toContain('complete_at_source')
    after.close()

    // Documents the coupling: a new migration is only reachable by raising this.
    expect(Number(stored.value)).toBeGreaterThanOrEqual(9)
  })

  /**
   * The Claude Code adapter used to bypass permissions whatever permission_mode
   * said. Upgrading must keep existing Claude Code agents on automatic
   * permissions, once, and never override a choice made afterwards.
   */
  it('keeps existing Claude Code agents on automatic permissions exactly once', () => {
    const first = new DatabaseManager()
    first.initialize()
    first.close?.()

    const now = new Date().toISOString()
    const raw = openRaw()
    const insert = raw.prepare(
      'INSERT INTO agents (id, name, server_url, config, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)'
    )
    insert.run('claude-ask', 'Claude ask', '', JSON.stringify({ coding_agent: 'claude-code', permission_mode: 'ask' }), now, now)
    insert.run('claude-unset', 'Claude unset', '', JSON.stringify({ coding_agent: 'claude-code' }), now, now)
    insert.run('opencode-ask', 'OpenCode ask', '', JSON.stringify({ coding_agent: 'opencode', permission_mode: 'ask' }), now, now)
    raw.prepare("DELETE FROM settings WHERE key = 'migration:claude-code-permission-mode'").run()
    raw.prepare("UPDATE settings SET value = ? WHERE key = '__schema_version'").run('10')
    raw.close()

    const second = new DatabaseManager()
    second.initialize()
    second.close?.()

    const modeOf = (db: InstanceType<typeof RawDatabase>, id: string): unknown => {
      const row = db.prepare('SELECT config FROM agents WHERE id = ?').get(id) as { config: string }
      return (JSON.parse(row.config) as { permission_mode?: unknown }).permission_mode
    }
    const after = openRaw()
    expect(modeOf(after, 'claude-ask')).toBe('allow')
    expect(modeOf(after, 'claude-unset')).toBe('allow')
    expect(modeOf(after, 'opencode-ask')).toBe('ask')

    // The user switches back to 'ask'; a later schema bump must not undo that.
    after
      .prepare('UPDATE agents SET config = ? WHERE id = ?')
      .run(JSON.stringify({ coding_agent: 'claude-code', permission_mode: 'ask' }), 'claude-ask')
    after.prepare("UPDATE settings SET value = ? WHERE key = '__schema_version'").run('10')
    after.close()

    const third = new DatabaseManager()
    third.initialize()
    third.close?.()

    const final = openRaw()
    expect(modeOf(final, 'claude-ask')).toBe('ask')
    final.close()
  })
})
