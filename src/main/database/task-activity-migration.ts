import type Database from 'better-sqlite3'

/** v25. Never infer activity from updated_at: it includes scheduler bookkeeping. */
export function migrateTaskActivity(db: Database.Database): void {
  const columns = db.pragma('table_info(tasks)') as { name: string }[]
  if (!columns.some((column) => column.name === 'last_activity_at')) {
    db.exec('ALTER TABLE tasks ADD COLUMN last_activity_at TEXT DEFAULT NULL')
  }
  db.exec(`
    UPDATE tasks SET last_activity_at = MAX(created_at, COALESCE((
      SELECT strftime('%Y-%m-%dT%H:%M:%fZ', MAX(created_at) / 1000.0, 'unixepoch')
      FROM transcript_parts WHERE task_id = tasks.id AND role IN ('user', 'assistant')
    ), created_at)) WHERE last_activity_at IS NULL;

    WITH RECURSIVE descendants(ancestor, id) AS (
      SELECT id, id FROM tasks
      UNION
      SELECT descendants.ancestor, tasks.id FROM tasks
      JOIN descendants ON tasks.parent_task_id = descendants.id
    )
    UPDATE tasks SET last_activity_at = (
      SELECT MAX(child.last_activity_at) FROM descendants
      JOIN tasks child ON child.id = descendants.id WHERE ancestor = tasks.id
    );

    CREATE TRIGGER IF NOT EXISTS tasks_initial_activity AFTER INSERT ON tasks
    WHEN NEW.last_activity_at IS NULL BEGIN
      UPDATE tasks SET last_activity_at = NEW.created_at WHERE id = NEW.id;
    END;
  `)
}
