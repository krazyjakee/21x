import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPortableDbFixture } from '../../test/helpers/portable-db-test-helper'
import { makeTask } from '../../test/helpers/task-fixtures'
import type { WorktreeManager } from './worktree-manager'
import { pruneStaleNodeModules } from './workspace-node-modules-gc'
import { WorkspaceCleanupSchedulerCore, type WorkspaceCleanupOperations } from './workspace-cleanup-scheduler-core'

describe('workspace cleanup raw work ownership', () => {
  let source: ReturnType<typeof createPortableDbFixture>
  let root: string
  const owners: WorkspaceCleanupSchedulerCore[] = []
  beforeEach(() => {
    source = createPortableDbFixture()
    root = mkdtempSync(join(tmpdir(), '21x-cleanup-owner-'))
    source.db.setSetting('workspace_nodemodules_gc_enabled', 'false')
  })
  afterEach(async () => {
    for (const owner of owners.splice(0)) await owner.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
    source.rawDb.close()
    rmSync(root, { recursive: true, force: true })
  })
  function held() {
    let finish!: () => void
    const promise = new Promise<void>(resolve => { finish = resolve })
    return { promise, finish }
  }
  function fixture() {
    const worktrees = { cleanupTaskWorkspace: vi.fn().mockResolvedValue(undefined) }
    const operations = {
      terminateProcesses: vi.fn().mockResolvedValue([]),
      findLiveProcesses: vi.fn<WorkspaceCleanupOperations['findLiveProcesses']>().mockResolvedValue(new Set<string>()),
      pruneNodeModules: vi.fn<WorkspaceCleanupOperations['pruneNodeModules']>().mockReturnValue({ pruned: [], errors: [] })
    }
    const host = {
      workspacesRoot: root,
      listWorkspaceDirs: vi.fn<() => string[] | null>(() => readdirSync(root)),
      emit: vi.fn()
    }
    const owner = new WorkspaceCleanupSchedulerCore(source.db, worktrees as unknown as WorktreeManager, host, operations)
    owners.push(owner)
    return { owner, worktrees, operations, host }
  }
  function oldTask(repos: string[] = []) {
    const task = source.db.createTask(makeTask({ status: 'completed', repos }))!
    source.rawDb.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', task.id)
    mkdirSync(join(root, task.id))
    return task
  }

  it('cancels startup and periodic timers, including replacement starts and paused starts', async () => {
    vi.useFakeTimers()
    const { owner } = fixture()
    owner.start()
    owner.start()
    expect(vi.getTimerCount()).toBe(2)
    owner.stop()
    expect(vi.getTimerCount()).toBe(0)
    owner.start()
    const sql = vi.spyOn(source.rawDb, 'prepare')
    await owner.close()
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
    expect(sql).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(() => owner.start()).toThrow('WORKSPACE_CLEANUP_CLOSED')
    await expect(owner.runNow()).rejects.toThrow('WORKSPACE_CLEANUP_CLOSED')
  })

  it('retains an accepted process operation after failed close and skips directory removal', async () => {
    const task = oldTask()
    const gate = held()
    const { owner, operations, host } = fixture()
    operations.terminateProcesses.mockImplementation(() => gate.promise.then(() => []))
    const request = owner.runNow()
    try {
      await vi.waitFor(() => expect(operations.terminateProcesses).toHaveBeenCalledOnce())
      await expect(owner.close(5)).rejects.toThrow('WORKSPACE_CLEANUP_SHUTDOWN_INCOMPLETE')
      host.emit.mockClear()
      const retry = owner.close()
      gate.finish()
      await retry
      expect((await request).cleaned).toBe(0)
      expect(existsSync(join(root, task.id))).toBe(true)
      expect(host.emit).not.toHaveBeenCalled()
      expect(operations.findLiveProcesses).not.toHaveBeenCalled()
    } finally { gate.finish(); await request }
  })

  it('joins raw worktree cleanup and its late SQLite write while skipping the next workspace', async () => {
    source.db.setSetting('github_org', 'fixture-org')
    oldTask(['fixture/repo'])
    oldTask(['fixture/repo'])
    const gate = held()
    const { owner, worktrees } = fixture()
    worktrees.cleanupTaskWorkspace.mockImplementation(async () => {
      await gate.promise
      source.db.setSetting('fixture_cleanup_settled', 'true')
    })
    const request = owner.runNow()
    try {
      await vi.waitFor(() => expect(worktrees.cleanupTaskWorkspace).toHaveBeenCalledOnce())
      await expect(owner.close(5)).rejects.toThrow('WORKSPACE_CLEANUP_SHUTDOWN_INCOMPLETE')
      const retry = owner.close()
      gate.finish()
      await retry
      expect((await request).cleaned).toBe(1)
      expect(source.db.getSetting('fixture_cleanup_settled')).toBe('true')
      expect(worktrees.cleanupTaskWorkspace).toHaveBeenCalledOnce()
    } finally { gate.finish(); await request }
  })

  it('joins scheduled liveness scanning and suppresses pruning, timestamps and later SQL', async () => {
    source.db.setSetting('workspace_nodemodules_gc_enabled', 'true')
    source.db.setSetting('workspace_autocleanup_enabled', 'true')
    const gate = held()
    const { owner, operations } = fixture()
    operations.findLiveProcesses.mockImplementation(() => gate.promise.then(() => new Set<string>()))
    vi.useFakeTimers()
    owner.start()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(operations.findLiveProcesses).toHaveBeenCalledOnce()
    expect((await owner.runNow()).errors).toEqual(['Cleanup is already in progress'])
    vi.useRealTimers()
    try {
      await expect(owner.close(5)).rejects.toThrow('WORKSPACE_CLEANUP_SHUTDOWN_INCOMPLETE')
      const sql = vi.spyOn(source.rawDb, 'prepare')
      const retry = owner.close()
      gate.finish()
      await retry
      expect(sql).not.toHaveBeenCalled()
      expect(operations.pruneNodeModules).not.toHaveBeenCalled()
    } finally { gate.finish(); await owner.close() }
  })

  it('cancels a queued manual pass before any database or filesystem operation', async () => {
    const { owner, operations, host } = fixture()
    const sql = vi.spyOn(source.rawDb, 'prepare')
    const request = owner.runNow()
    owner.shutdown()
    await owner.close()
    expect((await request).cleaned).toBe(0)
    expect(sql).not.toHaveBeenCalled()
    expect(host.listWorkspaceDirs).not.toHaveBeenCalled()
    expect(operations.terminateProcesses).not.toHaveBeenCalled()
  })

  it('does not reinterpret an unreadable workspace root as an empty liveness scan', async () => {
    source.db.setSetting('workspace_nodemodules_gc_enabled', 'true')
    const { owner, operations, host } = fixture()
    host.listWorkspaceDirs.mockReturnValue(null)
    const result = await owner.runNow()
    expect(result.errors).toContain('Could not list workspaces directory; pruning skipped')
    expect(operations.findLiveProcesses).not.toHaveBeenCalled()
    expect(operations.pruneNodeModules).not.toHaveBeenCalled()
  })

  it('preserves active workspaces when liveness is unavailable and prunes only idle fixture dependencies', async () => {
    source.db.setSetting('workspace_nodemodules_gc_enabled', 'true')
    const active = source.db.createTask(makeTask({ status: 'agent_working' }))!
    const idle = source.db.createTask(makeTask({ status: 'ready_for_review' }))!
    for (const task of [active, idle]) {
      const deps = join(root, task.id, 'repo', 'node_modules')
      mkdirSync(deps, { recursive: true })
      utimesSync(deps, new Date('2020-01-01'), new Date('2020-01-01'))
    }
    const { owner, operations } = fixture()
    operations.findLiveProcesses.mockResolvedValue(null)
    operations.pruneNodeModules.mockImplementation(pruneStaleNodeModules)
    const result = await owner.runNow()
    expect(result.nodeModulesCleaned).toBe(1)
    expect(existsSync(join(root, active.id, 'repo', 'node_modules'))).toBe(true)
    expect(existsSync(join(root, idle.id, 'repo', 'node_modules'))).toBe(false)
    expect(existsSync(join(root, idle.id, 'repo'))).toBe(true)
  })

  it('validates close deadlines without closing admission and removes only owned fixture directories', async () => {
    const task = oldTask()
    const { owner, operations } = fixture()
    await expect(owner.close(0)).rejects.toBeInstanceOf(RangeError)
    expect((await owner.runNow()).cleaned).toBe(1)
    expect(operations.terminateProcesses).toHaveBeenCalledWith({ workspacesRoot: root, workspaceIds: [task.id] })
    expect(existsSync(join(root, task.id))).toBe(false)
  })
})
