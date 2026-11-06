import type Database from 'better-sqlite3'

/**
 * Schema v40: Canvas is gone, so nothing reads its layouts or drawings. Only the
 * named settings rows go; every other setting and table is left alone.
 */
export function dropCanvasSettings(db: Database.Database): void {
  db.prepare(`DELETE FROM settings
    WHERE key IN ('canvas_state', 'drawing_state', 'canvas_state_migrated_to_projects', 'drawing_state_migrated_to_projects')
       OR key GLOB 'canvas_state:*'
       OR key GLOB 'drawing_state:*'`).run()
}
