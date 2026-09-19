import { execFile } from 'child_process'
import { promisify } from 'util'
import type { GitHubCollaborator, GitHubIssue, GitHubRepo } from './github-manager'
import {
  PullRequestCheckState,
  PullRequestReviewDecision,
  PullRequestState,
  type PullRequestCheck,
  type PullRequestDetails
} from '../shared/artifacts'
import { FORGEJO_LOGIN_SETTING, mapGitHubStyleRepo, otherOwners, repoOwner, uniqueRepos } from './repo-providers'

export { FORGEJO_LOGIN_SETTING }

const execFileAsync = promisify(execFile)

const TEA_MAX_BUFFER = 10 * 1024 * 1024
const TEA_API_TIMEOUT = 30_000
const PAGE_LIMIT = 50
const MAX_PAGES = 40


/** Credential helper git invokes for HTTPS clone/fetch/push. tea answers with
 * the token it already stores, so 20x never reads or persists credentials. */
const TEA_CREDENTIAL_HELPER = '!tea login helper'

const FORGEJO_PULL_REQUEST_PATH = /^\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/?$/

export type TeaStatusCode =
  | 'ready'
  | 'not-installed'
  | 'no-login'
  | 'login-selection-required'
  | 'login-not-found'
  | 'unauthorized'
  | 'unreachable'
  | 'error'

export interface TeaLogin {
  name: string
  url: string
  sshHost: string
  user: string
  isDefault: boolean
}

export interface TeaCliStatus {
  installed: boolean
  authenticated: boolean
  username?: string
  /** Name of the tea login 20x is using (or would use once reachable). */
  login?: string
  serverUrl?: string
  logins: TeaLogin[]
  code: TeaStatusCode
  message?: string
}

export interface ForgejoBranchPullRequest {
  number: number
  url: string
  state: string
  title: string
  ciStatus: 'passing' | 'failing' | 'pending' | 'none'
}

export class ForgejoError extends Error {
  constructor(public code: TeaStatusCode, message: string, public httpStatus?: number) {
    super(message)
    this.name = 'ForgejoError'
  }
}

interface RawTeaLogin {
  name?: string
  url?: string
  ssh_host?: string
  user?: string
  default?: string | boolean
}

interface RawUser {
  login?: string
  username?: string
  avatar_url?: string
  html_url?: string
}

interface RawPullRequest {
  number?: number
  html_url?: string
  title?: string
  body?: string
  state?: string
  merged?: boolean
  draft?: boolean
  mergeable?: boolean
  user?: RawUser
  base?: { ref?: string }
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null }
  additions?: number
  deletions?: number
  changed_files?: number
  comments?: number
  created_at?: string
  updated_at?: string
  merged_at?: string | null
  closed_at?: string | null
}

interface RawReview {
  user?: RawUser | null
  state?: string
  dismissed?: boolean
}

interface RawCommitStatus {
  context?: string
  status?: string
  target_url?: string
}

interface RawCombinedStatus {
  state?: string
  statuses?: RawCommitStatus[] | null
}

interface RawIssue {
  number: number
  title: string
  body: string | null
  state: string
  assignees: { login: string }[] | null
  labels: { name: string }[] | null
  milestone: { due_on: string | null } | null
  pull_request?: unknown
  created_at: string
  updated_at: string
}

/** Parse "host[:port]" out of an HTTP(S) URL, an ssh:// URL, or scp-style
 * `git@host:owner/repo.git`. Returns lower-case values or null. */
export function parseRemote(remote: string): { host: string; hostname: string; path: string } | null {
  const trimmed = remote.trim()
  if (!trimmed) return null
  const scp = trimmed.match(/^[^@/\s]+@([^:/\s]+):(?!\/)(.+)$/)
  if (scp) {
    return { host: scp[1].toLowerCase(), hostname: scp[1].toLowerCase(), path: '/' + scp[2] }
  }
  try {
    const url = new URL(trimmed)
    return { host: url.host.toLowerCase(), hostname: url.hostname.toLowerCase(), path: url.pathname }
  } catch {
    return null
  }
}

