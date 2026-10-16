import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorktreeManager, WORKTREE_PORTABLE_LIMITS } from '../src/main/worktree-manager-core'
import { CLEANUP_GIT_FIXTURE_LIMITS, createWorkspaceCleanupGitFixture, isCleanupGitDescendant, type CleanupGitFixturePaths } from './production-workspace-cleanup-git-fixture'

async function deadline<T>(raw: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([raw, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('GIT_FIXTURE_TEST raw receipt deadline')), CLEANUP_GIT_FIXTURE_LIMITS.timeoutMs) })]) }
  finally { clearTimeout(timer) }
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), '21x-cleanup-real-git-')))
  const paths: CleanupGitFixturePaths = { root, profileRoot: join(root, 'profile'), reposRoot: join(root, 'repos'), workspaceRoot: join(root, 'workspaces'), tempRoot: join(root, 'temp') }
  await mkdir(paths.profileRoot); await mkdir(paths.tempRoot)
  const git = await createWorkspaceCleanupGitFixture(paths)
  let allowed = true, observations = 0
  const current = (): void => { if (!allowed) throw new Error('GIT_PROVIDER_CANCELLED') }
  const owner = git.gitProviderProcess({ execFile, home: root, cwd: paths.profileRoot, environment: {}, worktreeRoots: [paths.reposRoot, paths.workspaceRoot], assertCurrent: () => {} })
  const manager = new WorktreeManager({ reposRoot: paths.reposRoot, workspaceRoot: paths.workspaceRoot, portableLimits: WORKTREE_PORTABLE_LIMITS,
    emitProgress() {}, assertPath: path => { if (path !== paths.reposRoot && path !== paths.workspaceRoot && !isCleanupGitDescendant(paths.reposRoot, path) && !isCleanupGitDescendant(paths.workspaceRoot, path)) throw new Error('GIT_FIXTURE_TEST foreign path') },
    // Controlled observation invocation only. These Git-owner tests do not
    // establish native/full-host process absence or production DB authority.
    beforeCleanupEffect: async () => { current(); observations++ },
    exec: (program, args, options) => owner.execWorktree(program, args, { cwd: options.cwd as string, maxBuffer: CLEANUP_GIT_FIXTURE_LIMITS.outputBytes }),
    onWorktreeRemoved: (path, identity) => owner.retireWorktreeDirectory(path, identity),
    onTaskWorkspaceRemoved: (id, identity) => owner.retireWorktreeDirectory(join(paths.workspaceRoot, id), identity) })
  const remove = (seed: Awaited<ReturnType<typeof git.seed>>) => owner.withRequestGuard(() => manager.withRequestGuard(
    () => manager.cleanupTaskWorkspace(seed.taskPath.split('/').at(-1)!, seed.repos, seed.org), current), current)
  return { paths, git, owner, manager, remove, revoke: () => { allowed = false }, observations: () => observations,
    async close(): Promise<void> {
      manager.shutdown(); await manager.close()
      await git.close()
      // Reached only after actual owner/callback/child/stdio drain. Failed
      // drain preserves this new synthetic root for diagnosis and retry.
      await rm(root, { recursive: true, force: false })
    } }
}

