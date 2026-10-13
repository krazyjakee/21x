import type Database from 'better-sqlite3'

/** v36: resumable rollover intent. Existing conversation rows stay intact. */
export function createSessionHandoffTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_handoffs (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    engine TEXT NOT NULL CHECK(engine IN ('chat', 'adapter')),
    generation_key TEXT NOT NULL,
    next_generation_key TEXT NOT NULL,
    model TEXT NOT NULL,
    source TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending', 'summary', 'memory', 'creating', 'created', 'creation_unconfirmed', 'completed')),
    summary TEXT,
    summary_source TEXT CHECK(summary_source IN ('model', 'fallback')),
    target_backend_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(owner_id, generation_key)
  );
  CREATE INDEX IF NOT EXISTS idx_session_handoff_pending ON session_handoffs(state, owner_id);`)
}