/** Extract `owner/repo` from a remote URL path such as `/owner/repo.git`. */
function repoFromRemotePath(path: string): { owner: string; repo: string } | null {
  const parts = path.replace(/\.git\/?$/, '').split('/').filter(Boolean)
  if (parts.length < 2) return null
  return { owner: parts[parts.length - 2], repo: parts[parts.length - 1] }
}

function hostOf(value: string): { host: string; hostname: string } | null {
  if (!value) return null
  const parsed = parseRemote(value.includes('://') ? value : `ssh://${value}`)
  return parsed ? { host: parsed.host, hostname: parsed.hostname } : null
}

function mapCheckState(status?: string): PullRequestCheckState {
  switch ((status || '').toLowerCase()) {
    case 'success': return PullRequestCheckState.PASSED
    case 'skipped': return PullRequestCheckState.SKIPPED
    case 'failure':
    case 'error': return PullRequestCheckState.FAILED
    default: return PullRequestCheckState.PENDING
  }
}

function rollupCiStatus(statuses: RawCommitStatus[]): ForgejoBranchPullRequest['ciStatus'] {
  if (statuses.length === 0) return 'none'
  const states = statuses.map((s) => mapCheckState(s.status))
  if (states.includes(PullRequestCheckState.FAILED)) return 'failing'
  if (states.includes(PullRequestCheckState.PENDING)) return 'pending'
  return 'passing'
}

/** Gitea/Forgejo returns one commit status per context update; keep the latest
 * per context (the API lists newest first). */
function latestStatusPerContext(statuses: RawCommitStatus[] | null | undefined): RawCommitStatus[] {
  const byContext = new Map<string, RawCommitStatus>()
  for (const status of statuses || []) {
    const key = status.context || ''
    if (!byContext.has(key)) byContext.set(key, status)
  }
  return Array.from(byContext.values())
}

function mapReviewDecision(reviews: RawReview[]): PullRequestReviewDecision {
  const latestByUser = new Map<string, string>()
  for (const review of reviews) {
    if (review.dismissed) continue
    const state = (review.state || '').toUpperCase()
    if (state !== 'APPROVED' && state !== 'REQUEST_CHANGES') continue
    latestByUser.set(review.user?.login || '', state)
  }
  const states = Array.from(latestByUser.values())
  if (states.includes('REQUEST_CHANGES')) return PullRequestReviewDecision.CHANGES_REQUESTED
  if (states.includes('APPROVED')) return PullRequestReviewDecision.APPROVED
  return PullRequestReviewDecision.NONE
}

function mapPullRequestState(raw: RawPullRequest): PullRequestState {
  if (raw.merged) return PullRequestState.MERGED
  if (raw.state === 'closed') return PullRequestState.CLOSED
  return PullRequestState.OPEN
}

/**
 * Forgejo (and Gitea) integration driven entirely by the tea CLI. Server URLs
 * and tokens stay in tea's own config; 20x only remembers which tea login name
 * to use when several are configured.
 */
export class ForgejoManager {
  constructor(private getSetting: (key: string) => string | null | undefined = () => null) {}

  async isInstalled(): Promise<boolean> {
    try {
      await execFileAsync('tea', ['--version'])
      return true
    } catch {
      return false
    }
  }

  async listLogins(): Promise<TeaLogin[]> {
    const { stdout } = await execFileAsync('tea', ['login', 'list', '--output', 'json'], {
      maxBuffer: TEA_MAX_BUFFER,
      timeout: TEA_API_TIMEOUT
    })
    const text = stdout.trim()
    if (!text || !text.startsWith('[')) return []
    const raw = JSON.parse(text) as RawTeaLogin[]
    return raw
      .filter((login) => login.name && login.url)
      .map((login) => ({
        name: login.name as string,
        url: (login.url as string).replace(/\/+$/, ''),
        sshHost: login.ssh_host || '',
        user: login.user || '',
        isDefault: login.default === true || login.default === 'true'
      }))
  }

