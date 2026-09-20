import type Database from 'better-sqlite3'

/** Append-only evidence. Revocation is a separate event, never an edit. */
export function createAuthorizationTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS authorization_nodes (
      id TEXT PRIMARY KEY, parent_id TEXT REFERENCES authorization_nodes(id),
      root_id TEXT NOT NULL, message_id TEXT, correlation_id TEXT UNIQUE,
      body TEXT NOT NULL, hash TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS authorization_origin ON authorization_nodes(message_id) WHERE parent_id IS NULL;
    CREATE TABLE IF NOT EXISTS authorization_revocations (
      node_id TEXT PRIMARY KEY REFERENCES authorization_nodes(id), at INTEGER NOT NULL, reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS authorization_transports (
      delivery_key TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES authorization_nodes(id),
      task_id TEXT NOT NULL, payload_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS authorization_dispatches (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, delivery_key TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL, node_id TEXT REFERENCES authorization_nodes(id), payload_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS authorization_task_bindings (
      task_id TEXT PRIMARY KEY, dispatch_seq INTEGER NOT NULL, node_id TEXT REFERENCES authorization_nodes(id)
    );
  `)
  for (const table of ['authorization_nodes', 'authorization_revocations', 'authorization_transports', 'authorization_dispatches']) {
    for (const operation of ['UPDATE', 'DELETE']) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${operation.toLowerCase()}
        BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'Authorization evidence is immutable'); END`)
    }
  }
}
