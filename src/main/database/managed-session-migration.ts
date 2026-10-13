import type Database from 'better-sqlite3'

/** v34: observational session ledger and token instrumentation only. */
export function createManagedSessionTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_generations (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, engine TEXT NOT NULL,
      generation_key TEXT NOT NULL, process_run_id TEXT NOT NULL,
      backend_id TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(owner_id, generation_key)
    );
    CREATE INDEX IF NOT EXISTS idx_session_generation_owner ON session_generations(owner_id, created_at);
    CREATE TABLE IF NOT EXISTS session_turns (
      id TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES session_generations(id),
      owner_id TEXT NOT NULL, turn_key TEXT NOT NULL, kind TEXT NOT NULL,
      state TEXT NOT NULL, stop_reason TEXT, input TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL, finished_at INTEGER, UNIQUE(generation_id, turn_key)
    );
    CREATE INDEX IF NOT EXISTS idx_session_turn_running ON session_turns(state, owner_id);
    CREATE TABLE IF NOT EXISTS session_summaries (
      id TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES session_generations(id),
      owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
      last_folded_id TEXT, content TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_event_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE, generation_key TEXT NOT NULL,
      engine TEXT NOT NULL, backend_id TEXT, process_run_id TEXT NOT NULL, turn_key TEXT, event_type TEXT NOT NULL,
      payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      claim_owner TEXT, created_at INTEGER NOT NULL, processed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_session_inbox_pending ON session_event_inbox(state, owner_id, id);
    CREATE TABLE IF NOT EXISTS session_lifecycle_events (
      idempotency_key TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES session_generations(id),
      owner_id TEXT NOT NULL, turn_key TEXT, event_type TEXT NOT NULL,
      payload TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_turn_usage (
      turn_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, context_window INTEGER,
      process_run_id TEXT NOT NULL, state TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      input_source TEXT NOT NULL DEFAULT 'estimated', output_source TEXT NOT NULL DEFAULT 'estimated',
      estimated_input_tokens INTEGER NOT NULL DEFAULT 0, estimated_output_tokens INTEGER NOT NULL DEFAULT 0,
      reported_input_tokens INTEGER, reported_output_tokens INTEGER,
      started_at INTEGER NOT NULL, finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_session_usage_owner ON session_turn_usage(owner_id, started_at);
    CREATE TABLE IF NOT EXISTS session_usage_calls (
      turn_id TEXT NOT NULL REFERENCES session_turn_usage(turn_id), call_index INTEGER NOT NULL,
      input_chars INTEGER NOT NULL, output_chars INTEGER NOT NULL DEFAULT 0,
      estimated_input_tokens INTEGER NOT NULL, estimated_output_tokens INTEGER NOT NULL DEFAULT 0,
      reported_input_tokens INTEGER, reported_output_tokens INTEGER,
      state TEXT NOT NULL, PRIMARY KEY(turn_id, call_index)
    );
    CREATE TABLE IF NOT EXISTS session_token_calibration (
      model TEXT PRIMARY KEY, input_chars INTEGER NOT NULL, input_tokens INTEGER NOT NULL,
      output_chars INTEGER NOT NULL, output_tokens INTEGER NOT NULL
    );
  `)
}
