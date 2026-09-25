/**
 * Merging pull requests for a project's Captain: the main-process side of its
 * `merge_pull_request` tool (answered in captain-github-tools.ts).
 *
 * Merging is done here, never by the model. {@link performMerge} reads the PR
 * from GitHub and refuses unless it is open, not a draft, every check passed
 * and GitHub reports branch protection satisfied (`mergeStateStatus` CLEAN or
 * HAS_HOOKS, no review required or changes requested), and unless the latest
 * verified 21x review of that exact head asks for changes. The merge command
 * is built from a fixed allow-list ({@link buildMergeCommand}), using the
 * synchronous REST merge endpoint with the checked SHA. It cannot enable
 * auto-merge or queue.
 */
import * as childProcess from 'child_process'
import { createHash } from 'crypto'
import { promisify } from 'util'
import type { DatabaseManager } from './database'
import {
  parseGitHubPullRequestUrl,
  type PullRequestRef,
  type PullRequestReadinessClassification,
  type PullRequestReadinessSnapshot,
  type PullRequestReviewAttestation
} from '../shared/pr-readiness'

export type MergeDb = Pick<
  DatabaseManager,
  | 'getProject'
  | 'getProjectRepos'
  | 'appendProjectStatusJournal'
  | 'getLatestPullRequestReviewAttestation'
  | 'getCurrentPullRequestReadinessSnapshot'
  | 'recordPullRequestReadinessSnapshot'
>

function githubRepoNames(db: MergeDb, projectId: string): string[] {
  return db.getProjectRepos(projectId)
    .filter((repo) => repo.provider === 'github' && repo.org && repo.name)
    .map((repo) => `${repo.org}/${repo.name}`)
}

// ── gh ────────────────────────────────────────────────────────

const GH_MAX_BUFFER = 10 * 1024 * 1024
const GH_TIMEOUT_MS = 60_000

/** Runs `gh` with an argument list (never a shell) and returns stdout. Replaceable in tests. */
export type GhRunner = (args: string[]) => Promise<string>

// execFile is looked up per call, so modules that import this one load under
// a child_process mock without it.
const defaultGhRunner: GhRunner = async (args) => {
  const { stdout } = await promisify(childProcess.execFile)('gh', args, { maxBuffer: GH_MAX_BUFFER, timeout: GH_TIMEOUT_MS })
  return stdout
}

let ghRunner: GhRunner = defaultGhRunner

export function setGhRunner(runner: GhRunner | null): void {
  ghRunner = runner ?? defaultGhRunner
}

// ── The pull request gate ─────────────────────────────────────

export interface PullRequestGateState {
  url: string
  number: number
  title: string
  state: string
  isDraft: boolean
  /** MERGEABLE | CONFLICTING | UNKNOWN */
  mergeable: string
  /** CLEAN | HAS_HOOKS | BLOCKED | BEHIND | DIRTY | UNSTABLE | DRAFT | UNKNOWN */
  mergeStateStatus: string
  /** APPROVED | REVIEW_REQUIRED | CHANGES_REQUESTED | '' */
  reviewDecision: string
  headRefOid: string
  baseRefName: string
  baseRefOid?: string
  /** The PR author's login, so their own approval never counts as independent. */
  authorLogin?: string
  /** Logins that approved the current PR and are not its author (#155). */
  independentApprovals?: string[]
  /** Formal GitHub approval is required by branch protection when true. */
  githubApprovalRequired?: boolean
  /** Requested users/teams that can own a missing formal approval. */
  approvalOwners?: string[]
  reviews?: Array<{ reviewer: string; state: string; commitSha: string }>
  checks: Array<{ name: string; state: 'passed' | 'skipped' | 'failed' | 'pending'; identity?: string }>
}

interface RawCheck {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
  detailsUrl?: string
  targetUrl?: string
  startedAt?: string
  completedAt?: string
}

function checkState(check: RawCheck): 'passed' | 'skipped' | 'failed' | 'pending' {
  // A CheckRun that has not completed has no conclusion yet.
  if (check.status && check.status.toUpperCase() !== 'COMPLETED' && !check.state) return 'pending'
  const value = (check.conclusion || check.state || '').toUpperCase()
  if (value === 'SUCCESS') return 'passed'
  if (value === 'NEUTRAL' || value === 'SKIPPED') return 'skipped'
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(value)) return 'failed'
  return 'pending'
}

