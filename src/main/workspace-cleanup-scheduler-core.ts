import { existsSync, readdirSync, statSync, rmSync, lstatSync, realpathSync, opendirSync, type Dir, type BigIntStats } from 'fs'
import { isAbsolute, join } from 'path'
import type { DatabaseManager } from './database'
import type { WorktreeManager } from './worktree-manager'
import { TaskStatus } from '../shared/constants'
import { terminateProcessesInWorkspaces, readDiskSpace, workspacePressureWarning } from './workspace-process-cleanup'
import {
  NODE_MODULES_GC_DAYS_KEY,
  NODE_MODULES_GC_ENABLED_KEY,
  NODE_MODULES_GC_LAST_RUN_KEY,
  DEFAULT_NODE_MODULES_GC_DAYS,
  activeStatusWorkspaceIds,
  findWorkspacesWithLiveProcesses,
  pruneStaleNodeModules
} from './workspace-node-modules-gc'

/** Combined outcome of a cleanup run: whole workspaces plus pruned dependency dirs. */
export interface CleanupResult {
  cleaned: number
  errors: string[]
  nodeModulesCleaned: number
}

/**
 * WorkspaceCleanupScheduler - Automatic cleanup of old completed task workspaces
 *
 * Runs once daily (every 24 hours). On each tick:
 * 1. Checks if auto-cleanup is enabled via settings
 * 2. Queries completed tasks where `updated_at` is older than the configured retention period
 * 3. Cleans up worktrees and workspace directories for those tasks
 * 4. Also removes orphaned workspace directories (no matching task in DB)
 * 5. Prunes idle `node_modules` directories at any depth, for tasks in ANY status
 *    (own enable flag + retention, on by default — deps reinstall from package.json)
 *
 * Settings:
 * - `workspace_autocleanup_enabled` — "true"/"false" (default: "false")
 * - `workspace_autocleanup_days` — number of days after completion (default: 7)
 * - `workspace_nodemodules_gc_enabled` — "true"/"false" (default: "true")
 * - `workspace_nodemodules_gc_days` — days of node_modules inactivity before pruning (default: 7)
 */
export interface WorkspaceCleanupHost {
  workspacesRoot: string
  listWorkspaceDirs(): string[] | null
  emit?(channel: 'workspace:cleanup-progress' | 'workspace:cleanup-complete', data: unknown): void
  /** Captured native/service policy; scheduled passes cannot fall back to the
   * legacy ambient process observer when this explicit policy is selected. */
  portablePolicy?: WorkspaceCleanupRequestControls
}

export interface WorkspaceCleanupRequestControls {
  beforeEffect(): void
  signal?: AbortSignal
  store: Pick<DatabaseManager, 'getTasks' | 'getSetting'>
  assertIdleWorkspace?(taskId: string, absolutePath: string): Promise<void>
  getRepoGroups?(taskId: string): ReadonlyArray<{ org: string; repos: { fullName: string }[] }>
  runMutation?<T>(taskIds: string[], effect: () => Promise<T>): Promise<T>
}

/** Actual SQL scalar reader for trusted portable cleanup policy. No unrelated
 * task JSON, credentials, process tools or filesystem effects are loaded. */
