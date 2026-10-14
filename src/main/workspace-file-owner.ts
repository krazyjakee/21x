import { constants, lstatSync, realpathSync, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import type { WorkspacePathIdentity, WorkspacePathReceipt } from '../shared/workspace-native-callbacks'
import { isWorkspacePathReceipt } from '../shared/workspace-native-callbacks'
export type { WorkspacePathIdentity, WorkspacePathReceipt } from '../shared/workspace-native-callbacks'

export const WORKSPACE_FILE_LIMITS = Object.freeze({ textBytes: 128 * 1024, pathBytes: 4096, depth: 64, flights: 16, taskReceipts: 4096 })
export interface WorkspaceFileControls { beforeEffect(): void; signal: AbortSignal }
export interface WorkspaceFileHandle {
  stat(): Promise<BigIntStats>
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number; buffer: Buffer }>
  close(): Promise<void>
}
export interface WorkspaceFilePrimitives {
  lstat(path: string): Promise<BigIntStats>
  realpath(path: string): Promise<string>
  mkdir(path: string): Promise<void>
  open(path: string, flags: number): Promise<WorkspaceFileHandle>
}
export interface WorkspaceFileOwnerOptions {
  workspaceRoot: string
  assertCurrent(): void
  native?: {
    openPath?(path: string, receipt: WorkspacePathReceipt): Promise<void>
    showItemInFolder?(path: string, receipt: WorkspacePathReceipt): Promise<void>
  }
  /** Trusted real-I/O fixture boundary; never caller-selected RPC primitives. */
  fs?: Partial<WorkspaceFilePrimitives>
}
export type WorkspaceFileErrorCode = 'WORKSPACE_INVALID_ARGUMENTS' | 'WORKSPACE_PATH_REFUSED' | 'WORKSPACE_PATH_CHANGED' | 'WORKSPACE_CANCELLED' | 'WORKSPACE_CLOSED' | 'WORKSPACE_BUSY' | 'WORKSPACE_IO_FAILED' | 'WORKSPACE_CLOSE_FAILED' | 'WORKSPACE_DRAIN_INCOMPLETE' | 'WORKSPACE_NATIVE_UNAVAILABLE'
export class WorkspaceFileError extends Error {
  constructor(readonly code: WorkspaceFileErrorCode) { super(code); this.name = 'WorkspaceFileError' }
}
function fail(code: WorkspaceFileErrorCode): never { throw new WorkspaceFileError(code) }
const taskIdValid = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)
const pathValid = (path: unknown): path is string => typeof path === 'string' && isAbsolute(path) && normalize(path) === path && Buffer.byteLength(path, 'utf8') <= WORKSPACE_FILE_LIMITS.pathBytes && !/[\u0000-\u001f\u007f]/.test(path)
const sameNode = (a: WorkspacePathIdentity, b: WorkspacePathIdentity): boolean => a.path === b.path && a.dev === b.dev && a.ino === b.ino && a.kind === b.kind
const sameFile = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
const missing = (cause: unknown): boolean => (cause as NodeJS.ErrnoException)?.code === 'ENOENT'
function identity(path: string, info: BigIntStats): WorkspacePathIdentity {
  const kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : fail('WORKSPACE_PATH_REFUSED')
  if (info.isSymbolicLink() || [info.dev, info.ino, info.size, info.nlink].some(value => typeof value !== 'bigint' || value < 0n || value > 18446744073709551615n) || info.size > BigInt(Number.MAX_SAFE_INTEGER) || info.nlink < 1n || kind === 'file' && info.nlink !== 1n) fail('WORKSPACE_PATH_REFUSED')
  return { path, dev: info.dev.toString(), ino: info.ino.toString(), kind, size: info.size.toString(), nlink: info.nlink.toString() }
}
interface CapturedPath { receipt: WorkspacePathReceipt; info: BigIntStats }
interface HandleReceipt { handle: WorkspaceFileHandle; controls: WorkspaceFileControls; closing?: Promise<void>; failed: boolean }