  /**
   * Picks the tea login 20x should use. A login chosen in 20x wins; otherwise a
   * sole login or tea's own default login is used. With several logins and no
   * default the user must choose explicitly.
   */
  resolveLogin(logins: TeaLogin[]): TeaLogin {
    if (logins.length === 0) {
      throw new ForgejoError('no-login', 'tea has no logins configured. Run `tea login add` in your terminal to connect a Forgejo server, then re-check.')
    }
    const selected = this.getSetting(FORGEJO_LOGIN_SETTING)
    if (selected) {
      const match = logins.find((login) => login.name === selected)
      if (match) return match
      throw new ForgejoError('login-not-found', `The tea login "${selected}" selected in 21x no longer exists. Choose one of: ${logins.map((login) => login.name).join(', ')}.`)
    }
    if (logins.length === 1) return logins[0]
    const teaDefault = logins.filter((login) => login.isDefault)
    if (teaDefault.length === 1) return teaDefault[0]
    throw new ForgejoError('login-selection-required', `Multiple tea logins are configured (${logins.map((login) => login.name).join(', ')}). Choose which one 21x should use.`)
  }

  private async getLogin(loginName?: string): Promise<TeaLogin> {
    const logins = await this.listLogins()
    if (loginName) {
      const match = logins.find((login) => login.name === loginName)
      if (!match) throw new ForgejoError('login-not-found', `tea login "${loginName}" does not exist. Run \`tea login list\` to see configured logins.`)
      return match
    }
    return this.resolveLogin(logins)
  }

  /**
   * Makes an authenticated API request through `tea api`. tea exits 0 even for
   * HTTP errors, so the status line (written to stderr by --include) is parsed
   * to surface authorization and not-found failures.
   */
  async api<T>(login: TeaLogin, endpoint: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
    const args = ['api', '--login', login.name, '--include']
    if (opts.method) args.push('--method', opts.method)
    if (opts.body !== undefined) args.push('--data', JSON.stringify(opts.body))
    args.push(endpoint)

    let stdout: string
    let stderr: string
    try {
      ({ stdout, stderr } = await execFileAsync('tea', args, { maxBuffer: TEA_MAX_BUFFER, timeout: TEA_API_TIMEOUT }))
    } catch (error) {
      throw this.classifyExecError(error, login)
    }

    const statusMatch = stderr.match(/HTTP\/[\d.]+\s+(\d{3})/)
    const status = statusMatch ? Number(statusMatch[1]) : 200
    if (status >= 400) {
      let detail = ''
      try { detail = (JSON.parse(stdout) as { message?: string }).message || '' } catch { detail = stdout.trim().slice(0, 200) }
      if (status === 401 || status === 403) {
        throw new ForgejoError('unauthorized', `${login.url} rejected tea login "${login.name}" (HTTP ${status}${detail ? `: ${detail}` : ''}). Refresh its token with \`tea login edit ${login.name}\` or re-add it with \`tea login add\`.`, status)
      }
      throw new ForgejoError('error', `Forgejo API ${opts.method || 'GET'} ${endpoint} failed with HTTP ${status}${detail ? `: ${detail}` : ''}`, status)
    }

    const text = stdout.trim()
    return (text ? JSON.parse(text) : undefined) as T
  }

  private classifyExecError(error: unknown, login: TeaLogin): ForgejoError {
    const execErr = error as { code?: string | number; killed?: boolean; stderr?: string; stdout?: string; message?: string }
    if (execErr?.code === 'ENOENT') {
      return new ForgejoError('not-installed', 'tea CLI is not installed or not on PATH.')
    }
    const output = `${execErr?.stderr || ''}${execErr?.stdout || ''}${execErr?.message || ''}`
    if (execErr?.killed || /dial tcp|connection refused|no such host|i\/o timeout|network is unreachable|context deadline exceeded|TLS handshake|certificate/i.test(output)) {
      return new ForgejoError('unreachable', `Could not reach ${login.url} for tea login "${login.name}". Check the server is running and reachable from this machine.`)
    }
    if (/does not exist/i.test(output)) {
      return new ForgejoError('login-not-found', `tea login "${login.name}" does not exist.`)
    }
    const firstLine = (execErr?.stderr || execErr?.message || 'tea command failed').trim().split('\n')[0]
    return new ForgejoError('error', firstLine)
  }