export function createBoundedWorkspaceCleanupStore(db: DatabaseManager, beforeEffect: () => void): Pick<DatabaseManager, 'getTasks' | 'getSetting'> {
  return Object.freeze({
    getSetting(key: string): string | undefined {
      beforeEffect()
      const stats = db.db.prepare('SELECT typeof(value) AS type,length(CAST(value AS BLOB)) AS bytes FROM settings WHERE key=?').get(key) as { type: string; bytes: number } | undefined
      if (!stats) return undefined
      if (stats.type !== 'text' || stats.bytes > 4096) throw new Error('WORKSPACE_CLEANUP_DATA_LIMIT')
      return (db.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string }).value
    },
    getTasks(): ReturnType<DatabaseManager['getTasks']> {
      beforeEffect()
      const fields = { id: 128, title: 1024, project_id: 128, role: 32, group_id: 128, agent_id: 128, source_id: 128, status: 64, repos: 65536, updated_at: 64 }
      const sizes = Object.entries(fields).map(([field, max]) => ({ length: `COALESCE(length(CAST(${field} AS BLOB)),0)`, max }))
      const stats = db.db.prepare(`SELECT COUNT(*) AS count,COALESCE(MAX(${sizes.map(value => `(${value.length}>${value.max})`).join(' OR ')}),0) AS oversized,COALESCE(SUM(${sizes.map(value => value.length).join('+')}),0) AS total FROM tasks`).get() as { count: number; oversized: number; total: number }
      if (stats.count > 4096 || stats.oversized || stats.total >= 890000) throw new Error('WORKSPACE_CLEANUP_DATA_LIMIT')
      return (db.db.prepare('SELECT id,title,project_id,role,group_id,agent_id,source_id,status,repos,updated_at FROM tasks ORDER BY id').all() as Array<Record<string, unknown>>).map(row => {
        let repos: unknown
        try { repos = JSON.parse(row.repos as string) } catch { throw new Error('WORKSPACE_CLEANUP_DATA_INVALID') }
        if (typeof row.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.id) || !Array.isArray(repos) || repos.length > 128 || repos.some(value => typeof value !== 'string' || Buffer.byteLength(value) > 512) || typeof row.title !== 'string' || Buffer.byteLength(row.title) > 1024 || typeof row.updated_at !== 'string' || Buffer.byteLength(row.updated_at) > 64 || !['task','captain','task_group'].includes(row.role as string)) throw new Error('WORKSPACE_CLEANUP_DATA_INVALID')
        return { ...row, repos } as unknown as ReturnType<DatabaseManager['getTasks']>[number]
      })
    }
  })
}

export interface WorkspaceCleanupOperations {
  terminateProcesses: typeof terminateProcessesInWorkspaces
  findLiveProcesses: typeof findWorkspacesWithLiveProcesses
  pruneNodeModules: typeof pruneStaleNodeModules
}

export class WorkspaceCleanupSchedulerCore {
  private dbManager: DatabaseManager
  private worktreeManager: WorktreeManager
  private intervalId: NodeJS.Timeout | null = null
  private startupTimer: NodeJS.Timeout | null = null
  private closing = false
  private activeRun: Promise<unknown> | null = null
  private isRunning = false
  private readonly portablePolicy?: WorkspaceCleanupRequestControls
  private readonly directories = new Set<Dir>()

  /** Check every hour, but only actually clean once per day */
  private readonly CHECK_INTERVAL = 60 * 60 * 1000 // 1 hour
  private readonly DEFAULT_RETENTION_DAYS = 7

  constructor(
    dbManager: DatabaseManager,
    worktreeManager: WorktreeManager,
    private readonly host: WorkspaceCleanupHost,
    private readonly operations: WorkspaceCleanupOperations = {
      terminateProcesses: terminateProcessesInWorkspaces,
      findLiveProcesses: findWorkspacesWithLiveProcesses,
      pruneNodeModules: pruneStaleNodeModules
    }
  ) {
    this.dbManager = dbManager
    this.worktreeManager = worktreeManager
    this.portablePolicy = host.portablePolicy ? this.captureControls(host.portablePolicy) : undefined
  }

  private captureControls(controls: WorkspaceCleanupRequestControls): WorkspaceCleanupRequestControls {
    if (!controls || typeof controls.beforeEffect !== 'function' || !controls.store || typeof controls.store.getTasks !== 'function' || typeof controls.store.getSetting !== 'function') throw new Error('WORKSPACE_CLEANUP_POLICY_INVALID')
    return Object.freeze({ ...controls, store: Object.freeze({ getTasks: controls.store.getTasks.bind(controls.store), getSetting: controls.store.getSetting.bind(controls.store) }) })
  }

