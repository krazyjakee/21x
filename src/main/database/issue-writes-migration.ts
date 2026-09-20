import type Database from 'better-sqlite3'

/**
 * Migration 24: the delegated GitHub issue-write ledger.
 *
 * One row per external issue write 21x attempts, claimed *before* GitHub is
 * called and settled afterwards. The row is both the audit record and the
 * idempotency claim, so the two can never disagree:
 *
 * - `idempotency_key` is UNIQUE. A default key is derived from durable things
 *   (project, repository, action, target, task, payload hash); a caller key is
 *   a project-scoped name. Either kind is immutably bound to the complete
 *   operation and trusted authorization origin, so an exact retry finds its
 *   own claim while a rebinding is refused. A claim never expires: a
 *   `succeeded` row deduplicates its key for good, which is the point.
 * - `payload_hash` is the hash of what was asked for, and `payload_fields`
 *   names which fields were in it. Reconciliation needs both: to decide
 *   whether an interrupted update landed it has to hash GitHub's *current*
 *   state in exactly the shape the request had, and a hash alone cannot say
 *   what that shape was.
 * - The provenance columns record who authorized the write: the kind of
 *   originating human instruction, its stored message id and session, a hash
 *   of the person's words (never the words themselves on GitHub's side), when
 *   they wrote them, and the Commander correlation the request was relayed
 *   under. `captain_task_id` / `captain_session_id` say who carried it out.
 * - `status` is `reserved` while an attempt holds the lease, then `succeeded`,
 *   `failed` (GitHub certainly refused, so nothing was written) or
 *   `unresolved` (the answer was never seen; the write may have landed). An
 *   expired lease becomes `unresolved`, never free — that is what stops a
 *   crash from duplicating an issue.
 * - `attempt_epoch` is the identity of the current attempt. Every transition
 *   into `reserved`, and every lease expiry, bumps it, and a settle must quote
 *   the epoch it was issued. A stalled attempt that wakes up after its lease
 *   was taken away therefore cannot resolve a row a newer attempt owns — the
 *   same protection `merge_grant_reservations` gets from minting a fresh
 *   reservation id per attempt.
 * - `effects_applied_at` fences the local half of success. The task attachment,
 *   journal entry and marker commit in one transaction; startup can therefore
 *   replay an interrupted local effect without duplicating it.
 *
 * The CHECK constraints below encode the invariants the code relies on, so a
 * row that would be invisible to reconciliation (a `reserved` row with no
 * lease, an `update_issue` with no target) or meaningless to a person (a
 * `succeeded` row with no URL) cannot exist even if a future writer is wrong.
 *
 * Rows survive their project being archived but go with it when it is deleted,
 * like every other project-scoped audit table. `task_id` deliberately carries
 * no foreign key: the audit outlives the task it was filed for.
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
      target_number INTEGER CHECK (target_number IS NULL OR target_number > 0),
      payload_hash TEXT NOT NULL,
      payload_fields TEXT NOT NULL DEFAULT '[]',
      origin_kind TEXT NOT NULL CHECK (origin_kind IN ('project_chat', 'commander_relay', 'user_task_instruction')),
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
      attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts > 0),
      attempt_epoch INTEGER NOT NULL DEFAULT 1 CHECK (attempt_epoch > 0),
      lease_expires_at INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      settled_at TEXT,
      effects_applied_at TEXT,

      -- A create names no target; updates and local links always do. A row
      -- that broke this would either target the wrong issue or be impossible
      -- to reconcile.
      CHECK ((action = 'create_issue') = (target_number IS NULL)),
      -- A reserved row with no lease could never go stale, so nothing would
      -- ever ask GitHub about it.
      CHECK (status != 'reserved' OR lease_expires_at IS NOT NULL),
      -- A success nobody can point at is not a success; it is unresolved.
      CHECK (status != 'succeeded' OR external_url IS NOT NULL),
      -- Terminal rows are stamped; open ones are not.
      CHECK ((status IN ('reserved', 'unresolved')) = (settled_at IS NULL)),
      -- Local effects are applied only after GitHub/local-link success. Their
      -- timestamp is the durable exactly-once marker for task links+journal.
      CHECK (effects_applied_at IS NULL OR status = 'succeeded')
    );
    CREATE INDEX IF NOT EXISTS idx_issue_writes_project
      ON issue_writes(project_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_issue_writes_task
      ON issue_writes(task_id, created_at DESC);
    -- Reconciliation asks "which of this project's writes are still open?", so
    -- the project leads and the two open statuses get their own partial index.
    CREATE INDEX IF NOT EXISTS idx_issue_writes_open
      ON issue_writes(project_id, status) WHERE status IN ('reserved', 'unresolved');
    CREATE INDEX IF NOT EXISTS idx_issue_writes_correlation
      ON issue_writes(correlation_id) WHERE correlation_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_issue_writes_pending_effects
      ON issue_writes(project_id, created_at)
      WHERE status = 'succeeded' AND effects_applied_at IS NULL;
  `)
}

export function migrateIssueWrites(db: Database.Database): void {
  createIssueWriteTables(db)
}
