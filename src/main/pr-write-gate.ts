import * as childProcess from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import type { DatabaseManager } from './database'
import type { TaskMcpScope } from './mcp-servers/task-management-core'
import { OPEN_DRAFT_PR_TOOL } from './mcp-servers/pr-write-tools'
import { authorizationRefusal, resolveTaskAuthorization } from './authorization'
import { normalizeRepoSlug, validateIssuePayload } from '../shared/issue-actions'

type PrWriteDb = Pick<DatabaseManager, 'db' | 'getTask' | 'getProjectRepos' | 'getWorkspaceDir'>
type CommandRunner = (command: 'git' | 'gh', args: string[], cwd: string) => Promise<string>

const defaultRunner: CommandRunner = (command, args, cwd) => new Promise((resolve, reject) => {
  childProcess.execFile(command, args, { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 60_000 }, (error, stdout) => {
    if (error) reject(error)
    else resolve(stdout)
  })
})

let runner: CommandRunner = defaultRunner
export function setPrWriteRunner(next: CommandRunner | null): void {
  runner = next ?? defaultRunner
}

function refusal(code: string, error: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: 'refused', code, error, ...extra }
}

function remoteMatches(remote: string, repo: string): boolean {
  const normalized = remote.trim().replace(/^git@github\.com:/i, 'https://github.com/').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase()
  return normalized === `https://github.com/${repo}`
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    throw new Error(`${label} returned malformed JSON.`)
  }
}

interface PullRequestView {
  url: string
  isDraft: boolean
  state?: string
  headRefOid: string
  baseRefName: string
}

async function findExisting(repo: string, branch: string, cwd: string): Promise<PullRequestView | null> {
  const rows = parseJson<PullRequestView[]>(await runner('gh', [
    'pr', 'list', '--repo', repo, '--head', branch, '--state', 'open',
    '--json', 'url,isDraft,state,headRefOid,baseRefName'
  ], cwd), 'gh pr list')
  if (!Array.isArray(rows)) throw new Error('gh pr list did not return an array.')
  if (rows.length > 1) throw new Error(`More than one open pull request uses branch ${branch}; resolve the ambiguity before retrying.`)
  return rows[0] ?? null
}

