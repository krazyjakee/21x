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

/** Schema 32 removed merge grants (schema 19 and 26). Children first, as above. */
export function dropMergeGrantTables(db: Database.Database): void {
  for (const table of ['merge_grant_reservations', 'merge_grant_uses', 'merge_grants']) {
    db.exec(`DROP TABLE IF EXISTS ${table}`)
  }
}

/**
 * Schema 32 also removed the escalation policy: the `escalation` and
 * `merge_grants` blocks of projects.settings are deleted. Unreadable
 * settings are left alone.
 */
export function removeProjectPermissionSettings(db: Database.Database): void {
  const cols = new Set((db.pragma('table_info(projects)') as { name: string }[]).map((c) => c.name))
  if (!cols.has('settings')) return
  const rows = db.prepare('SELECT id, settings FROM projects').all() as Array<{ id: string; settings: string | null }>
  const update = db.prepare('UPDATE projects SET settings = ? WHERE id = ?')
  for (const row of rows) {
    if (!row.settings) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(row.settings)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const settings = parsed as Record<string, unknown>
    if (!('escalation' in settings) && !('merge_grants' in settings)) continue
    const rest = { ...settings }
    delete rest.escalation
    delete rest.merge_grants
    update.run(JSON.stringify(rest), row.id)
  }
}
