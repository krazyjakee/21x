import type Database from 'better-sqlite3'
import { lstatSync, realpathSync, type BigIntStats } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { FileAttachmentRecord } from './database/types'
import { isDatabaseId } from '../shared/database-desktop-codecs'
import { TASK_ATTACHMENT_LIMITS, taskAttachmentRecord, taskAttachmentRecords } from '../shared/task-attachment-codecs'

export const ATTACHMENT_JOURNAL_PREFIX = '__attachment_journal_v1:'
export const ATTACHMENT_JOURNAL_LIMITS = Object.freeze({ records: 4096, recordBytes: 8192, totalBytes: 8 * 1024 * 1024 })
type Kind = 'publication' | 'unreferenced' | 'removal'
type Phase = 'opening' | 'staged' | 'ready' | 'published' | 'observed' | 'requested' | 'verified'
interface NodeIdentity { dev: string; ino: string; birthtimeNs: string }
interface FileIdentity extends NodeIdentity { size: string; mtimeNs: string; ctimeNs: string }
interface Scope { project_id: string; agent_id: string | null; parent_task_id: string | null; role: string; group_id: string | null }
export interface AttachmentJournalEntry {
  version: 1
  id: string
  profileId: string
  kind: Kind
  phase: Phase
  taskId: string
  attachment: FileAttachmentRecord
  root: NodeIdentity
  scope: Scope
  createdAt: string
  stage?: string
  directory?: NodeIdentity
  file?: FileIdentity
  digest?: string
}
export type AttachmentJournalClassification = 'referenced' | 'unreferenced' | 'publication_unconfirmed' | 'cleanup_unconfirmed' | 'metadata_conflict' | 'scope_changed' | 'task_absent' | 'foreign_owner'
export class AttachmentJournalError extends Error {
  constructor(readonly code: 'ATTACHMENT_JOURNAL_INVALID' | 'ATTACHMENT_JOURNAL_CAPACITY' | 'ATTACHMENT_JOURNAL_CHANGED') { super(code); this.name = 'AttachmentJournalError' }
}
function reject(code: AttachmentJournalError['code'] = 'ATTACHMENT_JOURNAL_INVALID'): never { throw new AttachmentJournalError(code) }
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
const decimal = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,39})$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every(key => keys.includes(key))
const sameAttachment = (a: FileAttachmentRecord, b: FileAttachmentRecord): boolean => a.id === b.id && a.filename === b.filename && a.size === b.size && a.mime_type === b.mime_type && a.added_at === b.added_at
const samePath = (a: FileAttachmentRecord, b: FileAttachmentRecord): boolean => a.id === b.id && a.filename === b.filename
const nodeIdentity = (info: BigIntStats): NodeIdentity => ({ dev: info.dev.toString(), ino: info.ino.toString(), birthtimeNs: info.birthtimeNs.toString() })
const fileIdentity = (info: BigIntStats): FileIdentity => ({ ...nodeIdentity(info), size: info.size.toString(), mtimeNs: info.mtimeNs.toString(), ctimeNs: info.ctimeNs.toString() })
const sameIdentity = (a: NodeIdentity, b: NodeIdentity): boolean => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs
const node = (value: unknown): value is NodeIdentity => object(value) && exact(value, ['dev', 'ino', 'birthtimeNs']) && decimal(value.dev) && decimal(value.ino) && decimal(value.birthtimeNs)
const file = (value: unknown): value is FileIdentity => object(value) && exact(value, ['dev', 'ino', 'birthtimeNs', 'size', 'mtimeNs', 'ctimeNs']) && ['dev', 'ino', 'birthtimeNs', 'size', 'mtimeNs', 'ctimeNs'].every(key => decimal(value[key]))
const scopeFields = ['project_id', 'agent_id', 'parent_task_id', 'role', 'group_id'] as const
const validScope = (value: unknown): value is Scope => object(value) && Object.keys(value).length === scopeFields.length && exact(value, scopeFields) && isDatabaseId(value.project_id) && [value.agent_id, value.parent_task_id, value.group_id].every(id => id === null || isDatabaseId(id)) && ['task', 'task_group', 'captain'].includes(String(value.role))
function validEntry(value: unknown): value is AttachmentJournalEntry {
  if (!object(value) || !exact(value, ['version', 'id', 'profileId', 'kind', 'phase', 'taskId', 'attachment', 'root', 'scope', 'createdAt', 'stage', 'directory', 'file', 'digest']) || value.version !== 1 || !uuid(value.id) || !isDatabaseId(value.taskId) || typeof value.profileId !== 'string' || !value.profileId || Buffer.byteLength(value.profileId) > 256 || !taskAttachmentRecord(value.attachment) || !node(value.root) || !validScope(value.scope) || typeof value.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt))) return false
  if (value.directory !== undefined && !node(value.directory) || value.file !== undefined && !file(value.file) || value.digest !== undefined && (typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest))) return false
  if (value.kind === 'publication') return ['opening', 'staged', 'ready', 'published'].includes(String(value.phase)) && typeof value.stage === 'string' && /^\.attachment-[0-9a-f-]{36}\.tmp$/.test(value.stage) && uuid(value.stage.slice(12, -4)) && node(value.directory) && (value.phase === 'opening' || file(value.file)) && (!['ready', 'published'].includes(String(value.phase)) || typeof value.digest === 'string')
  if (value.stage !== undefined || value.directory !== undefined) return false
  return value.kind === 'unreferenced' ? value.phase === 'observed' && value.file === undefined && value.digest === undefined
    : value.kind === 'removal' && (value.phase === 'requested' && value.file === undefined && value.digest === undefined || value.phase === 'verified' && file(value.file) && typeof value.digest === 'string')
}