const PR_VIEW_FIELDS = 'url,number,title,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,baseRefName,statusCheckRollup,author,reviewRequests'
// gh pr view does not expose baseRefOid on supported CLI versions.
// Read the latest review per reviewer here as well because gh pr view omits
// the commit each review covered. Readiness needs exact-head evidence, not an
// approval that may have survived a later push on an unprotected repo.
const PR_REFS_QUERY = 'query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { headRefOid baseRefName baseRefOid author { login } latestReviews(first: 100) { nodes { author { login } state commit { oid } } pageInfo { hasNextPage } } } } }'

function loginOf(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const login = (value as { login?: unknown }).login
  return typeof login === 'string' && /^\S+$/.test(login) ? login : ''
}

/**
 * Approving reviewers other than the PR author. `reviewDecision` is empty on a
 * repository without required reviews even when people have approved, so it
 * cannot stand in for "someone independent looked at this" (#155).
 */
function independentReviewsFrom(raw: Record<string, unknown>, headRefOid: string, authorLogin: string): {
  approvals: string[]
  reviews: Array<{ reviewer: string; state: string; commitSha: string }>
} {
  if (!authorLogin) throw new Error('GitHub returned missing PR author identity for exact-head review data')
  const connection = raw.latestReviews
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) {
    throw new Error('GitHub returned missing exact-head review data')
  }
  const reviews = (connection as { nodes?: unknown }).nodes
  const pageInfo = (connection as { pageInfo?: unknown }).pageInfo
  if (!Array.isArray(reviews) || reviews.length > 100 || !pageInfo || typeof pageInfo !== 'object' || Array.isArray(pageInfo) ||
      typeof (pageInfo as { hasNextPage?: unknown }).hasNextPage !== 'boolean' ||
      (pageInfo as { hasNextPage: boolean }).hasNextPage) {
    throw new Error('GitHub returned incomplete exact-head review data')
  }
  const author = authorLogin.toLowerCase()
  const seen = new Set<string>()
  const logins: string[] = []
  const parsed: Array<{ reviewer: string; state: string; commitSha: string }> = []
  for (const review of reviews) {
    // Do not silently discard malformed nodes: another node might be an old
    // approval from the same reviewer. latestReviews promises one per user.
    if (!review || typeof review !== 'object' || Array.isArray(review)) {
      throw new Error('GitHub returned malformed exact-head review data')
    }
    const login = loginOf(review.author)
    const commit = review.commit
    if (!login || typeof review.state !== 'string' ||
        !['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(review.state) ||
        !commit || typeof commit !== 'object' || Array.isArray(commit) ||
        typeof commit.oid !== 'string' || !/^[0-9a-f]{40}$/i.test(commit.oid)) {
      throw new Error('GitHub returned malformed exact-head review data')
    }
    const reviewer = login.toLowerCase()
    if (seen.has(reviewer)) throw new Error('GitHub returned inconsistent exact-head review data')
    seen.add(reviewer)
    parsed.push({ reviewer: login, state: review.state, commitSha: commit.oid })
    if (review.state === 'APPROVED' && commit.oid === headRefOid && reviewer !== author) logins.push(login)
  }
  return { approvals: logins, reviews: parsed }
}

function approvalOwnersFrom(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('GitHub returned malformed requested-reviewer data')
  const owners = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('GitHub returned malformed requested-reviewer data')
    }
    const record = entry as Record<string, unknown>
    for (const key of ['login', 'slug', 'name']) {
      const candidate = record[key]
      if (typeof candidate === 'string' && candidate.trim() && candidate.trim() === candidate) return candidate
    }
    throw new Error('GitHub returned malformed requested-reviewer identity')
  })
  return [...new Set(owners)]
}

