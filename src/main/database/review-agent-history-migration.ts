import type Database from 'better-sqlite3'

const TABLES = ['pr_review_handoffs', 'pr_review_attestations'] as const

/**
 * Migration 39: PR review records stop restricting agent deletion.
 *
 * `implementation_agent_id` and `reviewer_agent_id` were `ON DELETE RESTRICT`,
 * so any agent that had ever reviewed a PR failed to delete with a raw foreign
 * key error. The rows are audit evidence and must survive: dropping one could
 * lift a CHANGES_REQUIRED block on a merge. So the ids stay as the record of
 * who signed, as plain text; nothing resolves them back to an agent, and the
 * independence check compares the two ids, which still works once one is gone.
 *
 * SQLite cannot drop a foreign key in place. The new table is derived from the
 * stored DDL rather than a copy of it, because older databases gained
 * `handoff_id` by ALTER and hold their columns in a different order.
 */
export function migrateReviewAgentHistory(db: Database.Database): void {
  const restricted = TABLES.filter(table => (db.pragma(`foreign_key_list(${table})`) as Array<{ table: string }>).some(key => key.table === 'agents'))
  if (!restricted.length) return
  // Must stay outside the transaction: this pragma is a no-op inside one, and
  // with keys on the DROP below would run the RESTRICT from attestations.
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.transaction(() => {
      for (const table of restricted) {
        const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string }
        const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(table) as Array<{ sql: string }>
        const rebuilt = `${table}_v39`
        db.exec(sql.replace(table, rebuilt).replace(/\s+REFERENCES\s+"?agents"?\s*\(\s*id\s*\)\s+ON\s+DELETE\s+RESTRICT/gi, ''))
        db.exec(`INSERT INTO ${rebuilt} SELECT * FROM ${table}`)
        db.exec(`DROP TABLE ${table}`)
        db.exec(`ALTER TABLE ${rebuilt} RENAME TO ${table}`)
        for (const index of indexes) db.exec(index.sql)
      }
    })()
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}