  assertOwners(db: DatabaseManager, worktrees: WorktreeManager, workspaceRoot: string): void {
    if (this.closing || this.dbManager !== db || this.worktreeManager !== worktrees || this.host.workspacesRoot !== workspaceRoot) throw new Error('WORKSPACE_CLEANUP_OWNER_MISMATCH')
  }

  start(): void {
    if (this.closing) throw new Error('WORKSPACE_CLEANUP_CLOSED')
    this.stop()
    console.log('[WorkspaceCleanup] Starting scheduler...')

    // Delayed so the first run does not slow down app launch.
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      void this.runCleanup()
    }, 2 * 60 * 1000)

    this.intervalId = setInterval(() => {
      void this.runCleanup()
    }, this.CHECK_INTERVAL)
  }

  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      console.log('[WorkspaceCleanup] Scheduler stopped')
    }
  }

  shutdown(): void {
    this.closing = true
    this.stop()
  }

  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) {
      throw new RangeError('Workspace cleanup shutdown deadline must be an integer from 1 to 3000 ms')
    }
    this.shutdown()
    if (!this.activeRun) {
      for (const directory of [...this.directories]) { directory.closeSync(); this.directories.delete(directory) }
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('WORKSPACE_CLEANUP_SHUTDOWN_INCOMPLETE')), timeoutMs)
    })
    try {
      await Promise.race([this.activeRun.then(() => {}, () => {}), expired])
      for (const directory of [...this.directories]) { directory.closeSync(); this.directories.delete(directory) }
    }
    finally { if (timer) clearTimeout(timer) }
  }

  private own<T>(operation: () => Promise<T>): Promise<T> {
    this.isRunning = true
    const work = Promise.resolve().then(operation)
    this.activeRun = work
    void work.finally(() => {
      if (this.activeRun === work) { this.activeRun = null; this.isRunning = false }
    }).catch(() => {})
    return work
  }

  /**
   * Manually trigger a cleanup run. Returns the number of workspaces cleaned
   * plus the number of idle node_modules directories pruned.
   * Rejects if a cleanup is already in progress (prevents concurrent runs).
   */
  async runNow(controls?: WorkspaceCleanupRequestControls): Promise<CleanupResult> {
    if (this.closing) throw new Error('WORKSPACE_CLEANUP_CLOSED')
    if (this.directories.size) throw new Error('WORKSPACE_CLEANUP_DIRECTORY_CLOSE_UNACKNOWLEDGED')
    if (this.isRunning) {
      return { cleaned: 0, errors: ['Cleanup is already in progress'], nodeModulesCleaned: 0 }
    }
    const selected = controls ? this.captureControls({ ...this.portablePolicy, ...controls, assertIdleWorkspace: controls.assertIdleWorkspace ?? this.portablePolicy?.assertIdleWorkspace }) : this.portablePolicy
    return this.own(() => selected ? this.executePortable(selected) : this.executeManual())
  }

  private async executeManual(): Promise<CleanupResult> {
    if (this.closing) return { cleaned: 0, errors: [], nodeModulesCleaned: 0 }
    this.sendToRenderer('workspace:cleanup-progress', { phase: 'starting', current: 0, total: 0 })
    const result = await this.doCleanup(true)
    const nm = this.closing ? { pruned: 0, errors: [] } : await this.runNodeModulesPhase(true)
    const combined: CleanupResult = {
      cleaned: result.cleaned,
      errors: [...result.errors, ...nm.errors],
      nodeModulesCleaned: nm.pruned
    }
    this.sendToRenderer('workspace:cleanup-progress', {
      phase: 'done', current: combined.cleaned, total: combined.cleaned,
      cleaned: combined.cleaned, nodeModulesCleaned: combined.nodeModulesCleaned, errors: combined.errors
    })
    return combined
  }

  // ── Core Logic ──────────────────────────────────────────────

  private runCleanup(): Promise<void> {
    if (this.closing || this.isRunning) return Promise.resolve()
    return this.own(() => this.executeScheduled())
  }

  private async executeScheduled(): Promise<void> {
    if (this.closing) return
    if (this.portablePolicy) {
      // The captured portable planner is the only scheduled path. It cannot
      // retry through ambient process scans after a refused owned pass.
      try {
        this.portablePolicy.beforeEffect()
        const whole = this.portablePolicy.store.getSetting('workspace_autocleanup_enabled') === 'true'
        const deps = this.portablePolicy.store.getSetting(NODE_MODULES_GC_ENABLED_KEY) !== 'false'
        if (!whole && !deps) return
        await this.executePortable(this.portablePolicy, whole)
      } catch { /* explicit unavailable/cancelled work is retained by activeRun */ }
      return
    }
    try {
      // Idle node_modules pruning has its own flag and schedule: it is safe for
      // every task status (only regenerable deps go), so it runs whether or not
      // whole-workspace auto-cleanup is enabled.
      await this.runNodeModulesGcAuto()
      if (this.closing) return

      const enabled = this.dbManager.getSetting('workspace_autocleanup_enabled')
      if (enabled !== 'true') {
        // Auto-cleanup defaults to OFF, and that is exactly the machine where
        // the count grows without bound — 397 workspaces holding 313 GB on the
        // one this was found on. Reporting it only inside `doCleanup` would
        // mean the warning never reached the person who needs it.
        this.reportWorkspaceCount()
        return
      }

      const lastRun = this.dbManager.getSetting('workspace_autocleanup_last_run')
      if (lastRun) {
        const lastRunDate = new Date(lastRun)
        const now = new Date()
        const hoursSinceLastRun = (now.getTime() - lastRunDate.getTime()) / (1000 * 60 * 60)
        if (hoursSinceLastRun < 23) return // Run at most once per day
      }

      const result = await this.doCleanup(false)
      if (this.closing) return

      this.dbManager.setSetting('workspace_autocleanup_last_run', new Date().toISOString())

      if (result.cleaned > 0) {
        console.log(`[WorkspaceCleanup] Cleaned ${result.cleaned} workspace(s)`)
        this.sendToRenderer('workspace:cleanup-complete', {
          cleaned: result.cleaned,
          errors: result.errors
        })
      }
    } catch (err) {
      console.error('[WorkspaceCleanup] Error in runCleanup:', err)
    }
  }

  private async executePortable(controls: WorkspaceCleanupRequestControls, removeCompleted = true): Promise<CleanupResult> {
    let active = true
    const current = (): void => {
      if (!active) throw new Error('WORKSPACE_CLEANUP_REQUEST_EXPIRED')
      if (this.closing || controls.signal?.aborted) throw new Error('WORKSPACE_CLEANUP_CANCELLED')
      this.portablePolicy?.beforeEffect(); controls.beforeEffect()
    }
    const root = this.host.workspacesRoot
    const same = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && b.isDirectory() && !b.isSymbolicLink()
    const physical = (path: string): BigIntStats => { current(); const info = lstatSync(path, { bigint: true }); if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) throw new Error('WORKSPACE_CLEANUP_PATH_REFUSED'); return info }
    const scan = (path: string): Array<{ name: string; directory: boolean }> => {
      const before = physical(path), handle = opendirSync(path); this.directories.add(handle); const entries: Array<{ name: string; directory: boolean }> = []
      try {
        for (;;) { current(); const entry = handle.readSync(); if (!entry) break; if (++scanned > 8192 || Buffer.byteLength(join(path, entry.name)) > 4096) throw new Error('WORKSPACE_CLEANUP_SCAN_LIMIT'); entries.push({ name: entry.name, directory: entry.isDirectory() && !entry.isSymbolicLink() }) }
      } finally { handle.closeSync(); this.directories.delete(handle) }
      if (!same(before, physical(path))) throw new Error('WORKSPACE_CLEANUP_PATH_CHANGED')
      return entries
    }
    let scanned = 0
    try {
      current()
      if (!isAbsolute(root) || realpathSync(root) !== root) throw new Error('WORKSPACE_CLEANUP_PATH_REFUSED')
      const rootIdentity = physical(root), allTasks = controls.store.getTasks({ includeCoordinators: true })
      if (allTasks.length > 4096) throw new Error('WORKSPACE_CLEANUP_DATA_LIMIT')
      const tasks = new Map(allTasks.map(task => [task.id, task])), snapshot = JSON.stringify(allTasks)
      const rawDays = controls.store.getSetting('workspace_autocleanup_days'), parsedDays = Number.parseInt(rawDays ?? '', 10), days = Number.isFinite(parsedDays) && parsedDays >= 1 ? parsedDays : this.DEFAULT_RETENTION_DAYS
      const cutoff = Date.now() - days * 86400000, selected: Array<{ task: typeof allTasks[number]; path: string; identity: BigIntStats }> = []
      const rawDepsEnabled = controls.store.getSetting(NODE_MODULES_GC_ENABLED_KEY), rawDepsDays = controls.store.getSetting(NODE_MODULES_GC_DAYS_KEY), depsEnabled = rawDepsEnabled !== 'false', depsDays = Number.parseInt(rawDepsDays ?? '', 10) || DEFAULT_NODE_MODULES_GC_DAYS
      const checkSnapshot = (): void => { current(); if (JSON.stringify(controls.store.getTasks({ includeCoordinators: true })) !== snapshot || controls.store.getSetting('workspace_autocleanup_days') !== rawDays || controls.store.getSetting(NODE_MODULES_GC_ENABLED_KEY) !== rawDepsEnabled || controls.store.getSetting(NODE_MODULES_GC_DAYS_KEY) !== rawDepsDays || !same(rootIdentity, physical(root))) throw new Error('WORKSPACE_CLEANUP_SCOPE_CHANGED') }
      const findUnsupportedDeps = (path: string, depth = 0): void => {
        if (depth > 64) throw new Error('WORKSPACE_CLEANUP_SCAN_LIMIT')
        for (const entry of scan(path)) {
          if (!entry.directory || entry.name === '.git') continue
          const child = join(path, entry.name)
          if (entry.name === 'node_modules') { if (physical(child).mtimeMs < Date.now() - Math.max(1, depsDays) * 86400000) throw new Error('WORKSPACE_CLEANUP_NODE_MODULES_UNAVAILABLE'); continue }
          findUnsupportedDeps(child, depth + 1)
        }
      }
      for (const entry of scan(root)) {
        if (!entry.directory) continue
        const path = join(root, entry.name), identity = physical(path), task = tasks.get(entry.name)
        if (!task) { if (identity.mtimeMs < cutoff) throw new Error('WORKSPACE_CLEANUP_ORPHAN_REFUSED'); continue }
        if (depsEnabled) findUnsupportedDeps(path)
        if (!removeCompleted || task.status !== TaskStatus.Completed || new Date(task.updated_at).getTime() >= cutoff) continue
        if (task.role !== 'task' || task.group_id || !/^[A-Za-z0-9_-]{1,128}$/.test(task.id)) throw new Error('WORKSPACE_CLEANUP_SCOPE_UNSUPPORTED')
        selected.push({ task, path, identity })
      }
      checkSnapshot()
      if (selected.length > 128) throw new Error('WORKSPACE_CLEANUP_DATA_LIMIT')
      if (!selected.length) return { cleaned: 0, errors: [], nodeModulesCleaned: 0 }
      if (!controls.assertIdleWorkspace || !controls.runMutation) throw new Error('WORKSPACE_CLEANUP_PROCESS_AUTHORITY_UNAVAILABLE')
      const assertIdle = controls.assertIdleWorkspace
      return await controls.runMutation(selected.map(value => value.task.id), async () => {
        checkSnapshot()
        // Validate ALL accepted process observations before the first removal.
        for (const value of selected) { await assertIdle(value.task.id, value.path); checkSnapshot(); if (!same(value.identity, physical(value.path))) throw new Error('WORKSPACE_CLEANUP_PATH_CHANGED') }
        this.sendToRenderer('workspace:cleanup-progress', { phase: 'starting', current: 0, total: selected.length })
        let cleaned = 0
        for (const value of selected) {
          checkSnapshot(); if (!same(value.identity, physical(value.path))) throw new Error('WORKSPACE_CLEANUP_PATH_CHANGED')
          const groups = controls.getRepoGroups?.(value.task.id) ?? []
          if (value.task.repos.length && !groups.length) throw new Error('WORKSPACE_CLEANUP_REPOSITORY_AUTHORITY_UNAVAILABLE')
          await this.worktreeManager.withRequestGuard(async () => {
            for (const group of groups) { checkSnapshot(); await this.worktreeManager.cleanupTaskWorkspace(value.task.id, group.repos, group.org, false) }
            checkSnapshot(); await this.worktreeManager.cleanupTaskWorkspace(value.task.id, [], '', true)
          }, checkSnapshot, controls.signal)
          checkSnapshot(); if (existsSync(value.path)) throw new Error('WORKSPACE_CLEANUP_REMOVE_UNACKNOWLEDGED'); cleaned++
        }
        this.sendToRenderer('workspace:cleanup-progress', { phase: 'done', current: cleaned, total: selected.length, cleaned, nodeModulesCleaned: 0, errors: [] })
        return { cleaned, errors: [], nodeModulesCleaned: 0 }
      })
    } finally { active = false }
  }

  private async doCleanup(reportProgress: boolean): Promise<{ cleaned: number; errors: string[] }> {
    const retentionDays = this.getRetentionDays()
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    const org = this.dbManager.getSetting('github_org') || ''

    let cleaned = 0
    const errors: string[] = []

    // Phase 1: Clean workspaces for completed tasks past retention
    const allTasks = this.dbManager.getTasks({ includeCoordinators: true })
    const completedTasks = allTasks.filter(
      (t) =>
        t.status === TaskStatus.Completed &&
        new Date(t.updated_at) < cutoffDate
    )

    const eligibleTasks = completedTasks.filter((t) =>
      existsSync(join(this.host.workspacesRoot, t.id))
    )

    let orphanDirs: string[] = []
    try {
      if (existsSync(this.host.workspacesRoot)) {
        const taskIds = new Set(allTasks.map((t) => t.id))
        const dirs = readdirSync(this.host.workspacesRoot, { withFileTypes: true })
        orphanDirs = dirs
          .filter((d) => d.isDirectory() && !taskIds.has(d.name))
          .map((d) => d.name)
          .filter((name) => {
            try {
              return statSync(join(this.host.workspacesRoot, name)).mtime < cutoffDate
            } catch {
              return false
            }
          })
      }
    } catch {
      // ignore scan errors for counting
    }

    const total = eligibleTasks.length + orphanDirs.length
    let processed = 0

    // A process must not outlive its workspace. Removing the directory under a
    // running watcher leaves it holding several thousand descriptors on files
    // that no longer exist — the exact leak this cleanup is supposed to end.
    // Killed BEFORE any removal, and by cwd only, so a watcher the user started
    // in their own checkout is never a candidate.
    if (total > 0) {
      try {
        const killed = await this.operations.terminateProcesses({
          workspacesRoot: this.host.workspacesRoot,
          workspaceIds: [...eligibleTasks.map((t) => t.id), ...orphanDirs]
        })
        if (killed.length > 0) {
          console.log(`[WorkspaceCleanup] Terminated ${killed.length} process(es) rooted in workspaces being removed`)
        }
      } catch (err) {
        const message = `Failed to terminate processes in workspaces being removed: ${err instanceof Error ? err.message : String(err)}`
        console.warn(`[WorkspaceCleanup] ${message}`)
        errors.push(message)
      }
    }

    if (this.closing) return { cleaned, errors }
    if (reportProgress) {
      this.sendToRenderer('workspace:cleanup-progress', {
        phase: 'scanning',
        current: 0,
        total,
        message: `Found ${total} workspace${total !== 1 ? 's' : ''} to clean`
      })
    }

    for (const task of eligibleTasks) {
      if (this.closing) break
      const taskDir = join(this.host.workspacesRoot, task.id)

      if (reportProgress) {
        this.sendToRenderer('workspace:cleanup-progress', {
          phase: 'cleaning',
          current: processed,
          total,
          message: `Cleaning "${task.title}"...`
        })
      }

      try {
        if (task.repos.length > 0 && org) {
          await this.worktreeManager.cleanupTaskWorkspace(
            task.id,
            task.repos.map((r) => ({ fullName: r })),
            org,
            true
          )
        } else {
          // No repos — just remove the workspace directory
          rmSync(taskDir, { recursive: true, force: true })
        }
        cleaned++
        console.log(`[WorkspaceCleanup] Cleaned workspace for completed task "${task.title}" (${task.id})`)
      } catch (err) {
        const message = `Failed to clean workspace for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`
        console.error(`[WorkspaceCleanup] ${message}`)
        errors.push(message)
      }
      processed++
    }

    // Phase 2: Clean orphaned workspace directories (no matching task in DB)
    for (const name of orphanDirs) {
      if (this.closing) break
      const dirPath = join(this.host.workspacesRoot, name)

      if (reportProgress) {
        this.sendToRenderer('workspace:cleanup-progress', {
          phase: 'cleaning',
          current: processed,
          total,
          message: `Cleaning orphaned workspace ${name.substring(0, 12)}...`
        })
      }

      try {
        rmSync(dirPath, { recursive: true, force: true })
        cleaned++
        console.log(`[WorkspaceCleanup] Cleaned orphaned workspace directory: ${name}`)
      } catch (err) {
        const message = `Failed to clean orphaned directory ${name}: ${err instanceof Error ? err.message : String(err)}`
        console.error(`[WorkspaceCleanup] ${message}`)
        errors.push(message)
      }
      processed++
    }

    this.reportWorkspaceCount()

    return { cleaned, errors }
  }

  /**
   * Reports how many workspaces are left. Nothing bounds this count: every agent
   * run makes another clone with its own `node_modules`. On the machine the
   * process leak was diagnosed on there were 397 of them holding 313 GB, which
   * is a disk and inode problem in its own right. Counting it is the smallest
   * honest thing to do about it.
   */
  private reportWorkspaceCount(): void {
    if (this.closing) return
    const dirs = this.host.listWorkspaceDirs()
    if (dirs === null) return
    const pressure = workspacePressureWarning({ count: dirs.length, disk: readDiskSpace(this.host.workspacesRoot) })
    if (!pressure) return
    // Console only. An earlier version also sent `workspace:count-warning` to
    // the renderer, which was dead code: no preload bridge carries it and no
    // component listens, so it reached nobody while looking like it reached
    // someone. Surfacing this in the UI is a real change — a preload channel, a
    // component, and a decision about how insistent it should be — and it wants
    // to be made deliberately rather than smuggled in with a process fix.
    console.warn(`[WorkspaceCleanup] ${pressure}`)
  }

  private getRetentionDays(): number {
    const setting = this.dbManager.getSetting('workspace_autocleanup_days')
    if (setting) {
      const parsed = parseInt(setting, 10)
      if (!isNaN(parsed) && parsed >= 1) return parsed
    }
    return this.DEFAULT_RETENTION_DAYS
  }

  // ── Idle node_modules GC ──────────────────────────────

  private isNodeModulesGcEnabled(): boolean {
    const setting = this.dbManager.getSetting(NODE_MODULES_GC_ENABLED_KEY)
    if (setting === undefined || setting === null) return true
    return setting === 'true'
  }

  private getNodeModulesGcDays(): number {
    const setting = this.dbManager.getSetting(NODE_MODULES_GC_DAYS_KEY)
    if (setting) {
      const parsed = parseInt(setting, 10)
      if (!isNaN(parsed) && parsed >= 1) return parsed
    }
    return DEFAULT_NODE_MODULES_GC_DAYS
  }

  /**
   * Automatic (scheduled) node_modules pass: own enable flag, at most once per day.
   * Runs independently of whole-workspace auto-cleanup.
   */
  private async runNodeModulesGcAuto(): Promise<void> {
    if (!this.isNodeModulesGcEnabled()) return
    const lastRun = this.dbManager.getSetting(NODE_MODULES_GC_LAST_RUN_KEY)
    if (lastRun) {
      const hoursSinceLastRun = (Date.now() - new Date(lastRun).getTime()) / (1000 * 60 * 60)
      if (hoursSinceLastRun < 23) return
    }
    const nm = await this.runNodeModulesPhase(false)
    if (this.closing) return
    this.dbManager.setSetting(NODE_MODULES_GC_LAST_RUN_KEY, new Date().toISOString())
    if (nm.pruned > 0) {
      console.log(`[WorkspaceCleanup] Pruned ${nm.pruned} idle node_modules`)
    }
    if (nm.errors.length > 0) {
      console.warn(`[WorkspaceCleanup] node_modules prune errors: ${nm.errors.join('; ')}`)
    }
  }

  /**
   * One node_modules pruning pass over every workspace on disk, regardless of
   * task status. Workspaces with a live process rooted in them are skipped; when
   * liveness cannot be observed (Windows, unreadable process table), tasks in an
   * active status are skipped instead — a build lock inside node_modules must
   * never be pulled out from under a running agent.
   */
  private async runNodeModulesPhase(reportProgress: boolean): Promise<{ pruned: number; errors: string[] }> {
    if (!this.isNodeModulesGcEnabled()) return { pruned: 0, errors: [] }
    const days = this.getNodeModulesGcDays()
    const dirs = this.host.listWorkspaceDirs()
    if (dirs === null) return { pruned: 0, errors: ['Could not list workspaces directory; pruning skipped'] }
    const allTasks = this.dbManager.getTasks({ includeCoordinators: true })

    let skip = await this.operations.findLiveProcesses(this.host.workspacesRoot, dirs)
    if (this.closing) return { pruned: 0, errors: [] }
    if (skip === null) skip = activeStatusWorkspaceIds(allTasks)

    if (reportProgress) {
      this.sendToRenderer('workspace:cleanup-progress', {
        phase: 'pruning',
        current: 0,
        total: dirs.length,
        message: `Pruning idle node_modules (inactive > ${days} day${days !== 1 ? 's' : ''})...`
      })
    }

    const result = this.operations.pruneNodeModules({
      workspacesRoot: this.host.workspacesRoot,
      inactiveDays: days,
      skipWorkspaceIds: skip,
      onProgress: reportProgress
        ? (processed, total, currentPath) => {
            this.sendToRenderer('workspace:cleanup-progress', {
              phase: 'pruning',
              current: processed,
              total,
              message: currentPath ? `Pruning idle node_modules...` : `Pruned idle node_modules`
            })
          }
        : undefined
    })

    if (reportProgress) {
      this.sendToRenderer('workspace:cleanup-progress', {
        phase: 'pruning',
        current: dirs.length,
        total: dirs.length,
        message: result.pruned.length > 0
          ? `Pruned ${result.pruned.length} idle node_modules`
          : 'No idle node_modules to prune'
      })
    }

    return { pruned: result.pruned.length, errors: result.errors }
  }

  private sendToRenderer(channel: 'workspace:cleanup-progress' | 'workspace:cleanup-complete', data: unknown): void {
    if (!this.closing) this.host.emit?.(channel, data)
  }
}
