# Database Migrations

All schema migrations live in `src/main/database/schema.ts` as plain functions over the raw SQLite handle; `DatabaseManager.initialize()` applies them through `applySchema()`. Tests build their schema from the same functions (`test/helpers/db-test-helper.ts`).

## Version 20 — managed runtime and durable delivery

Version 20 adds `managed_agent_runtimes` and `delivery_outbox`. Runtime rows
persist Captain startup/switch generations, verified health, deadlines,
last-known-good rollback information and visible failure causes. Delivery rows
persist stable idempotency keys, claim leases, acknowledgements, deadlines and
terminal errors for typed agent messages, `ask_captain` requests and Captain
reports. Both tables are created idempotently, so fresh and upgraded databases
have the same schema; no legacy rows are rewritten or discarded.

SQLite transactions provide exactly-once application effects (one transcript
message/report for one idempotency key). Agent-provider transports do not offer
transactional acknowledgement, so the handoff itself is at-least-once after a
crash; the outbox and transcript/report inbox suppress duplicate application
effects during reconciliation.

## How it works

1. `createTables()` defines the canonical schema for **new** databases (`CREATE TABLE IF NOT EXISTS`).
2. `runMigrations()` upgrades **existing** databases by adding columns, rebuilding tables, etc.
3. `SCHEMA_VERSION` (integer at the top of the file) gates whether `runMigrations()` runs. On startup the stored `__schema_version` from the `settings` table is compared to `SCHEMA_VERSION` — migrations only run when stored < current.

## Adding a new column to the `tasks` table

1. **Add the column to `createTables()`** — this covers fresh installs.
2. **Add the column to `rebuildTasksTable()`** — this covers users whose table gets rebuilt during migration. Add it to the `CREATE TABLE tasks_new (...)` definition inside the method.
3. **Add an ALTER migration in `runMigrations()`** at the bottom of the tasks section:
   ```ts
   if (!columnNames.has('my_new_column')) {
     this.db.exec(`ALTER TABLE tasks ADD COLUMN my_new_column TEXT DEFAULT NULL`)
   }
   ```
4. **Bump `SCHEMA_VERSION`** by 1 — otherwise existing users with the old version stored will skip `runMigrations()` entirely.

### Rows that must survive every migration

`tasks.role` marks coordinator rows (the Captain, `role = 'captain'`).
The column is declared in all three places above and `seedCaptainTasks()`
runs on every startup, so a returning user gets the row exactly once. Never
default `role` to anything but `'task'`: an old row with a missing column must
stay a user task.

### Every task belongs to a project

Migration 15 (`migrateToProjects()`) adds `project_id` to `tasks` and
`task_sources`, creates the Default project (`DEFAULT_PROJECT_ID` in
`src/shared/projects.ts`), moves every existing row into it (coordinator rows
included), copies the global `github_org` / `git_provider` settings onto it and
seeds `project_repos` from the distinct `tasks.repos` values (`org/name`, or a
bare `name` resolved with `github_org`). The settings and repos are seeded only
when the Default row is first inserted, so later re-runs never undo user edits.

`tasks.project_id` is not declared `NOT NULL`: SQLite's `ALTER TABLE` can only
add a `REFERENCES` column with a NULL default, and a fresh database must match a
migrated one (`database-schema-equivalence.test.ts`). It is NOT NULL in effect:

- `DatabaseManager.createTask` assigns the parent's (or recurrence template's)
  project to a subtask, else the requested project, else the task source's,
  else the Default project; `updateTask` moves a task re-parented under another
  task into that task's project;
- the `tasks_assign_project` trigger applies the same fallback to raw inserts
  (the recurrence scheduler, the seed);
- the migration fills every existing NULL.

`rebuildTasksTable()` drops that trigger with the old table; it runs before
`migrateToProjects()` in `runMigrations()`, which recreates it. Keep that order.

### Skills have a scope