/** Reads what the gate needs from GitHub, through the user's gh CLI. */
export async function readPullRequestGate(pr: PullRequestRef): Promise<PullRequestGateState> {
  const stdout = await ghRunner(['pr', 'view', pr.url, '--json', PR_VIEW_FIELDS])
  const raw = JSON.parse(stdout) as Record<string, unknown>
  if (!raw || typeof raw !== 'object' || raw.url !== pr.url || raw.number !== pr.number ||
      typeof raw.isDraft !== 'boolean' || typeof raw.baseRefName !== 'string' || !raw.baseRefName ||
      !Array.isArray(raw.statusCheckRollup) || raw.statusCheckRollup.some((check) => !check || typeof check !== 'object')) {
    throw new Error('GitHub returned incomplete or mismatched PR/check data')
  }
  const refs = JSON.parse(await ghRunner(['api', 'graphql', '-f', `query=${PR_REFS_QUERY}`,
    '-f', `owner=${pr.owner}`, '-f', `repo=${pr.repo}`, '-F', `number=${pr.number}`,
    '--jq', '.data.repository.pullRequest'])) as Record<string, unknown> | null
  if (!refs || refs.headRefOid !== raw.headRefOid || refs.baseRefName !== raw.baseRefName ||
      typeof refs.baseRefOid !== 'string' || !/^[0-9a-f]{40}$/i.test(refs.baseRefOid)) {
    throw new Error('GitHub returned missing or changed PR head/base data; reevaluate before retrying')
  }
  const rollup = raw.statusCheckRollup as RawCheck[]
  const headRefOid = typeof raw.headRefOid === 'string' ? raw.headRefOid : ''
  const rawAuthorLogin = loginOf(raw.author)
  const authorLogin = loginOf(refs.author)
  if (!rawAuthorLogin || !authorLogin || rawAuthorLogin.trim() !== rawAuthorLogin ||
      authorLogin.trim() !== authorLogin || rawAuthorLogin.toLowerCase() !== authorLogin.toLowerCase()) {
    throw new Error('GitHub returned missing, malformed or changed PR author data; reevaluate before retrying')
  }
  const reviewData = independentReviewsFrom(refs, headRefOid, authorLogin)
  const reviewDecision = String(raw.reviewDecision ?? '').toUpperCase()
  return {
    url: typeof raw.url === 'string' ? raw.url : pr.url,
    number: typeof raw.number === 'number' ? raw.number : pr.number,
    title: typeof raw.title === 'string' ? raw.title : '',
    state: String(raw.state ?? '').toUpperCase(),
    isDraft: raw.isDraft === true,
    mergeable: String(raw.mergeable ?? '').toUpperCase(),
    mergeStateStatus: String(raw.mergeStateStatus ?? '').toUpperCase(),
    reviewDecision,
    headRefOid,
    baseRefName: typeof raw.baseRefName === 'string' ? raw.baseRefName : '',
    baseRefOid: refs.baseRefOid,
    authorLogin,
    independentApprovals: reviewData.approvals,
    githubApprovalRequired: reviewDecision === 'REVIEW_REQUIRED' || reviewDecision === 'APPROVED',
    approvalOwners: approvalOwnersFrom(raw.reviewRequests),
    reviews: reviewData.reviews,
    checks: rollup.map((check) => ({
      name: check.name || check.context || 'check',
      state: checkState(check),
      identity: JSON.stringify({
        type: check.__typename ?? '', name: check.name ?? '', context: check.context ?? '',
        status: check.status ?? '', conclusion: check.conclusion ?? '', state: check.state ?? '',
        detailsUrl: check.detailsUrl ?? '', targetUrl: check.targetUrl ?? '',
        startedAt: check.startedAt ?? '', completedAt: check.completedAt ?? ''
      })
    }))
  }
}

export interface GateVerdict {
  ok: boolean
  /** Why it cannot be merged now; empty when ok. */
  reasons: string[]
  /** A person outside 21x must act: a required review, CODEOWNERS, changes requested, protection. */
  needsExternalApproval: boolean
  /** Only waiting (checks running, mergeability not computed): try again later. */
  pending: boolean
  externalApproval?: {
    owner: 'github_branch_protection'
    requestedReviewers: string[]
    formalApprovalRequired: boolean
  }
}

/**
 * The condition every merge must meet: "checks green and branch
 * protection satisfied", as GitHub reports it. Unknown states refuse.
 */
