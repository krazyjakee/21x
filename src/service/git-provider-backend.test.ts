import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { execFile, type ChildProcess, type ExecFileException } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { GitHubManager } from '../main/github-manager'
import { GitLabManager } from '../main/gitlab-manager'
import { ForgejoManager } from '../main/forgejo-manager'
import { GitProviderProcessOwner } from '../main/git-provider-process-owner'
import { FORGEJO_LOGIN_SETTING, REPO_PROVIDERS_SETTING } from '../main/repo-providers'
import { GIT_PROVIDER_CODECS, GIT_PROVIDER_OPERATIONS, GIT_PROVIDER_LIMITS, type GitProviderCodec, type GitProviderOperation } from '../shared/git-provider-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import type { DesktopCallerContext } from './transport/desktop-registry'
import { GitProviderBackend, type GitProviderBackendOptions, type GitProviderOwners } from './git-provider-backend'

interface Reply { stdout: string; stderr?: string; error?: ExecFileException }
class ControlledChild extends EventEmitter {
  readonly stdout = new PassThrough(); readonly stderr = new PassThrough()
  exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; killed = false
  kill = vi.fn(() => { this.killed = true; return true })
  constructor(readonly executable: string, readonly args: readonly string[], readonly callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) { super() }
  answered = false; closed = false
  answer(reply: Reply) { if (this.answered) return; this.answered = true; this.callback(reply.error ?? null, reply.stdout, reply.stderr ?? '') }
  finish() { if (this.closed) return; this.closed = true; this.exitCode = 0; this.stdout.end(); this.stderr.end(); this.stdout.destroy(); this.stderr.destroy(); this.emit('exit', 0, null); this.emit('close', 0, null) }
}
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'git-provider-fixture', webviewId: 'main', origin: 'app://git-provider-fixture' }
const rawRepo = (owner: string, name: string) => ({ name, full_name: `${owner}/${name}`, default_branch: 'main', clone_url: `https://github.com/${owner}/${name}.git`, description: 'Synthetic repository', private: true })
const logins = [{ name: 'personal', url: 'https://personal.example', ssh_host: 'personal.example', user: 'fixture', default: true }, { name: 'work', url: 'https://forgejo.example', ssh_host: 'forgejo.example:2222', user: 'fixture', default: false }]
let db: ReturnType<typeof createPortableTestDb>, processOwner: GitProviderProcessOwner, options: GitProviderBackendOptions, backend: GitProviderBackend, root: string
let children: ControlledChild[], execute: ReturnType<typeof vi.fn>, read: boolean, write: boolean, ownerValid: boolean
let hold: (child: ControlledChild) => boolean, replyFor: (executable: string, args: readonly string[]) => Reply
const queued = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
async function eventually(predicate: () => boolean): Promise<void> { for (let i = 0; i < 100 && !predicate(); i++) await queued(); expect(predicate()).toBe(true) }
function reply(executable: string, args: readonly string[]): Reply {
  if (args[0] === '--version') return { stdout: `${executable} fixture version` }
  if (executable === 'gh') {
    if (args[0] === 'auth') return { stdout: 'Logged in to github.com account fixture\nActive account: true' }
    if (args[0] === 'api') return { stdout: JSON.stringify([rawRepo('team', 'repo'), rawRepo('fixture', 'own')]) }
    if (args[0] === 'pr') return { stdout: JSON.stringify({ url: args[2], number: 3, title: 'Actual GitHub manager projection', body: 'Synthetic PR body', state: 'OPEN', author: { login: 'fixture' }, baseRefName: 'main', headRefName: 'feature', additions: 1, deletions: 0, changedFiles: 1, comments: [], reviews: [], createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z', statusCheckRollup: [{ name: 'Synthetic CI', state: 'SUCCESS', targetUrl: 'https://ci.example/run/3?token=PRIVATE-FIXTURE' }] }) }
  }
  if (executable === 'glab') {
    if (args[0] === 'auth') return { stdout: 'Logged in to gitlab.example as fixture' }
    if (args[0] === 'api') {
      const rows = [{ path: 'repo', path_with_namespace: 'team/subgroup/repo', default_branch: 'main', http_url_to_repo: 'https://gitlab.example/team/subgroup/repo.git', description: 'Nested GitLab namespace', visibility: 'private' }, { path: 'own', path_with_namespace: 'fixture/own', http_url_to_repo: 'https://gitlab.example/fixture/own.git', visibility: 'public' }]
      return { stdout: JSON.stringify(args[1]?.startsWith('/groups/') ? rows.slice(0, 1) : rows) }
    }
  }
  if (executable === 'tea') {
    if (args[0] === 'login') return { stdout: JSON.stringify(logins) }
    const endpoint = args.at(-1)!
    if (endpoint === '/user') return { stdout: JSON.stringify({ login: 'fixture' }) }
    if (endpoint.startsWith('/user/orgs')) return { stdout: JSON.stringify([{ username: 'team' }]) }
    if (endpoint.startsWith('/user/repos') || endpoint.startsWith('/orgs/')) return { stdout: JSON.stringify([rawRepo('team', 'repo'), rawRepo('fixture', 'own')].map(row => ({ ...row, clone_url: row.clone_url.replace('github.com', 'forgejo.example') }))) }
    if (endpoint.endsWith('/reviews')) return { stdout: JSON.stringify([{ user: { login: 'reviewer' }, state: 'APPROVED' }]) }
    if (endpoint.includes('/commits/')) return { stdout: JSON.stringify({ statuses: [{ context: 'Synthetic CI', status: 'success', target_url: 'https://ci.example/run/3?signature=PRIVATE-FIXTURE' }] }) }
    if (endpoint === '/repos/team/repo/pulls/3') return { stdout: JSON.stringify({ html_url: 'https://forgejo.example/team/repo/pulls/3', number: 3, title: 'Actual configured Forgejo projection', body: 'Synthetic Forgejo body', state: 'open', draft: false, user: { login: 'fixture' }, base: { ref: 'main' }, head: { ref: 'feature', sha: 'abc123' }, additions: 1, deletions: 0, changed_files: 1, comments: 0, created_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z' }) }
  }
  throw new Error('Unexpected controlled provider command')
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), '21x-git-provider-binding-')); const home = join(root, 'cli-home'); mkdirSync(home, { mode: 0o700 })
  db = createPortableTestDb(); children = []; read = write = ownerValid = true; hold = () => false; replyFor = reply
  execute = vi.fn((executable: string, args: readonly string[], _settings: unknown, callback: ControlledChild['callback']) => {
    const child = new ControlledChild(executable, [...args], callback); children.push(child)
    if (!hold(child)) queueMicrotask(() => { child.answer(replyFor(executable, args)); child.finish() })
    return child as unknown as ChildProcess
  })
  processOwner = new GitProviderProcessOwner({ execFile: execute as unknown as typeof execFile, home, cwd: root, environment: { PATH: '/fixture/bin' }, assertCurrent() { if (!ownerValid) throw new ServiceProtocolError('DISCONNECTED') }, maxConcurrency: 4 })
  const github = new GitHubManager({ process: processOwner }), gitlab = new GitLabManager({ process: processOwner }), forgejo = new ForgejoManager(key => db.getSetting(key), { process: processOwner })
  options = { database: db, github, gitlab, forgejo, processOwner, engineEpoch: caller.engineEpoch, assertAvailable() { if (!db.db.open) throw new ServiceProtocolError('DISCONNECTED') }, assertGitProviderOwners(owners: GitProviderOwners) { if (owners.database !== db || owners.github !== github || owners.gitlab !== gitlab || owners.forgejo !== forgejo || owners.processOwner !== processOwner || !ownerValid) throw new ServiceProtocolError('DISCONNECTED') }, isTrustedDesktop: identity => identity.origin === caller.origin && identity.webviewId === caller.webviewId, canManageGitProviders: (_identity, access) => access === 'read' ? read : write }
  backend = new GitProviderBackend(options)
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  read = write = ownerValid = true; hold = () => false
  for (const child of children) { if (!child.answered) child.answer(reply(child.executable, child.args)); child.finish() }
  await backend.close(); await processOwner.close(); db.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks()
})
async function call<K extends GitProviderOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = GIT_PROVIDER_CODECS[operation] as GitProviderCodec<K>, value = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
  expect(codec.validateWireResult(value)).toBe(true); return codec.decodeResult((value as { value?: JsonValue }).value)
}

describe('actual Git provider managers with a captured trusted process boundary', () => {
  it('binds exactly fifteen retained controls and projects actual manager status/repos/orgs for all providers', async () => {
    expect(Object.keys(backend.operationSchemas(caller))).toEqual([...GIT_PROVIDER_OPERATIONS])
    expect(await call('github:checkCli', [])).toEqual({ installed: true, authenticated: true, username: 'fixture' })
    expect(await call('gitlab:checkCli', [])).toEqual({ installed: true, authenticated: true, username: 'fixture' })
    expect(await call('forgejo:checkCli', [])).toMatchObject({ installed: true, authenticated: true, login: 'personal', code: 'ready' })
    expect(await call('github:fetchOrgs', [])).toEqual(['team']); expect(await call('gitlab:fetchOrgs', [])).toEqual(['team']); expect(await call('forgejo:fetchOrgs', [])).toEqual(['team'])
    expect(await call('github:fetchOrgRepos', ['team'])).toMatchObject([{ fullName: 'team/repo', isPrivate: true }])
    expect(await call('gitlab:fetchOrgRepos', ['team/subgroup'])).toMatchObject([{ fullName: 'team/subgroup/repo' }])
    expect(await call('forgejo:fetchOrgRepos', ['team'])).toEqual(expect.arrayContaining([expect.objectContaining({ fullName: 'team/repo' })]))
    expect(await call('github:fetchUserRepos', [])).toMatchObject([{ fullName: 'fixture/own' }]); expect(await call('gitlab:fetchUserRepos', [])).toMatchObject([{ fullName: 'fixture/own' }]); expect(await call('forgejo:fetchUserRepos', [])).toMatchObject([{ fullName: 'fixture/own' }])
    for (const invocation of execute.mock.calls) { expect(invocation[2]).toMatchObject({ cwd: root, env: { HOME: join(root, 'cli-home') } }); expect(JSON.stringify(invocation[2])).not.toContain('TASK_API_TOKEN') }
  })
  it('keeps the GitHub PR route and actual configured Forgejo selection, never calling an arbitrary server or GitLab PR', async () => {
    expect(await call('github:fetchPullRequestDetails', ['https://github.com/team/repo/pull/3'])).toMatchObject({ title: 'Actual GitHub manager projection', checks: [{ url: 'https://ci.example/run/3' }] })
    const before = children.length
    expect(await call('github:fetchPullRequestDetails', ['https://forgejo.example/team/repo/pulls/3'])).toMatchObject({ title: 'Actual configured Forgejo projection', reviewDecision: 'approved', checks: [{ url: 'https://ci.example/run/3' }] })
    expect(children.slice(before).every(child => child.executable === 'tea')).toBe(true)
    const unknown = children.length
    await expect(call('github:fetchPullRequestDetails', ['https://unknown.example/team/repo/pulls/3'])).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(children.slice(unknown).every(child => child.executable === 'tea' && child.args[0] !== 'api')).toBe(true)
    const after = children.length
    await expect(call('github:fetchPullRequestDetails', ['https://gitlab.example/team/repo/merge_requests/3'])).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' }); expect(children.length).toBe(after)
  })
  it('preserves honest missing-CLI status without reflecting executable/config errors', async () => {
    replyFor = () => ({ stdout: '', stderr: 'PRIVATE-FIXTURE /private/cli/config', error: Object.assign(new Error('Missing /private/cli'), { code: 'ENOENT' }) as ExecFileException })
    expect(await call('github:checkCli', [])).toEqual({ installed: false, authenticated: false })
    expect(await call('gitlab:checkCli', [])).toEqual({ installed: false, authenticated: false })
    const status = await call('forgejo:checkCli', [])
    expect(status).toMatchObject({ installed: false, authenticated: false, code: 'not-installed', message: 'The tea CLI is unavailable.' }); expect(JSON.stringify(status)).not.toContain('PRIVATE-FIXTURE'); expect(JSON.stringify(status)).not.toContain('/private/cli')
  })
  it('validates current actual tea login names before exactly one selected-login settings write', async () => {
    const setter = vi.spyOn(db, 'setSetting')
    expect(await call('forgejo:setLogin', ['work'])).toMatchObject({ login: 'work', serverUrl: 'https://forgejo.example/' })
    expect(setter).toHaveBeenCalledOnce(); expect(setter).toHaveBeenCalledWith(FORGEJO_LOGIN_SETTING, 'work')
    await expect(call('forgejo:setLogin', ['not-configured'])).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' }); expect(setter).toHaveBeenCalledOnce(); expect(db.getSetting(FORGEJO_LOGIN_SETTING)).toBe('work')
    await call('forgejo:setLogin', [null]); expect(db.getSetting(FORGEJO_LOGIN_SETTING)).toBe('')
  })
  it('updates the real finite provider map, preserves other entries, and retains void/idempotent behavior', async () => {
    db.setSetting(REPO_PROVIDERS_SETTING, JSON.stringify({ 'existing/repo': 'forgejo' })); const setter = vi.spyOn(db, 'setSetting')
    expect(await call('git:recordRepoProviders', [['team/subgroup/repo'], 'gitlab'])).toBeUndefined()
    expect(JSON.parse(db.getSetting(REPO_PROVIDERS_SETTING)!)).toEqual({ 'existing/repo': 'forgejo', 'team/subgroup/repo': 'gitlab' }); expect(setter).toHaveBeenCalledOnce()
    await call('git:recordRepoProviders', [['team/subgroup/repo'], 'gitlab']); expect(setter).toHaveBeenCalledOnce()
    db.setSetting(REPO_PROVIDERS_SETTING, '[]'); await expect(call('git:recordRepoProviders', [['other/repo'], 'github'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(db.getSetting(REPO_PROVIDERS_SETTING)).toBe('[]')
    db.setSetting(REPO_PROVIDERS_SETTING, 'x'.repeat(GIT_PROVIDER_LIMITS.providerMapBytes + 1)); await expect(call('git:recordRepoProviders', [['other/repo'], 'github'])).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' })
  })
  it('refuses missing grants, foreign WebViews/origins, stale epochs and manager owner mismatches before spawn/SQL', async () => {
    read = false; await expect(call('github:checkCli', [])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); await expect(call('forgejo:setLogin', ['work'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); read = true
    write = false; await expect(call('forgejo:setLogin', ['work'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); await expect(call('git:recordRepoProviders', [['team/repo'], 'github'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); write = true
    for (const identity of [{ ...caller, origin: 'https://foreign.example' }, { ...caller, webviewId: 'foreign' }]) await expect(call('github:fetchOrgs', [], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('github:checkCli', [], undefined, { ...caller, engineEpoch: 'old' })).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    expect(() => new GitProviderBackend({ ...options, github: new GitHubManager() })).toThrow()
    expect(execute).not.toHaveBeenCalled(); expect(db.getSetting(FORGEJO_LOGIN_SETTING)).toBeUndefined(); expect(db.getSetting(REPO_PROVIDERS_SETTING)).toBeUndefined()
  })
  it('retains cancelled/deadline raw work until callback and native close and never republishes or replays it', async () => {
    hold = () => true; const controller = new AbortController()
    const operation = call('github:fetchOrgRepos', ['team'], controller.signal), failed = operation.catch(error => error)
    await eventually(() => children.length === 1); const child = children[0]!
    child.answer(reply(child.executable, child.args)); controller.abort()
    await queued(); expect(backend.inflightCount).toBe(1); expect(child.kill).toHaveBeenCalled()
    await expect(backend.close(5)).rejects.toMatchObject({ code: 'TIMEOUT' }); expect(backend.inflightCount).toBe(1)
    child.finish(); expect(['CANCELLED', 'DISCONNECTED']).toContain((await failed as ServiceProtocolError).code)
    await backend.close(); expect(backend.inflightCount).toBe(0); expect(children).toHaveLength(1); expect(db.getSetting(REPO_PROVIDERS_SETTING)).toBeUndefined()
  })
  it('rechecks grants after raw close before nested CLI commands or a login selection write', async () => {
    hold = () => true
    const operation = call('forgejo:setLogin', ['work']), failed = operation.catch(error => error)
    await eventually(() => children.length === 1); write = false; children[0]!.answer(reply('tea', ['--version'])); children[0]!.finish()
    expect((await failed as ServiceProtocolError).code).toBe('INVALID_REQUEST'); expect(children).toHaveLength(1); expect(db.getSetting(FORGEJO_LOGIN_SETTING)).toBeUndefined()
  })
  it('keeps a rejected parallel manager branch owned until its accepted sibling actually closes', async () => {
    hold = child => child.executable === 'gh' && child.args[0] === '--version'
    replyFor = (executable, args) => executable === 'gh' && args[0] === 'api' ? { stdout: '', error: Object.assign(new Error('Synthetic API failure'), { code: 1 }) as ExecFileException } : reply(executable, args)
    const operation = call('github:fetchOrgs', []), failed = operation.catch(error => error)
    await eventually(() => children.length === 2 && children.some(child => child.args[0] === 'api' && child.closed))
    expect(backend.inflightCount).toBe(1)
    const sibling = children.find(child => child.args[0] === '--version')!; sibling.answer(reply(sibling.executable, sibling.args)); sibling.finish()
    expect(await failed).toMatchObject({ code: 'INTERNAL_ERROR' }); expect(backend.inflightCount).toBe(0); expect(children.every(child => child.closed)).toBe(true)
  })
  it('prevents a GitLab fallback from bypassing a grant withdrawn after a failed group request', async () => {
    hold = () => true
    const operation = call('gitlab:fetchOrgRepos', ['team/subgroup']), failed = operation.catch(error => error)
    await eventually(() => children.length === 1); const child = children[0]!; read = false
    child.answer({ stdout: '', error: Object.assign(new Error('PRIVATE-FIXTURE provider failure'), { code: 1 }) as ExecFileException }); child.finish()
    expect(await failed).toMatchObject({ code: 'INVALID_REQUEST' }); expect(children).toHaveLength(1); expect(child.args[1]).toContain('/groups/')
  })
  it('fences external configuration changes while actual CLI lookup is pending', async () => {
    hold = () => true; const operation = call('forgejo:setLogin', ['work']), failed = operation.catch(error => error)
    await eventually(() => children.length === 1); db.setSetting(FORGEJO_LOGIN_SETTING, 'personal'); children[0]!.answer(reply('tea', ['--version'])); children[0]!.finish()
    expect((await failed as ServiceProtocolError).code).toBe('INVALID_REQUEST'); expect(db.getSetting(FORGEJO_LOGIN_SETTING)).toBe('personal'); expect(children).toHaveLength(1)
  })
  it('caps sixteen accepted requests and one configuration mutation until their actual raw ownership ends', async () => {
    hold = () => true
    const pending = Array.from({ length: 16 }, () => call('github:fetchOrgRepos', ['team']).catch(error => error))
    await eventually(() => backend.inflightCount === 16); await expect(call('github:fetchOrgRepos', ['team'])).rejects.toMatchObject({ code: 'BACKPRESSURE' })
    backend.shutdown(); hold = () => false
    for (const child of children) { child.answer(reply(child.executable, child.args)); child.finish() }
    await Promise.all(pending); await backend.close(); expect(backend.inflightCount).toBe(0)
    // Separate actual backend retains the same captured owner; no new process.
    backend = new GitProviderBackend(options); hold = () => true
    const selecting = call('forgejo:setLogin', ['work']).catch(error => error)
    await eventually(() => backend.inflightCount === 1)
    await expect(call('git:recordRepoProviders', [['team/repo'], 'github'])).rejects.toMatchObject({ code: 'BACKPRESSURE' })
    backend.shutdown(); for (const child of children) { if (!child.answered) child.answer(reply(child.executable, child.args)); child.finish() }; await selecting; await backend.close()
    expect(db.getSetting(REPO_PROVIDERS_SETTING)).toBeUndefined()
  })
  it('refuses malformed/large manager projections and returns fixed errors without provider secret diagnostics', async () => {
    replyFor = (executable, args) => executable === 'gh' && args[0] === 'api' ? { stdout: JSON.stringify([rawRepo('team', 'repo'), { ...rawRepo('team', 'bad'), private: 'not-a-boolean' }]) } : reply(executable, args)
    await expect(call('github:fetchOrgRepos', ['team'])).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    replyFor = (executable, args) => {
      if (executable !== 'gh' || args[0] !== 'api') return reply(executable, args)
      const page = Number(new URL(`https://github.example${args[1]}`).searchParams.get('page')), start = (page - 1) * 100
      return { stdout: JSON.stringify(Array.from({ length: Math.max(0, Math.min(100, 260 - start)) }, (_, i) => ({ ...rawRepo('team', `r${start + i}`), description: 'é'.repeat(1800) }))) }
    }
    await expect(call('github:fetchOrgRepos', ['team'])).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    replyFor = (executable, args) => executable === 'gh' && args[0] === 'api' ? { stdout: '', error: Object.assign(new Error('PRIVATE-FIXTURE-TOKEN in /private/cli/config'), { code: 1, stderr: 'PRIVATE-FIXTURE-TOKEN', stdout: '' }) as ExecFileException } : reply(executable, args)
    const failure = await call('github:fetchOrgRepos', ['team']).catch(error => error)
    expect(failure).toMatchObject({ code: 'INTERNAL_ERROR' }); expect(String(failure)).not.toContain('PRIVATE-FIXTURE-TOKEN'); expect(String(failure)).not.toContain('/private/cli/config')
  })
})
