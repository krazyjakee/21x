# Database Migrations

All schema migrations live in `src/main/database/schema.ts` as plain functions over the raw SQLite handle; `DatabaseManager.initialize()` applies them through `applySchema()`. Tests build their schema from the same functions (`test/helpers/db-test-helper.ts`).

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

`tasks.role` marks coordinator rows (the Mastermind, `role = 'mastermind'`).
The column is declared in all three places above and `seedMastermindTask()`
runs on every startup, so a returning user gets the row exactly once. Never
default `role` to anything but `'task'`: an old row with a missing column must
stay a user task.

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
