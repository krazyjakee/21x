/**
 * Optional install of the local speech runtime.
 *
 * The runtime is a native package. It is not part of the application bundle,
 * because it must stay optional: a user who never turns voice on must not pay
 * for it in download size, and a missing runtime must never break a build or an
 * install of 20x itself.
 *
 * The package is installed into the application data directory, not into the
 * application bundle, which is read-only once the app is packaged. The worker
 * then loads it from that directory by absolute path.
 */

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, rm, readFile, writeFile, lstat, realpath, open } from 'fs/promises'
import { join, isAbsolute } from 'path'
import { constants } from 'fs'
import { AsyncLocalStorage } from 'async_hooks'
import type { VoiceRuntimeStatus } from '../../shared/voice'

/**
 * The Phase 0 packaging spike must replace this with an exact version once it
 * has proved the runtime on macOS arm64, macOS x64, Windows x64 and Linux x64.
 * The resolved version is always reported back, so a diagnostic report states
 * what is really installed.
 */
export const VOICE_RUNTIME_PACKAGE = 'sherpa-onnx-node'

/** Roughly how much disk the runtime and its platform binaries need. */
export const VOICE_RUNTIME_APPROX_BYTES = 180 * 1024 * 1024

/**
 * The platforms `sherpa-onnx-node` ships prebuilt binaries for. Anything else
 * would fail deep inside npm with a message nobody can act on, so it is
 * refused up front with a plain one.
 */
const SUPPORTED_TARGETS: ReadonlySet<string> = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
])

/**
 * Says why this computer cannot run the local speech runtime, or null when it
 * can. Checked before the install and before a model download, so the user
 * hears it once, early, rather than after 650 MB.
 */
export function unsupportedHardwareReason(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | null {
  const target = `${platform}-${arch}`
  if (SUPPORTED_TARGETS.has(target)) return null
  const names: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }
  const os = names[platform] ?? platform
  return (
    `The local speech runtime has no build for ${os} on ${arch}. ` +
    'Voice control needs macOS (Apple silicon or Intel), Windows x64, or Linux x64/arm64.'
  )
}

export interface RuntimeProgress {
  stage: 'starting' | 'installing' | 'complete' | 'error'
  output: string
  percent: number
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

/** Where the runtime lives: `<userData>/voice-runtime`. */
export function runtimeModulePath(rootDir: string): string {
  return join(rootDir, 'node_modules', VOICE_RUNTIME_PACKAGE)
}

/** Reads what is installed. It never throws: voice must stay optional. */
export async function detectVoiceRuntime(rootDir: string): Promise<VoiceRuntimeStatus> {
  const modulePath = runtimeModulePath(rootDir)
  const manifest = join(modulePath, 'package.json')
  if (!existsSync(manifest)) {
    return { installed: false, version: null, modulePath: null, sizeBytes: VOICE_RUNTIME_APPROX_BYTES }
  }
  try {
    const parsed = JSON.parse(await readFile(manifest, 'utf8')) as { version?: string }
    return {
      installed: true,
      version: parsed.version ?? null,
      modulePath,
      sizeBytes: VOICE_RUNTIME_APPROX_BYTES,
    }
  } catch {
    return { installed: false, version: null, modulePath: null, sizeBytes: VOICE_RUNTIME_APPROX_BYTES }
  }
}

/** True when npm can be called. The install needs it. */
export async function isNpmAvailable(signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(false); return }
    const child = spawn(npmCommand(), ['--version'], {
      shell: process.platform === 'win32',
      windowsHide: true,
    })
    let failed = false
    let escalation: ReturnType<typeof setTimeout> | undefined
    const cancel = (): void => {
      failed = true
      child.kill()
      escalation ??= setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 200)
    }
    const timer = setTimeout(cancel, 5000)
    signal?.addEventListener('abort', cancel, { once: true })
    child.stdout?.resume?.()
    child.stderr?.resume?.()
    child.on('error', () => { failed = true })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (escalation) clearTimeout(escalation)
      signal?.removeEventListener('abort', cancel)
      resolve(!failed && code === 0)
    })
  })
}

/**
 * Installs the runtime into `rootDir`. Progress lines come straight from npm,
 * so the user can see what is happening and can read a real error.
 */
