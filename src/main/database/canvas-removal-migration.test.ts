import { afterEach, describe, expect, it } from 'vitest'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import { applySchema } from './schema'
import { dropCanvasSettings } from './canvas-removal-migration'
import type { DatabaseManager } from '../database'

const databases: DatabaseManager[] = []
afterEach(() => { for (const db of databases.splice(0)) db.db.close() })
function fixture() { const db = createPortableTestDb(); databases.push(db); return db }

const CANVAS_KEYS = ['canvas_state', 'drawing_state', 'canvas_state_migrated_to_projects', 'drawing_state_migrated_to_projects',
  'canvas_state:default', 'canvas_state:project_1', 'drawing_state:default', 'drawing_state:project_1']

describe('schema 40 Canvas removal migration', () => {
  it('drops saved layouts and drawings, keeps every other setting and the task itself, and is idempotent', () => {
    const manager = fixture(), db = manager.db
    const task = manager.createTask({ title: 'Task that had a panel' })!
    for (const key of CANVAS_KEYS) manager.setSetting(key, '{"panels":[{"type":"task","refId":"' + task.id + '"}]}')
    // Near misses must survive: only the exact keys and their `:<project>` forms go.
    manager.setSetting('canvas_state_backup', 'keep')
    manager.setSetting('my_canvas_state:default', 'keep')
    manager.setSetting('theme', 'dark')
    manager.setSetting('__schema_version', '39')

    expect(applySchema(db)).toBe(true)

    expect(manager.getSetting('__schema_version')).toBe('40')
    for (const key of CANVAS_KEYS) expect(manager.getSetting(key), key).toBeUndefined()
    expect(manager.getSetting('canvas_state_backup')).toBe('keep')
    expect(manager.getSetting('my_canvas_state:default')).toBe('keep')
    expect(manager.getSetting('theme')).toBe('dark')
    expect(manager.getTask(task.id)?.title).toBe('Task that had a panel')

    expect(applySchema(db)).toBe(false)
    expect(() => dropCanvasSettings(db)).not.toThrow()
    expect(manager.getSetting('theme')).toBe('dark')
  })
})