/** A private ledger, not a capability or retry queue. Its persisted IDs never
 * reconstruct live receipts or authorize a file read/unlink after restart. */
export class TaskAttachmentJournal {
  private readonly root: NodeIdentity
  private readonly tickets = new WeakMap<object, { entry: AttachmentJournalEntry; value: string }>()
  private readonly live = new Set<string>()
  constructor(private readonly options: { database: Database.Database; profileId: string; attachmentRoot: string; assertCurrent(): void }) {
    options.assertCurrent()
    const info = lstatSync(options.attachmentRoot, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(options.attachmentRoot) !== options.attachmentRoot || !options.profileId || Buffer.byteLength(options.profileId) > 256) reject()
    this.root = Object.freeze(nodeIdentity(info))
    this.options = Object.freeze({ ...options })
  }
  private current(): void {
    this.options.assertCurrent(); if (!this.options.database.open) reject()
    const info = lstatSync(this.options.attachmentRoot, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink() || !sameIdentity(nodeIdentity(info), this.root) || realpathSync(this.options.attachmentRoot) !== this.options.attachmentRoot) reject('ATTACHMENT_JOURNAL_CHANGED')
  }
  private taskScope(taskId: string): Scope | undefined {
    this.current()
    if (!isDatabaseId(taskId)) reject()
    const bounds = scopeFields.map(key => `COALESCE(length(CAST(${key} AS BLOB)),0)>${key === 'role' ? 32 : 128}`).join(' OR ')
    if (this.options.database.prepare(`SELECT 1 FROM tasks WHERE id=? AND (${bounds})`).get(taskId)) reject()
    const row = this.options.database.prepare(`SELECT ${scopeFields.join(',')} FROM tasks WHERE id=?`).get(taskId)
    if (row === undefined) return undefined
    if (!validScope(row)) reject()
    return row
  }
  private references(taskId: string): FileAttachmentRecord[] | undefined {
    this.current()
    const size = this.options.database.prepare('SELECT typeof(attachments) AS type,length(CAST(attachments AS BLOB)) AS bytes FROM tasks WHERE id=?').get(taskId) as { type: string; bytes: number } | undefined
    if (!size) return undefined
    if (size.type !== 'text' || size.bytes > TASK_ATTACHMENT_LIMITS.metadataBytes) reject()
    const row = this.options.database.prepare('SELECT attachments FROM tasks WHERE id=?').get(taskId) as { attachments: string }
    let records: unknown
    try { records = JSON.parse(row.attachments) } catch { reject() }
    if (!taskAttachmentRecords(records)) reject()
    return records as FileAttachmentRecord[]
  }
  private entries(): Array<{ key: string; value: string; entry: AttachmentJournalEntry }> {
    this.current()
    const stats = this.options.database.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(value AS BLOB))),0) AS bytes,COALESCE(MAX(length(CAST(value AS BLOB))),0) AS largest,COALESCE(MAX(length(CAST(key AS BLOB))),0) AS keyBytes FROM settings WHERE key GLOB ?').get(ATTACHMENT_JOURNAL_PREFIX + '*') as { count: number; bytes: number; largest: number; keyBytes: number }
    if (stats.count > ATTACHMENT_JOURNAL_LIMITS.records || stats.bytes > ATTACHMENT_JOURNAL_LIMITS.totalBytes || stats.largest > ATTACHMENT_JOURNAL_LIMITS.recordBytes) reject('ATTACHMENT_JOURNAL_CAPACITY')
    if (stats.keyBytes > ATTACHMENT_JOURNAL_PREFIX.length + 36) reject()
    const rows = this.options.database.prepare('SELECT key,value,typeof(value) AS type FROM settings WHERE key GLOB ? ORDER BY key LIMIT ?').all(ATTACHMENT_JOURNAL_PREFIX + '*', ATTACHMENT_JOURNAL_LIMITS.records + 1) as Array<{ key: string; value: string; type: string }>
    return rows.map(row => {
      if (row.type !== 'text' || row.key.length !== ATTACHMENT_JOURNAL_PREFIX.length + 36) reject()
      let entry: unknown
      try { entry = JSON.parse(row.value) } catch { reject() }
      if (!validEntry(entry) || row.key !== ATTACHMENT_JOURNAL_PREFIX + entry.id) reject()
      return { key: row.key, value: row.value, entry }
    })
  }
  private create(kind: Kind, phase: Phase, taskId: string, attachment: FileAttachmentRecord, extra: Partial<AttachmentJournalEntry> = {}): object {
    if (!taskAttachmentRecord(attachment)) reject()
    const scope = this.taskScope(taskId); if (!scope) reject()
    const entry: AttachmentJournalEntry = { version: 1, id: randomUUID(), profileId: this.options.profileId, kind, phase, taskId, attachment: { ...attachment }, root: this.root, scope, createdAt: new Date().toISOString(), ...extra }
    if (!validEntry(entry)) reject()
    const value = JSON.stringify(entry), rows = this.entries()
    // An enclosing metadata transaction may have rolled an intent back. Do
    // not retain those IDs indefinitely; missing rows never revive a ticket.
    const persisted = new Set(rows.map(row => row.entry.id))
    for (const id of this.live) if (!persisted.has(id)) this.live.delete(id)
    if (rows.length >= ATTACHMENT_JOURNAL_LIMITS.records || Buffer.byteLength(value) > ATTACHMENT_JOURNAL_LIMITS.recordBytes || rows.reduce((total, row) => total + Buffer.byteLength(row.value), 0) + Buffer.byteLength(value) > ATTACHMENT_JOURNAL_LIMITS.totalBytes) reject('ATTACHMENT_JOURNAL_CAPACITY')
    this.current(); this.options.database.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(ATTACHMENT_JOURNAL_PREFIX + entry.id, value)
    const ticket = Object.freeze({}); this.tickets.set(ticket, { entry, value }); if (kind !== 'unreferenced') this.live.add(entry.id); return ticket
  }
  private owned(ticket: object) {
    this.current()
    const saved = this.tickets.get(ticket); if (!saved) reject()
    const row = this.options.database.prepare('SELECT value FROM settings WHERE key=?').get(ATTACHMENT_JOURNAL_PREFIX + saved.entry.id) as { value: string } | undefined
    if (row?.value !== saved.value || saved.entry.profileId !== this.options.profileId || !sameIdentity(saved.entry.root, this.root)) reject('ATTACHMENT_JOURNAL_CHANGED')
    return saved
  }
  private update(ticket: object, patch: Partial<AttachmentJournalEntry>): void {
    const previous = this.owned(ticket), entry = { ...previous.entry, ...patch }, value = JSON.stringify(entry)
    if (!validEntry(entry) || Buffer.byteLength(value) > ATTACHMENT_JOURNAL_LIMITS.recordBytes) reject()
    const rows = this.entries()
    if (rows.reduce((total, row) => total + Buffer.byteLength(row.value), 0) - Buffer.byteLength(previous.value) + Buffer.byteLength(value) > ATTACHMENT_JOURNAL_LIMITS.totalBytes) reject('ATTACHMENT_JOURNAL_CAPACITY')
    this.current()
    if (this.options.database.prepare('UPDATE settings SET value=? WHERE key=? AND value=?').run(value, ATTACHMENT_JOURNAL_PREFIX + entry.id, previous.value).changes !== 1) reject('ATTACHMENT_JOURNAL_CHANGED')
    this.tickets.set(ticket, { entry, value })
  }
  beginPublication(taskId: string, attachment: FileAttachmentRecord, stage: string, directory: BigIntStats): object {
    if (!directory.isDirectory() || directory.isSymbolicLink()) reject()
    return this.create('publication', 'opening', taskId, attachment, { stage, directory: nodeIdentity(directory) })
  }
  staged(ticket: object, info: BigIntStats): void {
    if (this.owned(ticket).entry.phase !== 'opening' || !info.isFile() || info.nlink !== 1n || info.size !== 0n) reject()
    this.update(ticket, { phase: 'staged', file: fileIdentity(info) })
  }
  ready(ticket: object, info: BigIntStats, digest: string): void {
    const entry = this.owned(ticket).entry
    if (entry.phase !== 'staged' || !entry.file || !sameIdentity(entry.file, nodeIdentity(info)) || !info.isFile() || info.nlink !== 1n || info.size !== BigInt(entry.attachment.size)) reject()
    this.update(ticket, { phase: 'ready', file: fileIdentity(info), digest })
  }
  published(ticket: object, info: BigIntStats): void {
    const entry = this.owned(ticket).entry
    if (entry.phase !== 'ready' || !entry.file || !sameIdentity(entry.file, nodeIdentity(info)) || !info.isFile() || info.nlink !== 1n || info.size !== BigInt(entry.attachment.size) || info.mtimeNs.toString() !== entry.file.mtimeNs) reject()
    this.update(ticket, { phase: 'published', file: fileIdentity(info) })
  }
  /** Synchronous private intent joins the existing logical-removal transaction. */
  beginRemoval(taskId: string, attachment: FileAttachmentRecord): object {
    if (!taskAttachmentRecord(attachment) || !this.references(taskId)?.some(record => sameAttachment(record, attachment))) reject()
    return this.create('removal', 'requested', taskId, attachment)
  }
  assertRemoval(ticket: object, taskId: string, attachment: FileAttachmentRecord): void {
    const { entry } = this.owned(ticket)
    const scope = this.taskScope(taskId)
    if (entry.kind !== 'removal' || entry.taskId !== taskId || !scope || scopeFields.some(key => scope[key] !== entry.scope[key]) || !sameAttachment(entry.attachment, attachment) || this.references(taskId)?.some(record => samePath(record, attachment))) reject()
  }
  removalVerified(ticket: object, info: BigIntStats, digest: string): void {
    const entry = this.owned(ticket).entry
    if (entry.kind !== 'removal' || entry.phase !== 'requested' || !info.isFile() || info.nlink !== 1n || info.size !== BigInt(entry.attachment.size)) reject()
    this.update(ticket, { phase: 'verified', file: fileIdentity(info), digest })
  }
  isReferenced(ticket: object): boolean { const { entry } = this.owned(ticket); return !!this.references(entry.taskId)?.some(record => samePath(record, entry.attachment)) }
  /** Pure receipt retirement after an accepted copy/metadata boundary. Facts
   * were persisted before acknowledgement; no SQL or I/O can fail here. */
  acknowledge(ticket: object): void { const saved = this.tickets.get(ticket); if (saved) this.live.delete(saved.entry.id); this.tickets.delete(ticket) }
  /** Only a live receipt whose actual file retirement settled may erase intent. */
  retired(ticket: object): void {
    const saved = this.owned(ticket)
    this.options.database.transaction(() => {
      this.current()
      const resolved = this.entries().filter(row => {
        if (row.entry.id === saved.entry.id) return true
        const previous = row.entry, removal = saved.entry
        return removal.kind === 'removal' && removal.phase === 'verified' && !this.live.has(previous.id) &&
          previous.profileId === removal.profileId && sameIdentity(previous.root, removal.root) && previous.taskId === removal.taskId &&
          sameAttachment(previous.attachment, removal.attachment) && (previous.kind === 'unreferenced' ||
            previous.kind === 'publication' && previous.file && removal.file && sameIdentity(previous.file, removal.file) && previous.digest === removal.digest)
      })
      for (const row of resolved) if (this.options.database.prepare('DELETE FROM settings WHERE key=? AND value=?').run(row.key, row.value).changes !== 1) reject('ATTACHMENT_JOURNAL_CHANGED')
    })()
    this.acknowledge(ticket)
  }
  observeMetadataChange(taskId: string, before: FileAttachmentRecord[], after: FileAttachmentRecord[]): void {
    if (!taskAttachmentRecords(before) || !taskAttachmentRecords(after)) reject()
    this.options.database.transaction(() => {
      const existing = this.entries()
      for (const record of before) {
        if (after.some(next => samePath(record, next)) || existing.some(row => row.entry.taskId === taskId && samePath(row.entry.attachment, record))) continue
        this.create('unreferenced', 'observed', taskId, record)
      }
    })()
  }
  /** Bounded facts only: no metadata mutation, traversal, read, unlink or replay. */
  inspect(): Array<{ entry: AttachmentJournalEntry; classification: AttachmentJournalClassification }> {
    return this.entries().map(({ entry }) => {
      let classification: AttachmentJournalClassification
      if (entry.profileId !== this.options.profileId || !sameIdentity(entry.root, this.root)) classification = 'foreign_owner'
      else {
        const current = this.taskScope(entry.taskId), records = this.references(entry.taskId)
        classification = !current || !records ? 'task_absent'
          : scopeFields.some(key => current[key] !== entry.scope[key]) ? 'scope_changed'
            : entry.kind === 'removal' && records.some(record => samePath(record, entry.attachment)) ? 'metadata_conflict'
            : records.some(record => sameAttachment(record, entry.attachment)) ? 'referenced'
              : records.some(record => samePath(record, entry.attachment)) ? 'metadata_conflict'
                : entry.kind === 'removal' ? 'cleanup_unconfirmed'
                  : entry.kind === 'publication' && entry.phase !== 'published' ? 'publication_unconfirmed' : 'unreferenced'
      }
      return { entry: structuredClone(entry), classification }
    })
  }
}
