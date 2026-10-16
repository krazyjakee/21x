import { AsyncLocalStorage } from 'node:async_hooks'
import { OwnedOperationLifetime } from './owned-operation-lifetime'
import { execFile, type ExecFileOptions } from 'child_process'
import { promisify } from 'util'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, type BigIntStats } from 'fs'
import { readdir, opendir } from 'fs/promises'
import type { Dir } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep, win32 } from 'path'
import type { ForgejoManager } from './forgejo-manager'

const execFileAsync = promisify(execFile)


export interface WorktreeRepo {
  fullName: string
  defaultBranch: string
  cloneUrl?: string
}

export interface TaskChangesResult {
  repo: string
  diff: string
  allFiles?: string[]
  workspace?: boolean
  error?: string
  noWorktree?: boolean
  path?: string
  branch?: string
  pushed?: boolean
  prNumber?: number
  prUrl?: string
  prState?: string
  prTitle?: string
  ciStatus?: 'passing' | 'failing' | 'pending' | 'none'
}

export interface TaskFileInventoryResult {
  repo: string
  allFiles: string[]
  workspace?: boolean
  error?: string
  noWorktree?: boolean
  path?: string
}

export interface TaskFileContent {
  content: string
  size: number
  binary: boolean
  truncated: boolean
}

const MAX_TASK_FILE_PREVIEW_BYTES = 512 * 1024
const GIT_OPTS = { maxBuffer: 64 * 1024 * 1024 }
/** Parallel `git diff --no-index` processes when rendering untracked files. */
const UNTRACKED_DIFF_CONCURRENCY = 8
export const WORKTREE_PORTABLE_LIMITS = Object.freeze({ stdoutBytes: 128 * 1024, aggregateBytes: 512 * 1024, diffBytes: 128 * 1024, files: 4096, entries: 8192, depth: 64 })
export interface WorktreeRequestOptions {
  limits?: typeof WORKTREE_PORTABLE_LIMITS
  beforeRemoteRequest?(repo: string, address: string): void | Promise<void>
}
interface WorktreeRequestState { pending: Set<Promise<unknown>>; limits?: typeof WORKTREE_PORTABLE_LIMITS; budget: { bytes: number; entries: number }; options: WorktreeRequestOptions }

/** Like Promise.all over `items.map(fn)`, with at most `limit` in flight. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  }
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker))
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed) throw failed.reason
  return results
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const pathFromRoot = relative(rootPath, candidatePath)
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
}

export interface WorktreeHost {
  reposRoot: string
  workspaceRoot: string
  emitProgress(data: { taskId: string; repo: string; step: string; done: boolean; error?: string }): void
  bindWindow?(window: { isDestroyed(): boolean; webContents: { send(channel: string, ...args: unknown[]): void } }): void
  /** Trusted captured process owner; absent only for the legacy host. */
  exec?(program: 'git' | 'gh' | 'glab', args: string[], options: ExecFileOptions & { allowDiffExitOne?: true }): Promise<{ stdout: string; stderr: string }>
  assertPath?(path: string): void
  /** Optional captured cleanup observer; rejection must never enter fallback. */
  beforeCleanupEffect?(taskId: string): Promise<void>
  onTaskWorkspaceRemoved?(taskId: string, identity: { dev: string; ino: string }): void
  onWorktreeRemoved?(path: string, identity: { dev: string; ino: string }): void
  portableLimits?: typeof WORKTREE_PORTABLE_LIMITS
}

export class WorktreeManager {
  private readonly lifetime = new OwnedOperationLifetime()
  private readonly requestGuard = new AsyncLocalStorage<(() => void) | undefined>()
  private readonly requestState = new AsyncLocalStorage<WorktreeRequestState | undefined>()
  private readonly progressTask = new AsyncLocalStorage<string>()
  private readonly directories = new Set<Dir>()
  private readonly failedDirectories = new Set<Dir>()
  constructor(private readonly host: WorktreeHost) {
    for (const path of [host.reposRoot, host.workspaceRoot]) {
      if (!isAbsolute(path) || path.includes('\0')) throw new Error('WORKTREE_PATH_INVALID')
    }
  }
  private forgejoManager: ForgejoManager | null = null

  setMainWindow(window: Parameters<NonNullable<WorktreeHost['bindWindow']>>[0]): void {
    if (!this.host.bindWindow) throw new Error('WORKTREE_WINDOW_HOST_UNAVAILABLE')
    this.host.bindWindow(window)
  }

  shutdown(): void { this.lifetime.stop() }
  async close(timeoutMs = 3000): Promise<void> {
    await this.lifetime.close(timeoutMs)
    for (const directory of [...this.directories]) { await directory.close(); this.directories.delete(directory); this.failedDirectories.delete(directory) }
    if (this.directories.size) throw new Error('WORKTREE_DIRECTORY_DRAIN_INCOMPLETE')
  }

  assertOwners(reposRoot: string, workspaceRoot: string, forgejo: ForgejoManager): void {
    this.lifetime.assertOpen()
    if (this.failedDirectories.size) throw new Error('WORKTREE_DIRECTORY_CLOSE_UNACKNOWLEDGED')
    if (this.host.reposRoot !== reposRoot || this.host.workspaceRoot !== workspaceRoot || this.forgejoManager !== forgejo || !this.host.exec || !this.host.assertPath) throw new Error('WORKTREE_OWNER_MISMATCH')
  }

