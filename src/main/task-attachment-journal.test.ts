import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { TaskAttachmentFileOwner, type TaskAttachmentFileOwnerOptions } from './task-attachment-file-owner'
import { ATTACHMENT_JOURNAL_LIMITS, ATTACHMENT_JOURNAL_PREFIX, TaskAttachmentJournal } from './task-attachment-journal'
import type { FileAttachmentRecord } from './database/types'
import { PRODUCTION_SETTINGS_CODECS } from '../shared/production-settings-codecs'

const fixtures: Array<{ root: string; db: ReturnType<typeof createPortableTestDb>; files: TaskAttachmentFileOwner }> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) { await f.files.close(); f.db.close(); rmSync(f.root, { recursive: true, force: true }) }
})
function fixture(fs?: TaskAttachmentFileOwnerOptions['fs']) {
  const db = createPortableTestDb(), root = dirname(dirname(db.getWorkspaceDir('fixture'))), attachmentRoot = join(root, 'attachments')
  mkdirSync(attachmentRoot, { recursive: true })
  const current = { allowed: true }, assertCurrent = (): void => { if (!current.allowed || !db.db.open) throw new Error('Retired profile') }
  const options = { database: db.db, profileId: 'synthetic-journal-profile', attachmentRoot, assertCurrent }
  const journal = new TaskAttachmentJournal(options), files = new TaskAttachmentFileOwner({ attachmentRoot, assertCurrent, journal, fs })
  fixtures.push({ root, db, files })
  const task = db.createTask({ title: 'Private journal test' })!, bytes = Buffer.from('owned bytes')
  const record: FileAttachmentRecord = { id: randomUUID(), filename: 'owned.txt', size: bytes.length, mime_type: 'text/plain', added_at: '2026-10-18T00:00:00.000Z' }
  const controls = { beforeEffect() {}, signal: new AbortController().signal }
  return { root, db, attachmentRoot, journal, files, task, bytes, record, controls, current, options,
    path: join(attachmentRoot, task.id, `${record.id}-${record.filename}`) }
}