export function evaluatePullRequestGate(state: PullRequestGateState): GateVerdict {
  const reasons: string[] = []
  let needsExternalApproval = false
  let pending = false
  let blocking = false

  if (state.state !== 'OPEN') { reasons.push(`the pull request is ${state.state.toLowerCase() || 'not open'}`); blocking = true }
  if (state.isDraft || state.mergeStateStatus === 'DRAFT') { reasons.push('it is a draft'); blocking = true }
  if (!/^[0-9a-f]{40}$/i.test(state.headRefOid)) { reasons.push('its head commit could not be read'); blocking = true }

  if (state.reviewDecision === 'REVIEW_REQUIRED') {
    reasons.push('a required review has not approved it (branch protection or CODEOWNERS)')
    needsExternalApproval = true
  } else if (state.reviewDecision === 'CHANGES_REQUESTED') {
    reasons.push('a reviewer requested changes')
    needsExternalApproval = true
  }

  const failed = state.checks.filter((check) => check.state === 'failed').map((check) => check.name)
  const running = state.checks.filter((check) => check.state === 'pending').map((check) => check.name)
  if (failed.length > 0) { reasons.push(`failing checks: ${failed.join(', ')}`); blocking = true }
  if (running.length > 0) { reasons.push(`checks still running: ${running.join(', ')}`); pending = true }

  if (state.mergeable === 'CONFLICTING') { reasons.push('it has merge conflicts'); blocking = true }
  else if (state.mergeable !== 'MERGEABLE') { reasons.push('GitHub has not confirmed that the PR is mergeable'); pending = true }
  if (!['', 'APPROVED', 'REVIEW_REQUIRED', 'CHANGES_REQUESTED'].includes(state.reviewDecision)) {
    reasons.push('GitHub returned an unknown review decision'); blocking = true
  }

  switch (state.mergeStateStatus) {
    case 'CLEAN':
    case 'HAS_HOOKS':
      break
    case 'BLOCKED':
      if (!needsExternalApproval && running.length === 0 && failed.length === 0) {
        reasons.push('branch protection is not satisfied (a required check, review, signature or conversation resolution)')
        needsExternalApproval = true
      }
      break
    case 'BEHIND':
      reasons.push('it is behind its base branch and protection requires it to be up to date'); blocking = true
      break
    case 'DIRTY':
      if (state.mergeable !== 'CONFLICTING') reasons.push('it has merge conflicts')
      blocking = true
      break
    case 'UNSTABLE':
      if (failed.length === 0 && running.length === 0) reasons.push('GitHub reports non-passing checks')
      blocking = true
      break
    case 'DRAFT':
      break
    default:
      reasons.push('GitHub has not computed whether it can be merged yet')
      pending = true
  }

  const ok = reasons.length === 0
  return {
    ok,
    reasons,
    needsExternalApproval,
    pending: !ok && pending && !blocking && !needsExternalApproval,
    ...(needsExternalApproval
      ? {
          externalApproval: {
            owner: 'github_branch_protection' as const,
            requestedReviewers: state.approvalOwners ?? [],
            formalApprovalRequired: state.githubApprovalRequired === true || state.reviewDecision === 'REVIEW_REQUIRED'
          }
        }
      : {})
  }
}

export interface PullRequestReadinessEvaluation {
  state: PullRequestGateState
  verdict: GateVerdict
  snapshot: PullRequestReadinessSnapshot
  changed: boolean
  attestation?: PullRequestReviewAttestation
}

function observedReadinessState(state: PullRequestGateState): Record<string, unknown> {
  return {
    state: state.state,
    draft: state.isDraft,
    mergeable: state.mergeable,
    merge_state: state.mergeStateStatus,
    review_decision: state.reviewDecision,
    github_approval_required: state.githubApprovalRequired === true,
    approval_owners: state.approvalOwners ?? [],
    reviews: state.reviews ?? [],
    checks: state.checks
  }
}

