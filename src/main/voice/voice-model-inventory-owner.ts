import { createHash, randomUUID } from 'node:crypto'
import { constants, lstatSync, realpathSync } from 'node:fs'
import { open, lstat, realpath, mkdir, readdir, link, unlink, rename, rmdir, mkdtemp, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { AuthenticatedSecretStorage } from '../platform/authenticated-secret-storage'
import { VOICE_TTS_MODEL_MANIFEST } from './voice-tts-manifest'
import type { VoiceTtsModelManifestEntry } from '../../shared/voice-tts'

const DOMAIN = '21x:voice-model-publication:tts:v1\n'
const MAX_JSON_BYTES = 900_000
const MAX_CIPHERTEXT_BYTES = 1_048_640
const MAX_ENTRIES = 4096

interface Identity { dev: number; ino: number }
interface InventoryEntry extends Identity {
  path: string
  type: 'directory' | 'file'
  mode: number
  size?: number
  mtimeMs?: number
  sha256?: string
}
interface ModelIdentity {
  id: string
  family: string
  sampleRate: number
  archive: VoiceTtsModelManifestEntry['archive']
  files: VoiceTtsModelManifestEntry['files']
}
interface InventoryRecord {
  version: 1
  kind: 'tts-publication'
  phase: 'prepared' | 'committed' | 'retiring'
  publicationId: string
  model: ModelIdentity
  binding: {
    profileRootDir: string; inventoryRootDir: string; modelRootDir: string
    profile: Identity; inventory: Identity; models: Identity
  }
  tree: InventoryEntry[]
  retirement?: { relative: string; container: Identity }
}
interface FileReceipt extends Identity { size: number; mtimeMs: number }
interface PreparedPublication { record: InventoryRecord; file: FileReceipt }
/** Opaque same-owner publication admission, never a renderer DTO. */
export interface VoiceModelPublicationReceipt { readonly token: object }
export interface VoiceModelInventoryOwnerOptions {
  profileRootDir: string
  inventoryRootDir: string
  modelRootDir: string
  storage: AuthenticatedSecretStorage
  assertCurrent(): void
  /** Trusted filesystem seam; production uses the actual Node open primitive. */
  openFile?: typeof open
}

function fail(code = 'VOICE_MODEL_INVENTORY_UNOWNED'): never { throw new Error(code) }
function identity(info: Identity): Identity { return { dev: info.dev, ino: info.ino } }
function sameIdentity(a: Identity, b: Identity): boolean { return a.dev === b.dev && a.ino === b.ino }
function number(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function keys(value: Record<string, unknown>, expected: string[]): boolean { return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)) }
function validIdentity(value: unknown): value is Identity { return object(value) && keys(value, ['dev', 'ino']) && number(value.dev) && number(value.ino) }
function relativePath(value: unknown, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= 2048 && (allowEmpty && value === '' || value.length > 0 && value.split('/').length <= 17 && value.split('/').every(part => part.length > 0 && part.length <= 255 && part !== '.' && part !== '..' && !/[:\\\x00-\x1f\x7f]/.test(part)))
}
function modelIdentity(entry: VoiceTtsModelManifestEntry): ModelIdentity {
  return { id: entry.id, family: entry.family, sampleRate: entry.sampleRate,
    archive: { url: entry.archive.url, sha256: entry.archive.sha256, sizeBytes: entry.archive.sizeBytes, unpackedBytes: entry.archive.unpackedBytes, rootDir: entry.archive.rootDir, format: entry.archive.format },
    files: { model: entry.files.model, voices: entry.files.voices, tokens: entry.files.tokens, dataDir: entry.files.dataDir } }
}

/** Authenticated local publication receipts. This owner never adopts a tree
 * merely because it looks like a model, and never sweeps a model namespace. */
export class VoiceModelInventoryOwner {
  private readonly options: VoiceModelInventoryOwnerOptions
  private readonly profile: Identity
  private inventory: Identity | null = null
  private models: Identity | null = null
  private readonly manifest = structuredClone(VOICE_TTS_MODEL_MANIFEST)
  private readonly flights = new Set<Promise<unknown>>()
  private readonly busy = new Set<string>()
  private readonly admissions = new Map<object, PreparedPublication>()
  private readonly handles = new Set<FileHandle>()
  private readonly closingHandles = new Map<FileHandle, Promise<void>>()
  private closing = false

