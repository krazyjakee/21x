import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { open, lstat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, delimiter, normalize, relative, sep } from 'node:path'
import { detectInstalledAgents } from './detect.js'
import { rtkIntegrationFiles } from './rtk-integrations.js'

export const AGENT_DETECTION_LIMITS = { children: 4, snapshots: 2, queued: 32, outputBytes: 65_536, fileBytes: 262_144, probeMs: 10_000, snapshotMs: 30_000 } as const
export const AGENT_DETECTION_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'] as const
export interface PortableAgentDetectionOwnerOptions {
  environment: Readonly<NodeJS.ProcessEnv>
  home: string
  cwd: string
  /** Trusted preferred CLI roots, never request paths. */
  preferredPaths?: readonly string[]
  platform?: NodeJS.Platform
  maxConcurrency?: number
  probeTimeoutMs?: number
}
export class AgentDetectionError extends Error {
  constructor(readonly code: 'AGENT_DETECTION_CLOSED' | 'AGENT_DETECTION_CANCELLED' | 'AGENT_DETECTION_TIMEOUT' | 'AGENT_DETECTION_BACKPRESSURE' | 'AGENT_DETECTION_INVALID_OPTIONS') { super(code); this.name = 'AgentDetectionError' }
}
class ProbeError extends Error {
  constructor(readonly kind: 'missing' | 'failed' | 'timeout' | 'overflow') { super('CLI_PROBE_FAILED') }
}
type Child = { process: ChildProcess; stop(): void }
type Job = { run(): Promise<void>; reject(error: unknown): void }

/** Owns real local version probes and integration reads, never installer
 * effects. Host-captured paths/environment are not request arguments. */