function readinessInvalidationReason(
  current: PullRequestReadinessSnapshot | undefined,
  state: PullRequestGateState,
  observed: Record<string, unknown>
): string {
  if (!current) return 'initial_observation'
  const reasons: string[] = []
  if (current.head_sha !== state.headRefOid) reasons.push('head_changed')
  if (current.base_sha !== state.baseRefOid) reasons.push('base_changed')
  const before = current.observed_state
  if (before.draft !== observed.draft) reasons.push('draft_changed')
  if (before.mergeable !== observed.mergeable || before.merge_state !== observed.merge_state) reasons.push('mergeability_changed')
  if (JSON.stringify(before.reviews) !== JSON.stringify(observed.reviews) ||
      before.review_decision !== observed.review_decision ||
      before.github_approval_required !== observed.github_approval_required ||
      JSON.stringify(before.approval_owners) !== JSON.stringify(observed.approval_owners)) reasons.push('review_changed')
  if (JSON.stringify(before.checks) !== JSON.stringify(observed.checks)) reasons.push('checks_changed')
  if (before.state !== observed.state) reasons.push('pr_state_changed')
  return reasons.length > 0 ? reasons.join(',') : 'review_attestation_changed'
}

/** Persist one exact live view and invalidate the prior view on every material change. */
export function reconcilePullRequestReadiness(
  db: MergeDb,
  projectId: string,
  pr: PullRequestRef,
  state: PullRequestGateState
): PullRequestReadinessEvaluation {
  const verdict = evaluatePullRequestGate(state)
  const baseSha = state.baseRefOid ?? ''
  const repo = `${pr.owner}/${pr.repo}`
  const attestation = /^[0-9a-f]{40}$/i.test(state.headRefOid) && /^[0-9a-f]{40}$/i.test(baseSha)
    ? db.getLatestPullRequestReviewAttestation({
        projectId, repo, prNumber: pr.number, headSha: state.headRefOid.toLowerCase(), baseSha: baseSha.toLowerCase()
      })
    : undefined
  const independentlyReviewed = (state.independentApprovals ?? []).length > 0 || attestation?.verdict === 'CLEAN'
  let classification: PullRequestReadinessClassification
  let reasons = [...verdict.reasons]
  if (!verdict.ok) {
    classification = verdict.needsExternalApproval
      ? 'external_approval_required'
      : verdict.pending
        ? 'pending'
        : 'blocked'
  } else if (attestation?.verdict === 'CHANGES_REQUIRED') {
    classification = 'blocked'
    reasons = [`the latest verified 21x review requires changes${attestation.summary ? `: ${attestation.summary}` : ''}`]
  } else if (!independentlyReviewed) {
    classification = 'independent_review_required'
    reasons = [`head ${state.headRefOid} has neither an exact-head GitHub approval nor a verified 21x independent-review attestation`]
  } else {
    classification = 'ready'
  }
  const observed = observedReadinessState(state)
  const fingerprint = createHash('sha256').update(JSON.stringify({
    repo: repo.toLowerCase(), pr: pr.number, head: state.headRefOid, base: baseSha, observed,
    // An attestation is mutable evidence about an immutable revision. Bind
    // its exact audit row into the fingerprint so CLEAN -> CHANGES_REQUIRED,
    // replacement, or provenance changes invalidate an already-read gate.
    attestation: attestation
      ? {
          id: attestation.id,
          handoff: attestation.handoff_id,
          implementation_task: attestation.implementation_task_id,
          review_task: attestation.review_task_id,
          implementation_agent: attestation.implementation_agent_id,
          reviewer_agent: attestation.reviewer_agent_id,
          verdict: attestation.verdict,
          created_at: attestation.created_at
        }
      : null
  })).digest('hex')
  const current = db.getCurrentPullRequestReadinessSnapshot(projectId, repo, pr.number)
  const saved = db.recordPullRequestReadinessSnapshot({
    project_id: projectId,
    repo,
    pr_number: pr.number,
    head_sha: state.headRefOid,
    base_sha: baseSha,
    state_fingerprint: fingerprint,
    classification,
    reasons,
    observed_state: observed,
    attestation_id: attestation?.id ?? null
  }, readinessInvalidationReason(current, state, observed))
  return { state, verdict, snapshot: saved.snapshot, changed: saved.changed, attestation }
}

/** Reads GitHub live and immediately records the authoritative readiness revision. */
export async function readPullRequestReadiness(
  db: MergeDb,
  projectId: string,
  pr: PullRequestRef
): Promise<PullRequestReadinessEvaluation> {
  return reconcilePullRequestReadiness(db, projectId, pr, await readPullRequestGate(pr))
}

