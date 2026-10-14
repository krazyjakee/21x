/**
 * On-demand speech model storage (design §5.10).
 *
 * Rules:
 *  - Download only after the user agrees, and only when the manifest carries a
 *    verified SHA-256 for every file.
 *  - Verify each file before it becomes visible. A partial file is written to a
 *    `.part` name and is renamed only after the checksum matches.
 *  - An interrupted download resumes from the bytes already on disk.
 *  - The user can delete a model and get the disk space back.
 *  - A model directory is versioned by model ID, so an app update never
 *    silently changes the model in use.
 *  - A model that is no longer offered (a `legacy` catalogue entry, or a
 *    directory the catalogue no longer names at all) is still listed when it
 *    is on disk, so the user can see it and delete it. It is never downloaded.
 */

import { createHash, randomUUID } from 'crypto'
import { createWriteStream, constants } from 'fs'
import { mkdir, rm, stat, rename, readdir, open, lstat, realpath, link, unlink, rmdir, opendir } from 'fs/promises'
import { join, isAbsolute } from 'path'
import { AsyncLocalStorage } from 'async_hooks'
import { totalmem } from 'os'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import type {
  VoiceModelKind,
  VoiceModelManifestEntry,
  VoiceModelPhase,
  VoiceModelState,
} from '../../shared/voice'
import {
  VOICE_MODEL_MANIFEST,
  isManifestVerified,
  manifestKind,
  manifestSizeBytes,
} from './voice-model-manifest'
import { VoiceModelDownloadPolicy, VOICE_MODEL_DOWNLOAD_DEADLINE_MS } from './voice-model-download-policy'

export interface ResolvedModel {
  id: string
  dir: string
  encoder: string
  decoder: string
  joiner: string
  tokens: string
  /** Tells the worker which recogniser to build. Absent means streaming. */
  kind?: VoiceModelKind
}

/**
 * A hand-installed directory is an offline (Parakeet-style) model when its
 * name says so. There is nothing inside a sherpa-onnx transducer export that
 * tells the two apart before loading, so the name is the signal, and the
 * settings page says which names count.
 */
export function customDirKind(dir: string): VoiceModelKind {
  return /parakeet|offline/i.test(dir.split(/[\\/]/).filter(Boolean).pop() ?? '') ? 'offline' : 'streaming'
}

export interface VoiceModelManagerOptions {
  /** Root directory for downloaded models — normally `<userData>/voice-models`. */
  rootDir: string
  /** Injected for tests. */
  fetchImpl?: typeof fetch
  /** Trusted filesystem primitive; production uses the actual Node open. */
  openFile?: typeof open
  onProgress?: (state: VoiceModelState) => void
  portable?: boolean
  downloads?: 'enabled' | 'disabled'
  assertCurrent?: () => void
  beforeRequest?: () => void
}

export class VoiceModelManager {
  private installing = new Map<string, number>()
  private phases = new Map<string, VoiceModelPhase>()
  private errors = new Map<string, string>()
  private aborts = new Map<string, AbortController>()

