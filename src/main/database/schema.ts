import type Database from 'better-sqlite3'
import { createId } from '@paralleldrive/cuid2'
import { TaskStatus } from '../../shared/constants'
import { DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME } from '../../shared/projects'
import { getRepoProviders, isGitProvider } from '../repo-providers'
import type { AgentMcpServerEntry, McpServerConfigRecord } from './types'
import { migrateCoordinatorToCaptain } from './captain-migration'
import { migrateTaskActivity } from './task-activity-migration'
import { splitLegacyPullRequestEscalation } from '../../shared/project-policies'
import { createConcurrencyTables, migrateConcurrencyControl } from './concurrency-migration'
import { createAuthorizationTables } from './authorization-schema'
import { createDurableStartQueueTables, migrateDurableStartQueue } from './start-queue-migration'
import { createIssueWriteTables, migrateIssueWrites } from './issue-writes-migration'

/**
 * Bump this whenever new migrations are added so returning users skip
 * the full migration check on startup.
 *
 * ⚠️ `runMigrations()` is ONLY called when the stored version is LOWER than
 * this number (see `applySchema()`). Adding an `ALTER TABLE` to `runMigrations()`
 * without bumping this leaves the column missing on every existing install, and
 * every write to it fails with "no such column" at runtime. Unit tests build a
 * fresh schema, so they never exercise the version gate.
 *
 * 8 → 9: tasks.complete_at_source
 * 9 → 10: remove hosted-service data (removeHostedServiceData)
 * 10 → 11: preserve existing Claude Code agents' permission behaviour
 * 11 → 12: tasks.next_subtask_ids
 * 12 → 13: tasks.role (coordinator rows such as the Captain)
 * 13 → 14: skills.preferred_model
 * 14 → 15: projects, project_repos, project_resources; tasks.project_id and
 *          task_sources.project_id, everything moved into the Default project
 *          (migrateToProjects)
 * 15 → 16: skills.project_id (null = global; every existing skill stays global)
 *          (migrateSkillScope, #74)
 * 16 → 17: the project coordinator is renamed to Captain (#71):
 *          tasks.role, projects.captain_agent_id, the captain_prewarm setting,
 *          projects.settings.captain_wakeups and project_status_journal.source
 *          (migrateCoordinatorToCaptain in captain-migration.ts)
 * 17 → 19: merge grants (#137): merge_grants, merge_grant_uses
 *          (migrateMergeGrants), and the escalation policy's combined `pr`
 *          item split into `open_pr` / `merge_pr` in projects.settings
 *          (splitPullRequestEscalation: the old level goes to merge_pr,
 *          open_pr gets its default "tell_commander"). 18 was skipped for a
 *          contemporaneous feature branch.
 * 19 → 20: managed Captain runtime generations and the durable delivery
 *          outbox used by task messages, Commander requests and reports.
 * 20 → 21: Captain-managed concurrency (#150): concurrency_audit, task_touches,
 *          and agents.config.concurrency_cap = min(max_parallel_sessions, 5)
 *          where unset (migrateConcurrencyControl in concurrency-migration.ts).
 * 21 → 22: durable agent start queue, leases, generations, retry state and
 *          cross-project fairness (#148, migrateDurableStartQueue).
 * 22 → 23: immutable human authorization chains and durable dispatch bindings.
 * 23 → 24: the delegated GitHub issue-write ledger: issue_writes, one row per
 *          external issue write, carrying both its audit provenance and its
 *          unique idempotency claim (migrateIssueWrites in
 *          issue-writes-migration.ts).
 * 24 → 25: meaningful task activity timestamps (#142).
 * 25 → 26: merge-grant uses retain policy/relay context separately from the
 *          effective grant authority (#159, migrateMergeGrantAttribution).
 * 26 → 27: exact-head PR review attestations and durable readiness snapshots.
 * 27 → 28: signed implementation-to-review handoffs bind attestation task and
 *          agent provenance; legacy unbound attestations fail closed.
 */
const SCHEMA_VERSION = 28

/**
 * Bring `db` to the current schema. A fresh database gets the base tables from
 * `createTables()` and the remaining columns from `runMigrations()`, exactly
 * like an upgrade. Returns true when migrations ran, so the caller can seed
 * first-run data.
 */
export function applySchema(db: Database.Database): boolean {
  createTables(db)
  const migrated = getSchemaVersion(db) < SCHEMA_VERSION
  if (migrated) {
    runMigrations(db)
    setSchemaVersion(db, SCHEMA_VERSION)
  }
  // Not gated on the version: both are idempotent, and the FTS rebuild keeps
  // its triggers in step with the current schema.
  ensureTranscriptRevColumn(db)
  initializeTasksFts(db)
  ensureTaskProjectAssignment(db)
  return migrated
}

/**
 * Idempotently add the `rev` change-cursor column to transcript_parts for DBs
 * created before it existed. Backfills existing rows with a monotonic rev so
 * a first delta query returns them in a stable order.
 */
export function ensureTranscriptRevColumn(db: Database.Database): void {
  try {
    const cols = db.prepare(`PRAGMA table_info(transcript_parts)`).all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'rev')) {
      // Legacy DB created before `rev` existed — add the column and backfill
      // existing rows with a global monotonic rev ordered by (created_at, seq).
      db.exec(`ALTER TABLE transcript_parts ADD COLUMN rev INTEGER NOT NULL DEFAULT 0`)
      db.exec(`
        WITH ordered AS (
          SELECT rowid AS rid, ROW_NUMBER() OVER (ORDER BY created_at ASC, seq ASC) AS rn
          FROM transcript_parts
        )
        UPDATE transcript_parts SET rev = (SELECT rn FROM ordered WHERE ordered.rid = transcript_parts.rowid)
      `)
      console.log('[Database] Added transcript_parts.rev column and backfilled existing rows')
    }
    // Create the rev index HERE (not in createTables) so it never runs before
    // the column exists on a legacy DB. Idempotent + safe on a fresh DB, where
    // the column is declared in the CREATE TABLE and this simply adds the index.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_transcript_parts_task_rev ON transcript_parts(task_id, rev)`)
    // upsertTranscriptParts reads the global MAX(rev) inside every write
    // transaction; without this index that is a full table scan.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_transcript_parts_rev ON transcript_parts(rev)`)
  } catch (err) {
    console.error('[Database] ensureTranscriptRevColumn failed:', err)
  }
}

function getSchemaVersion(db: Database.Database): number {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = '__schema_version'").get() as { value: string } | undefined
    return row ? parseInt(row.value, 10) || 0 : 0
  } catch {
    return 0
  }
}

function setSchemaVersion(db: Database.Database, version: number): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('__schema_version', ?)").run(String(version))
}

