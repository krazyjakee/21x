/**
 * On-demand speech-synthesis model storage (design §5.10).
 *
 * The rules match `VoiceModelManager`, which does the same job for speech
 * recognition:
 *  - download only after the user agrees, and only when the manifest carries a
 *    verified SHA-256,
 *  - verify before anything becomes visible,
 *  - resume an interrupted download,
 *  - let the user delete a model and get the disk space back,
 *  - keep one directory per model ID, so an app update never silently changes
 *    the voice in use.
 *
 * The one difference is the shape of the download. A voice needs an
 * `espeak-ng-data` directory of about 355 files, so the catalogue points at the
 * published archive. The archive is checksummed as a whole and is extracted
 * only after that value matches.
 */

import { createHash } from 'crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { constants, createReadStream, createWriteStream, lstatSync, realpathSync, readdirSync } from 'fs'
import { mkdir, rm, rmdir, unlink, stat, rename, open, lstat, realpath, mkdtemp, readdir } from 'fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'path'
import { totalmem, freemem } from 'os'
import { pipeline } from 'stream/promises'
import { Readable, Transform } from 'stream'
import { setTimeout as sleep } from 'timers/promises'
import bz2 from 'unbzip2-stream'
import { extract as tarExtract } from 'tar-stream'
import type { VoiceTtsModelManifestEntry, VoiceTtsModelState } from '../../shared/voice-tts'
import {
  VOICE_TTS_MODEL_MANIFEST,
  findTtsManifestEntry,
  isTtsManifestVerified,
} from './voice-tts-manifest'

export interface ResolvedTtsModel {
  id: string
  family: 'kokoro' | 'kitten'
  dir: string
  model: string
  voices: string
  tokens: string
  dataDir: string
  sampleRate: number
}

export interface VoiceTtsModelManagerOptions {
  /** Normally `<userData>/voice-tts-models`. */
  rootDir: string
  fetchImpl?: typeof fetch
  onProgress?: (state: VoiceTtsModelState) => void
  /** How a dropped download is retried. Narrowed in tests so they stay quick. */
  retry?: { attempts?: number; baseDelayMs?: number }
  host?: VoiceTtsModelHost
}
export interface VoiceTtsModelHost {
  downloads: 'enabled' | 'disabled'
  assertCurrent(): void
  beforeRequest(address: string): void
}

/** The download is most of the wait; extraction is the rest. */
const DOWNLOAD_SHARE = 0.9

/**
 * How many times a dropped download is resumed before the user is told.
 *
 * Each attempt continues from the bytes already on disk, so this is a budget
 * for interruptions and not for repeated whole downloads.
 */
const VOICE_TTS_DOWNLOAD_ATTEMPTS = 6

export class VoiceTtsModelManager {
  private installing = new Map<string, number>()
  private errors = new Map<string, string>()
  private aborts = new Map<string, AbortController>()
  private readonly flights = new Map<string, Promise<VoiceTtsModelState>>()
  private readonly reads = new Set<Promise<unknown>>()
  private closing = false
  private readonly manifest: VoiceTtsModelManifestEntry[] | null
  private readonly management = new AsyncLocalStorage<{ token: object; beforeWrite(): void }>()
  private managementToken: object | null = null
  private rootIdentity: { dev: number; ino: number } | null = null
  // Receipts grant removal only for this owner's exact published bytes. A
  // historical tree is readable, but is never silently adopted for deletion.
  private readonly publications = new Map<string, { archive: string; tree: string }>()