  private async paginate<T>(login: TeaLogin, path: string): Promise<T[]> {
    const separator = path.includes('?') ? '&' : '?'
    const results: T[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await this.api<T[] | null>(login, `${path}${separator}limit=${PAGE_LIMIT}&page=${page}`)
      if (!Array.isArray(batch) || batch.length === 0) break
      results.push(...batch)
      if (batch.length < PAGE_LIMIT) break
    }
    return results
  }

  async checkTeaCli(): Promise<TeaCliStatus> {
    if (!(await this.isInstalled())) {
      return {
        installed: false,
        authenticated: false,
        logins: [],
        code: 'not-installed',
        message: 'Forgejo features use the tea CLI. Install tea, run `tea login add` in your terminal, then re-check.'
      }
    }

    let logins: TeaLogin[] = []
    try {
      logins = await this.listLogins()
      const login = this.resolveLogin(logins)
      try {
        const user = await this.api<RawUser>(login, '/user')
        return {
          installed: true,
          authenticated: true,
          username: user?.login || user?.username || login.user || undefined,
          login: login.name,
          serverUrl: login.url,
          logins,
          code: 'ready'
        }
      } catch (error) {
        const err = error instanceof ForgejoError ? error : new ForgejoError('error', (error as Error).message)
        return { installed: true, authenticated: false, login: login.name, serverUrl: login.url, logins, code: err.code, message: err.message }
      }
    } catch (error) {
      const err = error instanceof ForgejoError ? error : new ForgejoError('error', (error as Error).message)
      return { installed: true, authenticated: false, logins, code: err.code, message: err.message }
    }
  }

  private async fetchAccessibleRepos(login: TeaLogin): Promise<GitHubRepo[]> {
    return uniqueRepos(await this.paginate<Record<string, unknown>>(login, '/user/repos'), mapGitHubStyleRepo)
  }

  private async currentUsername(login: TeaLogin): Promise<string> {
    const user = await this.api<RawUser>(login, '/user')
    return user?.login || user?.username || login.user
  }

  async fetchUsername(loginName?: string): Promise<string> {
    return this.currentUsername(await this.getLogin(loginName))
  }

  async fetchUserOrgs(loginName?: string): Promise<string[]> {
    const login = await this.getLogin(loginName)
    const [username, orgs, repos] = await Promise.all([
      this.currentUsername(login),
      this.paginate<{ username?: string; name?: string }>(login, '/user/orgs'),
      this.fetchAccessibleRepos(login)
    ])
    return otherOwners([...orgs.map((org) => org.username || org.name), ...repos.map(repoOwner)], username)
  }

  async fetchOrgRepos(org: string, loginName?: string): Promise<GitHubRepo[]> {
    const login = await this.getLogin(loginName)
    try {
      const raw = await this.paginate<Record<string, unknown>>(login, `/orgs/${encodeURIComponent(org)}/repos`)
      return raw.map(mapGitHubStyleRepo)
    } catch (error) {
      // Personal namespaces and collaborator-only owners are not orgs.
      if (!(error instanceof ForgejoError) || error.httpStatus !== 404) throw error
      const repos = await this.fetchAccessibleRepos(login)
      return repos.filter((repo) => repo.fullName.startsWith(`${org}/`))
    }
  }

  async fetchUserRepos(loginName?: string): Promise<GitHubRepo[]> {
    const login = await this.getLogin(loginName)
    const [username, repos] = await Promise.all([this.currentUsername(login), this.fetchAccessibleRepos(login)])
    return repos.filter((repo) => repo.fullName.startsWith(`${username}/`))
  }

