import { execFile, type ExecFileOptions } from 'child_process'
import { GitProviderProcessOwner, GitProviderProcessError, type GitProviderManagerHost } from './git-provider-process-owner'
import { promisify } from 'util'
import {
  PullRequestCheckState,
  PullRequestReviewDecision,
  PullRequestState,
  type PullRequestCheck,
  type PullRequestDetails
} from '../shared/artifacts'

const execFileAsync = promisify(execFile)

const GH_API_MAX_BUFFER = 10 * 1024 * 1024
const GITHUB_PULL_REQUEST_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i

export interface GhCliStatus {
  installed: boolean
  authenticated: boolean
  username?: string
}

export interface GitHubRepo {
  name: string
  fullName: string
  defaultBranch: string
  cloneUrl: string
  description: string
  isPrivate: boolean
}

export interface GitHubIssue {
  number: number
  title: string
  body: string | null
  state: string
  assignees: { login: string }[]
  labels: { name: string }[]
  milestone: { due_on: string | null } | null
  pull_request?: unknown
  created_at: string
  updated_at: string
}

export interface GitHubCollaborator {
  login: string
  avatar_url: string
  type: string
}

interface RawPullRequestCheck {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
  detailsUrl?: string
  targetUrl?: string
}

interface RawPullRequestDetails {
  url?: string
  number?: number
  title?: string
  body?: string
  state?: string
  isDraft?: boolean
  mergeStateStatus?: string
  reviewDecision?: string
  author?: { login?: string; avatarUrl?: string; url?: string }
  baseRefName?: string
  headRefName?: string
  additions?: number
  deletions?: number
  changedFiles?: number
  comments?: unknown[]
  reviews?: unknown[]
  createdAt?: string
  updatedAt?: string
  mergedAt?: string
  closedAt?: string
  statusCheckRollup?: RawPullRequestCheck[]
}

function mapPullRequestState(value?: string): PullRequestState {
  if (value?.toUpperCase() === 'MERGED') return PullRequestState.MERGED
  if (value?.toUpperCase() === 'CLOSED') return PullRequestState.CLOSED
  return PullRequestState.OPEN
}

function mapReviewDecision(value?: string): PullRequestReviewDecision {
  switch (value?.toUpperCase()) {
    case 'APPROVED': return PullRequestReviewDecision.APPROVED
    case 'CHANGES_REQUESTED': return PullRequestReviewDecision.CHANGES_REQUESTED
    case 'REVIEW_REQUIRED': return PullRequestReviewDecision.REVIEW_REQUIRED
    default: return PullRequestReviewDecision.NONE
  }
}

function mapCheckState(check: RawPullRequestCheck): PullRequestCheckState {
  const value = (check.conclusion || check.state || check.status || '').toUpperCase()
  if (['SUCCESS'].includes(value)) return PullRequestCheckState.PASSED
  if (['NEUTRAL', 'SKIPPED'].includes(value)) return PullRequestCheckState.SKIPPED
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(value)) {
    return PullRequestCheckState.FAILED
  }
  return PullRequestCheckState.PENDING
}

function mapPullRequestCheck(check: RawPullRequestCheck): PullRequestCheck {
  return {
    name: check.name || check.context || 'Check',
    state: mapCheckState(check),
    url: check.detailsUrl || check.targetUrl || undefined
  }
}

function parseActiveGhAccount(output: string): string | undefined | null {
  const accounts: Array<{ authenticated: boolean; username?: string; active?: boolean }> = []
  let account: (typeof accounts)[number] | undefined

  for (const line of output.split(/\r?\n/)) {
    const loggedIn = line.match(/Logged in to \S+ (?:account|as) (\S+)/)
    if (loggedIn) {
      account = { authenticated: true, username: loggedIn[1] }
      accounts.push(account)
      continue
    }

    if (/(?:Failed|Timeout trying) to log in to \S+/.test(line)) {
      account = { authenticated: false }
      accounts.push(account)
      continue
    }

    const active = line.match(/Active account:\s*(true|false)/)
    if (active && account) account.active = active[1] === 'true'
  }

  const hasActiveMarkers = accounts.some((entry) => entry.active !== undefined)
  const selected = hasActiveMarkers
    ? accounts.find((entry) => entry.active === true)
    : accounts.find((entry) => entry.authenticated)

  return selected?.authenticated ? selected.username : null
}