export type MergeMethod = 'squash' | 'merge' | 'rebase'
const MERGE_METHODS: readonly MergeMethod[] = ['squash', 'merge', 'rebase']

/** Flags that would bypass protection or defer the check; never passed. */
export const FORBIDDEN_MERGE_FLAGS = ['--admin', '--auto', '--disable-auto'] as const

export function isMergeMethod(value: unknown): value is MergeMethod {
  return typeof value === 'string' && (MERGE_METHODS as readonly string[]).includes(value)
}

/**
 * The only merge command 21x runs: the method, pinned to the head commit
 * the gate checked (the REST `sha` precondition, so a push after the check makes
 * GitHub refuse). Nothing from the model reaches it except a validated URL
 * and one of three methods.
 */
export function buildMergeCommand(prUrl: string, method: MergeMethod, headSha: string): string[] {
  if (!isMergeMethod(method)) throw new Error(`Unsupported merge method: ${String(method)}`)
  if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new Error('A full head commit SHA is required')
  const pr = parseGitHubPullRequestUrl(prUrl)
  if (!pr) throw new Error('A canonical GitHub PR URL is required')
  // The synchronous REST endpoint cannot silently enable auto-merge or enqueue
  // a future merge (gh pr merge does that on branches requiring a merge queue).
  const args = ['api', '--method', 'PUT', `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/merge`, '-f', `sha=${headSha}`, '-f', `merge_method=${method}`]
  if (args.some((arg) => (FORBIDDEN_MERGE_FLAGS as readonly string[]).includes(arg))) throw new Error('Refusing a merge bypass flag')
  return args
}

// ── Merging ───────────────────────────────────────────────────

class MergeRefusedError extends Error {}

/** A definite refusal from GitHub, as opposed to a transport failure that may have come after the merge. */
function confirmedMergeFailure(error: unknown): boolean {
  if (error instanceof MergeRefusedError) return true
  if (!error || typeof error !== 'object') return false
  if ('code' in error && error.code === 'ENOENT') return true // gh was never started
  return 'stderr' in error && /\(HTTP (?:400|401|403|404|405|409|422)\)/.test(String(error.stderr))
}

export interface MergeHooks {
  notifyUser?: (title: string, body: string) => void
  pushToRenderer?: (channel: string, data: unknown) => void
  /** A report to the Commander: a PR was merged, or a merge needs a person on GitHub. */
  report?: (projectId: string, kind: 'merged' | 'needs_user', summary: string) => void
}

export interface MergeRequest {
  projectId: string
  pr: PullRequestRef
  method: MergeMethod
}

// External-approval blockers are reported once per PR head.
const reportedBlocks = new Set<string>()

export function clearReportedMergeBlocks(): void {
  reportedBlocks.clear()
}

/**
 * The result for a PR that cannot be merged now, or null when it can. A
 * missing external approval is reported to the Commander once per PR head.
 * Nothing is merged.
 */
export function refuseUnmergeable(
  projectId: string,
  pr: PullRequestRef,
  state: PullRequestGateState,
  hooks: MergeHooks = {},
  readiness?: PullRequestReadinessEvaluation
): Record<string, unknown> | null {
  const verdict = readiness?.verdict ?? evaluatePullRequestGate(state)
  if (verdict.ok) return null
  const summary = `${pr.url} cannot be merged: ${verdict.reasons.join('; ')}`
  if (verdict.needsExternalApproval) {
    const key = `${pr.url}@${state.headRefOid}`
    if ((readiness ? readiness.changed : !reportedBlocks.has(key))) {
      reportedBlocks.add(key)
      hooks.report?.(projectId, 'needs_user', `${summary}. This needs a person on GitHub; 21x will not bypass it.`)
    }
  }
  return {
    status: 'blocked',
    blocker_class: verdict.needsExternalApproval ? 'external_approval_required' : verdict.pending ? 'pending' : 'blocked',
    reason_code: verdict.needsExternalApproval ? 'EXTERNAL_APPROVAL_REQUIRED' : undefined,
    pr_url: pr.url,
    reasons: verdict.reasons,
    needs_external_approval: verdict.needsExternalApproval,
    retry_later: verdict.pending,
    approval_ownership: verdict.externalApproval,
    readiness_snapshot_id: readiness?.snapshot.id,
    message: verdict.needsExternalApproval
      ? 'Not merged. A genuine external approval is missing; report it to the user as a blocker. Do not try to merge another way.'
      : verdict.pending
        ? 'Not merged yet: checks are still running or GitHub is still computing mergeability. Try again after they finish.'
        : 'Not merged. Fix the listed problems (or have the task agent fix them), then try again.'
  }
}

