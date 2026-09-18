import Database from 'better-sqlite3'
import { vi } from 'vitest'
import { DatabaseManager } from '../../src/main/database'
import { createTables, ensureTranscriptRevColumn, runMigrations } from '../../src/main/database/schema'

/**
 * Creates a DatabaseManager backed by in-memory SQLite for testing, using the
 * production schema path. `initialize()` is not used because it calls
 * `app.getPath()` and seeds default rows (agent, skill, MCP server).
 */
export function createTestDb(): { db: DatabaseManager; rawDb: InstanceType<typeof Database> } {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  createTables(db)
  runMigrations(db)
  ensureTranscriptRevColumn(db)

  const manager = new DatabaseManager()
  manager.db = db

  // Stub filesystem methods that call app.getPath
  manager.getWorkspaceDir = vi.fn(() => '/tmp/test-workspace')
  manager.getAttachmentsDir = vi.fn(() => '/tmp/test-attachments')
  manager.deleteTaskAttachments = vi.fn()

  return { db: manager, rawDb: db }
}