/**
 * GitHub operations use the user's authenticated gh CLI. The portable owner
 * preserves only finite host-captured CLI auth environment; credential values
 * are never projected to the renderer, logged, or persisted by this manager.
 */
export class GitHubManager {
  constructor(private readonly host?: GitProviderManagerHost) {
    if (!host) return
    if (!(host.process instanceof GitProviderProcessOwner)) throw new GitProviderProcessError('GIT_PROVIDER_INVALID_OPTIONS')
    for (const name of ['checkGhCli','fetchUserOrgs','fetchOrgRepos','fetchUserRepos','fetchPullRequestDetails','fetchIssues','updateIssue','addIssueComment','fetchRepoCollaborators'] as const) {
      const original = this[name].bind(this) as (...args: unknown[]) => Promise<unknown>
      ;(this as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name] = (...args) => {
        try { this.current(); return host.process.retain(original(...args).then(value => { this.current(); return value }).catch(cause => { this.current(); if (cause instanceof GitProviderProcessError) throw cause; throw new GitProviderProcessError('GIT_PROVIDER_INVALID_RESULT') })) }
        catch (cause) { return Promise.reject(cause) }
      }
    }
  }
  assertOwners(owner: GitProviderProcessOwner): void { if (!this.host || this.host.process !== owner) throw new GitProviderProcessError('GIT_PROVIDER_INVALID_OPTIONS'); owner.assertOpen() }
  withRequestGuard<T>(effect: () => T | Promise<T>, guard: () => void, signal?: AbortSignal): Promise<T> {
    if (!this.host) return Promise.reject(new GitProviderProcessError('GIT_PROVIDER_INVALID_OPTIONS'))
    return this.host.process.withRequestGuard(effect, guard, signal)
  }
  private current(): void { this.host?.process.assertCurrent(); this.host?.assertCurrent?.() }
  private async exec(command: 'gh', args: string[], options?: ExecFileOptions): Promise<{ stdout: string; stderr: string }> {
    if (!this.host) {
      const result = options ? await execFileAsync(command, args, options) : await execFileAsync(command, args)
      return { stdout: String(result.stdout), stderr: String(result.stderr) }
    }
    this.current()
    const result = await this.host.process.exec(command, args, { maxBuffer: options?.maxBuffer ?? (args[0] === 'api' || args[0] === 'pr' ? GH_API_MAX_BUFFER : 65536), timeout: options?.timeout, allowNonzero: args[0] === 'auth' && args[1] === 'status' })
    this.current(); return result
  }
  private array<T>(stdout: string): T[] {
    const raw = JSON.parse(stdout) as T[]
    if (this.host && (!Array.isArray(raw) || raw.length > 4096)) throw new GitProviderProcessError('GIT_PROVIDER_INVALID_RESULT')
    return raw
  }
  private async paginate<T>(path: string): Promise<T[]> {
    const results: T[] = []; let bytes = 0
    for (let page = 1; page <= 40; page++) {
      this.current()
      const { stdout } = await this.exec('gh', ['api', `${path}${path.includes('?') ? '&' : '?'}page=${page}`], { maxBuffer: GH_API_MAX_BUFFER })
      bytes += Buffer.byteLength(stdout, 'utf8')
      const batch = this.array<T>(stdout)
      if (batch.length > 100 || results.length + batch.length > 4096 || bytes > GH_API_MAX_BUFFER) throw new GitProviderProcessError('GIT_PROVIDER_INVALID_RESULT')
      results.push(...batch)
      if (batch.length < 100) return results
    }
    throw new GitProviderProcessError('GIT_PROVIDER_INVALID_RESULT')
  }

