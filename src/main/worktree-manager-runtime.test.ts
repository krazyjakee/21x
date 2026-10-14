import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorktreeDirectoryAuthority } from './worktree-directory-authority'
import { WorktreeManager, WORKTREE_PORTABLE_LIMITS, type WorktreeHost } from './worktree-manager-core'

function held() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
let root: string, reposRoot: string, workspaceRoot: string, owner: WorktreeManager, paths: WorktreeDirectoryAuthority
let execute: NonNullable<WorktreeHost['exec']>, calls: Array<{ file: string; args: string[]; options: unknown }>
let releases: Array<() => void>
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), '21x-worktree-runtime-')); reposRoot = join(root, 'repos'); workspaceRoot = join(root, 'workspaces'); mkdirSync(reposRoot); mkdirSync(workspaceRoot)
  paths = new WorktreeDirectoryAuthority([reposRoot, workspaceRoot], () => {}); calls = []; releases = []
  execute = async () => ({ stdout: '', stderr: '' })
  owner = new WorktreeManager({ reposRoot, workspaceRoot, portableLimits: WORKTREE_PORTABLE_LIMITS, assertPath: path => paths.assertPath(path), emitProgress: vi.fn(), exec: (file, args, options) => { calls.push({ file, args: [...args], options }); return execute(file, args, options) } })
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => { for (const release of releases) release(); await owner.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })
describe('portable worktree raw ownership and physical endpoint fences', () => {
  it('joins each nested scope raw child before revoking it and keeps the outer request alive', async () => {
    mkdirSync(join(workspaceRoot, 'fixture-task', 'repo'), { recursive: true })
    const gate = held(), entered = held(); releases.push(gate.release)
    execute = async () => { entered.release(); await gate.promise; return { stdout: 'actual.txt\0', stderr: '' } }
    let nestedSettled = false, outerSettled = false, child!: Promise<unknown>
    const outer = owner.withRequestGuard(async () => {
      const nested = owner.withRequestGuard(() => { child = owner.getTaskFiles('fixture-task', [{ fullName: 'team/repo' }]); void child.catch(() => {}); return 'early value' }, () => {})
      void nested.then(() => { nestedSettled = true }); await nested
      return 'outer value'
    }, () => {}).then(value => { outerSettled = true; return value })
    await entered.promise; expect(nestedSettled).toBe(false); expect(outerSettled).toBe(false)
    gate.release(); expect(await outer).toBe('outer value'); expect(nestedSettled).toBe(true)
    expect(await child).toContainEqual({ repo: 'team/repo', allFiles: ['actual.txt'] })
  })
  it('revokes inherited native Promise continuations after the accepted request settles', async () => {
    const trigger = held(), entered = held(); releases.push(trigger.release)
    let late!: Promise<unknown>
    await owner.withRequestGuard(async () => {
      late = trigger.promise.then(() => owner.getTaskFiles('fixture-task', []))
      void late.catch(() => {}); entered.release()
    }, () => {})
    await entered.promise; trigger.release()
    await expect(late).rejects.toThrow('WORKTREE_REQUEST_EXPIRED')
    expect(calls).toEqual([])
  })
  it('joins an accepted sibling command after another response is oversized and cancellation arrives', async () => {
    mkdirSync(join(workspaceRoot, 'fixture-task', 'one'), { recursive: true }); mkdirSync(join(workspaceRoot, 'fixture-task', 'two'))
    const gate = held(), entered = held(); releases.push(gate.release)
    execute = async (_file, _args, settings) => {
      if (settings?.cwd === join(workspaceRoot, 'fixture-task', 'one')) return { stdout: 'x'.repeat(WORKTREE_PORTABLE_LIMITS.stdoutBytes + 1), stderr: '' }
      entered.release(); await gate.promise; return { stdout: 'kept.txt\0', stderr: '' }
    }
    const controller = new AbortController()
    const pending = owner.withRequestGuard(() => owner.getTaskFiles('fixture-task', [{ fullName: 'team/one' }, { fullName: 'team/two' }]), () => {}, controller.signal)
    const failed = pending.catch(error => error)
    await entered.promise; controller.abort()
    await expect(owner.close(5)).rejects.toThrow('OWNER_DRAIN_BLOCKED')
    expect(existsSync(join(workspaceRoot, 'fixture-task', 'two'))).toBe(true)
    gate.release(); expect((await failed).message).toMatch(/OWNER_CLOSING|WORKTREE_CANCELLED/)
    await owner.close()
  })
  it('refuses cached origins that differ from exact captured provider metadata before fetch', async () => {
    mkdirSync(join(reposRoot, 'team', 'repo.git'), { recursive: true })
    execute = async () => ({ stdout: 'https://foreign.example/team/repo.git\n', stderr: '' })
    await expect(owner.withRequestGuard(() => owner.setupWorkspaceForTask('fixture-task', [{ fullName: 'team/repo', defaultBranch: 'main' }], 'team', 'github'), () => {}, undefined, { beforeRemoteRequest: () => {} })).rejects.toThrow('WORKTREE_CLONE_SCOPE_INVALID')
    expect(calls.map(call => call.args)).toEqual([['remote', 'get-url', '--all', 'origin']])
    expect(existsSync(join(workspaceRoot, 'fixture-task', 'repo'))).toBe(false)
  })
  it('refuses unbound automatic network setup and unknown self-hosted metadata before directory effects', async () => {
    await expect(owner.setupWorkspaceForTask('fixture-task', [{ fullName: 'team/repo', defaultBranch: 'main' }], 'team', 'github')).rejects.toThrow('WORKTREE_REMOTE_SCOPE_UNAVAILABLE')
    await expect(owner.withRequestGuard(() => owner.setupWorkspaceForTask('fixture-task', [{ fullName: 'team/repo', defaultBranch: 'main' }], 'team', 'gitlab'), () => {}, undefined, { beforeRemoteRequest: () => {} })).rejects.toThrow('WORKTREE_CLONE_SCOPE_INVALID')
    expect(calls).toEqual([]); expect(existsSync(join(workspaceRoot, 'fixture-task'))).toBe(false)
  })
  it('uses actual returned untracked diff bytes and disables repository external diff/textconv', async () => {
    mkdirSync(join(workspaceRoot, 'fixture-task', 'repo'), { recursive: true }); writeFileSync(join(workspaceRoot, 'fixture-task', 'repo', 'new.txt'), 'new')
    execute = async (_file, args) => {
      if (args.includes('ls-files')) return { stdout: 'new.txt\0', stderr: '' }
      if (args.includes('symbolic-ref')) return { stdout: 'origin/main\n', stderr: '' }
      if (args.includes('merge-base')) return { stdout: 'abc123\n', stderr: '' }
      if (args.includes('--abbrev-ref')) return { stdout: 'HEAD\n', stderr: '' }
      if (args.includes('--no-index')) return { stdout: 'diff --git a/new.txt b/new.txt\n+new\n', stderr: '' }
      return { stdout: '', stderr: '' }
    }
    const result = await owner.withRequestGuard(() => owner.getTaskChanges('fixture-task', [{ fullName: 'team/repo' }]), () => {})
    expect(result[1]?.diff).toContain('+new')
    const diffs = calls.filter(call => call.args.includes('diff')); expect(diffs).toHaveLength(2)
    for (const diff of diffs) expect(diff.args).toEqual(expect.arrayContaining(['--no-ext-diff', '--no-textconv']))
    expect(diffs.find(call => call.args.includes('--no-index'))?.options).toMatchObject({ allowDiffExitOne: true })
  })
})