  async fetchIssues(
    owner: string,
    repo: string,
    opts: { state?: string; assignee?: string; labels?: string; login?: string } = {}
  ): Promise<GitHubIssue[]> {
    const login = await this.getLogin(opts.login)
    const params = new URLSearchParams({ type: 'issues', state: opts.state || 'open' })
    if (opts.assignee) params.set('assigned_by', opts.assignee)
    if (opts.labels) params.set('labels', opts.labels)

    const raw = await this.paginate<RawIssue>(login, `/repos/${owner}/${repo}/issues?${params.toString()}`)
    return raw
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({ ...issue, assignees: issue.assignees || [], labels: issue.labels || [] }))
  }

  async updateIssue(
    owner: string,
    repo: string,
    number: number,
    data: { title?: string; body?: string; state?: string; assignees?: string[]; labels?: string[] },
    loginName?: string
  ): Promise<void> {
    const login = await this.getLogin(loginName)
    const { labels, ...fields } = data
    const body = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
    if (Object.keys(body).length > 0) {
      await this.api(login, `/repos/${owner}/${repo}/issues/${number}`, { method: 'PATCH', body })
    }
    // Forgejo edits labels through a dedicated endpoint that accepts names.
    if (labels) {
      await this.api(login, `/repos/${owner}/${repo}/issues/${number}/labels`, { method: 'PUT', body: { labels } })
    }
  }

  async addIssueComment(owner: string, repo: string, number: number, body: string, loginName?: string): Promise<void> {
    const login = await this.getLogin(loginName)
    await this.api(login, `/repos/${owner}/${repo}/issues/${number}/comments`, { method: 'POST', body: { body } })
  }

  async fetchRepoCollaborators(owner: string, repo: string, loginName?: string): Promise<GitHubCollaborator[]> {
    const login = await this.getLogin(loginName)
    const raw = await this.paginate<RawUser & { type?: string }>(login, `/repos/${owner}/${repo}/collaborators`)
    return raw.map((user) => ({ login: user.login || user.username || '', avatar_url: user.avatar_url || '', type: 'User' }))
  }

  /**
   * Finds the tea login serving a URL (web, clone, or SSH remote). Exact
   * host:port matches win, then hostname-only matches (SSH ports differ from
   * HTTP ports). Ties prefer the login selected in 20x.
   */
  async findLoginForUrl(url: string, logins?: TeaLogin[]): Promise<TeaLogin | null> {
    const target = parseRemote(url)
    if (!target) return null
    const all = logins || await this.listLogins()
    const exact = all.filter((login) => {
      const web = hostOf(login.url)
      const ssh = hostOf(login.sshHost)
      return web?.host === target.host || ssh?.host === target.host
    })
    const candidates = exact.length > 0
      ? exact
      : all.filter((login) => hostOf(login.url)?.hostname === target.hostname || hostOf(login.sshHost)?.hostname === target.hostname)
    if (candidates.length <= 1) return candidates[0] || null
    const selected = this.getSetting(FORGEJO_LOGIN_SETTING)
    return candidates.find((login) => login.name === selected) || candidates.find((login) => login.isDefault) || candidates[0]
  }

  /** True when the URL belongs to a server with a configured tea login. */
  async isForgejoUrl(url: string): Promise<boolean> {
    try {
      if (!(await this.isInstalled())) return false
      return (await this.findLoginForUrl(url)) !== null
    } catch {
      return false
    }
  }

  private async fetchChecks(login: TeaLogin, owner: string, repo: string, sha?: string): Promise<RawCommitStatus[]> {
    if (!sha) return []
    const combined = await this.api<RawCombinedStatus>(login, `/repos/${owner}/${repo}/commits/${sha}/status`)
    return latestStatusPerContext(combined?.statuses)
  }

  async fetchPullRequestDetails(url: string): Promise<PullRequestDetails> {
    const parsed = parseRemote(url.split(/[?#]/)[0])
    const match = parsed?.path.match(FORGEJO_PULL_REQUEST_PATH)
    if (!parsed || !match) throw new Error('A valid Forgejo pull request URL is required')
    const login = await this.findLoginForUrl(url)
    if (!login) throw new ForgejoError('no-login', `No tea login is configured for ${parsed.host}. Run \`tea login add\` for that server.`)

    const [, owner, repo, number] = match
    const raw = await this.api<RawPullRequest>(login, `/repos/${owner}/${repo}/pulls/${number}`)
    const [reviews, checks] = await Promise.all([
      this.api<RawReview[] | null>(login, `/repos/${owner}/${repo}/pulls/${number}/reviews`).catch(() => []),
      this.fetchChecks(login, owner, repo, raw.head?.sha).catch(() => [])
    ])
    const reviewList = reviews || []

    return {
      url: raw.html_url || url,
      repository: `${owner}/${repo}`,
      number: raw.number || Number(number),
      title: raw.title || `Pull request #${number}`,
      body: raw.body || '',
      state: mapPullRequestState(raw),
      isDraft: raw.draft === true,
      mergeStateStatus: raw.mergeable === false ? 'DIRTY' : undefined,
      reviewDecision: mapReviewDecision(reviewList),
      author: {
        login: raw.user?.login || 'unknown',
        avatarUrl: raw.user?.avatar_url || undefined,
        url: raw.user?.html_url || undefined
      },
      baseRefName: raw.base?.ref || '',
      headRefName: raw.head?.ref || '',
      additions: raw.additions || 0,
      deletions: raw.deletions || 0,
      changedFiles: raw.changed_files || 0,
      commentsCount: raw.comments || 0,
      reviewsCount: reviewList.length,
      createdAt: raw.created_at || '',
      updatedAt: raw.updated_at || '',
      mergedAt: raw.merged_at || undefined,
      closedAt: raw.closed_at || undefined,
      checks: checks.map((check): PullRequestCheck => ({
        name: check.context || 'Check',
        state: mapCheckState(check.status),
        url: check.target_url || undefined
      }))
    }
  }

  /**
   * Looks up the pull request whose head is `branch` in the repository behind
   * `remoteUrl`, plus the CI rollup of its head commit. Returns null when the
   * remote is not served by a tea login or no pull request exists.
   */
  async getBranchPullRequest(remoteUrl: string, branch: string): Promise<ForgejoBranchPullRequest | null> {
    const remote = parseRemote(remoteUrl)
    const target = remote ? repoFromRemotePath(remote.path) : null
    if (!target) return null
    const login = await this.findLoginForUrl(remoteUrl)
    if (!login) return null

    const { owner, repo } = target
    const findIn = async (state: string): Promise<RawPullRequest | undefined> => {
      const pulls = await this.api<RawPullRequest[] | null>(login, `/repos/${owner}/${repo}/pulls?state=${state}&sort=recentupdate&limit=${PAGE_LIMIT}`)
      return (pulls || []).find((pull) => pull.head?.ref === branch)
    }
    const pull = (await findIn('open')) || (await findIn('closed'))
    if (!pull?.number) return null

    const checks = await this.fetchChecks(login, owner, repo, pull.head?.sha).catch(() => [])
    return {
      number: pull.number,
      url: pull.html_url || '',
      state: mapPullRequestState(pull).toUpperCase(),
      title: pull.title || '',
      ciStatus: rollupCiStatus(checks)
    }
  }

  /**
   * Creates a bare clone authenticated by tea's git credential helper, and
   * configures the clone so later fetches/pushes from its worktrees keep using
   * tea rather than any credentials stored elsewhere.
   */
  async cloneBare(fullName: string, barePath: string, cloneUrl?: string): Promise<void> {
    const login = await this.getLogin()
    const url = cloneUrl || `${login.url}/${fullName}.git`
    console.log(`[ForgejoManager] Executing: git clone --bare ${url} ${barePath} (tea login "${login.name}")`)
    await execFileAsync('git', [
      '-c', 'credential.helper=',
      '-c', `credential.helper=${TEA_CREDENTIAL_HELPER}`,
      'clone', '--bare', url, barePath
    ], { timeout: 300_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

    // An empty helper entry resets helpers inherited from global config.
    await execFileAsync('git', ['config', '--add', 'credential.helper', ''], { cwd: barePath })
    await execFileAsync('git', ['config', '--add', 'credential.helper', TEA_CREDENTIAL_HELPER], { cwd: barePath })
    // `git clone --bare` does not set a fetch refspec, so origin/<branch>
    // tracking refs would never be created by `git fetch origin`.
    await execFileAsync('git', ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], { cwd: barePath })
  }
}
