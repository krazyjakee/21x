import type Database from 'better-sqlite3'

/** Schema v33 keeps table creation independent of provider runtime ownership. */
export function createProviderRecoveryTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_provider_recovery (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    next_retry_at INTEGER,
    record TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS idx_provider_recovery_pending ON agent_provider_recovery(state, next_retry_at)`)
}
