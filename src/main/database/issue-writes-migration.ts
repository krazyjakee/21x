import type Database from 'better-sqlite3'

/**
 * Migration 23: the delegated GitHub issue-write ledger.
 *
 * One row per external issue write 21x attempts, claimed *before* GitHub is
 * called and settled afterwards. The row is both the audit record and the
 * idempotency claim, so the two can never disagree:
 *
 * - `idempotency_key` is UNIQUE. It is derived from durable things only
 *   (project, repository, action, target, task, payload hash), so the retry of
 *   an interrupted write recomputes the same key across a restart and finds
 *   its own claim instead of filing a second issue.
 * - The provenance columns record who authorized the write: the kind of
 *   originating human instruction, its stored message id and session, a hash
 *   of the person's words (never the words themselves on GitHub's side), when
 *   they wrote them, and the Commander correlation the request was relayed
 *   under. `captain_task_id` / `captain_session_id` say who carried it out.
 * - `status` is `reserved` while an attempt holds the lease, then `succeeded`,
 *   `failed` (GitHub certainly refused) or `unresolved` (the answer was never
 *   seen; the write may have landed). An expired lease becomes `unresolved`,
 *   never free — that is what stops a crash from duplicating an issue.
 *
 * Rows survive their project being archived but go with it when it is deleted,
 * like every other project-scoped audit table.
 */
export function createIssueWriteTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue_writes (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      captain_task_id TEXT,
      captain_session_id TEXT,
      task_id TEXT,
      repo TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('create_issue', 'update_issue', 'link_issue')),
      target_number INTEGER,
      payload_hash TEXT NOT NULL,
      origin_kind TEXT NOT NULL,
      origin_message_id TEXT NOT NULL,
      origin_session_id TEXT,
      origin_text_hash TEXT NOT NULL,
      origin_excerpt TEXT NOT NULL DEFAULT '',
      origin_authored_at TEXT NOT NULL,
      correlation_id TEXT,
      status TEXT NOT NULL DEFAULT 'reserved'
        CHECK (status IN ('reserved', 'succeeded', 'failed', 'unresolved')),
      external_url TEXT,
      external_number INTEGER,
      external_result TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 1,
      lease_expires_at INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      settled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_issue_writes_project
      ON issue_writes(project_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_issue_writes_task
      ON issue_writes(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_issue_writes_open
      ON issue_writes(status, project_id);
    CREATE INDEX IF NOT EXISTS idx_issue_writes_correlation
      ON issue_writes(correlation_id) WHERE correlation_id IS NOT NULL;
  `)
}

export function migrateIssueWrites(db: Database.Database): void {
  createIssueWriteTables(db)
}
