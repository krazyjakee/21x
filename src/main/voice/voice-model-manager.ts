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

import { createHash } from 'crypto'
import { createWriteStream } from 'fs'
import { mkdir, rm, stat, rename, readdir, open } from 'fs/promises'
import { join } from 'path'
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
  findManifestEntry,
  isManifestVerified,
  manifestKind,
  manifestSizeBytes,
} from './voice-model-manifest'

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
  onProgress?: (state: VoiceModelState) => void
}

export class VoiceModelManager {
  private installing = new Map<string, number>()
  private phases = new Map<string, VoiceModelPhase>()
  private errors = new Map<string, string>()
  private aborts = new Map<string, AbortController>()

  constructor(private options: VoiceModelManagerOptions) {}

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  modelDir(id: string): string {
    return join(this.options.rootDir, id)
  }

  /**
   * Every catalogue entry, then every directory on disk the catalogue does not
   * name (a model from an older release). Those are `legacy`, so the settings
   * page offers to delete them and never to download them.
   */
  async list(activeId?: string): Promise<VoiceModelState[]> {
    const states: VoiceModelState[] = []
    for (const entry of VOICE_MODEL_MANIFEST) {
      states.push({
        ...this.stateOf(entry),
        active: entry.id === activeId,
        installed: await this.isInstalled(entry),
      })
    }
    for (const id of await this.strayModelIds()) {
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
    const known = new Set(VOICE_MODEL_MANIFEST.map((entry) => entry.id))
    return names
      .filter((d) => d.isDirectory() && !known.has(d.name))
      .map((d) => d.name)
      .sort()
  }

  async isInstalled(entry: VoiceModelManifestEntry): Promise<boolean> {
    const dir = this.modelDir(entry.id)
    for (const file of entry.files) {
      const info = await stat(join(dir, file.name)).catch(() => null)
      if (!info || !info.isFile() || info.size === 0) return false
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
      const resolved = await this.resolveCustomDir(customDir)
      if (resolved) return resolved
    }
    const entry = findManifestEntry(modelId)
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
  async install(id: string): Promise<VoiceModelState> {
    const entry = findManifestEntry(id)
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
    await mkdir(dir, { recursive: true })
    const controller = new AbortController()
    this.aborts.set(entry.id, controller)
    this.errors.delete(entry.id)
    this.installing.set(entry.id, 0)
    this.phases.set(entry.id, 'downloading')
    this.emit(entry)

    let done = 0
    try {
      for (const file of entry.files) {
        const target = join(dir, file.name)
        const existing = await stat(target).catch(() => null)
        if (existing?.isFile() && (await sha256OfFile(target)) === file.sha256) {
          done += file.sizeBytes
          this.installing.set(entry.id, Math.min(1, done / needed))
          this.emit(entry)
          continue
        }
        this.phases.set(entry.id, 'downloading')
        await this.downloadFile(
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
          }
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
    }

    this.installing.delete(entry.id)
    this.phases.delete(entry.id)
    this.aborts.delete(entry.id)
    this.emit(entry)
    const states = await this.list()
    return states.find((s) => s.id === entry.id) as VoiceModelState
  }

  cancel(id: string): void {
    this.aborts.get(id)?.abort()
    this.aborts.delete(id)
    this.installing.delete(id)
    this.phases.delete(id)
  }

  /** Removes the files and the directory of one model. */
  async remove(id: string): Promise<void> {
    this.cancel(id)
    await rm(this.modelDir(id), { recursive: true, force: true })
    this.errors.delete(id)
  }

  /** Removes every downloaded model (the "Delete models" control). */
  async removeAll(): Promise<void> {
    for (const entry of VOICE_MODEL_MANIFEST) this.cancel(entry.id)
    await rm(this.options.rootDir, { recursive: true, force: true })
    this.errors.clear()
  }

  private async downloadFile(
    url: string,
    target: string,
    expectedSha256: string,
    signal: AbortSignal,
    onBytes: (bytes: number) => void,
    onVerify: () => void = () => {}
  ): Promise<void> {
    const partial = `${target}.part`
    const already = (await stat(partial).catch(() => null))?.size ?? 0
    const headers: Record<string, string> = already > 0 ? { Range: `bytes=${already}-` } : {}

    const response = await this.fetchImpl(url, { headers, signal })
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
    await pipeline(source, createWriteStream(partial, { flags: append ? 'a' : 'w' }))

    onVerify()
    const digest = await sha256OfFile(partial)
    if (digest !== expectedSha256) {
      await rm(partial, { force: true })
      throw new Error(`Checksum mismatch for ${url}`)
    }
    await rename(partial, target)
  }

  private emit(entry: VoiceModelManifestEntry): void {
    this.options.onProgress?.(this.stateOf(entry))
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
 * Turns a raw failure into one line the user can act on. The original message
 * is kept, so a diagnostic report still says what really happened.
 */
export function describeInstallFailure(err: unknown, entry: VoiceModelManifestEntry): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/abort/i.test(raw)) return `The download of "${entry.label}" was cancelled.`
  if (/checksum mismatch/i.test(raw)) {
    return `${raw}. The file on the server does not match the recorded checksum, so it was discarded. Try again later; if it keeps happening, report it.`
  }
  if (/ENOSPC/i.test(raw)) {
    return `Not enough disk space for "${entry.label}" (${gigabytes(manifestSizeBytes(entry))} GB). Free some space and try again.`
  }
  if (/Download failed \((\d+)\)/.test(raw)) {
    return `${raw}. Check the connection and try again; the download resumes where it stopped.`
  }
  if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(raw)) {
    return `The download of "${entry.label}" could not reach the server (${raw}). Check the connection and try again; it resumes where it stopped.`
  }
  return raw
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
  const handle = await open(path, 'r')
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(1024 * 1024)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}