export class PortableAgentDetectionOwner {
  private readonly environment: Readonly<NodeJS.ProcessEnv>
  private readonly home: string
  private readonly cwd: string
  private readonly concurrency: number
  private readonly timeoutMs: number
  private readonly preferredPaths: readonly string[]
  private closing = false
  private active = 0
  private readonly queue: Job[] = []
  private readonly children = new Set<Child>()
  private readonly work = new Set<Promise<unknown>>()
  private readonly jobs = new Set<Promise<void>>()
  private readonly controllers = new Set<AbortController>()
  constructor(options: PortableAgentDetectionOwnerOptions) {
    const validPath = (path: unknown): path is string => typeof path === 'string' && path.length <= 4096 && isAbsolute(path) && !/[\u0000-\u001f]/.test(path)
    if (!options || !validPath(options.home) || !validPath(options.cwd) || options.platform !== undefined && options.platform !== process.platform ||
      options.maxConcurrency !== undefined && (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1 || options.maxConcurrency > AGENT_DETECTION_LIMITS.children) ||
      options.probeTimeoutMs !== undefined && (!Number.isInteger(options.probeTimeoutMs) || options.probeTimeoutMs < 10 || options.probeTimeoutMs > AGENT_DETECTION_LIMITS.probeMs) ||
      options.preferredPaths !== undefined && (!Array.isArray(options.preferredPaths) || options.preferredPaths.length > 8 || !options.preferredPaths.every(validPath))) throw new AgentDetectionError('AGENT_DETECTION_INVALID_OPTIONS')
    const environment: NodeJS.ProcessEnv = {}
    if (!options.environment || typeof options.environment !== 'object' || Array.isArray(options.environment)) throw new AgentDetectionError('AGENT_DETECTION_INVALID_OPTIONS')
    for (const [key, value] of Object.entries(options.environment)) {
      if (!AGENT_DETECTION_ENV_KEYS.includes(key as typeof AGENT_DETECTION_ENV_KEYS[number]) || value !== undefined && (typeof value !== 'string' || value.length > 32768 || /[\u0000-\u001f]/.test(value))) throw new AgentDetectionError('AGENT_DETECTION_INVALID_OPTIONS')
      if (value !== undefined) environment[key] = value
    }
    this.home = normalize(options.home); this.cwd = normalize(options.cwd)
    const paths = (environment.PATH ?? '').split(delimiter).filter(path => path && validPath(path)).map(normalize)
    // Same well-known directories as Electron detection, in this private copy.
    this.preferredPaths = Object.freeze((options.preferredPaths ?? []).map(normalize))
    environment.PATH = [...new Set([...this.preferredPaths, join(this.home, '.local', 'bin'), join(this.home, '.opencode', 'bin'), ...paths])].join(delimiter)
    environment.HOME = this.home
    if (process.platform === 'win32') environment.USERPROFILE = this.home
    this.environment = Object.freeze(environment)
    this.concurrency = options.maxConcurrency ?? AGENT_DETECTION_LIMITS.children
    this.timeoutMs = options.probeTimeoutMs ?? AGENT_DETECTION_LIMITS.probeMs
  }
  get childCount(): number { return this.children.size }
  get inflightCount(): number { return this.work.size + this.jobs.size }
  assertOpen(): void { if (this.closing) throw new AgentDetectionError('AGENT_DETECTION_CLOSED') }
  assertOwners(owners: { home: string; cwd: string }): void {
    this.assertOpen()
    if (normalize(owners.home) !== this.home || normalize(owners.cwd) !== this.cwd) throw new AgentDetectionError('AGENT_DETECTION_INVALID_OPTIONS')
  }
  detect(signal?: AbortSignal, controls?: { beforeEffect(): void }): ReturnType<typeof detectInstalledAgents> {
    this.assertOpen()
    if (controls !== undefined && typeof controls.beforeEffect !== 'function') throw new AgentDetectionError('AGENT_DETECTION_INVALID_OPTIONS')
    controls?.beforeEffect()
    if (signal?.aborted) return Promise.reject(new AgentDetectionError('AGENT_DETECTION_CANCELLED'))
    if (this.work.size >= AGENT_DETECTION_LIMITS.snapshots) return Promise.reject(new AgentDetectionError('AGENT_DETECTION_BACKPRESSURE'))
    const controller = new AbortController(); this.controllers.add(controller)
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, AGENT_DETECTION_LIMITS.snapshotMs)
    const beforeEffect = (): void => {
      this.assertOpen()
      if (timedOut) throw new AgentDetectionError('AGENT_DETECTION_TIMEOUT')
      if (controller.signal.aborted) throw new AgentDetectionError('AGENT_DETECTION_CANCELLED')
      controls?.beforeEffect()
    }
    const failures = new Map<string, ProbeError['kind']>()
    const raw = (async () => {
      const result = await detectInstalledAgents({ portable: true, home: this.home, platform: process.platform,
        exec: async (command, args = [], options = {}) => {
          try { return await this.schedule(() => this.probe(command, args, controller.signal, Number((options as { timeout?: number }).timeout) || this.timeoutMs, beforeEffect)) }
          catch (error) { if (error instanceof ProbeError) failures.set(basename(command).replace(/\.(cmd|exe|bat)$/i, ''), error.kind); throw error }
        },
        integrations: async () => {
          const entries = await Promise.all(rtkIntegrationFiles(this.environment, this.home).map(file => this.schedule(async () => {
            beforeEffect()
            const value = await this.integration(file.path, file.text, beforeEffect)
            beforeEffect(); return [file.key, value] as const
          })))
          return Object.fromEntries(entries)
        }
      })
      beforeEffect()
      if (this.closing) throw new AgentDetectionError('AGENT_DETECTION_CLOSED')
      if (signal?.aborted) throw new AgentDetectionError('AGENT_DETECTION_CANCELLED')
      if (timedOut) throw new AgentDetectionError('AGENT_DETECTION_TIMEOUT')
      for (const [key, command] of Object.entries({ nodejs: 'node', npm: 'npm', pnpm: 'pnpm', git: 'git', gh: 'gh', glab: 'glab', tea: 'tea', rtk: 'rtk', claudeCode: 'claude', opencode: 'opencode', codex: 'codex', cursor: 'cursor-agent' })) {
        const failure = failures.get(command)
        if (!result[key].installed && failure && failure !== 'missing') result[key] = { ...result[key], reason: failure === 'timeout' ? 'CLI detection timed out.' : 'CLI detection failed.' }
      }
      return result
    })()
    this.work.add(raw)
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.controllers.delete(controller); this.work.delete(raw) }
    void raw.then(done, done)
    return raw
  }
  private schedule<T>(run: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new AgentDetectionError('AGENT_DETECTION_CLOSED'))
    if (this.queue.length >= AGENT_DETECTION_LIMITS.queued) return Promise.reject(new AgentDetectionError('AGENT_DETECTION_BACKPRESSURE'))
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run: async () => { try { resolve(await run()) } catch (error) { reject(error) } }, reject }); this.pump()
    })
  }
  private pump(): void {
    while (!this.closing && this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!; this.active++
      const raw = job.run(); this.jobs.add(raw)
      void raw.finally(() => { this.jobs.delete(raw); this.active--; this.pump() })
    }
  }
  private async windowsCommand(command: string, beforeEffect: () => void): Promise<{ command: string; prefix: string[] }> {
    const names = /\.(exe|cmd|bat|com)$/i.test(command) ? [command] : ['.exe', '.cmd', '.bat', '.com'].map(ext => command + ext)
    const paths = isAbsolute(command) ? [''] : (this.environment.PATH ?? '').split(';')
    for (const path of paths) for (const name of names) {
      const candidate = path ? join(path, name) : name
      try {
        beforeEffect(); const entry = await lstat(candidate); beforeEffect()
        if (!entry.isFile()) continue
        if (/\.(cmd|bat)$/i.test(candidate)) {
          if (/[\u0000-\u001f"%!^&|<>]/.test(candidate)) throw new ProbeError('failed')
          const systemRoot = this.environment.SystemRoot ?? this.environment.WINDIR
          if (!systemRoot || !isAbsolute(systemRoot)) throw new ProbeError('failed')
          return { command: join(systemRoot, 'System32', 'cmd.exe'), prefix: ['/d', '/s', '/c', candidate] }
        }
        return { command: candidate, prefix: [] }
      } catch (error) { if (error instanceof ProbeError) throw error }
    }
    throw new ProbeError('missing')
  }
  private async probe(command: string, args: string[], signal: AbortSignal, requestedTimeout: number, beforeEffect: () => void): Promise<{ stdout: string; stderr: string }> {
    beforeEffect()
    if (signal.aborted || this.closing) throw new AgentDetectionError('AGENT_DETECTION_CANCELLED')
    const version = args.length === 1 && args[0] === '--version', prefix = args.length === 2 && args[0] === 'prefix' && args[1] === '-g'
    const known = ['node', 'npm', 'npm.cmd', 'pnpm', 'git', 'gh', 'glab', 'tea', 'rtk', 'claude', 'opencode', 'codex', 'cursor-agent', 'pi', 'pi.cmd', 'pi.exe']
    const absolutePi = isAbsolute(command) && ['pi', 'pi.cmd', 'pi.exe'].includes(basename(command)) && command.length <= 4096 &&
      (relative(this.home, command) && !relative(this.home, command).startsWith('..' + sep) && !isAbsolute(relative(this.home, command)) ||
        (this.environment.PATH ?? '').split(delimiter).includes(dirname(command)))
    if ((!version || !known.includes(command) && !absolutePi) && !(prefix && ['npm', 'npm.cmd'].includes(command))) throw new ProbeError('failed')
    let program = command, arguments_ = args
    if (process.platform === 'win32') {
      const resolved = await this.windowsCommand(command, beforeEffect); program = resolved.command
      arguments_ = resolved.prefix.length ? [...resolved.prefix.slice(0, 3), `""${resolved.prefix[3]}" ${args.join(' ')}"`] : args
    }
    beforeEffect()
    if (signal.aborted || this.closing) throw new AgentDetectionError('AGENT_DETECTION_CANCELLED')
    return new Promise((resolve, reject) => {
      let child: ChildProcess
      try { beforeEffect(); child = spawn(program, arguments_, { cwd: this.cwd, env: this.environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) }
      catch { reject(new ProbeError('failed')); return }
      let failure: ProbeError | undefined, stopped = false, bytes = 0
      const stdout: Buffer[] = [], stderr: Buffer[] = []
      let escalation: ReturnType<typeof setTimeout> | undefined
      const stop = () => {
        if (stopped) return; stopped = true
        try { child.kill('SIGTERM') } catch { /* retain until close */ }
        escalation = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* retain until close */ } }, 200)
      }
      const owned: Child = { process: child, stop }; this.children.add(owned)
      const abort = () => stop(); signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) stop()
      const timer = setTimeout(() => { failure ??= new ProbeError('timeout'); stop() }, Math.min(this.timeoutMs, requestedTimeout))
      const data = (list: Buffer[]) => (chunk: Buffer | string) => {
        if (failure || stopped) return
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += value.length
        if (bytes > AGENT_DETECTION_LIMITS.outputBytes) { failure = new ProbeError('overflow'); stop(); return }
        list.push(Buffer.from(value))
      }
      child.stdout?.on('data', data(stdout)); child.stderr?.on('data', data(stderr))
      const failed = (error: { code?: string }) => { failure ??= new ProbeError(error.code === 'ENOENT' ? 'missing' : 'failed'); stop() }
      child.on('error', failed); child.stdout?.on('error', failed); child.stderr?.on('error', failed)
      child.once('close', code => {
        clearTimeout(timer); if (escalation) clearTimeout(escalation); signal.removeEventListener('abort', abort); this.children.delete(owned)
        try {
          beforeEffect()
          if (signal.aborted || this.closing) reject(new AgentDetectionError('AGENT_DETECTION_CANCELLED'))
          else if (failure || code !== 0) reject(failure ?? new ProbeError('failed'))
          else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
        } catch (error) { reject(error) } finally { for (const value of [...stdout, ...stderr]) value.fill(0) }
      })
    })
  }
  private async integration(path: string, marker: string, beforeEffect: () => void): Promise<boolean> {
    let handle: Awaited<ReturnType<typeof open>> | undefined, bytes: Buffer | undefined
    try {
      const inside = relative(this.home, path)
      if (!inside || inside.startsWith('..' + sep) || isAbsolute(inside)) return false
      const anchors: Array<{ path: string; dev: bigint; ino: bigint }> = []
      const anchor = async (path: string): Promise<boolean> => {
        beforeEffect(); const entry = await lstat(path, { bigint: true }); beforeEffect()
        if (!entry.isDirectory() || entry.isSymbolicLink()) return false
        anchors.push({ path, dev: entry.dev, ino: entry.ino }); return true
      }
      let cursor = this.home
      if (!await anchor(cursor)) return false
      for (const part of inside.split(sep).slice(0, -1)) { cursor = join(cursor, part); if (!await anchor(cursor)) return false }
      beforeEffect(); const entry = await lstat(path, { bigint: true }); beforeEffect()
      if (!entry.isFile() || entry.isSymbolicLink()) return false
      beforeEffect(); handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW || 0))
      beforeEffect(); const stat = await handle.stat({ bigint: true })
      if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.size > BigInt(AGENT_DETECTION_LIMITS.fileBytes)) return false
      bytes = Buffer.alloc(Number(stat.size) + 1)
      beforeEffect(); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      beforeEffect(); const after = await handle.stat({ bigint: true }), current = await lstat(path, { bigint: true })
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) return false
      for (const anchor of anchors) {
        beforeEffect(); const current = await lstat(anchor.path, { bigint: true }); beforeEffect()
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== anchor.dev || current.ino !== anchor.ino) return false
      }
      beforeEffect(); return bytesRead <= Number(stat.size) && bytes.subarray(0, bytesRead).toString('utf8').includes(marker)
    } catch { return false }
    finally { bytes?.fill(0); await handle?.close() }
  }
  stop(): void {
    this.closing = true
    for (const controller of this.controllers) controller.abort()
    for (const child of this.children) child.stop()
    for (const job of this.queue.splice(0)) job.reject(new AgentDetectionError('AGENT_DETECTION_CLOSED'))
  }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid CLI detection shutdown deadline')
    this.stop()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([(async () => { while (this.work.size || this.jobs.size) await Promise.allSettled([...this.work, ...this.jobs]) })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AgentDetectionError('AGENT_DETECTION_TIMEOUT')), timeoutMs) })])
    } finally { if (timer) clearTimeout(timer) }
  }
}