export function createTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'general',
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT '${TaskStatus.NotStarted}',
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
      heartbeat_enabled INTEGER NOT NULL DEFAULT 0,
      heartbeat_interval_minutes INTEGER DEFAULT 30,
      heartbeat_last_check_at TEXT DEFAULT NULL,
      heartbeat_next_check_at TEXT DEFAULT NULL,
      auto_start_agent INTEGER NOT NULL DEFAULT 0,
      auto_complete_without_review INTEGER NOT NULL DEFAULT 0,
      complete_at_source INTEGER DEFAULT NULL,
      parent_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      next_subtask_ids TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'task',
      project_id TEXT REFERENCES projects(id),
      last_activity_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
    CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source);
    -- NOTE: idx_tasks_project is created in migrateToProjects(), after the
    -- project_id column exists on an upgraded database.

    -- Projects group tasks and task sources. A project has zero, one or many
    -- repos; resources are links and notes given to agents as context only.
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      default_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      captain_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      git_provider TEXT DEFAULT NULL,
      git_org TEXT DEFAULT NULL,
      settings TEXT NOT NULL DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_repos (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      provider TEXT NOT NULL DEFAULT 'github',
      org TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      default_branch TEXT DEFAULT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_repos_project ON project_repos(project_id, sort_order);

    CREATE TABLE IF NOT EXISTS project_resources (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      url TEXT DEFAULT NULL,
      notes TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_resources_project ON project_resources(project_id, sort_order);

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      server_url TEXT NOT NULL DEFAULT 'http://localhost:4096',
      config TEXT NOT NULL DEFAULT '{}',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'local',
      command TEXT NOT NULL DEFAULT '',
      args TEXT NOT NULL DEFAULT '[]',
      url TEXT,
      headers TEXT NOT NULL DEFAULT '{}',
      environment TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_sources (
      id TEXT PRIMARY KEY,
      mcp_server_id TEXT REFERENCES mcp_servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      list_tool TEXT NOT NULL,
      list_tool_args TEXT NOT NULL DEFAULT '{}',
      update_tool TEXT NOT NULL DEFAULT '',
      update_tool_args TEXT NOT NULL DEFAULT '{}',
      last_synced_at TEXT,
      plugin_id TEXT NOT NULL DEFAULT '',
      config TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      project_id TEXT REFERENCES projects(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      content TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      confidence REAL NOT NULL DEFAULT 0.5,
      uses INTEGER NOT NULL DEFAULT 0,
      last_used TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      preferred_model TEXT DEFAULT NULL,
      project_id TEXT REFERENCES projects(id),
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS heartbeat_logs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      summary TEXT,
      session_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_heartbeat_logs_task ON heartbeat_logs(task_id);
    CREATE INDEX IF NOT EXISTS idx_heartbeat_logs_created ON heartbeat_logs(created_at);

    CREATE TABLE IF NOT EXISTS oauth_tokens (
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

    CREATE TABLE IF NOT EXISTS secrets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      env_var_name TEXT NOT NULL UNIQUE,
      value BLOB NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_secrets_env_var ON secrets(env_var_name);

    CREATE TABLE IF NOT EXISTS marketplace_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      source_type TEXT NOT NULL DEFAULT 'github',
      source_url TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      auto_update INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS installed_plugins (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      marketplace_id TEXT REFERENCES marketplace_sources(id) ON DELETE CASCADE,
      manifest TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT '{}',
      scope TEXT NOT NULL DEFAULT 'user',
      enabled INTEGER NOT NULL DEFAULT 1,
      version TEXT NOT NULL DEFAULT '1.0.0',
      installed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_installed_plugins_name_marketplace
      ON installed_plugins(name, marketplace_id);

    CREATE TABLE IF NOT EXISTS mobile_pair_codes (
      id TEXT PRIMARY KEY,
      pin TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS mobile_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      device_name TEXT,
      paired_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen INTEGER NOT NULL DEFAULT (unixepoch()),
      revoked INTEGER NOT NULL DEFAULT 0
    );

    -- Durable transcript projection: the main process is the source of truth
    -- for every message part shown in a task transcript. The renderer hydrates
    -- from snapshots of this table instead of depending on catching live
    -- events, so output produced while no view is bound (background wake-ups,
    -- resumed sessions, mobile) is never lost.
    CREATE TABLE IF NOT EXISTS transcript_parts (
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
      -- Global monotonic change cursor: bumped on every insert AND content
      -- update, so a client can fetch "everything changed since rev N" (deltas),
      -- capturing both new parts and streaming edits to existing ones.
      rev INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (task_id, part_id)
    );
    CREATE INDEX IF NOT EXISTS idx_transcript_parts_task_seq ON transcript_parts(task_id, seq);
    -- NOTE: the rev indexes are created in ensureTranscriptRevColumn(),
    -- NOT here. On a DB created before rev existed, CREATE TABLE IF NOT EXISTS
    -- is a no-op (no rev column), so building them here would fail with
    -- no-such-column before the ALTER TABLE migration runs.

    -- Commander chat sessions (docs/commander.md). Timestamps are epoch ms.
    CREATE TABLE IF NOT EXISTS commander_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      last_read_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_commander_sessions_updated ON commander_sessions(updated_at);

    CREATE TABLE IF NOT EXISTS commander_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES commander_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'report', 'summary')),
      content TEXT NOT NULL DEFAULT '',
      tool_calls TEXT,
      tool_call_id TEXT,
      tool_name TEXT,
      is_error INTEGER NOT NULL DEFAULT 0,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      correlation_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_commander_messages_session_created ON commander_messages(session_id, created_at);

    CREATE TABLE IF NOT EXISTS managed_agent_runtimes (
      owner_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL DEFAULT 0,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      candidate_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      last_good_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      session_id TEXT,
      phase TEXT NOT NULL,
      deadline_at INTEGER,
      last_probe_at INTEGER,
      probe_ok INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_detail TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_managed_agent_runtimes_project
      ON managed_agent_runtimes(project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_managed_agent_runtimes_phase_deadline
      ON managed_agent_runtimes(phase, deadline_at);

    CREATE TABLE IF NOT EXISTS delivery_outbox (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      source_session_id TEXT,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      correlation_id TEXT,
      payload TEXT NOT NULL,
      destination_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      claim_owner TEXT,
      claim_expires_at INTEGER,
      deadline_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      acknowledged_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_outbox_recovery
      ON delivery_outbox(kind, state, claim_expires_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_delivery_outbox_correlation
      ON delivery_outbox(correlation_id, kind, created_at DESC)
      WHERE correlation_id IS NOT NULL;
  `)

  // Embedded connector pieces (docs/connectors.md). Timestamps are epoch ms.
  // New tables only, so CREATE IF NOT EXISTS covers fresh and existing DBs
  // alike. Everything cascades from connector_instances, and `auth` (safeStorage
  // ciphertext, never plaintext) lives on the instance row itself.
  db.exec(`
    CREATE TABLE IF NOT EXISTS connector_instances (
      id TEXT PRIMARY KEY,
      piece_name TEXT NOT NULL,
      piece_version TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      config TEXT NOT NULL DEFAULT '{}',
      auth BLOB,
      auth_type TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS connector_kv (
      instance_id TEXT NOT NULL REFERENCES connector_instances(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK (scope IN ('project', 'flow')),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (instance_id, scope, key)
    );

    CREATE TABLE IF NOT EXISTS connector_sync_state (
      instance_id TEXT PRIMARY KEY REFERENCES connector_instances(id) ON DELETE CASCADE,
      cursor TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER,
      last_error TEXT,
      last_synced_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS connector_dead_letters (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL REFERENCES connector_instances(id) ON DELETE CASCADE,
      external_id TEXT,
      payload TEXT NOT NULL DEFAULT 'null',
      error TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_connector_dead_letters_instance ON connector_dead_letters(instance_id, created_at);
  `)

  // Project status snapshot (#58): the Captain's narrative for a project.
  // Counts are never stored; they are computed from tasks and live sessions.
  // One row per project, replaced on every write. A durable journal of past
  // snapshots (#72) is a separate table beside this one, keyed the same way.
  // New table, so CREATE IF NOT EXISTS covers fresh and existing DBs alike.
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_status (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      summary TEXT NOT NULL DEFAULT '',
      top_blockers TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );
  `)

  // Project status journal (#72): one row per Captain status update, kept
  // beside the snapshot above. The lists are JSON arrays of short strings.
  // `source` is 'captain' for a written update and 'compaction' for the
  // monthly roll-up of entries older than the retention window. Rows go with
  // their project. The index serves the newest-first (created_at, id) page
  // reads. New table, so CREATE IF NOT EXISTS covers fresh and existing DBs alike.
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_status_journal (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      summary TEXT NOT NULL,
      completed TEXT NOT NULL DEFAULT '[]',
      blockers TEXT NOT NULL DEFAULT '[]',
      decisions TEXT NOT NULL DEFAULT '[]',
      next_steps TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'captain',
      correlation_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_status_journal_project_created
      ON project_status_journal(project_id, created_at DESC, id DESC);
  `)

  createMergeGrantTables(db)
  createPullRequestReadinessTables(db)
  // Concurrency control (#150): audit feed and declared touches.
  createConcurrencyTables(db)

  // Captain self-healing (#148): the one durable admission/start queue.
  createDurableStartQueueTables(db)

  // Delegated GitHub issue writes: the audit ledger and idempotency claims.
  createIssueWriteTables(db)

  // Report routing (#62): a Captain report quotes the correlation id of
  // the `ask_captain` tool row it answers; this serves that lookup.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_commander_messages_correlation
      ON commander_messages(correlation_id) WHERE correlation_id IS NOT NULL;
  `)

  // Images attached to a Commander user message (#144). The bytes live in
  // their own table so message rows, events and searches stay small; they go
  // with their message. New table, so CREATE IF NOT EXISTS covers fresh and
  // existing DBs alike.
  db.exec(`
    CREATE TABLE IF NOT EXISTS commander_images (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES commander_messages(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      data BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_commander_images_message ON commander_images(message_id, position);
  `)
}

/**
 * Rebuild the tasks table using the canonical schema from createTables().
 * Dynamically copies all columns that exist in both old and new tables,
 * so future column additions don't need to update this method.
 * Refreshes columnNames in-place after the rebuild.
 */
function rebuildTasksTable(db: Database.Database, columnNames: Set<string>): void {
  db.exec('PRAGMA foreign_keys = OFF')

  // Drop tasks_new if it exists from a previous failed attempt
  db.exec('DROP TABLE IF EXISTS tasks_new')

  db.exec(`
    CREATE TABLE tasks_new (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'general',
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT '${TaskStatus.NotStarted}',
      assignee TEXT NOT NULL DEFAULT '',
      due_date TEXT,
      labels TEXT NOT NULL DEFAULT '[]',
      checklist TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'local',
      resolution TEXT,
      attachments TEXT NOT NULL DEFAULT '[]',
      repos TEXT NOT NULL DEFAULT '[]',
      output_fields TEXT NOT NULL DEFAULT '[]',
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      external_id TEXT,
      source_id TEXT REFERENCES task_sources(id) ON DELETE CASCADE,
      skill_ids TEXT DEFAULT NULL,
      session_id TEXT DEFAULT NULL,
      snoozed_until TEXT DEFAULT NULL,
      feedback_rating INTEGER DEFAULT NULL,
      feedback_comment TEXT DEFAULT NULL,
      is_recurring INTEGER NOT NULL DEFAULT 0,
      recurrence_pattern TEXT DEFAULT NULL,
      recurrence_parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      last_occurrence_at TEXT DEFAULT NULL,
      next_occurrence_at TEXT DEFAULT NULL,
      heartbeat_enabled INTEGER NOT NULL DEFAULT 0,
      heartbeat_interval_minutes INTEGER DEFAULT 30,
      heartbeat_last_check_at TEXT DEFAULT NULL,
      heartbeat_next_check_at TEXT DEFAULT NULL,
      auto_start_agent INTEGER NOT NULL DEFAULT 0,
      auto_complete_without_review INTEGER NOT NULL DEFAULT 0,
      complete_at_source INTEGER DEFAULT NULL,
      parent_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      next_subtask_ids TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'task',
      project_id TEXT REFERENCES projects(id),
      last_activity_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

  // Dynamically find columns shared between old and new tables
  const newCols = (db.pragma('table_info(tasks_new)') as { name: string }[]).map(c => c.name)
  // Read the live columns: earlier migrations in the same run ALTER the table
  // without updating the caller's set (e.g. session_id), and trusting it would
  // drop those columns' data here.
  const oldCols = new Set((db.pragma('table_info(tasks)') as { name: string }[]).map(c => c.name))
  const sharedCols = newCols.filter(c => oldCols.has(c))

  const colList = sharedCols.join(', ')
  db.exec(`INSERT INTO tasks_new (${colList}) SELECT ${colList} FROM tasks`)

  db.exec('DROP TABLE tasks')
  db.exec('ALTER TABLE tasks_new RENAME TO tasks')

  // Recreate indexes
  db.exec(`
    CREATE INDEX idx_tasks_status ON tasks(status);
    CREATE INDEX idx_tasks_priority ON tasks(priority);
    CREATE INDEX idx_tasks_source ON tasks(source);
    CREATE UNIQUE INDEX idx_tasks_source_external ON tasks(source_id, external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX idx_tasks_next_occurrence ON tasks(next_occurrence_at) WHERE is_recurring = 1;
    CREATE INDEX idx_tasks_heartbeat_next ON tasks(heartbeat_next_check_at) WHERE heartbeat_enabled = 1;
    CREATE INDEX idx_tasks_parent ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;
    CREATE INDEX idx_tasks_project ON tasks(project_id);
  `)

  db.exec('PRAGMA foreign_keys = ON')

  ensureTaskProjectAssignment(db)

  // Refresh columnNames so subsequent migrations see accurate state
  columnNames.clear()
  for (const col of newCols) columnNames.add(col)
}

export function runMigrations(db: Database.Database): void {
  const columns = db.pragma('table_info(tasks)') as { name: string }[]
  const columnNames = new Set(columns.map((c) => c.name))

  if (!columnNames.has('attachments')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'`)
  }

  if (!columnNames.has('agent_id')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL`)
  }

  if (!columnNames.has('repos')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN repos TEXT NOT NULL DEFAULT '[]'`)
  }

  if (!columnNames.has('output_fields')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN output_fields TEXT NOT NULL DEFAULT '[]'`)
  }

  if (!columnNames.has('external_id')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN external_id TEXT`)
  }
  if (!columnNames.has('source_id')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN source_id TEXT REFERENCES task_sources(id) ON DELETE SET NULL`)
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_external ON tasks(source_id, external_id) WHERE external_id IS NOT NULL`)
  }

  if (!columnNames.has('skill_ids')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN skill_ids TEXT DEFAULT NULL`)
  }

  // Migrate oc_session_id to session_id (for backward compatibility)
  if (columnNames.has('oc_session_id') && !columnNames.has('session_id')) {
    // Rename column by creating new column, copying data, dropping old
    db.exec(`ALTER TABLE tasks ADD COLUMN session_id TEXT DEFAULT NULL`)
    db.exec(`UPDATE tasks SET session_id = oc_session_id WHERE oc_session_id IS NOT NULL`)
    // Note: SQLite doesn't support DROP COLUMN in all versions, so we leave oc_session_id for now
    // It will be unused going forward
  } else if (!columnNames.has('session_id')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN session_id TEXT DEFAULT NULL`)
  }

  if (!columnNames.has('snoozed_until')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN snoozed_until TEXT DEFAULT NULL`)
  }

  if (!columnNames.has('resolution')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN resolution TEXT DEFAULT NULL`)
  }

  if (!columnNames.has('feedback_rating')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN feedback_rating INTEGER DEFAULT NULL`)
  }
  if (!columnNames.has('feedback_comment')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN feedback_comment TEXT DEFAULT NULL`)
  }

  // Migrate mcp_servers table — add new columns for remote support
  const mcpColumns = db.pragma('table_info(mcp_servers)') as { name: string }[]
  const mcpColumnNames = new Set(mcpColumns.map((c) => c.name))

  if (!mcpColumnNames.has('type')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN type TEXT NOT NULL DEFAULT 'local'`)
  }
  if (!mcpColumnNames.has('url')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN url TEXT`)
  }
  if (!mcpColumnNames.has('headers')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN headers TEXT NOT NULL DEFAULT '{}'`)
  }
  if (!mcpColumnNames.has('environment')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN environment TEXT NOT NULL DEFAULT '{}'`)
  }
  if (!mcpColumnNames.has('tools')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN tools TEXT NOT NULL DEFAULT '[]'`)
  }
  if (!mcpColumnNames.has('oauth_metadata')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN oauth_metadata TEXT NOT NULL DEFAULT '{}'`)
  }
  if (!mcpColumnNames.has('source')) {
    // Provenance column. Defaults to 'user'.
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN source TEXT NOT NULL DEFAULT 'user'`)
  }

  // Migrate oauth_tokens: make source_id nullable and add mcp_server_id
  const oauthTokenColumns = db.pragma('table_info(oauth_tokens)') as { name: string; notnull: number }[]
  const hasMcpServerIdOAuth = oauthTokenColumns.some(col => col.name === 'mcp_server_id')

  if (oauthTokenColumns.length > 0 && !hasMcpServerIdOAuth) {
    db.exec(`
      PRAGMA foreign_keys = OFF;

      CREATE TABLE IF NOT EXISTS oauth_tokens_new (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        source_id TEXT REFERENCES task_sources(id) ON DELETE CASCADE,
        mcp_server_id TEXT REFERENCES mcp_servers(id) ON DELETE CASCADE,
        access_token BLOB NOT NULL,
        refresh_token BLOB,
        expires_at TEXT NOT NULL,
        scope TEXT,
        token_type TEXT NOT NULL DEFAULT 'Bearer',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO oauth_tokens_new (id, provider, source_id, access_token, refresh_token, expires_at, scope, token_type, created_at, updated_at)
      SELECT id, provider, source_id, access_token, refresh_token, expires_at, scope, token_type, created_at, updated_at FROM oauth_tokens;

      DROP TABLE oauth_tokens;
      ALTER TABLE oauth_tokens_new RENAME TO oauth_tokens;

      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_source ON oauth_tokens(source_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider ON oauth_tokens(provider);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_mcp_server ON oauth_tokens(mcp_server_id);

      PRAGMA foreign_keys = ON;
    `)
  }

  // Migrate inline MCP servers from agent configs → mcp_servers table
  migrateInlineMcpServers(db)

  // Migrate task_sources: add plugin_id + config columns
  const tsColumns = db.pragma('table_info(task_sources)') as { name: string }[]
  const tsColumnNames = new Set(tsColumns.map((c) => c.name))

  if (!tsColumnNames.has('plugin_id')) {
    db.exec(`ALTER TABLE task_sources ADD COLUMN plugin_id TEXT NOT NULL DEFAULT ''`)
  }
  if (!tsColumnNames.has('config')) {
    db.exec(`ALTER TABLE task_sources ADD COLUMN config TEXT NOT NULL DEFAULT '{}'`)
    // Migrate existing rows: pack old columns into config JSON
    const sources = db.prepare('SELECT id, list_tool, list_tool_args, update_tool, update_tool_args FROM task_sources').all() as {
      id: string; list_tool: string; list_tool_args: string; update_tool: string; update_tool_args: string
    }[]
    for (const src of sources) {
      const config = {
        list_tool: src.list_tool,
        list_tool_args: JSON.parse(src.list_tool_args || '{}'),
        update_tool: src.update_tool || undefined,
        update_tool_args: JSON.parse(src.update_tool_args || '{}')
      }
      db.prepare('UPDATE task_sources SET config = ? WHERE id = ?').run(JSON.stringify(config), src.id)
    }
  }

  // Migrate task statuses: old 6-status → new 4-status
  const hasOldStatuses = (db.prepare(
    "SELECT COUNT(*) as count FROM tasks WHERE status IN ('inbox', 'accepted', 'in_progress', 'pending_review', 'cancelled')"
  ).get() as { count: number }).count > 0

  if (hasOldStatuses) {
    db.exec(`
      UPDATE tasks SET status = 'not_started' WHERE status IN ('inbox', 'accepted', 'cancelled');
      UPDATE tasks SET status = 'agent_working' WHERE status = 'in_progress';
      UPDATE tasks SET status = 'ready_for_review' WHERE status = 'pending_review';
    `)
  }

  // Add coding_agent column to agents table for multi-backend support
  const agentColumns = db.pragma('table_info(agents)') as { name: string }[]
  const agentColumnNames = new Set(agentColumns.map((c) => c.name))

  if (!agentColumnNames.has('coding_agent')) {
    db.exec(`ALTER TABLE agents ADD COLUMN coding_agent TEXT NOT NULL DEFAULT 'opencode'`)
    db.exec(`UPDATE agents SET coding_agent = 'opencode' WHERE coding_agent IS NULL OR coding_agent = ''`)
  }

  // Migrate task_sources: make mcp_server_id nullable (for plugins that don't
  // need MCP), and drop the legacy 'peakflo' default on plugin_id. Both need a
  // table rebuild, so either one triggers it.
  const tsInfo = db.pragma('table_info(task_sources)') as Array<{name: string, notnull: number, dflt_value: string | null}>
  const mcpServerIdCol = tsInfo.find(col => col.name === 'mcp_server_id')
  const pluginIdCol = tsInfo.find(col => col.name === 'plugin_id')

  if ((mcpServerIdCol && mcpServerIdCol.notnull === 1) || (pluginIdCol && pluginIdCol.dflt_value !== "''")) {
    // Column exists and is NOT NULL, need to recreate table
    db.exec(`
      PRAGMA foreign_keys = OFF;

      CREATE TABLE task_sources_new (
        id TEXT PRIMARY KEY,
        mcp_server_id TEXT REFERENCES mcp_servers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        list_tool TEXT NOT NULL,
        list_tool_args TEXT NOT NULL DEFAULT '{}',
        update_tool TEXT NOT NULL DEFAULT '',
        update_tool_args TEXT NOT NULL DEFAULT '{}',
        last_synced_at TEXT,
        plugin_id TEXT NOT NULL DEFAULT '',
        config TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        project_id TEXT REFERENCES projects(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

    `)
    // Copy by name: an older table has fewer columns, or the same ones in a
    // different order, so a positional SELECT * would scramble rows.
    const newTsCols = (db.pragma('table_info(task_sources_new)') as { name: string }[]).map(c => c.name)
    const oldTsCols = new Set((db.pragma('table_info(task_sources)') as { name: string }[]).map(c => c.name))
    const tsCols = newTsCols.filter(c => oldTsCols.has(c)).join(', ')
    db.exec(`
      INSERT INTO task_sources_new (${tsCols}) SELECT ${tsCols} FROM task_sources;

      DROP TABLE task_sources;

      ALTER TABLE task_sources_new RENAME TO task_sources;

      PRAGMA foreign_keys = ON;
    `)
  }

  // Fix corrupted task_sources config fields (cleanup after migration issues)
  const allSources = db.prepare('SELECT id, config, name FROM task_sources').all() as Array<{
    id: string
    config: string
    name: string
  }>

  for (const src of allSources) {
    try {
      // Try to parse config as JSON
      JSON.parse(src.config)
    } catch {
      // Invalid JSON - reset to empty object and infer plugin_id from the name
      console.log(`[Database Migration] Fixing corrupted config for task source: ${src.name} (${src.id})`)

      const name = src.name.toLowerCase()
      const pluginId = name.includes('linear') ? 'linear' : name.includes('hubspot') ? 'hubspot' : null
      if (pluginId) {
        db.prepare('UPDATE task_sources SET config = ?, plugin_id = ? WHERE id = ?')
          .run('{}', pluginId, src.id)
      } else {
        db.prepare('UPDATE task_sources SET config = ? WHERE id = ?').run('{}', src.id)
      }
    }
  }

  // Migrate tasks table: change source_id foreign key from ON DELETE SET NULL to ON DELETE CASCADE
  const taskTableInfo = db.pragma('foreign_key_list(tasks)') as Array<{
    id: number
    seq: number
    table: string
    from: string
    to: string
    on_update: string
    on_delete: string
  }>

  const sourceIdFk = taskTableInfo.find(fk => fk.from === 'source_id' && fk.table === 'task_sources')
  if (sourceIdFk && sourceIdFk.on_delete === 'SET NULL') {
    console.log('[Database Migration] Updating source_id foreign key to CASCADE delete')
    rebuildTasksTable(db, columnNames)
    console.log('[Database Migration] Successfully updated source_id foreign key to CASCADE')
  }

  // Add recurring task columns
  if (!columnNames.has('is_recurring')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN is_recurring INTEGER NOT NULL DEFAULT 0`)
  }
  if (!columnNames.has('recurrence_pattern')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN recurrence_pattern TEXT DEFAULT NULL`)
  }
  if (!columnNames.has('recurrence_parent_id')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN recurrence_parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE`)
  }
  if (!columnNames.has('last_occurrence_at')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN last_occurrence_at TEXT DEFAULT NULL`)
  }
  if (!columnNames.has('next_occurrence_at')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN next_occurrence_at TEXT DEFAULT NULL`)
  }
  // Built here rather than in createTables(): on a database older than
  // recurring tasks the column only exists after the ALTER above.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_next_occurrence ON tasks(next_occurrence_at) WHERE is_recurring = 1`)

  // Add heartbeat columns to tasks
  if (!columnNames.has('heartbeat_enabled')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN heartbeat_enabled INTEGER NOT NULL DEFAULT 0`)
  }
  if (!columnNames.has('heartbeat_interval_minutes')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN heartbeat_interval_minutes INTEGER DEFAULT 30`)
  }
  if (!columnNames.has('heartbeat_last_check_at')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN heartbeat_last_check_at TEXT DEFAULT NULL`)
  }
  if (!columnNames.has('heartbeat_next_check_at')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN heartbeat_next_check_at TEXT DEFAULT NULL`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_heartbeat_next ON tasks(heartbeat_next_check_at) WHERE heartbeat_enabled = 1`)
  }

  // Add parent_task_id column for subtask support
  if (!columnNames.has('parent_task_id')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE`)
  }
  // Always ensure the index exists (covers both new DBs and migrated DBs)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL`)

  // Add sort_order column for explicit subtask ordering (supports drag-and-drop)
  if (!columnNames.has('sort_order')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`)
  }
  if (!columnNames.has('next_subtask_ids')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN next_subtask_ids TEXT NOT NULL DEFAULT '[]'`)
  }

  // Add auto_start_agent and auto_complete_without_review columns for recurring tasks
  if (!columnNames.has('auto_start_agent')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN auto_start_agent INTEGER NOT NULL DEFAULT 0`)
  }
  if (!columnNames.has('complete_at_source')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN complete_at_source INTEGER DEFAULT NULL`)
  }
  if (!columnNames.has('auto_complete_without_review')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN auto_complete_without_review INTEGER NOT NULL DEFAULT 0`)
  }

  // Coordinator rows (the Captain) live in `tasks` so their session and
  // transcript persist like any task's, and `role` keeps them out of every list.
  if (!columnNames.has('role')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN role TEXT NOT NULL DEFAULT 'task'`)
  }

  // Create heartbeat_logs table
  const heartbeatLogsTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='heartbeat_logs'"
  ).get()
  if (!heartbeatLogsTable) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS heartbeat_logs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        summary TEXT,
        session_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_heartbeat_logs_task ON heartbeat_logs(task_id);
      CREATE INDEX IF NOT EXISTS idx_heartbeat_logs_created ON heartbeat_logs(created_at);
    `)
  }

  // Migration v2: secrets table
  const secretsTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='secrets'"
  ).get()
  if (!secretsTable) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        env_var_name TEXT NOT NULL UNIQUE,
        value BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_secrets_env_var ON secrets(env_var_name);
    `)
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name)`)

  // Migration v14: optional per-skill preferred model (null = no preference).
  const skillCols = new Set((db.pragma('table_info(skills)') as { name: string }[]).map((c) => c.name))
  if (!skillCols.has('preferred_model')) {
    db.exec(`ALTER TABLE skills ADD COLUMN preferred_model TEXT DEFAULT NULL`)
  }

  // Migration v15: projects. Everything that existed before moves into the Default project.
  migrateToProjects(db)

  // Migration v16: skill scope (#74). Runs after migrateToProjects so the
  // projects table the column references exists.
  migrateSkillScope(db)

  // Migration v17: the coordinator is renamed to Captain (#71). Runs after migrateToProjects so
  // the projects table (and its renamed column) exists.
  migrateCoordinatorToCaptain(db)

  // Migration v19: merge grants (#137). New tables only; runs after
  // migrateToProjects so the projects table they reference exists.
  migrateMergeGrants(db)
  // Migration v21: concurrency control (#150). After migrateToProjects so the
  // projects table the audit references exists.
  migrateConcurrencyControl(db)

  // Migration v22: durable start claims and recovery (#148). This extends the
  // v20 runtime and v21 admission model rather than introducing a second one.
  migrateDurableStartQueue(db)
  createAuthorizationTables(db)

  // Migration v24: the delegated GitHub issue-write ledger. New table only;
  // runs after migrateToProjects so the projects table it references exists.
  migrateIssueWrites(db)

  // Migration v25: meaningful activity, including ancestor backfill.
  migrateTaskActivity(db)

  // Migration v26: durable context for effective merge-grant attribution.
  migrateMergeGrantAttribution(db)

  // Migration v27: exact-head review evidence and invalidatable readiness.
  createPullRequestReadinessTables(db)

  // Migration v28: immutable task/agent provenance for review handoffs.
  migratePullRequestAttestationSecurity(db)

  // Migration v4: FTS5 full-text search index for similar task search
  initializeTasksFts(db)

  // Migration v10: 20x is local-only. Remove hosted-service data left by
  // older releases without losing any local work.
  removeHostedServiceData(db)

  // Migration v11: the Claude Code adapter now honours permission_mode.
  preserveClaudeCodePermissionBehaviour(db)
}

/**
 * Merge grants (#137): standing merge authority the user gave a project's
 * Captain in words they typed (src/main/merge-grants.ts). A grant is bound
 * to that message (`source_message_id`, `user_text` verbatim; one grant per
 * message, so one message can never reach several projects), has one fixed
 * action and condition, optional filters, and always an expiry.
 * `merge_grant_uses` is the audit trail: one row per merge made under a
 * grant, with the PR, the head SHA merged and the checks and protection
 * state GitHub reported at that moment. `revoked_by` says who revoked it. Both go with their project. New tables, so CREATE IF NOT EXISTS
 * covers fresh and existing DBs alike.
 */
function createMergeGrantTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS merge_grants (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      action TEXT NOT NULL DEFAULT 'merge_pr',
      condition TEXT NOT NULL DEFAULT 'checks_green_and_protection_satisfied',
      repo TEXT,
      base_branch TEXT,
      pr_numbers TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL,
      source_session_id TEXT,
      source_message_id TEXT NOT NULL,
      user_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      max_uses INTEGER,
      uses INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      revoked_at TEXT,
      revoked_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_merge_grants_project ON merge_grants(project_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_grants_source_message ON merge_grants(source, source_message_id);
    CREATE TABLE IF NOT EXISTS merge_grant_uses (
      id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL REFERENCES merge_grants(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      pr_url TEXT NOT NULL,
      pr_title TEXT NOT NULL DEFAULT '',
      base_branch TEXT NOT NULL DEFAULT '',
      head_sha TEXT NOT NULL,
      method TEXT NOT NULL,
      merge_state TEXT NOT NULL DEFAULT '',
      review_decision TEXT NOT NULL DEFAULT '',
      checks TEXT NOT NULL DEFAULT '[]',
      authorization_context TEXT NOT NULL DEFAULT '{}',
      merged_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_merge_grant_uses_grant ON merge_grant_uses(grant_id, merged_at DESC);
    CREATE TABLE IF NOT EXISTS merge_grant_reservations (
      id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL REFERENCES merge_grants(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      snapshot TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_merge_grant_reservations_pending ON merge_grant_reservations(state, project_id);

  `)
}

