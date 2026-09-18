import { beforeEach, describe, expect, it, vi } from 'vitest'

type ExecResult = { stdout?: string; stderr?: string; error?: Error }
type ExecCallback = (error: Error | null, stdout?: string, stderr?: string) => void

const { execFileMock } = vi.hoisted(() => {
  const execFileMock = vi.fn()
  const customPromisify = Symbol.for('nodejs.util.promisify.custom')

  execFileMock[customPromisify] = (...args: unknown[]) => {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFileMock(...args, (error: Error | null, stdout = '', stderr = '') => {
        if (error) reject(error)
        else resolve({ stdout, stderr })
      })
    })
  }

  return { execFileMock }
})

vi.mock('child_process', () => ({
  execFile: execFileMock,
  spawn: vi.fn()
}))

import { ForgejoManager, parseRemote } from './forgejo-manager'
import { PullRequestCheckState, PullRequestReviewDecision, PullRequestState } from '../shared/artifacts'

interface ApiRoute { status?: number; body: unknown }

const LOCAL_LOGIN = { name: 'local', url: 'http://forge.lan:3000', ssh_host: 'forge.lan', user: 'alice', default: 'false' }
const WORK_LOGIN = { name: 'work', url: 'https://code.example.com', ssh_host: 'code.example.com', user: 'alice-w', default: 'false' }

/** Fake tea binary: `tea login list` returns `logins`, `tea api` resolves
 * endpoints from `routes` (keyed by "METHOD endpoint" or just "endpoint"). */
function fakeTea(opts: {
  installed?: boolean
  logins?: unknown[]
  routes?: Record<string, ApiRoute | ((login: string, body?: unknown) => ApiRoute)>
  apiError?: Error
  calls?: Array<{ file: string; args: string[] }>
}): void {
  execFileMock.mockImplementation((file: string, args: string[], optsOrCb: unknown, maybeCb?: ExecCallback) => {
    const callback = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as ExecCallback
    opts.calls?.push({ file, args })
    const reply = (result: ExecResult): void => {
      if (result.error) callback(result.error)
      else callback(null, result.stdout ?? '', result.stderr ?? '')
    }

    if (file === 'git') return reply({})
    if (opts.installed === false) {
      return reply({ error: Object.assign(new Error('spawn tea ENOENT'), { code: 'ENOENT' }) })
    }
    if (args[0] === '--version') return reply({ stdout: 'Version: 0.15.1' })
    if (args[0] === 'login' && args[1] === 'list') return reply({ stdout: JSON.stringify(opts.logins ?? [LOCAL_LOGIN]) })
    if (args[0] === 'api') {
      if (opts.apiError) return reply({ error: opts.apiError })
      const login = args[args.indexOf('--login') + 1]
      const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET'
      const body = args.includes('--data') ? JSON.parse(args[args.indexOf('--data') + 1]) : undefined
      const endpoint = args[args.length - 1]
      const path = endpoint.split('?')[0]
      const route = opts.routes?.[`${method} ${endpoint}`] ?? opts.routes?.[endpoint] ?? opts.routes?.[`${method} ${path}`] ?? opts.routes?.[path]
      const resolved = typeof route === 'function' ? route(login, body) : route
      const status = resolved?.status ?? (resolved ? 200 : 404)
      const payload = resolved ? resolved.body : { message: 'The target couldn\'t be found.' }
      return reply({ stdout: payload === undefined ? '' : JSON.stringify(payload), stderr: `HTTP/1.1 ${status} X\nContent-Type: application/json\n` })
    }
    reply({ error: new Error(`unexpected tea call: ${args.join(' ')}`) })
  })
}

function repo(fullName: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const [, name] = fullName.split('/')
  return { name, full_name: fullName, default_branch: 'main', clone_url: `http://forge.lan:3000/${fullName}.git`, description: '', private: true, ...extra }
}

