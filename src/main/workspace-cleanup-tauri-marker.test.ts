import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { registerGitHandlers } from './ipc/git'
import type { IpcDeps } from './ipc/deps'
import { TAURI_SHARED_WORKSPACES_FILE } from './platform/profile-lock'
import { WorkspaceCleanupSchedulerCore, type WorkspaceCleanupHost, type WorkspaceCleanupOperations } from './workspace-cleanup-scheduler-core'
import { WorkspaceCleanupScheduler } from './workspace-cleanup-scheduler'
import { WORKSPACES_DIR, electronKeepsWorkspaces } from './workspace-paths'
import { WorktreeManager } from './worktree-manager'
import { WorktreeManager as WorktreeManagerCore } from './worktree-manager-core'

// `WORKSPACES_DIR` is fixed at import, so the throwaway profile has to exist first.
const profile = vi.hoisted(() => {
  const { mkdtempSync } = process.getBuiltinModule('node:fs'), { tmpdir } = process.getBuiltinModule('node:os'), { join } = process.getBuiltinModule('node:path')
  return mkdtempSync(join(tmpdir(), '21x-tauri-marker-'))
})
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => profile), getName: vi.fn(() => '21x'), getVersion: vi.fn(() => '1.0.0'), isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  dialog: {},
  safeStorage: { isEncryptionAvailable: vi.fn(() => false), encryptString: vi.fn((value: string) => Buffer.from(value)), decryptString: vi.fn((value: Buffer) => value.toString()) }
}))

const LONG_AGO = new Date('2020-01-01')
const marker = join(profile, TAURI_SHARED_WORKSPACES_FILE)
const mark = (): void => writeFileSync(marker, '')
let db: ReturnType<typeof createPortableTestDb>, worktrees: WorktreeManager, owner: WorkspaceCleanupScheduler

beforeEach(() => {
  mkdirSync(WORKSPACES_DIR, { recursive: true })
  db = createPortableTestDb()
  db.setSetting('workspace_nodemodules_gc_enabled', 'false')
  db.setSetting('workspace_autocleanup_enabled', 'true')
  db.setSetting('github_org', 'org')
  worktrees = new WorktreeManager()
  owner = new WorkspaceCleanupScheduler(db as never, worktrees)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => {
  await owner.close(); await worktrees.close(); db.close()
  vi.restoreAllMocks()
  for (const name of readdirSync(profile)) rmSync(join(profile, name), { recursive: true, force: true })
})
afterAll(() => rmSync(profile, { recursive: true, force: true }))

const PASSES = {
  'manual Run cleanup': () => owner.runNow().then(() => {}),
  'scheduled pass': () => (owner as unknown as { runCleanup(): Promise<void> }).runCleanup()
}
type Pass = keyof typeof PASSES

/** Route 1: a Tauri task Electron has never heard of. Only the top folder's age counts, so it looks abandoned. */
function unknownTask(id = 'tauri-task'): string {
  const path = join(WORKSPACES_DIR, id, 'repo'); mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'uncommitted'), 'the only copy')
  utimesSync(join(WORKSPACES_DIR, id), LONG_AGO, LONG_AGO)
  return join(WORKSPACES_DIR, id)
}
function completedHere(repos: string[] = []): { id: string; path: string } {
  const task = db.createTask({ title: 'Completed in Electron', repos })!
  db.db.prepare("UPDATE tasks SET status='completed',updated_at='2020-01-01T00:00:00Z' WHERE id=?").run(task.id)
  return { id: task.id, path: join(WORKSPACES_DIR, task.id) }
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}
/** Route 2: a real worktree holding uncommitted work, on a task Electron thinks is finished. */
function reopenedInTauri(): { id: string; path: string; work: string } {
  const task = completedHere(['org/repo']), bare = join(profile, 'repos', 'org', 'repo.git'), worktree = join(task.path, 'repo')
  mkdirSync(task.path, { recursive: true }); mkdirSync(bare, { recursive: true })
  git(bare, 'init', '--bare', '-b', 'main', '.')
  const tree = execFileSync('git', ['hash-object', '-t', 'tree', '-w', '--stdin'], { cwd: bare, input: '', encoding: 'utf8' }).trim()
  git(bare, 'update-ref', 'refs/heads/main', git(bare, 'commit-tree', tree, '-m', 'start'))
  git(bare, 'worktree', 'add', worktree, '-b', `task/${task.id}`, 'main')
  const work = join(worktree, 'uncommitted'); writeFileSync(work, 'the only copy')
  return { ...task, work }
}

