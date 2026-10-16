import { execFile, type ExecFileException, type ExecFileOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { GitProviderProcessOwner, type GitProviderProcessOwnerOptions } from '../src/main/git-provider-process-owner'

export const CLEANUP_GIT_FIXTURE_LIMITS = Object.freeze({ commands: 192, timeoutMs: 10_000, outputBytes: 128 * 1024, repositories: 2 })
export interface CleanupGitFixturePaths { root: string; profileRoot: string; reposRoot: string; workspaceRoot: string; tempRoot: string }
export interface CleanupGitWorktree { barePath: string; path: string; branch: string; commit: string; file: string; content: string }
export interface CleanupGitSeed { org: 'cleanup-fixture'; repos: Array<{ fullName: string; defaultBranch: 'main' }>; taskPath: string; worktrees: CleanupGitWorktree[] }
export interface CleanupGitCommandReceipt {
  phase: 'seed' | 'production' | 'verify'
  args: string[]
  cwd: string
  callbackReceived: boolean
  callbackDelivered: boolean
  childClosed: boolean
  stdoutClosed: boolean
  stderrClosed: boolean
  exitCode: number | null
  signal: string | null
  success: boolean
}
export interface CleanupGitRemovalReceipt {
  worktrees: number
  successfulProductionRemovals: number
  metadataEntriesRemoved: number
  pathsRemoved: number
  callbacksDelivered: number
  childCloses: number
  stdioCloses: number
  rawPending: number
}
interface Gate { entered: Promise<void>; release(): void; released: boolean; enter(): void; listeners: Set<() => void> }
function gate(): Gate {
  let enter!: () => void
  const value: Gate = { entered: new Promise<void>(done => { enter = done }), released: false, enter: () => enter(), listeners: new Set(),
    release: () => { value.released = true; for (const listener of value.listeners) listener() } }
  return value
}
function refuse(detail: string): never { throw new Error(`CLEANUP_GIT_FIXTURE ${detail}`) }
export function isCleanupGitDescendant(root: string, path: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(path)) return false
  const part = relative(root, path)
  return part !== '' && !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)
}
function directoryIdentity(path: string): string {
  const info = lstatSync(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) refuse('physical directory changed')
  return `${info.dev}:${info.ino}`
}
function worktreeRecords(output: string): Array<{ path: string; head?: string; branch?: string }> {
  if (Buffer.byteLength(output) > CLEANUP_GIT_FIXTURE_LIMITS.outputBytes || output.includes('\0')) refuse('worktree metadata overflow')
  return output.trim().split('\n\n').filter(Boolean).map(block => {
    const lines = block.split('\n'), path = lines.find(line => line.startsWith('worktree '))?.slice(9)
    if (!path || !isAbsolute(path)) refuse('invalid worktree metadata')
    return { path, head: lines.find(line => line.startsWith('HEAD '))?.slice(5), branch: lines.find(line => line.startsWith('branch '))?.slice(7) }
  })
}
async function bounded<T>(raw: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([raw, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`CLEANUP_GIT_FIXTURE ${label} drain incomplete`)), CLEANUP_GIT_FIXTURE_LIMITS.timeoutMs) })]) }
  finally { clearTimeout(timer) }
}

/** Local synthetic Git only. No public/runtime command is added. The returned
 * factory instruments the actual production process owner, never Git removal.
 * Caller owns the surrounding disposable root and must stop ProductionOwner
 * before close; incomplete raw drain deliberately preserves fixture files. */