describe('actual local multi-repository cleanup fixture', () => {
  it('refuses root, sibling and relative path authority before process creation', () => {
    const root = join(tmpdir(), 'cleanup-git-literal')
    expect(isCleanupGitDescendant(root, root)).toBe(false)
    expect(isCleanupGitDescendant(root, `${root}-other/task`)).toBe(false)
    expect(isCleanupGitDescendant(root, 'relative/task')).toBe(false)
    expect(isCleanupGitDescendant(root, join(root, 'task'))).toBe(true)
  })

  it.skipIf(process.platform !== 'linux')('preserves native root-observation refusal in a no-command request while actual Git admission remains physical', async () => {
    const f = await fixture(), original = `${f.paths.workspaceRoot}-original`
    const refusal = new Error('WORKSPACE_CLEANUP_OBSERVATION_UNAVAILABLE')
    let moved = false, substituted = false, reachedObservation = false
    try {
      await writeFile(join(f.paths.workspaceRoot, 'original.txt'), 'Original synthetic workspace bytes\n', { flag: 'wx' })
      const failure = await f.owner.withRequestGuard(async () => {
        await rename(f.paths.workspaceRoot, original); moved = true
        await mkdir(f.paths.workspaceRoot); substituted = true
        // The actual production guard must permit this observation result to
        // remain the failure even when it finalizes the no-command scope.
        reachedObservation = true
        throw refusal
      }, () => {}).catch(error => error)
      expect(reachedObservation).toBe(true)
      expect(failure).toBe(refusal)
      expect(f.git.snapshot()).toMatchObject({ started: 0, rawPending: 0 })
      expect(readFileSync(join(original, 'original.txt'), 'utf8')).toBe('Original synthetic workspace bytes\n')
      // This reaches the unchanged real process owner's command preflight;
      // the fixture's execFile boundary still refuses the substituted root
      // before admitting a child or trusting any removal arguments.
      await expect(f.owner.execWorktree('git', ['worktree', 'remove', join(f.paths.workspaceRoot, 'fixture', 'alpha'), '--force'], { cwd: f.paths.reposRoot }))
        .rejects.toMatchObject({ code: 'GIT_PROVIDER_COMMAND_FAILED' })
      expect(f.git.snapshot()).toMatchObject({ started: 0, rawPending: 0 })
      await expect(f.git.seed('root_changed_fixture')).rejects.toThrow('captured fixture root changed')
    } finally {
      // Restore only these freshly created synthetic directories. No original
      // preserved failure profile or production workspace is touched.
      if (substituted) await rmdir(f.paths.workspaceRoot)
      if (moved) await rename(original, f.paths.workspaceRoot)
      await f.close()
    }
  }, 30_000)

  it.skipIf(process.platform !== 'linux')('removes two actual linked Git worktrees and their metadata, retaining committed branches', async () => {
    const f = await fixture()
    try {
      const seed = await f.git.seed('actual_git_completed')
      expect(seed.repos.map(repo => repo.fullName)).toEqual(['cleanup-fixture/alpha', 'cleanup-fixture/beta'])
      expect(new Set(seed.worktrees.map(tree => tree.commit)).size).toBe(2)
      expect(seed.worktrees.map(tree => readFileSync(join(tree.path, tree.file), 'utf8'))).toEqual(seed.worktrees.map(tree => tree.content))
      await f.remove(seed)
      const receipt = await f.git.assertRemoved(seed)
      expect(receipt).toMatchObject({ worktrees: 2, successfulProductionRemovals: 2, metadataEntriesRemoved: 2, pathsRemoved: 2, rawPending: 0 })
      expect(receipt.callbacksDelivered).toBe(receipt.childCloses)
      expect(receipt.stdioCloses).toBe(receipt.childCloses * 2)
      expect(f.observations()).toBe(3)
      expect(existsSync(seed.taskPath)).toBe(false)
    } finally { await f.close() }
  }, 30_000)

  it.skipIf(process.platform !== 'linux')('retains actual exited-child/stdio ownership behind a held callback until the cancellation fence settles', async () => {
    const f = await fixture()
    let work: Promise<void> | undefined, release: (() => void) | undefined
    try {
      const seed = await f.git.seed('actual_git_cancelled'), hold = f.git.holdNextRemoval()
      release = hold.release
      let settled = false
      work = f.remove(seed)
      const outcome = work.then(() => { settled = true; return 'resolved' }, error => { settled = true; return (error as Error).message })
      await deadline(hold.entered)
      const state = f.git.snapshot(), command = state.commands.find(value => value.phase === 'production')!
      expect(command).toMatchObject({ callbackReceived: true, callbackDelivered: false, childClosed: true, stdoutClosed: true, stderrClosed: true, exitCode: 0, success: true })
      expect(state.rawPending).toBe(1); expect(f.owner.childCount).toBe(1); expect(settled).toBe(false)
      expect(existsSync(seed.worktrees[0].path)).toBe(false)
      expect(readFileSync(join(seed.worktrees[1].path, seed.worktrees[1].file), 'utf8')).toBe(seed.worktrees[1].content)
      // Revoke request authority only after its exact child has exited. No
      // helper process signalling, fabricated success or uncertain replay.
      f.revoke(); hold.release()
      expect(await deadline(outcome)).toBe('GIT_PROVIDER_CANCELLED')
      expect(f.git.snapshot()).toMatchObject({ rawPending: 0, successfulProductionRemovals: 1, failedProductionRemovals: 0 })
      expect(f.owner.childCount).toBe(0)
      expect(existsSync(seed.taskPath)).toBe(true)
      expect(existsSync(seed.worktrees[1].path)).toBe(true)
      await expect(f.git.assertRemoved(seed)).rejects.toThrow('worktree directory survived production cleanup')
    } finally {
      release?.(); if (work) await work.catch(() => {})
      await f.close()
    }
  }, 30_000)
})