/**
 * Application-authenticated review attestations are deliberately separate
 * from GitHub reviews. A COMMENT never becomes an approval. Readiness rows are
 * append-only revisions: the current row has invalidated_at NULL, and every
 * material live-state change closes it before a replacement is inserted.
 */
function createPullRequestReadinessTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pr_review_handoffs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      implementation_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
      review_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
      implementation_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
      reviewer_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pr_review_handoffs_exact
      ON pr_review_handoffs(project_id, repo, pr_number, head_sha, base_sha, created_at DESC);

    CREATE TABLE IF NOT EXISTS pr_review_attestations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      implementation_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
      review_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
      implementation_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
      reviewer_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
      handoff_id TEXT NOT NULL REFERENCES pr_review_handoffs(id) ON DELETE RESTRICT,
      verdict TEXT NOT NULL CHECK (verdict IN ('CLEAN', 'CHANGES_REQUIRED')),
      summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pr_review_attestations_exact
      ON pr_review_attestations(project_id, repo, pr_number, head_sha, base_sha, created_at DESC);

    CREATE TABLE IF NOT EXISTS pr_readiness_snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      state_fingerprint TEXT NOT NULL,
      classification TEXT NOT NULL,
      reasons TEXT NOT NULL DEFAULT '[]',
      observed_state TEXT NOT NULL DEFAULT '{}',
      attestation_id TEXT REFERENCES pr_review_attestations(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      invalidated_at TEXT,
      invalidated_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pr_readiness_snapshots_exact
      ON pr_readiness_snapshots(project_id, repo, pr_number, head_sha, base_sha, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_readiness_snapshots_current
      ON pr_readiness_snapshots(project_id, repo, pr_number) WHERE invalidated_at IS NULL;
  `)
}

/** Migration v28: attestations without a signed handoff remain stored for audit but cannot satisfy readiness. */
function migratePullRequestAttestationSecurity(db: Database.Database): void {
  createPullRequestReadinessTables(db)
  const columns = new Set((db.pragma('table_info(pr_review_attestations)') as { name: string }[]).map((column) => column.name))
  if (!columns.has('handoff_id')) {
    db.exec('ALTER TABLE pr_review_attestations ADD COLUMN handoff_id TEXT REFERENCES pr_review_handoffs(id) ON DELETE RESTRICT')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_pr_review_attestations_handoff ON pr_review_attestations(handoff_id)')
}

/** Migration v19 (#137). Idempotent: `createTables()` already ran the same statements. */
function migrateMergeGrants(db: Database.Database): void {
  createMergeGrantTables(db)
  splitPullRequestEscalation(db)
}

/** Migration v26 (#159). Existing uses predate separate policy/relay context. */
function migrateMergeGrantAttribution(db: Database.Database): void {
  createMergeGrantTables(db)
  const columns = new Set((db.pragma('table_info(merge_grant_uses)') as { name: string }[]).map((column) => column.name))
  if (!columns.has('authorization_context')) {
    db.exec("ALTER TABLE merge_grant_uses ADD COLUMN authorization_context TEXT NOT NULL DEFAULT '{}'")
  }
}

/**
 * Migration v19 (#137): the escalation policy's combined "opening or merging
 * pull requests" item (`pr`) becomes two. Whatever level a project had for
 * `pr` now applies to `merge_pr`; `open_pr` gets its new default. Rows
 * without a `pr` key are untouched, so re-runs are no-ops. Unreadable
 * settings are left alone (the reader falls back to defaults).
 */
export function splitPullRequestEscalation(db: Database.Database): void {
  const cols = new Set((db.pragma('table_info(projects)') as { name: string }[]).map((c) => c.name))
  if (!cols.has('settings')) return
  const rows = db.prepare('SELECT id, settings FROM projects').all() as Array<{ id: string; settings: string | null }>
  const update = db.prepare('UPDATE projects SET settings = ? WHERE id = ?')
  for (const row of rows) {
    if (!row.settings) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(row.settings)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const next = splitLegacyPullRequestEscalation(parsed as Record<string, unknown>)
    if (next) update.run(JSON.stringify(next), row.id)
  }
}

function readSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  const value = row?.value?.trim()
  return value ? value : null
}

/**
 * Migration v15: projects.
 *
 * Adds `project_id` to tasks and task_sources, creates the Default project,
 * moves every existing task (coordinator rows included) and task source into
 * it, copies the global `github_org` / `git_provider` settings onto it and
 * seeds its repos from the distinct `tasks.repos` values. The global settings
 * stay in place, so nothing that still reads them changes behaviour.
 *
 * Why `tasks.project_id` is not declared NOT NULL: it references
 * `projects(id)`, and SQLite's ALTER TABLE only adds a REFERENCES column with
 * a NULL default — so an upgraded install cannot get NOT NULL without
 * rebuilding `tasks`, and a fresh install must match an upgraded one (see
 * database-schema-equivalence.test.ts). It is NOT NULL in effect instead:
 * - `DatabaseManager.createTask` gives a subtask its parent's project, else
 *   the requested project, else the Default project;
 * - the `tasks_assign_project` trigger applies the same rule to every other
 *   INSERT (the recurrence scheduler and the seed write raw SQL);
 * - this migration fills every existing NULL.
 *
 * Idempotent: runMigrations() re-runs on every later schema bump. The Default
 * project's settings and repos are only seeded when the row is first created,
 * so a later bump never undoes the user's edits.
 */
function migrateToProjects(db: Database.Database): void {
  const taskCols = new Set((db.pragma('table_info(tasks)') as { name: string }[]).map((c) => c.name))
  if (!taskCols.has('project_id')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id)`)
  }

  const sourceCols = new Set((db.pragma('table_info(task_sources)') as { name: string }[]).map((c) => c.name))
  if (!sourceCols.has('project_id')) {
    db.exec(`ALTER TABLE task_sources ADD COLUMN project_id TEXT REFERENCES projects(id)`)
  }

  const githubOrg = readSetting(db, 'github_org')
  const gitProvider = readSetting(db, 'git_provider')
  const now = new Date().toISOString()
  const created = db.prepare(`
    INSERT OR IGNORE INTO projects (id, name, description, git_provider, git_org, settings, sort_order, archived, created_at, updated_at)
    VALUES (?, ?, '', ?, ?, '{}', 0, 0, ?, ?)
  `).run(DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME, gitProvider, githubOrg, now, now).changes > 0
  if (created) seedDefaultProjectRepos(db, githubOrg, gitProvider, now)

  db.prepare('UPDATE tasks SET project_id = ? WHERE project_id IS NULL').run(DEFAULT_PROJECT_ID)
  db.prepare('UPDATE task_sources SET project_id = ? WHERE project_id IS NULL').run(DEFAULT_PROJECT_ID)

  ensureTaskProjectAssignment(db)
}

