import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
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
    expect(actual).toEqual({ cleaned: 1, errors: [], nodeModulesCleaned: 0 }); expect(existsSync(value.path)).toBe(false); expect(observed).toHaveBeenCalledTimes(2); expect(db.getTask(value.task.id)).toBeDefined()
  })
  it('requires a fresh observation at the actual removal boundary after planning accepted idle', async () => {
    const value = oldTask(), observed = vi.fn(async () => {})
    observed.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { throw new Error('WORKSPACE_CLEANUP_PROCESS_NOT_IDLE') })
    await expect(owner.runNow({ ...controls, assertIdleWorkspace: observed, runMutation: async (_ids, effect) => effect() })).rejects.toThrow('PROCESS_NOT_IDLE')
    expect(observed).toHaveBeenCalledTimes(2); expect(readFileSync(join(value.path, 'kept.txt'), 'utf8')).toBe('actual owned bytes')
  })
  it('refuses a replacement session binding or malformed task time after planning', async () => {
    const value = oldTask()
    await expect(owner.runNow({ ...controls, assertIdleWorkspace: async () => { db.db.prepare('UPDATE tasks SET session_id=? WHERE id=?').run('replacement-generation', value.task.id) }, runMutation: async (_ids, effect) => effect() })).rejects.toThrow('SCOPE_CHANGED')
    expect(existsSync(value.path)).toBe(true)
    db.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run('invalid-time', value.task.id)
    await expect(owner.runNow({ ...controls, assertIdleWorkspace: async () => {}, runMutation: async (_ids, effect) => effect() })).rejects.toThrow('DATA_INVALID')
    expect(existsSync(value.path)).toBe(true)
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
    await expect(owner.runNow()).rejects.toThrow('WORKSPACE_CLEANUP_PROCESS_AUTHORITY_UNAVAILABLE'); expect(readFileSync(join(orphan, 'personal'), 'utf8')).toBe('preserve'); expect(readFileSync(join(outside, 'private'), 'utf8')).toBe('private')
  })
  it('removes an aged absent-ID directory through an explicit absent-ID lease without inventing a task', async () => {
    const path = join(root, 'workspaces', 'absent-fixture'); mkdirSync(path); writeFileSync(join(path, 'bytes'), 'orphan')
    utimesSync(path, new Date('2020-01-01'), new Date('2020-01-01'))
    const observed = vi.fn(async () => { expect(db.getTask('absent-fixture')).toBeUndefined() })
    const result = await owner.runNow({ ...controls, assertIdleWorkspace: observed, runMutation: async (ids, effect, absentIds) => {
      expect(ids).toEqual(['absent-fixture']); expect(absentIds).toEqual(ids); return effect()
    } })
    expect(result).toEqual({ cleaned: 1, errors: [], nodeModulesCleaned: 0 }); expect(observed).toHaveBeenCalledTimes(2)
    expect(existsSync(path)).toBe(false); expect(db.getTask('absent-fixture')).toBeUndefined(); expect(ambient.terminateProcesses).not.toHaveBeenCalled()
  })
  it('refuses orphan row reappearance after an accepted observation and preserves bytes', async () => {
    const value = oldTask()
    const read = db.db.prepare<[string], Record<string, unknown>>('SELECT * FROM tasks WHERE id=?')
    const captured = read.get(value.task.id)
    if (!captured) throw new Error('Actual fixture task row is missing')
    const columns = Object.keys(captured), quoted = columns.map(column => `"${column.replaceAll('"', '""')}"`)
    const restore = db.db.prepare(`INSERT INTO tasks(${quoted.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
    db.db.prepare('DELETE FROM tasks WHERE id=?').run(value.task.id); utimesSync(value.path, new Date('2020-01-01'), new Date('2020-01-01'))
    await expect(owner.runNow({ ...controls, runMutation: async (_ids, effect) => effect(), assertIdleWorkspace: async () => {
      restore.run(...Object.values(captured))
    } })).rejects.toThrow('WORKSPACE_CLEANUP_SCOPE_CHANGED')
    expect(readFileSync(join(value.path, 'kept.txt'), 'utf8')).toBe('actual owned bytes'); expect(read.get(value.task.id)).toEqual(captured)
  })
  it.each(['target', 'root'] as const)('refuses orphan %s identity substitution across observation', async target => {
    const path = join(root, 'workspaces', 'absent-fixture'); mkdirSync(path); writeFileSync(join(path, 'bytes'), 'original'); utimesSync(path, new Date('2020-01-01'), new Date('2020-01-01'))
    const original = target === 'root' ? join(root, 'workspaces') : path, moved = join(root, 'retained-original')
    await expect(owner.runNow({ ...controls, runMutation: async (_ids, effect) => effect(), assertIdleWorkspace: async () => {
      renameSync(original, moved); mkdirSync(original); writeFileSync(join(original, 'replacement'), 'replacement')
    } })).rejects.toThrow(target === 'root' ? 'WORKSPACE_CLEANUP_SCOPE_CHANGED' : 'WORKSPACE_CLEANUP_PATH_CHANGED')
    expect(readFileSync(join(moved, target === 'root' ? 'absent-fixture/bytes' : 'bytes'), 'utf8')).toBe('original')
    expect(readFileSync(join(original, 'replacement'), 'utf8')).toBe('replacement')
  })
  it('runs scheduled dependency GC independently, preserving the workspace, recent deps, source and protected roles', async () => {
    const value = oldTask(); db.db.prepare("UPDATE tasks SET status='not_started' WHERE id=?").run(value.task.id)
    const stale = join(value.path, 'repo', 'packages', 'node_modules'), recent = join(value.path, 'recent', 'node_modules')
    mkdirSync(stale, { recursive: true }); mkdirSync(recent, { recursive: true }); writeFileSync(join(stale, 'dependency'), 'regenerable'); utimesSync(stale, new Date('2020-01-01'), new Date('2020-01-01'))
    const captain = db.ensureCoordinatorTask(value.task.project_id)!
    const protectedDeps = join(root, 'workspaces', captain.id, 'node_modules'); mkdirSync(protectedDeps, { recursive: true }); utimesSync(protectedDeps, new Date('2020-01-01'), new Date('2020-01-01'))
    db.setSetting('workspace_autocleanup_enabled', 'false'); db.setSetting('workspace_nodemodules_gc_enabled', 'true')
    await owner.close()
    const observed = vi.fn(async () => {})
    owner = new WorkspaceCleanupSchedulerCore(db, worktrees, { workspacesRoot: join(root, 'workspaces'), listWorkspaceDirs: () => [], portablePolicy: { ...controls, assertIdleWorkspace: observed, runMutation: async (ids, effect, absentIds) => { expect(ids).toEqual([value.task.id]); expect(absentIds).toEqual([]); return effect() } } }, ambient)
    vi.useFakeTimers(); owner.start(); await vi.advanceTimersByTimeAsync(120000); owner.stop()
    expect(existsSync(stale)).toBe(false); expect(existsSync(recent)).toBe(true); expect(existsSync(protectedDeps)).toBe(true)
    expect(readFileSync(join(value.path, 'kept.txt'), 'utf8')).toBe('actual owned bytes'); expect(db.getTask(value.task.id)?.status).toBe('not_started')
    expect(db.getSetting('workspace_nodemodules_gc_last_run')).toBe(new Date().toISOString()); expect(db.getSetting('workspace_autocleanup_last_run')).toBeUndefined()
    expect(observed).toHaveBeenCalledTimes(2); expect(ambient.pruneNodeModules).not.toHaveBeenCalled()
  })
  it.each(['whole', 'dependencies'] as const)('honors independent automatic cadence when only %s is due', async phase => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-10T12:00:00.000Z'))
    const whole = oldTask(), deps = oldTask(); db.db.prepare("UPDATE tasks SET status='not_started' WHERE id=?").run(deps.task.id)
    const target = join(deps.path, 'node_modules'); mkdirSync(target); utimesSync(target, new Date('2020-01-01'), new Date('2020-01-01'))
    const ancient = '2020-01-01T00:00:00.000Z', recent = new Date().toISOString()
    const wholeLast = phase === 'whole' ? ancient : recent, depsLast = phase === 'dependencies' ? ancient : recent
    db.setSetting('workspace_autocleanup_enabled', 'true'); db.setSetting('workspace_nodemodules_gc_enabled', 'true')
    db.setSetting('workspace_autocleanup_last_run', wholeLast); db.setSetting('workspace_nodemodules_gc_last_run', depsLast)
    await owner.close()
    const observed = vi.fn(async (_id: string) => {})
    owner = new WorkspaceCleanupSchedulerCore(db, worktrees, { workspacesRoot: join(root, 'workspaces'), listWorkspaceDirs: () => [], portablePolicy: { ...controls, assertIdleWorkspace: observed, runMutation: async (_ids, effect) => effect() } }, ambient)
    owner.start(); await vi.advanceTimersByTimeAsync(120000); owner.stop()
    expect(existsSync(whole.path)).toBe(phase !== 'whole'); expect(existsSync(target)).toBe(phase !== 'dependencies')
    expect(db.getSetting('workspace_autocleanup_last_run')).toBe(phase === 'whole' ? new Date().toISOString() : wholeLast)
    expect(db.getSetting('workspace_nodemodules_gc_last_run')).toBe(phase === 'dependencies' ? new Date().toISOString() : depsLast)
    expect(observed.mock.calls.map(([id]) => id)).toEqual([phase === 'whole' ? whole.task.id : deps.task.id, phase === 'whole' ? whole.task.id : deps.task.id])
  })
  it('keeps manual cleanup explicit despite recent automatic cadence and preserves automatic timestamps', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-10T12:00:00.000Z'))
    const whole = oldTask(), deps = oldTask(); db.db.prepare("UPDATE tasks SET status='not_started' WHERE id=?").run(deps.task.id)
    const target = join(deps.path, 'node_modules'); mkdirSync(target); utimesSync(target, new Date('2020-01-01'), new Date('2020-01-01'))
    const recent = new Date().toISOString(); db.setSetting('workspace_autocleanup_enabled', 'false'); db.setSetting('workspace_nodemodules_gc_enabled', 'true')
    db.setSetting('workspace_autocleanup_last_run', recent); db.setSetting('workspace_nodemodules_gc_last_run', recent)
    const result = await owner.runNow({ ...controls, assertIdleWorkspace: async () => {}, runMutation: async (_ids, effect) => effect() })
    expect(result).toEqual({ cleaned: 1, errors: [], nodeModulesCleaned: 1 }); expect(existsSync(whole.path)).toBe(false); expect(existsSync(deps.path)).toBe(true); expect(existsSync(target)).toBe(false)
    expect(db.getSetting('workspace_autocleanup_last_run')).toBe(recent); expect(db.getSetting('workspace_nodemodules_gc_last_run')).toBe(recent)
  })
  it('does not stamp an automatic run before its retained mutation retirement acknowledges success', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-10T12:00:00.000Z'))
    const value = oldTask(), ancient = '2020-01-01T00:00:00.000Z'
    db.setSetting('workspace_autocleanup_enabled', 'true'); db.setSetting('workspace_autocleanup_last_run', ancient)
    await owner.close()
    owner = new WorkspaceCleanupSchedulerCore(db, worktrees, { workspacesRoot: join(root, 'workspaces'), listWorkspaceDirs: () => [], portablePolicy: { ...controls, assertIdleWorkspace: async () => {}, runMutation: async (_ids, effect) => { await effect(); throw new Error('WORKSPACE_CLEANUP_PROCESS_DRAIN_INCOMPLETE') } } }, ambient)
    owner.start(); await vi.advanceTimersByTimeAsync(120000); owner.stop()
    expect(existsSync(value.path)).toBe(false); expect(db.getSetting('workspace_autocleanup_last_run')).toBe(ancient); expect(db.getSetting('workspace_nodemodules_gc_last_run')).toBeUndefined()
  })
  it.each(['ancestor', 'target', 'age', 'contents', 'eligibility'] as const)('refuses dependency %s changes after observation without removing either generation', async change => {
    const value = oldTask(); db.db.prepare("UPDATE tasks SET status='not_started' WHERE id=?").run(value.task.id); db.setSetting('workspace_nodemodules_gc_enabled', 'true')
    const ancestor = join(value.path, 'repo'), target = join(ancestor, 'node_modules'); mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'bytes'), 'original'); utimesSync(target, new Date('2020-01-01'), new Date('2020-01-01'))
    let observations = 0
    await expect(owner.runNow({ ...controls, runMutation: async (_ids, effect) => effect(), assertIdleWorkspace: async () => {
      if (++observations !== 2) return
      if (change === 'age') { utimesSync(target, new Date(), new Date()); return }
      if (change === 'contents') { writeFileSync(join(target, 'bytes'), 'changed in place'); return }
      if (change === 'eligibility') { db.db.prepare("UPDATE tasks SET status='agent_working' WHERE id=?").run(value.task.id); return }
      const replaced = change === 'ancestor' ? ancestor : target
      renameSync(replaced, join(root, 'retained-original')); mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'bytes'), 'replacement'); utimesSync(target, new Date('2020-01-01'), new Date('2020-01-01'))
    } })).rejects.toThrow(change === 'age' || change === 'contents' || change === 'eligibility' ? 'WORKSPACE_CLEANUP_SCOPE_CHANGED' : 'WORKSPACE_CLEANUP_PATH_CHANGED')
    expect(readFileSync(join(target, 'bytes'), 'utf8')).toBe(change === 'ancestor' || change === 'target' ? 'replacement' : change === 'contents' ? 'changed in place' : 'original')
    if (change === 'ancestor' || change === 'target') expect(readFileSync(join(root, 'retained-original', change === 'ancestor' ? 'node_modules/bytes' : 'bytes'), 'utf8')).toBe('original')
  })
  it('preserves active tasks, invalid directory IDs and symlinked dependencies even when aged', async () => {
    const value = oldTask(); db.db.prepare("UPDATE tasks SET status='agent_working' WHERE id=?").run(value.task.id); db.setSetting('workspace_nodemodules_gc_enabled', 'true')
    const deps = join(value.path, 'node_modules'); mkdirSync(deps); utimesSync(deps, new Date('2020-01-01'), new Date('2020-01-01'))
    const invalid = join(root, 'workspaces', '.unowned'); mkdirSync(invalid); utimesSync(invalid, new Date('2020-01-01'), new Date('2020-01-01'))
    const idle = oldTask(); db.db.prepare("UPDATE tasks SET status='not_started' WHERE id=?").run(idle.task.id)
    symlinkSync(deps, join(idle.path, 'node_modules'), 'junction')
    expect(await owner.runNow()).toEqual({ cleaned: 0, errors: [], nodeModulesCleaned: 0 }); expect(existsSync(deps)).toBe(true); expect(existsSync(invalid)).toBe(true)
  })
  it('retains a dependency observation through cancellation and never records a failed pass as successful', async () => {
    const value = oldTask(); db.db.prepare("UPDATE tasks SET status='not_started' WHERE id=?").run(value.task.id); db.setSetting('workspace_nodemodules_gc_enabled', 'true')
    const target = join(value.path, 'node_modules'); mkdirSync(target); writeFileSync(join(target, 'bytes'), 'preserved'); utimesSync(target, new Date('2020-01-01'), new Date('2020-01-01'))
    const entered = held(), gate = held(), cancel = new AbortController(); let observations = 0
    const pending = owner.runNow({ ...controls, signal: cancel.signal, runMutation: async (_ids, effect) => effect(), assertIdleWorkspace: async () => { if (++observations === 2) { entered.release(); await gate.promise } } })
    const failure = pending.catch(error => error)
    try {
      await entered.promise; cancel.abort(); expect(readFileSync(join(target, 'bytes'), 'utf8')).toBe('preserved')
      expect(await owner.runNow()).toEqual({ cleaned: 0, errors: ['Cleanup is already in progress'], nodeModulesCleaned: 0 })
      gate.release(); expect(await failure).toBeInstanceOf(Error); await expect(pending).rejects.toThrow('WORKSPACE_CLEANUP_CANCELLED')
      expect(readFileSync(join(target, 'bytes'), 'utf8')).toBe('preserved'); expect(db.getSetting('workspace_nodemodules_gc_last_run')).toBeUndefined()
    } finally { gate.release(); await failure }
  })
  it('refuses an over-depth dependency inventory before admitting observations or removals', async () => {
    const value = oldTask(); db.db.prepare("UPDATE tasks SET status='not_started' WHERE id=?").run(value.task.id); db.setSetting('workspace_nodemodules_gc_enabled', 'true')
    const target = join(value.path, 'node_modules'); mkdirSync(join(target, ...Array.from({ length: 65 }, () => 'nested')), { recursive: true }); utimesSync(target, new Date('2020-01-01'), new Date('2020-01-01'))
    const observed = vi.fn(async () => {})
    await expect(owner.runNow({ ...controls, assertIdleWorkspace: observed, runMutation: async (_ids, effect) => effect() })).rejects.toThrow('WORKSPACE_CLEANUP_SCAN_LIMIT')
    expect(observed).not.toHaveBeenCalled(); expect(existsSync(target)).toBe(true); expect(db.getSetting('workspace_nodemodules_gc_last_run')).toBeUndefined()
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