  withRequestGuard<T>(effect: () => T | Promise<T>, beforeEffect: () => void, signal?: AbortSignal, options: WorktreeRequestOptions = {}): Promise<T> {
    const parent = this.requestGuard.getStore(), inherited = this.requestState.getStore()
    let active = true
    const guard = (): void => { if (!active) throw new Error('WORKTREE_REQUEST_EXPIRED'); parent?.(); beforeEffect(); if (signal?.aborted) throw new Error('WORKTREE_CANCELLED') }
    const state: WorktreeRequestState = { pending: new Set(), limits: options.limits ?? inherited?.limits ?? this.host.portableLimits, budget: inherited?.budget ?? { bytes: 0, entries: 0 }, options: Object.freeze({ ...inherited?.options, ...options }) }
    const raw = this.requestGuard.run(guard, () => this.requestState.run(state, () => this.lifetime.run(async () => {
      try {
        this.assertRequestCurrent(); let value!: T, failed = false, failure: unknown
        try { value = await effect() } catch (cause) { failed = true; failure = cause }
        while (state.pending.size) await Promise.allSettled([...state.pending])
        this.assertRequestCurrent()
        if (failed) throw failure
        return value
      } finally { active = false }
    })))
    // Register the nested wrapper outside its own ALS state. The parent owns
    // that scope, while each scope joins only its own actual children.
    if (inherited) { inherited.pending.add(raw); void raw.then(() => inherited.pending.delete(raw), () => inherited.pending.delete(raw)) }
    return raw
  }

  private ownRaw<T>(raw: Promise<T>): Promise<T> {
    const state = this.requestState.getStore()
    if (state) { state.pending.add(raw); void raw.then(() => state.pending.delete(raw), () => state.pending.delete(raw)) }
    return raw
  }
  private runOwned<T>(effect: () => Promise<T>): Promise<T> {
    return !this.requestState.getStore() && this.host.portableLimits
      ? this.withRequestGuard(effect, () => { this.host.assertPath?.(this.host.workspaceRoot) }, undefined, { limits: this.host.portableLimits })
      : this.lifetime.run(effect)
  }
  private limits(): typeof WORKTREE_PORTABLE_LIMITS | undefined { return this.requestState.getStore()?.limits ?? this.host.portableLimits }
  private fallback(cause?: unknown): void {
    this.assertRequestCurrent()
    if (this.limits() && cause instanceof Error && cause.name === 'ServiceProtocolError') throw cause
    if (this.limits() && cause instanceof Error && /^(?:WORKTREE_(?:OUTPUT|FILES|SCAN|DEPTH|DIRECTORY|PATH|REF|CLONE|OWNER|CANCELLED)|GIT_PROVIDER_(?:OUTPUT|CANCELLED|CLOSED|DRAIN|TIMEOUT|CWD))/.test(cause.message)) throw cause
  }
  private boundedText(value: string): string {
    const limits = this.limits(), state = this.requestState.getStore(), bytes = Buffer.byteLength(value)
    if (limits && bytes > limits.stdoutBytes) throw new Error('WORKTREE_OUTPUT_LIMIT')
    if (state && limits) { state.budget.bytes += bytes; if (state.budget.bytes > limits.aggregateBytes) throw new Error('WORKTREE_OUTPUT_LIMIT') }
    return value
  }

  setForgejoManager(manager: ForgejoManager): void {
    this.forgejoManager = manager
  }

  private sendProgress(taskId: string, repo: string, step: string, done: boolean, error?: string): void {
    this.assertRequestCurrent()
    this.host.emitProgress({ taskId: taskId || this.progressTask.getStore() || '', repo, step, done, error: error === undefined ? undefined : this.limits() ? 'The worktree operation could not be completed.' : error })
  }

  private assertRequestCurrent(): void {
    this.lifetime.assertOpen(); this.requestGuard.getStore()?.()
    if (this.failedDirectories.size) throw new Error('WORKTREE_DIRECTORY_CLOSE_UNACKNOWLEDGED')
    const state = this.requestState.getStore()
    if (state?.limits && state.budget.bytes > state.limits.aggregateBytes) throw new Error('WORKTREE_OUTPUT_LIMIT')
  }

  private async execOwned(file: 'git' | 'gh' | 'glab', args: string[], options: ExecFileOptions & { allowDiffExitOne?: true } = {}): Promise<{ stdout: string; stderr: string }> {
    this.assertRequestCurrent()
    const limits = this.limits(), boundedOptions = limits ? { ...options, maxBuffer: Math.min(options.maxBuffer ?? limits.stdoutBytes, limits.stdoutBytes) } : options
    const result = await this.ownRaw(this.host.exec ? this.host.exec(file, args, { ...boundedOptions, cwd: options.cwd ?? this.host.reposRoot })
      : execFileAsync(file, args, boundedOptions).then(({ stdout, stderr }) => ({ stdout: stdout.toString(), stderr: stderr.toString() })))
    this.assertRequestCurrent()
    return { stdout: this.boundedText(result.stdout), stderr: this.boundedText(result.stderr) }
  }

  private bareClonePath(org: string, repoName: string): string {
    if (this.host.assertPath && (!this.validNamespace(org) || !this.validSegment(repoName))) throw new Error('WORKTREE_PATH_UNAUTHORIZED')
    return this.directory(join(this.host.reposRoot, org, `${repoName}.git`))
  }

  private worktreePath(taskId: string, repoName: string): string {
    if (this.host.assertPath && !this.validSegment(repoName)) throw new Error('WORKTREE_PATH_UNAUTHORIZED')
    return this.directory(join(this.taskDirectory(taskId), repoName))
  }