  private closing = false
  private flights = new Set<Promise<unknown>>()
  private installations = new Map<string, Promise<VoiceModelState>>()
  private guards = new AsyncLocalStorage<() => void>()
  private readonly manifest: VoiceModelManifestEntry[]
  private readonly downloadPolicy: VoiceModelDownloadPolicy | null
  private progressListener?: (state: VoiceModelState) => void
  constructor(private options: VoiceModelManagerOptions) {
    if (!isAbsolute(options.rootDir)) throw new Error('VOICE_MODEL_ROOT_REQUIRED')
    this.manifest = structuredClone(VOICE_MODEL_MANIFEST)
    this.downloadPolicy = options.portable ? new VoiceModelDownloadPolicy(this.manifest.filter(isManifestVerified)) : null
    const methods = this as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    for (const name of ['list','listLegacyInstalled','isInstalled','resolve','remove','removeAll'] as const) {
      const original = methods[name].bind(this)
      methods[name] = (...args) => {
        try { this.current(); return this.own(original(...args)) } catch (error) { return Promise.reject(error) }
      }
    }
  }
  assertRoot(root: string): void { if (root !== this.options.rootDir) throw new Error('VOICE_MODEL_OWNER_MISMATCH') }
  setProgressListener(listener: (state: VoiceModelState) => void): void { this.progressListener = listener }
  get inflightCount(): number { return this.flights.size }
  private current(): void {
    if (this.closing) throw new Error('VOICE_MODEL_CLOSED')
    this.options.assertCurrent?.()
    this.guards.getStore()?.()
  }
  withMutationGuard<T>(effect: () => T | Promise<T>, guard: () => void): Promise<T> {
    this.current()
    return this.guards.run(guard, () => this.own(Promise.resolve().then(effect)))
  }
  private own<T>(raw: Promise<T>): Promise<T> {
    this.flights.add(raw)
    void raw.then(() => this.flights.delete(raw), () => this.flights.delete(raw))
    return raw
  }
  stop(): void { this.closing = true; for (const controller of this.aborts.values()) controller.abort() }
  async close(timeoutMs = 3000): Promise<void> {
    this.stop()
    const deadline = Date.now() + Math.max(1, Math.min(timeoutMs, 30000))
    while (this.flights.size) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('VOICE_MODEL_DRAIN_INCOMPLETE')
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([Promise.allSettled([...this.flights]), new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining) })])
      if (timer) clearTimeout(timer)
    }
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  modelDir(id: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) || id === '.' || id === '..') throw new Error('VOICE_MODEL_ID_INVALID')
    return join(this.options.rootDir, id)
  }

  /**
   * Every catalogue entry, then every directory on disk the catalogue does not
   * name (a model from an older release). Those are `legacy`, so the settings
   * page offers to delete them and never to download them.
   */
  async list(activeId?: string): Promise<VoiceModelState[]> {
    const states: VoiceModelState[] = []
    if (this.options.portable) await this.safeDirectory(this.options.rootDir, true)
    for (const entry of this.manifest) {
      states.push({
        ...this.stateOf(entry),
        active: entry.id === activeId,
        installed: await this.isInstalled(entry),
      })
    }
    // Portable management can project only the reviewed catalogue. Unknown
    // legacy trees remain on disk and are never treated as deletion authority.
    for (const id of this.options.portable ? [] : await this.strayModelIds()) {
      states.push({
        id,
        label: `Older model (${id})`,
        description: 'Left by an earlier version of 20x. It is not in the catalogue any more and cannot be loaded.',
        license: 'unknown',
        licenseUrl: '',
        languages: [],
        active: id === activeId,
        installed: true,
        installing: false,
        progress: 0,
        sizeBytes: await directorySize(this.modelDir(id)),
        downloadable: false,
        legacy: true,
      })
    }
    return states
  }

  /** Installed models the user should be moved off: legacy entries and strays. */
  async listLegacyInstalled(): Promise<VoiceModelState[]> {
    return (await this.list()).filter((m) => m.legacy && m.installed)
  }

  /** Directories under the root that no catalogue entry names. */
  private async strayModelIds(): Promise<string[]> {
    const names = await readdir(this.options.rootDir, { withFileTypes: true }).catch(() => [])
    if (names.length > 256) throw new Error('VOICE_MODEL_DIRECTORY_LIMIT')
    const known = new Set(this.manifest.map((entry) => entry.id))
    return names
      .filter((d) => d.isDirectory() && !known.has(d.name))
      .map((d) => d.name)
      .sort()
  }

  async isInstalled(entry: VoiceModelManifestEntry): Promise<boolean> {
    const dir = this.modelDir(entry.id)
    if (this.options.portable && !(await this.safeDirectory(dir, true))) return false
    for (const file of entry.files) {
      const info = await (this.options.portable ? lstat : stat)(join(dir, file.name)).catch(() => null)
      if (!info || !info.isFile() || info.size === 0) return false
      if (this.options.portable && (info.isSymbolicLink() || info.size > file.sizeBytes)) throw new Error('VOICE_MODEL_FILE_UNSAFE')
    }
    return true
  }

  /**
   * Returns the paths the worker needs, or null when nothing usable is present.
   * A hand-installed directory wins over the catalogue so that a user is never
   * blocked by a pending checksum.
   */
  async resolve(modelId: string, customDir?: string): Promise<ResolvedModel | null> {
    if (customDir) {
      if (this.options.portable) throw new Error('VOICE_CUSTOM_MODEL_UNAVAILABLE')
      const resolved = await this.resolveCustomDir(customDir)
      if (resolved) return resolved
    }
    const entry = this.manifest.find((item) => item.id === modelId)
    if (!entry) return null
    if (!(await this.isInstalled(entry))) return null
    const dir = this.modelDir(entry.id)
    return {
      id: entry.id,
      dir,
      encoder: join(dir, entry.roles.encoder),
      decoder: join(dir, entry.roles.decoder),
      joiner: join(dir, entry.roles.joiner),
      tokens: join(dir, entry.roles.tokens),
      kind: manifestKind(entry),
    }
  }

  /**
   * Accepts a directory that holds an encoder, a decoder, a joiner and a tokens
   * file, whatever their exact names are. This matches the layout of an
   * unpacked sherpa-onnx model release.
   */
  private async resolveCustomDir(dir: string): Promise<ResolvedModel | null> {
    const names = await readdir(dir).catch(() => null)
    if (!names) return null
    const pick = (needle: string, ext: string): string | undefined =>
      names.find((n) => n.toLowerCase().includes(needle) && n.toLowerCase().endsWith(ext))
    const encoder = pick('encoder', '.onnx')
    const decoder = pick('decoder', '.onnx')
    const joiner = pick('joiner', '.onnx')
    const tokens = names.find((n) => n.toLowerCase() === 'tokens.txt')
    if (!encoder || !decoder || !joiner || !tokens) return null
    return {
      id: 'custom',
      dir,
      encoder: join(dir, encoder),
      decoder: join(dir, decoder),
      joiner: join(dir, joiner),
      tokens: join(dir, tokens),
      kind: customDirKind(dir),
    }
  }

  /** Downloads and verifies one catalogue entry. */
  install(id: string): Promise<VoiceModelState> {
    try { this.current() } catch (error) { return Promise.reject(error) }
    const existing = this.installations.get(id)
    if (existing) return existing
    const raw = this.own(this.installOwned(id))
    this.installations.set(id, raw)
    void raw.then(() => this.installations.delete(id), () => this.installations.delete(id))
    return raw
  }
  private async installOwned(id: string): Promise<VoiceModelState> {
    if (this.options.downloads === 'disabled') throw new Error('VOICE_MODEL_DOWNLOAD_UNAVAILABLE')
    const entry = this.manifest.find((item) => item.id === id)
    if (!entry) throw new Error(`Unknown voice model: ${id}`)
    if (entry.legacy) {
      throw new Error(
        `"${entry.label}" is no longer offered. Download Parakeet v3 from Voice settings instead.`
      )
    }
    if (!isManifestVerified(entry)) {
      throw new Error(
        `The checksum for "${entry.label}" is not recorded yet. ` +
          'Install the model by hand and set the custom model directory in Voice settings.'
      )
    }
    const needed = manifestSizeBytes(entry)
    // Refuse only when the machine itself is too small. Free memory alone is
    // a poor gate: the operating system gives caches back on demand.
    if (totalmem() < entry.minMemoryBytes) {
      throw new Error(
        `"${entry.label}" needs about ${gigabytes(entry.minMemoryBytes)} GB of memory and this computer has ` +
          `${gigabytes(totalmem())} GB. It cannot run here.`
      )
    }

    const dir = this.modelDir(entry.id)
    this.current()
    if (this.options.portable) await this.safeDirectory(this.options.rootDir, true)
    this.current()
    await mkdir(dir, { recursive: true })
    this.current()
    if (this.options.portable) await this.safeDirectory(dir)
    const controller = new AbortController()
    const deadline = this.options.portable ? setTimeout(() => controller.abort(new Error('VOICE_MODEL_DOWNLOAD_DEADLINE')), VOICE_MODEL_DOWNLOAD_DEADLINE_MS) : null
    deadline?.unref?.()
    this.aborts.set(entry.id, controller)
    this.errors.delete(entry.id)
    this.installing.set(entry.id, 0)
    this.phases.set(entry.id, 'downloading')
    let done = 0
    try {
      this.emit(entry)
      for (const file of entry.files) {
        this.current()
        if (controller.signal.aborted) throw new Error('VOICE_MODEL_ABORTED')
        const target = join(dir, file.name)
        const existing = await (this.options.portable ? lstat : stat)(target).catch(() => null)
        if (this.options.portable && existing && (!existing.isFile() || existing.isSymbolicLink() || existing.size > file.sizeBytes)) throw new Error('VOICE_MODEL_FILE_UNSAFE')
        if (existing?.isFile() && (await sha256OfFile(target)) === file.sha256) {
          done += file.sizeBytes
          this.installing.set(entry.id, Math.min(1, done / needed))
          this.emit(entry)
          continue
        }
        if (this.options.portable && existing) throw new Error('VOICE_MODEL_UNOWNED_FILE')
        this.phases.set(entry.id, 'downloading')
        await (this.options.portable ? this.downloadOwnedFile.bind(this) : this.downloadFile.bind(this))(
          file.url,
          target,
          file.sha256,
          controller.signal,
          (bytes) => {
            this.installing.set(entry.id, Math.min(1, (done + bytes) / needed))
            this.emit(entry)
          },
          () => {
            this.phases.set(entry.id, 'verifying')
            this.emit(entry)
          },
          file.sizeBytes
        )
        done += file.sizeBytes
      }
    } catch (err) {
      const message = describeInstallFailure(err, entry)
      this.errors.set(entry.id, message)
      this.installing.delete(entry.id)
      this.phases.delete(entry.id)
      this.aborts.delete(entry.id)
      this.emit(entry)
      throw new Error(message)
    } finally { if (deadline) clearTimeout(deadline) }

    this.installing.delete(entry.id)
    this.phases.delete(entry.id)
    this.aborts.delete(entry.id)
    this.emit(entry)
    const states = await this.list()
    return states.find((s) => s.id === entry.id) as VoiceModelState
  }

  cancel(id: string): void {
    this.aborts.get(id)?.abort()
  }

  /** Removes the files and the directory of one model. */
  async remove(id: string): Promise<void> {
    this.cancel(id)
    await this.installations.get(id)?.catch(() => {})
    this.current()
    if (this.options.portable) await this.validateRemoval(id)
    this.current()
    if (this.options.portable) await this.removeOwnedDirectory(id)
    else await rm(this.modelDir(id), { recursive: true, force: true })
    this.errors.delete(id)
  }

  /** Removes every downloaded model (the "Delete models" control). */
  async removeAll(): Promise<void> {
    for (const id of this.aborts.keys()) this.cancel(id)
    await Promise.allSettled([...this.installations.values()])
    this.current()
    if (this.options.portable) {
      for (const entry of this.manifest) await this.validateRemoval(entry.id)
      for (const entry of this.manifest) { this.current(); await this.removeOwnedDirectory(entry.id) }
    } else await rm(this.options.rootDir, { recursive: true, force: true })
    this.errors.clear()
  }

  private async downloadFile(
    url: string,
    target: string,
    expectedSha256: string,
    signal: AbortSignal,
    onBytes: (bytes: number) => void,
    onVerify: () => void = () => {},
    _sizeBytes?: number
  ): Promise<void> {
    const partial = `${target}.part`
    const already = (await stat(partial).catch(() => null))?.size ?? 0
    const headers: Record<string, string> = already > 0 ? { Range: `bytes=${already}-` } : {}

    this.options.beforeRequest?.()
    this.current()
    const response = await this.fetchImpl(url, { headers, signal })
    try { this.current(); if (signal.aborted) throw new Error('VOICE_MODEL_ABORTED') } catch (error) { await response.body?.cancel(); throw error }
    if (!response.ok || !response.body) {
      throw new Error(`Download failed (${response.status}) for ${url}`)
    }
    // The server ignored the range request, so start again from zero.
    const append = already > 0 && response.status === 206
    if (!append && already > 0) await rm(partial, { force: true })

    let received = append ? already : 0
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    source.on('data', (chunk: Buffer) => {
      received += chunk.length
      onBytes(received)
    })
    await pipeline(source, createWriteStream(partial, { flags: append ? 'a' : 'w' }), { signal })
    this.current()
    if (signal.aborted) throw new Error('VOICE_MODEL_ABORTED')

    onVerify()
    const digest = await sha256OfFile(partial)
    if (digest !== expectedSha256) {
      await rm(partial, { force: true })
      throw new Error(`Checksum mismatch for ${url}`)
    }
    await rename(partial, target)
  }

  private async safeDirectory(path: string, missing = false): Promise<Awaited<ReturnType<typeof lstat>> | null> {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (missing && error.code === 'ENOENT') return null; throw new Error('VOICE_MODEL_PATH_UNAVAILABLE') })
    if (!info) return null
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('VOICE_MODEL_PATH_UNSAFE')
    return info
  }
  private async validateRemoval(id: string): Promise<void> {
    await this.safeDirectory(this.options.rootDir, true)
    const dir = this.modelDir(id)
    if (!(await this.safeDirectory(dir, true))) return
    const entry = this.manifest.find((item) => item.id === id)
    if (!entry) throw new Error('VOICE_MODEL_REMOVAL_UNAVAILABLE')
    const names = await this.boundedOwnedNames(dir, entry.files.length)
    const owned = new Set(entry.files.map((file) => file.name))
    if (names.some((name) => !owned.has(name))) throw new Error('VOICE_MODEL_UNOWNED_FILE')
    for (const name of names) {
      const info = await lstat(join(dir, name))
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('VOICE_MODEL_FILE_UNSAFE')
      const expected = entry.files.find((file) => file.name === name)!
      if (info.size !== expected.sizeBytes || await sha256OfFile(join(dir, name)) !== expected.sha256) throw new Error('VOICE_MODEL_UNOWNED_FILE')
    }
  }
  private async boundedOwnedNames(dir: string, max: number): Promise<string[]> {
    const handle = await opendir(dir)
    const names: string[] = []
    try {
      for (;;) {
        const item = await handle.read()
        if (!item) return names
        if (names.length === max) throw new Error('VOICE_MODEL_UNOWNED_FILE')
        names.push(item.name)
      }
    } finally { await handle.close() }
  }
  private async removeOwnedDirectory(id: string): Promise<void> {
    const dir = this.modelDir(id)
    const parent = await this.safeDirectory(dir, true)
    if (!parent) return
    const names = await this.boundedOwnedNames(dir, this.manifest.find((entry) => entry.id === id)?.files.length ?? 0)
    const allowed = new Set(this.manifest.find((entry) => entry.id === id)?.files.map((file) => file.name) ?? [])
    if (names.some((name) => !allowed.has(name))) throw new Error('VOICE_MODEL_UNOWNED_FILE')
    for (const name of names) {
      const path = join(dir, name)
      const file = await lstat(path)
      const expected = this.manifest.find((entry) => entry.id === id)?.files.find((item) => item.name === name)
      if (!expected || file.size !== expected.sizeBytes || await sha256OfFile(path) !== expected.sha256) throw new Error('VOICE_MODEL_UNOWNED_FILE')
      const currentFile = await lstat(path)
      const now = await this.safeDirectory(dir)
      if (!now || now.dev !== parent.dev || now.ino !== parent.ino || !file.isFile() || file.isSymbolicLink() || currentFile.dev !== file.dev || currentFile.ino !== file.ino || currentFile.size !== file.size || currentFile.mtimeMs !== file.mtimeMs) throw new Error('VOICE_MODEL_PATH_CHANGED')
      this.current()
      await unlink(path)
    }
    this.current()
    const now = await this.safeDirectory(dir)
    if (!now || now.dev !== parent.dev || now.ino !== parent.ino) throw new Error('VOICE_MODEL_PATH_CHANGED')
    // Concurrent/user files prevent rmdir; never recursively sweep them.
    await rmdir(dir)
  }
  private async downloadOwnedFile(url: string, target: string, expectedSha256: string, signal: AbortSignal, onBytes: (bytes: number) => void, onVerify: () => void, sizeBytes = 0): Promise<void> {
    const dir = join(target, '..')
    const parent = await this.safeDirectory(dir)
    const partial = `${target}.owned-${randomUUID()}.part`
    this.current()
    if (signal.aborted) throw new Error('VOICE_MODEL_ABORTED')
    const handle = await (this.options.openFile ?? open)(partial, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600)
    let receipt: Awaited<ReturnType<typeof handle.stat>> | null = null
    let published = false
    try {
      receipt = await handle.stat()
      this.current()
      if (!this.downloadPolicy) throw new Error('VOICE_MODEL_DOWNLOAD_POLICY_UNAVAILABLE')
      const response = await this.downloadPolicy.request(url, { fetchImpl: this.fetchImpl, signal, assertCurrent: () => this.current(), beforeRequest: this.options.beforeRequest })
      const reader = response.body?.getReader()
      let received = 0
      const hash = createHash('sha256')
      let ended = false
      let cancellation: Promise<void> | null = null
      const cancelReader = (): Promise<void> => {
        if (!cancellation) {
          cancellation = reader ? reader.cancel() : Promise.resolve()
          // Abort callbacks cannot leak a rejection; the operation still awaits
          // this exact raw cleanup receipt before releasing the reader/file.
          void cancellation.catch(() => {})
        }
        return cancellation
      }
      const abortReader = (): void => { void cancelReader() }
      signal.addEventListener('abort', abortReader, { once: true })
      if (signal.aborted) abortReader()
      try {
        this.current()
        if (signal.aborted) throw new Error('VOICE_MODEL_ABORTED')
        if (!response.ok || !reader) throw new Error('VOICE_MODEL_DOWNLOAD_FAILED')
        for (;;) {
          const { value, done } = await reader.read()
          this.current()
          if (signal.aborted) throw new Error('VOICE_MODEL_ABORTED')
          if (done) { ended = true; break }
          received += value.byteLength
          if (received > sizeBytes) throw new Error('VOICE_MODEL_SIZE_MISMATCH')
          const bytes = Buffer.from(value)
          let offset = 0
          while (offset < bytes.length) {
            this.current()
            if (signal.aborted) throw new Error('VOICE_MODEL_ABORTED')
            const written = await handle.write(bytes, offset)
            if (!written.bytesWritten) throw new Error('VOICE_MODEL_WRITE_FAILED')
            offset += written.bytesWritten
          }
          hash.update(bytes); onBytes(received)
        }
      } finally {
        signal.removeEventListener('abort', abortReader)
        if (reader) { try { if (!ended || cancellation) await cancelReader() } finally { reader.releaseLock() } }
      }
      this.current()
      if (signal.aborted) throw new Error('VOICE_MODEL_ABORTED')
      onVerify()
      if (received !== sizeBytes || hash.digest('hex') !== expectedSha256) throw new Error('Checksum mismatch')
      this.current()
      if (signal.aborted) throw new Error('VOICE_MODEL_ABORTED')
      await handle.sync()
      const verifiedFile = await lstat(partial)
      if (verifiedFile.size !== sizeBytes || await sha256OfFile(partial) !== expectedSha256) throw new Error('Checksum mismatch')
      const currentParent = await this.safeDirectory(dir)
      const currentFile = await lstat(partial)
      if (!parent || !currentParent || parent.dev !== currentParent.dev || parent.ino !== currentParent.ino || currentFile.dev !== receipt.dev || currentFile.ino !== receipt.ino || currentFile.size !== verifiedFile.size || currentFile.mtimeMs !== verifiedFile.mtimeMs || !currentFile.isFile()) throw new Error('VOICE_MODEL_PATH_CHANGED')
      this.current()
      if (signal.aborted) throw new Error('VOICE_MODEL_ABORTED')
      // link is exclusive: a file created by another owner is never replaced.
      await link(partial, target)
      published = true
    } finally {
      await handle.close()
      const now = await lstat(partial).catch(() => null)
      const nowParent = await lstat(dir).catch(() => null)
      if (receipt && now && nowParent && parent && now.dev === receipt.dev && now.ino === receipt.ino && nowParent.dev === parent.dev && nowParent.ino === parent.ino && !now.isSymbolicLink()) await unlink(partial)
    }
    if (!published) throw new Error('VOICE_MODEL_PUBLICATION_FAILED')
  }

  private emit(entry: VoiceModelManifestEntry): void {
    if (this.closing) return
    this.options.onProgress?.(this.stateOf(entry))
    this.progressListener?.(this.stateOf(entry))
  }

  /** The catalogue view of one entry. `active` and `installed` are filled by `list`. */
  private stateOf(entry: VoiceModelManifestEntry): VoiceModelState {
    return {
      id: entry.id,
      label: entry.label,
      description: entry.description,
      license: entry.license,
      licenseUrl: entry.licenseUrl,
      languages: entry.languages,
      active: false,
      installed: false,
      installing: this.installing.has(entry.id),
      progress: this.installing.get(entry.id) ?? 0,
      sizeBytes: manifestSizeBytes(entry),
      // A legacy entry is recognised on disk but never fetched again.
      downloadable: !entry.legacy && isManifestVerified(entry),
      kind: manifestKind(entry),
      ...(entry.legacy ? { legacy: true } : {}),
      ...(this.phases.has(entry.id) ? { phase: this.phases.get(entry.id) } : {}),
      ...(this.errors.has(entry.id) ? { error: this.errors.get(entry.id) } : {}),
    }
  }
}