describe('private bounded attachment journal with actual SQLite and protected files', () => {
  it('cannot read, replace or expose private intent through retained production settings codecs', () => {
    const key = ATTACHMENT_JOURNAL_PREFIX + randomUUID(), value = '{"private":"journal"}'
    expect(PRODUCTION_SETTINGS_CODECS['settings:get'].validateArguments([key])).toBe(false)
    expect(PRODUCTION_SETTINGS_CODECS['settings:set'].validateArguments([key, value])).toBe(false)
    expect(PRODUCTION_SETTINGS_CODECS['settings:getAll'].encodeResult({ theme: 'dark', [key]: value })).toEqual({ defined: true, value: { theme: 'dark' } })
  })
  it('records publication before acknowledgement and retains unreferenced accepted bytes after owner reconstruction', async () => {
    const f = fixture(), receipt = await f.files.write(f.task.id, f.record, f.bytes, f.controls)
    expect(f.journal.inspect()).toMatchObject([{ entry: { kind: 'publication', phase: 'published', attachment: f.record }, classification: 'unreferenced' }])
    // The accepted metadata/copy boundary must not gain a new fallible SQL step.
    const prepare = vi.spyOn(f.db.db, 'prepare').mockImplementation(() => { throw new Error('No SQL during commit') })
    f.files.commit(receipt); prepare.mockRestore()
    await f.files.close()
    const reconstructed = new TaskAttachmentJournal(f.options)
    expect(reconstructed.inspect()).toEqual(f.journal.inspect())
    expect(readFileSync(f.path)).toEqual(f.bytes)
    expect(f.db.getTask(f.task.id)?.attachments).toEqual([])
    expect(readdirSync(join(f.attachmentRoot, f.task.id))).toEqual([`${f.record.id}-${f.record.filename}`])
  })
  it('classifies canonical references and refuses to roll their bytes back after a separately accepted metadata write', async () => {
    const f = fixture(), receipt = await f.files.write(f.task.id, f.record, f.bytes, f.controls)
    f.db.updateTask(f.task.id, { attachments: [f.record] })
    await f.files.rollback(receipt)
    expect(f.journal.inspect()[0].classification).toBe('referenced')
    expect(readFileSync(f.path)).toEqual(f.bytes)
    expect(f.files.inflightCount).toBe(0)
  })
  it('retires a verified uncommitted copy and its live journal receipt together', async () => {
    const f = fixture(), receipt = await f.files.write(f.task.id, f.record, f.bytes, f.controls)
    await f.files.rollback(receipt)
    expect(f.journal.inspect()).toEqual([]); expect(existsSync(f.path)).toBe(false)
  })
  it('retains the live cleanup owner when SQLite refuses journal retirement after verified unlink', async () => {
    const f = fixture(), receipt = await f.files.write(f.task.id, f.record, f.bytes, f.controls)
    f.db.db.exec(`CREATE TRIGGER refuse_journal_retirement BEFORE DELETE ON settings WHEN OLD.key GLOB '__attachment_journal_v1:*' BEGIN SELECT RAISE(ABORT, 'Controlled journal retirement refusal'); END`)
    await expect(f.files.rollback(receipt)).rejects.toThrow('Controlled journal retirement refusal')
    expect(existsSync(f.path)).toBe(false)
    expect(f.files.inflightCount).toBeGreaterThan(0)
    expect(f.db.db.open).toBe(true)
    expect(f.journal.inspect()).toHaveLength(1)
    await expect(f.files.close()).rejects.toThrow('Controlled journal retirement refusal')
    expect(f.files.inflightCount).toBeGreaterThan(0)
    f.db.db.exec('DROP TRIGGER refuse_journal_retirement')
    await f.files.close()
    expect(f.files.inflightCount).toBe(0); expect(f.journal.inspect()).toEqual([])
  })
  it('joins logical removal intent to the existing SQLite transaction and never reconstructs unlink authority', async () => {
    const f = fixture(), receipt = await f.files.write(f.task.id, f.record, f.bytes, f.controls)
    f.db.updateTask(f.task.id, { attachments: [f.record] }); f.files.commit(receipt)
    let rolledBack!: object
    expect(() => f.db.db.transaction(() => {
      rolledBack = f.files.beginRemovalIntent(f.task.id, f.record, f.controls)!
      f.db.updateTask(f.task.id, { attachments: [] }); throw new Error('Withdraw logical delta')
    })()).toThrow('Withdraw logical delta')
    expect(f.journal.inspect()).toHaveLength(1)
    expect(() => f.journal.assertRemoval(rolledBack, f.task.id, f.record)).toThrow()
    await expect(f.files.remove(f.task.id, f.record, f.controls)).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID_ARGUMENTS' })
    const ticket = f.db.db.transaction(() => {
      const ticket = f.files.beginRemovalIntent(f.task.id, f.record, f.controls)!
      f.db.updateTask(f.task.id, { attachments: [] }); return ticket
    })()
    const reconstructed = new TaskAttachmentJournal(f.options)
    expect(() => reconstructed.assertRemoval(ticket, f.task.id, f.record)).toThrow()
    expect(reconstructed.inspect().find(row => row.entry.kind === 'removal')?.classification).toBe('cleanup_unconfirmed')
    expect(readFileSync(f.path)).toEqual(f.bytes)
    await f.files.remove(f.task.id, f.record, f.controls, ticket)
    expect(existsSync(f.path)).toBe(false)
    expect(f.journal.inspect()).toEqual([])
  })
  it('preserves accepted logical removal and a verified cleanup record when raw unlink refuses', async () => {
    let refuse = false
    const f = fixture({ unlink: async path => { if (refuse && !path.endsWith('.tmp')) throw new Error('Controlled unlink refusal'); await unlink(path) } })
    const receipt = await f.files.write(f.task.id, f.record, f.bytes, f.controls)
    f.db.updateTask(f.task.id, { attachments: [f.record] }); f.files.commit(receipt)
    const ticket = f.db.db.transaction(() => { const ticket = f.files.beginRemovalIntent(f.task.id, f.record, f.controls)!; f.db.updateTask(f.task.id, { attachments: [] }); return ticket })()
    refuse = true
    await expect(f.files.remove(f.task.id, f.record, f.controls, ticket)).rejects.toThrow()
    expect(f.db.getTask(f.task.id)?.attachments).toEqual([])
    expect(f.journal.inspect()).toContainEqual(expect.objectContaining({ entry: expect.objectContaining({ kind: 'removal', phase: 'verified' }), classification: 'cleanup_unconfirmed' }))
    const reconstructed = new TaskAttachmentJournal(f.options)
    expect(reconstructed.inspect()).toHaveLength(2)
    expect(readFileSync(f.path)).toEqual(f.bytes)
  })
  it('records metadata-only detachment inside its transaction and never automatically removes files', async () => {
    const f = fixture()
    f.db.updateTask(f.task.id, { attachments: [f.record] })
    expect(() => f.db.db.transaction(() => { f.journal.observeMetadataChange(f.task.id, [f.record], []); throw new Error('Abort') })()).toThrow('Abort')
    expect(f.journal.inspect()).toEqual([])
    f.db.db.transaction(() => { f.journal.observeMetadataChange(f.task.id, [f.record], []); f.db.updateTask(f.task.id, { attachments: [] }) })()
    expect(f.journal.inspect()).toMatchObject([{ entry: { kind: 'unreferenced', phase: 'observed' }, classification: 'unreferenced' }])
    expect(existsSync(join(f.attachmentRoot, f.task.id))).toBe(false)
  })
  it.each(['malformed', 'oversized', 'foreign-key'] as const)('refuses %s ledger input before opening any new protected file', async kind => {
    const f = fixture()
    const key = ATTACHMENT_JOURNAL_PREFIX + (kind === 'foreign-key' ? 'wrong' : randomUUID())
    f.db.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(key, kind === 'oversized' ? 'x'.repeat(ATTACHMENT_JOURNAL_LIMITS.recordBytes + 1) : '{}')
    await expect(f.files.write(f.task.id, f.record, f.bytes, f.controls)).rejects.toThrow()
    expect(readdirSync(join(f.attachmentRoot, f.task.id))).toEqual([])
    expect(() => f.journal.inspect()).toThrow()
    f.db.db.prepare('DELETE FROM settings WHERE key=?').run(key)
  })
  it.each(['keys', 'count', 'total'] as const)('bounds ledger %s in SQLite before materializing rows', kind => {
    const f = fixture(), insert = f.db.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)')
    f.db.db.transaction(() => {
      if (kind === 'keys') insert.run(ATTACHMENT_JOURNAL_PREFIX + 'x'.repeat(65536), '{}')
      else for (let index = 0; index < ATTACHMENT_JOURNAL_LIMITS.records + (kind === 'count' ? 1 : 0); index++) insert.run(ATTACHMENT_JOURNAL_PREFIX + randomUUID(), kind === 'total' ? 'x'.repeat(3072) : '{}')
    })()
    const prepares = vi.spyOn(f.db.db, 'prepare')
    expect(() => f.journal.inspect()).toThrow()
    expect(prepares.mock.calls.some(([query]) => query.startsWith('SELECT key,value'))).toBe(false)
    prepares.mockRestore()
    f.db.db.prepare('DELETE FROM settings WHERE key GLOB ?').run(ATTACHMENT_JOURNAL_PREFIX + '*')
  })
  it('retains facts and refuses a changed physical root or withdrawn profile', async () => {
    const f = fixture(), receipt = await f.files.write(f.task.id, f.record, f.bytes, f.controls)
    f.files.commit(receipt); f.current.allowed = false
    expect(() => f.journal.inspect()).toThrow('Retired profile'); f.current.allowed = true
    const retired = f.attachmentRoot + '-retired', outside = join(f.root, 'outside')
    renameSync(f.attachmentRoot, retired); mkdirSync(outside); symlinkSync(outside, f.attachmentRoot)
    expect(() => f.journal.inspect()).toThrow()
    expect(readdirSync(outside)).toEqual([])
    rmSync(f.attachmentRoot); renameSync(retired, f.attachmentRoot)
    expect(f.journal.inspect()[0].classification).toBe('unreferenced')
  })
})
