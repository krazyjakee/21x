/**
 * Migration 21: Captain-managed concurrency under a user-set hard cap (#150).
 *
 *  - `concurrency_audit`: one row per change of a working level, a pin or
 *    Captain control, with who made it and why. It is the project's
 *    concurrency activity feed; every row also has a line in the status
 *    journal (src/main/concurrency-control.ts).
 *  - `task_touches`: the files a task declares it will change (the
 *    "touches" hint), used to serialise tickets that share hot files.
 *  - every agent without a `config.concurrency_cap` gets
 *    min(existing max_parallel_sessions, 5) (shared/concurrency.ts,
 *    defaultHardCap). Only a missing cap is filled, so a later re-run of
 *    runMigrations never undoes a cap the user set.
 *
 * New tables, so CREATE IF NOT EXISTS covers fresh and existing databases.
 * Both go with their project or task.
 */
import type Database from 'better-sqlite3'
import { defaultHardCap } from '../../shared/concurrency'

export function createConcurrencyTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS concurrency_audit (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      previous_level INTEGER,
      level INTEGER,
      cap INTEGER NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_concurrency_audit_project_created
      ON concurrency_audit(project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS task_touches (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      paths TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );
  `)
}

/** Fills `config.concurrency_cap` on agents that have none. Returns how many changed. */
export function backfillAgentHardCaps(db: Database.Database): number {
  const agents = db.prepare('SELECT id, config FROM agents').all() as { id: string; config: string }[]
  const update = db.prepare('UPDATE agents SET config = ? WHERE id = ?')
  let changed = 0
  for (const agent of agents) {
    let config: Record<string, unknown>
    try {
      config = JSON.parse(agent.config || '{}') as Record<string, unknown>
    } catch {
      continue
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) continue
    const existing = Number(config.concurrency_cap)
    if (Number.isFinite(existing) && existing >= 1) continue
    config.concurrency_cap = defaultHardCap(config.max_parallel_sessions)
    update.run(JSON.stringify(config), agent.id)
    changed += 1
    console.log(`[Database Migration] Agent ${agent.id}: hard cap ${config.concurrency_cap as number}`)
  }
  return changed
}

export function migrateConcurrencyControl(db: Database.Database): void {
  createConcurrencyTables(db)
  backfillAgentHardCaps(db)
}
