import type Database from 'better-sqlite3'

/**
 * Migration 31: per-turn token usage (managed sessions B1, #97).
 *
 * One row per turn of a Commander session, a Captain or a task agent: what
 * the model read and wrote, how large its context was, and whether each
 * figure was reported by the backend or estimated by 21x (`usage_source`).
 * It is instrumentation only; nothing reads it to change behaviour yet.
 *
 * - `owner_kind` / `owner_id`: whose conversation it is (a Commander session
 *   id, or the task id of a Captain or task agent). No foreign key: usage is an
 *   audit record that outlives the task or session it was measured for.
 * - `turn_key` identifies the turn within its owner (the ChatRuntime turn id,
 *   a Claude Code result, a Codex turn id, an opencode assistant message id).
 *   It is unique per owner, so a figure seen twice (a poll replay, a
 *   cumulative update) replaces the row instead of adding another.
 * - `context_tokens` is the prompt size of the turn's last model call: what
 *   the model had in context, the figure a budget compares to
 *   `context_window`. `window_source` says where the window came from
 *   (model-windows.ts).
 * - `estimated_prompt_tokens` is 21x's estimate of a prompt whose size was
 *   also reported; the pair calibrates later estimates (token-estimator.ts).
 *
 * Later batches add `session_generations` / `session_turns` and may move
 * these rows under a generation; the table is additive, so a downgrade
 * ignores it.
 */
export function createSessionUsageTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_usage (
      id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL CHECK (owner_kind IN ('commander', 'captain', 'task')),
      owner_id TEXT NOT NULL,
      session_id TEXT,
      turn_key TEXT NOT NULL,
      engine TEXT NOT NULL CHECK (engine IN ('chat', 'adapter')),
      backend TEXT NOT NULL,
      model TEXT,
      usage_source TEXT NOT NULL CHECK (usage_source IN ('reported', 'estimated')),
      input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
      output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
      cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
      cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
      reasoning_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
      context_tokens INTEGER CHECK (context_tokens IS NULL OR context_tokens >= 0),
      context_source TEXT CHECK (context_source IS NULL OR context_source IN ('reported', 'estimated')),
      context_window INTEGER CHECK (context_window IS NULL OR context_window > 0),
      window_source TEXT CHECK (window_source IS NULL OR window_source IN ('reported', 'override', 'known', 'default')),
      estimated_prompt_tokens INTEGER CHECK (estimated_prompt_tokens IS NULL OR estimated_prompt_tokens >= 0),
      model_calls INTEGER CHECK (model_calls IS NULL OR model_calls >= 0),
      cost_usd REAL,
      stop_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (owner_kind, owner_id, turn_key)
    );
    CREATE INDEX IF NOT EXISTS idx_session_usage_owner_created
      ON session_usage(owner_kind, owner_id, created_at DESC);
  `)
}

/** Migration 31 is a new table only; `createTables()` already creates it idempotently. */
export function migrateSessionUsage(db: Database.Database): void {
  createSessionUsageTables(db)
}