  private mapRepo(raw: Record<string, unknown>): GitHubRepo {
    return {
      name: raw.name as string,
      fullName: raw.full_name as string,
      defaultBranch: (raw.default_branch as string) || 'main',
      cloneUrl: raw.clone_url as string,
      description: (raw.description as string) || '',
      isPrivate: raw.private as boolean
    }
  }

  private async fetchAccessibleRepos(): Promise<GitHubRepo[]> {
    const path = '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member'
    let raw: Record<string, unknown>[]
    if (this.host) raw = await this.paginate<Record<string, unknown>>(path)
    else {
      const { stdout } = await this.exec('gh', ['api', '--paginate', path], { maxBuffer: GH_API_MAX_BUFFER })
      raw = JSON.parse(stdout) as Record<string, unknown>[]
    }
    const deduped = new Map<string, GitHubRepo>()

    for (const repo of raw) {
      const mapped = this.mapRepo(repo)
      deduped.set(mapped.fullName, mapped)
    }

    return Array.from(deduped.values())
  }

  async checkGhCli(): Promise<GhCliStatus> {
    try {
      await this.exec('gh', ['--version'])
    } catch (cause) {
      this.current()
      if (this.host && (!(cause instanceof GitProviderProcessError) || cause.code !== 'GIT_PROVIDER_CLI_MISSING')) throw cause
      return { installed: false, authenticated: false }
    }

    // Older gh versions do not support `--active`, so parse the full status output instead.
    // Some versions write status to stderr, and a stale inactive account can make it exit 1.
    let output: string
    try {
      const { stdout, stderr } = await this.exec('gh', ['auth', 'status', '--hostname', 'github.com'])
      output = `${stdout}\n${stderr}`
    } catch (error: unknown) {
      this.current()
      if (this.host) throw error
      const execErr = error as { stderr?: string; stdout?: string }
      output = `${execErr?.stdout || ''}\n${execErr?.stderr || ''}`
    }

    const username = parseActiveGhAccount(output)
    if (username === null) return { installed: true, authenticated: false }
    return { installed: true, authenticated: true, username }
  }

  async fetchUserOrgs(): Promise<string[]> {
    const [status, repos] = await Promise.all([
      this.checkGhCli(),
      this.fetchAccessibleRepos()
    ])

    const owners = new Set<string>()
    for (const repo of repos) {
      const [owner] = repo.fullName.split('/')
      if (owner && owner !== status.username) {
        owners.add(owner)
      }
    }

    return Array.from(owners).sort((left, right) => left.localeCompare(right))
  }

  async fetchOrgRepos(org: string): Promise<GitHubRepo[]> {
    const repos = await this.fetchAccessibleRepos()
    return repos.filter((repo) => repo.fullName.startsWith(`${org}/`))
  }

  async fetchUserRepos(): Promise<GitHubRepo[]> {
    const status = await this.checkGhCli()
    if (!status.username) return []

    const repos = await this.fetchAccessibleRepos()
    return repos.filter((repo) => repo.fullName.startsWith(`${status.username}/`))
  }

