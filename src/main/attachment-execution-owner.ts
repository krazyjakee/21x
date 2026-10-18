import { constants, lstatSync, realpathSync, type BigIntStats } from 'node:fs'
import { open, lstat, realpath, mkdir, rename, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseManager } from './database/manager'
import type { FileAttachmentRecord } from './database/types'
import { TaskAttachmentFileOwner } from './task-attachment-file-owner'
import { TASK_ATTACHMENT_LIMITS, taskAttachmentRecords } from '../shared/task-attachment-codecs'
import { isDatabaseId } from '../shared/database-desktop-codecs'
import type { AgentAttachmentExecution } from './agent-manager/host'
import { buildMessageWithAttachmentPreviews, type MessageAttachmentRef } from './agent-manager/attachments'

export const ATTACHMENT_EXECUTION_LIMITS = Object.freeze({ files: 128, bytes: 64 * 1024 * 1024, flights: 4, previewBytes: 24 * 1024, previewCount: 3, previewChars: 1200, pathBytes: 4096 })
export class AttachmentExecutionError extends Error {
  constructor(readonly code: 'ATTACHMENT_EXECUTION_REFUSED' | 'ATTACHMENT_EXECUTION_UNAVAILABLE' | 'ATTACHMENT_EXECUTION_BUSY' | 'ATTACHMENT_EXECUTION_CLOSED' | 'ATTACHMENT_EXECUTION_DRAIN_INCOMPLETE') { super(code); this.name = 'AttachmentExecutionError' }
}
function refuse(): never { throw new AttachmentExecutionError('ATTACHMENT_EXECUTION_REFUSED') }
const sameNode = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.isDirectory() === b.isDirectory() && a.isFile() === b.isFile()
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
interface Row { id: string; project_id: string; agent_id: string | null; parent_task_id: string | null; role: string; group_id: string | null; session_id: string | null; attachments: string }
interface Group { id: string; project_id: string; execution_task_id: string; agent_id: string | null; state: string }
interface Entry { taskId: string; record: FileAttachmentRecord; parts: string[]; reference: string }
interface Snapshot { signature: string; entries: Entry[]; own: FileAttachmentRecord[] }
interface Directory { handle: FileHandle; path: string; info: BigIntStats }
interface Temporary { directory: Directory; path: string; info?: BigIntStats; handle: FileHandle }
export interface AttachmentExecutionOwnerOptions {
  database: DatabaseManager
  files: TaskAttachmentFileOwner
  attachmentRoot: string
  workspaceRoot: string
  assertCurrent(): void
  /** Trusted real-I/O fixture boundary, never caller-selected filesystem code. */
  fs?: Partial<{ open: typeof open; mkdir: typeof mkdir; rename: typeof rename; unlink: typeof unlink }>
}

/** Private production copy/preview authority. Linux publication is relative to
 * held directory FDs; other platforms have no ambient-path fallback. Source
 * bytes come only from TaskAttachmentFileOwner's complete held-FD receipt. */