export async function installVoiceRuntime(
  rootDir: string,
  onProgress: (progress: RuntimeProgress) => void,
  signal?: AbortSignal
): Promise<VoiceRuntimeStatus> {
  onProgress({ stage: 'starting', output: 'Preparing the download…\n', percent: 0 })

  const unsupported = unsupportedHardwareReason()
  if (unsupported) {
    onProgress({ stage: 'error', output: `${unsupported}\n`, percent: 100 })
    throw new Error(unsupported)
  }

  if (!(await isNpmAvailable(signal))) {
    const message =
      'npm was not found. Install Node.js first — 21x can install it from Settings → General.\n'
    onProgress({ stage: 'error', output: message, percent: 100 })
    throw new Error(message.trim())
  }

  if (signal?.aborted) throw new Error('VOICE_RUNTIME_CANCELLED')
  await mkdir(rootDir, { recursive: true })
  if (signal?.aborted) throw new Error('VOICE_RUNTIME_CANCELLED')
  // A private manifest keeps npm from walking up into the app directory.
  await writeFile(
    join(rootDir, 'package.json'),
    `${JSON.stringify({ name: '20x-voice-runtime', version: '1.0.0', private: true }, null, 2)}\n`,
    'utf8'
  )

  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('VOICE_RUNTIME_CANCELLED')); return }
    const child = spawn(
      npmCommand(),
      ['install', VOICE_RUNTIME_PACKAGE, '--omit=dev', '--no-audit', '--no-fund', '--loglevel=info'],
      { cwd: rootDir, shell: process.platform === 'win32', windowsHide: true }
    )

    // npm gives no percentage, so the bar moves towards 90 and finishes on exit.
    let percent = 5
    const bump = (chunk: Buffer): void => {
      percent = Math.min(90, percent + 3)
      onProgress({ stage: 'installing', output: chunk.toString(), percent })
    }
    child.stdout?.on('data', bump)
    child.stderr?.on('data', bump)

    let failed = false
    let escalation: ReturnType<typeof setTimeout> | undefined
    const cancel = (): void => {
      child.kill()
      escalation ??= setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 200)
    }
    signal?.addEventListener('abort', cancel, { once: true })
    const deadline = setTimeout(cancel, 10 * 60 * 1000)
    child.on('error', () => { failed = true })
    child.stdout?.on('error', () => { failed = true; cancel() })
    child.stderr?.on('error', () => { failed = true; cancel() })
    child.on('close', (code) => {
      clearTimeout(deadline)
      if (escalation) clearTimeout(escalation)
      signal?.removeEventListener('abort', cancel)
      if (!failed && code === 0 && !signal?.aborted) resolve()
      else reject(new Error('VOICE_RUNTIME_INSTALL_FAILED'))
    })
  })

  const status = await detectVoiceRuntime(rootDir)
  if (!status.installed) {
    const message = 'The install finished but the runtime was not found.\n'
    onProgress({ stage: 'error', output: message, percent: 100 })
    throw new Error(message.trim())
  }
  onProgress({
    stage: 'complete',
    output: `Installed ${VOICE_RUNTIME_PACKAGE} ${status.version ?? ''}\n`,
    percent: 100,
  })
  return status
}

/** Deletes the runtime and gives the disk space back. */
export async function removeVoiceRuntime(rootDir: string): Promise<void> {
  await rm(rootDir, { recursive: true, force: true })
}

export interface VoiceRuntimeOwnerOptions {
  rootDir: string
  /** The unpinned legacy npm installer is admitted only by the Electron host. */
  installation: 'unavailable' | 'electron-compatibility'
  assertCurrent?: () => void
}

