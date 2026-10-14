import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeSync, linkSync, renameSync, unlinkSync, type BigIntStats } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, normalize } from 'node:path'

export const HEARTBEAT_FILE_MAX_BYTES = 128 * 1024
export interface HeartbeatWorkspaceReceipt { dev: string; ino: string }
interface Identity extends HeartbeatWorkspaceReceipt { kind: 'file' | 'directory'; size: bigint; nlink: bigint; mtime: bigint; ctime: bigint }
export interface HeartbeatFilePrimitives {
  lstat(path: string): BigIntStats
  realpath(path: string): string
  mkdir(path: string): void
  open(path: string, flags: number, mode?: number): number
  fstat(fd: number): BigIntStats
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number
  write(fd: number, buffer: Buffer, offset: number, length: number, position: number): number
  fsync(fd: number): void
  close(fd: number): void
  link(from: string, to: string): void
  rename(from: string, to: string): void
  unlink(path: string): void
}
export interface HeartbeatFileOwnerOptions { workspaceRoot: string; assertCurrent(): void; fs?: Partial<HeartbeatFilePrimitives> }
export class HeartbeatFileError extends Error {
  constructor(readonly code: 'HEARTBEAT_FILE_INVALID' | 'HEARTBEAT_FILE_CLOSED' | 'HEARTBEAT_FILE_CHANGED' | 'HEARTBEAT_FILE_UNSAFE' | 'HEARTBEAT_FILE_LIMIT' | 'HEARTBEAT_FILE_IO' | 'HEARTBEAT_FILE_CLOSE_PENDING') { super(code); this.name = 'HeartbeatFileError' }
}
function fail(code: HeartbeatFileError['code']): never { throw new HeartbeatFileError(code) }
const idValid = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)
const missing = (cause: unknown) => (cause as NodeJS.ErrnoException)?.code === 'ENOENT'
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino && a.kind === b.kind
const exactFile = (a: Identity, b: Identity) => same(a, b) && a.size === b.size && a.nlink === b.nlink && a.mtime === b.mtime && a.ctime === b.ctime
function identity(info: BigIntStats): Identity {
  const kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : fail('HEARTBEAT_FILE_UNSAFE')
  if (info.isSymbolicLink() || [info.dev, info.ino, info.size, info.nlink].some(value => typeof value !== 'bigint' || value < 0n || value > 18446744073709551615n) || info.size > BigInt(Number.MAX_SAFE_INTEGER) || info.nlink < 1n || kind === 'file' && info.nlink !== 1n) fail('HEARTBEAT_FILE_UNSAFE')
  return { dev: info.dev.toString(), ino: info.ino.toString(), kind, size: info.size, nlink: info.nlink, mtime: info.mtimeNs, ctime: info.ctimeNs }
}
interface OwnedFd { fd: number; path: string; beforeEffect?: () => void; failed: boolean; temp?: Temp }
interface Temp { path: string; identity: Identity; publishedLink?: boolean; preserve?: boolean }

/** Fixed heartbeat.md only. Synchronous filesystem effects preserve the
 * scheduler API; failed actual FD closes remain owned until explicit retry. */
