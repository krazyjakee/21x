import { AsyncLocalStorage } from 'node:async_hooks'
import type { ChildProcess, ExecFileOptions, ExecFileException, execFile as ExecFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { delimiter, isAbsolute, normalize, relative, sep } from 'node:path'

export const GIT_PROVIDER_PROCESS_LIMITS = Object.freeze({ children: 4, queued: 32, args: 64, argumentBytes: 524288, argsBytes: 1048576, outputBytes: 10485760, worktreeOutputBytes: 67108864, commandMs: 60000, worktreeMs: 300000 })
export const GIT_PROVIDER_ENV_KEYS = Object.freeze(['PATH','HOME','USERPROFILE','USER','LOGNAME','TMPDIR','TEMP','TMP','SystemRoot','WINDIR','COMSPEC','PATHEXT','APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','GH_CONFIG_DIR','GLAB_CONFIG_DIR','TEA_CONFIG_DIR','GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN','GITLAB_TOKEN','GITLAB_ACCESS_TOKEN','GITLAB_HOST','SSH_AUTH_SOCK'] as const)
export type GitProviderProgram = 'gh' | 'glab' | 'tea'
export type GitWorktreeProgram = 'git' | 'gh' | 'glab'
export type GitProviderProcessCode = 'GIT_PROVIDER_INVALID_OPTIONS' | 'GIT_PROVIDER_CWD_REFUSED' | 'GIT_PROVIDER_CLOSED' | 'GIT_PROVIDER_CANCELLED' | 'GIT_PROVIDER_BUSY' | 'GIT_PROVIDER_TIMEOUT' | 'GIT_PROVIDER_OUTPUT_LIMIT' | 'GIT_PROVIDER_CLI_MISSING' | 'GIT_PROVIDER_COMMAND_FAILED' | 'GIT_PROVIDER_INVALID_RESULT' | 'GIT_PROVIDER_DRAIN_INCOMPLETE'
export class GitProviderProcessError extends Error {
  constructor(readonly code: GitProviderProcessCode) { super(code); this.name = 'GitProviderProcessError' }
}
export interface GitProviderProcessOwnerOptions {
  execFile: typeof ExecFile
  home: string
  cwd: string
  environment: Readonly<NodeJS.ProcessEnv>
  assertCurrent(): void
  worktreeRoots?: readonly string[]
  maxConcurrency?: number
  commandTimeoutMs?: number
  /** Trusted fixture boundary only: fixed scripts run through real execFile. */
  fixture?: { executables: Readonly<Partial<Record<GitProviderProgram | 'git', { file: string; prefix: readonly string[] }>>> }
}
export interface GitProviderExecOptions { maxBuffer?: number; timeout?: number; allowNonzero?: boolean }
export interface GitWorktreeExecOptions { cwd?: string; timeout?: number; maxBuffer?: number; env?: { GIT_TERMINAL_PROMPT?: '0' } }
export interface GitProviderExecResult { stdout: string; stderr: string }
export interface GitProviderManagerHost { process: GitProviderProcessOwner; assertCurrent?(): void }
type Scope = { pending: Set<Promise<unknown>>; guards: Array<() => void>; signals: AbortSignal[] }
type RootReceipt = { path: string; dev: number; ino: number }
type Child = { process: ChildProcess; stop(): void }
type Job = { run(): Promise<void>; reject(error: unknown): void }
function error(code: GitProviderProcessCode): GitProviderProcessError { return new GitProviderProcessError(code) }
function validPath(value: unknown): value is string { return typeof value === 'string' && isAbsolute(value) && Buffer.byteLength(value, 'utf8') <= 4096 && !/[\u0000-\u001f\u007f]/.test(value) }
function inside(root: string, target: string): boolean { const part = relative(root, target); return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`) }

/** One captured app-owned CLI boundary. Requests cannot choose programs, env,
 * auth tokens or cwd. Callback delivery and actual child/pipe close are
 * independent receipts, both of which are retained before a job releases. */
export class GitProviderProcessOwner {
  private readonly environment: Readonly<NodeJS.ProcessEnv>
  private readonly home: string
  private readonly cwd: string
  private readonly worktreeRoots: readonly string[]
  private readonly executables: GitProviderProcessOwnerOptions['fixture']
  private readonly concurrency: number
  private readonly timeout: number
  private readonly hasSearchPath: boolean
  private readonly execFile: typeof ExecFile
  private readonly ownerCurrent: () => void
  private closing = false
  private active = 0
  private readonly work = new Set<Promise<unknown>>()
  private readonly jobs = new Set<Promise<unknown>>()
  private readonly children = new Set<Child>()
  private readonly queue: Job[] = []
  private readonly scopes = new AsyncLocalStorage<Scope | undefined>()
  private readonly roots = new Map<string, RootReceipt>()
  constructor(options: GitProviderProcessOwnerOptions) {
    if (!options || typeof options.execFile !== 'function' || typeof options.assertCurrent !== 'function' || !validPath(options.home) || !validPath(options.cwd) ||
      options.maxConcurrency !== undefined && (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1 || options.maxConcurrency > GIT_PROVIDER_PROCESS_LIMITS.children) ||
      options.commandTimeoutMs !== undefined && (!Number.isInteger(options.commandTimeoutMs) || options.commandTimeoutMs < 10 || options.commandTimeoutMs > GIT_PROVIDER_PROCESS_LIMITS.commandMs) ||
      options.worktreeRoots !== undefined && (!Array.isArray(options.worktreeRoots) || options.worktreeRoots.length > 16 || options.worktreeRoots.some(root => !validPath(root)))) throw error('GIT_PROVIDER_INVALID_OPTIONS')
    const environment: NodeJS.ProcessEnv = {}
    if (!options.environment || typeof options.environment !== 'object' || Array.isArray(options.environment)) throw error('GIT_PROVIDER_INVALID_OPTIONS')
    for (const [key, value] of Object.entries(options.environment)) {
      if (!GIT_PROVIDER_ENV_KEYS.includes(key as typeof GIT_PROVIDER_ENV_KEYS[number]) || value !== undefined && (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 32768 || /[\u0000-\u001f\u007f]/.test(value))) throw error('GIT_PROVIDER_INVALID_OPTIONS')
      if (value !== undefined) environment[key] = value
    }
    const searchPaths = (environment.PATH ?? '').split(delimiter).filter(Boolean)
    if (searchPaths.some(path => !validPath(path))) throw error('GIT_PROVIDER_INVALID_OPTIONS')
    this.hasSearchPath = searchPaths.length > 0
    if (this.hasSearchPath) environment.PATH = [...new Set(searchPaths.map(normalize))].join(delimiter)
    else delete environment.PATH
    for (const key of ['XDG_CONFIG_HOME','GH_CONFIG_DIR','GLAB_CONFIG_DIR','TEA_CONFIG_DIR','APPDATA','LOCALAPPDATA','TMPDIR','TEMP','TMP','SSH_AUTH_SOCK']) if (environment[key] && !validPath(environment[key])) throw error('GIT_PROVIDER_INVALID_OPTIONS')
    if (environment.GITLAB_HOST && !/^(?:https?:\/\/)?[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?(?::[0-9]{1,5})?\/?$/.test(environment.GITLAB_HOST)) throw error('GIT_PROVIDER_INVALID_OPTIONS')
    this.home = normalize(options.home); this.cwd = normalize(options.cwd)
    environment.HOME = this.home
    if (process.platform === 'win32') environment.USERPROFILE = this.home
    Object.assign(environment, { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GH_PAGER: '', GLAB_PAGER: '', PAGER: '', NO_COLOR: '1', CLICOLOR: '0', TERM: 'dumb' })
    this.environment = Object.freeze(environment)
    this.execFile = options.execFile
    this.ownerCurrent = options.assertCurrent
    this.worktreeRoots = Object.freeze((options.worktreeRoots ?? []).map(normalize))
    const executables: NonNullable<GitProviderProcessOwnerOptions['fixture']>['executables'] = {}
    for (const [program, target] of Object.entries(options.fixture?.executables ?? {})) {
      if (!['gh','glab','tea','git'].includes(program) || !target || !validPath(target.file) || !Array.isArray(target.prefix) || target.prefix.length > 8 || target.prefix.some(value => typeof value !== 'string' || value.length > 4096 || value.includes('\0'))) throw error('GIT_PROVIDER_INVALID_OPTIONS')
      ;(executables as Record<string, { file: string; prefix: readonly string[] }>)[program] = Object.freeze({ file: target.file, prefix: Object.freeze([...target.prefix]) })
    }
    this.executables = Object.freeze({ executables: Object.freeze(executables) })
    this.concurrency = options.maxConcurrency ?? GIT_PROVIDER_PROCESS_LIMITS.children
    this.timeout = options.commandTimeoutMs ?? GIT_PROVIDER_PROCESS_LIMITS.commandMs
  }
  get childCount(): number { return this.children.size }
  get inflightCount(): number { return this.work.size + this.jobs.size }
  get queuedCount(): number { return this.queue.length }
  assertOpen(): void { if (this.closing) throw error('GIT_PROVIDER_CLOSED') }
  assertCurrent(): void {
    this.assertOpen(); this.ownerCurrent()
    const scope = this.scopes.getStore()
    for (const signal of scope?.signals ?? []) if (signal.aborted) throw error('GIT_PROVIDER_CANCELLED')
    for (const guard of scope?.guards ?? []) guard()
  }
  retain<T>(raw: Promise<T>): Promise<T> {
    this.work.add(raw)
    const pending = this.scopes.getStore()?.pending
    pending?.add(raw)
    const done = (): void => { this.work.delete(raw); pending?.delete(raw) }
    void raw.then(done, done)
    return raw
  }
  withRequestGuard<T>(effect: () => T | Promise<T>, beforeEffect: () => void, signal?: AbortSignal): Promise<T> {
    try { this.assertCurrent(); if (signal?.aborted) throw error('GIT_PROVIDER_CANCELLED'); beforeEffect() } catch (cause) { return Promise.reject(cause) }
    const parent = this.scopes.getStore()
    const scope: Scope = { pending: parent?.pending ?? new Set(), guards: [...parent?.guards ?? [], beforeEffect], signals: [...parent?.signals ?? [], ...signal ? [signal] : []] }
    const raw = this.scopes.run(scope, async () => {
      let value: T | undefined, failure: unknown, failed = false
      try { this.assertCurrent(); value = await effect() } catch (cause) { failure = cause; failed = true }
      if (!parent) while (scope.pending.size) await Promise.allSettled([...scope.pending])
      this.assertCurrent()
      if (failed) throw failure
      return value as T
    })
    // The outer guard must never wait on itself. Nested scopes belong to the
    // outer pending set but perform their own join only at the outer boundary.
    return this.retain(raw)
  }
  exec(program: GitProviderProgram, args: readonly string[], opts: GitProviderExecOptions = {}): Promise<GitProviderExecResult> {
    if (!['gh','glab','tea'].includes(program)) return Promise.reject(error('GIT_PROVIDER_INVALID_OPTIONS'))
    if (opts.allowNonzero && !(program === 'gh' && args.join('\0') === 'auth\0status\0--hostname\0github.com' || program === 'glab' && args.join('\0') === 'auth\0status')) return Promise.reject(error('GIT_PROVIDER_INVALID_OPTIONS'))
    return this.execute(program, args, opts, this.cwd, false)
  }
  execWorktree(program: GitWorktreeProgram, args: readonly string[], opts: GitWorktreeExecOptions = {}): Promise<GitProviderExecResult> {
    if (!['git','gh','glab'].includes(program) || !validPath(opts.cwd ?? this.cwd) || !this.worktreeRoots.some(root => inside(root, normalize(opts.cwd ?? this.cwd))) ||
      opts.env && Object.entries(opts.env).some(([key, value]) => key !== 'GIT_TERMINAL_PROMPT' || value !== '0')) return Promise.reject(error('GIT_PROVIDER_CWD_REFUSED'))
    return this.execute(program, args, opts, normalize(opts.cwd ?? this.cwd), true)
  }
  private execute(program: GitProviderProgram | 'git', args: readonly string[], opts: GitProviderExecOptions, cwd: string, worktree: boolean): Promise<GitProviderExecResult> {
    try {
      this.assertCurrent()
      if (!Array.isArray(args) || args.length > GIT_PROVIDER_PROCESS_LIMITS.args || args.some(value => typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value, 'utf8') > GIT_PROVIDER_PROCESS_LIMITS.argumentBytes) || args.reduce((size, value) => size + Buffer.byteLength(value, 'utf8'), 0) > GIT_PROVIDER_PROCESS_LIMITS.argsBytes ||
        opts.timeout !== undefined && (!Number.isInteger(opts.timeout) || opts.timeout < 1 || opts.timeout > (worktree ? GIT_PROVIDER_PROCESS_LIMITS.worktreeMs : GIT_PROVIDER_PROCESS_LIMITS.commandMs)) ||
        opts.maxBuffer !== undefined && (!Number.isInteger(opts.maxBuffer) || opts.maxBuffer < 1 || opts.maxBuffer > (worktree ? GIT_PROVIDER_PROCESS_LIMITS.worktreeOutputBytes : GIT_PROVIDER_PROCESS_LIMITS.outputBytes))) throw error('GIT_PROVIDER_INVALID_OPTIONS')
    } catch (cause) { return Promise.reject(cause) }
    const captured = [...args], scope = this.scopes.getStore()
    return this.retain(this.schedule(() => this.scopes.run(scope, async () => {
      await this.checkDirectory(this.home)
      await this.checkDirectory(cwd)
      if (worktree) for (const root of this.worktreeRoots.filter(root => inside(root, cwd))) await this.checkDirectory(root)
      this.assertCurrent()
      return this.process(program, captured, opts, cwd, worktree)
    })))
  }
  private async checkDirectory(path: string): Promise<void> {
    const info = await lstat(path).catch(() => { throw error('GIT_PROVIDER_CWD_REFUSED') })
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw error('GIT_PROVIDER_CWD_REFUSED')
    const current = await lstat(path).catch(() => { throw error('GIT_PROVIDER_CWD_REFUSED') })
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino) throw error('GIT_PROVIDER_CWD_REFUSED')
    const receipt = this.roots.get(path)
    if (receipt && (receipt.dev !== info.dev || receipt.ino !== info.ino)) throw error('GIT_PROVIDER_CWD_REFUSED')
    this.roots.set(path, { path, dev: info.dev, ino: info.ino })
  }
  private schedule<T>(effect: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(error('GIT_PROVIDER_CLOSED'))
    if (this.queue.length >= GIT_PROVIDER_PROCESS_LIMITS.queued) return Promise.reject(error('GIT_PROVIDER_BUSY'))
    return new Promise<T>((resolve, reject) => { this.queue.push({ run: async () => { try { resolve(await effect()) } catch (cause) { reject(cause) } }, reject }); this.pump() })
  }
  private pump(): void {
    while (!this.closing && this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!; this.active++
      const raw = job.run(); this.jobs.add(raw)
      void raw.then(() => this.finished(raw), () => this.finished(raw))
    }
  }
  private finished(raw: Promise<unknown>): void { this.jobs.delete(raw); this.active--; this.pump() }
  private process(program: GitProviderProgram | 'git', args: string[], opts: GitProviderExecOptions, cwd: string, worktree: boolean): Promise<GitProviderExecResult> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess | undefined, callbackDone = false, childClosed = false, stdoutClosed = true, stderrClosed = true, failure: GitProviderProcessError | undefined
      let stdout = '', stderr = '', stopped = false, bytes = 0, escalation: ReturnType<typeof setTimeout> | undefined
      const scope = this.scopes.getStore(), signals = scope?.signals ?? []
      const limit = opts.maxBuffer ?? (worktree ? GIT_PROVIDER_PROCESS_LIMITS.worktreeOutputBytes : GIT_PROVIDER_PROCESS_LIMITS.outputBytes)
      const timeout = worktree ? opts.timeout ?? this.timeout : Math.min(opts.timeout ?? this.timeout, this.timeout)
      const stop = (): void => {
        if (stopped) return; stopped = true
        try { child?.kill('SIGTERM') } catch { /* retain actual close */ }
        escalation = setTimeout(() => { if (!childClosed) { try { child?.kill('SIGKILL') } catch { /* retain */ } } }, 200)
      }
      const abort = (): void => { failure ??= error('GIT_PROVIDER_CANCELLED'); stop() }
      const finish = (): void => {
        if (!child || !callbackDone || !childClosed || !stdoutClosed || !stderrClosed) return
        clearTimeout(timer); if (escalation) clearTimeout(escalation)
        for (const signal of signals) signal.removeEventListener('abort', abort)
        this.children.delete(owned)
        try { this.scopes.run(scope, () => { this.assertCurrent(); if (failure) throw failure; resolve({ stdout, stderr }) }) } catch (cause) { reject(cause) }
        finally { stdout = ''; stderr = '' }
      }
      const callback = (cause: ExecFileException | null, out: string | Buffer, err: string | Buffer): void => {
        callbackDone = true
        const outBytes = typeof out === 'string' ? Buffer.byteLength(out, 'utf8') : out?.length ?? 0
        const errBytes = typeof err === 'string' ? Buffer.byteLength(err, 'utf8') : err?.length ?? 0
        if (outBytes + errBytes > limit) failure ??= error('GIT_PROVIDER_OUTPUT_LIMIT')
        if (cause && !(opts.allowNonzero && typeof cause.code === 'number')) failure ??= error(cause.code === 'ENOENT' ? 'GIT_PROVIDER_CLI_MISSING' : cause.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'GIT_PROVIDER_OUTPUT_LIMIT' : 'GIT_PROVIDER_COMMAND_FAILED')
        if (!failure) { stdout = String(out ?? ''); stderr = String(err ?? '') }
        finish()
      }
      const target = this.executables?.executables[program]
      if (!target && !this.hasSearchPath) { reject(error('GIT_PROVIDER_CLI_MISSING')); return }
      try {
        this.assertCurrent()
        child = this.execFile(target?.file ?? program, [...target?.prefix ?? [], ...args], { cwd, env: this.environment, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: limit } as ExecFileOptions, callback)
      } catch { reject(error('GIT_PROVIDER_COMMAND_FAILED')); return }
      const owned: Child = { process: child, stop }; this.children.add(owned)
      const failed = (cause: NodeJS.ErrnoException): void => { failure ??= error(cause.code === 'ENOENT' ? 'GIT_PROVIDER_CLI_MISSING' : 'GIT_PROVIDER_COMMAND_FAILED'); stop() }
      child.on('error', failed)
      for (const [stream, which] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']] as const) {
        if (!stream) continue
        if (which === 'stdout') stdoutClosed = stream.closed
        else stderrClosed = stream.closed
        stream.on('data', (value: string | Buffer) => { bytes += typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.length; if (bytes > limit) { failure ??= error('GIT_PROVIDER_OUTPUT_LIMIT'); stop() } })
        stream.on('error', failed)
        stream.once('close', () => { if (which === 'stdout') stdoutClosed = true; else stderrClosed = true; finish() })
      }
      child.stdin?.on('error', failed); child.stdin?.end()
      child.once('close', code => {
        if (code !== undefined && code !== 0 && !(opts.allowNonzero && typeof code === 'number')) failure ??= error('GIT_PROVIDER_COMMAND_FAILED')
        childClosed = true; finish()
      })
      for (const signal of signals) { signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort() }
      const timer = setTimeout(() => { failure ??= error('GIT_PROVIDER_TIMEOUT'); stop() }, timeout)
      finish()
    })
  }
  stop(): void {
    this.closing = true
    for (const child of this.children) child.stop()
    for (const job of this.queue.splice(0)) job.reject(error('GIT_PROVIDER_CLOSED'))
  }
  async close(timeoutMs = 3000): Promise<void> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw error('GIT_PROVIDER_INVALID_OPTIONS')
    this.stop()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([(async () => { while (this.work.size || this.jobs.size || this.children.size) await Promise.allSettled([...this.work, ...this.jobs]) })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(error('GIT_PROVIDER_DRAIN_INCOMPLETE')), timeoutMs) })])
    } finally { if (timer) clearTimeout(timer) }
  }
}
