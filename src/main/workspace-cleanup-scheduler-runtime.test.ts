import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { WorktreeDirectoryAuthority } from './worktree-directory-authority'
import { WorktreeManager } from './worktree-manager-core'
import { WorkspaceCleanupSchedulerCore, createBoundedWorkspaceCleanupStore, type WorkspaceCleanupRequestControls, type WorkspaceCleanupOperations } from './workspace-cleanup-scheduler-core'

let db: ReturnType<typeof createPortableTestDb>, root: string, worktrees: WorktreeManager, owner: WorkspaceCleanupSchedulerCore
let controls: WorkspaceCleanupRequestControls, ambient: { [K in keyof WorkspaceCleanupOperations]: Mock<WorkspaceCleanupOperations[K]> }
function held() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
beforeEach(() => {
  db = createPortableTestDb(); root = mkdtempSync(join(tmpdir(), '21x-cleanup-runtime-')); const repos = join(root, 'repos'), workspaces = join(root, 'workspaces'); mkdirSync(repos); mkdirSync(workspaces)
  db.setSetting('workspace_nodemodules_gc_enabled', 'false')
  const paths = new WorktreeDirectoryAuthority([repos, workspaces], () => {})
  worktrees = new WorktreeManager({ reposRoot: repos, workspaceRoot: workspaces, emitProgress: vi.fn(), assertPath: path => paths.assertPath(path), exec: async () => ({ stdout: '', stderr: '' }) })
  controls = { beforeEffect() {}, store: createBoundedWorkspaceCleanupStore(db, () => {}) }
  ambient = { terminateProcesses: vi.fn(async () => []), findLiveProcesses: vi.fn(async () => new Set<string>()), pruneNodeModules: vi.fn(() => ({ pruned: [], errors: [] })) }
  owner = new WorkspaceCleanupSchedulerCore(db, worktrees, { workspacesRoot: workspaces, listWorkspaceDirs: () => { throw new Error('Legacy listing forbidden') }, portablePolicy: controls, emit: vi.fn() }, ambient)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => { await owner.close(); await worktrees.close(); db.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.useRealTimers() })
function oldTask() { const task = db.createTask({ title: 'Owned completed fixture' })!; db.db.prepare("UPDATE tasks SET status='completed',updated_at='2020-01-01T00:00:00Z' WHERE id=?").run(task.id); const path = join(root, 'workspaces', task.id); mkdirSync(path); writeFileSync(join(path, 'kept.txt'), 'actual owned bytes'); return { task, path } }
describe('strict portable cleanup policy', () => {
  it('returns truthful empty counts and never invokes ambient process tools', async () => {
    expect(await owner.runNow()).toEqual({ cleaned: 0, errors: [], nodeModulesCleaned: 0 })
    expect(ambient.terminateProcesses).not.toHaveBeenCalled(); expect(ambient.findLiveProcesses).not.toHaveBeenCalled(); expect(ambient.pruneNodeModules).not.toHaveBeenCalled()
  })
  it('refuses nonempty manual and automatic cleanup before effects when process authority is absent', async () => {
    const value = oldTask(); await expect(owner.runNow()).rejects.toThrow('WORKSPACE_CLEANUP_PROCESS_AUTHORITY_UNAVAILABLE')
    db.setSetting('workspace_autocleanup_enabled', 'true'); vi.useFakeTimers(); owner.start(); await vi.advanceTimersByTimeAsync(120000); owner.stop()
    expect(readFileSync(join(value.path, 'kept.txt'), 'utf8')).toBe('actual owned bytes'); expect(db.getSetting('workspace_autocleanup_last_run')).toBeUndefined()
    expect(ambient.terminateProcesses).not.toHaveBeenCalled(); expect(ambient.findLiveProcesses).not.toHaveBeenCalled(); expect(ambient.pruneNodeModules).not.toHaveBeenCalled()
  })
  it('uses a captured controlled process proof and real worktree removal inside the mutation lease', async () => {
    const value = oldTask(), observed = vi.fn(async (id: string, path: string) => { expect(id).toBe(value.task.id); expect(path).toBe(value.path); expect(existsSync(path)).toBe(true) })
    let leased = false
    const actual = await owner.runNow({ ...controls, assertIdleWorkspace: observed, runMutation: async (ids, effect) => { expect(ids).toEqual([value.task.id]); leased = true; try { return await effect() } finally { leased = false } }, beforeEffect() { if (observed.mock.calls.length) expect(leased).toBe(true) } })
    expect(actual).toEqual({ cleaned: 1, errors: [], nodeModulesCleaned: 0 }); expect(existsSync(value.path)).toBe(false); expect(observed).toHaveBeenCalledOnce(); expect(db.getTask(value.task.id)).toBeDefined()
  })
  it('retains an accepted process observation across cancellation and close timeout without deleting bytes', async () => {
    const value = oldTask(), gate = held(), entered = held()
    const pending = owner.runNow({ ...controls, assertIdleWorkspace: async () => { entered.release(); await gate.promise }, runMutation: async (_ids, effect) => effect() }), failed = pending.catch(error => error)
    try {
      await entered.promise; expect(await owner.runNow()).toEqual({ cleaned: 0, errors: ['Cleanup is already in progress'], nodeModulesCleaned: 0 })
      await expect(owner.close(5)).rejects.toThrow('WORKSPACE_CLEANUP_SHUTDOWN_INCOMPLETE'); expect(existsSync(value.path)).toBe(true)
      gate.release(); expect((await failed).message).toBe('WORKSPACE_CLEANUP_CANCELLED'); await owner.close(); expect(existsSync(value.path)).toBe(true)
    } finally { gate.release(); await failed }
  })
  it('refuses a task or retention binding changed after the actual observation was accepted', async () => {
    const value = oldTask()
    await expect(owner.runNow({ ...controls, runMutation: async (_ids, effect) => effect(), assertIdleWorkspace: async () => { db.setSetting('workspace_nodemodules_gc_enabled', 'true') } })).rejects.toThrow('WORKSPACE_CLEANUP_SCOPE_CHANGED')
    expect(existsSync(value.path)).toBe(true)
  })
  it('preserves aged orphan bytes and linked foreign directories instead of treating them as idle tasks', async () => {
    const orphan = join(root, 'workspaces', 'unowned'), outside = join(root, 'private'); mkdirSync(orphan); mkdirSync(outside); writeFileSync(join(orphan, 'personal'), 'preserve'); writeFileSync(join(outside, 'private'), 'private')
    utimesSync(orphan, new Date('2020-01-01'), new Date('2020-01-01')); symlinkSync(outside, join(root, 'workspaces', 'foreign-link'), 'junction')
    await expect(owner.runNow()).rejects.toThrow('WORKSPACE_CLEANUP_ORPHAN_REFUSED'); expect(readFileSync(join(orphan, 'personal'), 'utf8')).toBe('preserve'); expect(readFileSync(join(outside, 'private'), 'utf8')).toBe('private')
  })
  it('rejects oversized selected scalars and aggregate bytes before row materialization or JSON parsing', () => {
    const value = db.createTask({ title: 'Bounded fixture' })!; db.db.prepare('UPDATE tasks SET title=? WHERE id=?').run('x'.repeat(65536), value.id)
    const prepare = vi.spyOn(db.db, 'prepare'); expect(() => controls.store.getTasks()).toThrow('WORKSPACE_CLEANUP_DATA_LIMIT')
    expect(prepare.mock.calls.some(([sql]) => sql.startsWith('SELECT id,title'))).toBe(false); prepare.mockRestore()
    db.db.prepare('UPDATE tasks SET title=? WHERE id=?').run('x'.repeat(1024), value.id)
    const insert = db.db.prepare('INSERT INTO tasks(id,title,project_id,created_at,updated_at) VALUES(?,?,?,?,?)')
    db.db.transaction(() => { for (let i = 0; i < 900; i++) insert.run(`aggregate-${i}`, 'x'.repeat(1024), value.project_id, '2026-10-14T00:00:00Z', '2026-10-14T00:00:00Z') })()
    const aggregate = vi.spyOn(db.db, 'prepare'); expect(() => controls.store.getTasks()).toThrow('WORKSPACE_CLEANUP_DATA_LIMIT'); expect(aggregate.mock.calls.some(([sql]) => sql.startsWith('SELECT id,title'))).toBe(false)
  })
})
