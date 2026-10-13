import type Database from 'better-sqlite3'

/** Schema 35: voice attribution and durable exact action reversals. DDL only. */
export function migrateCommanderActions(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(commander_messages)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'input_mode')) {
    db.exec("ALTER TABLE commander_messages ADD COLUMN input_mode TEXT CHECK(input_mode IS NULL OR input_mode IN ('voice', 'typed'))")
  }
  createCommanderActionTables(db)
}

export function createCommanderActionTables(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS commander_actions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    target TEXT NOT NULL,
    changes TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    undone_at INTEGER,
    undone_message_id TEXT,
    UNIQUE(session_id, tool_call_id)
  );
  CREATE INDEX IF NOT EXISTS commander_actions_session ON commander_actions(session_id, created_at);`)
}