describe('ForgejoManager', () => {
  let settings: Record<string, string>
  let manager: ForgejoManager

  beforeEach(() => {
    execFileMock.mockReset()
    settings = {}
    manager = new ForgejoManager((key) => settings[key])
  })

  describe('checkTeaCli', () => {
    it('reports a missing tea CLI', async () => {
      fakeTea({ installed: false })
      const status = await manager.checkTeaCli()
      expect(status).toMatchObject({ installed: false, authenticated: false, code: 'not-installed' })
      expect(status.message).toContain('tea login add')
    })

    it('reports missing logins', async () => {
      fakeTea({ logins: [] })
      expect(await manager.checkTeaCli()).toMatchObject({ installed: true, authenticated: false, code: 'no-login' })
    })

    it('uses the only login without asking and verifies it against the server', async () => {
      fakeTea({ routes: { '/user': { body: { login: 'alice' } } } })
      expect(await manager.checkTeaCli()).toMatchObject({
        installed: true,
        authenticated: true,
        username: 'alice',
        login: 'local',
        serverUrl: 'http://forge.lan:3000',
        code: 'ready'
      })
    })

    it('requires an explicit choice when several logins exist and tea has no default', async () => {
      fakeTea({ logins: [LOCAL_LOGIN, WORK_LOGIN] })
      const status = await manager.checkTeaCli()
      expect(status).toMatchObject({ authenticated: false, code: 'login-selection-required' })
      expect(status.logins.map((login) => login.name)).toEqual(['local', 'work'])
    })

    it('honours the login selected in 20x over tea\'s default', async () => {
      settings.forgejo_login = 'work'
      const calls: Array<{ file: string; args: string[] }> = []
      fakeTea({
        logins: [{ ...LOCAL_LOGIN, default: 'true' }, WORK_LOGIN],
        routes: { '/user': (login) => ({ body: { login: login === 'work' ? 'alice-w' : 'alice' } }) },
        calls
      })
      expect(await manager.checkTeaCli()).toMatchObject({ authenticated: true, login: 'work', username: 'alice-w' })
      expect(calls.find((call) => call.args[0] === 'api')?.args).toEqual(expect.arrayContaining(['--login', 'work']))
    })

    it('flags a selected login that no longer exists', async () => {
      settings.forgejo_login = 'gone'
      fakeTea({})
      expect(await manager.checkTeaCli()).toMatchObject({ authenticated: false, code: 'login-not-found' })
    })

    it('reports authorization failures with the rejected login', async () => {
      fakeTea({ routes: { '/user': { status: 401, body: { message: 'token is invalid' } } } })
      const status = await manager.checkTeaCli()
      expect(status).toMatchObject({ authenticated: false, code: 'unauthorized', login: 'local' })
      expect(status.message).toContain('tea login edit local')
    })

    it('reports an unreachable server', async () => {
      fakeTea({ apiError: Object.assign(new Error('Command failed'), { code: 1, stderr: 'Error: request failed: Get "http://forge.lan:3000/api/v1/user": dial tcp: connect: connection refused' }) })
      const status = await manager.checkTeaCli()
      expect(status).toMatchObject({ authenticated: false, code: 'unreachable' })
      expect(status.message).toContain('http://forge.lan:3000')
    })
  })

  describe('repositories', () => {
    it('paginates accessible repos and derives orgs excluding the user', async () => {
      const page1 = Array.from({ length: 50 }, (_, i) => repo(`alice/r${i}`))
      fakeTea({
        routes: {
          '/user': { body: { login: 'alice' } },
          '/user/orgs': { body: [{ username: 'team' }] },
          '/user/repos?limit=50&page=1': { body: page1 },
          '/user/repos?limit=50&page=2': { body: [repo('shared/tool')] }
        }
      })

      expect(await manager.fetchUserOrgs()).toEqual(['shared', 'team'])
      const userRepos = await manager.fetchUserRepos()
      expect(userRepos).toHaveLength(50)
      expect(userRepos[0]).toEqual({
        name: 'r0',
        fullName: 'alice/r0',
        defaultBranch: 'main',
        cloneUrl: 'http://forge.lan:3000/alice/r0.git',
        description: '',
        isPrivate: true
      })
    })

    it('lists org repos and falls back to accessible repos for non-org owners', async () => {
      fakeTea({
        routes: {
          '/orgs/team/repos': { body: [repo('team/app')] },
          '/user/repos': { body: [repo('bob/lib'), repo('alice/x')] }
        }
      })
      expect((await manager.fetchOrgRepos('team')).map((r) => r.fullName)).toEqual(['team/app'])
      expect((await manager.fetchOrgRepos('bob')).map((r) => r.fullName)).toEqual(['bob/lib'])
    })
  })

  describe('issues', () => {
    it('fetches issues through the given login, excluding pull requests and normalising nulls', async () => {
      const calls: Array<{ file: string; args: string[] }> = []
      fakeTea({
        logins: [LOCAL_LOGIN, WORK_LOGIN],
        calls,
        routes: {
          '/repos/team/app/issues': {
            body: [
              { number: 1, title: 'Bug', body: null, state: 'open', assignees: null, labels: null, milestone: null, created_at: '', updated_at: '' },
              { number: 2, title: 'PR', body: '', state: 'open', assignees: [], labels: [], milestone: null, pull_request: {}, created_at: '', updated_at: '' }
            ]
          }
        }
      })

      const issues = await manager.fetchIssues('team', 'app', { state: 'all', assignee: 'alice', labels: 'bug', login: 'work' })
      expect(issues).toHaveLength(1)
      expect(issues[0]).toMatchObject({ number: 1, assignees: [], labels: [] })
      const api = calls.find((call) => call.args[0] === 'api')!
      expect(api.args).toEqual(expect.arrayContaining(['--login', 'work']))
      expect(api.args.at(-1)).toContain('type=issues&state=all&assigned_by=alice&labels=bug')
    })

    it('patches issue fields and replaces labels through the labels endpoint', async () => {
      const bodies: Record<string, unknown> = {}
      fakeTea({
        routes: {
          'PATCH /repos/team/app/issues/3': (_login, body) => { bodies.patch = body; return { status: 201, body: {} } },
          'PUT /repos/team/app/issues/3/labels': (_login, body) => { bodies.labels = body; return { body: [] } },
          'POST /repos/team/app/issues/3/comments': (_login, body) => { bodies.comment = body; return { status: 201, body: {} } }
        }
      })

      await manager.updateIssue('team', 'app', 3, { state: 'closed', assignees: ['bob'], labels: ['bug'] })
      await manager.addIssueComment('team', 'app', 3, 'Done')
      expect(bodies).toEqual({
        patch: { state: 'closed', assignees: ['bob'] },
        labels: { labels: ['bug'] },
        comment: { body: 'Done' }
      })
    })

    it('surfaces API errors instead of silently succeeding', async () => {
      fakeTea({ routes: { 'PATCH /repos/team/app/issues/3': { status: 403, body: { message: 'forbidden' } } } })
      await expect(manager.updateIssue('team', 'app', 3, { state: 'closed' })).rejects.toMatchObject({ code: 'unauthorized', httpStatus: 403 })
    })
  })

  describe('pull requests and CI', () => {
    const pull = {
      number: 7,
      html_url: 'http://forge.lan:3000/team/app/pulls/7',
      title: 'Add feature',
      body: 'Body',
      state: 'open',
      merged: false,
      draft: false,
      user: { login: 'alice' },
      base: { ref: 'main' },
      head: { ref: 'feature', sha: 'abc123' },
      additions: 10,
      deletions: 2,
      changed_files: 3,
      comments: 1
    }

    it('maps pull request details, reviews, and commit statuses', async () => {
      fakeTea({
        logins: [LOCAL_LOGIN, WORK_LOGIN],
        routes: {
          '/repos/team/app/pulls/7': { body: pull },
          '/repos/team/app/pulls/7/reviews': { body: [{ user: { login: 'bob' }, state: 'REQUEST_CHANGES' }, { user: { login: 'bob' }, state: 'APPROVED' }] },
          '/repos/team/app/commits/abc123/status': {
            body: {
              statuses: [
                { context: 'ci/build', status: 'failure', target_url: 'http://forge.lan:3000/team/app/actions/runs/2' },
                { context: 'ci/build', status: 'success' },
                { context: 'ci/lint', status: 'pending' }
              ]
            }
          }
        }
      })

      const details = await manager.fetchPullRequestDetails('http://forge.lan:3000/team/app/pulls/7')
      expect(details).toMatchObject({
        repository: 'team/app',
        number: 7,
        state: PullRequestState.OPEN,
        reviewDecision: PullRequestReviewDecision.APPROVED,
        headRefName: 'feature',
        commentsCount: 1,
        reviewsCount: 2,
        checks: [
          { name: 'ci/build', state: PullRequestCheckState.FAILED, url: 'http://forge.lan:3000/team/app/actions/runs/2' },
          { name: 'ci/lint', state: PullRequestCheckState.PENDING }
        ]
      })
    })

    it('finds the pull request for a branch from an SSH remote and rolls up CI', async () => {
      fakeTea({
        routes: {
          '/repos/team/app/pulls': (_login) => ({ body: [{ ...pull, head: { ref: 'other' } }, pull] }),
          '/repos/team/app/commits/abc123/status': { body: { statuses: [{ context: 'ci', status: 'success' }] } }
        }
      })

      expect(await manager.getBranchPullRequest('ssh://git@forge.lan:2222/team/app.git', 'feature')).toEqual({
        number: 7,
        url: 'http://forge.lan:3000/team/app/pulls/7',
        state: 'OPEN',
        title: 'Add feature',
        ciStatus: 'passing'
      })
    })

    it('ignores remotes that no tea login serves', async () => {
      fakeTea({})
      expect(await manager.isForgejoUrl('https://github.com/a/b/pull/1')).toBe(false)
      expect(await manager.getBranchPullRequest('git@github.com:a/b.git', 'main')).toBeNull()
      expect(await manager.isForgejoUrl('http://forge.lan:3000/team/app/pulls/7')).toBe(true)
    })
  })

  describe('cloneBare', () => {
    it('clones with tea as the only credential helper and configures the fetch refspec', async () => {
      const calls: Array<{ file: string; args: string[] }> = []
      fakeTea({ calls })
      await manager.cloneBare('team/app', '/tmp/repos/team/app.git')

      const gitCalls = calls.filter((call) => call.file === 'git').map((call) => call.args)
      expect(gitCalls[0]).toEqual([
        '-c', 'credential.helper=',
        '-c', 'credential.helper=!tea login helper',
        'clone', '--bare', 'http://forge.lan:3000/team/app.git', '/tmp/repos/team/app.git'
      ])
      expect(gitCalls).toContainEqual(['config', '--add', 'credential.helper', ''])
      expect(gitCalls).toContainEqual(['config', '--add', 'credential.helper', '!tea login helper'])
      expect(gitCalls).toContainEqual(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'])
    })
  })
})

describe('parseRemote', () => {
  it('parses HTTP, ssh://, and scp-style remotes', () => {
    expect(parseRemote('http://forge.lan:3000/team/app.git')).toEqual({ host: 'forge.lan:3000', hostname: 'forge.lan', path: '/team/app.git' })
    expect(parseRemote('ssh://git@forge.lan:222/team/app.git')).toEqual({ host: 'forge.lan:222', hostname: 'forge.lan', path: '/team/app.git' })
    expect(parseRemote('git@forge.lan:team/app.git')).toEqual({ host: 'forge.lan', hostname: 'forge.lan', path: '/team/app.git' })
    expect(parseRemote('')).toBeNull()
  })
})