export class AttachmentExecutionOwner implements AgentAttachmentExecution {
  private readonly fs: Required<NonNullable<AttachmentExecutionOwnerOptions['fs']>>
  private readonly roots: Array<{ path: string; info: BigIntStats }> = []
  private readonly flights = new Set<Promise<unknown>>()
  private readonly handles = new Set<FileHandle>()
  private readonly closingHandles = new Map<FileHandle, Promise<void>>()
  private readonly temporaries = new Set<Temporary>()
  private tail: Promise<void> = Promise.resolve()
  private closing = false
  constructor(private readonly options: AttachmentExecutionOwnerOptions) {
    if (!(options.files instanceof TaskAttachmentFileOwner) || typeof options.assertCurrent !== 'function' || !isAbsolute(options.workspaceRoot) || normalize(options.workspaceRoot) !== options.workspaceRoot || Buffer.byteLength(options.workspaceRoot) > ATTACHMENT_EXECUTION_LIMITS.pathBytes) refuse()
    options.assertCurrent(); options.files.assertOwners(options.attachmentRoot)
    for (let path = options.workspaceRoot;; path = dirname(path)) {
      const info = lstatSync(path, { bigint: true })
      if (!info.isDirectory() || info.isSymbolicLink() || this.roots.length >= 64) refuse()
      this.roots.unshift({ path, info }); if (dirname(path) === path) break
    }
    if (realpathSync(options.workspaceRoot) !== options.workspaceRoot) refuse()
    const defaults = { open, mkdir, rename, unlink }
    for (const [key, value] of Object.entries(options.fs ?? {})) if (!Object.hasOwn(defaults, key) || typeof value !== 'function') refuse()
    this.fs = Object.freeze({ ...defaults, ...options.fs })
    this.options = Object.freeze({ ...options })
  }
  get inflightCount(): number { return this.flights.size + this.handles.size + this.temporaries.size }
  shutdown(): void { this.closing = true }
  private current(beforeEffect: () => void): void {
    beforeEffect()
    if (this.closing) throw new AttachmentExecutionError('ATTACHMENT_EXECUTION_CLOSED')
    this.options.assertCurrent(); this.options.files.assertOwners(this.options.attachmentRoot)
    if (!this.options.database.db.open) refuse()
  }
  private admit(beforeEffect: () => void): void {
    this.current(beforeEffect)
    if (this.flights.size >= ATTACHMENT_EXECUTION_LIMITS.flights || !this.flights.size && (this.handles.size || this.temporaries.size)) throw new AttachmentExecutionError('ATTACHMENT_EXECUTION_BUSY')
  }
  private run<T>(beforeEffect: () => void, effect: (guard: () => void) => Promise<T>): Promise<T> {
    try { this.admit(beforeEffect) } catch (error) { return Promise.reject(error) }
    let active = true
    const guard = (): void => { if (!active) refuse(); this.current(beforeEffect) }
    const previous = this.tail; let release!: () => void
    this.tail = new Promise<void>(resolve => { release = resolve })
    // Admit ownership before any trusted callback can synchronously reenter close.
    const raw = Promise.resolve().then(async () => { await previous; guard(); if (this.handles.size || this.temporaries.size) throw new AttachmentExecutionError('ATTACHMENT_EXECUTION_BUSY'); return effect(guard) }).then(value => { guard(); return value }).catch(error => {
      if (error instanceof AttachmentExecutionError || error instanceof Error && ['ServiceProtocolError', 'TaskGroupRequestScopeError'].includes(error.name)) throw error
      // Filesystem exceptions may contain private paths. Keep the new private
      // authority's generic failure finite while retaining all raw cleanup.
      throw new AttachmentExecutionError('ATTACHMENT_EXECUTION_REFUSED')
    }).finally(() => { active = false; release() })
    this.flights.add(raw); void raw.then(() => this.flights.delete(raw), () => this.flights.delete(raw)); return raw
  }
  private async step<T>(guard: () => void, effect: () => Promise<T>): Promise<T> { guard(); const result = await effect(); guard(); return result }
  private capture(taskId: string): Snapshot {
    if (!isDatabaseId(taskId)) refuse()
    const db = this.options.database.db
    if (db.prepare("SELECT 1 FROM task_groups WHERE execution_task_id=? AND state='active' AND (length(CAST(id AS BLOB))>128 OR length(CAST(project_id AS BLOB))>128 OR length(CAST(execution_task_id AS BLOB))>128 OR COALESCE(length(CAST(agent_id AS BLOB)),0)>128) LIMIT 1").get(taskId)) refuse()
    const rawGroup = db.prepare("SELECT id,project_id,execution_task_id,agent_id,state FROM task_groups WHERE execution_task_id=? AND state='active' LIMIT 2").all(taskId) as Group[]
    if (rawGroup.length > 1 || rawGroup.some(group => [group.id, group.project_id, group.execution_task_id, group.agent_id ?? ''].some(value => typeof value !== 'string' || Buffer.byteLength(value) > 128))) refuse()
    const group = rawGroup[0]
    const where = group ? 'id=? OR id IN (SELECT task_id FROM task_group_memberships WHERE group_id=? AND left_at IS NULL)' : 'id=?'
    const params = group ? [taskId, group.id] : [taskId]
    // Refuse oversized metadata/scalars in SQL before materializing JSON/rows.
    const bounds = { id: 128, project_id: 128, agent_id: 128, parent_task_id: 128, role: 32, group_id: 128, session_id: 512, attachments: TASK_ATTACHMENT_LIMITS.metadataBytes }
    const invalid = Object.entries(bounds).map(([field, bytes]) => `COALESCE(length(CAST(${field} AS BLOB)),0)>${bytes}`).join(' OR ')
    if (db.prepare(`SELECT 1 FROM tasks WHERE (${where}) AND (${invalid}) LIMIT 1`).get(...params)) refuse()
    const rows = db.prepare(`SELECT ${Object.keys(bounds).join(',')} FROM tasks WHERE ${where} ORDER BY id LIMIT 129`).all(...params) as Row[]
    if (rows.length > 128) refuse()
    const root = rows.find(row => row.id === taskId), entries: Entry[] = []
    if (!root) { if (group || rows.length) refuse(); return { signature: 'absent', entries, own: [] } }
    if (group ? root.role !== 'task_group' || root.project_id !== group.project_id : root.role === 'task_group') refuse()
    if (group && db.prepare('SELECT 1 FROM task_group_memberships WHERE group_id=? AND left_at IS NULL AND (length(CAST(id AS BLOB))>128 OR length(CAST(task_id AS BLOB))>128 OR length(CAST(joined_at AS BLOB))>64) LIMIT 1').get(group.id)) refuse()
    const memberships = group ? db.prepare('SELECT id,task_id,position,joined_at FROM task_group_memberships WHERE group_id=? AND left_at IS NULL ORDER BY position,id LIMIT 129').all(group.id) : []
    if (memberships.length > 128 || group && !memberships.length) refuse()
    let total = 0, own: FileAttachmentRecord[] = []
    for (const row of rows) {
      if (!isDatabaseId(row.id) || !isDatabaseId(row.project_id) || row.project_id !== root.project_id || row.id !== taskId && (!group || row.group_id !== group.id || row.role !== 'task')) refuse()
      let records: FileAttachmentRecord[]
      try { records = JSON.parse(row.attachments) } catch { refuse() }
      if (!taskAttachmentRecords(records)) refuse()
      if (row.id === taskId) own = records
      const filenames = new Set<string>()
      for (const record of records) {
        total += record.size
        if (entries.length >= ATTACHMENT_EXECUTION_LIMITS.files || total > ATTACHMENT_EXECUTION_LIMITS.bytes || filenames.has(record.filename)) refuse()
        filenames.add(record.filename)
        const parts = row.id === taskId ? [record.filename] : [`task-${row.id}`, `${record.id}-${record.filename}`]
        entries.push({ taskId: row.id, record, parts, reference: row.id === taskId ? `- attachments/${record.filename}` : `- Task ${row.id}: attachments/${parts.join('/')}` })
      }
    }
    return { signature: JSON.stringify([rows, rawGroup, memberships]), entries, own }
  }
  private scoped(taskId: string, guard: () => void, scope: Snapshot) {
    const current = (): void => { guard(); if (this.capture(taskId).signature !== scope.signature) refuse() }
    current(); return { ...scope, guard: current }
  }
  private async closeHandle(handle: FileHandle): Promise<void> {
    if (!this.handles.has(handle)) return
    if (!this.closingHandles.has(handle)) {
      const raw = Promise.resolve().then(() => handle.close()); this.closingHandles.set(handle, raw)
      void raw.then(() => { this.handles.delete(handle); this.closingHandles.delete(handle) }, () => { if (this.closingHandles.get(handle) === raw) this.closingHandles.delete(handle) })
    }
    await this.closingHandles.get(handle)
  }
  private async openDirectory(path: string, guard: () => void): Promise<Directory> {
    guard()
    const handle = await this.fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    this.handles.add(handle)
    try {
      guard()
      const info = await this.step(guard, () => handle.stat({ bigint: true }))
      if (!info.isDirectory() || info.isSymbolicLink()) refuse()
      return { handle, path, info }
    } catch (error) { await this.closeHandle(handle); throw error }
  }
  private relative(directory: Directory, name: string): string { return `/proc/self/fd/${directory.handle.fd}/${name}` }
  private async verify(directories: Directory[], guard: () => void): Promise<void> {
    for (const root of this.roots) {
      const info = await this.step(guard, () => lstat(root.path, { bigint: true }))
      if (!info.isDirectory() || info.isSymbolicLink() || !sameNode(info, root.info)) refuse()
    }
    for (const directory of directories) {
      const named = await this.step(guard, () => lstat(directory.path, { bigint: true })), held = await this.step(guard, () => directory.handle.stat({ bigint: true }))
      if (!named.isDirectory() || named.isSymbolicLink() || !sameNode(named, directory.info) || !sameNode(held, directory.info) || await this.step(guard, () => realpath(directory.path)) !== directory.path) refuse()
    }
  }
  private async child(parent: Directory, name: string, guard: () => void): Promise<Directory> {
    try { await this.step(guard, () => this.fs.mkdir(this.relative(parent, name), { mode: 0o700 })) } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error; guard() }
    const directory = await this.openDirectory(this.relative(parent, name), guard)
    return { ...directory, path: join(parent.path, name) }
  }
  private async cleanup(temporary: Temporary): Promise<void> {
    try {
      const info = temporary.info ?? await temporary.handle.stat({ bigint: true })
      const named = await lstat(temporary.path, { bigint: true })
      if (!info.isFile() || !named.isFile() || named.isSymbolicLink() || !sameNode(named, info)) refuse()
      await this.fs.unlink(temporary.path)
    } catch (error) { if (!missing(error)) throw error }
    this.temporaries.delete(temporary)
  }
  sync(taskId: string, workspaceDir: string, beforeEffect: () => void): Promise<string[]> {
    let initial: Snapshot
    try { this.admit(beforeEffect); initial = this.capture(taskId) } catch (error) { return Promise.reject(error) }
    return this.run(beforeEffect, async current => {
      const scope = this.scoped(taskId, current, initial)
      if (!scope.entries.length) return []
      if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) throw new AttachmentExecutionError('ATTACHMENT_EXECUTION_UNAVAILABLE')
      if (workspaceDir !== join(this.options.workspaceRoot, taskId)) refuse()
      const directories: Directory[] = [], opened: FileHandle[] = []
      try {
        const root = await this.openDirectory(this.options.workspaceRoot, scope.guard); directories.push(root); opened.push(root.handle)
        if (!sameNode(root.info, this.roots[this.roots.length - 1].info)) refuse()
        const workspace = await this.openDirectory(this.relative(root, taskId), scope.guard)
        workspace.path = workspaceDir; directories.push(workspace); opened.push(workspace.handle)
        await this.verify(directories, scope.guard)
        const attachments = await this.child(workspace, 'attachments', scope.guard); directories.push(attachments); opened.push(attachments.handle)
        const members = new Map<string, Directory>()
        for (const entry of scope.entries) {
          let destination = attachments
          if (entry.parts.length === 2) {
            const name = entry.parts[0]
            if (!members.has(name)) { const member = await this.child(attachments, name, scope.guard); members.set(name, member); directories.push(member); opened.push(member.handle) }
            destination = members.get(name)!
          }
          await this.verify(directories, scope.guard)
          const path = this.relative(destination, `.21x-attachment-${randomUUID()}.tmp`)
          const handle = await this.fs.open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
          this.handles.add(handle); opened.push(handle)
          const temporary: Temporary = { directory: destination, path, handle }; this.temporaries.add(temporary)
          const info = await handle.stat({ bigint: true })
          if (!info.isFile() || info.nlink !== 1n || info.size !== 0n) refuse()
          temporary.info = info
          // Source verification and held-FD close finish before rename admits
          // the workspace publication. No consumer path can reopen the source.
          const digest = createHash('sha256')
          await this.options.files.readForExecution(entry.taskId, entry.record, { beforeEffect: scope.guard, signal: new AbortController().signal }, async read => {
            let offset = 0
            while (offset < entry.record.size) {
              const bytes = await read(offset, Math.min(65536, entry.record.size - offset)); let written = 0
              while (written < bytes.length) {
                await this.verify(directories, scope.guard)
                const result = await this.step(scope.guard, () => handle.write(bytes, written, bytes.length - written, offset + written))
                if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten < 1 || result.bytesWritten > bytes.length - written) refuse()
                digest.update(bytes.subarray(written, written + result.bytesWritten))
                written += result.bytesWritten
              }
              offset += bytes.length
            }
            await this.step(scope.guard, () => handle.sync())
          })
          await this.verify(directories, scope.guard)
          const ready = await this.step(scope.guard, () => handle.stat({ bigint: true })), named = await this.step(scope.guard, () => lstat(path, { bigint: true }))
          if (!sameNode(ready, info) || !sameNode(named, info) || ready.size !== BigInt(entry.record.size) || named.size !== ready.size || ready.nlink !== 1n || named.nlink !== 1n) refuse()
          const copied = createHash('sha256'), buffer = Buffer.alloc(Math.min(65536, entry.record.size)); let checked = 0
          while (checked < entry.record.size) {
            const result = await this.step(scope.guard, () => handle.read(buffer, 0, Math.min(buffer.length, entry.record.size - checked), checked))
            if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 1 || result.bytesRead > Math.min(buffer.length, entry.record.size - checked)) refuse()
            copied.update(buffer.subarray(0, result.bytesRead)); checked += result.bytesRead
          }
          const verified = await this.step(scope.guard, () => handle.stat({ bigint: true }))
          if (!sameNode(ready, verified) || verified.size !== ready.size || verified.mtimeNs !== ready.mtimeNs || verified.ctimeNs !== ready.ctimeNs || copied.digest('hex') !== digest.digest('hex')) refuse()
          await this.verify(directories, scope.guard)
          // rename replaces the exact directory entry, including a hostile
          // symlink; it never opens/truncates a pre-existing destination file.
          await this.step(scope.guard, () => this.fs.rename(path, this.relative(destination, entry.parts[entry.parts.length - 1])))
          this.temporaries.delete(temporary)
          await this.verify(directories, scope.guard)
          const published = await this.step(scope.guard, () => lstat(this.relative(destination, entry.parts[entry.parts.length - 1]), { bigint: true }))
          if (!sameNode(published, ready) || published.size !== ready.size || published.nlink !== 1n) refuse()
          await this.closeHandle(handle)
        }
        scope.guard(); return scope.entries.map(entry => entry.reference)
      } finally {
        const cleanup = await Promise.allSettled([...this.temporaries].filter(item => directories.includes(item.directory)).map(item => this.cleanup(item)))
        if (cleanup.some(result => result.status === 'rejected')) throw new AttachmentExecutionError('ATTACHMENT_EXECUTION_DRAIN_INCOMPLETE')
        const closed = await Promise.allSettled(opened.map(handle => this.closeHandle(handle)))
        if (closed.some(result => result.status === 'rejected')) throw new AttachmentExecutionError('ATTACHMENT_EXECUTION_DRAIN_INCOMPLETE')
      }
    })
  }
  context(taskId: string, _workspaceDir: string | undefined, message: string, attachments: MessageAttachmentRef[] | undefined, beforeEffect: () => void): Promise<string> {
    let initial: Snapshot
    try { this.admit(beforeEffect); if (attachments !== undefined && (!Array.isArray(attachments) || attachments.length > 128)) refuse(); initial = this.capture(taskId) } catch (error) { return Promise.reject(error) }
    const requested = attachments?.map(record => ({ ...record }))
    return this.run(beforeEffect, async current => {
      const scope = this.scoped(taskId, current, initial)
      if (!requested?.length) return message
      if (process.platform !== 'linux') throw new AttachmentExecutionError('ATTACHMENT_EXECUTION_UNAVAILABLE')
      if (requested.length > 128) refuse()
      const records = requested.map(input => scope.own.find(record => record.id === input.id && record.filename === input.filename && record.size === input.size && record.mime_type === input.mime_type) ?? refuse())
      const previews: string[] = []
      for (const record of records.slice(0, 10)) {
        if (previews.length >= ATTACHMENT_EXECUTION_LIMITS.previewCount) break
        if (record.size > ATTACHMENT_EXECUTION_LIMITS.previewBytes || !(record.mime_type.startsWith('text/') || /\.(md|txt|json|ya?ml|xml|csv|tsx?|jsx?|py|java|go|rb|rs|sql)$/i.test(record.filename))) continue
        const bytes = await this.options.files.readForExecution(taskId, record, { beforeEffect: scope.guard, signal: new AbortController().signal }, read => record.size ? read(0, record.size) : Promise.resolve(Buffer.alloc(0)))
        scope.guard(); const text = bytes.toString('utf8'), suffix = text.length > ATTACHMENT_EXECUTION_LIMITS.previewChars ? '\n...[truncated]' : ''
        previews.push(`### attachments/${record.filename}\n\`\`\`\n${text.slice(0, ATTACHMENT_EXECUTION_LIMITS.previewChars)}${suffix}\n\`\`\``)
      }
      scope.guard(); return buildMessageWithAttachmentPreviews(message, requested, previews)
    })
  }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid attachment execution drain deadline')
    this.shutdown(); let timer: ReturnType<typeof setTimeout> | undefined
    const drain = async (): Promise<void> => {
      while (this.flights.size) await Promise.allSettled([...this.flights])
      await Promise.all([...this.temporaries].map(item => this.cleanup(item)))
      await Promise.all([...this.handles].map(handle => this.closeHandle(handle)))
    }
    try { await Promise.race([drain(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AttachmentExecutionError('ATTACHMENT_EXECUTION_DRAIN_INCOMPLETE')), timeoutMs) })]) }
    catch { throw new AttachmentExecutionError('ATTACHMENT_EXECUTION_DRAIN_INCOMPLETE') }
    finally { if (timer) clearTimeout(timer) }
  }
}
