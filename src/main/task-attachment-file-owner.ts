import { AsyncLocalStorage } from 'node:async_hooks'
import { constants, lstatSync, realpathSync, type BigIntStats } from 'node:fs'
import { lstat, realpath, mkdir, open, link, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import type { FileAttachmentRecord } from './database/types'
import { TASK_ATTACHMENT_LIMITS, taskAttachmentFilename, taskAttachmentId, taskAttachmentRecord } from '../shared/task-attachment-codecs'

export interface TaskAttachmentFileControls { beforeEffect(): void; signal: AbortSignal }
export interface TaskAttachmentFileHandle {
  stat(): Promise<BigIntStats>
  write(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesWritten: number; buffer: Buffer }>
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number; buffer: Buffer }>
  sync(): Promise<void>
  close(): Promise<void>
}
export interface TaskAttachmentFilePrimitives {
  lstat(path: string): Promise<BigIntStats>
  realpath(path: string): Promise<string>
  mkdir(path: string): Promise<void>
  open(path: string, flags: number, mode?: number): Promise<TaskAttachmentFileHandle>
  link(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}
export interface TaskAttachmentFileOwnerOptions { attachmentRoot: string; assertCurrent(): void; fs?: Partial<TaskAttachmentFilePrimitives> }
export type TaskAttachmentFileCode = 'ATTACHMENT_INVALID_ARGUMENTS' | 'ATTACHMENT_PATH_REFUSED' | 'ATTACHMENT_PATH_CHANGED' | 'ATTACHMENT_CAPACITY' | 'ATTACHMENT_CLOSED' | 'ATTACHMENT_CANCELLED' | 'ATTACHMENT_BUSY' | 'ATTACHMENT_IO_FAILED' | 'ATTACHMENT_CLOSE_FAILED' | 'ATTACHMENT_DRAIN_INCOMPLETE'
export class TaskAttachmentFileError extends Error { constructor(readonly code: TaskAttachmentFileCode) { super(code); this.name = 'TaskAttachmentFileError' } }
function fail(code: TaskAttachmentFileCode): never { throw new TaskAttachmentFileError(code) }
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const sameNode = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.isDirectory() === b.isDirectory() && a.isFile() === b.isFile()
const sameBytes = (a: BigIntStats, b: BigIntStats): boolean => sameNode(a, b) && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
interface DirectoryProof { taskId: string; path: string; info: BigIntStats }
interface Handle { fd: TaskAttachmentFileHandle; closing?: Promise<void> }
interface Publication { proof: DirectoryProof; paths: Set<string>; info: BigIntStats; digest: string; size: number; receipt: object }

/** A protected attachment root, distinct from task workspaces. All filenames
 * come from UUID + saved metadata; native callers never supply a root/path. */
export class TaskAttachmentFileOwner {
  private readonly root: string
  private readonly roots: ReadonlyArray<{ path: string; info: BigIntStats }>
  private readonly ownerCurrent: () => void
  private readonly fs: TaskAttachmentFilePrimitives
  private readonly tasks = new Map<string, BigIntStats>()
  private readonly handles = new Set<Handle>()
  private readonly flights = new Set<Promise<unknown>>()
  private readonly publications = new WeakMap<object, Publication>()
  private readonly retiring = new Set<Publication>()
  private readonly pendingPublications = new Set<Publication>()
  private readonly cleanupWork = new Map<Publication, Promise<void>>()
  private readonly guards = new AsyncLocalStorage<() => void>()
  private readonly busy = new Set<string>()
  private closing = false
  private drain?: Promise<void>
  constructor(options: TaskAttachmentFileOwnerOptions) {
    if (!options || !isAbsolute(options.attachmentRoot) || normalize(options.attachmentRoot) !== options.attachmentRoot || Buffer.byteLength(options.attachmentRoot) > 4096 || /[\u0000-\u001f\u007f]/.test(options.attachmentRoot) || typeof options.assertCurrent !== 'function') fail('ATTACHMENT_INVALID_ARGUMENTS')
    options.assertCurrent(); this.root = options.attachmentRoot; this.ownerCurrent = options.assertCurrent
    const chain: Array<{ path: string; info: BigIntStats }> = []
    try {
      if (realpathSync(this.root) !== this.root) fail('ATTACHMENT_PATH_REFUSED')
      for (let path = this.root;; path = dirname(path)) {
        const info = lstatSync(path, { bigint: true }); if (!info.isDirectory() || info.isSymbolicLink() || chain.length >= 64) fail('ATTACHMENT_PATH_REFUSED')
        chain.unshift({ path, info }); if (dirname(path) === path) break
      }
    } catch { fail('ATTACHMENT_PATH_REFUSED') }
    this.roots = Object.freeze(chain)
    const defaults: TaskAttachmentFilePrimitives = { lstat: path => lstat(path, { bigint: true }), realpath, mkdir: async path => { await mkdir(path, { mode: 0o700 }) }, link, unlink, open: async (path, flags, mode) => {
      const fd = await open(path, flags, mode)
      return { stat: () => fd.stat({ bigint: true }), read: (buffer, offset, length, position) => fd.read(buffer, offset, length, position), write: (buffer, offset, length, position) => fd.write(buffer, offset, length, position), sync: () => fd.sync(), close: () => fd.close() }
    } }
    for (const [key, value] of Object.entries(options.fs ?? {})) if (!Object.hasOwn(defaults, key) || typeof value !== 'function') fail('ATTACHMENT_INVALID_ARGUMENTS')
    this.fs = Object.freeze({ ...defaults, ...options.fs })
  }
  get inflightCount(): number { return this.flights.size + this.handles.size + this.retiring.size + this.pendingPublications.size }
  assertOwners(root: string): void { if (root !== this.root) fail('ATTACHMENT_INVALID_ARGUMENTS'); if (this.closing) fail('ATTACHMENT_CLOSED') }
  shutdown(): void { this.closing = true }
  private profile(): void { this.ownerCurrent() }
  private current(controls: TaskAttachmentFileControls): void { this.guards.getStore()?.(); controls.beforeEffect(); if (this.closing) fail('ATTACHMENT_CLOSED'); if (controls.signal.aborted) fail('ATTACHMENT_CANCELLED'); this.profile() }
  private async step<T>(controls: TaskAttachmentFileControls, effect: () => Promise<T>): Promise<T> { this.current(controls); const value = await effect(); this.current(controls); return value }
  private run<T>(taskId: string, controls: TaskAttachmentFileControls, effect: (controls: TaskAttachmentFileControls) => Promise<T>, onRejected?: () => Promise<void>): Promise<T> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId) || !controls || typeof controls.beforeEffect !== 'function' || !controls.signal) return Promise.reject(new TaskAttachmentFileError('ATTACHMENT_INVALID_ARGUMENTS'))
    try { this.current(controls); if (this.flights.size >= 16 || this.handles.size || this.retiring.size || this.busy.has(taskId)) fail('ATTACHMENT_BUSY') } catch (error) { return Promise.reject(error) }
    const parent = this.guards.getStore(); let active = true
    const captured = Object.freeze({ ...controls, beforeEffect: () => { if (!active) fail('ATTACHMENT_CANCELLED'); parent?.(); controls.beforeEffect() } })
    this.busy.add(taskId)
    const raw = this.guards.run(captured.beforeEffect, () => Promise.resolve().then(() => effect(captured)).then(value => { this.current(captured); return value }).catch(async error => {
      if (onRejected) await onRejected()
      if (error instanceof TaskAttachmentFileError) throw error; this.current(captured); if (error instanceof Error && error.name === 'ServiceProtocolError') throw error; fail('ATTACHMENT_IO_FAILED')
    }).finally(() => { active = false; this.busy.delete(taskId) }))
    this.flights.add(raw); void raw.then(() => this.flights.delete(raw), () => this.flights.delete(raw)); return raw
  }
  private async rootProof(): Promise<void> {
    this.profile()
    for (const root of this.roots) { const current = await this.fs.lstat(root.path); this.profile(); if (!current.isDirectory() || current.isSymbolicLink() || !sameNode(root.info, current)) fail('ATTACHMENT_PATH_CHANGED') }
    if (await this.fs.realpath(this.root) !== this.root) fail('ATTACHMENT_PATH_CHANGED'); this.profile()
  }
  private async directory(taskId: string, create: boolean, controls: TaskAttachmentFileControls): Promise<DirectoryProof | null> {
    await this.step(controls, () => this.rootProof()); const path = join(this.root, taskId); let info: BigIntStats
    try { info = await this.step(controls, () => this.fs.lstat(path)) } catch (error) {
      if (!missing(error)) throw error
      if (this.tasks.has(taskId)) fail('ATTACHMENT_PATH_CHANGED')
      if (!create) { await this.step(controls, () => this.rootProof()); return null }
      await this.step(controls, () => this.fs.mkdir(path)); info = await this.step(controls, () => this.fs.lstat(path))
    }
    if (!info.isDirectory() || info.isSymbolicLink() || await this.step(controls, () => this.fs.realpath(path)) !== path) fail('ATTACHMENT_PATH_REFUSED')
    const old = this.tasks.get(taskId); if (old && !sameNode(old, info)) fail('ATTACHMENT_PATH_CHANGED')
    if (!old && this.tasks.size >= 4096) fail('ATTACHMENT_CAPACITY'); this.tasks.set(taskId, info)
    const proof = { taskId, path, info }; await this.verifyDirectory(proof); this.current(controls); return proof
  }
  private async verifyDirectory(proof: DirectoryProof): Promise<void> {
    await this.rootProof(); const info = await this.fs.lstat(proof.path); this.profile()
    if (!info.isDirectory() || info.isSymbolicLink() || !sameNode(info, proof.info) || await this.fs.realpath(proof.path) !== proof.path) fail('ATTACHMENT_PATH_CHANGED'); this.profile()
  }
  private file(info: BigIntStats, size?: number, links = 1): void { if (!info.isFile() || info.isSymbolicLink() || info.nlink !== BigInt(links) || info.size < 0n || info.size > BigInt(TASK_ATTACHMENT_LIMITS.imageBytes) || size !== undefined && info.size !== BigInt(size)) fail(info.size > BigInt(TASK_ATTACHMENT_LIMITS.imageBytes) ? 'ATTACHMENT_CAPACITY' : 'ATTACHMENT_PATH_REFUSED') }
  private async openOwned(path: string, flags: number, controls?: TaskAttachmentFileControls): Promise<Handle> {
    if (controls) this.current(controls); else this.profile()
    const fd = await this.fs.open(path, flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600), receipt = { fd }
    this.handles.add(receipt)
    // Capture a late accepted FD before any cancellation assertion can throw.
    return receipt
  }
  private async closeHandle(receipt: Handle): Promise<void> {
    if (!this.handles.has(receipt)) return
    if (!receipt.closing) { const raw = Promise.resolve().then(() => receipt.fd.close()); receipt.closing = raw; void raw.then(() => this.handles.delete(receipt), () => { if (receipt.closing === raw) receipt.closing = undefined }) }
    try { await receipt.closing } catch { fail('ATTACHMENT_CLOSE_FAILED') }
  }
  private async bytes(fd: TaskAttachmentFileHandle, size: number): Promise<Buffer> {
    if (size > TASK_ATTACHMENT_LIMITS.imageBytes) fail('ATTACHMENT_CAPACITY')
    const out = Buffer.alloc(size); let read = 0
    while (read < size) { this.profile(); const result = await fd.read(out, read, Math.min(65536, size - read), read); if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 1 || result.bytesRead > size - read) fail('ATTACHMENT_PATH_CHANGED'); read += result.bytesRead }
    return out
  }
  /** Receipts are owner-produced opaque objects, never accepted over RPC. */
  write(taskId: string, attachment: FileAttachmentRecord, rawBytes: Buffer, controls: TaskAttachmentFileControls): Promise<object> {
    if (!taskAttachmentRecord(attachment) || !Buffer.isBuffer(rawBytes) || attachment.size !== rawBytes.length || rawBytes.length > TASK_ATTACHMENT_LIMITS.imageBytes) return Promise.reject(new TaskAttachmentFileError('ATTACHMENT_INVALID_ARGUMENTS'))
    const metadata = Object.freeze({ ...attachment }), bytes = Buffer.from(rawBytes)
    let accepted: Publication | undefined
    return this.run(taskId, controls, async guard => {
      const proof = (await this.directory(taskId, true, guard))!, path = join(proof.path, `${metadata.id}-${metadata.filename}`), stage = join(proof.path, `.attachment-${randomUUID()}.tmp`)
      let handle: Handle | undefined, publication: Publication | undefined, written = 0
      try {
        handle = await this.openOwned(stage, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, guard)
        const initial = await handle.fd.stat(); this.file(initial, 0)
        publication = { proof, paths: new Set([stage]), info: initial, digest: hash(bytes), size: bytes.length, receipt: Object.freeze({}) }
        accepted = publication
        this.retiring.add(publication); this.current(guard); await this.verifyDirectory(proof)
        while (written < bytes.length) { this.current(guard); const result = await handle.fd.write(bytes, written, Math.min(65536, bytes.length - written), written); if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten < 1 || result.bytesWritten > bytes.length - written) fail('ATTACHMENT_IO_FAILED'); written += result.bytesWritten; this.current(guard) }
        const ready = await handle.fd.stat(); this.file(ready, bytes.length); if (!sameNode(initial, ready) || hash(await this.bytes(handle.fd, bytes.length)) !== publication.digest) fail('ATTACHMENT_PATH_CHANGED')
        await handle.fd.sync(); this.current(guard); const verified = await handle.fd.stat(); if (!sameBytes(ready, verified)) fail('ATTACHMENT_PATH_CHANGED'); publication.info = verified
        await this.closeHandle(handle); handle = undefined; this.current(guard); await this.verifyDirectory(proof)
        const current = await this.step(guard, () => this.fs.lstat(stage)); if (!sameBytes(current, verified)) fail('ATTACHMENT_PATH_CHANGED')
        // link is atomic no-replace publication; rename-overwrite is never used.
        this.current(guard); await this.fs.link(stage, path); publication.paths.add(path)
        this.current(guard); await this.verifyDirectory(proof)
        const linked = await this.fs.lstat(path); this.file(linked, bytes.length, 2); if (!sameNode(linked, verified)) fail('ATTACHMENT_PATH_CHANGED')
        const staged = await this.fs.lstat(stage); if (!sameBytes(linked, staged)) fail('ATTACHMENT_PATH_CHANGED')
        this.current(guard); await this.fs.unlink(stage); publication.paths.delete(stage)
        const final = await this.fs.lstat(path); this.file(final, bytes.length); if (!sameNode(final, verified) || final.mtimeNs !== verified.mtimeNs) fail('ATTACHMENT_PATH_CHANGED'); publication.info = final
        this.current(guard); await this.verifyDirectory(proof)
        this.publications.set(publication.receipt, publication); this.pendingPublications.add(publication); this.retiring.delete(publication); return publication.receipt
      } catch (error) {
        if (handle) {
          // An acknowledged prefix is still ours. An unacknowledged partial
          // syscall or a changed prefix remains preserved for explicit repair.
          if (publication) {
            const info = await handle.fd.stat(); this.file(info)
            if (sameNode(info, publication.info) && info.size === BigInt(written) && hash(await this.bytes(handle.fd, written)) === hash(bytes.subarray(0, written)) && sameBytes(info, await handle.fd.stat())) {
              publication.info = info; publication.size = written; publication.digest = hash(bytes.subarray(0, written))
            }
          }
          await this.closeHandle(handle); handle = undefined
        }
        if (publication) await this.cleanup(publication)
        if (error instanceof TaskAttachmentFileError) throw error
        this.current(guard); fail('ATTACHMENT_IO_FAILED')
      }
    }, async () => { if (accepted && (this.retiring.has(accepted) || this.pendingPublications.has(accepted))) { this.retiring.add(accepted); await this.cleanup(accepted) } })
  }
  /** Pure bookkeeping after the synchronous durable metadata commit. */
  commit(receipt: unknown): void { if (!receipt || typeof receipt !== 'object') fail('ATTACHMENT_INVALID_ARGUMENTS'); const publication = this.publications.get(receipt); if (!publication) fail('ATTACHMENT_INVALID_ARGUMENTS'); this.pendingPublications.delete(publication); this.publications.delete(receipt) }
  rollback(receipt: unknown): Promise<void> {
    if (!receipt || typeof receipt !== 'object') return Promise.reject(new TaskAttachmentFileError('ATTACHMENT_INVALID_ARGUMENTS'))
    const publication = this.publications.get(receipt); if (!publication) return Promise.reject(new TaskAttachmentFileError('ATTACHMENT_INVALID_ARGUMENTS'))
    this.retiring.add(publication); const raw = this.cleanup(publication); this.flights.add(raw); void raw.then(() => this.flights.delete(raw), () => this.flights.delete(raw)); return raw
  }
  private cleanup(publication: Publication): Promise<void> {
    const previous = this.cleanupWork.get(publication); if (previous) return previous
    const raw = this.performCleanup(publication); this.cleanupWork.set(publication, raw)
    void raw.then(() => this.cleanupWork.delete(publication), () => this.cleanupWork.delete(publication)); return raw
  }
  private async performCleanup(publication: Publication): Promise<void> {
    this.profile(); if (this.handles.size) fail('ATTACHMENT_CLOSE_FAILED')
    await this.verifyDirectory(publication.proof)
    const present: Array<{ path: string; info: BigIntStats }> = []
    for (const path of publication.paths) { try { present.push({ path, info: await this.fs.lstat(path) }) } catch (error) { if (!missing(error)) throw error; publication.paths.delete(path) } }
    if (!present.length) { this.retiring.delete(publication); this.pendingPublications.delete(publication); this.publications.delete(publication.receipt); return }
    for (const item of present) {
      this.file(item.info, publication.size, present.length); if (!sameNode(item.info, publication.info)) fail('ATTACHMENT_PATH_CHANGED')
      const handle = await this.openOwned(item.path, constants.O_RDONLY)
      try { const stat = await handle.fd.stat(); if (!sameBytes(stat, item.info) || hash(await this.bytes(handle.fd, publication.size)) !== publication.digest || !sameBytes(await handle.fd.stat(), item.info)) fail('ATTACHMENT_PATH_CHANGED') } finally { await this.closeHandle(handle) }
      await this.verifyDirectory(publication.proof); if (!sameBytes(await this.fs.lstat(item.path), item.info)) fail('ATTACHMENT_PATH_CHANGED')
    }
    // Every named link is ours and every byte verified before the first unlink.
    for (const item of present) {
      await this.verifyDirectory(publication.proof); const actual = await this.fs.lstat(item.path)
      if (!sameNode(actual, item.info) || actual.size !== BigInt(publication.size) || actual.mtimeNs !== item.info.mtimeNs || actual.nlink !== BigInt(publication.paths.size)) fail('ATTACHMENT_PATH_CHANGED')
      this.profile(); await this.fs.unlink(item.path); publication.paths.delete(item.path)
    }
    this.retiring.delete(publication); this.pendingPublications.delete(publication); this.publications.delete(publication.receipt)
  }
  remove(taskId: string, attachment: FileAttachmentRecord, controls: TaskAttachmentFileControls): Promise<void> {
    if (!taskAttachmentRecord(attachment) || !taskAttachmentId(attachment.id) || !taskAttachmentFilename(attachment.filename)) return Promise.reject(new TaskAttachmentFileError('ATTACHMENT_INVALID_ARGUMENTS'))
    const metadata = Object.freeze({ ...attachment })
    return this.run(taskId, controls, async guard => {
      if (metadata.size > TASK_ATTACHMENT_LIMITS.imageBytes) fail('ATTACHMENT_CAPACITY')
      const proof = await this.directory(taskId, false, guard); if (!proof) return
      const path = join(proof.path, `${metadata.id}-${metadata.filename}`); let before: BigIntStats
      try { before = await this.step(guard, () => this.fs.lstat(path)) } catch (error) { if (!missing(error)) throw error; await this.verifyDirectory(proof); this.current(guard); return }
      this.file(before, metadata.size); const handle = await this.openOwned(path, constants.O_RDONLY, guard)
      try { this.current(guard); const fdInfo = await this.step(guard, () => handle.fd.stat()); if (!sameBytes(before, fdInfo)) fail('ATTACHMENT_PATH_CHANGED'); await this.step(guard, () => this.bytes(handle.fd, metadata.size)); if (!sameBytes(before, await this.step(guard, () => handle.fd.stat()))) fail('ATTACHMENT_PATH_CHANGED') } finally { await this.closeHandle(handle) }
      await this.verifyDirectory(proof); const after = await this.step(guard, () => this.fs.lstat(path)); if (!sameBytes(before, after)) fail('ATTACHMENT_PATH_CHANGED')
      this.current(guard); await this.fs.unlink(path); this.current(guard); await this.verifyDirectory(proof)
    })
  }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid attachment close deadline')
    this.shutdown(); let timer: ReturnType<typeof setTimeout> | undefined
    if (!this.drain) { const raw = (async () => { while (this.flights.size) await Promise.allSettled([...this.flights]); for (const handle of [...this.handles]) await this.closeHandle(handle); for (const publication of new Set([...this.retiring, ...this.pendingPublications])) await this.cleanup(publication); if (this.handles.size || this.retiring.size || this.pendingPublications.size) fail('ATTACHMENT_DRAIN_INCOMPLETE') })(); this.drain = raw; void raw.then(() => { if (this.drain === raw) this.drain = undefined }, () => { if (this.drain === raw) this.drain = undefined }) }
    const drain = this.drain
    try { await Promise.race([drain, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TaskAttachmentFileError('ATTACHMENT_DRAIN_INCOMPLETE')), timeoutMs) })]) } finally { if (timer) clearTimeout(timer) }
  }
}