export class HeartbeatFileOwner {
  private readonly root: string
  private readonly rootChain: ReadonlyArray<{ path: string; identity: Identity }>
  private readonly ownerCurrent: () => void
  private readonly fs: HeartbeatFilePrimitives
  private readonly tasks = new Map<string, Identity>()
  private readonly fds = new Set<OwnedFd>()
  private readonly temps = new Set<Temp>()
  private closing = false
  constructor(options: HeartbeatFileOwnerOptions) {
    if (!options || !isAbsolute(options.workspaceRoot) || normalize(options.workspaceRoot) !== options.workspaceRoot || Buffer.byteLength(options.workspaceRoot) > 4096 || /[\u0000-\u001f\u007f]/.test(options.workspaceRoot) || typeof options.assertCurrent !== 'function') fail('HEARTBEAT_FILE_INVALID')
    options.assertCurrent(); this.root = options.workspaceRoot; this.ownerCurrent = options.assertCurrent
    const defaults: HeartbeatFilePrimitives = { lstat: path => lstatSync(path, { bigint: true }), realpath: realpathSync, mkdir: path => { mkdirSync(path) }, open: openSync, fstat: fd => fstatSync(fd, { bigint: true }), read: readSync, write: writeSync, fsync: fsyncSync, close: closeSync, link: linkSync, rename: renameSync, unlink: unlinkSync }
    for (const [key, value] of Object.entries(options.fs ?? {})) if (!Object.hasOwn(defaults, key) || typeof value !== 'function') fail('HEARTBEAT_FILE_INVALID')
    this.fs = Object.freeze({ ...defaults, ...options.fs })
    const chain: Array<{ path: string; identity: Identity }> = []
    try {
      if (realpathSync(this.root) !== this.root) fail('HEARTBEAT_FILE_UNSAFE')
      for (let path = this.root;; path = dirname(path)) {
        const found = identity(lstatSync(path, { bigint: true }))
        if (found.kind !== 'directory' || chain.length >= 64) fail('HEARTBEAT_FILE_UNSAFE')
        chain.unshift({ path, identity: found }); if (dirname(path) === path) break
      }
    } catch { fail('HEARTBEAT_FILE_UNSAFE') }
    this.rootChain = Object.freeze(chain); options.assertCurrent()
  }
  get inflightCount(): number { return this.fds.size + this.temps.size }
  assertOwners(workspaceRoot: string): void { if (workspaceRoot !== this.root) fail('HEARTBEAT_FILE_INVALID'); if (this.closing) fail('HEARTBEAT_FILE_CLOSED') }
  shutdown(): void { this.closing = true }
  private current(beforeEffect?: () => void): void {
    beforeEffect?.()
    if (this.closing) fail('HEARTBEAT_FILE_CLOSED')
    if ([...this.fds].some(fd => fd.failed)) fail('HEARTBEAT_FILE_CLOSE_PENDING')
    this.ownerCurrent()
  }
  private step<T>(beforeEffect: (() => void) | undefined, effect: () => T): T {
    this.current(beforeEffect)
    try { const value = effect(); this.current(beforeEffect); return value }
    catch (cause) { this.current(beforeEffect); throw cause }
  }
  private rootProof(beforeEffect?: () => void): void {
    for (const expected of this.rootChain) {
      const found = identity(this.step(beforeEffect, () => this.fs.lstat(expected.path)))
      if (!same(found, expected.identity)) fail('HEARTBEAT_FILE_CHANGED')
    }
    if (this.step(beforeEffect, () => this.fs.realpath(this.root)) !== this.root) fail('HEARTBEAT_FILE_CHANGED')
    if (!same(identity(this.step(beforeEffect, () => this.fs.lstat(this.root))), this.rootChain[this.rootChain.length - 1].identity)) fail('HEARTBEAT_FILE_CHANGED')
  }
  private workspace(taskId: string, create: boolean, beforeEffect?: () => void): string | null {
    if (!idValid(taskId)) fail('HEARTBEAT_FILE_INVALID')
    this.rootProof(beforeEffect); const workspace = join(this.root, taskId)
    if (Buffer.byteLength(join(workspace, 'heartbeat.md')) > 4096) fail('HEARTBEAT_FILE_INVALID')
    let info: BigIntStats
    try { info = this.step(beforeEffect, () => this.fs.lstat(workspace)) }
    catch (cause) {
      if (!missing(cause)) throw cause
      if (this.tasks.has(taskId)) fail('HEARTBEAT_FILE_CHANGED')
      if (!create) { this.rootProof(beforeEffect); return null }
      this.rootProof(beforeEffect)
      try { this.step(beforeEffect, () => this.fs.mkdir(workspace)) }
      catch (cause) { if ((cause as NodeJS.ErrnoException)?.code !== 'EEXIST') throw cause }
      info = this.step(beforeEffect, () => this.fs.lstat(workspace))
    }
    const found = identity(info), old = this.tasks.get(taskId)
    if (found.kind !== 'directory' || old && !same(found, old) || this.step(beforeEffect, () => this.fs.realpath(workspace)) !== workspace) fail('HEARTBEAT_FILE_CHANGED')
    if (!old && this.tasks.size >= 4096) fail('HEARTBEAT_FILE_LIMIT')
    this.tasks.set(taskId, found); this.rootProof(beforeEffect); return workspace
  }
  getPath(taskId: string, beforeEffect?: () => void): string { this.current(beforeEffect); if (!idValid(taskId)) fail('HEARTBEAT_FILE_INVALID'); this.rootProof(beforeEffect); const path = join(this.root, taskId, 'heartbeat.md'); if (Buffer.byteLength(path) > 4096) fail('HEARTBEAT_FILE_INVALID'); return path }
  private leaf(taskId: string, beforeEffect?: () => void): { path: string; info: Identity } | null {
    const workspace = this.workspace(taskId, false, beforeEffect)
    if (!workspace) return null
    const path = join(workspace, 'heartbeat.md')
    let info: BigIntStats
    try { info = this.step(beforeEffect, () => this.fs.lstat(path)) }
    catch (cause) { if (!missing(cause)) throw cause; this.workspace(taskId, false, beforeEffect); return null }
    const found = identity(info)
    if (found.kind !== 'file') fail('HEARTBEAT_FILE_UNSAFE')
    this.workspace(taskId, false, beforeEffect); return { path, info: found }
  }
  private opened(path: string, flags: number, beforeEffect?: () => void): OwnedFd {
    this.current(beforeEffect)
    const fd = this.fs.open(path, flags, 0o600), owned: OwnedFd = { fd, path, beforeEffect, failed: false }
    this.fds.add(owned)
    try {
      if (flags & constants.O_CREAT) { owned.temp = { path, identity: identity(this.fs.fstat(fd)) }; this.temps.add(owned.temp) }
      this.current(beforeEffect); return owned
    } catch (cause) {
      this.release(owned); if (owned.temp) this.cleanTemp(owned.temp)
      throw cause
    }
  }
  private release(owned: OwnedFd): void {
    try { this.current(owned.beforeEffect) } catch { /* actual cleanup remains authorized */ }
    try { this.fs.close(owned.fd); this.fds.delete(owned); owned.failed = false }
    catch { owned.failed = true; fail('HEARTBEAT_FILE_CLOSE_PENDING') }
    finally { try { this.current(owned.beforeEffect) } catch { /* do not abandon FD */ } }
  }
  hasFile(taskId: string, beforeEffect?: () => void): boolean {
    try { return !!this.leaf(taskId, beforeEffect) } catch (cause) { if (cause instanceof HeartbeatFileError) throw cause; this.current(beforeEffect); return fail('HEARTBEAT_FILE_IO') }
  }
  readFile(taskId: string, beforeEffect?: () => void): string | null {
    let owned: OwnedFd | undefined
    try {
      const leaf = this.leaf(taskId, beforeEffect)
      if (!leaf) return null
      if (leaf.info.size > BigInt(HEARTBEAT_FILE_MAX_BYTES)) fail('HEARTBEAT_FILE_LIMIT')
      owned = this.opened(leaf.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), beforeEffect)
      const opened = identity(this.step(beforeEffect, () => this.fs.fstat(owned!.fd)))
      if (!exactFile(opened, leaf.info)) fail('HEARTBEAT_FILE_CHANGED')
      this.workspace(taskId, false, beforeEffect)
      const bytes = Buffer.alloc(Number(opened.size) + 1); let total = 0
      for (;;) {
        const count = this.step(beforeEffect, () => this.fs.read(owned!.fd, bytes, total, bytes.length - total, total))
        if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length - total) fail('HEARTBEAT_FILE_IO')
        if (!count) break
        total += count; if (total > Number(opened.size)) fail('HEARTBEAT_FILE_CHANGED')
      }
      const final = identity(this.step(beforeEffect, () => this.fs.fstat(owned!.fd))), current = this.leaf(taskId, beforeEffect)
      if (!current || !exactFile(opened, final) || !exactFile(final, current.info) || total !== Number(opened.size)) fail('HEARTBEAT_FILE_CHANGED')
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, total))
      if (content.includes('\0')) fail('HEARTBEAT_FILE_UNSAFE')
      const closing = owned; owned = undefined; this.release(closing); this.current(beforeEffect); return content
    } catch (cause) { if (cause instanceof HeartbeatFileError) throw cause; this.current(beforeEffect); return fail('HEARTBEAT_FILE_IO') }
    finally { if (owned) this.release(owned) }
  }
  writeFile(taskId: string, content: string, beforeEffect?: () => void): void {
    if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > HEARTBEAT_FILE_MAX_BYTES || Buffer.from(content, 'utf8').toString('utf8') !== content) fail('HEARTBEAT_FILE_LIMIT')
    let owned: OwnedFd | undefined, temp: Temp | undefined
    try {
      const workspace = this.workspace(taskId, true, beforeEffect)!, existing = this.leaf(taskId, beforeEffect)
      if (existing && existing.info.size > BigInt(HEARTBEAT_FILE_MAX_BYTES)) fail('HEARTBEAT_FILE_LIMIT')
      const path = join(workspace, `.heartbeat-${randomUUID()}.tmp`)
      if (Buffer.byteLength(path) > 4096) fail('HEARTBEAT_FILE_INVALID')
      owned = this.opened(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), beforeEffect)
      temp = owned.temp!
      const bytes = Buffer.from(content, 'utf8'); let written = 0
      while (written < bytes.length) {
        const count = this.step(beforeEffect, () => this.fs.write(owned!.fd, bytes, written, bytes.length - written, written))
        if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - written) fail('HEARTBEAT_FILE_IO')
        written += count
        temp.identity = identity(this.step(beforeEffect, () => this.fs.fstat(owned!.fd)))
      }
      this.step(beforeEffect, () => this.fs.fsync(owned!.fd))
      temp.identity = identity(this.step(beforeEffect, () => this.fs.fstat(owned!.fd)))
      if (temp.identity.size !== BigInt(bytes.length) || !exactFile(temp.identity, identity(this.step(beforeEffect, () => this.fs.lstat(path))))) fail('HEARTBEAT_FILE_CHANGED')
      const actual = Buffer.alloc(bytes.length + 1); let received = 0
      for (;;) {
        const count = this.step(beforeEffect, () => this.fs.read(owned!.fd, actual, received, actual.length - received, received))
        if (!Number.isSafeInteger(count) || count < 0 || count > actual.length - received) fail('HEARTBEAT_FILE_IO')
        if (!count) break
        received += count; if (received > bytes.length) { temp.preserve = true; fail('HEARTBEAT_FILE_CHANGED') }
      }
      if (received !== bytes.length || !actual.subarray(0, received).equals(bytes)) { temp.preserve = true; fail('HEARTBEAT_FILE_CHANGED') }
      if (!exactFile(temp.identity, identity(this.step(beforeEffect, () => this.fs.fstat(owned!.fd)))) || !exactFile(temp.identity, identity(this.step(beforeEffect, () => this.fs.lstat(path))))) { temp.preserve = true; fail('HEARTBEAT_FILE_CHANGED') }
      const closing = owned; owned = undefined; this.release(closing)
      const final = this.leaf(taskId, beforeEffect)
      if (existing ? !final || !exactFile(existing.info, final.info) : final !== null) fail('HEARTBEAT_FILE_CHANGED')
      this.workspace(taskId, false, beforeEffect)
      if (existing) this.step(beforeEffect, () => this.fs.rename(path, existing.path))
      else {
        this.current(beforeEffect); this.fs.link(path, join(workspace, 'heartbeat.md')); temp.publishedLink = true; this.current(beforeEffect)
      }
      // Publication is accepted. Cleanup may continue after caller withdrawal.
      if (!existing) this.cleanTemp(temp)
      else this.temps.delete(temp)
      const expected = temp.identity
      temp = undefined; this.current(beforeEffect)
      const published = this.leaf(taskId, beforeEffect)
      if (!published || !same(published.info, expected) || published.info.nlink !== 1n || published.info.size !== BigInt(bytes.length) || published.info.mtime !== expected.mtime) fail('HEARTBEAT_FILE_CHANGED')
    } catch (cause) { if (cause instanceof HeartbeatFileError) throw cause; this.current(beforeEffect); return fail('HEARTBEAT_FILE_IO') }
    finally {
      if (owned) this.release(owned)
      if (temp) this.cleanTemp(temp)
    }
  }
  private cleanTemp(temp: Temp): void {
    // Never unlink a swapped file, unsafe ancestor or same-inode edited data.
    // A successful link legitimately changes nlink/ctime of the owned temp.
    try {
      if (this.fds.size && [...this.fds].some(fd => fd.path === temp.path)) fail('HEARTBEAT_FILE_CLOSE_PENDING')
      if (temp.preserve) fail('HEARTBEAT_FILE_CHANGED')
      for (const root of this.rootChain) if (!same(identity(this.fs.lstat(root.path)), root.identity)) fail('HEARTBEAT_FILE_CHANGED')
      const task = [...this.tasks.entries()].find(([id]) => dirname(temp.path) === join(this.root, id))
      if (!task || !same(identity(this.fs.lstat(dirname(temp.path))), task[1])) fail('HEARTBEAT_FILE_CHANGED')
      const raw = this.fs.lstat(temp.path)
      if (!raw.isFile() || raw.isSymbolicLink() || raw.dev.toString() !== temp.identity.dev || raw.ino.toString() !== temp.identity.ino || raw.size !== temp.identity.size || raw.mtimeNs !== temp.identity.mtime || !temp.publishedLink && (raw.nlink !== temp.identity.nlink || raw.ctimeNs !== temp.identity.ctime)) fail('HEARTBEAT_FILE_CHANGED')
      if (temp.publishedLink) {
        const published = this.fs.lstat(join(dirname(temp.path), 'heartbeat.md'))
        if (!published.isFile() || published.isSymbolicLink() || raw.nlink !== 2n || published.dev !== raw.dev || published.ino !== raw.ino) fail('HEARTBEAT_FILE_CHANGED')
      }
      this.fs.unlink(temp.path); this.temps.delete(temp)
    } catch (cause) { if (missing(cause)) { this.temps.delete(temp); return }; if (cause instanceof HeartbeatFileError) throw cause; fail('HEARTBEAT_FILE_IO') }
  }
  retireWorkspace(taskId: string, expected: HeartbeatWorkspaceReceipt): void {
    if (!idValid(taskId) || !expected || !/^(?:0|[1-9][0-9]{0,19})$/.test(expected.dev) || !/^(?:0|[1-9][0-9]{0,19})$/.test(expected.ino) || BigInt(expected.dev) > 18446744073709551615n || BigInt(expected.ino) > 18446744073709551615n) fail('HEARTBEAT_FILE_INVALID')
    for (const root of this.rootChain) if (!same(identity(this.fs.lstat(root.path)), root.identity)) fail('HEARTBEAT_FILE_CHANGED')
    const previous = this.tasks.get(taskId)
    if (previous && (previous.dev !== expected.dev || previous.ino !== expected.ino)) fail('HEARTBEAT_FILE_CHANGED')
    const path = join(this.root, taskId)
    if ([...this.fds].some(fd => dirname(fd.path) === path)) fail('HEARTBEAT_FILE_CLOSE_PENDING')
    try { const current = identity(this.fs.lstat(path)); if (current.kind !== 'directory' || current.dev !== expected.dev || current.ino !== expected.ino) fail('HEARTBEAT_FILE_CHANGED') }
    catch (cause) { if (!missing(cause)) throw cause }
    this.tasks.delete(taskId)
    // Trusted cleanup takes this exact directory identity, including preserved
    // temp data; this owner never deletes changed/unowned namespace content.
    for (const temp of this.temps) if (dirname(temp.path) === path) this.temps.delete(temp)
  }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) fail('HEARTBEAT_FILE_INVALID')
    this.shutdown()
    for (const owned of [...this.fds]) { try { this.release(owned) } catch { /* retained */ } }
    if (this.fds.size) fail('HEARTBEAT_FILE_CLOSE_PENDING')
    for (const temp of [...this.temps]) this.cleanTemp(temp)
    if (this.inflightCount) fail('HEARTBEAT_FILE_CLOSE_PENDING')
  }
}