  async fetchPullRequestDetails(url: string): Promise<PullRequestDetails> {
    const match = url.match(GITHUB_PULL_REQUEST_URL)
    if (!match) throw new Error('A valid GitHub pull request URL is required')

    const [, owner, repo, number] = match
    const { stdout } = await this.exec('gh', [
      'pr', 'view', url,
      '--json',
      'url,number,title,body,state,isDraft,mergeStateStatus,reviewDecision,author,baseRefName,headRefName,additions,deletions,changedFiles,comments,reviews,createdAt,updatedAt,mergedAt,closedAt,statusCheckRollup'
    ], { maxBuffer: GH_API_MAX_BUFFER })
    const raw = JSON.parse(stdout) as RawPullRequestDetails
    if (this.host && (!raw || typeof raw !== 'object' || Array.isArray(raw) || [raw.comments, raw.reviews, raw.statusCheckRollup].some(value => value !== undefined && (!Array.isArray(value) || value.length > 4096)))) throw new GitProviderProcessError('GIT_PROVIDER_INVALID_RESULT')

    return {
      url: raw.url || url,
      repository: `${owner}/${repo}`,
      number: raw.number || Number(number),
      title: raw.title || `Pull request #${number}`,
      body: raw.body || '',
      state: mapPullRequestState(raw.state),
      isDraft: raw.isDraft === true,
      mergeStateStatus: raw.mergeStateStatus || undefined,
      reviewDecision: mapReviewDecision(raw.reviewDecision),
      author: {
        login: raw.author?.login || 'unknown',
        avatarUrl: raw.author?.avatarUrl || undefined,
        url: raw.author?.url || undefined
      },
      baseRefName: raw.baseRefName || '',
      headRefName: raw.headRefName || '',
      additions: raw.additions || 0,
      deletions: raw.deletions || 0,
      changedFiles: raw.changedFiles || 0,
      commentsCount: raw.comments?.length || 0,
      reviewsCount: raw.reviews?.length || 0,
      createdAt: raw.createdAt || '',
      updatedAt: raw.updatedAt || '',
      mergedAt: raw.mergedAt || undefined,
      closedAt: raw.closedAt || undefined,
      checks: (raw.statusCheckRollup || []).map(mapPullRequestCheck)
    }
  }

  async fetchIssues(
    owner: string,
    repo: string,
    opts: { state?: string; assignee?: string; labels?: string } = {}
  ): Promise<GitHubIssue[]> {
    const params = new URLSearchParams({
      per_page: '100',
      state: opts.state || 'open'
    })
    if (opts.assignee) params.set('assignee', opts.assignee)
    if (opts.labels) params.set('labels', opts.labels)

    const path = `/repos/${owner}/${repo}/issues?${params.toString()}`
    let raw: GitHubIssue[]
    if (this.host) raw = await this.paginate<GitHubIssue>(path)
    else {
      const { stdout } = await this.exec('gh', ['api', '--paginate', path], { maxBuffer: GH_API_MAX_BUFFER })
      raw = JSON.parse(stdout) as GitHubIssue[]
    }
    // Filter out pull requests (GitHub issues API includes them)
    return raw.filter((issue) => !issue.pull_request)
  }

  async updateIssue(
    owner: string,
    repo: string,
    number: number,
    data: { title?: string; body?: string; state?: string; assignees?: string[]; labels?: string[] }
  ): Promise<void> {
    const args = ['api', '-X', 'PATCH', `/repos/${owner}/${repo}/issues/${number}`]
    for (const [key, val] of Object.entries(data)) {
      if (val === undefined) continue
      if (Array.isArray(val)) {
        // Use --raw-field for JSON arrays
        args.push('--raw-field', `${key}=${JSON.stringify(val)}`)
      } else {
        args.push('-f', `${key}=${val}`)
      }
    }
    await this.exec('gh', args)
  }

  async addIssueComment(owner: string, repo: string, number: number, body: string): Promise<void> {
    await this.exec('gh', [
      'api', '-X', 'POST',
      `/repos/${owner}/${repo}/issues/${number}/comments`,
      '-f', `body=${body}`
    ])
  }

  async fetchRepoCollaborators(owner: string, repo: string): Promise<GitHubCollaborator[]> {
    const path = `/repos/${owner}/${repo}/collaborators?per_page=100`
    if (this.host) return this.paginate<GitHubCollaborator>(path)
    const { stdout } = await this.exec('gh', ['api', '--paginate', path])
    return JSON.parse(stdout) as GitHubCollaborator[]
  }
}