  constructor(private options: VoiceTtsModelManagerOptions) {
    if (options.host && !isAbsolute(options.rootDir)) throw new Error('VOICE_TTS_MODEL_ROOT_INVALID')
    this.manifest = options.host ? structuredClone(VOICE_TTS_MODEL_MANIFEST) : null
    options.host?.assertCurrent()
    if (options.host) {
      try { const info = lstatSync(options.rootDir); if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(options.rootDir) !== resolve(options.rootDir)) throw new Error('VOICE_TTS_MODEL_PATH_UNSAFE'); this.rootIdentity = { dev: info.dev, ino: info.ino } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
  get inflightCount(): number { return this.flights.size + this.reads.size }
  assertOwner(rootDir: string, host?: VoiceTtsModelHost): void {
    if (rootDir !== this.options.rootDir || host !== this.options.host) throw new Error('VOICE_TTS_MODEL_OWNER_MISMATCH')
    this.available()
  }
  private available(): void { if (this.closing) throw new Error('VOICE_TTS_MODELS_CLOSED'); this.options.host?.assertCurrent() }
  runManagementMutation<T>(effect: () => Promise<T>, beforeWrite: () => void): Promise<T> {
    if (this.managementToken) return Promise.reject(new Error('VOICE_MANAGEMENT_BUSY'))
    const token = {}; this.managementToken = token
    return this.management.run({ token, beforeWrite }, () => this.retain(Promise.resolve().then(() => { this.beforeWrite(); return effect() })))
      .finally(() => { if (this.managementToken === token) this.managementToken = null })
  }
  private beforeWrite(): void { this.available(); const owner = this.management.getStore(); if (this.managementToken && owner?.token !== this.managementToken) throw new Error('VOICE_MANAGEMENT_BUSY'); owner?.beforeWrite() }
  private entry(id: string): VoiceTtsModelManifestEntry | undefined { return this.manifest?.find(entry => entry.id === id) ?? (this.manifest ? undefined : findTtsManifestEntry(id)) }
  private retain<T>(work: Promise<T>): Promise<T> { this.reads.add(work); void work.then(() => this.reads.delete(work), () => this.reads.delete(work)); return work }
  shutdown(): void { this.closing = true; for (const controller of this.aborts.values()) controller.abort() }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid speech model shutdown deadline')
    this.shutdown(); let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.allSettled([...this.flights.values(), ...this.reads]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('VOICE_TTS_MODELS_SHUTDOWN_INCOMPLETE')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  /** Worker-bound synchronous proof of actual paths/files; no external path
   * can be adopted by a request and espeak data cannot contain symlinks. */
  assertResolvedModel(model: ResolvedTtsModel): void {
    this.available(); const entry = this.entry(model.id), dir = this.modelDir(model.id)
    if (!entry || model.dir !== dir || model.model !== join(dir, entry.files.model) || model.voices !== join(dir, entry.files.voices) || model.tokens !== join(dir, entry.files.tokens) || model.dataDir !== join(dir, entry.files.dataDir) || model.family !== entry.family || model.sampleRate !== entry.sampleRate) throw new Error('VOICE_TTS_MODEL_OWNER_MISMATCH')
    const root = lstatSync(this.options.rootDir)
    if (root.isSymbolicLink() || this.rootIdentity && (root.dev !== this.rootIdentity.dev || root.ino !== this.rootIdentity.ino) || realpathSync(this.options.rootDir) !== resolve(this.options.rootDir) || realpathSync(dir) !== dir || lstatSync(dir).isSymbolicLink()) throw new Error('VOICE_TTS_MODEL_PATH_UNSAFE')
    let count = 0, bytes = 0
    const walk = (path: string, depth: number): void => {
      const info = lstatSync(path); if (info.isSymbolicLink() || depth > 16 || ++count > 4096) throw new Error('VOICE_TTS_MODEL_PATH_UNSAFE')
      if (info.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name), depth + 1)
      else if (info.isFile()) { bytes += info.size; if (bytes > entry.archive.unpackedBytes * 2 + 8 * 1024 * 1024) throw new Error('VOICE_TTS_MODEL_SIZE_LIMIT') }
      else throw new Error('VOICE_TTS_MODEL_PATH_UNSAFE')
    }
    walk(dir, 0)
  }
  private async root(create = false): Promise<void> {
    this.available()
    try { const info = await lstat(this.options.rootDir); if (!info.isDirectory() || info.isSymbolicLink() || await realpath(this.options.rootDir) !== resolve(this.options.rootDir) || this.rootIdentity && (info.dev !== this.rootIdentity.dev || info.ino !== this.rootIdentity.ino)) throw new Error('VOICE_TTS_MODEL_PATH_UNSAFE'); this.rootIdentity ??= { dev: info.dev, ino: info.ino } }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (this.rootIdentity) throw new Error('VOICE_TTS_MODEL_PATH_UNSAFE')
      if (!create) return
      if (await realpath(dirname(this.options.rootDir)) !== resolve(dirname(this.options.rootDir))) throw new Error('VOICE_TTS_MODEL_PATH_UNSAFE')
      await mkdir(this.options.rootDir, { mode: 0o700 }); this.available(); const info = await lstat(this.options.rootDir); this.rootIdentity = { dev: info.dev, ino: info.ino }
    }
  }

  list(...args: Parameters<VoiceTtsModelManager['listImpl']>): ReturnType<VoiceTtsModelManager['listImpl']> { return this.retain(Promise.resolve().then(() => { this.available(); return this.listImpl(...args) })) }
  resolve(...args: Parameters<VoiceTtsModelManager['resolveImpl']>): ReturnType<VoiceTtsModelManager['resolveImpl']> { return this.retain(Promise.resolve().then(() => { this.available(); return this.resolveImpl(...args) })) }
  isInstalled(...args: Parameters<VoiceTtsModelManager['isInstalledImpl']>): ReturnType<VoiceTtsModelManager['isInstalledImpl']> { return this.retain(Promise.resolve().then(() => { this.available(); return this.isInstalledImpl(...args) })) }
  remove(...args: Parameters<VoiceTtsModelManager['removeImpl']>): ReturnType<VoiceTtsModelManager['removeImpl']> { return this.retain(Promise.resolve().then(() => { this.available(); return this.removeImpl(...args) })) }
  removeAll(...args: Parameters<VoiceTtsModelManager['removeAllImpl']>): ReturnType<VoiceTtsModelManager['removeAllImpl']> { return this.retain(Promise.resolve().then(() => { this.available(); return this.removeAllImpl(...args) })) }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  private get attempts(): number {
    return Math.max(1, this.options.retry?.attempts ?? VOICE_TTS_DOWNLOAD_ATTEMPTS)
  }

  private get baseDelayMs(): number {
    return this.options.retry?.baseDelayMs ?? 500
  }

  modelDir(id: string): string {
    if (!this.entry(id)) throw new Error('Unknown voice model')
    return join(this.options.rootDir, id)
  }

  private async listImpl(activeId?: string): Promise<VoiceTtsModelState[]> {
    this.available()
    const states: VoiceTtsModelState[] = []
    for (const entry of this.manifest ?? VOICE_TTS_MODEL_MANIFEST) {
      states.push(this.describe(entry, activeId, await this.isInstalled(entry)))
    }
    return states
  }

  private async isInstalledImpl(entry: VoiceTtsModelManifestEntry): Promise<boolean> {
    this.available()
    if (this.options.host) { await this.root(); const trusted = this.entry(entry.id); if (!trusted) return false; entry = trusted }
    const dir = this.modelDir(entry.id)
    for (const relative of [entry.files.model, entry.files.voices, entry.files.tokens]) {
      const info = await stat(join(dir, relative)).catch(() => null)
      if (!info?.isFile() || info.size === 0) return false
    }
    const data = await stat(join(dir, entry.files.dataDir)).catch(() => null)
    if (this.options.host && data?.isDirectory()) {
      try { this.assertResolvedModel({ id: entry.id, family: entry.family, dir, model: join(dir, entry.files.model), voices: join(dir, entry.files.voices), tokens: join(dir, entry.files.tokens), dataDir: join(dir, entry.files.dataDir), sampleRate: entry.sampleRate }) } catch { return false }
    }
    this.available(); return Boolean(data?.isDirectory())
  }

  /** The paths the worker needs, or null when the model is not on disk. */
  private async resolveImpl(id: string): Promise<ResolvedTtsModel | null> {
    this.available()
    const entry = this.entry(id)
    if (!entry) return null
    if (!(await this.isInstalled(entry))) return null
    const dir = this.modelDir(entry.id)
    return {
      id: entry.id,
      family: entry.family,
      dir,
      model: join(dir, entry.files.model),
      voices: join(dir, entry.files.voices),
      tokens: join(dir, entry.files.tokens),
      dataDir: join(dir, entry.files.dataDir),
      sampleRate: entry.sampleRate,
    }
  }

  /** Downloads, verifies and extracts one catalogue entry. */
  install(id: string): Promise<VoiceTtsModelState> {
    try { this.beforeWrite() } catch (error) { return Promise.reject(error) }
    const existing = this.flights.get(id); if (existing) return existing
    const work = this.options.host ? this.installPortable(id) : this.installLegacy(id)
    this.flights.set(id, work); void work.then(() => this.flights.delete(id), () => this.flights.delete(id)); return work
  }
  private async installLegacy(id: string): Promise<VoiceTtsModelState> {
    const entry = this.entry(id)
    if (!entry) throw new Error(`Unknown voice model: ${id}`)
    if (!isTtsManifestVerified(entry)) {
      throw new Error(`The checksum for "${entry.label}" is not recorded yet.`)
    }
    if (freemem() < entry.minMemoryBytes && totalmem() < entry.minMemoryBytes) {
      throw new Error(`"${entry.label}" needs about ${Math.round(entry.minMemoryBytes / 1e9)} GB of memory.`)
    }

    await mkdir(this.options.rootDir, { recursive: true })
    const controller = new AbortController()
    this.aborts.set(entry.id, controller)
    this.errors.delete(entry.id)
    this.setProgress(entry, 0)

    const archivePath = join(this.options.rootDir, `${entry.id}.tar.bz2`)
    const stagingDir = join(this.options.rootDir, `${entry.id}.incomplete`)
    const finalDir = this.modelDir(entry.id)

    try {
      await this.download(entry, archivePath, controller.signal)
      this.available(); if (controller.signal.aborted) throw new Error('The download was cancelled.')
      await rm(stagingDir, { recursive: true, force: true })
      await extractTarBz2(archivePath, stagingDir, controller.signal, (done, total) => {
        this.setProgress(entry, DOWNLOAD_SHARE + (1 - DOWNLOAD_SHARE) * Math.min(1, done / Math.max(1, total)))
      })
      this.beforeWrite(); if (controller.signal.aborted) throw new Error('The download was cancelled.')
      // The old directory only goes when the new one is complete, so a failed
      // update never leaves the user without a voice.
      await rm(finalDir, { recursive: true, force: true })
      await rename(stagingDir, finalDir)
      await rm(archivePath, { force: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
      this.errors.set(entry.id, message)
      this.installing.delete(entry.id)
      this.aborts.delete(entry.id)
      this.emit(entry)
      throw err
    }

    this.installing.delete(entry.id)
    this.aborts.delete(entry.id)
    // The closing report says the voice is installed. Reporting `false` here
    // would make a finished download look like one that had gone back to the
    // beginning.
    this.emit(entry, true)
    return this.describe(entry, entry.id, true)
  }

  cancel(id: string): void {
    this.aborts.get(id)?.abort()
  }

  private async removeImpl(id: string): Promise<void> {
    this.beforeWrite(); if (!this.entry(id)) throw new Error('Unknown voice model')
    this.cancel(id)
    await this.flights.get(id)?.catch(() => {})
    this.available()
    if (this.options.host) {
      await this.root(); const path = this.modelDir(id), info = await lstat(path).catch(() => null)
      if (info?.isSymbolicLink() || info && !info.isDirectory()) throw new Error('VOICE_TTS_MODEL_PATH_UNSAFE')
      if (!info) return
      this.assertResolvedModel((await this.resolve(id)) ?? (() => { throw new Error('VOICE_TTS_MODEL_NAMESPACE_AMBIGUOUS') })())
      const publication = this.publications.get(id)
      if (!publication || publication.archive !== this.entry(id)!.archive.sha256 || publication.tree !== await this.inventory(path, this.entry(id)!)) throw new Error('VOICE_TTS_MODEL_REMOVAL_UNOWNED')
      const privateDir = await mkdtemp(join(this.options.rootDir, `.${id}.remove-`)), retired = join(privateDir, 'owned')
      this.beforeWrite(); await this.root(); this.beforeWrite(); await rename(path, retired)
      const captured = await lstat(retired)
      if (captured.ino !== info.ino || captured.dev !== info.dev || captured.isSymbolicLink()) throw new Error('VOICE_TTS_MODEL_PATH_UNSAFE')
      // A concurrent change detected after retirement is preserved, not erased.
      if (publication.tree !== await this.inventory(retired, this.entry(id)!)) throw new Error('VOICE_TTS_MODEL_REMOVAL_UNOWNED')
      const privateReceipt = await lstat(privateDir)
      const rows = JSON.parse(publication.tree) as Array<[string, 'file' | 'directory', number, number, number, number?, number?, string?]>
      for (const [relative, kind, dev, ino, mode, size, mtime, hash] of rows.reverse()) {
        this.beforeWrite()
        const currentPrivate = await lstat(privateDir), currentRoot = await lstat(retired)
        if (currentPrivate.isSymbolicLink() || currentPrivate.dev !== privateReceipt.dev || currentPrivate.ino !== privateReceipt.ino ||
          currentRoot.isSymbolicLink() || currentRoot.dev !== captured.dev || currentRoot.ino !== captured.ino) throw new Error('VOICE_TTS_MODEL_PATH_UNSAFE')
        const path = relative ? join(retired, relative) : retired, current = await lstat(path)
        if (await realpath(path) !== path || current.isSymbolicLink() || current.dev !== dev || current.ino !== ino || current.mode !== mode) throw new Error('VOICE_TTS_MODEL_REMOVAL_UNOWNED')
        if (kind === 'file') {
          if (!current.isFile() || current.size !== size || current.mtimeMs !== mtime ||
            await sha256OfFile(path, { maxBytes: size, beforeRead: () => this.beforeWrite() }) !== hash) throw new Error('VOICE_TTS_MODEL_REMOVAL_UNOWNED')
          this.beforeWrite(); await unlink(path)
        } else { this.beforeWrite(); await rmdir(path) }
      }
      // Empty-directory removal preserves anything added after inventory capture.
      this.beforeWrite(); await rmdir(privateDir); this.publications.delete(id); this.errors.delete(id); return
    }
    await rm(this.modelDir(id), { recursive: true, force: true })
    await rm(join(this.options.rootDir, `${id}.tar.bz2`), { force: true })
    await rm(join(this.options.rootDir, `${id}.tar.bz2.part`), { force: true })
    this.errors.delete(id)
  }

  private async removeAllImpl(): Promise<void> {
    this.available()
    if (this.options.host) { for (const entry of this.manifest!) await this.remove(entry.id); return }
    for (const entry of VOICE_TTS_MODEL_MANIFEST) this.cancel(entry.id)
    await rm(this.options.rootDir, { recursive: true, force: true })
    this.errors.clear()
  }
  private async installPortable(id: string): Promise<VoiceTtsModelState> {
    const entry = this.entry(id), host = this.options.host!
    this.beforeWrite()
    if (!entry || !isTtsManifestVerified(entry)) throw new Error('VOICE_TTS_MODEL_UNAVAILABLE')
    if (host.downloads !== 'enabled') throw new Error('VOICE_TTS_DOWNLOAD_UNAVAILABLE')
    host.beforeRequest(entry.archive.url)
    await this.root(true)
    if (await this.isInstalled(entry)) return this.describe(entry, id, true)
    const final = this.modelDir(id)
    if (await lstat(final).catch(() => null)) throw new Error('VOICE_TTS_MODEL_NAMESPACE_AMBIGUOUS')
    const lock = await open(join(this.options.rootDir, `.${id}.install-lock`), 'wx', 0o600)
    let directory: string, receipt: Awaited<ReturnType<typeof lstat>>
    try { directory = await mkdtemp(join(this.options.rootDir, `.${id}.stage-`)); receipt = await lstat(directory) }
    catch (error) { const receipt = await lock.stat(); await lock.close(); const path = join(this.options.rootDir, `.${id}.install-lock`), current = await lstat(path).catch(() => null); if (current?.ino === receipt.ino && current.dev === receipt.dev && !current.isSymbolicLink()) await rm(path); throw error }
    const controller = new AbortController()
    this.aborts.set(id, controller); this.errors.delete(id); this.setProgress(entry, 0)
    const check = async (): Promise<void> => { this.beforeWrite(); if (controller.signal.aborted) throw new Error('The download was cancelled.'); await this.root(); const current = await lstat(directory); if (current.isSymbolicLink() || current.ino !== receipt.ino || current.dev !== receipt.dev || await realpath(directory) !== directory) throw new Error('VOICE_TTS_MODEL_PATH_UNSAFE') }
    try {
      await this.download(entry, join(directory, 'model.tar.bz2'), controller.signal); await check()
      const payload = join(directory, 'payload')
      await extractTarBz2(join(directory, 'model.tar.bz2'), payload, controller.signal, undefined, { maxBytes: entry.archive.unpackedBytes * 2 + 8 * 1024 * 1024, rootName: entry.archive.rootDir, beforeWrite: () => { this.beforeWrite(); if (controller.signal.aborted) throw new Error('The install was cancelled.') } })
      await check()
      for (const file of [entry.files.model, entry.files.voices, entry.files.tokens]) { const info = await lstat(join(payload, file)); if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error('VOICE_TTS_MODEL_INCOMPLETE') }
      if (!(await lstat(join(payload, entry.files.dataDir))).isDirectory()) throw new Error('VOICE_TTS_MODEL_INCOMPLETE')
      if (await lstat(final).catch(() => null)) throw new Error('VOICE_TTS_MODEL_NAMESPACE_AMBIGUOUS')
      const tree = await this.inventory(payload, entry)
      await check(); this.beforeWrite(); await rename(payload, final)
      this.publications.set(id, { archive: entry.archive.sha256, tree })
      this.available(); this.emit(entry, true)
      return this.describe(entry, id, true)
    } catch (error) { this.errors.set(id, controller.signal.aborted ? 'The download was cancelled.' : 'The voice model could not be installed.'); throw error }
    finally {
      this.aborts.delete(id); this.installing.delete(id)
      const current = await lstat(directory).catch(() => null)
      if (current && !current.isSymbolicLink() && current.ino === receipt.ino && current.dev === receipt.dev) await rm(directory, { recursive: true, force: true })
      const ownedLock = await lock.stat(); await lock.close()
      const path = join(this.options.rootDir, `.${id}.install-lock`), currentLock = await lstat(path).catch(() => null)
      if (currentLock && !currentLock.isSymbolicLink() && currentLock.ino === ownedLock.ino && currentLock.dev === ownedLock.dev) await rm(path)
    }
  }

  private async inventory(root: string, entry: VoiceTtsModelManifestEntry): Promise<string> {
    let count = 0, bytes = 0
    const rows: unknown[] = []
    const walk = async (relative: string, depth: number): Promise<void> => {
      this.beforeWrite()
      const path = relative ? join(root, relative) : root, info = await lstat(path)
      if (info.isSymbolicLink() || ++count > 4096 || depth > 16) throw new Error('VOICE_TTS_MODEL_PATH_UNSAFE')
      if (info.isDirectory()) {
        rows.push([relative, 'directory', info.dev, info.ino, info.mode])
        for (const name of (await readdir(path)).sort()) await walk(relative ? join(relative, name) : name, depth + 1)
      } else if (info.isFile()) {
        bytes += info.size
        if (bytes > entry.archive.unpackedBytes * 2 + 8 * 1024 * 1024) throw new Error('VOICE_TTS_MODEL_SIZE_LIMIT')
        const hash = await sha256OfFile(path, { maxBytes: info.size, beforeRead: () => this.beforeWrite() })
        const after = await lstat(path)
        if (after.isSymbolicLink() || after.ino !== info.ino || after.dev !== info.dev || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('VOICE_TTS_MODEL_PATH_UNSAFE')
        rows.push([relative, 'file', info.dev, info.ino, info.mode, info.size, info.mtimeMs, hash])
      } else throw new Error('VOICE_TTS_MODEL_PATH_UNSAFE')
    }
    await walk('', 0); this.beforeWrite()
    return JSON.stringify(rows)
  }

  // ── Internals ─────────────────────────────────────────────

  /**
   * Fetches the archive, resuming a part file, and checks the SHA-256.
   *
   * A connection that drops part of the way through is normal on a download
   * this size, and it is what a single-shot fetch reports to the user as
   * "TypeError: terminated". Measured in the Electron main process, the same
   * 26 MB archive dropped at 19.5 MB and at 8.8 MB on consecutive attempts,
   * through both network stacks, while the same request from plain Node
   * completed.
   *
   * So a drop is treated as ordinary. The bytes already on disk are kept, the
   * next attempt asks for the rest with a `Range` header, and only a download
   * that fails repeatedly reaches the user — as a sentence rather than as a
   * `TypeError`.
   */
  private async download(
    entry: VoiceTtsModelManifestEntry,
    target: string,
    signal: AbortSignal
  ): Promise<void> {
    const existing = await stat(target).catch(() => null)
    const proof = this.options.host ? { maxBytes: entry.archive.sizeBytes, signal, beforeRead: () => this.beforeWrite() } : undefined
    if (existing?.isFile() && (await sha256OfFile(target, proof)) === entry.archive.sha256) {
      this.setProgress(entry, DOWNLOAD_SHARE)
      return
    }

    const partial = `${target}.part`
    let lastFailure = ''

    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      if (signal.aborted) throw new Error('The download was cancelled.')
      try {
        const resumed = await this.downloadOnce(entry, partial, signal)

        if ((await sha256OfFile(partial, proof)) === entry.archive.sha256) {
          this.beforeWrite(); if (signal.aborted) throw new Error('The download was cancelled.')
          await rename(partial, target)
          this.setProgress(entry, DOWNLOAD_SHARE)
          return
        }
        // The assembled bytes are wrong, so they go.
        await rm(partial, { force: true })
        // A download taken in one piece that still does not match is not a
        // network problem: those are the bytes the server serves. Retrying
        // would download 100 MB again to reach the same answer.
        if (!resumed) {
          throw new Error(`The download of "${entry.label}" did not match its checksum.`)
        }
        // A resumed one may have been stitched together wrongly, so the next
        // attempt starts from zero.
        lastFailure = 'the downloaded bytes did not match the recorded checksum'
      } catch (err) {
        if (err instanceof Error && err.message.includes('did not match its checksum')) throw err
        if (signal.aborted) throw new Error('The download was cancelled.')
        lastFailure = describeDownloadFailure(err)
      }

      if (attempt < this.attempts) {
        // Back off a little, so a server that is refusing is not hammered. A
        // cancel ends the wait early; the next attempt then reports it.
        await sleep(Math.min(8 * this.baseDelayMs, this.baseDelayMs * 2 ** (attempt - 1)), undefined, { signal }).catch(() => {})
      }
    }

    throw new Error(
      `“${entry.label}” could not be downloaded after ${this.attempts} attempts: ${lastFailure}. ` +
        'Check the network connection and try again; what has already been downloaded is kept.'
    )
  }

  /**
   * One attempt. Appends to the part file when the server allows it.
   *
   * Returns true when it carried on from bytes that were already on disk.
   */
  private async downloadOnce(
    entry: VoiceTtsModelManifestEntry,
    partial: string,
    signal: AbortSignal
  ): Promise<boolean> {
    const already = (await stat(partial).catch(() => null))?.size ?? 0
    // Nothing left to ask for: the previous attempt finished the bytes and
    // only the checksum is outstanding.
    if (already >= entry.archive.sizeBytes) return already > 0

    const headers: Record<string, string> = already > 0 ? { Range: `bytes=${already}-` } : {}
    let address = entry.archive.url, response: Response
    if (this.options.host) {
      for (let redirects = 0;; redirects++) {
        this.available(); if (signal.aborted) throw new Error('The download was cancelled.')
        const url = new URL(address)
        if (url.protocol !== 'https:' || url.username || url.password || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) throw new Error('VOICE_TTS_DOWNLOAD_ADDRESS_UNAVAILABLE')
        this.options.host.beforeRequest(address)
        response = await this.fetchImpl(address, { headers, signal, redirect: 'manual' })
        if (![301, 302, 303, 307, 308].includes(response.status)) break
        const location = response.headers.get('location'); await response.body?.cancel()
        if (!location || redirects >= 4) throw new Error('VOICE_TTS_DOWNLOAD_REDIRECT_LIMIT')
        address = new URL(location, address).href
      }
    } else response = await this.fetchImpl(address, { headers, signal })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error(`the server answered ${response.status}`)
    }
    // The server ignored the range request, so start again from zero.
    const append = already > 0 && response.status === 206
    if (!append && already > 0) await rm(partial, { force: true })

    let received = append ? already : 0
    if (this.options.host) {
      const reader = response.body.getReader(); let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        this.beforeWrite(); if (signal.aborted) throw new Error('The download was cancelled.')
        handle = await open(partial, constants.O_WRONLY | constants.O_CREAT | (append ? constants.O_APPEND : constants.O_TRUNC) | (constants.O_NOFOLLOW ?? 0), 0o600)
        for (;;) {
          this.beforeWrite(); if (signal.aborted) throw new Error('The download was cancelled.')
          const result = await reader.read()
          this.beforeWrite(); if (signal.aborted) throw new Error('The download was cancelled.')
          if (result.done) break
          received += result.value.byteLength
          if (received > entry.archive.sizeBytes) throw new Error('VOICE_TTS_DOWNLOAD_SIZE_LIMIT')
          const bytes = Buffer.from(result.value); let written = 0
          while (written < bytes.length) { const write = await handle.write(bytes, written, bytes.length - written); if (!write.bytesWritten) throw new Error('VOICE_TTS_DOWNLOAD_WRITE_FAILED'); written += write.bytesWritten }
          this.setProgress(entry, DOWNLOAD_SHARE * Math.min(1, received / entry.archive.sizeBytes))
        }
        if (received !== entry.archive.sizeBytes) throw new Error('VOICE_TTS_DOWNLOAD_INCOMPLETE')
      } finally { await Promise.allSettled([reader.cancel(), handle?.close()]); reader.releaseLock() }
      return append
    }
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    source.on('data', (chunk: Buffer) => {
      received += chunk.length
      this.setProgress(entry, DOWNLOAD_SHARE * Math.min(1, received / entry.archive.sizeBytes))
    })
    await pipeline(source, createWriteStream(partial, { flags: append ? 'a' : 'w' }))
    return append
  }

  private setProgress(entry: VoiceTtsModelManifestEntry, progress: number): void {
    this.installing.set(entry.id, Math.min(1, Math.max(0, progress)))
    this.emit(entry)
  }

  private describe(
    entry: VoiceTtsModelManifestEntry,
    activeId: string | undefined,
    installed: boolean
  ): VoiceTtsModelState {
    return {
      id: entry.id,
      label: entry.label,
      description: entry.description,
      license: entry.license,
      licenseUrl: entry.licenseUrl,
      languages: entry.languages,
      installed,
      active: entry.id === activeId,
      installing: this.installing.has(entry.id),
      progress: this.installing.get(entry.id) ?? 0,
      sizeBytes: entry.archive.sizeBytes,
      unpackedBytes: entry.archive.unpackedBytes,
      downloadable: isTtsManifestVerified(entry),
      speakerCount: entry.speakers.length,
      ...(this.errors.has(entry.id) ? { error: this.errors.get(entry.id) } : {}),
    }
  }

  private emit(entry: VoiceTtsModelManifestEntry, installed = false): void {
    if (this.closing) return
    this.options.onProgress?.(this.describe(entry, undefined, installed))
  }
}

/**
 * Turns a network failure into words.
 *
 * `fetch` reports a dropped connection as `TypeError: terminated`, which tells
 * the user nothing at all. The real reason sits in `cause`.
 */
export function describeDownloadFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = (err as { cause?: unknown }).cause
  const causeText =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  if (err.message === 'terminated' || /terminated|socket|closed|reset|ECONNRESET/i.test(causeText)) {
    return `the connection closed early${causeText ? ` (${causeText})` : ''}`
  }
  return causeText ? `${err.message} (${causeText})` : err.message
}

