import type Database from 'better-sqlite3'

/**
 * Migration 22 (#148): durable, generation-fenced agent start admission.
 *
 * One row is retained per task so a start keeps a stable identity across
 * retries and restarts. Active states are claimed with a short lease; the
 * generation makes every later start/ack conditional on the claim that made
 * it. Fairness state is durable too, so a restart cannot put a busy project at
 * the front of every round.
 */
export function createDurableStartQueueTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_start_queue (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      workspace_dir TEXT,
      skip_initial_prompt INTEGER NOT NULL DEFAULT 0,
      priority TEXT NOT NULL DEFAULT 'medium',
      fifo_seq INTEGER NOT NULL UNIQUE,
      dependency_reason TEXT,
      admission_reason TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued'
        CHECK (state IN ('queued', 'retrying', 'claimed', 'starting', 'started', 'recovered', 'failed', 'cancelled')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER,
      generation INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at INTEGER,
      session_id TEXT,
      recovery_cause TEXT,
      recovery_action TEXT,
      recovery_result TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      queued_at INTEGER NOT NULL,
      claimed_at INTEGER,
      started_at INTEGER,
      acknowledged_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_start_queue_dispatch
      ON agent_start_queue(state, next_retry_at, priority, fifo_seq);
    CREATE INDEX IF NOT EXISTS idx_agent_start_queue_project
      ON agent_start_queue(project_id, state, fifo_seq);
    CREATE INDEX IF NOT EXISTS idx_agent_start_queue_lease
      ON agent_start_queue(state, lease_expires_at);

    CREATE TABLE IF NOT EXISTS agent_start_queue_fairness (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      served_seq INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
}

export function migrateDurableStartQueue(db: Database.Database): void {
  createDurableStartQueueTables(db)
}
