import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorktreeManager, type WorktreeHost } from './worktree-manager-core'
import { WorktreeDirectoryAuthority } from './worktree-directory-authority'

const command = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('child_process', () => ({ execFile: command.execFile }))
afterEach(() => { vi.restoreAllMocks(); command.execFile.mockReset() })

describe('portable worktree host and command lifetime', () => {
  it('uses only captured execution and refuses unsafe repo inputs before creating task directories', async () => {
    const root = mkdtempSync(join(tmpdir(), '21x-worktree-authority-'))
    const reposRoot = join(root, 'repos'), workspaceRoot = join(root, 'workspaces')
    mkdirSync(reposRoot); mkdirSync(workspaceRoot)
    const paths = new WorktreeDirectoryAuthority([reposRoot, workspaceRoot], () => {})
    const exec = vi.fn<NonNullable<WorktreeHost['exec']>>(async () => ({ stdout: '', stderr: '' }))
    const owner = new WorktreeManager({ reposRoot, workspaceRoot, emitProgress: vi.fn(), exec, assertPath: path => paths.assertPath(path) })
    const repo = { fullName: 'fixture-org/repo', defaultBranch: 'main' }
    try {
      await expect(owner.setupWorkspaceForTask('../outside', [repo], 'fixture-org')).rejects.toThrow('WORKTREE_PATH_UNAUTHORIZED')
      await expect(owner.setupWorkspaceForTask('fixture-task', [{ ...repo, fullName: 'other/repo' }], 'fixture-org')).rejects.toThrow('WORKTREE_PATH_UNAUTHORIZED')
      await expect(owner.setupWorkspaceForTask('fixture-task', [{ ...repo, cloneUrl: 'file:///outside/repo' }], 'fixture-org')).rejects.toThrow('WORKTREE_CLONE_SCOPE_INVALID')
      await expect(owner.setupWorkspaceForTask('fixture-task', [{ ...repo, defaultBranch: '--help' }], 'fixture-org')).rejects.toThrow('WORKTREE_REF_INVALID')
      expect(existsSync(join(workspaceRoot, 'fixture-task'))).toBe(false)
      await owner.setupWorkspaceForTask('fixture-task', [repo], 'fixture-org')
      expect(exec.mock.calls[0]).toEqual(['gh', ['repo', 'clone', 'https://github.com/fixture-org/repo.git', join(reposRoot, 'fixture-org', 'repo.git'), '--', '--bare'], { timeout: 300000, cwd: reposRoot }])
      expect(command.execFile).not.toHaveBeenCalled()
    } finally { await owner.close(); rmSync(root, { recursive: true, force: true }) }
  })

  it.each(['link', 'directory'] as const)('preserves a replacement %s after an awaited cleanup command fails', async kind => {
    const root = mkdtempSync(join(tmpdir(), '21x-worktree-link-'))
    const reposRoot = join(root, 'repos'), workspaceRoot = join(root, 'workspaces'), outside = join(root, 'outside')
    const target = join(workspaceRoot, 'fixture-task', 'repo')
    mkdirSync(join(reposRoot, 'fixture-org', 'repo.git'), { recursive: true }); mkdirSync(target, { recursive: true }); mkdirSync(outside)
    writeFileSync(join(outside, 'personal.txt'), 'Keep this file')
    const paths = new WorktreeDirectoryAuthority([reposRoot, workspaceRoot], () => {})
    let finish!: () => void, entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const exec = vi.fn(() => new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => { finish = () => reject(new Error('fixture git refusal')); entered() }))
    const owner = new WorktreeManager({ reposRoot, workspaceRoot, emitProgress: vi.fn(), exec, assertPath: path => paths.assertPath(path) })
    const work = owner.cleanupTaskWorkspace('fixture-task', [{ fullName: 'fixture-org/repo' }], 'fixture-org')
    const failed = expect(work).rejects.toThrow(kind === 'link' ? 'WORKTREE_PATH_UNAUTHORIZED' : 'WORKTREE_DIRECTORY_CHANGED')
    try {
      await started; renameSync(target, target + '.retained')
      if (kind === 'link') symlinkSync(outside, target, 'junction')
      else { mkdirSync(target); writeFileSync(join(target, 'personal.txt'), 'Keep replacement') }
      finish()
      await failed
      expect(readFileSync(join(outside, 'personal.txt'), 'utf8')).toBe('Keep this file')
      if (kind === 'directory') expect(readFileSync(join(target, 'personal.txt'), 'utf8')).toBe('Keep replacement')
      expect(command.execFile).not.toHaveBeenCalled()
    } finally { finish?.(); await failed; await owner.close(); rmSync(root, { recursive: true, force: true }) }
  })
  it('uses the trusted workspace root for actual files and refuses new work after close', async () => {
    const root = mkdtempSync(join(tmpdir(), '21x-worktree-host-'))
    const workspaceRoot = join(root, 'workspaces')
    mkdirSync(join(workspaceRoot, 'fixture-task'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'fixture-task', 'result.txt'), 'fixture result')
    const owner = new WorktreeManager({ reposRoot: join(root, 'repos'), workspaceRoot, emitProgress: vi.fn() })
    try {
      expect(owner.readTaskFile('fixture-task', null, 'result.txt')?.content).toBe('fixture result')
      expect(owner.readTaskFile('fixture-task', null, '../outside.txt')).toBeNull()
      await owner.close()
      expect(() => owner.readTaskFile('fixture-task', null, 'result.txt')).toThrow('OWNER_CLOSING')
      await expect(owner.getTaskFiles('fixture-task', [])).rejects.toThrow('OWNER_CLOSING')
    } finally { await owner.close(); rmSync(root, { recursive: true, force: true }) }
  })

  it('retains a raw git cleanup callback and prevents fallback filesystem removal after shutdown', async () => {
    const root = mkdtempSync(join(tmpdir(), '21x-worktree-drain-'))
    const reposRoot = join(root, 'repos'), workspaceRoot = join(root, 'workspaces')
    mkdirSync(join(reposRoot, 'fixture-org', 'fixture-repo.git'), { recursive: true })
    const taskDir = join(workspaceRoot, 'fixture-task', 'fixture-repo')
    mkdirSync(taskDir, { recursive: true }); writeFileSync(join(taskDir, 'retain.txt'), 'retain')
    let finish!: (error: Error | null, stdout?: string, stderr?: string) => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    command.execFile.mockImplementation((_file, _args, _options, callback) => { finish = callback; entered() })
    const owner = new WorktreeManager({ reposRoot, workspaceRoot, emitProgress: vi.fn() })
    const work = owner.cleanupTaskWorkspace('fixture-task', [{ fullName: 'fixture-org/fixture-repo' }], 'fixture-org')
    const failed = expect(work).rejects.toThrow('OWNER_CLOSING')
    try {
      await started
      await expect(owner.close(5)).rejects.toThrow('OWNER_DRAIN_BLOCKED')
      expect(readFileSync(join(taskDir, 'retain.txt'), 'utf8')).toBe('retain')
      finish(new Error('controlled git refusal'))
      await failed
      await owner.close()
      expect(readFileSync(join(taskDir, 'retain.txt'), 'utf8')).toBe('retain')
      expect(command.execFile).toHaveBeenCalledOnce()
    } finally { finish?.(new Error('fixture finished')); await failed; await owner.close(); rmSync(root, { recursive: true, force: true }) }
  })
})