  private validSegment(value: string): boolean { return value !== '.' && value !== '..' && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/.test(value) }
  private validNamespace(value: string): boolean { return value.length <= 2048 && value.split('/').length <= 15 && value.split('/').every(part => this.validSegment(part)) }
  private directory(path: string): string { this.assertRequestCurrent(); this.host.assertPath?.(path); return path }
  private taskDirectory(taskId: string): string {
    if (this.host.assertPath && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(taskId)) throw new Error('WORKTREE_PATH_UNAUTHORIZED')
    return this.directory(join(this.host.workspaceRoot, taskId))
  }
  private assertRemoval(path: string, captured: BigIntStats | null): void {
    this.directory(path)
    if (captured) {
      const current = lstatSync(path, { bigint: true })
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== captured.dev || current.ino !== captured.ino) throw new Error('WORKTREE_DIRECTORY_CHANGED')
    }
  }
  private assertRepo(org: string, repo: WorktreeRepo, provider?: string): void {
    if (!this.host.assertPath) return
    const name = repo.fullName.split('/').pop() ?? ''
    if (!this.validNamespace(org) || !this.validSegment(name) || repo.fullName !== `${org}/${name}` || provider !== undefined && !['github', 'gitlab', 'forgejo'].includes(provider)) throw new Error('WORKTREE_PATH_UNAUTHORIZED')
    const branch = repo.defaultBranch
    if (!branch || branch.length > 1024 || /^[-/]/.test(branch) || /[\u0000-\u0020\u007f~^:?*\[\\]/.test(branch) || branch.includes('..') || branch.includes('@{') || branch.includes('//') || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) throw new Error('WORKTREE_REF_INVALID')
    if ((!provider || provider === 'github') && repo.cloneUrl) {
      const expected = `https://github.com/${repo.fullName}.git`
      if (repo.cloneUrl !== expected) throw new Error('WORKTREE_CLONE_SCOPE_INVALID')
    }
  }

  private portableCloneAddress(repo: WorktreeRepo, provider?: string): string {
    const address = repo.cloneUrl || ((!provider || provider === 'github') ? `https://github.com/${repo.fullName}.git` : '')
    try {
      const url = new URL(address)
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href !== address) throw new Error()
    } catch { throw new Error('WORKTREE_CLONE_SCOPE_INVALID') }
    return address
  }

  private async authorizeRemote(repo: string, address: string): Promise<void> {
    this.assertRequestCurrent()
    if (!this.limits()) return
    const beforeRemote = this.requestState.getStore()?.options.beforeRemoteRequest
    if (!beforeRemote) throw new Error('WORKTREE_REMOTE_SCOPE_UNAVAILABLE')
    await this.ownRaw(Promise.resolve(beforeRemote(repo, address)))
    this.assertRequestCurrent()
  }

  /** Read one selected file on demand while keeping renderer-provided paths
   * inside the task workspace (and inside the selected repository, if any). */
  readTaskFile(taskId: string, repoFullName: string | null, filePath: string): TaskFileContent | null {
    this.assertRequestCurrent()
    if (!filePath || filePath.includes('\0') || isAbsolute(filePath) || win32.isAbsolute(filePath)) return null
    const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '')
    if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return null

    try {
      this.taskDirectory(taskId)
      const workspacesRoot = realpathSync(this.host.workspaceRoot)
      const workspaceRoot = realpathSync(join(workspacesRoot, taskId))
      if (!isWithinRoot(workspacesRoot, workspaceRoot)) return null
      const repoName = repoFullName?.split('/').pop()
      if (repoFullName && (!repoName || repoName === '.' || repoName === '..')) return null
      const requestedRoot = repoName ? join(workspaceRoot, repoName) : workspaceRoot
      const root = realpathSync(requestedRoot)
      if (!isWithinRoot(workspaceRoot, root)) return null
      const candidate = realpathSync(resolve(root, normalized))
      if (!isWithinRoot(root, candidate)) return null

      const fileStat = statSync(candidate)
      if (!fileStat.isFile()) return null
      if (fileStat.size > MAX_TASK_FILE_PREVIEW_BYTES) {
        return { content: '', size: fileStat.size, binary: false, truncated: true }
      }
      const bytes = readFileSync(candidate)
      const binary = bytes.subarray(0, 8192).includes(0)
      return {
        content: binary ? '' : bytes.toString('utf8'),
        size: fileStat.size,
        binary,
        truncated: false
      }
    } catch {
      return null
    }
  }

  /** The portable bridge supplies its actual captured descriptor reader. No
   * renderer path/root/primitive can replace this trusted internal callback. */
  readTaskFileOwned(taskId: string, repoFullName: string | null, filePath: string, reader: (absolutePath: string) => Promise<TaskFileContent | null>): Promise<TaskFileContent | null> {
    return this.runOwned(async () => {
      this.assertRequestCurrent()
      if (!filePath || filePath.includes('\0') || isAbsolute(filePath) || win32.isAbsolute(filePath)) return null
      const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '')
      if (normalized.split('/').some(segment => !segment || segment === '.' || segment === '..')) return null
      const taskRoot = this.taskDirectory(taskId), repo = repoFullName?.split('/').pop()
      if (repoFullName && (!repo || !this.validSegment(repo))) return null
      const root = repo ? join(taskRoot, repo) : taskRoot, candidate = resolve(root, normalized)
      if (!isWithinRoot(root, candidate)) return null
      const value = await this.ownRaw(reader(candidate)); this.assertRequestCurrent(); return value
    })
  }

  async setupWorkspaceForTask(
    taskId: string,
    repos: WorktreeRepo[],
    org: string,
    provider?: string,
    beforeEffect?: () => void
  ): Promise<string> {
    const parent = this.requestGuard.getStore()
    return this.progressTask.run(taskId, () => this.requestGuard.run(beforeEffect ? () => { parent?.(); beforeEffect() } : parent, () => this.runOwned(async () => {
      this.assertRequestCurrent()
      const result = await this.performSetupWorkspaceForTask(taskId, repos, org, provider)
      this.assertRequestCurrent()
      return result
    })))
  }

  private async performSetupWorkspaceForTask(
    taskId: string,
    repos: WorktreeRepo[],
    org: string,
    provider?: string
  ): Promise<string> {
    const taskDir = this.taskDirectory(taskId)
    for (const repo of repos) this.assertRepo(org, repo, provider)
    // Resolve only captured provider metadata before the first directory or
    // network effect. Portable GitLab/Forgejo have no guessed host fallback.
    if (this.limits()) for (const repo of repos) await this.authorizeRemote(repo.fullName, this.portableCloneAddress(repo, provider))
    console.log(`[WorktreeManager] Setting up workspace for task ${taskId}`)
    console.log(`[WorktreeManager]   Task directory: ${taskDir}`)
    console.log(`[WorktreeManager]   Organization: ${org}`)
    console.log(`[WorktreeManager]   Provider: ${provider || 'github'}`)
    console.log(`[WorktreeManager]   Repos to setup: ${repos.map(r => r.fullName).join(', ')}`)

    this.assertRequestCurrent()
    mkdirSync(taskDir, { recursive: true })

    for (const repo of repos) {
      const repoName = repo.fullName.split('/').pop() || repo.fullName
      try {
        console.log(`[WorktreeManager] Processing repo: ${repo.fullName}`)
        await this.ensureBareClone(org, repoName, repo.fullName, provider, repo.cloneUrl)
        await this.fetchBareClone(org, repoName, repo, provider)
        await this.createWorktree(taskId, org, repoName, repo.defaultBranch)
        this.sendProgress(taskId, repoName, 'done', true)
      } catch (error: unknown) {
        this.fallback(error)
        const errMsg = (error as Error).message
        if (!this.limits()) console.error(`[WorktreeManager] Error setting up ${repo.fullName}:`, errMsg)
        this.sendProgress(taskId, repoName, 'error', true, errMsg)
        throw error
      }
    }

    console.log(`[WorktreeManager] Workspace setup complete: ${taskDir}`)
    return taskDir
  }

  private async ensureBareClone(
    org: string,
    repoName: string,
    fullName: string,
    provider?: string,
    cloneUrl?: string
  ): Promise<void> {
    const barePath = this.bareClonePath(org, repoName)

    if (existsSync(barePath)) {
      console.log(`[WorktreeManager]   Bare clone already exists: ${barePath}`)
      return
    }

    console.log(`[WorktreeManager]   Bare clone not found, creating: ${barePath}`)
    this.sendProgress('', repoName, 'cloning', false)
    const orgDir = this.directory(join(this.host.reposRoot, org))
    this.assertRequestCurrent()
    mkdirSync(orgDir, { recursive: true })

    if (provider === 'forgejo') {
      if (!this.forgejoManager) throw new Error('Forgejo support is not initialized')
      await this.ownRaw(this.forgejoManager.cloneBare(fullName, barePath, cloneUrl)); this.assertRequestCurrent()
    } else if (provider === 'gitlab') {
      console.log(`[WorktreeManager]   Executing: glab repo clone ${fullName} ${barePath} -- --bare`)
      await this.execOwned('glab', ['repo', 'clone', this.limits() ? cloneUrl! : fullName, barePath, '--', '--bare'], {
        timeout: 300000
      })
      // glab bare clone doesn't set fetch refspec — without it, `git fetch origin`
      // only fetches HEAD as FETCH_HEAD and doesn't create remote tracking branches
      // (e.g. origin/main). This breaks worktree creation from origin/<branch>.
      console.log(`[WorktreeManager]   Setting fetch refspec for glab bare clone`)
      await this.execOwned('git', [
        'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'
      ], { cwd: barePath })
    } else {
      const githubCloneTarget = cloneUrl || `https://github.com/${fullName}.git`
      console.log(`[WorktreeManager]   Executing: gh repo clone ${githubCloneTarget} ${barePath} -- --bare`)
      await this.execOwned('gh', ['repo', 'clone', githubCloneTarget, barePath, '--', '--bare'], {
        timeout: 300000
      })
    }
    console.log(`[WorktreeManager]   Bare clone created successfully`)
  }

  private async fetchBareClone(org: string, repoName: string, repo: WorktreeRepo, provider?: string): Promise<void> {
    const barePath = this.bareClonePath(org, repoName)
    if (this.limits()) {
      const expected = this.portableCloneAddress(repo, provider)
      const { stdout } = await this.execOwned('git', ['remote', 'get-url', '--all', 'origin'], { cwd: barePath })
      if (stdout.trim() !== expected || stdout.trim().includes('\n') || stdout.trim().includes('\r')) throw new Error('WORKTREE_CLONE_SCOPE_INVALID')
      await this.authorizeRemote(repo.fullName, expected)
    }
    console.log(`[WorktreeManager]   Fetching latest from origin`)
    console.log(`[WorktreeManager]   Executing: git fetch origin`)
    console.log(`[WorktreeManager]   CWD: ${barePath}`)
    this.sendProgress('', repoName, 'fetching', false)

    // Failures propagate to setupWorkspaceForTask, which logs and reports them.
    await this.execOwned('git', ['fetch', 'origin'], {
      cwd: barePath,
      timeout: 120000
    })
    console.log(`[WorktreeManager]   Fetch completed successfully`)
  }

  /**
   * Resolves the start ref for a bare clone. Tries origin/<branch>, then <branch>, then HEAD.
   */
  private async resolveStartRef(barePath: string, defaultBranch: string): Promise<string> {
    const candidates = [`origin/${defaultBranch}`, defaultBranch, 'HEAD']
    for (const ref of candidates) {
      try {
        await this.execOwned('git', ['rev-parse', '--verify', ref], { cwd: barePath })
        return ref
      } catch (error) {
        this.fallback(error)
        // try next
      }
    }
    throw new Error(`Could not resolve any ref for ${defaultBranch} in ${barePath}`)
  }

  private async createWorktree(
    taskId: string,
    org: string,
    repoName: string,
    defaultBranch: string
  ): Promise<void> {
    const barePath = this.bareClonePath(org, repoName)
    const wtPath = this.worktreePath(taskId, repoName)

    console.log(`[WorktreeManager] Creating worktree for ${repoName}`)
    console.log(`[WorktreeManager]   Bare clone: ${barePath}`)
    console.log(`[WorktreeManager]   Worktree path: ${wtPath}`)
    console.log(`[WorktreeManager]   Default branch: ${defaultBranch}`)

    if (existsSync(wtPath)) {
      console.log(`[WorktreeManager]   Worktree already exists, skipping`)
      return
    }

    this.sendProgress(taskId, repoName, 'creating worktree', false)

    const branchName = `task/${taskId}`

    // Check if branch already exists
    try {
      const { stdout } = await this.execOwned('git', ['branch', '--list', branchName], {
        cwd: barePath
      })
      if (stdout.trim()) {
        this.directory(wtPath)
        // Branch exists — create worktree from existing branch
        console.log(`[WorktreeManager]   Branch ${branchName} exists, creating worktree from existing branch`)
        console.log(`[WorktreeManager]   Executing: git worktree add ${wtPath} ${branchName}`)
        console.log(`[WorktreeManager]   CWD: ${barePath}`)
        await this.execOwned('git', ['worktree', 'add', wtPath, branchName], {
          cwd: barePath
        })
        console.log(`[WorktreeManager]   Worktree created successfully`)
        return
      }
    } catch (err: unknown) {
      this.fallback(err)
      console.log(`[WorktreeManager]   Error checking for existing branch:`, (err as Error).message)
      // ignore — fall through to create new branch
    }

    const startRef = await this.resolveStartRef(barePath, defaultBranch)
    this.directory(wtPath)
    console.log(`[WorktreeManager]   Resolved start ref: ${startRef}`)

    // Create worktree with new branch from resolved ref
    console.log(`[WorktreeManager]   Creating new branch ${branchName} from ${startRef}`)
    console.log(`[WorktreeManager]   Executing: git worktree add ${wtPath} -b ${branchName} ${startRef}`)
    console.log(`[WorktreeManager]   CWD: ${barePath}`)

    try {
      await this.execOwned('git', [
        'worktree', 'add', wtPath, '-b', branchName, startRef
      ], {
        cwd: barePath,
        timeout: 60000
      })
      console.log(`[WorktreeManager]   Worktree created successfully`)
    } catch (err: unknown) {
      const execErr = err as { message: string; stdout?: string; stderr?: string }
      if (!this.limits()) {
        console.error(`[WorktreeManager]   Failed to create worktree:`, execErr.message)
        if (execErr.stdout) console.error(`[WorktreeManager]   stdout:`, execErr.stdout)
        if (execErr.stderr) console.error(`[WorktreeManager]   stderr:`, execErr.stderr)
      }
      throw err
    }
  }

  async cleanupTaskWorkspace(
    taskId: string,
    repos: { fullName: string }[],
    org: string,
    removeTaskDir = true
  ): Promise<void> {
    return this.runOwned(() => this.performCleanupTaskWorkspace(taskId, repos, org, removeTaskDir))
  }

  private async performCleanupTaskWorkspace(
    taskId: string,
    repos: { fullName: string }[],
    org: string,
    removeTaskDir = true
  ): Promise<void> {
    const taskDir = this.taskDirectory(taskId)
    const taskIdentity = this.host.assertPath && existsSync(taskDir) ? lstatSync(taskDir, { bigint: true }) : null
    const beforeRemoval = async (path: string, captured: BigIntStats | null): Promise<void> => {
      if (!this.host.beforeCleanupEffect) return
      this.assertRequestCurrent()
      await this.host.beforeCleanupEffect(taskId)
      // Observations yield. Recheck request, physical task generation and the
      // precise target after the await and before any destructive boundary.
      this.assertRequestCurrent(); this.assertRemoval(taskDir, taskIdentity)
      if (path !== taskDir) this.assertRemoval(path, captured)
    }
    for (const repo of repos) {
      const repoName = repo.fullName.split('/').pop() || repo.fullName
      const barePath = this.bareClonePath(org, repoName)
      const wtPath = this.worktreePath(taskId, repoName)
      const worktreeIdentity = this.host.assertPath && existsSync(wtPath) ? lstatSync(wtPath, { bigint: true }) : null

      if (existsSync(barePath) && existsSync(wtPath)) {
        await beforeRemoval(wtPath, worktreeIdentity)
        try {
          await this.execOwned('git', ['worktree', 'remove', wtPath, '--force'], {
            cwd: barePath
          })
        } catch (error) {
          this.fallback(error)
          // If git worktree remove fails, remove directory manually
          if (existsSync(wtPath)) {
            await beforeRemoval(wtPath, worktreeIdentity)
            this.assertRequestCurrent()
            this.assertRemoval(wtPath, worktreeIdentity)
            rmSync(wtPath, { recursive: true, force: true })
          }
        }
      } else if (existsSync(wtPath)) {
        await beforeRemoval(wtPath, worktreeIdentity)
        this.assertRequestCurrent()
        this.assertRemoval(wtPath, worktreeIdentity)
        rmSync(wtPath, { recursive: true, force: true })
      }
      this.assertRequestCurrent()
      if (worktreeIdentity && !existsSync(wtPath)) this.host.onWorktreeRemoved?.(wtPath, { dev: worktreeIdentity.dev.toString(), ino: worktreeIdentity.ino.toString() })
      else if (worktreeIdentity && this.limits() && existsSync(wtPath)) throw new Error('WORKTREE_DIRECTORY_REMOVE_UNACKNOWLEDGED')
    }

    // Remove task directory if requested (skip when session is still active)
    if (removeTaskDir) {
      if (existsSync(taskDir)) {
        await beforeRemoval(taskDir, taskIdentity)
        try {
          this.assertRequestCurrent()
          this.assertRemoval(taskDir, taskIdentity)
          rmSync(taskDir, { recursive: true, force: true })
          if (taskIdentity) this.host.onTaskWorkspaceRemoved?.(taskId, { dev: taskIdentity.dev.toString(), ino: taskIdentity.ino.toString() })
        } catch (error) {
          this.fallback(error)
          if (this.limits()) throw error
          // Preserve legacy best-effort removal, but scoped failures refuse.
        }
      }
    }
  }

  /**
   * Collect the task workspace inventory and the working-tree diff for each
   * linked repository. Returns one raw unified diff per repo — tracked changes vs HEAD plus
   * untracked files rendered via `git diff --no-index` (read-only; never
   * mutates the index). Repos without a worktree yet are skipped; per-repo
   * failures are reported rather than thrown so one bad repo can't hide the rest.
   */
  async getTaskChanges(
    taskId: string,
    repos: { fullName: string }[]
  ): Promise<TaskChangesResult[]> {
    return this.runOwned(() => this.performGetTaskChanges(taskId, repos))
  }

  private async performGetTaskChanges(
    taskId: string,
    repos: { fullName: string }[]
  ): Promise<TaskChangesResult[]> {
    // Repos are independent worktrees, so inspect them concurrently.
    const [workspaceFiles, results] = await Promise.all([
      this.ownRaw(this.listNonRepositoryWorkspaceFiles(taskId, repos)),
      Promise.all(repos.map((repo) => this.ownRaw(this.getRepoChanges(taskId, repo))))
    ])
    return [{ repo: 'Task workspace', diff: '', allFiles: workspaceFiles, workspace: true }, ...results]
  }

  private async getRepoChanges(taskId: string, repo: { fullName: string }): Promise<TaskChangesResult> {
    const repoName = repo.fullName.split('/').pop() || repo.fullName
    const wtPath = this.worktreePath(taskId, repoName)
    if (!existsSync(wtPath)) {
      console.log(`[WorktreeManager] getTaskChanges: no worktree for ${repo.fullName} at ${wtPath}`)
      return { repo: repo.fullName, diff: '', noWorktree: true, path: wtPath }
    }

    try {
      // Complete browsable worktree inventory: tracked + untracked files,
      // while respecting .gitignore and never traversing .git internals.
      const allFiles = await this.listRepositoryFiles(wtPath)

      // Agents auto-commit, so "uncommitted only" (git diff HEAD) is usually
      // empty. We want the task's whole diff: base branch → current work
      // (committed + uncommitted). Discover the base branch this worktree
      // forked from, then diff against the merge-base.
      let baseRef = ''
      try {
        const { stdout } = await this.execOwned(
          'git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
          { cwd: wtPath, ...GIT_OPTS }
        )
        baseRef = stdout.trim() // e.g. "origin/main"
      } catch (error) { this.fallback(error) /* origin/HEAD not set */ }
      if (!baseRef) {
        for (const cand of ['origin/main', 'origin/master', 'main', 'master']) {
          try {
            await this.execOwned('git', ['rev-parse', '--verify', '--quiet', cand], { cwd: wtPath, ...GIT_OPTS })
            baseRef = cand
            break
          } catch (error) { this.fallback(error) /* not this candidate */ }
        }
      }

      // Diff target: merge-base with the base branch (captures committed work);
      // fall back to HEAD (uncommitted only) if no base can be resolved.
      let against = 'HEAD'
      if (baseRef) {
        try {
          const { stdout } = await this.execOwned('git', ['merge-base', 'HEAD', baseRef], { cwd: wtPath, ...GIT_OPTS })
          const mergeBase = stdout.trim()
          if (mergeBase) against = mergeBase
        } catch (error) { this.fallback(error) /* keep HEAD */ }
      }

      // `git diff <against>` compares that commit to the WORKING TREE, so the
      // patch includes both committed and uncommitted changes.
      let tracked = ''
      try {
        const { stdout } = await this.execOwned(
          'git', ['-c', 'core.quotepath=false', 'diff', '--no-color', ...(this.limits() ? ['--no-ext-diff', '--no-textconv'] : []), against],
          { cwd: wtPath, ...GIT_OPTS }
        )
        tracked = stdout
      } catch (e) {
        this.fallback(e)
        if (this.limits()) throw e
        const err = e as { stdout?: string }
        tracked = err.stdout ?? ''
      }

      const untracked = await this.untrackedFilesPatch(wtPath)

      // Branch + PR metadata so the UI can group changes by branch / PR.
      let branch: string | undefined
      try {
        const { stdout } = await this.execOwned('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wtPath, ...GIT_OPTS })
        const b = stdout.trim()
        branch = b && b !== 'HEAD' ? b : undefined
      } catch (error) { this.fallback(error) /* detached HEAD */ }

      let pushed = false
      if (branch) {
        try {
          await this.execOwned('git', ['rev-parse', '--verify', '--quiet', `origin/${branch}`], { cwd: wtPath, ...GIT_OPTS })
          pushed = true
        } catch (error) { this.fallback(error) /* branch not on remote yet */ }
      }

      // Best-effort PR/MR lookup for the branch checked out in this worktree.
      // `gh pr view` (no branch arg) resolves the current branch's PR directly,
      // so it works even when the local origin/<branch> tracking ref is stale
      // (i.e. the branch is pushed but this worktree hasn't fetched it).
      let prNumber: number | undefined
      let prUrl: string | undefined
      let prState: string | undefined
      let prTitle: string | undefined
      let ciStatus: 'passing' | 'failing' | 'pending' | 'none' | undefined
      if (branch) {
        let provider: 'github' | 'gitlab' | 'forgejo' | 'other' = 'other'
        let remoteUrl = ''
        try {
          const { stdout } = await this.execOwned('git', ['remote', 'get-url', 'origin'], { cwd: wtPath, ...GIT_OPTS })
          remoteUrl = stdout.trim()
          const beforeRemote = this.requestState.getStore()?.options.beforeRemoteRequest
          if (this.limits() && !beforeRemote) throw new Error('WORKTREE_REMOTE_SCOPE_UNAVAILABLE')
          if (beforeRemote) { await this.ownRaw(Promise.resolve(beforeRemote(repo.fullName, remoteUrl))); this.assertRequestCurrent() }
          const url = remoteUrl.toLowerCase()
          if (url.includes('gitlab')) provider = 'gitlab'
          else if (url.includes('github')) provider = 'github'
          else if (this.forgejoManager && await this.forgejoManager.isForgejoUrl(remoteUrl)) provider = 'forgejo'
        } catch (error) { this.fallback(error); provider = 'other' /* ignore */ }

        try {
          if (provider === 'github') {
            const { stdout } = await this.execOwned(
              'gh', ['pr', 'view', '--json', 'number,url,state,title,statusCheckRollup'],
              { cwd: wtPath, timeout: 8000, ...GIT_OPTS }
            )
            const j = JSON.parse(stdout) as {
              number?: number; url?: string; state?: string; title?: string
              statusCheckRollup?: Array<{ status?: string; conclusion?: string; state?: string }>
            }
            prNumber = j.number; prUrl = j.url; prState = j.state; prTitle = j.title
            // Aggregate all check runs / status contexts into a single rollup.
            const items = j.statusCheckRollup
            if (!items || items.length === 0) {
              ciStatus = 'none'
            } else {
              let pending = false
              let failing = false
              for (const it of items) {
                if (it.status && it.status !== 'COMPLETED') { pending = true; continue }
                const s = (it.conclusion || it.state || '').toUpperCase()
                if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s)) failing = true
                else if (['PENDING', 'EXPECTED', 'REQUESTED', 'WAITING', 'QUEUED', 'IN_PROGRESS'].includes(s)) pending = true
              }
              ciStatus = failing ? 'failing' : pending ? 'pending' : 'passing'
            }
          } else if (provider === 'gitlab') {
            const { stdout } = await this.execOwned('glab', ['mr', 'list', '--source-branch', branch, '--output', 'json'], { cwd: wtPath, timeout: 8000, ...GIT_OPTS })
            const arr = JSON.parse(stdout) as Array<{ iid?: number; web_url?: string; state?: string; title?: string }>
            if (Array.isArray(arr) && arr[0]) { prNumber = arr[0].iid; prUrl = arr[0].web_url; prState = arr[0].state; prTitle = arr[0].title }
          } else if (provider === 'forgejo' && this.forgejoManager) {
            const pr = await this.forgejoManager.getBranchPullRequest(remoteUrl, branch)
            if (pr) { prNumber = pr.number; prUrl = pr.url; prState = pr.state; prTitle = pr.title; ciStatus = pr.ciStatus }
          }
        } catch (error) { this.fallback(error) /* no PR/MR, or CLI unavailable */ }
      }
      // A resolved PR implies the branch is pushed, even if the local
      // origin/<branch> tracking ref is missing/stale.
      pushed = pushed || Boolean(prUrl)

      console.log(`[WorktreeManager] getTaskChanges ${repo.fullName}: branch=${branch ?? '(detached)'} pushed=${pushed} pr=${prNumber ?? 'none'} ci=${ciStatus ?? 'n/a'}`)

      if (this.limits() && Buffer.byteLength(tracked) + Buffer.byteLength(untracked) > this.limits()!.diffBytes) throw new Error('WORKTREE_OUTPUT_LIMIT')
      return { repo: repo.fullName, diff: tracked + untracked, allFiles, branch, pushed, prNumber, prUrl, prState, prTitle, ciStatus }
    } catch (e) {
      this.fallback(e)
      return { repo: repo.fullName, diff: '', error: this.limits() ? 'The worktree operation could not be completed.' : (e as Error).message }
    }
  }

  /** New-file patches for untracked files, in `git ls-files` order. Read-only:
   * never mutates the index. Enumeration failures yield an empty patch. */
  private async untrackedFilesPatch(wtPath: string): Promise<string> {
    let files: string[]
    try {
      const { stdout } = await this.execOwned(
        'git', ['ls-files', '--others', '--exclude-standard', '-z'],
        { cwd: wtPath, ...GIT_OPTS }
      )
      files = stdout.split('\0').filter(Boolean)
      if (this.limits() && files.length > this.limits()!.files) throw new Error('WORKTREE_FILES_LIMIT')
    } catch (error) {
      this.fallback(error)
      return ''
    }
    const patches = await mapWithConcurrency(files, UNTRACKED_DIFF_CONCURRENCY, async (file) => {
      try {
        const result = await this.execOwned(
          'git', ['diff', '--no-color', ...(this.limits() ? ['--no-ext-diff', '--no-textconv'] : []), '--no-index', '--', '/dev/null', file],
          { cwd: wtPath, ...GIT_OPTS, ...(this.limits() && this.host.exec ? { allowDiffExitOne: true as const } : {}) }
        )
        return this.limits() && this.host.exec ? result.stdout : ''
      } catch (e) {
        this.fallback(e)
        // --no-index exits 1 when files differ; the patch is on stdout.
        return (e as { stdout?: string }).stdout ?? ''
      }
    })
    if (this.limits() && patches.reduce((bytes, patch) => bytes + Buffer.byteLength(patch), 0) > this.limits()!.diffBytes) throw new Error('WORKTREE_OUTPUT_LIMIT')
    return patches.join('')
  }

  /** Fast inventory used to render All files before the more expensive diff,
   * branch, pull-request, and CI discovery completes. */
  async getTaskFiles(taskId: string, repos: { fullName: string }[]): Promise<TaskFileInventoryResult[]> {
    return this.runOwned(() => this.performGetTaskFiles(taskId, repos))
  }

  private async performGetTaskFiles(taskId: string, repos: { fullName: string }[]): Promise<TaskFileInventoryResult[]> {
    const [workspaceFiles, results] = await Promise.all([
      this.ownRaw(this.listNonRepositoryWorkspaceFiles(taskId, repos)),
      Promise.all(repos.map((repo) => this.ownRaw((async (): Promise<TaskFileInventoryResult> => {
        const repoName = repo.fullName.split('/').pop() || repo.fullName
        const wtPath = this.worktreePath(taskId, repoName)
        if (!existsSync(wtPath)) return { repo: repo.fullName, allFiles: [], noWorktree: true, path: wtPath }
        try {
          return { repo: repo.fullName, allFiles: await this.listRepositoryFiles(wtPath) }
        } catch (error) {
          this.fallback(error)
          return { repo: repo.fullName, allFiles: [], error: this.limits() ? 'The worktree operation could not be completed.' : error instanceof Error ? error.message : String(error) }
        }
      })())))
    ])
    return [{ repo: 'Task workspace', allFiles: workspaceFiles, workspace: true }, ...results]
  }

  private async listRepositoryFiles(wtPath: string): Promise<string[]> {
    try {
      const { stdout } = await this.execOwned(
        'git', ['-c', 'core.quotepath=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { cwd: wtPath, ...GIT_OPTS }
      )
      const entries = stdout.split('\0').filter(Boolean)
      if (this.limits() && entries.length > this.limits()!.files) throw new Error('WORKTREE_FILES_LIMIT')
      return [...new Set(entries)].sort((left, right) => left.localeCompare(right))
    } catch (error) {
      this.fallback(error)
      if (this.limits()) throw error
      return []
    }
  }

  private async listNonRepositoryWorkspaceFiles(taskId: string, repos: { fullName: string }[]): Promise<string[]> {
    const workspacePath = this.taskDirectory(taskId)
    if (!existsSync(workspacePath)) return []

    const repositoryDirectories = new Set(repos.map((repo) => repo.fullName.split('/').pop() || repo.fullName))
    const files: string[] = []

    const visit = async (directory: string, relativeDirectory = ''): Promise<void> => {
      let entries
      try {
        this.directory(directory)
        if (this.limits()) {
          if (relativeDirectory.split('/').filter(Boolean).length > this.limits()!.depth) throw new Error('WORKTREE_DEPTH_LIMIT')
          const handle = await this.ownRaw(opendir(directory)); this.directories.add(handle)
          entries = []
          try {
            this.directory(directory)
            for (;;) {
              this.assertRequestCurrent(); const entry = await this.ownRaw(handle.read()); this.directory(directory)
              if (!entry) break
              const state = this.requestState.getStore()
              if (state) { if (++state.budget.entries > this.limits()!.entries) throw new Error('WORKTREE_SCAN_LIMIT') }
              else if (entries.length >= this.limits()!.entries) throw new Error('WORKTREE_SCAN_LIMIT')
              entries.push(entry)
            }
          } finally {
            try { await this.ownRaw(handle.close()); this.directories.delete(handle) }
            catch (cause) { this.failedDirectories.add(handle); throw cause }
          }
        } else entries = await this.ownRaw(readdir(directory, { withFileTypes: true }))
        this.directory(directory)
      } catch (error) {
        this.fallback(error)
        if (this.limits()) throw error
        return
      }

      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        if (!relativeDirectory && repositoryDirectories.has(entry.name) && entry.isDirectory()) continue
        if (!relativeDirectory && entry.name === '.opencode') continue
        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
        if (entry.isDirectory()) await visit(join(directory, entry.name), relativePath)
        else if (entry.isFile() || entry.isSymbolicLink()) {
          if (this.limits() && files.length >= this.limits()!.files) throw new Error('WORKTREE_FILES_LIMIT')
          files.push(relativePath)
        }
      }
    }

    await visit(workspacePath)
    return files
  }
}