/** Owns the optional runtime; portable installation is intentionally unavailable. */
export class VoiceRuntimeOwner {
  private closing = false
  private flights = new Set<Promise<unknown>>()
  private guards = new AsyncLocalStorage<() => void>()
  private abort = new AbortController()
  constructor(private readonly options: VoiceRuntimeOwnerOptions) {
    if (!isAbsolute(options.rootDir)) throw new Error('VOICE_RUNTIME_ROOT_REQUIRED')
  }
  assertRoot(root: string): void {
    if (root !== this.options.rootDir) throw new Error('VOICE_RUNTIME_OWNER_MISMATCH')
  }
  get inflightCount(): number { return this.flights.size }
  private current(): void {
    if (this.closing) throw new Error('VOICE_RUNTIME_CLOSED')
    this.options.assertCurrent?.()
    this.guards.getStore()?.()
  }
  withMutationGuard<T>(effect: () => T | Promise<T>, guard: () => void): Promise<T> {
    return this.guards.run(guard, () => this.own(async () => effect()))
  }
  private own<T>(effect: () => Promise<T>): Promise<T> {
    let raw: Promise<T>
    try { this.current(); raw = effect() } catch (error) { return Promise.reject(error) }
    this.flights.add(raw)
    void raw.then(() => this.flights.delete(raw), () => this.flights.delete(raw))
    return raw
  }
  detect(): Promise<VoiceRuntimeStatus> {
    return this.own(async () => {
      if (this.options.installation === 'electron-compatibility') return detectVoiceRuntime(this.options.rootDir)
      const absent: VoiceRuntimeStatus = { installed: false, version: null, modulePath: null, sizeBytes: VOICE_RUNTIME_APPROX_BYTES }
      const modulePath = runtimeModulePath(this.options.rootDir)
      const dirs = [this.options.rootDir, join(this.options.rootDir, 'node_modules'), modulePath]
      const receipts: Array<{ path: string; dev: number; ino: number }> = []
      for (const path of dirs) {
        const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw new Error('VOICE_RUNTIME_PATH_UNAVAILABLE')
        })
        if (!info) return absent
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('VOICE_RUNTIME_PATH_UNSAFE')
        receipts.push({ path, dev: info.dev, ino: info.ino })
      }
      const path = join(modulePath, 'package.json')
      const receipt = await lstat(path).catch(() => null)
      if (!receipt) return absent
      if (!receipt.isFile() || receipt.isSymbolicLink() || receipt.size > 16384) throw new Error('VOICE_RUNTIME_MANIFEST_INVALID')
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      let text: string
      try {
        const opened = await handle.stat()
        if (opened.dev !== receipt.dev || opened.ino !== receipt.ino || opened.size !== receipt.size) throw new Error('VOICE_RUNTIME_PATH_CHANGED')
        const bytes = Buffer.alloc(16385)
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
        if (bytesRead > 16384) throw new Error('VOICE_RUNTIME_MANIFEST_INVALID')
        text = bytes.subarray(0, bytesRead).toString('utf8')
      } finally { await handle.close() }
      for (const item of [...receipts, { path, dev: receipt.dev, ino: receipt.ino }]) {
        const now = await lstat(item.path)
        if (now.isSymbolicLink() || now.dev !== item.dev || now.ino !== item.ino) throw new Error('VOICE_RUNTIME_PATH_CHANGED')
      }
      this.current()
      let parsed: { name?: unknown; version?: unknown }
      try { parsed = JSON.parse(text) } catch { throw new Error('VOICE_RUNTIME_MANIFEST_INVALID') }
      if (parsed.name !== VOICE_RUNTIME_PACKAGE || typeof parsed.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(parsed.version) || parsed.version.length > 128) throw new Error('VOICE_RUNTIME_MANIFEST_INVALID')
      return { installed: true, version: parsed.version, modulePath, sizeBytes: VOICE_RUNTIME_APPROX_BYTES }
    })
  }
  install(onProgress: (progress: RuntimeProgress) => void): Promise<VoiceRuntimeStatus> {
    this.current()
    if (this.options.installation === 'unavailable') return Promise.reject(new Error('VOICE_RUNTIME_INSTALL_UNAVAILABLE'))
    return this.own(() => installVoiceRuntime(this.options.rootDir, (progress) => { if (!this.closing) onProgress(progress) }, this.abort.signal))
  }
  remove(): Promise<void> {
    return this.own(async () => {
      if (this.options.installation === 'electron-compatibility') {
        this.current()
        await removeVoiceRuntime(this.options.rootDir)
        return
      }
      // A runtime tree contains npm-owned shared dependencies. Until the host
      // supplies an installation inventory we cannot safely claim those bytes.
      const status = await this.detect()
      this.current()
      if (status.installed) throw new Error('VOICE_RUNTIME_REMOVAL_INVENTORY_UNAVAILABLE')
    })
  }
  stop(): void { this.closing = true; this.abort.abort() }
  async close(timeoutMs = 3000): Promise<void> {
    this.stop()
    const deadline = Date.now() + Math.max(1, Math.min(timeoutMs, 30000))
    while (this.flights.size) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('VOICE_RUNTIME_DRAIN_INCOMPLETE')
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([Promise.allSettled([...this.flights]), new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining) })])
      if (timer) clearTimeout(timer)
    }
  }
}