/**
 * Checks and merges one pull request. The PR must be in one of the project's
 * GitHub repos, pass {@link evaluatePullRequestGate}, and have no verified 21x
 * review of its head asking for changes. Never throws: failures are results.
 */
export async function performMerge(db: MergeDb, request: MergeRequest, hooks: MergeHooks = {}): Promise<Record<string, unknown>> {
  const { projectId, pr, method } = request
  const project = db.getProject(projectId)
  if (!project) return { error: 'Project not found' }
  const repos = githubRepoNames(db, projectId).map((name) => name.toLowerCase())
  if (!repos.includes(`${pr.owner}/${pr.repo}`.toLowerCase())) {
    return { error: `${pr.owner}/${pr.repo} is not one of this project's GitHub repositories.` }
  }
  if (!isMergeMethod(method)) return { error: `merge_method must be one of ${MERGE_METHODS.join(', ')}` }

  let readiness: PullRequestReadinessEvaluation
  try {
    readiness = await readPullRequestReadiness(db, projectId, pr)
  } catch (error) {
    return { error: `Could not read ${pr.url} from GitHub: ${error instanceof Error ? error.message : String(error)}` }
  }
  const state = readiness.state

  const blocked = refuseUnmergeable(projectId, pr, state, hooks, readiness)
  if (blocked) return blocked

  const attestation = readiness.attestation
  if (attestation?.verdict === 'CHANGES_REQUIRED') {
    const review = `head ${state.headRefOid} has unresolved changes from its latest verified 21x independent review${attestation.summary ? `: ${attestation.summary}` : ''}`
    if (readiness.changed) hooks.report?.(projectId, 'needs_user', `${pr.url} was not merged: ${review}.`)
    return {
      status: 'blocked',
      blocker_class: 'blocked',
      reason_code: 'REVIEW_CHANGES_REQUIRED',
      pr_url: pr.url,
      needs_external_approval: false,
      retry_later: false,
      reasons: [review],
      readiness_snapshot_id: readiness.snapshot.id,
      message: `Not merged. ${review} Fix the findings, then hand the new head to a review agent.`
    }
  }

  try {
    const response = JSON.parse(await ghRunner(buildMergeCommand(pr.url, method, state.headRefOid))) as { merged?: boolean; sha?: string; message?: string }
    if (response.merged !== true || !/^[0-9a-f]{40}$/i.test(response.sha ?? '')) {
      if (response.merged === false) throw new MergeRefusedError(response.message || 'GitHub did not merge the PR')
      return { status: 'unknown', pr_url: pr.url, message: 'GitHub did not confirm the merge outcome. Inspect the PR before retrying.' }
    }
  } catch (error) {
    if (!confirmedMergeFailure(error)) {
      return { status: 'unknown', pr_url: pr.url, message: 'The merge outcome is unknown. Inspect the PR before retrying.' }
    }
    const detail = error instanceof Error ? error.message : String(error)
    return { error: `GitHub refused the merge of ${pr.url}: ${detail.slice(0, 1_000)}`, pr_url: pr.url }
  }

  const title = state.title ? ` "${state.title.slice(0, 120)}"` : ''
  const summary = `Merged ${pr.url}${title} (${method}, ${state.headRefOid.slice(0, 7)})`
  db.appendProjectStatusJournal(projectId, {
    summary,
    completed: [`Merged ${pr.owner}/${pr.repo}#${pr.number}${title}`]
  })
  hooks.pushToRenderer?.('project:statusChanged', { projectId })
  hooks.notifyUser?.(`Captain of ${project.name} merged a PR`, summary)
  hooks.report?.(projectId, 'merged', summary)
  return { status: 'merged', pr_url: pr.url, head_sha: state.headRefOid, method, message: 'Merged.' }
}
