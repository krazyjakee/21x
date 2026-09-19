import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  PullRequestCheckState,
  PullRequestReviewDecision,
  PullRequestState,
  type PullRequestCheck,
  type PullRequestDetails
} from '../shared/artifacts'
import { mapGitHubStyleRepo, otherOwners, repoOwner, uniqueRepos } from './repo-providers'

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

/**
 * All GitHub operations go through the user's authenticated gh CLI. 20x never
 * logs in, reads, stores, or forwards GitHub credentials itself.
 */
export class GitHubManager {
  private async fetchAccessibleRepos(): Promise<GitHubRepo[]> {
    const { stdout } = await execFileAsync('gh', [
      'api', '--paginate',
      '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member'
    ], { maxBuffer: GH_API_MAX_BUFFER })

    return uniqueRepos(JSON.parse(stdout) as Record<string, unknown>[], mapGitHubStyleRepo)
  }

  async checkGhCli(): Promise<GhCliStatus> {
    try {
      await execFileAsync('gh', ['--version'])
    } catch {
      return { installed: false, authenticated: false }
    }

    try {
      const { stdout } = await execFileAsync('gh', ['auth', 'status', '--active'])
      const match = stdout.match(/Logged in to .+ account (\S+)/) ||
                    stdout.match(/account (\S+)/) ||
                    stdout.match(/as (\S+)/)
      return { installed: true, authenticated: true, username: match?.[1] }
    } catch (error: unknown) {
      // gh auth status exits with 1 when not authenticated, but may still output to stderr
      const execErr = error as { stderr?: string; stdout?: string }
      const output = execErr?.stderr || execErr?.stdout || ''
      if (output.includes('Logged in')) {
        const match = output.match(/account (\S+)/) || output.match(/as (\S+)/)
        return { installed: true, authenticated: true, username: match?.[1] }
      }
      return { installed: true, authenticated: false }
    }
  }

  async fetchUserOrgs(): Promise<string[]> {
    const [status, repos] = await Promise.all([
      this.checkGhCli(),
      this.fetchAccessibleRepos()
    ])
    return otherOwners(repos.map(repoOwner), status.username)
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
    const { stdout } = await execFileAsync('gh', [
      'pr', 'view', url,
      '--json',
      'url,number,title,body,state,isDraft,mergeStateStatus,reviewDecision,author,baseRefName,headRefName,additions,deletions,changedFiles,comments,reviews,createdAt,updatedAt,mergedAt,closedAt,statusCheckRollup'
    ], { maxBuffer: GH_API_MAX_BUFFER })
    const raw = JSON.parse(stdout) as RawPullRequestDetails

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

    const { stdout } = await execFileAsync('gh', [
      'api', '--paginate',
      `/repos/${owner}/${repo}/issues?${params.toString()}`
    ], { maxBuffer: 10 * 1024 * 1024 })

    const raw = JSON.parse(stdout) as GitHubIssue[]
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
    await execFileAsync('gh', args)
  }

  async addIssueComment(owner: string, repo: string, number: number, body: string): Promise<void> {
    await execFileAsync('gh', [
      'api', '-X', 'POST',
      `/repos/${owner}/${repo}/issues/${number}/comments`,
      '-f', `body=${body}`
    ])
  }

  async fetchRepoCollaborators(owner: string, repo: string): Promise<GitHubCollaborator[]> {
    const { stdout } = await execFileAsync('gh', [
      'api', '--paginate',
      `/repos/${owner}/${repo}/collaborators?per_page=100`
    ])
    return JSON.parse(stdout) as GitHubCollaborator[]
  }
}
