import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema, removeHostedServiceData, runMigrations } from './database/schema'

type Db = InstanceType<typeof Database>

/**
 * `runMigrations()` upgrades existing installs column by column, table rebuild
 * by table rebuild, while `createTables()` describes the schema a fresh install
 * gets. Nothing else checks that the two paths meet: a column added to one but
 * not the other, or a rebuild that silently drops a column, only shows up on a
 * returning user's machine. These tests build a database in a legacy shape,
 * run it through the production startup path (`applySchema()`), and require
 * the result to be structurally identical to a fresh database.
 */

/**
 * A legacy database. The tables are the `createTables()` of the February 2026
 * release (commit 31def197) plus the columns that release's own migrations had
 * already added by ALTER TABLE, in the shapes `runMigrations()` still has
 * guarded steps for:
 *
 * - tasks: pre-rename `oc_session_id`, `source_id` still ON DELETE SET NULL
 *   (forces the table rebuild), no heartbeat / subtask / feedback columns
 * - mcp_servers: no `oauth_metadata` / `source`
 * - oauth_tokens: `source_id` NOT NULL and no `mcp_server_id` (forces its rebuild)
 * - skills: the hosted-sync columns that migration v10 removes
 * - transcript_parts: created before the `rev` change cursor existed
 */
const LEGACY_SCHEMA = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'general',
    priority TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'not_started',
    assignee TEXT NOT NULL DEFAULT '',
    due_date TEXT,
    labels TEXT NOT NULL DEFAULT '[]',
    checklist TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'local',
    resolution TEXT,
    is_recurring INTEGER NOT NULL DEFAULT 0,
    recurrence_pattern TEXT DEFAULT NULL,
    recurrence_parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    last_occurrence_at TEXT DEFAULT NULL,
    next_occurrence_at TEXT DEFAULT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  ALTER TABLE tasks ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE tasks ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
  ALTER TABLE tasks ADD COLUMN repos TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE tasks ADD COLUMN output_fields TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE tasks ADD COLUMN external_id TEXT;
  ALTER TABLE tasks ADD COLUMN source_id TEXT REFERENCES task_sources(id) ON DELETE SET NULL;
  ALTER TABLE tasks ADD COLUMN skill_ids TEXT DEFAULT NULL;
  ALTER TABLE tasks ADD COLUMN oc_session_id TEXT DEFAULT NULL;
  ALTER TABLE tasks ADD COLUMN snoozed_until TEXT DEFAULT NULL;

  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
  CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source);
  CREATE INDEX IF NOT EXISTS idx_tasks_next_occurrence ON tasks(next_occurrence_at) WHERE is_recurring = 1;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_external ON tasks(source_id, external_id) WHERE external_id IS NOT NULL;

  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    server_url TEXT NOT NULL DEFAULT 'http://localhost:4096',
    config TEXT NOT NULL DEFAULT '{}',
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'local',
    command TEXT NOT NULL DEFAULT '',
    args TEXT NOT NULL DEFAULT '[]',
    url TEXT,
    headers TEXT NOT NULL DEFAULT '{}',
    environment TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  ALTER TABLE mcp_servers ADD COLUMN tools TEXT NOT NULL DEFAULT '[]';

  CREATE TABLE task_sources (
    id TEXT PRIMARY KEY,
    mcp_server_id TEXT REFERENCES mcp_servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    list_tool TEXT NOT NULL,
    list_tool_args TEXT NOT NULL DEFAULT '{}',
    update_tool TEXT NOT NULL DEFAULT '',
    update_tool_args TEXT NOT NULL DEFAULT '{}',
    last_synced_at TEXT,
    plugin_id TEXT NOT NULL DEFAULT 'peakflo',
    config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    content TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    confidence REAL NOT NULL DEFAULT 0.5,
    uses INTEGER NOT NULL DEFAULT 0,
    last_used TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    is_deleted INTEGER NOT NULL DEFAULT 0,
    enterprise_skill_id TEXT DEFAULT NULL,
    uses_at_last_sync INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_skills_enterprise_id ON skills(enterprise_skill_id);

  CREATE TABLE oauth_tokens (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    source_id TEXT NOT NULL REFERENCES task_sources(id) ON DELETE CASCADE,
    access_token BLOB NOT NULL,
    refresh_token BLOB,
    expires_at TEXT NOT NULL,
    scope TEXT,
    token_type TEXT NOT NULL DEFAULT 'Bearer',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_oauth_tokens_source ON oauth_tokens(source_id);
  CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider ON oauth_tokens(provider);

  CREATE TABLE transcript_parts (
    task_id TEXT NOT NULL,
    part_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'system',
    content TEXT NOT NULL DEFAULT '',
    part_type TEXT,
    tool TEXT,
    payload TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
    PRIMARY KEY (task_id, part_id)
  );
  CREATE INDEX IF NOT EXISTS idx_transcript_parts_task_seq ON transcript_parts(task_id, seq);
`

const NOW = '2026-02-20T10:00:00.000Z'

function openMemory(): Db {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  return db
}

function openLegacy(): Db {
  const db = openMemory()
  db.exec(LEGACY_SCHEMA)
  return db
}

/** Rows a returning user's database would hold, chosen to hit every data migration. */
function seedLegacyData(db: Db): void {
  db.prepare('INSERT INTO agents (id, name, config, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('agent-1', 'Inline MCP agent', JSON.stringify({
      mcp_servers: [{ name: 'filesystem', command: 'npx', args: ['-y', 'fs-server'] }]
    }), 1, NOW, NOW)
  db.prepare('INSERT INTO agents (id, name, config, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('agent-2', 'Claude', JSON.stringify({ coding_agent: 'claude-code', permission_mode: 'ask' }), 0, NOW, NOW)

  db.prepare('INSERT INTO mcp_servers (id, name, command, args, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('mcp-1', 'linear-bridge', 'npx', '["linear-mcp"]', NOW, NOW)
  db.prepare('INSERT INTO task_sources (id, mcp_server_id, name, list_tool, plugin_id, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('src-1', 'mcp-1', 'Linear', 'list_issues', 'linear', '{}', NOW, NOW)
  db.prepare('INSERT INTO oauth_tokens (id, provider, source_id, access_token, refresh_token, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('tok-1', 'linear', 'src-1', Buffer.from('ciphertext-access'), null, NOW, NOW, NOW)

  db.prepare('INSERT INTO tasks (id, title, status, oc_session_id, source_id, external_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('task-1', 'Awaiting review', 'pending_review', 'sess-abc', 'src-1', 'LIN-1', NOW, NOW)
  db.prepare('INSERT INTO tasks (id, title, status, is_recurring, next_occurrence_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('task-2', 'Weekly digest', 'not_started', 1, '2026-03-01T09:00:00.000Z', NOW, NOW)

  db.prepare('INSERT INTO skills (id, name, description, content, enterprise_skill_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('skill-1', 'review', 'Review code', '# Review', 'ent-9', NOW, NOW)

  db.prepare('INSERT INTO transcript_parts (task_id, part_id, seq, role, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('task-1', 'p-2', 2, 'assistant', 'second', 2000, 2000)
  db.prepare('INSERT INTO transcript_parts (task_id, part_id, seq, role, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('task-1', 'p-1', 1, 'user', 'first', 1000, 1000)
}

// ── Schema snapshot ──────────────────────────────────────────

interface ColumnShape { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
interface ForeignKeyShape { table: string; from: string; to: string; on_update: string; on_delete: string }
interface TableShape { columns: ColumnShape[]; foreignKeys: ForeignKeyShape[] }
interface SchemaSnapshot {
  tables: Record<string, TableShape>
  indexes: Record<string, string>
  triggers: Record<string, string>
}

/** Whitespace and `IF NOT EXISTS` carry no meaning; everything else must match. */
function normalizeSql(sql: string): string {
  return sql
    .replace(/\bif not exists\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim()
    .toLowerCase()
}

/**
 * Structure only: column definitions (sorted by name, since ALTER TABLE appends
 * while CREATE TABLE declares in order), foreign keys, index and trigger SQL.
 */
function snapshotSchema(db: Db): SchemaSnapshot {
  const objects = db.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all() as Array<{ type: string; name: string; sql: string | null }>

  const snapshot: SchemaSnapshot = { tables: {}, indexes: {}, triggers: {} }
  for (const obj of objects) {
    if (obj.type === 'table') {
      const columns = (db.pragma(`table_info(${obj.name})`) as ColumnShape[])
        .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type: type.toUpperCase(), notnull, dflt_value, pk }))
        .sort((a, b) => a.name.localeCompare(b.name))
      const foreignKeys = (db.pragma(`foreign_key_list(${obj.name})`) as ForeignKeyShape[])
        .map(({ table, from, to, on_update, on_delete }) => ({ table, from, to, on_update, on_delete }))
        .sort((a, b) => a.from.localeCompare(b.from))
      snapshot.tables[obj.name] = { columns, foreignKeys }
    } else if (obj.type === 'index') {
      // Auto-indexes (PRIMARY KEY / UNIQUE) have no SQL; the column info covers them.
      if (obj.sql) snapshot.indexes[obj.name] = normalizeSql(obj.sql)
    } else if (obj.type === 'trigger') {
      snapshot.triggers[obj.name] = normalizeSql(obj.sql ?? '')
    }
  }
  return snapshot
}

function schemaVersion(db: Db): string | undefined {
  return (db.prepare("SELECT value FROM settings WHERE key = '__schema_version'").get() as { value: string } | undefined)?.value
}

function columnNames(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name)
}

function agentConfig(db: Db, id: string): Record<string, unknown> {
  const row = db.prepare('SELECT config FROM agents WHERE id = ?').get(id) as { config: string }
  return JSON.parse(row.config) as Record<string, unknown>
}

describe('schema equivalence: legacy database migrated vs fresh database', () => {
  it('ends up with the same tables, columns, foreign keys, indexes and triggers', () => {
    const fresh = openMemory()
    applySchema(fresh)

    const legacy = openLegacy()
    seedLegacyData(legacy)
    // Sanity: the legacy shape really is different before migrating.
    expect(columnNames(legacy, 'tasks')).toContain('oc_session_id')
    expect(columnNames(legacy, 'tasks')).not.toContain('parent_task_id')

    expect(applySchema(legacy)).toBe(true)

    const freshSnapshot = snapshotSchema(fresh)
    const legacySnapshot = snapshotSchema(legacy)
    expect(Object.keys(legacySnapshot.tables).sort()).toEqual(Object.keys(freshSnapshot.tables).sort())
    expect(legacySnapshot).toEqual(freshSnapshot)
    expect(schemaVersion(legacy)).toBe(schemaVersion(fresh))
  })

  it('carries the legacy rows through every data migration', () => {
    const legacy = openLegacy()
    seedLegacyData(legacy)
    applySchema(legacy)

    // Old six-status workflow is mapped onto the current four statuses.
    const tasks = legacy.prepare('SELECT id, status, session_id, next_occurrence_at FROM tasks ORDER BY id').all() as Array<{
      id: string; status: string; session_id: string | null; next_occurrence_at: string | null
    }>
    expect(tasks).toEqual([
      { id: 'task-1', status: 'ready_for_review', session_id: 'sess-abc', next_occurrence_at: null },
      { id: 'task-2', status: 'not_started', session_id: null, next_occurrence_at: '2026-03-01T09:00:00.000Z' }
    ])
    // The rebuild that fixes the source_id foreign key drops the pre-rename column.
    expect(columnNames(legacy, 'tasks')).not.toContain('oc_session_id')
    const sourceFk = (legacy.pragma('foreign_key_list(tasks)') as ForeignKeyShape[]).find((fk) => fk.from === 'source_id')
    expect(sourceFk?.on_delete).toBe('CASCADE')

    // Every task and task source lands in the Default project.
    expect(legacy.prepare('SELECT DISTINCT project_id FROM tasks').all()).toEqual([{ project_id: 'default' }])
    expect(legacy.prepare('SELECT DISTINCT project_id FROM task_sources').all()).toEqual([{ project_id: 'default' }])

    // Inline MCP servers move to the mcp_servers table and agents keep ids only.
    const fsServer = legacy.prepare("SELECT id, command, source FROM mcp_servers WHERE name = 'filesystem'").get() as
      { id: string; command: string; source: string } | undefined
    expect(fsServer).toMatchObject({ command: 'npx', source: 'user' })
    expect(agentConfig(legacy, 'agent-1').mcp_servers).toEqual([fsServer!.id])
    expect(legacy.prepare("SELECT coding_agent FROM agents WHERE id = 'agent-1'").get()).toEqual({ coding_agent: 'opencode' })

    // Existing Claude Code agents keep the automatic permissions they had.
    expect(agentConfig(legacy, 'agent-2').permission_mode).toBe('allow')

    // The oauth_tokens rebuild keeps the row and its ciphertext.
    const token = legacy.prepare('SELECT source_id, mcp_server_id, access_token FROM oauth_tokens WHERE id = ?').get('tok-1') as
      { source_id: string; mcp_server_id: string | null; access_token: Buffer }
    expect(token.source_id).toBe('src-1')
    expect(token.mcp_server_id).toBeNull()
    expect(token.access_token.toString('utf8')).toBe('ciphertext-access')

    // Hosted-sync columns are gone, the skill is not.
    expect(columnNames(legacy, 'skills')).not.toContain('enterprise_skill_id')
    expect(columnNames(legacy, 'skills')).not.toContain('uses_at_last_sync')
    expect(legacy.prepare("SELECT name FROM skills WHERE id = 'skill-1'").get()).toEqual({ name: 'review' })

    // The transcript change cursor is backfilled in (created_at, seq) order.
    const parts = legacy.prepare('SELECT part_id, rev FROM transcript_parts ORDER BY rev').all()
    expect(parts).toEqual([{ part_id: 'p-1', rev: 1 }, { part_id: 'p-2', rev: 2 }])

    // The full-text index covers the migrated rows.
    const hits = legacy.prepare("SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH 'digest'").all()
    expect(hits).toHaveLength(1)
  })

  it('running the migrations again on a current database changes nothing', () => {
    const db = openMemory()
    applySchema(db)
    const before = snapshotSchema(db)

    // Every schema bump re-runs the whole list, so each step must be a no-op once applied.
    runMigrations(db)
    expect(snapshotSchema(db)).toEqual(before)

    // And the version gate skips them entirely.
    expect(applySchema(db)).toBe(false)
    expect(snapshotSchema(db)).toEqual(before)
  })
})

// ── removeHostedServiceData ──────────────────────────────────

const HOSTED_MCP_URL = 'https://app.peakflo.ai/api/mcp/dev/mcp'

/** A database that synced with the hosted service, in the shape migration v10 sees. */
function seedHostedServiceData(db: Db): void {
  db.exec('ALTER TABLE skills ADD COLUMN enterprise_skill_id TEXT DEFAULT NULL')
  db.exec('ALTER TABLE skills ADD COLUMN uses_at_last_sync INTEGER NOT NULL DEFAULT 0')
  db.exec('CREATE INDEX idx_skills_enterprise_id ON skills(enterprise_skill_id)')

  const insertMcp = db.prepare(
    'INSERT INTO mcp_servers (id, name, type, url, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  insertMcp.run('mcp-hosted', 'Peakflo tasks', 'remote', HOSTED_MCP_URL, 'enterprise', NOW, NOW)
  insertMcp.run('mcp-synced', 'Team docs', 'remote', 'https://mcp.example.com/sse', 'enterprise', NOW, NOW)
  insertMcp.run('mcp-user', 'Local fs', 'local', null, 'user', NOW, NOW)

  const insertSource = db.prepare(
    'INSERT INTO task_sources (id, mcp_server_id, name, list_tool, plugin_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  insertSource.run('src-hosted', null, 'Peakflo', '', 'peakflo', NOW, NOW)
  insertSource.run('src-linear', null, 'Linear', '', 'linear', NOW, NOW)

  const insertTask = db.prepare(
    'INSERT INTO tasks (id, title, source, source_id, external_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  insertTask.run('task-hosted', 'Synced from Peakflo', 'Peakflo', 'src-hosted', 'PF-1', NOW, NOW)
  insertTask.run('task-linear', 'From Linear', 'Linear', 'src-linear', 'LIN-1', NOW, NOW)
  insertTask.run('task-local', 'Local only', 'local', null, null, NOW, NOW)

  db.prepare('INSERT INTO agents (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    'agent-1', 'Synced agent',
    JSON.stringify({
      enterprise_source: 'tenant-1',
      enterprise_agent_id: 'ea-1',
      mcp_servers: ['mcp-hosted', { serverId: 'mcp-synced', enabledTools: ['search'] }, 'mcp-user']
    }),
    NOW, NOW
  )

  db.prepare('INSERT INTO skills (id, name, description, content, enterprise_skill_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('skill-1', 'review', 'Review code', '# Review', 'ent-1', NOW, NOW)

  const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
  insertSetting.run('enterprise_token', 'secret')
  insertSetting.run('workflo-sync-cursor', '42')
  insertSetting.run('theme', 'dark')
}

/** Everything removeHostedServiceData touches, in a comparable form. */
function dumpHostedState(db: Db): unknown {
  return {
    tasks: db.prepare('SELECT id, source, source_id, external_id FROM tasks ORDER BY id').all(),
    taskSources: db.prepare('SELECT id, plugin_id FROM task_sources ORDER BY id').all(),
    mcpServers: db.prepare('SELECT id, source, url FROM mcp_servers ORDER BY id').all(),
    agents: db.prepare('SELECT id, config FROM agents ORDER BY id').all(),
    skillColumns: columnNames(db, 'skills'),
    skills: db.prepare('SELECT id, name FROM skills ORDER BY id').all(),
    settings: db.prepare('SELECT key, value FROM settings ORDER BY key').all(),
    indexes: db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'skills' ORDER BY name").all()
  }
}

describe('removeHostedServiceData', () => {
  it('removes only what cannot work without the hosted service', () => {
    const db = openMemory()
    applySchema(db)
    seedHostedServiceData(db)

    removeHostedServiceData(db)

    // Hosted tasks become local tasks; other sourced tasks are untouched.
    expect(db.prepare('SELECT source, source_id, external_id FROM tasks WHERE id = ?').get('task-hosted'))
      .toEqual({ source: 'local', source_id: null, external_id: null })
    expect(db.prepare('SELECT source, source_id, external_id FROM tasks WHERE id = ?').get('task-linear'))
      .toEqual({ source: 'Linear', source_id: 'src-linear', external_id: 'LIN-1' })
    expect(db.prepare('SELECT id FROM task_sources ORDER BY id').all()).toEqual([{ id: 'src-linear' }])

    // Only the MCP server that points at the hosted API goes; the other synced one is kept as a user server.
    expect(db.prepare('SELECT id, source FROM mcp_servers ORDER BY id').all()).toEqual([
      { id: 'mcp-synced', source: 'user' },
      { id: 'mcp-user', source: 'user' }
    ])
    expect(agentConfig(db, 'agent-1')).toEqual({
      mcp_servers: [{ serverId: 'mcp-synced', enabledTools: ['search'] }, 'mcp-user']
    })

    // Sync bookkeeping is dropped from skills and settings; user data stays.
    expect(columnNames(db, 'skills')).not.toContain('enterprise_skill_id')
    expect(columnNames(db, 'skills')).not.toContain('uses_at_last_sync')
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_skills_enterprise_id'").get()).toBeUndefined()
    expect(db.prepare("SELECT name FROM skills WHERE id = 'skill-1'").get()).toEqual({ name: 'review' })
    expect(db.prepare("SELECT key, value FROM settings WHERE key NOT LIKE '\\_\\_%' ESCAPE '\\' AND key NOT LIKE 'migration:%' ORDER BY key").all())
      .toEqual([{ key: 'theme', value: 'dark' }])
  })

  it('is idempotent: a second run neither fails nor changes anything', () => {
    const db = openMemory()
    applySchema(db)
    seedHostedServiceData(db)
    const original = dumpHostedState(db)

    removeHostedServiceData(db)
    const afterFirstRun = dumpHostedState(db)
    expect(afterFirstRun).not.toEqual(original)

    expect(() => removeHostedServiceData(db)).not.toThrow()
    expect(dumpHostedState(db)).toEqual(afterFirstRun)

    // Partial runs are completed rather than repeated: a hosted source that
    // reappears is cleaned up without touching anything already migrated.
    db.prepare('INSERT INTO task_sources (id, mcp_server_id, name, list_tool, plugin_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('src-hosted-2', null, 'Peakflo again', '', 'peakflo', NOW, NOW)
    removeHostedServiceData(db)
    expect(dumpHostedState(db)).toEqual(afterFirstRun)
  })
})