function gigabytes(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, '')
}

/**
 * Projects bounded, fixed failure text. Provider errors, paths and signed
 * download queries are never copied into the public model status.
 */
export function describeInstallFailure(err: unknown, entry: VoiceModelManifestEntry): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/abort/i.test(raw)) return `The download of "${entry.label}" was cancelled.`
  if (/checksum mismatch/i.test(raw)) {
    return `Checksum mismatch. The file does not match the recorded checksum, so it was discarded. Try again later.`
  }
  if (/ENOSPC/i.test(raw)) {
    return `Not enough disk space for "${entry.label}" (${gigabytes(manifestSizeBytes(entry))} GB). Free some space and try again.`
  }
  if (/Download failed \((\d+)\)/.test(raw)) {
    const status = /Download failed \((\d+)\)/.exec(raw)?.[1]
    return `The download of "${entry.label}" failed (${status}). Check the connection and try again.`
  }
  if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(raw)) {
    return `The download of "${entry.label}" could not reach the server. Check the connection and try again.`
  }
  return `The download of "${entry.label}" failed safely. Check the model files and try again.`
}

async function directorySize(dir: string): Promise<number> {
  const names = await readdir(dir).catch(() => [])
  let total = 0
  for (const name of names) {
    const info = await stat(join(dir, name)).catch(() => null)
    if (info?.isFile()) total += info.size
  }
  return total
}

export async function sha256OfFile(path: string): Promise<string> {
  const expected = await lstat(path)
  if (!expected.isFile() || expected.isSymbolicLink() || expected.size > 2 * 1024 ** 3) throw new Error('VOICE_MODEL_FILE_UNSAFE')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const actual = await handle.stat()
    if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size) throw new Error('VOICE_MODEL_PATH_CHANGED')
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(1024 * 1024)
    let total = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > expected.size) throw new Error('VOICE_MODEL_PATH_CHANGED')
      hash.update(buffer.subarray(0, bytesRead))
    }
    const final = await lstat(path)
    if (total !== expected.size || final.dev !== expected.dev || final.ino !== expected.ino || final.size !== expected.size || final.mtimeMs !== expected.mtimeMs || final.isSymbolicLink()) throw new Error('VOICE_MODEL_PATH_CHANGED')
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}
