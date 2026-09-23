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
      task_id TEXT PRIMARY KEY, dispatch_seq INTEGER NOT NULL,
      node_id TEXT REFERENCES authorization_nodes(id),
      assignment_node_id TEXT REFERENCES authorization_nodes(id),
      supersession_node_id TEXT REFERENCES authorization_nodes(id)
    );
  `)
  const bindingColumns = db.prepare('PRAGMA table_info(authorization_task_bindings)').all() as Array<{ name: string }>
  if (!bindingColumns.some((column) => column.name === 'assignment_node_id')) {
    db.exec('ALTER TABLE authorization_task_bindings ADD COLUMN assignment_node_id TEXT REFERENCES authorization_nodes(id)')
  }
  if (!bindingColumns.some((column) => column.name === 'supersession_node_id')) {
    db.exec('ALTER TABLE authorization_task_bindings ADD COLUMN supersession_node_id TEXT REFERENCES authorization_nodes(id)')
    // Existing installs may already have an accepted human node overriding a
    // delegated assignment. Preserve that fail-closed state across migration.
    db.exec(`
      UPDATE authorization_task_bindings
      SET supersession_node_id = node_id
      WHERE assignment_node_id IS NOT NULL
        AND node_id IS NOT NULL
        AND node_id IS NOT assignment_node_id
    `)
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS authorization_assignment_no_replace
    BEFORE UPDATE OF assignment_node_id ON authorization_task_bindings
    WHEN OLD.assignment_node_id IS NOT NULL AND NEW.assignment_node_id IS NOT OLD.assignment_node_id
    BEGIN SELECT RAISE(ABORT, 'Assigned authorization lineage is immutable'); END`)
  for (const table of ['authorization_nodes', 'authorization_revocations', 'authorization_transports', 'authorization_dispatches']) {
    for (const operation of ['UPDATE', 'DELETE']) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${operation.toLowerCase()}
        BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'Authorization evidence is immutable'); END`)
    }
  }
}
