import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseManager, type DatabaseRuntimeOptions } from './database/manager'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'

const owned: Array<{ db: DatabaseManager; root: string }> = []
afterEach(() => { for (const { db, root } of owned.splice(0)) { db.close(); rmSync(root, { recursive: true, force: true }) } })
function fixture(retain: boolean) {
  const root = mkdtempSync(join(tmpdir(), '21x-database-attachment-retention-'))
  const options: DatabaseRuntimeOptions = { paths: { profileRoot: root, workspaceRoot: join(root, 'workspaces'), attachmentRoot: join(root, 'attachments') }, managedTaskMcp: { disabled: true }, ...(retain ? { attachmentDeletion: 'retain' as const } : {}) }
  const db = new DatabaseManager(options); db.db = createPortableTestDb().db; owned.push({ db, root })
  const task = db.createTask({ title: 'Retained bytes' })!, taskDirectory = join(options.paths.attachmentRoot, task.id), path = join(taskDirectory, 'retained.txt')
  mkdirSync(taskDirectory, { recursive: true }); writeFileSync(path, 'retained bytes')
  return { db, root, options, task, path }
}
describe('captured private database attachment deletion policy', () => {
  it('retains bytes for logical deletion and direct cleanup calls without materializing paths', () => {
    const f = fixture(true)
    f.options.attachmentDeletion = undefined
    f.options.paths.attachmentRoot = join(f.root, 'replacement')
    f.db.deleteTaskAttachments(f.task.id)
    expect(readFileSync(f.path, 'utf8')).toBe('retained bytes')
    expect(f.db.deleteTask(f.task.id)).toBe(true)
    expect(f.db.getTask(f.task.id)).toBeUndefined()
    expect(readFileSync(f.path, 'utf8')).toBe('retained bytes')
    expect(f.db.deleteTask(f.task.id)).toBe(false)
    expect(readFileSync(f.path, 'utf8')).toBe('retained bytes')
  })
  it('preserves the explicit legacy host default and captures it before option mutation', () => {
    const f = fixture(false)
    f.options.attachmentDeletion = 'retain'
    expect(f.db.deleteTask(f.task.id)).toBe(true)
    expect(existsSync(f.path)).toBe(false)
  })
  it('refuses malformed private policies rather than falling back to recursive deletion', () => {
    const f = fixture(true)
    for (const value of [null, false, {}, 'recursive', 'RETAIN']) expect(() => new DatabaseManager({ ...f.options, attachmentDeletion: value } as unknown as DatabaseRuntimeOptions)).toThrow('Invalid attachment deletion policy')
    expect(readFileSync(f.path, 'utf8')).toBe('retained bytes')
  })
})
