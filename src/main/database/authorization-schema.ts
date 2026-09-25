import type Database from 'better-sqlite3'

/**
 * Schema 31 removed the human-authorization chain (schema 23–30). Its tables
 * are dropped children first, so foreign keys never see a missing parent.
 */
export function dropAuthorizationTables(db: Database.Database): void {
  for (const table of ['authorization_transports', 'authorization_dispatches', 'authorization_task_bindings', 'authorization_revocations', 'authorization_nodes']) {
    db.exec(`DROP TABLE IF EXISTS ${table}`)
  }
}