describe('Electron cleanup with the Tauri marker', () => {
  describe.each(Object.keys(PASSES) as Pass[])('%s', pass => {
    const run = (): Promise<void> => PASSES[pass]()
    it('removes the workspace of an unknown task without the marker, which is the danger', async () => {
      const path = unknownTask()
      await run()
      expect(existsSync(path)).toBe(false)
    })
    it('keeps the workspace of an unknown task with the marker', async () => {
      const path = unknownTask(); mark()
      await run()
      expect(readFileSync(join(path, 'repo', 'uncommitted'), 'utf8')).toBe('the only copy')
    })
    it('removes a task Completed in its own record without the marker, which is the danger', async () => {
      const task = reopenedInTauri()
      await run()
      expect(existsSync(task.path)).toBe(false)
    })
    it('keeps a task Completed in its own record with the marker, even one reopened in Tauri', async () => {
      const task = reopenedInTauri(); mark()
      await run()
      expect(readFileSync(task.work, 'utf8')).toBe('the only copy')
      expect(git(join(profile, 'repos', 'org', 'repo.git'), 'worktree', 'list')).toContain(task.id)
    })
  })

  it('tells the user how many workspaces it kept, in the result and the final event', async () => {
    const emit = vi.fn(); (owner as unknown as { sendToRenderer: typeof emit }).sendToRenderer = emit
    unknownTask('tauri-a'); unknownTask('tauri-b'); completedHere(); mkdirSync(completedHere().path); mark()
    expect(await owner.runNow()).toEqual({ cleaned: 0, errors: [], nodeModulesCleaned: 0, workspacesKept: 3 })
    expect(emit).toHaveBeenLastCalledWith('workspace:cleanup-progress', expect.objectContaining({ phase: 'done', workspacesKept: 3 }))
  })

  it('stamps no daily run while it keeps workspaces, so removing the marker by hand restores cleanup at once', async () => {
    const run = PASSES['scheduled pass'], path = unknownTask(); mark()
    await run()
    expect(db.getSetting('workspace_autocleanup_last_run')).toBeUndefined()
    expect(existsSync(path)).toBe(true)
    rmSync(marker)
    await run()
    expect(existsSync(path)).toBe(false)
    expect(db.getSetting('workspace_autocleanup_last_run')).toBeDefined()
  })

  describe('a marker appearing during a pass', () => {
    it('stops the next removal after one has finished', async () => {
      const task = completedHere(), first = unknownTask('tauri-a'), second = unknownTask('tauri-b'); mkdirSync(task.path)
      const cleanup = vi.fn(async () => [] as number[])
      const local = new WorkspaceCleanupSchedulerCore(db as never, worktrees, { workspacesRoot: WORKSPACES_DIR, listWorkspaceDirs: () => [], keepWholeWorkspaces: electronKeepsWorkspaces }, operations({ terminateProcesses: cleanup as never }))
      const removeFirst = vi.spyOn(console, 'log').mockImplementation(message => { if (String(message).includes('Cleaned orphaned workspace directory')) mark() })
      const result = await local.runNow()
      await local.close(); removeFirst.mockRestore()
      expect(result).toEqual({ cleaned: 2, errors: [], nodeModulesCleaned: 0, workspacesKept: 1 })
      expect(existsSync(task.path)).toBe(false)
      expect([existsSync(first), existsSync(second)].sort()).toEqual([false, true])
    })
    it('stops every removal if it arrives while processes are being stopped', async () => {
      const path = unknownTask()
      const local = new WorkspaceCleanupSchedulerCore(db as never, worktrees, { workspacesRoot: WORKSPACES_DIR, listWorkspaceDirs: () => [], keepWholeWorkspaces: electronKeepsWorkspaces }, operations({ terminateProcesses: (async () => { mark(); return [] }) as never }))
      expect(await local.runNow()).toEqual({ cleaned: 0, errors: [], nodeModulesCleaned: 0, workspacesKept: 1 })
      await local.close()
      expect(existsSync(path)).toBe(true)
    })
    it('stops inside a task with several repositories', async () => {
      const task = completedHere(['org/first', 'org/second']), removed: string[] = []
      for (const repo of ['first', 'second']) { mkdirSync(join(task.path, repo), { recursive: true }); mkdirSync(join(profile, 'repos', 'org', `${repo}.git`), { recursive: true }) }
      const guarded = new WorktreeManagerCore({ reposRoot: join(profile, 'repos'), workspaceRoot: WORKSPACES_DIR, emitProgress: vi.fn(), exec: async (_file, args) => {
        removed.push(args[2]); rmSync(args[2], { recursive: true }); mark(); return { stdout: '', stderr: '' }
      } })
      const local = new WorkspaceCleanupSchedulerCore(db as never, guarded, { workspacesRoot: WORKSPACES_DIR, listWorkspaceDirs: () => [], keepWholeWorkspaces: electronKeepsWorkspaces }, operations())
      expect(await local.runNow()).toEqual({ cleaned: 0, errors: [], nodeModulesCleaned: 0, workspacesKept: 1 })
      await local.close(); await guarded.close()
      expect(removed).toEqual([join(task.path, 'first')])
      expect(existsSync(join(task.path, 'second'))).toBe(true)
    })
  })

  describe('whatever is at that name counts', () => {
    const KINDS: Array<[string, () => void]> = [
      ['an empty file', () => writeFileSync(marker, '')],
      ['content that means nothing', () => writeFileSync(marker, Buffer.from([0xff, 0x00, 0xfe]))],
      ['content that reads like a refusal', () => writeFileSync(marker, 'false\n')],
      ['a link to nowhere', () => symlinkSync(join(profile, 'missing'), marker)],
      ['a link to a folder', () => { mkdirSync(join(profile, 'elsewhere')); symlinkSync(join(profile, 'elsewhere'), marker) }],
      ['a folder', () => mkdirSync(marker)],
      ['a file nobody can read', () => { writeFileSync(marker, 'x'); chmodSync(marker, 0o000) }]
    ]
    it.each(KINDS)('%s', async (_name, plant) => {
      const path = unknownTask(), task = reopenedInTauri(); plant()
      expect((await owner.runNow()).workspacesKept).toBe(2)
      expect(existsSync(path)).toBe(true); expect(existsSync(task.work)).toBe(true)
    })
  })

  describe('dependency pruning', () => {
    const idleDependencies = (workspace: string): string => {
      const path = join(workspace, 'repo', 'node_modules'); mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'package.json'), '{}')
      utimesSync(join(path, 'package.json'), LONG_AGO, LONG_AGO); utimesSync(path, LONG_AGO, LONG_AGO)
      return path
    }
    beforeEach(() => { db.setSetting('workspace_nodemodules_gc_enabled', 'true') })

    it('still prunes a task this app knows, and leaves a workspace it does not', async () => {
      const known = db.createTask({ title: 'Known here', repos: [] })!, ours = idleDependencies(join(WORKSPACES_DIR, known.id))
      const theirs = idleDependencies(unknownTask()); utimesSync(join(WORKSPACES_DIR, 'tauri-task'), LONG_AGO, LONG_AGO); mark()
      expect(await owner.runNow()).toEqual({ cleaned: 0, errors: [], nodeModulesCleaned: 1, workspacesKept: 1 })
      expect(existsSync(ours)).toBe(false)
      expect(existsSync(theirs)).toBe(true)
    })
    it('prunes that same unknown workspace without the marker, as it always has', async () => {
      const path = unknownTask('recent'), theirs = idleDependencies(path); utimesSync(path, new Date(), new Date())
      expect(await owner.runNow()).toEqual({ cleaned: 0, errors: [], nodeModulesCleaned: 1 })
      expect(existsSync(theirs)).toBe(false)
    })
  })

  describe('with no marker', () => {
    /** Everything a pass can do that anyone could see. */
    async function observe(host: Pick<WorkspaceCleanupHost, 'keepWholeWorkspaces'>) {
      const known = db.db.prepare('SELECT id FROM tasks ORDER BY id').pluck().all() as string[]
      for (const id of known) mkdirSync(join(WORKSPACES_DIR, id), { recursive: true })
      unknownTask(); unknownTask('tauri-b')
      const events: unknown[] = [], calls = operations()
      const run = new WorkspaceCleanupSchedulerCore(db as never, worktrees, { workspacesRoot: WORKSPACES_DIR, listWorkspaceDirs: () => readdirSync(WORKSPACES_DIR), emit: (channel, data) => events.push([channel, data]), ...host }, calls)
      const result = await run.runNow(); await run.close()
      return { result, events, left: readdirSync(WORKSPACES_DIR).sort(), terminated: calls.terminateProcesses.mock.calls, pruned: calls.pruneNodeModules.mock.calls.length }
    }
    it('matches a host that has never heard of the marker, event for event', async () => {
      completedHere(); completedHere(['org/repo'])
      const plain = await observe({})
      expect(Object.keys(plain.result)).toEqual(['cleaned', 'errors', 'nodeModulesCleaned'])
      for (const name of readdirSync(WORKSPACES_DIR)) rmSync(join(WORKSPACES_DIR, name), { recursive: true })
      expect(await observe({ keepWholeWorkspaces: electronKeepsWorkspaces })).toEqual(plain)
      expect(plain.result.cleaned).toBe(4)
    })
  })

  it('stops no process in a workspace that stays', async () => {
    unknownTask(); mark()
    const calls = operations()
    const local = new WorkspaceCleanupSchedulerCore(db as never, worktrees, { workspacesRoot: WORKSPACES_DIR, listWorkspaceDirs: () => [], keepWholeWorkspaces: electronKeepsWorkspaces }, calls)
    await local.runNow(); await local.close()
    expect(calls.terminateProcesses).not.toHaveBeenCalled()
  })

  describe('the worktree:cleanup request', () => {
    let cleanup: (...args: unknown[]) => Promise<void>
    beforeEach(() => {
      vi.mocked(ipcMain.handle).mockClear()
      registerGitHandlers({ db, worktreeManager: worktrees, workspaceCleanupScheduler: owner, githubManager: {}, gitlabManager: {}, forgejoManager: {} } as unknown as IpcDeps)
      cleanup = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === 'worktree:cleanup')![1] as never
    })

    it('keeps a workspace on the automatic cleanup when a task completes', async () => {
      const task = reopenedInTauri(); mark()
      await cleanup({}, task.id, [{ fullName: 'org/repo' }], 'org', undefined)
      expect(readFileSync(task.work, 'utf8')).toBe('the only copy')
    })
    it('removes it on that cleanup with no marker, as it always has', async () => {
      const task = reopenedInTauri()
      await cleanup({}, task.id, [{ fullName: 'org/repo' }], 'org', undefined)
      expect(existsSync(task.path)).toBe(false)
    })
    it('leaves an explicit task delete as it is, which is the choice still open', async () => {
      const task = reopenedInTauri(); mark()
      await cleanup({}, task.id, [{ fullName: 'org/repo' }], 'org', true)
      expect(existsSync(task.path)).toBe(false)
    })
    it('leaves dropping one repository from a task as it is', async () => {
      const task = reopenedInTauri(); mark()
      await cleanup({}, task.id, [{ fullName: 'org/repo' }], 'org', false)
      expect(existsSync(join(task.path, 'repo'))).toBe(false)
      expect(statSync(task.path).isDirectory()).toBe(true)
    })
  })
})

function operations(overrides: Partial<WorkspaceCleanupOperations> = {}) {
  return {
    terminateProcesses: vi.fn(async () => []), findLiveProcesses: vi.fn(async () => new Set<string>()), pruneNodeModules: vi.fn(() => ({ pruned: [], errors: [] })),
    ...overrides
  } as unknown as { [K in keyof WorkspaceCleanupOperations]: ReturnType<typeof vi.fn> & WorkspaceCleanupOperations[K] }
}
