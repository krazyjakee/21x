import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseManager } from '../../src/main/database/manager'
import { createTables, ensureTranscriptRevColumn, runMigrations } from '../../src/main/database/schema'
import { TaskAttachmentFileOwner } from '../../src/main/task-attachment-file-owner'
import { TaskAttachmentJournal } from '../../src/main/task-attachment-journal'

// Private proof process. A persisted ledger ID deliberately cannot reconstruct
// one of the live receipts owned by the process killed at these checkpoints.
const [root, mode] = process.argv.slice(2), attachmentRoot = join(root, 'attachments')
mkdirSync(attachmentRoot, { recursive: true })
const raw = new Database(join(root, 'journal-proof.sqlite'))
raw.pragma('journal_mode=WAL'); raw.pragma('foreign_keys=ON')
createTables(raw); runMigrations(raw); ensureTranscriptRevColumn(raw)
const database = new DatabaseManager({ paths: { profileRoot: root, workspaceRoot: join(root, 'workspaces'), attachmentRoot }, managedTaskMcp: { disabled: true }, logger: { log() {}, error() {} } })
database.db = raw
const journal = new TaskAttachmentJournal({ database: raw, profileId: 'synthetic-crash-profile', attachmentRoot, assertCurrent() { if (!raw.open) throw new Error('Closed profile') } })
const waiting = (): Promise<never> => new Promise(() => { setInterval(() => {}, 1000) })
const send = async (value: unknown): Promise<void> => {
  const encoded = JSON.stringify(value)
  if (Buffer.byteLength(encoded) > 65536) throw new Error('Oversized private proof receipt')
  await new Promise<void>((resolve, reject) => process.send!(JSON.parse(encoded), error => error ? reject(error) : resolve()))
}
if (mode === 'inspect') {
  const rows = journal.inspect(), task = raw.prepare('SELECT id,attachments FROM tasks WHERE title=?').get('Crash journal checkpoint')
  await send({ kind: 'inspection', rows, task }); raw.close(); process.disconnect!()
} else {
  const files = new TaskAttachmentFileOwner({ attachmentRoot, journal, assertCurrent() { if (!raw.open) throw new Error('Closed profile') },
    fs: { unlink: async path => {
      if (!path.endsWith('.tmp') && mode.startsWith('remove-')) {
        if (mode === 'remove-after') await unlink(path)
        await send({ kind: 'checkpoint', mode }); await waiting()
      }
      await unlink(path)
    } } })
  const task = database.createTask({ title: 'Crash journal checkpoint' })!, bytes = Buffer.alloc(65537, 37)
  const record = { id: randomUUID(), filename: 'crash-owned.txt', size: bytes.length, mime_type: 'text/plain', added_at: '2026-10-18T00:00:00.000Z' }
  const controls = { beforeEffect() {}, signal: new AbortController().signal }
  const receipt = await files.writeStream(task.id, record, async (offset, length) => {
    if (mode === 'partial' && offset > 0) { await send({ kind: 'checkpoint', mode }); await waiting() }
    return bytes.subarray(offset, offset + length)
  }, controls)
  files.commit(receipt)
  if (mode === 'published') { await send({ kind: 'checkpoint', mode }); await waiting() }
  database.updateTask(task.id, { attachments: [record] })
  const intent = raw.transaction(() => {
    const intent = files.beginRemovalIntent(task.id, record, controls)
    database.updateTask(task.id, { attachments: [] }); return intent
  })()
  await files.remove(task.id, record, controls, intent)
  throw new Error('The controlled checkpoint must be killed before this return')
}
