import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseManager } from '../../src/main/database/manager'
import { createTables, ensureTranscriptRevColumn, runMigrations } from '../../src/main/database/schema'

/** Actual schema and manager, without an Electron host or filesystem effects. */
export function createPortableTestDb(): DatabaseManager {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  createTables(db)
  runMigrations(db)
  ensureTranscriptRevColumn(db)
  const root = join(tmpdir(), `21x-portable-unit-${randomUUID()}`)
  const manager = new DatabaseManager({
    paths: { profileRoot: root, workspaceRoot: join(root, 'workspaces'), attachmentRoot: join(root, 'attachments') },
    managedTaskMcp: { disabled: true }, logger: { log() {}, error() {} }
  })
  manager.db = db
  return manager
}
