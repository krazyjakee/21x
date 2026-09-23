import type Database from 'better-sqlite3'

/**
 * Migration 32: the managed-session ledger (managed sessions B3, #99).
 *
 * The epic's proposal numbered this migration 18. 18 was skipped on purpose
 * for the unlanded `feat/commander-on-agent-sessions` branch, and main had
 * reached 30 (31 is B1's `session_usage`), so the ledger takes the next free
 * version. See docs/managed-sessions.md.
 *
 * - `session_generations`: one backend conversation of an owner (a Commander
 *   session, a Captain or a task agent). `n` counts from 1 per owner. At most
 *   one generation per owner is open (`ended_at IS NULL`, enforced by a
 *   partial unique index). `backend_session_id` is a cache of the backend's
 *   own id (a Claude Code session, a Codex thread, …); `tasks.session_id`
 *   stays its mirror.
 * - `session_turns`: one event delivered to the owner and the turn it ran.
 *   `dedupe_key` is UNIQUE per owner, so an event delivered twice is recorded
 *   once. `seq` orders the owner's turns across generations (never the
 *   mutable `created_at`). `runner_id` is the process that ran the turn:
 *   startup recovery marks another process's `queued`/`running` turns
 *   `interrupted` and closes their open tool calls (`tool_calls`, a JSON
 *   array). `usage_keys` lists the `session_usage.turn_key`s whose figures
 *   the token columns sum.
 * - `session_summaries`: a fold, a handoff or a failed summary attempt of a
 *   generation, UNIQUE per (generation, dedupe_key).
 *
 * No foreign key to `tasks` or `commander_sessions`: the ledger is an audit
 * record that outlives what it measured, like `session_usage`. New tables
 * only, so `CREATE TABLE IF NOT EXISTS` covers fresh and upgraded databases.
 */
export function createSessionLedgerTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_generations (
      id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL CHECK (owner_kind IN ('commander', 'captain', 'task')),
      owner_id TEXT NOT NULL,
      n INTEGER NOT NULL CHECK (n >= 1),
      engine TEXT NOT NULL CHECK (engine IN ('chat', 'adapter')),
      provider TEXT,
      model TEXT,
      backend_session_id TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      end_reason TEXT CHECK (end_reason IS NULL OR end_reason IN ('rollover', 'lost', 'replaced', 'closed')),
      seed_handoff_id TEXT,
      UNIQUE (owner_kind, owner_id, n)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_generations_open
      ON session_generations(owner_kind, owner_id) WHERE ended_at IS NULL;

    CREATE TABLE IF NOT EXISTS session_turns (
      id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL CHECK (owner_kind IN ('commander', 'captain', 'task')),
      owner_id TEXT NOT NULL,
      generation_id TEXT NOT NULL REFERENCES session_generations(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL CHECK (seq >= 1),
      trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('user', 'report', 'wake', 'subtask_done', 'schedule', 'nudge', 'start', 'system')),
      dedupe_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'interrupted', 'dropped', 'coalesced')),
      coalesced_into TEXT REFERENCES session_turns(id) ON DELETE SET NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      runner_id TEXT,
      tool_calls TEXT NOT NULL DEFAULT '[]',
      usage_keys TEXT NOT NULL DEFAULT '[]',
      input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
      output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
      context_tokens_after INTEGER CHECK (context_tokens_after IS NULL OR context_tokens_after >= 0),
      usage_source TEXT CHECK (usage_source IS NULL OR usage_source IN ('reported', 'estimated')),
      stop_reason TEXT,
      error_kind TEXT,
      error_detail TEXT,
      queued_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER,
      updated_at INTEGER NOT NULL,
      UNIQUE (owner_kind, owner_id, dedupe_key),
      UNIQUE (owner_kind, owner_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_session_turns_generation ON session_turns(generation_id, seq);
    CREATE INDEX IF NOT EXISTS idx_session_turns_unfinished
      ON session_turns(status) WHERE status IN ('queued', 'running');

    CREATE TABLE IF NOT EXISTS session_summaries (
      id TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL REFERENCES session_generations(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('fold', 'handoff', 'failed')),
      status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('pending', 'done', 'degraded')),
      dedupe_key TEXT NOT NULL,
      covers_through_ref TEXT,
      content_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (generation_id, dedupe_key)
    );
    CREATE INDEX IF NOT EXISTS idx_session_summaries_generation ON session_summaries(generation_id, created_at);
  `)
}

/** Migration 32 is new tables only; `createTables()` already creates them idempotently. */
export function migrateSessionLedger(db: Database.Database): void {
  createSessionLedgerTables(db)
}