/** Retains actual filesystem and native callback receipts. Caller cancellation
 * fences publication/effects but never abandons an accepted open/read/close. */
export class WorkspaceFileOwner {
  private readonly root: string
  private readonly rootChain: readonly WorkspacePathIdentity[]
  private readonly ownerCurrent: () => void
  private readonly fs: WorkspaceFilePrimitives
  private readonly native: Readonly<NonNullable<WorkspaceFileOwnerOptions['native']>>
  private readonly tasks = new Map<string, WorkspacePathIdentity>()
  private readonly flights = new Set<Promise<unknown>>()
  private readonly handles = new Set<HandleReceipt>()
  private closing = false
  constructor(options: WorkspaceFileOwnerOptions) {
    if (!options || !pathValid(options.workspaceRoot) || typeof options.assertCurrent !== 'function') fail('WORKSPACE_INVALID_ARGUMENTS')
    options.assertCurrent()
    this.root = options.workspaceRoot; this.ownerCurrent = options.assertCurrent
    const paths: string[] = []
    for (let path = this.root;; path = dirname(path)) {
      paths.unshift(path)
      if (paths.length > WORKSPACE_FILE_LIMITS.depth) fail('WORKSPACE_INVALID_ARGUMENTS')
      if (dirname(path) === path) break
    }
    try {
      if (realpathSync(this.root) !== this.root) fail('WORKSPACE_PATH_REFUSED')
      this.rootChain = Object.freeze(paths.map(path => {
        const result = identity(path, lstatSync(path, { bigint: true }))
        if (result.kind !== 'directory') fail('WORKSPACE_PATH_REFUSED')
        return Object.freeze(result)
      }))
    } catch { fail('WORKSPACE_PATH_REFUSED') }
    const defaults: WorkspaceFilePrimitives = {
      lstat: path => lstat(path, { bigint: true }), realpath, mkdir: async path => { await mkdir(path) },
      open: async (path, flags) => {
        const handle = await open(path, flags)
        return { stat: () => handle.stat({ bigint: true }), read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position), close: () => handle.close() }
      },
    }
    for (const [key, value] of Object.entries(options.fs ?? {})) if (!Object.hasOwn(defaults, key) || typeof value !== 'function') fail('WORKSPACE_INVALID_ARGUMENTS')
    this.fs = Object.freeze({ ...defaults, ...options.fs })
    for (const [key, value] of Object.entries(options.native ?? {})) if (!['openPath', 'showItemInFolder'].includes(key) || typeof value !== 'function') fail('WORKSPACE_INVALID_ARGUMENTS')
    this.native = Object.freeze({ ...options.native })
  }
  get inflightCount(): number { return this.flights.size + this.handles.size }
  get canOpenPath(): boolean { return typeof this.native.openPath === 'function' }
  get canShowItemInFolder(): boolean { return typeof this.native.showItemInFolder === 'function' }
  assertOwners(workspaceRoot: string): void { if (workspaceRoot !== this.root) fail('WORKSPACE_INVALID_ARGUMENTS'); if (this.closing) fail('WORKSPACE_CLOSED') }
  /** Trusted worktree cleanup acknowledgement only; never a renderer grant.
   * In-flight operations retain their original path/FD receipts independently. */
  retireWorkspace(taskId: string, expected: { dev: string; ino: string }): void {
    if (!taskIdValid(taskId)) fail('WORKSPACE_INVALID_ARGUMENTS')
    if (this.closing) fail('WORKSPACE_CLOSED')
    this.ownerCurrent()
    const captured = this.tasks.get(taskId)
    if (captured && captured.dev === expected.dev && captured.ino === expected.ino) this.tasks.delete(taskId)
  }
  shutdown(): void { this.closing = true }
  private current(controls: WorkspaceFileControls): void {
    // Invoke the captured caller assertion at every boundary, including when
    // cancellation/shutdown independently refuses the operation.
    controls.beforeEffect()
    if (controls.signal.aborted) fail('WORKSPACE_CANCELLED')
    if (this.closing) fail('WORKSPACE_CLOSED')
    this.ownerCurrent()
  }
  private async step<T>(controls: WorkspaceFileControls, effect: () => Promise<T>): Promise<T> {
    this.current(controls)
    try { const value = await effect(); this.current(controls); return value }
    catch (cause) { this.current(controls); throw cause }
  }
  private run<T>(taskId: string, controls: WorkspaceFileControls, effect: (controls: WorkspaceFileControls) => Promise<T>): Promise<T> {
    if (!taskIdValid(taskId) || !controls || typeof controls.beforeEffect !== 'function' || !controls.signal || typeof controls.signal.aborted !== 'boolean') return Promise.reject(new WorkspaceFileError('WORKSPACE_INVALID_ARGUMENTS'))
    const captured = Object.freeze({ beforeEffect: controls.beforeEffect, signal: controls.signal })
    try { this.current(captured); if (this.flights.size + this.handles.size >= WORKSPACE_FILE_LIMITS.flights) fail('WORKSPACE_BUSY') }
    catch (cause) { return Promise.reject(cause) }
    const raw = effect(captured).then(value => { this.current(captured); return value }).catch(cause => {
      if (cause instanceof WorkspaceFileError) throw cause
      this.current(captured)
      fail('WORKSPACE_IO_FAILED')
    })
    this.flights.add(raw); void raw.then(() => this.flights.delete(raw), () => this.flights.delete(raw))
    return raw
  }
  private targetPath(taskId: string, path: string): string {
    if (!pathValid(path)) fail('WORKSPACE_PATH_REFUSED')
    const workspace = join(this.root, taskId), part = relative(workspace, path)
    if (isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`) || part.split(sep).length > WORKSPACE_FILE_LIMITS.depth || process.platform === 'win32' && part.split(sep).some(segment => /[:]|[. ]$/.test(segment))) fail('WORKSPACE_PATH_REFUSED')
    return path
  }
  private async rootProof(controls: WorkspaceFileControls): Promise<WorkspacePathIdentity> {
    for (const expected of this.rootChain) {
      const current = identity(expected.path, await this.step(controls, () => this.fs.lstat(expected.path)))
      if (!sameNode(current, expected)) fail('WORKSPACE_PATH_CHANGED')
    }
    if (await this.step(controls, () => this.fs.realpath(this.root)) !== this.root) fail('WORKSPACE_PATH_CHANGED')
    const final = identity(this.root, await this.step(controls, () => this.fs.lstat(this.root)))
    if (!sameNode(final, this.rootChain[this.rootChain.length - 1])) fail('WORKSPACE_PATH_CHANGED')
    return final
  }
  private rememberTask(taskId: string, found: WorkspacePathIdentity): void {
    if (found.kind !== 'directory') fail('WORKSPACE_PATH_REFUSED')
    const expected = this.tasks.get(taskId)
    if (expected && !sameNode(expected, found)) fail('WORKSPACE_PATH_CHANGED')
    if (!expected && this.tasks.size >= WORKSPACE_FILE_LIMITS.taskReceipts) fail('WORKSPACE_BUSY')
    this.tasks.set(taskId, found)
  }
  private async capture(taskId: string, path: string, controls: WorkspaceFileControls): Promise<CapturedPath | null> {
    this.targetPath(taskId, path)
    const root = await this.rootProof(controls), workspace = join(this.root, taskId)
    const parts = relative(this.root, path).split(sep), ancestors: WorkspacePathIdentity[] = []
    let currentPath = this.root, target: WorkspacePathIdentity | undefined, info: BigIntStats | undefined
    for (const part of parts) {
      currentPath = join(currentPath, part)
      try { info = await this.step(controls, () => this.fs.lstat(currentPath)) }
      catch (cause) {
        if (!missing(cause)) throw cause
        if (currentPath === workspace && this.tasks.has(taskId)) fail('WORKSPACE_PATH_CHANGED')
        for (const expected of ancestors) {
          const found = identity(expected.path, await this.step(controls, () => this.fs.lstat(expected.path)))
          if (!sameNode(expected, found)) fail('WORKSPACE_PATH_CHANGED')
        }
        await this.rootProof(controls)
        return null
      }
      const found = identity(currentPath, info)
      if (currentPath === workspace) this.rememberTask(taskId, found)
      if (currentPath !== path) { if (found.kind !== 'directory') fail('WORKSPACE_PATH_REFUSED'); ancestors.push(found) }
      else target = found
    }
    if (!target || !info || await this.step(controls, () => this.fs.realpath(path)) !== path) fail('WORKSPACE_PATH_CHANGED')
    const receipt: WorkspacePathReceipt = { version: 1, taskId, workspaceRoot: this.root, path, root, ancestors, target }
    await this.verify(receipt, controls)
    return { receipt, info }
  }
  private async verify(receipt: WorkspacePathReceipt, controls: WorkspaceFileControls): Promise<void> {
    const root = await this.rootProof(controls)
    if (!sameNode(root, receipt.root)) fail('WORKSPACE_PATH_CHANGED')
    for (const expected of [...receipt.ancestors, receipt.target]) {
      const found = identity(expected.path, await this.step(controls, () => this.fs.lstat(expected.path)))
      if (!sameNode(found, expected) || found.kind === 'file' && (found.size !== expected.size || found.nlink !== expected.nlink)) fail('WORKSPACE_PATH_CHANGED')
    }
    if (await this.step(controls, () => this.fs.realpath(receipt.path)) !== receipt.path) fail('WORKSPACE_PATH_CHANGED')
    this.current(controls)
  }
  private async opened(captured: CapturedPath, controls: WorkspaceFileControls): Promise<HandleReceipt> {
    this.current(controls)
    let handle: WorkspaceFileHandle
    try { handle = await this.fs.open(captured.receipt.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)) }
    catch (cause) { this.current(controls); throw cause }
    // Register even a late accepted FD before a revoked guard can throw.
    const owned: HandleReceipt = { handle, controls, failed: false }; this.handles.add(owned)
    try {
      this.current(controls)
      const initial = await this.step(controls, () => handle.stat())
      if (!sameNode(identity(captured.receipt.path, initial), captured.receipt.target) || captured.receipt.target.kind === 'file' && !sameFile(initial, captured.info)) fail('WORKSPACE_PATH_CHANGED')
      await this.verify(captured.receipt, controls)
      return owned
    } catch (cause) { await this.release(owned); throw cause }
  }
  private release(owned: HandleReceipt): Promise<void> {
    if (owned.closing) return owned.closing
    // Cleanup still calls the assertion, but its rejection cannot abandon the
    // accepted raw handle. Failed closes remain retained for an explicit retry.
    try { this.current(owned.controls) } catch { /* cleanup authority */ }
    const raw = (async () => {
      // Defer the close invocation until the exact raw receipt is assigned,
      // including trusted test primitives which throw before returning a promise.
      await Promise.resolve()
      try { this.current(owned.controls) } catch { /* cleanup authority */ }
      try { await owned.handle.close(); this.handles.delete(owned); owned.failed = false }
      catch { owned.failed = true; fail('WORKSPACE_CLOSE_FAILED') }
      finally { try { this.current(owned.controls) } catch { /* cleanup authority */ }; owned.closing = undefined }
    })()
    owned.closing = raw
    void raw.catch(() => {})
    return raw
  }
  getWorkspaceDir(taskId: string, controls: WorkspaceFileControls): Promise<string> {
    return this.run(taskId, controls, async current => {
      const workspace = join(this.root, taskId)
      if (!await this.capture(taskId, workspace, current)) {
        await this.rootProof(current)
        try { await this.step(current, () => this.fs.mkdir(workspace)) }
        catch (cause) { if ((cause as NodeJS.ErrnoException)?.code !== 'EEXIST') throw cause }
        if (!await this.capture(taskId, workspace, current)) fail('WORKSPACE_PATH_CHANGED')
      }
      this.current(current); return workspace
    })
  }
  readTextFile(taskId: string, filePath: string, controls: WorkspaceFileControls): Promise<{ content: string; size: number } | null> {
    return this.run(taskId, controls, async current => {
      const captured = await this.capture(taskId, filePath, current)
      if (!captured) { this.current(current); return null }
      if (captured.receipt.target.kind !== 'file') fail('WORKSPACE_PATH_REFUSED')
      const owned = await this.opened(captured, current)
      try {
        const size = Number(captured.receipt.target.size)
        if (size > WORKSPACE_FILE_LIMITS.textBytes) { await this.verify(captured.receipt, current); return { content: '', size } }
        const chunks: Buffer[] = []; let total = 0
        for (;;) {
          const buffer = Buffer.alloc(Math.min(32 * 1024, WORKSPACE_FILE_LIMITS.textBytes + 1 - total))
          const result = await this.step(current, () => owned.handle.read(buffer, 0, buffer.length, total))
          if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0 || result.bytesRead > buffer.length) fail('WORKSPACE_IO_FAILED')
          if (!result.bytesRead) break
          total += result.bytesRead
          if (total > WORKSPACE_FILE_LIMITS.textBytes) fail('WORKSPACE_PATH_CHANGED')
          chunks.push(buffer.subarray(0, result.bytesRead))
        }
        const final = await this.step(current, () => owned.handle.stat())
        const leaf = await this.step(current, () => this.fs.lstat(filePath))
        if (!sameFile(captured.info, final) || !sameFile(final, leaf) || total !== size) fail('WORKSPACE_PATH_CHANGED')
        await this.verify(captured.receipt, current)
        return { content: Buffer.concat(chunks, total).toString('utf8'), size }
      } finally { await this.release(owned) }
    })
  }
  openPath(taskId: string, filePath: string, controls: WorkspaceFileControls): Promise<void> { return this.nativeEffect('openPath', taskId, filePath, controls) }
  showItemInFolder(taskId: string, filePath: string, controls: WorkspaceFileControls): Promise<void> { return this.nativeEffect('showItemInFolder', taskId, filePath, controls) }
  private nativeEffect(operation: 'openPath' | 'showItemInFolder', taskId: string, filePath: string, controls: WorkspaceFileControls): Promise<void> {
    return this.run(taskId, controls, async current => {
      const callback = this.native[operation]
      if (!callback) fail('WORKSPACE_NATIVE_UNAVAILABLE')
      const captured = await this.capture(taskId, filePath, current)
      if (!captured) { this.current(current); return }
      const owned = await this.opened(captured, current)
      try {
        const receipt = Object.freeze({ ...captured.receipt, root: Object.freeze({ ...captured.receipt.root }), ancestors: Object.freeze(captured.receipt.ancestors.map(item => Object.freeze({ ...item }))), target: Object.freeze({ ...captured.receipt.target }) })
        if (!isWorkspacePathReceipt(receipt)) fail('WORKSPACE_PATH_REFUSED')
        await this.step(current, () => callback(filePath, receipt as unknown as WorkspacePathReceipt))
        await this.verify(captured.receipt, current)
      } finally { await this.release(owned) }
    })
  }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) fail('WORKSPACE_INVALID_ARGUMENTS')
    this.shutdown()
    let timer: ReturnType<typeof setTimeout> | undefined
    const drain = (async () => {
      await Promise.allSettled([...this.handles].filter(handle => handle.failed && !handle.closing).map(handle => this.release(handle)))
      await Promise.allSettled([...this.flights, ...[...this.handles].flatMap(handle => handle.closing ? [handle.closing] : [])])
      if (this.flights.size || this.handles.size) fail('WORKSPACE_DRAIN_INCOMPLETE')
    })()
    try { await Promise.race([drain, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new WorkspaceFileError('WORKSPACE_DRAIN_INCOMPLETE')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
}