it('fences the next worktree command and publication after an accepted fetch loses its caller guard', async () => {
  const root = mkdtempSync(join(tmpdir(), '21x-worktree-request-')), reposRoot = join(root, 'repos'), workspaceRoot = join(root, 'workspaces')
  mkdirSync(join(reposRoot, 'fixture-org', 'repo.git'), { recursive: true }); mkdirSync(workspaceRoot)
  const paths = new WorktreeDirectoryAuthority([reposRoot, workspaceRoot], () => {})
  let finish!: () => void, entered!: () => void, allowed = true
  const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { finish = resolve })
  const denied = new Error('Caller scope withdrawn'), progress = vi.fn()
  const exec = vi.fn<NonNullable<WorktreeHost['exec']>>(async () => { entered(); await gate; return { stdout: '', stderr: '' } })
  const owner = new WorktreeManager({ reposRoot, workspaceRoot, emitProgress: progress, exec, assertPath: path => paths.assertPath(path) })
  const beforeEffect = (): void => { if (!allowed) throw denied }
  const work = owner.setupWorkspaceForTask('fixture-task', [{ fullName: 'fixture-org/repo', defaultBranch: 'main' }, { fullName: 'fixture-org/later', defaultBranch: 'main' }], 'fixture-org', 'github', beforeEffect)
  const rejected = expect(work).rejects.toBe(denied)
  try {
    await started; allowed = false; const emitted = progress.mock.calls.length
    finish(); await rejected
    expect(exec).toHaveBeenCalledOnce(); expect(exec.mock.calls[0][1]).toEqual(['fetch', 'origin'])
    expect(progress.mock.calls.length).toBe(emitted)
    expect(existsSync(join(workspaceRoot, 'fixture-task', 'repo'))).toBe(false)
    expect(existsSync(join(reposRoot, 'fixture-org', 'later.git'))).toBe(false)
  } finally { finish?.(); await rejected; await owner.close(); rmSync(root, { recursive: true, force: true }) }
})
