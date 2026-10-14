import { execFile } from 'node:child_process'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { GitHubManager } from '../main/github-manager'
import { GitLabManager } from '../main/gitlab-manager'
import { ForgejoManager, type TeaLogin } from '../main/forgejo-manager'
import { GitProviderProcessOwner, GIT_PROVIDER_ENV_KEYS, type GitProviderProcessOwnerOptions } from '../main/git-provider-process-owner'
import { WorktreeDirectoryAuthority } from '../main/worktree-directory-authority'
import type { DatabaseManager } from '../main/database/manager'
import type { WorktreeHost } from '../main/worktree-manager-core'

export function productionForgejoCloneUrl(input: { fullName: string; cloneUrl?: string; login: TeaLogin }): string {
  if (!/^[A-Za-z0-9_.-]{1,255}\/[A-Za-z0-9_.-]{1,255}$/.test(input.fullName) || input.fullName.split('/').some(part => part === '.' || part === '..')) throw new Error('FORGEJO_CLONE_SCOPE_INVALID')
  const base = new URL(input.login.url)
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('FORGEJO_CLONE_SCOPE_INVALID')
  const address = input.cloneUrl ?? `${input.login.url.replace(/\/+$/, '')}/${input.fullName}.git`
  if (address.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(address)) throw new Error('FORGEJO_CLONE_SCOPE_INVALID')
  const sshHosts = new Set([base.hostname])
  if (input.login.sshHost) {
    const ssh = new URL(`ssh://${input.login.sshHost}`)
    if (ssh.username || ssh.password || ssh.search || ssh.hash || ssh.pathname && ssh.pathname !== '/') throw new Error('FORGEJO_CLONE_SCOPE_INVALID')
    sshHosts.add(ssh.hostname)
  }
  const scp = /^([A-Za-z0-9_.-]+)@([A-Za-z0-9.-]+):(.+)$/.exec(address)
  if (scp) {
    if (!['git', input.login.user].includes(scp[1]) || !sshHosts.has(scp[2]) || scp[3] !== `${input.fullName}.git`) throw new Error('FORGEJO_CLONE_SCOPE_INVALID')
    return address
  }
  const target = new URL(address)
  if (target.password || target.search || target.hash) throw new Error('FORGEJO_CLONE_SCOPE_INVALID')
  if (['https:', 'http:'].includes(target.protocol)) {
    if (target.username || target.origin !== base.origin || target.pathname !== `${base.pathname.replace(/\/+$/, '')}/${input.fullName}.git`) throw new Error('FORGEJO_CLONE_SCOPE_INVALID')
  } else if (target.protocol === 'ssh:') {
    if (!['git', input.login.user].includes(target.username) || !sshHosts.has(target.hostname) || target.pathname !== `/${input.fullName}.git` || target.port && Number(target.port) > 65535) throw new Error('FORGEJO_CLONE_SCOPE_INVALID')
  } else throw new Error('FORGEJO_CLONE_SCOPE_INVALID')
  return address
}

/** One actual CLI/account owner, shared by provider controls, task sources and
 * worktrees. Native ingress never supplies executable/env/cwd overrides. */
export function createProductionGitProviderOwner(input: {
  database: DatabaseManager; profileRoot: string; reposRoot: string; workspaceRoot: string; tempRoot: string
  assertCurrent(): void
  createProcess?(options: GitProviderProcessOwnerOptions): GitProviderProcessOwner
}) {
  input.assertCurrent()
  for (const path of [input.reposRoot, input.workspaceRoot]) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    const info = lstatSync(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('GIT_PROVIDER_ROOT_INVALID')
  }
  const directories = new WorktreeDirectoryAuthority([input.reposRoot, input.workspaceRoot], input.assertCurrent)
  const environment: NodeJS.ProcessEnv = {}
  for (const key of GIT_PROVIDER_ENV_KEYS) if (process.env[key] !== undefined) environment[key] = process.env[key]
  environment.TMPDIR = input.tempRoot; environment.TEMP = input.tempRoot; environment.TMP = input.tempRoot
  const options: GitProviderProcessOwnerOptions = { execFile, environment, home: realpathSync(homedir()), cwd: realpathSync(input.profileRoot),
    worktreeRoots: [realpathSync(input.reposRoot), realpathSync(input.workspaceRoot)], assertCurrent: input.assertCurrent }
  const processOwner = input.createProcess ? input.createProcess(options) : new GitProviderProcessOwner(options)
  if (!(processOwner instanceof GitProviderProcessOwner)) throw new Error('GIT_PROVIDER_OWNER_INVALID')
  processOwner.assertOpen()
  const github = new GitHubManager({ process: processOwner, assertCurrent: input.assertCurrent })
  const gitlab = new GitLabManager({ process: processOwner, assertCurrent: input.assertCurrent })
  const forgejo = new ForgejoManager(key => { input.assertCurrent(); return input.database.getSetting(key) }, {
    process: processOwner, assertCurrent: input.assertCurrent,
    async cloneBare(request) {
      input.assertCurrent()
      const address = productionForgejoCloneUrl(request), [org, repo] = request.fullName.split('/')
      if (request.barePath !== join(input.reposRoot, org, `${repo}.git`)) throw new Error('FORGEJO_CLONE_SCOPE_INVALID')
      directories.assertPath(request.barePath)
      const parent = dirname(request.barePath)
      directories.assertPath(parent)
      await processOwner.execWorktree('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!tea login helper', 'clone', '--bare', '--', address, request.barePath],
        { cwd: realpathSync(parent), timeout: 300000, env: { GIT_TERMINAL_PROMPT: '0' } })
      for (const args of [['config', '--add', 'credential.helper', ''], ['config', '--add', 'credential.helper', '!tea login helper'], ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']]) {
        input.assertCurrent(); directories.assertPath(request.barePath)
        await processOwner.execWorktree('git', args, { cwd: realpathSync(request.barePath) })
      }
    }
  })
  const exec: NonNullable<WorktreeHost['exec']> = async (program, args, options) => {
    input.assertCurrent()
    const cwd = options.cwd ?? input.reposRoot
    if (typeof cwd !== 'string') throw new Error('WORKTREE_PATH_UNAUTHORIZED')
    directories.assertPath(cwd)
    return processOwner.execWorktree(program, args, { cwd: realpathSync(cwd),
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}), ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
      ...('allowDiffExitOne' in options && options.allowDiffExitOne === true ? { allowDiffExitOne: true as const } : {}) })
  }
  return { github, gitlab, forgejo, processOwner, exec, assertPath: (path: string) => directories.assertPath(path) }
}