  constructor(options: VoiceModelInventoryOwnerOptions) {
    if (!(options.storage instanceof AuthenticatedSecretStorage)) fail('VOICE_MODEL_INVENTORY_STORAGE_REQUIRED')
    for (const path of [options.profileRootDir, options.inventoryRootDir, options.modelRootDir]) if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0')) fail('VOICE_MODEL_INVENTORY_ROOT_INVALID')
    if (dirname(options.inventoryRootDir) !== options.profileRootDir || dirname(options.modelRootDir) !== options.profileRootDir || options.inventoryRootDir === options.modelRootDir) fail('VOICE_MODEL_INVENTORY_ROOT_INVALID')
    this.options = { ...options }; this.options.assertCurrent(); options.storage.isEncryptionAvailable()
    const profile = lstatSync(options.profileRootDir)
    if (!profile.isDirectory() || profile.isSymbolicLink() || realpathSync(options.profileRootDir) !== options.profileRootDir) fail('VOICE_MODEL_INVENTORY_ROOT_INVALID')
    this.profile = identity(profile)
    this.inventory = this.initialRoot(options.inventoryRootDir)
    this.models = this.initialRoot(options.modelRootDir)
  }
  private initialRoot(path: string): Identity | null {
    try { const info = lstatSync(path); if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) fail('VOICE_MODEL_INVENTORY_ROOT_INVALID'); return identity(info) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  get inflightCount(): number { return this.flights.size + this.handles.size }
  assertOwners(owners: Pick<VoiceModelInventoryOwnerOptions, 'profileRootDir' | 'inventoryRootDir' | 'modelRootDir' | 'storage'>): void {
    if (owners.profileRootDir !== this.options.profileRootDir || owners.inventoryRootDir !== this.options.inventoryRootDir || owners.modelRootDir !== this.options.modelRootDir || owners.storage !== this.options.storage) fail('VOICE_MODEL_INVENTORY_OWNER_MISMATCH')
    this.current()
  }
  assertModelRoot(modelRootDir: string): void { if (modelRootDir !== this.options.modelRootDir) fail('VOICE_MODEL_INVENTORY_OWNER_MISMATCH'); this.current() }
  private current(beforeWrite?: () => void): void {
    if (this.closing) fail('VOICE_MODEL_INVENTORY_CLOSED')
    this.options.assertCurrent(); this.options.storage.isEncryptionAvailable(); beforeWrite?.()
  }
  private entry(entry: VoiceTtsModelManifestEntry): VoiceTtsModelManifestEntry {
    const trusted = this.manifest.find(value => value.id === entry.id)
    if (!trusted || JSON.stringify(modelIdentity(trusted)) !== JSON.stringify(modelIdentity(entry)) || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(trusted.id) || !/^[a-f0-9]{64}$/.test(trusted.archive.sha256) || !Object.values(trusted.files).every(path => relativePath(path))) fail('VOICE_MODEL_INVENTORY_MODEL_MISMATCH')
    return trusted
  }
  private own<T>(id: string, effect: () => Promise<T>): Promise<T> {
    try { this.current(); if (this.busy.has(id)) fail('VOICE_MODEL_INVENTORY_BUSY') } catch (error) { return Promise.reject(error) }
    this.busy.add(id)
    const work = Promise.resolve().then(effect).catch(error => {
      if (/^E[A-Z0-9]+$/.test((error as NodeJS.ErrnoException).code ?? '')) fail('VOICE_MODEL_INVENTORY_IO_FAILED')
      throw error
    }).finally(() => { this.busy.delete(id) })
    this.flights.add(work); void work.then(() => this.flights.delete(work), () => this.flights.delete(work)); return work
  }
  shutdown(): void { this.closing = true }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid inventory shutdown deadline')
    this.shutdown(); let timer: ReturnType<typeof setTimeout> | undefined
    const drain = Promise.allSettled([...this.flights]).then(async () => {
      const results = await Promise.allSettled([...this.handles].map(handle => this.closeFile(handle)))
      if (results.some(result => result.status === 'rejected') || this.handles.size > 0) fail('VOICE_MODEL_INVENTORY_SHUTDOWN_INCOMPLETE')
    })
    try { await Promise.race([drain, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('VOICE_MODEL_INVENTORY_SHUTDOWN_INCOMPLETE')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  private async roots(create: boolean, beforeWrite: () => void): Promise<InventoryRecord['binding']> {
    this.current(beforeWrite)
    const profile = await lstat(this.options.profileRootDir)
    if (!profile.isDirectory() || profile.isSymbolicLink() || !sameIdentity(profile, this.profile) || await realpath(this.options.profileRootDir) !== this.options.profileRootDir) fail('VOICE_MODEL_INVENTORY_ROOT_CHANGED')
    for (const key of ['inventory', 'models'] as const) {
      const path = key === 'inventory' ? this.options.inventoryRootDir : this.options.modelRootDir
      let info = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
      if (!info && create && key === 'inventory' && !this.inventory) { this.current(beforeWrite); await mkdir(path, { mode: 0o700 }); info = await lstat(path) }
      if (!info || !info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path || this[key] && !sameIdentity(info, this[key]!)) fail('VOICE_MODEL_INVENTORY_ROOT_CHANGED')
      this[key] ??= identity(info)
    }
    this.current(beforeWrite)
    return { profileRootDir: this.options.profileRootDir, inventoryRootDir: this.options.inventoryRootDir, modelRootDir: this.options.modelRootDir, profile: { ...this.profile }, inventory: { ...this.inventory! }, models: { ...this.models! } }
  }
  private path(id: string, phase: InventoryRecord['phase']): string { return join(this.options.inventoryRootDir, `${id}.${phase}`) }
  private async absent(path: string): Promise<void> {
    const info = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
    if (info) fail('VOICE_MODEL_INVENTORY_AMBIGUOUS')
  }
  private async openFile(path: string, flags: number, mode?: number): Promise<FileHandle> { const handle = await (this.options.openFile ?? open)(path, flags, mode); this.handles.add(handle); return handle }
  private closeFile(handle: FileHandle): Promise<void> {
    const pending = this.closingHandles.get(handle); if (pending) return pending
    const closed = Promise.resolve().then(() => handle.close()).then(() => { this.handles.delete(handle) })
    this.closingHandles.set(handle, closed)
    void closed.then(() => { this.closingHandles.delete(handle) }, () => { this.closingHandles.delete(handle) })
    return closed
  }
  private async syncDirectory(path: string): Promise<void> {
    const expected = path === this.options.inventoryRootDir ? this.inventory : path === this.options.modelRootDir ? this.models : null
    const before = await lstat(path)
    if (!expected || !before.isDirectory() || before.isSymbolicLink() || !sameIdentity(before, expected) || await realpath(path) !== path) fail('VOICE_MODEL_INVENTORY_ROOT_CHANGED')
    const handle = await this.openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try { const info = await handle.stat(); if (!info.isDirectory() || !sameIdentity(info, expected)) fail('VOICE_MODEL_INVENTORY_ROOT_CHANGED'); await handle.sync(); const after = await lstat(path); if (after.isSymbolicLink() || !sameIdentity(after, expected)) fail('VOICE_MODEL_INVENTORY_ROOT_CHANGED') }
    finally { await this.closeFile(handle) }
  }
  private async matchingFile(path: string, receipt: FileReceipt): Promise<void> {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || !sameIdentity(info, receipt) || info.size !== receipt.size || info.mtimeMs !== receipt.mtimeMs) fail('VOICE_MODEL_INVENTORY_CHANGED')
  }
  private async writeRecord(record: InventoryRecord, beforeWrite: () => void): Promise<FileReceipt> {
    const binding = await this.roots(true, beforeWrite)
    if (JSON.stringify(binding) !== JSON.stringify(record.binding)) fail('VOICE_MODEL_INVENTORY_ROOT_CHANGED')
    const plaintext = DOMAIN + JSON.stringify(record)
    if (Buffer.byteLength(plaintext) > MAX_JSON_BYTES) fail('VOICE_MODEL_INVENTORY_SIZE_LIMIT')
    const bytes = this.options.storage.encryptString(plaintext)
    const path = this.path(record.model.id, record.phase), temporary = join(this.options.inventoryRootDir, `.${record.model.id}.${randomUUID()}.tmp`)
    await this.absent(path); this.current(beforeWrite)
    const handle = await this.openFile(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    let receipt: FileReceipt | undefined, complete = false
    try {
      const opened = await handle.stat(); receipt = { ...identity(opened), size: 0, mtimeMs: opened.mtimeMs }
      let written = 0
      while (written < bytes.length) { this.current(beforeWrite); const result = await handle.write(bytes, written, bytes.length - written); if (!result.bytesWritten) fail('VOICE_MODEL_INVENTORY_WRITE_FAILED'); written += result.bytesWritten }
      await handle.sync(); const info = await handle.stat(); receipt = { ...identity(info), size: info.size, mtimeMs: info.mtimeMs }
      this.current(beforeWrite); await this.roots(false, beforeWrite); await this.matchingFile(temporary, receipt); this.current(beforeWrite)
      // Hard-link publication refuses an existing leaf, unlike rename overwrite.
      await link(temporary, path); await this.syncDirectory(this.options.inventoryRootDir)
      this.current(beforeWrite); await this.matchingFile(path, receipt)
      complete = true
      return receipt
    } finally {
      await this.closeFile(handle)
      try {
        // Failed/partial writes are preserved. Successful scratch cleanup
        // proves exact encrypted bytes as well as the captured file/root IDs.
        const current = await lstat(temporary).catch(() => null), root = await lstat(this.options.inventoryRootDir), profile = await lstat(this.options.profileRootDir)
        if (complete && receipt && current?.isFile() && !current.isSymbolicLink() && sameIdentity(current, receipt) && current.size === bytes.length && current.mtimeMs === receipt.mtimeMs && !root.isSymbolicLink() && sameIdentity(root, record.binding.inventory) && !profile.isSymbolicLink() && sameIdentity(profile, record.binding.profile)) {
          const reader = await this.openFile(temporary, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), actual = Buffer.alloc(bytes.length)
          try {
            const opened = await reader.stat(); if (!sameIdentity(opened, receipt) || opened.size !== bytes.length) fail('VOICE_MODEL_INVENTORY_CHANGED')
            let offset = 0
            while (offset < actual.length) { const result = await reader.read(actual, offset, actual.length - offset, null); if (!result.bytesRead) fail('VOICE_MODEL_INVENTORY_CHANGED'); offset += result.bytesRead }
            const after = await reader.stat(); if (after.size !== bytes.length || after.mtimeMs !== receipt.mtimeMs || !actual.equals(bytes)) fail('VOICE_MODEL_INVENTORY_CHANGED')
          } finally { actual.fill(0); await this.closeFile(reader) }
          await this.matchingFile(temporary, receipt); await unlink(temporary); await this.syncDirectory(this.options.inventoryRootDir)
        } else if (complete) fail('VOICE_MODEL_INVENTORY_CHANGED')
      } finally { bytes.fill(0) }
    }
  }
  private async readRecord(entry: VoiceTtsModelManifestEntry, phase: InventoryRecord['phase'], beforeWrite: () => void): Promise<{ record: InventoryRecord; file: FileReceipt }> {
    const binding = await this.roots(false, beforeWrite), path = this.path(entry.id, phase)
    const expected = await lstat(path)
    if (!expected.isFile() || expected.isSymbolicLink() || expected.size < 40 || expected.size > MAX_CIPHERTEXT_BYTES) fail('VOICE_MODEL_INVENTORY_INVALID')
    const handle = await this.openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    let bytes: Buffer | undefined
    try {
      const opened = await handle.stat(); if (!opened.isFile() || !sameIdentity(opened, expected) || opened.size !== expected.size) fail('VOICE_MODEL_INVENTORY_CHANGED')
      bytes = Buffer.alloc(expected.size); let offset = 0
      while (offset < bytes.length) { this.current(beforeWrite); const result = await handle.read(bytes, offset, bytes.length - offset, null); if (!result.bytesRead) fail('VOICE_MODEL_INVENTORY_CHANGED'); offset += result.bytesRead }
      const probe = Buffer.alloc(1), extra = await handle.read(probe, 0, 1, null), after = await handle.stat()
      if (extra.bytesRead || after.size !== expected.size || after.mtimeMs !== expected.mtimeMs) fail('VOICE_MODEL_INVENTORY_CHANGED')
      this.current(beforeWrite); const plaintext = this.options.storage.decryptString(bytes)
      if (!plaintext.startsWith(DOMAIN) || Buffer.byteLength(plaintext) > MAX_JSON_BYTES) fail('VOICE_MODEL_INVENTORY_INVALID')
      let value: unknown
      try { value = JSON.parse(plaintext.slice(DOMAIN.length)) } catch { fail('VOICE_MODEL_INVENTORY_INVALID') }
      const record = this.validateRecord(value, entry, phase, binding)
      const file = { ...identity(expected), size: expected.size, mtimeMs: expected.mtimeMs }
      await this.matchingFile(path, file); return { record, file }
    } catch (error) {
      if ((error as Error).message.startsWith('VOICE_MODEL_INVENTORY_')) throw error
      return fail('VOICE_MODEL_INVENTORY_INVALID')
    } finally { bytes?.fill(0); await this.closeFile(handle) }
  }
  private validateRecord(value: unknown, entry: VoiceTtsModelManifestEntry, phase: InventoryRecord['phase'], binding: InventoryRecord['binding']): InventoryRecord {
    if (!object(value) || !keys(value, ['version', 'kind', 'phase', 'publicationId', 'model', 'binding', 'tree', ...(phase === 'retiring' ? ['retirement'] : [])]) || value.version !== 1 || value.kind !== 'tts-publication' || value.phase !== phase || typeof value.publicationId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.publicationId) || JSON.stringify(value.model) !== JSON.stringify(modelIdentity(entry)) || JSON.stringify(value.binding) !== JSON.stringify(binding) || !Array.isArray(value.tree) || value.tree.length < 1 || value.tree.length > MAX_ENTRIES) fail('VOICE_MODEL_INVENTORY_INVALID')
    let bytes = 0
    const seen = new Map<string, string>()
    for (const row of value.tree) {
      if (!object(row) || !relativePath(row.path, true) || !number(row.dev) || !number(row.ino) || !number(row.mode) || seen.has(row.path) || !['directory', 'file'].includes(String(row.type))) fail('VOICE_MODEL_INVENTORY_INVALID')
      const file = row.type === 'file'
      if (!keys(row, ['path', 'type', 'dev', 'ino', 'mode', ...(file ? ['size', 'mtimeMs', 'sha256'] : [])])) fail('VOICE_MODEL_INVENTORY_INVALID')
      if (file) {
        if (!number(row.size) || typeof row.mtimeMs !== 'number' || !Number.isFinite(row.mtimeMs) || row.mtimeMs < 0 || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)) fail('VOICE_MODEL_INVENTORY_INVALID')
        bytes += row.size
      }
      const parent = row.path.split('/').slice(0, -1).join('/')
      if (row.path !== '' && seen.get(parent) !== 'directory' || row.path === '' && (seen.size > 0 || file)) fail('VOICE_MODEL_INVENTORY_INVALID')
      seen.set(row.path, String(row.type))
    }
    if (bytes > entry.archive.unpackedBytes * 2 + 8 * 1024 * 1024 || seen.get('') !== 'directory' || [entry.files.model, entry.files.voices, entry.files.tokens].some(path => seen.get(path) !== 'file') || seen.get(entry.files.dataDir) !== 'directory') fail('VOICE_MODEL_INVENTORY_INVALID')
    if (phase === 'retiring' && (!object(value.retirement) || !keys(value.retirement, ['relative', 'container']) || typeof value.retirement.relative !== 'string' || !new RegExp(`^\\.${entry.id}\\.remove-[A-Za-z0-9]+$`).test(value.retirement.relative) || !validIdentity(value.retirement.container))) fail('VOICE_MODEL_INVENTORY_INVALID')
    return value as unknown as InventoryRecord
  }
  private async tree(root: string, entry: VoiceTtsModelManifestEntry, beforeWrite: () => void): Promise<InventoryEntry[]> {
    const rows: InventoryEntry[] = []; let bytes = 0
    const walk = async (relative: string, depth: number): Promise<void> => {
      this.current(beforeWrite); const path = relative ? join(root, ...relative.split('/')) : root, info = await lstat(path)
      if (info.isSymbolicLink() || !relativePath(relative, true) || depth > 16 || rows.length >= MAX_ENTRIES || await realpath(path) !== path) fail('VOICE_MODEL_INVENTORY_TREE_UNSAFE')
      if (info.isDirectory()) {
        rows.push({ path: relative, type: 'directory', ...identity(info), mode: info.mode })
        for (const name of (await readdir(path)).sort()) { if (!relativePath(name) || name.includes('/')) fail('VOICE_MODEL_INVENTORY_TREE_UNSAFE'); await walk(relative ? `${relative}/${name}` : name, depth + 1) }
      } else if (info.isFile()) {
        bytes += info.size; if (bytes > entry.archive.unpackedBytes * 2 + 8 * 1024 * 1024) fail('VOICE_MODEL_INVENTORY_SIZE_LIMIT')
        const row: InventoryEntry = { path: relative, type: 'file', ...identity(info), mode: info.mode, size: info.size, mtimeMs: info.mtimeMs, sha256: await this.hash(path, info, beforeWrite) }; rows.push(row)
      } else fail('VOICE_MODEL_INVENTORY_TREE_UNSAFE')
      const after = await lstat(path); if (!sameIdentity(after, info) || after.mode !== info.mode || after.isSymbolicLink()) fail('VOICE_MODEL_INVENTORY_CHANGED')
    }
    await walk('', 0); this.current(beforeWrite)
    this.validateRecord({ version: 1, kind: 'tts-publication', phase: 'prepared', publicationId: randomUUID(), model: modelIdentity(entry), binding: await this.roots(false, beforeWrite), tree: rows }, entry, 'prepared', await this.roots(false, beforeWrite))
    return rows
  }
  private async hash(path: string, expected: { dev: number; ino: number; size: number; mtimeMs: number }, beforeWrite: () => void): Promise<string> {
    this.current(beforeWrite)
    const handle = await this.openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const opened = await handle.stat(); if (!opened.isFile() || !sameIdentity(opened, expected) || opened.size !== expected.size || opened.mtimeMs !== expected.mtimeMs) fail('VOICE_MODEL_INVENTORY_CHANGED')
      const buffer = Buffer.alloc(1024 * 1024), hash = createHash('sha256'); let count = 0
      for (;;) { this.current(beforeWrite); const result = await handle.read(buffer, 0, buffer.length, null); count += result.bytesRead; if (count > expected.size) fail('VOICE_MODEL_INVENTORY_CHANGED'); if (!result.bytesRead) break; hash.update(buffer.subarray(0, result.bytesRead)) }
      const after = await handle.stat(); this.current(beforeWrite); if (count !== expected.size || after.size !== expected.size || after.mtimeMs !== expected.mtimeMs) fail('VOICE_MODEL_INVENTORY_CHANGED')
      const leaf = await lstat(path); if (leaf.isSymbolicLink() || !sameIdentity(leaf, expected) || leaf.size !== expected.size || leaf.mtimeMs !== expected.mtimeMs) fail('VOICE_MODEL_INVENTORY_CHANGED')
      return hash.digest('hex')
    } finally { await this.closeFile(handle) }
  }

  prepare(entry: VoiceTtsModelManifestEntry, stagingDir: string, beforeWrite: () => void): Promise<VoiceModelPublicationReceipt> {
    return this.own(entry.id, async () => {
      entry = this.entry(entry); const binding = await this.roots(true, beforeWrite)
      const relative = stagingDir.slice(this.options.modelRootDir.length + 1)
      if (!stagingDir.startsWith(this.options.modelRootDir + sep) || !new RegExp(`^\\.${entry.id}\\.stage-[A-Za-z0-9]+${sep === '\\' ? '\\\\' : '/'}payload$`).test(relative)) fail('VOICE_MODEL_INVENTORY_TREE_UNSAFE')
      for (const phase of ['prepared', 'committed', 'retiring'] as const) await this.absent(this.path(entry.id, phase))
      await this.absent(join(this.options.modelRootDir, entry.id))
      const record: InventoryRecord = { version: 1, kind: 'tts-publication', phase: 'prepared', publicationId: randomUUID(), model: modelIdentity(entry), binding, tree: await this.tree(stagingDir, entry, beforeWrite) }
      const file = await this.writeRecord(record, beforeWrite), token = {}
      this.admissions.set(token, { record, file }); return { token }
    })
  }
  commit(entry: VoiceTtsModelManifestEntry, receipt: VoiceModelPublicationReceipt, beforeWrite: () => void): Promise<void> {
    return this.own(entry.id, async () => {
      entry = this.entry(entry); const accepted = this.admissions.get(receipt.token)
      if (!accepted || accepted.record.model.id !== entry.id) fail('VOICE_MODEL_INVENTORY_OWNER_MISMATCH')
      const prepared = await this.readRecord(entry, 'prepared', beforeWrite)
      if (JSON.stringify(prepared.record) !== JSON.stringify(accepted.record) || !sameIdentity(prepared.file, accepted.file)) fail('VOICE_MODEL_INVENTORY_CHANGED')
      if (JSON.stringify(await this.tree(join(this.options.modelRootDir, entry.id), entry, beforeWrite)) !== JSON.stringify(prepared.record.tree)) fail('VOICE_MODEL_INVENTORY_TREE_CHANGED')
      await this.syncDirectory(this.options.modelRootDir); this.current(beforeWrite)
      await this.writeRecord({ ...prepared.record, phase: 'committed' }, beforeWrite)
      await this.matchingFile(this.path(entry.id, 'prepared'), prepared.file); this.current(beforeWrite); await unlink(this.path(entry.id, 'prepared'))
      await this.syncDirectory(this.options.inventoryRootDir); this.admissions.delete(receipt.token)
    })
  }
  assertCommitted(entry: VoiceTtsModelManifestEntry, beforeWrite: () => void): Promise<void> {
    return this.own(entry.id, async () => {
      entry = this.entry(entry); await this.roots(false, beforeWrite)
      for (const phase of ['prepared', 'retiring'] as const) await this.absent(this.path(entry.id, phase))
      const committed = await this.readRecord(entry, 'committed', beforeWrite)
      if (JSON.stringify(await this.tree(join(this.options.modelRootDir, entry.id), entry, beforeWrite)) !== JSON.stringify(committed.record.tree)) fail('VOICE_MODEL_INVENTORY_TREE_CHANGED')
    })
  }
  remove(entry: VoiceTtsModelManifestEntry, beforeWrite: () => void): Promise<void> {
    return this.own(entry.id, async () => {
      entry = this.entry(entry)
      await this.roots(false, beforeWrite)
      for (const phase of ['prepared', 'retiring'] as const) await this.absent(this.path(entry.id, phase))
      const committed = await this.readRecord(entry, 'committed', beforeWrite), path = join(this.options.modelRootDir, entry.id)
      if (JSON.stringify(await this.tree(path, entry, beforeWrite)) !== JSON.stringify(committed.record.tree)) fail('VOICE_MODEL_INVENTORY_TREE_CHANGED')
      this.current(beforeWrite)
      const container = await mkdtemp(join(this.options.modelRootDir, `.${entry.id}.remove-`)), containerInfo = await lstat(container), retired = join(container, 'owned')
      const record: InventoryRecord = { ...committed.record, phase: 'retiring', retirement: { relative: container.slice(this.options.modelRootDir.length + 1), container: identity(containerInfo) } }
      const retiring = await this.writeRecord(record, beforeWrite)
      this.current(beforeWrite); await this.roots(false, beforeWrite); await this.matchingFile(this.path(entry.id, 'committed'), committed.file)
      this.current(beforeWrite); await rename(path, retired); await this.syncDirectory(this.options.modelRootDir)
      if (JSON.stringify(await this.tree(retired, entry, beforeWrite)) !== JSON.stringify(committed.record.tree)) fail('VOICE_MODEL_INVENTORY_TREE_CHANGED')
      let index = 0
      const root = committed.record.tree[0]!
      for (const row of [...committed.record.tree].reverse()) {
        this.current(beforeWrite); await this.roots(false, beforeWrite)
        await this.matchingFile(this.path(entry.id, 'committed'), committed.file); await this.matchingFile(this.path(entry.id, 'retiring'), retiring)
        const parent = await lstat(container), currentRoot = await lstat(retired)
        if (parent.isSymbolicLink() || !sameIdentity(parent, containerInfo) || currentRoot.isSymbolicLink() || !sameIdentity(currentRoot, root)) fail('VOICE_MODEL_INVENTORY_TREE_CHANGED')
        const leaf = row.path ? join(retired, ...row.path.split('/')) : retired
        // Verify every traversed ancestor, preventing link replacement from
        // changing which directory an exact leaf operation reaches.
        let ancestor = retired
        for (const segment of row.path.split('/').slice(0, -1)) {
          ancestor = join(ancestor, segment); const relative = ancestor.slice(retired.length + 1).split(sep).join('/'), expected = committed.record.tree.find(value => value.path === relative), info = await lstat(ancestor)
          if (!expected || expected.type !== 'directory' || info.isSymbolicLink() || !info.isDirectory() || !sameIdentity(info, expected) || await realpath(ancestor) !== ancestor) fail('VOICE_MODEL_INVENTORY_TREE_CHANGED')
        }
        const current = await lstat(leaf)
        if (current.isSymbolicLink() || !sameIdentity(current, row) || current.mode !== row.mode || await realpath(leaf) !== leaf) fail('VOICE_MODEL_INVENTORY_TREE_CHANGED')
        if (row.type === 'file') {
          if (!current.isFile() || current.size !== row.size || current.mtimeMs !== row.mtimeMs || await this.hash(leaf, current, beforeWrite) !== row.sha256) fail('VOICE_MODEL_INVENTORY_TREE_CHANGED')
          const capturedLeaf = join(container, `entry-${index++}`); await this.absent(capturedLeaf); this.current(beforeWrite); await rename(leaf, capturedLeaf)
          const captured = await lstat(capturedLeaf)
          if (!captured.isFile() || captured.isSymbolicLink() || !sameIdentity(captured, row) || captured.size !== row.size || captured.mtimeMs !== row.mtimeMs || await this.hash(capturedLeaf, captured, beforeWrite) !== row.sha256) fail('VOICE_MODEL_INVENTORY_TREE_CHANGED')
          this.current(beforeWrite)
          const last = await lstat(capturedLeaf), lastParent = await lstat(container)
          if (last.isSymbolicLink() || !sameIdentity(last, row) || last.size !== row.size || last.mtimeMs !== row.mtimeMs || lastParent.isSymbolicLink() || !sameIdentity(lastParent, containerInfo)) fail('VOICE_MODEL_INVENTORY_TREE_CHANGED')
          await unlink(capturedLeaf)
        } else { if (!current.isDirectory()) fail('VOICE_MODEL_INVENTORY_TREE_CHANGED'); this.current(beforeWrite); await rmdir(leaf) }
      }
      this.current(beforeWrite); await rmdir(container); await this.syncDirectory(this.options.modelRootDir)
      await this.matchingFile(this.path(entry.id, 'committed'), committed.file); this.current(beforeWrite); await unlink(this.path(entry.id, 'committed'))
      await this.matchingFile(this.path(entry.id, 'retiring'), retiring); this.current(beforeWrite); await unlink(this.path(entry.id, 'retiring')); await this.syncDirectory(this.options.inventoryRootDir)
    })
  }
}