Migration 16 (`migrateSkillScope()`) adds `skills.project_id` (nullable,
references `projects`) and `idx_skills_project`. Nothing is backfilled: NULL
means global, so every skill that existed before the upgrade is visible to
every project exactly as it was. The column is declared in `createTables()`
and added with a guarded `ALTER TABLE` in the migration; it runs after
`migrateToProjects()` so the referenced table exists. Names stay unique across
scopes (`idx_skills_name`). See docs/skills.md, *Scope*.

### The coordinator is the Captain

Migration 17 (`migrateCoordinatorToCaptain()` in
`src/main/database/captain-migration.ts`, #71) renames the coordinator's
persisted identifiers in place. The exact legacy identifiers are isolated in
that compatibility module and its schema-16 fixture.

| Stored field | Current value (17) |
| --- | --- |
| Coordinator task role, title and seeded description | `captain`, `Captain`, current description (same row, id and session) |
| Project agent column | `projects.captain_agent_id` (values kept) |
| App prewarm setting | `captain_prewarm` |
| Project wakeup settings | `projects.settings.captain_wakeups` |
| Status journal source and column default | `captain` |

No row is inserted, so `seedCaptainTasks()` finds the renamed row and never
adds a second coordinator. A value already stored under a new key wins over the
old key. Every step only matches old values, so re-runs are no-ops. The same
file retires the untouched legacy seeded skill; edited user skills are preserved.

The #136 follow-up uses read compatibility for persisted prose and delegation
labels (`src/shared/captain-compat.ts`), retaining original history and routing
IDs. No schema change or new migration is needed: version 17 already migrates
roles, agent columns and settings. Version 18 remains reserved for the concurrent
sessions/redesign work. See [Captain terminology](captain-terminology.md) for
resume behavior and the stale-context investigation.

The repository terminology guard covers source, docs, prompts and tests. Only
migration fixtures and exact shared compatibility declarations may spell the
retired name.

### Merge grants and the pull-request policy split (v19)

Migration 19 (`migrateMergeGrants()`, #137) adds `merge_grants`,
`merge_grant_uses` and durable `merge_grant_reservations` (new tables, also in `createTables()`) and splits the
escalation policy's combined `pr` item in `projects.settings.escalation`:
the stored level moves to `merge_pr`, `open_pr` gets its default
(`tell_commander`), and `pr` is removed (`splitPullRequestEscalation()`).
Rows without `pr`, or with unreadable settings, are untouched, so re-runs are
no-ops. **18 was skipped on purpose** for a contemporaneous feature branch;
the managed-runtime and durable-delivery migration follows as version 20.

### Concurrency control (#150, v21)

Migration 21 (`migrateConcurrencyControl()` in
`src/main/database/concurrency-migration.ts`) supports Captain-managed
concurrency under a user-set hard cap (see docs/concurrency.md):

- `concurrency_audit` (new): one row per change to a working level, a pin or
  Captain control, with the actor and the reason. It is the project's
  concurrency activity feed. It goes with its project.
- `task_touches` (new): the files a task declares it will change. It goes with
  its task.
- `agents.config.concurrency_cap` is set to min(`max_parallel_sessions`, 5) on
  every agent that has none. Only a missing cap is filled, so a later re-run of
  `runMigrations()` never overwrites a cap the user set.
  `max_parallel_sessions` is left as it was.

Both tables are also created in `createTables()`. Nothing is added to `tasks`,
so `rebuildTasksTable()` is unchanged. This migration follows the managed
runtime and delivery-outbox migration at v20.

### Durable Captain recovery queue (#148, v22)

Migration 22 (`migrateDurableStartQueue()` in
`src/main/database/start-queue-migration.ts`) adds the single durable agent
start queue and its cross-project fairness cursor. Each task keeps one stable
queue ID. Priority/FIFO position, admission or dependency reason, retry and
backoff state, claim generation, lease, session acknowledgement, recovery
cause/action/result, and timestamps are committed before a queued result is
returned. Claims and acknowledgements are generation-fenced, so replaying
startup reconciliation or crashing around claim/start/ack cannot double-start
the logical item.

Landing order is v20 (#151 runtime and delivery outbox), v21 (#152 priority,
admission and fairness), then v22 (#148 reconciliation and durable starts).
All three migrations are idempotent and fresh databases create the same final
tables directly.

Migration 23 adds the immutable human-authorization chain and durable dispatch
bindings described in `docs/authorization-chain.md`. Issue writes consume that
resolver; they do not create a parallel provenance store.

### Delegated GitHub issue-write ledger (v24)

Migration 24 (`migrateIssueWrites()` in
`src/main/database/issue-writes-migration.ts`) adds `issue_writes`: one row per
external GitHub issue write, claimed before the call and settled after it. The
row is both the audit record and the idempotency claim, so the two cannot
disagree — `idempotency_key` is UNIQUE and a claimed key is immutably bound to
the project, repository, action, target, task, exact payload shape/hash and
trusted authorization origin. Any mismatch is refused even after a confirmed
failed attempt, leaving the original audit row unchanged. An exact retry
recomputes the same key across a restart instead of filing a second issue. The
provenance columns record the originating human instruction, the Commander
correlation and the Captain task/session; `status` moves `reserved` →
`succeeded` | `failed` | `unresolved`, and an expired lease becomes
`unresolved` rather than free. Attempt epochs fence late external answers from
newer reconciliation passes, and `payload_fields` lets interrupted partial
updates be compared in the same shape that was requested. `effects_applied_at`
is the durable commit marker for an atomic task-attachment + journal
transaction; startup reconciliation replays any successful external row whose
local effects were interrupted, exactly once. New table only, so
`CREATE TABLE IF NOT EXISTS` covers fresh and existing databases alike.
Create reconciliation accepts a marker only from a complete GitHub search
response: missing/invalid counts, `incomplete_results`, pagination truncation,
or more than one exact marker all remain unresolved. The surviving candidate's
canonical repository/issue identity and the payload reconstructed in the
stored `payload_fields` shape must also reproduce `payload_hash`; a copied
marker with different title, body or labels is not success evidence.

## Adding a column to other tables

Same pattern: update `createTables()`, add a guarded `ALTER TABLE` in `runMigrations()`, and bump `SCHEMA_VERSION`.

## Rebuilding a table (e.g. changing foreign key constraints)

Use the `rebuildTasksTable(columnNames)` helper. It:
- Creates `tasks_new` with the canonical schema
- Dynamically copies only columns that exist in **both** old and new tables (so you don't have to maintain a hardcoded SELECT list)
- Drops old, renames new, recreates indexes
- Refreshes `columnNames` in-place so subsequent migrations see accurate state

If you need to rebuild a different table, follow the same dynamic-copy pattern — never hardcode the column list in the INSERT...SELECT.

## Common mistakes to avoid

- **Forgetting to bump `SCHEMA_VERSION`**: existing users will never run the new migration.
- **Hardcoding column lists in table rebuilds**: when a column is added later, the rebuild silently drops it. Always use dynamic column intersection (see `rebuildTasksTable()` for the pattern).
- **Using stale `columnNames` after a table rebuild**: if a migration rebuilds the table, refresh `columnNames` from `pragma table_info()` before any subsequent `columnNames.has()` checks.
- **Adding a column only to `createTables()` but not to `runMigrations()`**: new users get the column, but existing users upgrading do not.
- **Adding a column only to `runMigrations()` but not to `createTables()` and `rebuildTasksTable()`**: existing users get the column via ALTER, but if the table gets rebuilt later (e.g. FK change), the rebuild drops it.

## Checklist

When adding a new column:

- [ ] Added to `createTables()` (`CREATE TABLE IF NOT EXISTS tasks`)
- [ ] Added to `rebuildTasksTable()` (`CREATE TABLE tasks_new`)
- [ ] Added guarded `ALTER TABLE` in `runMigrations()`
- [ ] Bumped `SCHEMA_VERSION`