// ── Archive extraction ──────────────────────────────────────

/**
 * Unpacks a `.tar.bz2` into `targetDir`, dropping the single top directory the
 * publisher wraps everything in.
 *
 * Every entry name is checked before anything is written. A name that climbs
 * out of `targetDir`, an absolute name, and every entry that is not a plain
 * file or a directory are refused, so a tampered archive cannot write outside
 * the model directory.
 */
export async function extractTarBz2(
  archivePath: string,
  targetDir: string,
  signal?: AbortSignal,
  onProgress?: (bytesWritten: number, totalBytes: number) => void,
  controls?: { maxBytes: number; rootName: string; beforeWrite(): void }
): Promise<void> {
  const totalBytes = (await stat(archivePath)).size
  controls?.beforeWrite()
  if (signal?.aborted) throw new Error('The install was cancelled.')
  await mkdir(targetDir, { recursive: true })

  const extract = tarExtract()
  let written = 0
  let entries = 0, decompressed = 0
  const flights = new Set<Promise<void>>()

  const done = new Promise<void>((finishExtract, reject) => {
    extract.on('error', reject)
    extract.on('finish', finishExtract)
    extract.on('entry', (header, stream, next) => {
      // Destroying a rejected archive also errors its active entry stream.
      // Its receipt must remain observed even before an entry pipeline exists.
      stream.on('error', () => {})
      const work = (async () => {
        try {
          controls?.beforeWrite()
          if (signal?.aborted) throw new Error('The install was cancelled.')
          const relative = stripRoot(header.name)
          if (controls && (++entries > 4096 || header.name.split(/[\\/]/).length > 18 || header.name.split('/')[0] !== controls.rootName || !['file', 'directory'].includes(header.type ?? '') || !Number.isSafeInteger(header.size) || (header.size ?? -1) < 0 || (header.size ?? 0) > controls.maxBytes || relative === null && header.name !== controls.rootName && header.name !== controls.rootName + '/')) throw new Error('VOICE_TTS_ARCHIVE_UNSAFE')
          if (relative === null || (header.type !== 'file' && header.type !== 'directory')) {
            stream.resume()
            return
          }
          const destination = join(targetDir, relative)
          if (controls) {
            const root = await realpath(targetDir); if (root !== resolve(targetDir)) throw new Error('VOICE_TTS_ARCHIVE_UNSAFE')
            let path = root
            for (const segment of relative.split(sep).slice(0, -1)) { path = join(path, segment); const info = await lstat(path).catch(() => null); if (info?.isSymbolicLink() || info && !info.isDirectory()) throw new Error('VOICE_TTS_ARCHIVE_UNSAFE') }
            const info = await lstat(destination).catch(() => null); if (info?.isSymbolicLink() || info && !info.isDirectory()) throw new Error('VOICE_TTS_ARCHIVE_DUPLICATE')
          }
          if (header.type === 'directory') {
            controls?.beforeWrite()
            await mkdir(destination, { recursive: true })
            stream.resume()
            return
          }
          controls?.beforeWrite()
          await mkdir(dirname(destination), { recursive: true })
          controls?.beforeWrite()
          if (controls) {
            const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
            let fileBytes = 0
            try {
              for await (const chunk of stream) {
                controls.beforeWrite()
                if (signal?.aborted) throw new Error('The install was cancelled.')
                const bytes = Buffer.from(chunk)
                fileBytes += bytes.length
                if (fileBytes > (header.size ?? 0) || written + fileBytes > controls.maxBytes) throw new Error('VOICE_TTS_ARCHIVE_SIZE_LIMIT')
                await handle.writeFile(bytes)
              }
              if (fileBytes !== header.size) throw new Error('VOICE_TTS_ARCHIVE_SIZE_LIMIT')
            }
            finally { await handle.close() }
          } else await pipeline(stream, createWriteStream(destination))
          written += header.size ?? 0
          if (controls && written > controls.maxBytes) throw new Error('VOICE_TTS_ARCHIVE_SIZE_LIMIT')
          onProgress?.(written, totalBytes)
        } catch (err) {
          extract.destroy(err instanceof Error ? err : new Error(String(err)))
        } finally {
          if (!extract.destroyed) next()
        }
      })()
      flights.add(work); void work.then(() => flights.delete(work), () => flights.delete(work))
    })
  })

  const bound = new Transform({ transform(chunk: Buffer, _encoding, callback) { decompressed += chunk.length; if (controls && decompressed > controls.maxBytes + 8 * 1024 * 1024) callback(new Error('VOICE_TTS_ARCHIVE_SIZE_LIMIT')); else callback(null, chunk) } })
  const results = await Promise.allSettled([pipeline(createReadStream(archivePath), bz2(), bound, extract), done])
  do { await Promise.allSettled([...flights]) } while (flights.size)
  const failure = results.find(result => result.status === 'rejected'); if (failure?.status === 'rejected') throw failure.reason
}