/** Adjacent-to-execution gate for one deliberately narrow PR-open operation. */
export async function handlePrWriteRoute(
  db: PrWriteDb,
  route: string,
  params: Record<string, unknown>,
  trustedScope?: TaskMcpScope
): Promise<unknown> {
  if (route !== `/${OPEN_DRAFT_PR_TOOL}`) return undefined
  const taskId = trustedScope?.taskId ?? trustedScope?.artifactTaskId ?? null
  if (!taskId) return refusal('task_scope_required', 'A signed coding-task scope is required; a Captain or raw HTTP caller cannot open a pull request.')
  const task = db.getTask(taskId)
  if (!task) return refusal('task_scope_required', 'The signed coding task no longer exists.')
  const projectId = task.project_id
  if (trustedScope?.projectId && trustedScope.projectId !== projectId) return refusal('cross_project_target', 'The signed task and project scopes do not match.')

  const repo = normalizeRepoSlug(params.repo)
  if (!repo) return refusal('repo_missing', 'repo must be a GitHub owner/name.')
  const projectRepo = db.getProjectRepos(projectId).find((entry) => entry.provider === 'github' && `${entry.org}/${entry.name}`.toLowerCase() === repo)
  if (!projectRepo) return refusal('repo_not_in_project', `${repo} is not a configured GitHub repository in this project.`)
  const assigned = task.repos ?? []
  if (!assigned.some((entry) => entry.toLowerCase() === repo || entry.toLowerCase() === projectRepo.name.toLowerCase())) {
    return refusal('repo_not_in_task', `The coding task is not assigned to ${repo}.`)
  }

  const initial = resolveTaskAuthorization(db, { taskId, projectId, action: 'github.pr.open', repo })
  if (!initial.allowed) return { status: 'refused', ...authorizationRefusal(initial) }

  const unexpected = Object.keys(params).filter((key) => !['repo', 'title', 'body', 'base'].includes(key))
  if (unexpected.length > 0) {
    return refusal('payload_rejected', `Unsupported pull-request argument: ${unexpected.sort().join(', ')}.`)
  }

  const title = typeof params.title === 'string' ? params.title.trim() : ''
  const body = typeof params.body === 'string' ? params.body : ''
  if (!title || title.length > 256 || /[\r\n]/.test(title)) return refusal('payload_rejected', 'title must be one line between 1 and 256 characters.')
  if (body.length > 20_000) return refusal('payload_rejected', 'body must be at most 20,000 characters.')
  const unsafePayload = validateIssuePayload({ title, body }, { requireTitle: true })
  if (unsafePayload) return refusal(unsafePayload.code, unsafePayload.message)

  const base = projectRepo.default_branch || 'main'
  if (params.base !== undefined && params.base !== base) return refusal('base_not_configured', `The PR base must be the configured branch ${base}.`)
  const workspace = db.getWorkspaceDir(taskId)
  const cwd = join(workspace, projectRepo.name)
  if (!existsSync(cwd) || !existsSync(join(cwd, '.git'))) return refusal('worktree_missing', `The task worktree for ${repo} is not available.`)

  try {
    const [head, branch, status, remote] = await Promise.all([
      runner('git', ['rev-parse', 'HEAD'], cwd),
      runner('git', ['branch', '--show-current'], cwd),
      runner('git', ['status', '--porcelain'], cwd),
      runner('git', ['remote', 'get-url', 'origin'], cwd)
    ])
    const headSha = head.trim()
    const branchName = branch.trim()
    if (!/^[0-9a-f]{40}$/i.test(headSha)) return refusal('head_invalid', 'The task worktree has no immutable 40-character Git head.')
    if (!branchName || ['main', 'master', base].includes(branchName)) return refusal('branch_invalid', 'Open a pull request only from a named non-base task branch.')
    if (status.trim()) return refusal('worktree_dirty', 'Commit the task worktree before opening its pull request.')
    if (!remoteMatches(remote, repo)) return refusal('repo_mismatch', `The worktree origin does not match ${repo}.`)
    await runner('git', ['merge-base', '--is-ancestor', `origin/${base}`, 'HEAD'], cwd)

    const existing = await findExisting(repo, branchName, cwd)
    if (existing) {
      if (existing.headRefOid !== headSha || existing.baseRefName !== base) return refusal('existing_pr_mismatch', 'An open PR for this branch targets another head or base; 21x will not alter it.')
      return { status: 'already_done', pr_url: existing.url, draft: existing.isDraft, head_sha: headSha, base }
    }

    const beforePush = resolveTaskAuthorization(db, { taskId, projectId, action: 'github.pr.open', repo })
    if (!beforePush.allowed) return { status: 'refused', ...authorizationRefusal(beforePush) }
    await runner('git', ['push', '--set-upstream', 'origin', 'HEAD'], cwd)

    const beforeCreate = resolveTaskAuthorization(db, { taskId, projectId, action: 'github.pr.open', repo })
    if (!beforeCreate.allowed) return { status: 'refused', ...authorizationRefusal(beforeCreate) }
    const recovered = await findExisting(repo, branchName, cwd)
    if (recovered) {
      if (recovered.headRefOid !== headSha || recovered.baseRefName !== base) return refusal('existing_pr_mismatch', 'An open PR appeared for another head or base; 21x stopped.')
      return { status: 'already_done', pr_url: recovered.url, draft: recovered.isDraft, head_sha: headSha, base }
    }

    const url = (await runner('gh', [
      'pr', 'create', '--draft', '--repo', repo, '--base', base, '--head', branchName,
      '--title', title, '--body', body
    ], cwd)).trim()
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url)) return refusal('unresolved', 'GitHub did not return a canonical pull-request URL; inspect the branch before retrying.')
    const verified = parseJson<PullRequestView>(await runner('gh', [
      'pr', 'view', url, '--json', 'url,isDraft,state,headRefOid,baseRefName'
    ], cwd), 'gh pr view')
    if (verified.url !== url || verified.state !== 'OPEN' || !verified.isDraft || verified.headRefOid !== headSha || verified.baseRefName !== base) {
      return refusal('verification_failed', 'GitHub did not confirm an open draft at the exact head and base. No further mutation was attempted.', { pr_url: url })
    }
    return { status: 'opened', pr_url: url, draft: true, head_sha: headSha, base }
  } catch (error) {
    return refusal('pr_open_failed', error instanceof Error ? error.message : String(error))
  }
}
