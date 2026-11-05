import type Database from 'better-sqlite3'

const TABLES = ['pr_review_handoffs', 'pr_review_attestations']
const AGENT_REFERENCE = /\s+REFERENCES agents\(id\) ON DELETE RESTRICT/g

/**
 * Migration v39: a PR review no longer holds its agents in place.
 *
 * Both agent ids were `ON DELETE RESTRICT`, so one finished review made an agent
 * impossible to delete. They are evidence of who did the work, compared as text
 * and bound to an exact commit, and nothing reads the agent row through them, so
 * they stay as plain ids that outlive the agent. References to tasks are kept.
 *
 * Each table is rebuilt from its own stored definition, not a copy of today's:
 * installed tables differ from fresh ones, and older attestations have no handoff.
 */
export function dropReviewAgentReferences(db: Database.Database): void {
  const definition = (table: string): string | undefined =>
    (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined)?.sql
  const stale = TABLES.filter((table) => definition(table)?.includes('REFERENCES agents(id)'))
  if (stale.length === 0) return

  // Dropping a table runs an implicit DELETE, which RESTRICT and SET NULL
  // references from other tables would act on. This pragma does nothing inside
  // a transaction, so it is set before the transaction opens.
  db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      for (const table of stale) {
        const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(table) as { sql: string }[]
        const columns = (db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name).join(', ')
        db.exec(`DROP TABLE IF EXISTS ${table}_new`)
        db.exec(definition(table)!.replace(AGENT_REFERENCE, '').replace(table, `${table}_new`))
        db.exec(`INSERT INTO ${table}_new (${columns}) SELECT ${columns} FROM ${table}`)
        db.exec(`DROP TABLE ${table}`)
        db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`)
        for (const index of indexes) db.exec(index.sql)
      }
    })()
  } finally {
    db.pragma('foreign_keys = ON')
  }
}