/**
 * Removes the first path segment and refuses anything that could escape the
 * target directory. Returns null when the entry must be skipped.
 */
export function stripRoot(name: string): string | null {
  const normalised = name.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalised || normalised.startsWith('/') || /^[A-Za-z]:/.test(normalised)) return null
  const parts = normalised.split('/').filter((part) => part.length > 0 && part !== '.')
  if (parts.some((part) => part === '..')) return null
  parts.shift()
  if (parts.length === 0) return null
  return parts.join(sep)
}

export async function sha256OfFile(path: string, controls?: { maxBytes: number; signal?: AbortSignal; beforeRead(): void }): Promise<string> {
  const check = (): void => { controls?.beforeRead(); if (controls?.signal?.aborted) throw new Error('The download was cancelled.') }
  check(); const expected = await lstat(path)
  if (controls && (expected.isSymbolicLink() || !expected.isFile() || expected.size > controls.maxBytes)) throw new Error('VOICE_TTS_DOWNLOAD_SIZE_LIMIT')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const initial = await handle.stat(); if (controls && (initial.ino !== expected.ino || initial.dev !== expected.dev)) throw new Error('VOICE_TTS_MODEL_PATH_UNSAFE')
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(1024 * 1024)
    let total = 0
    for (;;) {
      check()
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      check(); total += bytesRead
      if (controls && total > controls.maxBytes) throw new Error('VOICE_TTS_DOWNLOAD_SIZE_LIMIT')
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    const final = await handle.stat(); if (controls && (final.size !== initial.size || final.mtimeMs !== initial.mtimeMs)) throw new Error('VOICE_TTS_MODEL_PATH_UNSAFE')
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}