/**
 * Migration v16: skill scope (#74).
 *
 * Adds `skills.project_id` (NULL = global, visible to every project; a project
 * id = owned by that project). Nothing is backfilled: the column arrives NULL,
 * which is exactly "every existing skill is global", so an upgrade keeps every
 * skill available everywhere. Skill names stay unique across both scopes
 * (`idx_skills_name` is unchanged), so a task workspace can hold global and
 * project skills side by side without a SKILL.md directory collision.
 *
 * Idempotent: the column is only added when missing and the index uses
 * IF NOT EXISTS, so re-runs on later schema bumps are no-ops.
 */
function migrateSkillScope(db: Database.Database): void {
  const skillCols = new Set((db.pragma('table_info(skills)') as { name: string }[]).map((c) => c.name))
  if (!skillCols.has('project_id')) {
    db.exec(`ALTER TABLE skills ADD COLUMN project_id TEXT REFERENCES projects(id)`)
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_skills_project ON skills(project_id)`)
}

/**
 * The project index and the `tasks_assign_project` trigger. A tasks-table
 * rebuild drops both, so this runs after every rebuild and on every startup
 * (applySchema), not only inside the migration. No-op before tasks has
 * project_id.
 */
export function ensureTaskProjectAssignment(db: Database.Database): void {
  const taskCols = new Set((db.pragma('table_info(tasks)') as { name: string }[]).map((c) => c.name))
  if (!taskCols.has('project_id')) return
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)`)
  // Keep in step with DatabaseManager.createTask: parent, then recurrence template, then Default.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS tasks_assign_project AFTER INSERT ON tasks
    WHEN NEW.project_id IS NULL
    BEGIN
      UPDATE tasks SET project_id = COALESCE(
        (SELECT project_id FROM tasks WHERE id = NEW.parent_task_id),
        (SELECT project_id FROM tasks WHERE id = NEW.recurrence_parent_id),
        '${DEFAULT_PROJECT_ID}'
      ) WHERE id = NEW.id;
    END
  `)
}

/**
 * One project_repos row per distinct repo in `tasks.repos`, in first-use order.
 * Entries are `org/name` (the org may contain '/' for GitLab subgroups) or a
 * bare `name`, which gets the configured `github_org` like worktree setup does.
 * The provider is the one recorded when the repo was attached, else the
 * global default.
 */
function seedDefaultProjectRepos(db: Database.Database, githubOrg: string | null, gitProvider: string | null, now: string): void {
  const recorded = getRepoProviders({ getSetting: (key) => readSetting(db, key), setSetting: () => {} })
  const fallbackProvider = isGitProvider(gitProvider) ? gitProvider : 'github'
  const insert = db.prepare(`
    INSERT INTO project_repos (id, project_id, provider, org, name, default_branch, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
  `)
  const seen = new Set<string>()
  const rows = db.prepare('SELECT repos FROM tasks ORDER BY created_at ASC, rowid ASC').all() as { repos: string | null }[]
  for (const row of rows) {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.repos || '[]')
    } catch {
      continue
    }
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      if (typeof entry !== 'string') continue
      const repo = entry.trim().replace(/^\/+|\/+$/g, '')
      if (!repo) continue
      const slash = repo.lastIndexOf('/')
      const org = slash >= 0 ? repo.slice(0, slash) : (githubOrg ?? '')
      const name = slash >= 0 ? repo.slice(slash + 1) : repo
      const key = `${org}/${name}`.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const provider = (org && recorded[`${org}/${name}`]) || fallbackProvider
      insert.run(createId(), DEFAULT_PROJECT_ID, provider, org, name, seen.size - 1, now)
    }
  }
}

/**
 * The Claude Code adapter used to ignore `permission_mode` and always run
 * with permission checks bypassed, while the agent form showed (and saved)
 * 'ask' by default. Now that the setting is honoured, record what existing
 * Claude Code agents actually did, 'allow', so upgrading does not suddenly
 * stop every unattended run at an approval prompt. The form then shows the
 * real behaviour and the user can switch to 'ask'.
 *
 * Runs once, guarded by a settings flag, because runMigrations() runs again
 * on every later schema bump and must not undo a choice made after this.
 */
function preserveClaudeCodePermissionBehaviour(db: Database.Database): void {
  const flag = 'migration:claude-code-permission-mode'
  if (db.prepare('SELECT value FROM settings WHERE key = ?').get(flag)) return

  const agents = db.prepare('SELECT id, config FROM agents').all() as { id: string; config: string }[]
  for (const agent of agents) {
    let config: Record<string, unknown>
    try {
      config = JSON.parse(agent.config || '{}') as Record<string, unknown>
    } catch {
      continue
    }
    if (config.coding_agent !== 'claude-code' || config.permission_mode === 'allow') continue
    config.permission_mode = 'allow'
    db.prepare('UPDATE agents SET config = ? WHERE id = ?').run(JSON.stringify(config), agent.id)
    console.log(`[Database Migration] Kept automatic permissions for Claude Code agent ${agent.id}`)
  }

  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(flag, '1')
}

/** True for URLs served by the hosted service that older releases connected to. */
function isHostedServiceUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    return host === 'peakflo.ai' || host.endsWith('.peakflo.ai') ||
      parsed.pathname.replace(/\/+$/, '') === '/api/mcp/dev/mcp'
  } catch {
    return false
  }
}

/**
 * Older releases could connect to a hosted service that synced tasks,
 * agents, skills and MCP servers into this database. Keep everything the
 * user can still use locally, and remove only what cannot work without it:
 *
 * - Tasks imported from the hosted task source become ordinary local tasks
 *   before the source row goes (tasks.source_id cascades on delete).
 * - MCP servers that point at the hosted API are removed and unlinked from
 *   agents. Other synced MCP servers are kept as user servers.
 * - Synced agents and skills are kept; only their remote link ids go.
 * - Session tokens, tenant data, gateway keys and sync queues are deleted.
 *
 * Every step is idempotent, so a partial run is completed on the next start.
 */
export function removeHostedServiceData(db: Database.Database): void {
  const hostedSources = db.prepare(
    "SELECT id FROM task_sources WHERE plugin_id = 'peakflo'"
  ).all() as { id: string }[]
  for (const { id } of hostedSources) {
    db.prepare(
      "UPDATE tasks SET source_id = NULL, external_id = NULL, source = 'local' WHERE source_id = ?"
    ).run(id)
    db.prepare('DELETE FROM task_sources WHERE id = ?').run(id)
  }

  const hostedMcpIds = new Set<string>()
  const syncedMcpServers = db.prepare(
    "SELECT id, url FROM mcp_servers WHERE source = 'enterprise'"
  ).all() as { id: string; url: string | null }[]
  for (const server of syncedMcpServers) {
    if (isHostedServiceUrl(server.url)) {
      hostedMcpIds.add(server.id)
      db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(server.id)
    } else {
      db.prepare("UPDATE mcp_servers SET source = 'user' WHERE id = ?").run(server.id)
    }
  }

  const agents = db.prepare('SELECT id, config FROM agents').all() as { id: string; config: string }[]
  for (const agent of agents) {
    let config: Record<string, unknown>
    try {
      config = JSON.parse(agent.config || '{}') as Record<string, unknown>
    } catch {
      continue
    }
    let changed = false
    for (const key of ['enterprise_source', 'enterprise_agent_id']) {
      if (key in config) {
        delete config[key]
        changed = true
      }
    }
    if (Array.isArray(config.mcp_servers) && hostedMcpIds.size > 0) {
      const kept = (config.mcp_servers as Array<string | AgentMcpServerEntry>).filter((entry) =>
        !hostedMcpIds.has(typeof entry === 'string' ? entry : entry.serverId)
      )
      if (kept.length !== config.mcp_servers.length) {
        config.mcp_servers = kept
        changed = true
      }
    }
    if (changed) {
      db.prepare('UPDATE agents SET config = ? WHERE id = ?').run(JSON.stringify(config), agent.id)
    }
  }

  db.exec('DROP INDEX IF EXISTS idx_skills_enterprise_id')
  const skillColumns = new Set((db.pragma('table_info(skills)') as { name: string }[]).map((c) => c.name))
  for (const column of ['enterprise_skill_id', 'uses_at_last_sync']) {
    if (skillColumns.has(column)) db.exec(`ALTER TABLE skills DROP COLUMN ${column}`)
  }

  db.exec(`
    DELETE FROM settings
    WHERE substr(key, 1, 11) = 'enterprise_'
       OR substr(key, 1, 8) = 'workflo-'
  `)
}

/**
 * Creates (or rebuilds) the FTS5 full-text search index used by
 * `find_similar_tasks`.  The virtual table is a *content-sync* table
 * backed by `tasks`, plus triggers that keep it in sync on every
 * INSERT / UPDATE / DELETE.
 *
 * We always DROP + re-CREATE the FTS table so the trigger definitions
 * stay in sync with the current schema — this is cheap because the
 * table is tiny and only holds text columns.
 */
function initializeTasksFts(db: Database.Database): void {
  db.exec(`
    -- Drop existing FTS artifacts so we can recreate cleanly
    DROP TRIGGER IF EXISTS tasks_fts_insert;
    DROP TRIGGER IF EXISTS tasks_fts_update;
    DROP TRIGGER IF EXISTS tasks_fts_delete;
    DROP TABLE   IF EXISTS tasks_fts;

    -- Content-sync FTS5 table.  content= keeps it linked to tasks;
    -- content_rowid= maps the FTS rowid to tasks.rowid.
    --
    -- The porter stemmer reduces each word to its root at both index and
    -- query time, so "fix" also finds "fixed" and "fixing".  Without it a
    -- search only matches the exact form the author happened to type, which
    -- costs recall on the similar-task lookup.  Changing the tokenizer needs
    -- the index rebuilt against it — the DROP + re-CREATE above does that on
    -- the next launch, so existing installs upgrade with no extra migration.
    CREATE VIRTUAL TABLE tasks_fts USING fts5(
      title,
      description,
      labels,
      type,
      content='tasks',
      content_rowid='rowid',
      tokenize='porter unicode61 remove_diacritics 2'
    );

    -- Populate from existing rows
    INSERT INTO tasks_fts(rowid, title, description, labels, type)
      SELECT rowid, title, description, labels, type FROM tasks;

    -- Keep FTS in sync via triggers
    CREATE TRIGGER tasks_fts_insert AFTER INSERT ON tasks BEGIN
      INSERT INTO tasks_fts(rowid, title, description, labels, type)
        VALUES (new.rowid, new.title, new.description, new.labels, new.type);
    END;

    CREATE TRIGGER tasks_fts_update AFTER UPDATE OF title, description, labels, type ON tasks BEGIN
      INSERT INTO tasks_fts(tasks_fts, rowid, title, description, labels, type)
        VALUES ('delete', old.rowid, old.title, old.description, old.labels, old.type);
      INSERT INTO tasks_fts(rowid, title, description, labels, type)
        VALUES (new.rowid, new.title, new.description, new.labels, new.type);
    END;

    CREATE TRIGGER tasks_fts_delete AFTER DELETE ON tasks BEGIN
      INSERT INTO tasks_fts(tasks_fts, rowid, title, description, labels, type)
        VALUES ('delete', old.rowid, old.title, old.description, old.labels, old.type);
    END;
  `)
}

function migrateInlineMcpServers(db: Database.Database): void {
  const agents = db.prepare('SELECT id, config FROM agents').all() as { id: string; config: string }[]
  const now = new Date().toISOString()

  for (const agent of agents) {
    let config: Record<string, unknown>
    try { config = JSON.parse(agent.config) as Record<string, unknown> } catch { continue }

    if (!Array.isArray(config.mcp_servers) || config.mcp_servers.length === 0) continue
    // Already migrated if first element is a string (ID) or an AgentMcpServerEntry object
    const first = config.mcp_servers[0]
    if (typeof first === 'string' || (typeof first === 'object' && first.serverId)) continue

    const ids: string[] = []
    for (const srv of config.mcp_servers as McpServerConfigRecord[]) {
      const existing = db.prepare(
        'SELECT id FROM mcp_servers WHERE name = ? AND command = ?'
      ).get(srv.name, srv.command) as { id: string } | undefined

      if (existing) {
        ids.push(existing.id)
      } else {
        const id = createId()
        db.prepare(
          'INSERT INTO mcp_servers (id, name, command, args, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(id, srv.name, srv.command, JSON.stringify(srv.args || []), now, now)
        ids.push(id)
      }
    }

    config.mcp_servers = ids
    db.prepare('UPDATE agents SET config = ? WHERE id = ?').run(JSON.stringify(config), agent.id)
  }
}
