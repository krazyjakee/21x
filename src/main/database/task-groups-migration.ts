import type Database from 'better-sqlite3'

/** Portable v37 DDL. Membership episodes remain after ungrouping/deletion. */
export function createTaskGroupTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_groups (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id),
      agent_id TEXT NOT NULL,
      execution_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','dissolved')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_groups_project ON task_groups(project_id, state, created_at);
    CREATE TABLE IF NOT EXISTS task_group_memberships (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES task_groups(id) ON DELETE RESTRICT,
      task_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      joined_at TEXT NOT NULL,
      left_at TEXT,
      progress_state TEXT NOT NULL DEFAULT 'pending' CHECK(progress_state IN ('pending','working','done','blocked')),
      progress_message TEXT NOT NULL DEFAULT '',
      progress_updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_group_current_member ON task_group_memberships(task_id) WHERE left_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_task_group_members ON task_group_memberships(group_id, left_at, position);
    CREATE INDEX IF NOT EXISTS idx_task_group_history ON task_group_memberships(task_id, joined_at);
  `)
}

export function migrateTaskGroups(db: Database.Database): void {
  db.transaction(() => {
    createTaskGroupTables(db)
    const columns = db.pragma('table_info(tasks)') as Array<{ name: string }>
    if (!columns.some(column => column.name === 'group_id')) db.exec('ALTER TABLE tasks ADD COLUMN group_id TEXT REFERENCES task_groups(id) ON DELETE SET NULL')
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_id) WHERE group_id IS NOT NULL')
  })()
}