export async function createWorkspaceCleanupGitFixture(paths: CleanupGitFixturePaths) {
  paths = { ...paths }
  if (process.platform !== 'linux') refuse('requires explicitly staged Linux system Git')
  const root = await realpath(paths.root), rootIdentity = directoryIdentity(root)
  if (root !== paths.root || [paths.profileRoot, paths.reposRoot, paths.workspaceRoot, paths.tempRoot].some(path => !isCleanupGitDescendant(root, path) || dirname(path) !== root)) refuse('foreign fixture roots')
  const sandbox = await mkdtemp(join(root, '.cleanup-git-'))
  const home = join(sandbox, 'home'), hooks = join(sandbox, 'empty-hooks'), temp = join(sandbox, 'tmp')
  const captured = new Map<string, string>([[sandbox, directoryIdentity(sandbox)]])
  for (const path of [home, hooks, temp, paths.reposRoot, paths.workspaceRoot]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    captured.set(path, directoryIdentity(path))
  }
  const globalConfig = join(home, 'empty.gitconfig')
  await writeFile(globalConfig, '', { flag: 'wx', mode: 0o600 })
  const git = await realpath('/usr/bin/git')
  await access(git, constants.X_OK)
  const gitInfo = lstatSync(git)
  if (!gitInfo.isFile() || gitInfo.isSymbolicLink() || gitInfo.size > 32 * 1024 * 1024) refuse('invalid system Git artifact')
  const gitSha256 = createHash('sha256').update(readFileSync(git)).digest('hex')
  const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, TMPDIR: temp, TEMP: temp, TMP: temp }
  const isolatedEnvironment = (base: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv => ({ ...base, ...environment,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: globalConfig, GIT_TEMPLATE_DIR: hooks, GIT_ALLOW_PROTOCOL: 'file', GIT_PROTOCOL_FROM_USER: '0',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks,
    GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '', GIT_CONFIG_KEY_2: 'commit.gpgSign', GIT_CONFIG_VALUE_2: 'false',
    GIT_AUTHOR_NAME: 'Disposable Cleanup Fixture', GIT_AUTHOR_EMAIL: 'cleanup-fixture@example.invalid', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'Disposable Cleanup Fixture', GIT_COMMITTER_EMAIL: 'cleanup-fixture@example.invalid', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' })
  const receipts: CleanupGitCommandReceipt[] = [], raw = new Set<Promise<void>>(), owners: GitProviderProcessOwner[] = [], holds: Gate[] = []
  const seeds = new Map<CleanupGitSeed, CleanupGitSeed>()
  let nextHold: Gate | null = null, closed = false, phase: 'seed' | 'verify' = 'seed', seeded = false, gitVersion: string | null = null
  let closeFailure: unknown
  const current = (): void => {
    if (closed || directoryIdentity(root) !== rootIdentity) refuse('fixture owner changed')
    for (const [path, identity] of captured) if (directoryIdentity(path) !== identity) refuse('captured fixture root changed')
  }
  const capture = (production: boolean): typeof execFile => ((file: string, args: string[], options: ExecFileOptions,
    callback: (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => void) => {
    current()
    if (file !== 'git' && file !== git || options.shell || typeof options.cwd !== 'string' || !isCleanupGitDescendant(root, options.cwd) || receipts.length >= CLEANUP_GIT_FIXTURE_LIMITS.commands) refuse('unowned Git command')
    const removal = production && args[0] === 'worktree' && args[1] === 'remove'
    // Production cleanup may only touch the seeded local bare/worktree pair.
    if (production && !removal) refuse('unexpected production Git operation')
    if (removal && ![...seeds.values()].some(seed => seed.worktrees.some(tree => options.cwd === tree.barePath && args.length === 4 && args[2] === tree.path && args[3] === '--force'))) refuse('foreign production removal')
    const receipt: CleanupGitCommandReceipt = { phase: production ? 'production' : phase, args: [...args], cwd: options.cwd, callbackReceived: false, callbackDelivered: false,
      childClosed: false, stdoutClosed: true, stderrClosed: true, exitCode: null, signal: null, success: false }
    receipts.push(receipt)
    const held = removal ? nextHold : null
    if (held) nextHold = null
    let deliver: (() => void) | undefined, resolve!: () => void
    const joined = new Promise<void>(done => { resolve = done }); raw.add(joined)
    const settle = (): void => {
      if (!receipt.callbackReceived || !receipt.childClosed || !receipt.stdoutClosed || !receipt.stderrClosed) return
      held?.enter()
      if (held && !held.released) return
      if (!receipt.callbackDelivered) { receipt.callbackDelivered = true; deliver!() }
      held?.listeners.delete(settle); raw.delete(joined); resolve()
    }
    held?.listeners.add(settle)
    let child: ReturnType<typeof execFile>
    try {
      child = execFile(git, args, { ...options, env: isolatedEnvironment(options.env), encoding: 'utf8', shell: false }, (error, stdout, stderr) => {
        receipt.callbackReceived = true; receipt.success = error === null
        deliver = () => callback(error, stdout, stderr); settle()
      })
    } catch (error) { held?.listeners.delete(settle); raw.delete(joined); resolve(); throw error }
    for (const [stream, key] of [[child.stdout, 'stdoutClosed'], [child.stderr, 'stderrClosed']] as const) {
      if (!stream) continue
      receipt[key] = stream.closed
      stream.once('close', () => { receipt[key] = true; settle() })
    }
    child.once('close', (code, signal) => { receipt.childClosed = true; receipt.exitCode = code; receipt.signal = signal; settle() })
    return child
  }) as typeof execFile
  const seedOwner = new GitProviderProcessOwner({ execFile: capture(false), home, cwd: sandbox, environment, worktreeRoots: [sandbox, paths.reposRoot, paths.workspaceRoot], assertCurrent: current,
    maxConcurrency: 1, commandTimeoutMs: CLEANUP_GIT_FIXTURE_LIMITS.timeoutMs })
  owners.push(seedOwner)
  const run = (cwd: string, args: string[]) => seedOwner.execWorktree('git', args, { cwd, timeout: CLEANUP_GIT_FIXTURE_LIMITS.timeoutMs, maxBuffer: CLEANUP_GIT_FIXTURE_LIMITS.outputBytes })
  const snapshot = () => ({ git: { path: git, version: gitVersion, sha256: gitSha256 }, started: receipts.length, callbacksReceived: receipts.filter(value => value.callbackReceived).length, callbacksDelivered: receipts.filter(value => value.callbackDelivered).length,
    childCloses: receipts.filter(value => value.childClosed).length, stdioCloses: receipts.reduce((sum, value) => sum + Number(value.stdoutClosed) + Number(value.stderrClosed), 0), rawPending: raw.size,
    successfulProductionRemovals: receipts.filter(value => value.phase === 'production' && value.success && value.callbackDelivered && value.childClosed && value.exitCode === 0).length,
    failedProductionRemovals: receipts.filter(value => value.phase === 'production' && value.callbackReceived && !value.success).length,
    owners: owners.map(owner => ({ children: owner.childCount, inflight: owner.inflightCount, queued: owner.queuedCount })), commands: receipts.map(value => ({ ...value, args: [...value.args] })) })
  return {
    gitProviderProcess(options: GitProviderProcessOwnerOptions): GitProviderProcessOwner {
      current()
      if (options.cwd !== paths.profileRoot || options.worktreeRoots?.length !== 2 || !options.worktreeRoots.includes(paths.reposRoot) || !options.worktreeRoots.includes(paths.workspaceRoot)) refuse('production roots mismatch')
      captured.set(paths.profileRoot, directoryIdentity(paths.profileRoot))
      const owner = new GitProviderProcessOwner({ ...options, execFile: capture(true), home, environment, fixture: undefined,
        // Preserve the real owner-wide readiness/epoch hook. Request guards
        // also run when no Git process is admitted, including finalization
        // after native observation refuses a replaced root. Fixture physical
        // roots are enforced by capture() at actual command admission instead.
        assertCurrent: options.assertCurrent })
      owners.push(owner); return owner
    },
    async seed(taskId: string): Promise<CleanupGitSeed> {
      current()
      if (seeded || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(taskId)) refuse('invalid or repeated task seed')
      seeded = true
      gitVersion = (await run(sandbox, ['--version'])).stdout.trim()
      if (!/^git version [0-9]+\.[0-9]+\.[0-9]+(?:[. -][A-Za-z0-9.-]+)?$/.test(gitVersion)) refuse('invalid system Git version receipt')
      const org = 'cleanup-fixture' as const, taskPath = join(paths.workspaceRoot, taskId), bareRoot = join(paths.reposRoot, org)
      if (existsSync(bareRoot)) refuse('existing repository namespace')
      await mkdir(bareRoot, { mode: 0o700 }); await mkdir(taskPath, { recursive: true, mode: 0o700 })
      captured.set(bareRoot, directoryIdentity(bareRoot))
      directoryIdentity(taskPath)
      const seed: CleanupGitSeed = { org, taskPath, repos: [], worktrees: [] }
      for (const name of ['alpha', 'beta']) {
        current()
        const source = join(sandbox, `source-${name}`), barePath = join(bareRoot, `${name}.git`), path = join(taskPath, name), branch = `cleanup-${taskId}-${name}`
        if (existsSync(path) || existsSync(barePath)) refuse('existing seed target')
        await run(sandbox, ['init', '--initial-branch=main', source])
        const file = 'cleanup-fixture.txt', content = `Committed ${name} repository fixture\nDistinct content and branch for actual cleanup proof.\n`
        await writeFile(join(source, file), content, { flag: 'wx', mode: 0o600 })
        await run(source, ['add', '--', file]); await run(source, ['commit', '--no-gpg-sign', '-m', `Seed disposable ${name} worktree`])
        // Both operands are new captured local paths. Protocol policy refuses
        // every network transport; no user repository or remote is consulted.
        await run(sandbox, ['clone', '--bare', '--no-hardlinks', '--', source, barePath])
        await run(barePath, ['worktree', 'add', '-b', branch, path, 'main'])
        const commit = (await run(path, ['rev-parse', 'HEAD'])).stdout.trim()
        if (!/^[a-f0-9]{40}$/.test(commit) || (await run(path, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim() !== branch || (await run(path, ['show', `HEAD:${file}`])).stdout !== content || readFileSync(join(path, file), 'utf8') !== content) refuse('committed worktree content mismatch')
        const metadata = worktreeRecords((await run(barePath, ['worktree', 'list', '--porcelain'])).stdout)
        if (!metadata.some(value => value.path === path && value.head === commit && value.branch === `refs/heads/${branch}`)) refuse('worktree membership missing')
        seed.repos.push({ fullName: `${org}/${name}`, defaultBranch: 'main' }); seed.worktrees.push({ barePath, path, branch, commit, file, content })
      }
      if (seed.worktrees[0].commit === seed.worktrees[1].commit) refuse('repositories did not retain distinct committed content')
      seeds.set(seed, { ...seed, repos: seed.repos.map(repo => ({ ...repo })), worktrees: seed.worktrees.map(tree => ({ ...tree })) }); return seed
    },
    async assertRemoved(seed: CleanupGitSeed): Promise<CleanupGitRemovalReceipt> {
      current(); const capturedSeed = seeds.get(seed); if (!capturedSeed) refuse('foreign seed receipt')
      phase = 'verify'
      let metadataEntriesRemoved = 0, pathsRemoved = 0
      for (const tree of capturedSeed.worktrees) {
        if (existsSync(tree.path)) refuse('worktree directory survived production cleanup')
        pathsRemoved++
        const metadata = worktreeRecords((await run(tree.barePath, ['worktree', 'list', '--porcelain'])).stdout)
        if (metadata.some(value => value.path === tree.path)) refuse('Git metadata survived production cleanup')
        if ((await run(tree.barePath, ['rev-parse', `refs/heads/${tree.branch}`])).stdout.trim() !== tree.commit) refuse('unrelated committed branch was changed')
        metadataEntriesRemoved++
        const removals = receipts.filter(value => value.phase === 'production' && value.cwd === tree.barePath && value.args[2] === tree.path)
        if (removals.length !== 1 || !removals[0].success || !removals[0].callbackDelivered || !removals[0].childClosed || !removals[0].stdoutClosed || !removals[0].stderrClosed || removals[0].exitCode !== 0) refuse('actual successful Git removal receipt missing')
      }
      const state = snapshot()
      if (state.rawPending || state.failedProductionRemovals || state.successfulProductionRemovals !== 2) refuse('raw Git work not acknowledged')
      return { worktrees: capturedSeed.worktrees.length, successfulProductionRemovals: state.successfulProductionRemovals, metadataEntriesRemoved, pathsRemoved,
        callbacksDelivered: state.callbacksDelivered, childCloses: state.childCloses, stdioCloses: state.stdioCloses, rawPending: state.rawPending }
    },
    holdNextRemoval(): { entered: Promise<void>; release(): void } {
      current(); if (nextHold) refuse('removal hold already armed')
      const held = gate(); holds.push(held); nextHold = held
      return { entered: held.entered, release: held.release }
    },
    snapshot,
    async close(): Promise<void> {
      if (closed) { if (closeFailure) throw closeFailure; return }
      for (const held of holds) held.release()
      await bounded((async () => { while (raw.size) await Promise.all([...raw]) })(), 'raw Git')
      await bounded((async () => {
        while (owners.some(owner => owner.childCount || owner.inflightCount || owner.queuedCount)) await new Promise<void>(done => setImmediate(done))
      })(), 'admitted owner')
      // No process signalling is performed by this helper. Normal owner close
      // runs only after every real callback, child and stdio receipt settled.
      for (const owner of owners) {
        await owner.close()
      }
      current(); closed = true
      try { await rm(sandbox, { recursive: true, force: false }) }
      catch (error) { closeFailure = error; throw error }
    }
  }
}
