/**
 * Merge grants (#137): the main-process side.
 *
 * A grant is standing authority for a project's Captain to merge ready pull
 * requests. It exists only when the user typed the words for it:
 * - in the Commander chat, where the app hands the Commander's tools the
 *   stored id and verbatim text of the current user turn
 *   (commander/project-tools.ts, `ask_captain` with `merge_grant`);
 * - in a project's own chat, where the chat composer reports what the user
 *   typed (Enter or Send, never dictation) to the Captain
 *   ({@link recordUserTypedProjectMessage}, via ipc/merge-grants.ts);
 *   the Captain's `grant_merge_authority` tool binds to the newest one.
 * Nothing else creates a grant: not a model paraphrase, not a Captain report,
 * not a wake-up, not text from an issue or a web page. See
 * {@link createMergeGrantFromUserMessage} for every rule.
 *
 * Merging is done here, never by the model: the Captain's
 * `merge_pull_request` tool is answered by the escalation gate
 * (escalation.ts), which finds the authority (policy, grant or the user's
 * approval of a held call) and calls {@link performMerge}. That reads the PR
 * from GitHub and refuses unless it is open, not a draft, every check passed
 * and GitHub reports branch protection satisfied (`mergeStateStatus` CLEAN or
 * HAS_HOOKS, no review required or changes requested). The merge command is
 * built from a fixed allow-list ({@link buildMergeCommand}), using the synchronous
 * REST merge endpoint with the checked SHA. It cannot enable auto-merge or queue.
 */
import * as childProcess from 'child_process'
import { randomUUID } from 'crypto'
import { promisify } from 'util'
import type { DatabaseManager } from './database'
import {
  DEFAULT_MERGE_GRANT_HOURS,
  MAX_GRANT_USER_TEXT_CHARS,
  MAX_MERGE_GRANT_HOURS,
  PROJECT_CHAT_GRANT_WINDOW_MS,
  checkMergeIntent,
  describeMergeGrant,
  grantCoversPullRequest,
  mergeGrantSettingsFrom,
  mergeGrantFailure,
  type MergeGrantFailure,
  type MergeGrantProblem,
  type MergeGrantReasonCode,
  mergeGrantStatus,
  prNumbersMentioned,
  parseGitHubPullRequestUrl,
  type MergeGrant,
  type MergeAuthorizationContext,
  type MergeGrantAuditEntry,
  type MergeGrantScopeInput,
  type MergeGrantSource,
  type PullRequestRef
} from '../shared/merge-grants'

export type MergeGrantDb = Pick<
  DatabaseManager,
  | 'getProject'
  | 'getProjects'
  | 'getProjectRepos'
  | 'createMergeGrant'
  | 'getMergeGrant'
  | 'listMergeGrants'
  | 'revokeMergeGrant'
  | 'reserveMergeGrantUse'
  | 'refundMergeGrantUse'
  | 'recordMergeGrantUse'
  | 'listPendingMergeGrantReservations'
  | 'listMergeGrantUses'
  | 'appendProjectStatusJournal'
>

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

// ── Change events ─────────────────────────────────────────────

let changeListener: ((projectId: string) => void) | null = null

/** index.ts pushes `mergeGrants:changed` to the window from here. */
export function setMergeGrantChangeListener(listener: ((projectId: string) => void) | null): void {
  changeListener = listener
}

function grantsChanged(projectId: string): void {
  try {
    changeListener?.(projectId)
  } catch (error) {
    console.error('[MergeGrants] change listener failed:', error)
  }
}

// ── What the user typed in a project chat ─────────────────────

export interface TypedMessage {
  id: string
  projectId: string
  taskId: string
  text: string
  at: number
}

const typedByProject = new Map<string, TypedMessage>()
const latestDispatch = new Map<string, string>()

/** A delivery token is minted in main, before any asynchronous resume work. */
export interface ProjectMessageDispatch {
  id: string
  projectId: string
  typed?: TypedMessage
}

export function prepareProjectMessageDispatch(projectId: string, typed?: TypedMessage): ProjectMessageDispatch {
  const dispatch = { id: randomUUID(), projectId, typed }
  latestDispatch.set(projectId, dispatch.id)
  typedByProject.delete(projectId)
  return dispatch
}

/** Install provenance only at the adapter send boundary, and only for the latest dispatch. */
export function activateProjectMessageDispatch(dispatch: ProjectMessageDispatch): void {
  if (latestDispatch.get(dispatch.projectId) !== dispatch.id) return
  if (dispatch.typed) typedByProject.set(dispatch.projectId, dispatch.typed)
}

export function failProjectMessageDispatch(dispatch: ProjectMessageDispatch): void {
  if (latestDispatch.get(dispatch.projectId) === dispatch.id) typedByProject.delete(dispatch.projectId)
}

/** Main-process message identity, also used for the persisted transcript event. */
export function makeUserTypedProjectMessage(projectId: string, taskId: string, text: string, now = Date.now()): TypedMessage {
  return { id: `pc-${randomUUID()}`, projectId, taskId, text, at: now }
}

/** Test helper for an already-dispatched typed message. Production uses the dispatch functions. */
export function recordUserTypedProjectMessage(projectId: string, taskId: string, text: string, now = Date.now()): TypedMessage | null {
  if (!projectId || !text.trim()) return null
  const entry = makeUserTypedProjectMessage(projectId, taskId, text, now)
  activateProjectMessageDispatch(prepareProjectMessageDispatch(projectId, entry))
  return entry
}

/** The latest dispatched typed message. Any subsequent non-typed dispatch invalidates it. */
export function latestUserTypedProjectMessage(projectId: string, now = Date.now()): TypedMessage | null {
  const entry = typedByProject.get(projectId)
  if (!entry) return null
  if (now - entry.at > PROJECT_CHAT_GRANT_WINDOW_MS) {
    typedByProject.delete(projectId)
    return null
  }
  return entry
}

export function clearUserTypedProjectMessages(): void {
  typedByProject.clear()
  latestDispatch.clear()
}

// ── Creating a grant ──────────────────────────────────────────

/** A message the app knows the user typed. The model supplies none of these fields. */
export interface UserMessageBinding {
  source: MergeGrantSource
  /** The Commander session or the Captain task. */
  sessionId: string | null
  messageId: string
  text: string
}

export type GrantResult = { ok: true; grant: MergeGrant; notes: string[] } | MergeGrantFailure

const BRANCH_NAME = /^[A-Za-z0-9._/-]{1,200}$/
const MAX_PR_FILTER = 50
const MAX_MERGES_CAP = 100

function githubRepoNames(db: MergeGrantDb, projectId: string): string[] {
  return db.getProjectRepos(projectId)
    .filter((repo) => repo.provider === 'github' && repo.org && repo.name)
    .map((repo) => `${repo.org}/${repo.name}`)
}

/**
 * Creates a grant bound to a message the user typed, or says why not.
 * Every check is here, so both sources get the same rules:
 * - the project exists, is not archived and has merge grants turned on;
 * - the message is non-empty and asks for merging in the user's own words
 *   ({@link checkMergeIntent}): no grant from "ship it", none from "don't merge";
 * - when the message names PRs, the grant is narrowed to them and cannot
 *   name others;
 * - the repo filter is one of the project's GitHub repos;
 * - the expiry is at most {@link MAX_MERGE_GRANT_HOURS} hours;
 * - a message backs at most one grant, so it reaches one project only.
 */
export function createMergeGrantFromUserMessage(
  db: MergeGrantDb,
  projectId: string,
  binding: UserMessageBinding,
  scope: MergeGrantScopeInput = {}
): GrantResult {
  const project = db.getProject(projectId)
  const fail = (code: MergeGrantReasonCode, message: string, offending = binding.text): MergeGrantFailure =>
    mergeGrantFailure([{ reason_code: code, message, offending_scope: offending }], project?.name)
  if (!project) return fail('PROJECT_MISSING', `Project not found: ${projectId}`, projectId)
  const blockers: MergeGrantProblem[] = []
  const add = (reason_code: MergeGrantReasonCode, message: string, offending_scope: string): void => {
    blockers.push({ reason_code, message, offending_scope })
  }
  // Stable precedence: project/configuration, provenance, then command/scope.
  // Report independent failures together; rephrasing never enables the feature.
  if (project.archived) add('PROJECT_ARCHIVED', `Project "${project.name}" is archived.`, projectId)
  if (!mergeGrantSettingsFrom(project.settings).enabled) {
    add('FEATURE_DISABLED', `Merge grants are turned off for "${project.name}". Enable merge_grants.enabled in project settings (Escalation → Merge grants) before creating a grant.`, projectId)
  }
  const eligible = (binding.source === 'commander' || binding.source === 'project_chat') &&
    !!binding.messageId && typeof binding.text === 'string' && !!binding.text.trim()
  if (!eligible) add('INELIGIBLE_PROVENANCE', 'There is no message the user typed available to bind the grant to. Use a current typed instruction; reports, voice and model text cannot grant authority.', binding.source)
  const intent = checkMergeIntent(eligible && binding.text.length <= MAX_GRANT_USER_TEXT_CHARS ? binding.text : '')
  if (eligible && binding.text.length > MAX_GRANT_USER_TEXT_CHARS) {
    add('PR_SCOPE_UNSUPPORTED', `Use a separate merge instruction of at most ${MAX_GRANT_USER_TEXT_CHARS} characters; the audit must retain it verbatim.`, 'user_text')
  } else if (eligible && !intent.ok) {
    add(intent.reasonCode ?? 'AMBIGUOUS_COMMAND', intent.reason ?? 'The user did not ask for merging.', intent.offendingScope ?? binding.text)
  }
  if (intent.ok && intent.projectName) {
    const named = db.getProjects({ includeArchived: true }).filter((p) => p.name.toLowerCase() === intent.projectName!.toLowerCase())
    if (named.length > 1) add('PROJECT_AMBIGUOUS', 'The project name is ambiguous. Use a unique owner/repository.', intent.projectName)
    else if (named.length === 0) add('PROJECT_MISSING', 'No project has this exact name.', intent.projectName)
    else if (named[0].id !== projectId) add('PROJECT_MISMATCH', 'The instruction names a different project.', intent.projectName)
  }
  if (intent.ok && intent.scopeKind === 'project_wide' && intent.repo) {
    const owners = db.getProjects({ includeArchived: true }).filter((p) =>
      githubRepoNames(db, p.id).some((repo) => repo.toLowerCase() === intent.repo!.toLowerCase()))
    if (owners.length > 1) add('PROJECT_AMBIGUOUS', 'The repository belongs to multiple projects. Name one unique project instead.', intent.repo)
    else if (owners.length === 0) add('PROJECT_MISSING', 'No project owns this GitHub repository.', intent.repo)
    else if (owners[0].id !== projectId) add('PROJECT_MISMATCH', 'The repository belongs to a different project.', intent.repo)
  }
  for (const key of ['repo', 'base_branch'] as const) {
    if (scope[key] != null && typeof scope[key] !== 'string') add('PR_SCOPE_UNSUPPORTED', `${key} must be a string.`, key)
  }
  if (scope.pr_numbers != null && (!Array.isArray(scope.pr_numbers) || scope.pr_numbers.some((n) => !Number.isSafeInteger(n) || n <= 0))) {
    add('PR_SCOPE_UNSUPPORTED', 'pr_numbers must be an array of positive integers.', 'pr_numbers')
  }
  if (scope.expires_in_hours != null && (typeof scope.expires_in_hours !== 'number' || !Number.isFinite(scope.expires_in_hours) || scope.expires_in_hours <= 0)) {
    add('INVALID_EXPIRY', 'expires_in_hours must be a positive finite number.', 'expires_in_hours')
  }
  if (scope.max_merges != null && (!Number.isInteger(scope.max_merges) || scope.max_merges <= 0 || scope.max_merges > MAX_MERGES_CAP)) {
    add('INVALID_USE_LIMIT', `max_merges must be an integer from 1 to ${MAX_MERGES_CAP}.`, 'max_merges')
  }
  if (blockers.length) return mergeGrantFailure(blockers, project.name)
  if (intent.repo && scope.repo && intent.repo.toLowerCase() !== scope.repo.trim().toLowerCase()) {
    return fail('PR_SCOPE_UNSUPPORTED', 'The grant cannot cover a different repository from the user instruction.')
  }
  if (intent.baseBranch && scope.base_branch && intent.baseBranch !== scope.base_branch.trim()) {
    return fail('PR_SCOPE_UNSUPPORTED', 'The grant cannot cover a different base branch from the user instruction.')
  }
  scope = { ...scope, repo: intent.repo ?? scope.repo, base_branch: intent.baseBranch ?? scope.base_branch }

  const notes: string[] = []
  const repos = githubRepoNames(db, projectId)
  if (repos.length === 0) return fail('PR_SCOPE_UNSUPPORTED', `"${project.name}" has no GitHub repository; merge grants cover GitHub pull requests only.`)

  let repo: string | null = null
  if (scope.repo !== undefined && scope.repo !== null && scope.repo !== '') {
    const match = repos.find((name) => name.toLowerCase() === scope.repo!.trim().toLowerCase())
    if (!match) return fail('PR_SCOPE_UNSUPPORTED', `repo must be one of the project's GitHub repositories: ${repos.join(', ')}`)
    repo = match
  }

  let baseBranch: string | null = null
  if (scope.base_branch !== undefined && scope.base_branch !== null && scope.base_branch !== '') {
    if (!BRANCH_NAME.test(scope.base_branch.trim())) return fail('PR_SCOPE_UNSUPPORTED', 'base_branch is not a valid branch name')
    baseBranch = scope.base_branch.trim()
    return fail('PR_SCOPE_UNSUPPORTED', 'Base-branch-restricted merge grants are unavailable: GitHub cannot atomically pin the PR base during a merge. No grant was created.')
  }

  let prNumbers: number[] = []
  if (scope.pr_numbers !== undefined && scope.pr_numbers !== null) {
    prNumbers = [...new Set(scope.pr_numbers)].sort((a, b) => a - b)
    if (prNumbers.length > MAX_PR_FILTER) return fail('PR_SCOPE_UNSUPPORTED', `pr_numbers holds at most ${MAX_PR_FILTER} numbers`)
  }
  const mentioned = prNumbersMentioned(binding.text)
  if (mentioned.length > 0) {
    if (prNumbers.length === 0) {
      prNumbers = mentioned
      notes.push(`Narrowed to the PRs the user named: ${mentioned.map((n) => `#${n}`).join(', ')}.`)
    } else {
      const outside = prNumbers.filter((n) => !mentioned.includes(n))
      if (outside.length > 0) {
        return fail('PR_SCOPE_UNSUPPORTED', `The user named ${mentioned.map((n) => `#${n}`).join(', ')}; the grant cannot also cover ${outside.map((n) => `#${n}`).join(', ')}.`)
      }
    }
  }

  if (prNumbers.length > 0 && !repo) {
    if (repos.length !== 1) return fail('PR_SCOPE_UNSUPPORTED', 'Name a repository or use a full PR URL: PR numbers are ambiguous across this project’s repositories.')
    repo = repos[0]
  }

  let hours = DEFAULT_MERGE_GRANT_HOURS
  if (scope.expires_in_hours !== undefined && scope.expires_in_hours !== null) {
    hours = scope.expires_in_hours
    if (hours > MAX_MERGE_GRANT_HOURS) {
      hours = MAX_MERGE_GRANT_HOURS
      notes.push(`Expiry capped at ${MAX_MERGE_GRANT_HOURS} hours (7 days).`)
    }
  }

  let maxUses: number | null = null
  if (scope.max_merges !== undefined && scope.max_merges !== null) {
    maxUses = scope.max_merges
  }

  const grant = db.createMergeGrant({
    project_id: projectId,
    repo,
    base_branch: baseBranch,
    pr_numbers: prNumbers,
    source: binding.source,
    source_session_id: binding.sessionId,
    source_message_id: binding.messageId,
    user_text: binding.text,
    expires_at: new Date(Date.now() + hours * 3_600_000).toISOString(),
    max_uses: maxUses
  })
  if (!grant) {
    return fail('MESSAGE_ALREADY_USED', 'That user message already backs a merge grant. One instruction grants one project; ask the user for a separate instruction for each project.')
  }
  grantsChanged(projectId)
  return { ok: true, grant, notes }
}

/** Revokes a grant; `projectId`, when given, must match. `by` goes in the audit trail. */
export function revokeMergeGrant(db: MergeGrantDb, id: string, options: { projectId?: string; by?: 'user' | 'commander' } = {}): { ok: boolean; error?: string } {
  const grant = db.getMergeGrant(id)
  if (!grant || (options.projectId && grant.project_id !== options.projectId)) return { ok: false, error: 'No such merge grant' }
  if (grant.revoked_at) return { ok: true }
  const revoked = db.revokeMergeGrant(id, options.by ?? 'user')
  if (revoked) grantsChanged(grant.project_id)
  return revoked ? { ok: true } : { ok: false, error: 'Could not revoke the grant' }
}

/** Grants that could authorise a merge now: the project opted in, and the grant is active. */
export function activeMergeGrants(db: MergeGrantDb, projectId: string): MergeGrant[] {
  const project = db.getProject(projectId)
  if (!project || project.archived || !mergeGrantSettingsFrom(project.settings).enabled) return []
  return db.listMergeGrants({ projectId, activeOnly: true })
}

/**
 * The grant that covers this PR, if any. A `grantId` the Captain names must
 * be one of the project's active grants and cover the PR; otherwise the
 * oldest covering grant is used, so the narrowest, soonest-expiring
 * permission is spent first.
 */
export function findCoveringGrant(
  db: MergeGrantDb,
  projectId: string,
  pr: PullRequestRef & { baseRefName: string | null },
  grantId?: string | null
): MergeGrant | null {
  const grants = activeMergeGrants(db, projectId).filter((grant) => grantCoversPullRequest(grant, pr))
  if (grantId) return grants.find((grant) => grant.id === grantId) ?? null
  return grants.sort((a, b) => a.expires_at.localeCompare(b.expires_at))[0] ?? null
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
  checks: Array<{ name: string; state: 'passed' | 'skipped' | 'failed' | 'pending' }>
}

interface RawCheck {
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
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

const PR_VIEW_FIELDS = 'url,number,title,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,baseRefName,statusCheckRollup,author'
// gh pr view does not expose baseRefOid on supported CLI versions.
// Read the latest review per reviewer here as well because gh pr view omits
// the commit each review covered. A standing grant needs exact-head evidence,
// not an approval that may have survived a later push on an unprotected repo.
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
function independentApprovalsFrom(raw: Record<string, unknown>, headRefOid: string, authorLogin: string): string[] {
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
    if (review.state === 'APPROVED' && commit.oid === headRefOid && reviewer !== author) logins.push(login)
  }
  return logins
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
  return {
    url: typeof raw.url === 'string' ? raw.url : pr.url,
    number: typeof raw.number === 'number' ? raw.number : pr.number,
    title: typeof raw.title === 'string' ? raw.title : '',
    state: String(raw.state ?? '').toUpperCase(),
    isDraft: raw.isDraft === true,
    mergeable: String(raw.mergeable ?? '').toUpperCase(),
    mergeStateStatus: String(raw.mergeStateStatus ?? '').toUpperCase(),
    reviewDecision: String(raw.reviewDecision ?? '').toUpperCase(),
    headRefOid,
    baseRefName: typeof raw.baseRefName === 'string' ? raw.baseRefName : '',
    baseRefOid: refs.baseRefOid,
    authorLogin,
    independentApprovals: independentApprovalsFrom(refs, headRefOid, authorLogin),
    checks: rollup.map((check) => ({ name: check.name || check.context || 'check', state: checkState(check) }))
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
}

/**
 * The condition every merge must meet, grant or not: "checks green and
 * branch protection satisfied", as GitHub reports it. Unknown states refuse.
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
  return { ok, reasons, needsExternalApproval, pending: !ok && pending && !blocking && !needsExternalApproval }
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

/** A transport failure may occur after GitHub committed: only a definite refusal refunds authority. */
function confirmedMergeFailure(error: unknown): boolean {
  if (error instanceof MergeRefusedError) return true
  if (!error || typeof error !== 'object') return false
  if ('code' in error && error.code === 'ENOENT') return true // gh was never started
  return 'stderr' in error && /\(HTTP (?:400|401|403|404|405|409|422)\)/.test(String(error.stderr))
}

/** Where the authority for one merge came from. */
export type MergeAuthority =
  | { kind: 'policy'; level: 'autonomous' | 'tell_commander' }
  | { kind: 'grant'; grantId: string }
  | { kind: 'user_approval'; heldId: string }

export interface MergeHooks {
  notifyUser?: (title: string, body: string) => void
  pushToRenderer?: (channel: string, data: unknown) => void
  /** A report to the Commander (merged under a grant, or needs the user). */
  report?: (projectId: string, kind: 'merged_under_grant' | 'needs_user', summary: string, grantId?: string, context?: MergeAuthorizationContext) => void
}

export interface MergeRequest {
  projectId: string
  pr: PullRequestRef
  method: MergeMethod
  authority: MergeAuthority
  /** Explicit grant named by the caller; the executor decides whether it is effective. */
  requestedGrantId?: string | null
  /** Policy is context, not authority, once a covering requested grant is selected. */
  policyLevel?: MergeAuthorizationContext['policy_level']
  /** The state the caller just read, to avoid a second read; re-read when absent. */
  state?: PullRequestGateState
}

// External-approval blockers are reported once per PR head.
const reportedBlocks = new Set<string>()

export function clearReportedMergeBlocks(): void {
  reportedBlocks.clear()
}

function authorityText(db: MergeGrantDb, authority: MergeAuthority): { line: string; grant?: MergeGrant } {
  switch (authority.kind) {
    case 'grant': {
      const grant = db.getMergeGrant(authority.grantId)
      const quote = grant ? `"${grant.user_text.replace(/\s+/g, ' ').slice(0, 200)}"` : ''
      return { line: `under the user's merge grant ${authority.grantId}${quote ? ` (the user said ${quote})` : ''}`, grant }
    }
    case 'user_approval':
      return { line: `approved by the user (held call ${authority.heldId})` }
    default:
      return { line: `under the project's escalation policy (pull requests: ${authority.level})` }
  }
}

function authorizedBy(authority: MergeAuthority, grant?: MergeGrant): Record<string, unknown> {
  return authority.kind === 'grant'
    ? {
        kind: 'grant', grant_id: authority.grantId, user_text: grant?.user_text,
        uses: grant?.uses, max_uses: grant?.max_uses, expires_at: grant?.expires_at
      }
    : authority
}

function authorizationContext(
  request: MergeRequest,
  grant: MergeGrant | undefined,
  requestedGrantId: string | null
): MergeAuthorizationContext {
  return {
    policy_level: request.policyLevel ?? (request.authority.kind === 'policy' ? request.authority.level : null),
    requested_grant_id: requestedGrantId,
    grant_source: grant?.source ?? null,
    source_session_id: grant?.source_session_id ?? null,
    source_message_id: grant?.source_message_id ?? null
  }
}

/**
 * The result for a PR that cannot be merged now, or null when it can. A
 * missing external approval is reported to the Commander once per PR head.
 * Nothing is merged and no authority is consulted.
 */
export function refuseUnmergeable(projectId: string, pr: PullRequestRef, state: PullRequestGateState, hooks: MergeHooks = {}): Record<string, unknown> | null {
  const verdict = evaluatePullRequestGate(state)
  if (verdict.ok) return null
  const summary = `${pr.url} cannot be merged: ${verdict.reasons.join('; ')}`
  if (verdict.needsExternalApproval) {
    const key = `${pr.url}@${state.headRefOid}`
    if (!reportedBlocks.has(key)) {
      reportedBlocks.add(key)
      hooks.report?.(projectId, 'needs_user', `${summary}. This needs a person on GitHub; 21x will not bypass it.`)
    }
  }
  return {
    status: 'blocked',
    pr_url: pr.url,
    reasons: verdict.reasons,
    needs_external_approval: verdict.needsExternalApproval,
    retry_later: verdict.pending,
    message: verdict.needsExternalApproval
      ? 'Not merged. A genuine external approval is missing; report it to the user as a blocker. Do not try to merge another way.'
      : verdict.pending
        ? 'Not merged yet: checks are still running or GitHub is still computing mergeability. Try again after they finish.'
        : 'Not merged. Fix the listed problems (or have the task agent fix them), then try again.'
  }
}

/**
 * Why this PR has no independent review, or null when it has one. GitHub's
 * `reviewDecision` is only authoritative when the base branch requires
 * reviews; on an unprotected branch it is empty however many people approved,
 * so an explicit approval by someone other than the author is what counts.
 */
export function missingIndependentReview(state: PullRequestGateState): string | null {
  if ((state.independentApprovals ?? []).length > 0) return null
  return state.authorLogin
    ? `no one other than ${state.authorLogin} has approved its current head ${state.headRefOid}`
    : `its current head ${state.headRefOid} has no independent approving review`
}

/**
 * Checks and merges one pull request under an authority the caller already
 * established. The PR must be in one of the project's GitHub repos and pass
 * {@link evaluatePullRequestGate}. A grant's use is reserved before the
 * merge runs and given back if it fails. Never throws: failures are results.
 */
export async function performMerge(db: MergeGrantDb, request: MergeRequest, hooks: MergeHooks = {}): Promise<Record<string, unknown>> {
  const { projectId, pr, method } = request
  const project = db.getProject(projectId)
  if (!project) return { error: 'Project not found' }
  const repos = githubRepoNames(db, projectId).map((name) => name.toLowerCase())
  if (!repos.includes(`${pr.owner}/${pr.repo}`.toLowerCase())) {
    return { error: `${pr.owner}/${pr.repo} is not one of this project's GitHub repositories.` }
  }
  if (!isMergeMethod(method)) return { error: `merge_method must be one of ${MERGE_METHODS.join(', ')}` }

  const requestedGrantId = request.authority.kind === 'grant'
    ? request.authority.grantId
    : request.authority.kind === 'policy' && request.requestedGrantId
      ? request.requestedGrantId
      : null
  const requestedGrant = requestedGrantId ? db.getMergeGrant(requestedGrantId) : undefined
  if (requestedGrant?.project_id === projectId) {
    const priorUse = db.listMergeGrantUses(requestedGrant.id)
      .find((use) => use.pr_url.toLowerCase() === pr.url.toLowerCase())
    if (priorUse) {
      return {
        status: 'merged', already_recorded: true, pr_url: pr.url,
        head_sha: priorUse.head_sha, method: priorUse.method,
        authorized_by: authorizedBy({ kind: 'grant', grantId: requestedGrant.id }, requestedGrant),
        authorization_context: priorUse.authorization_context,
        message: `This exact PR merge is already recorded under merge grant ${requestedGrantId}; no second merge or grant use was attempted.`
      }
    }
  }

  let state: PullRequestGateState
  try {
    state = await readPullRequestGate(pr)
  } catch (error) {
    return { error: `Could not read ${pr.url} from GitHub: ${error instanceof Error ? error.message : String(error)}` }
  }

  // A retry while the first request is in flight, or after its response was
  // lost, must keep the original grant attribution and never dispatch a
  // second merge. If GitHub now confirms the saved head/base as merged,
  // finalize that durable reservation exactly once.
  if (requestedGrantId) {
    const pending = db.listPendingMergeGrantReservations(projectId).find((reservation) =>
      reservation.grant_id === requestedGrantId &&
      reservation.snapshot.pr_url.toLowerCase() === pr.url.toLowerCase())
    if (pending) {
      const pendingGrant = requestedGrant?.project_id === projectId ? requestedGrant : undefined
      const pendingContext = pending.snapshot.authorization_context ?? authorizationContext(request, pendingGrant, requestedGrantId)
      if (state.state === 'MERGED' && state.headRefOid === pending.snapshot.head_sha && state.baseRefName === pending.snapshot.base_branch) {
        const use = db.recordMergeGrantUse(pending.id)
        if (use) {
          grantsChanged(projectId)
          const summary = `Recovered merge outcome for ${pr.url} after a retried request under merge grant ${requestedGrantId}; GitHub confirms head ${state.headRefOid} merged.`
          hooks.pushToRenderer?.('project:statusChanged', { projectId })
          hooks.report?.(projectId, 'merged_under_grant', summary, requestedGrantId, pendingContext)
        }
        return {
          status: 'merged', already_recorded: true, pr_url: pr.url,
          head_sha: pending.snapshot.head_sha, method: pending.snapshot.method,
          authorized_by: authorizedBy({ kind: 'grant', grantId: requestedGrantId }, pendingGrant),
          authorization_context: pendingContext,
          message: `GitHub confirms the reserved merge under grant ${requestedGrantId}; the audit was finalized without dispatching another merge.`
        }
      }
      return {
        status: 'unknown', pr_url: pr.url, reservation_id: pending.id,
        authorized_by: authorizedBy({ kind: 'grant', grantId: requestedGrantId }, pendingGrant),
        authorization_context: pendingContext,
        message: 'A merge attempt for this PR is already reserved under the requested grant. Reconcile its GitHub outcome before retrying; no second merge or grant use was attempted.'
      }
    }
  }

  const blocked = refuseUnmergeable(projectId, pr, state, hooks)
  if (blocked) return blocked

  // A predecessor may have landed, or the PR may have been retargeted since
  // the gate selected authority. Do not spend a use on that stale assessment.
  if (request.state && (request.state.headRefOid !== state.headRefOid ||
      request.state.baseRefName !== state.baseRefName || request.state.baseRefOid !== state.baseRefOid)) {
    return { status: 'blocked', reason_code: 'PR_CHANGED', pr_url: pr.url,
      message: 'The PR head or base changed. Reevaluate reviews, checks and stack predecessors before retrying; no grant use was spent.' }
  }

  // Resolve the effective authority only after the final GitHub read. Policy
  // explains why the call was allowed, but an explicitly requested covering
  // grant is the authority that must be reserved, spent and audited (#159).
  // A named grant that no longer covers the PR fails closed; it never silently
  // falls back to broader policy authority.
  let authority: MergeAuthority = request.authority
  let grant: MergeGrant | undefined
  if (requestedGrantId) {
    grant = findCoveringGrant(db, projectId, { ...pr, baseRefName: state.baseRefName }, requestedGrantId) ?? undefined
    if (!grant) {
      return {
        error: 'The requested merge grant is no longer active, does not cover this PR, or the project disabled grants. Ask the user.',
        pr_url: pr.url,
        authorization_context: authorizationContext(request, undefined, requestedGrantId)
      }
    }
    authority = { kind: 'grant', grantId: grant.id }
  }
  const context = authorizationContext(request, grant, requestedGrantId)

  // A grant is standing authority over many PRs, so nobody looks at each one
  // before it lands. GitHub reports reviewDecision "" on a repository without
  // required reviews, so the mechanical gate alone would merge an unreviewed,
  // obsolete or duplicate PR under a project-wide grant. Require a real
  // independent approval instead, and spend no grant use without one (#155).
  const review = missingIndependentReview(state)
  if (authority.kind === 'grant' && review) {
    const key = `independent-review:${pr.url}@${state.headRefOid}`
    if (!reportedBlocks.has(key)) {
      reportedBlocks.add(key)
      hooks.report?.(projectId, 'needs_user', `${pr.url} was not merged under the merge grant: ${review}`, grant?.id, context)
    }
    return {
      status: 'blocked',
      reason_code: 'INDEPENDENT_REVIEW_REQUIRED',
      pr_url: pr.url,
      needs_external_approval: true,
      reasons: [review],
      authorized_by: authorizedBy(authority, grant),
      authorization_context: context,
      message: `Not merged and no grant use was spent. ${review} A merge grant authorises merging; it is not evidence that this PR is safe, current or not superseded. Get an independent approving review on GitHub, or ask the user to merge it themselves.`
    }
  }

  let reservationId: string | undefined
  if (authority.kind === 'grant') {
    const current = findCoveringGrant(db, projectId, { ...pr, baseRefName: state.baseRefName }, authority.grantId)
    if (!current) return { error: 'The merge grant is no longer active or the project disabled it. Ask the user.' }
    if (current.base_branch) return { status: 'blocked', needs_external_approval: true, message: 'This grant restricts the base branch, which GitHub cannot pin atomically. Ask the user to handle this merge on GitHub; no grant authority was spent.' }
    const reserved = db.reserveMergeGrantUse(authority.grantId, {
      pr_url: pr.url, pr_title: state.title, base_branch: state.baseRefName,
      head_sha: state.headRefOid, method, merge_state: state.mergeStateStatus,
      review_decision: state.reviewDecision, checks: state.checks,
      authorization_context: context
    })
    grant = reserved?.grant
    reservationId = reserved?.reservationId
    if (reserved) grantsChanged(projectId)
    if (!grant || grant.project_id !== projectId) {
      if (reservationId) db.refundMergeGrantUse(reservationId)
      return { error: 'The merge grant is no longer active (revoked, expired or used up). Ask the user.' }
    }
    if (!grantCoversPullRequest(grant, { ...pr, baseRefName: state.baseRefName })) {
      if (reservationId) db.refundMergeGrantUse(reservationId)
      return { error: `The merge grant ${grant.id} does not cover ${pr.url} (into ${state.baseRefName}).` }
    }
  }

  try {
    const response = JSON.parse(await ghRunner(buildMergeCommand(pr.url, method, state.headRefOid))) as { merged?: boolean; sha?: string; message?: string }
    if (response.merged !== true || !/^[0-9a-f]{40}$/i.test(response.sha ?? '')) {
      if (response.merged === false) throw new MergeRefusedError(response.message || 'GitHub did not merge the PR')
      // An ambiguous response cannot justify refunding possibly spent authority.
      return { status: 'unknown', pr_url: pr.url, reservation_id: reservationId,
        authorized_by: authorizedBy(authority, grant), authorization_context: context,
        message: `GitHub did not confirm the merge outcome. ${reservationId ? 'The grant use remains reserved. ' : ''}Inspect the PR before retrying.` }
    }
  } catch (error) {
    if (!confirmedMergeFailure(error)) return { status: 'unknown', pr_url: pr.url, reservation_id: reservationId,
      authorized_by: authorizedBy(authority, grant), authorization_context: context,
      message: `The merge outcome is unknown. ${reservationId ? 'The grant use remains reserved. ' : ''}Inspect the PR before retrying.` }
    if (reservationId) { db.refundMergeGrantUse(reservationId); grantsChanged(projectId) }
    const detail = error instanceof Error ? error.message : String(error)
    return { error: `GitHub refused the merge of ${pr.url}: ${detail.slice(0, 1_000)}`, pr_url: pr.url,
      authorized_by: authorizedBy(authority, grant), authorization_context: context }
  }

  // Finalization writes the use and journal atomically. Recovery may have
  // already finalized it while GitHub's response was in flight.
  let recorded = true
  try {
    if (reservationId) recorded = !!db.recordMergeGrantUse(reservationId)
  } catch {
    return { status: 'unknown', pr_url: pr.url, reservation_id: reservationId,
      authorized_by: authorizedBy(authority, grant), authorization_context: context,
      message: 'GitHub confirmed the merge, but its local audit could not be saved. The durable reservation remains for recovery.' }
  }
  const { line } = authorityText(db, authority)
  const title = state.title ? ` "${state.title.slice(0, 120)}"` : ''
  const summary = `Merged ${pr.url}${title} (${method}, ${state.headRefOid.slice(0, 7)}) ${line}`
  if (!reservationId) db.appendProjectStatusJournal(projectId, {
    summary,
    completed: [`Merged ${pr.owner}/${pr.repo}#${pr.number}${title}`],
    decisions: [authority.kind === 'grant' ? `Merge authorised by merge grant ${authority.grantId}` : `Merge authorised ${line}`]
  })
  hooks.pushToRenderer?.('project:statusChanged', { projectId })
  hooks.notifyUser?.(`Captain of ${project.name} merged a PR`, summary)
  hooks.pushToRenderer?.('mergeGrants:merged', { projectId, prUrl: pr.url, authority, authorizationContext: context, at: new Date().toISOString() })
  if (grant) {
    grantsChanged(projectId)
    if (recorded) hooks.report?.(projectId, 'merged_under_grant', summary, grant.id, context)
  }
  return {
    status: 'merged',
    pr_url: pr.url,
    head_sha: state.headRefOid,
    method,
    authorized_by: authorizedBy(authority, grant),
    authorization_context: context,
    message: authority.kind === 'grant'
      ? `Merged under the user's merge grant ${authority.grantId}. Say so when you report it ("merged under your merge grant").`
      : 'Merged.'
  }
}

/**
 * The per-project audit log: every grant (active or not), who granted it and
 * in which words, its scope, and each merge made under it with the PR, the
 * SHA and the checks state at merge time. Newest grant first.
 */
export function mergeGrantAudit(db: MergeGrantDb, projectId: string): MergeGrantAuditEntry[] {
  const now = Date.now()
  return db.listMergeGrants({ projectId }).map((grant) => ({
    grant,
    status: mergeGrantStatus(grant, now),
    uses: db.listMergeGrantUses(grant.id),
    pending: db.listPendingMergeGrantReservations(projectId).filter((reservation) => reservation.grant_id === grant.id)
  }))
}

/**
 * Recover a saved attempt only when GitHub confirms the exact head merged into
 * the observed base. OPEN, changed heads/bases, and transport failures remain
 * reserved for inspection: a delayed remote operation must never free a use.
 */
export async function reconcileMergeGrantReservations(db: MergeGrantDb, projectId?: string, hooks: MergeHooks = {}): Promise<void> {
  for (const reservation of db.listPendingMergeGrantReservations(projectId)) {
    try {
      const pr = parseGitHubPullRequestUrl(reservation.snapshot.pr_url)
      if (!pr) continue
      const state = await readPullRequestGate(pr)
      if (state.state !== 'MERGED' || state.headRefOid !== reservation.snapshot.head_sha || state.baseRefName !== reservation.snapshot.base_branch) continue
      const use = db.recordMergeGrantUse(reservation.id)
      if (!use) continue
      grantsChanged(reservation.project_id)
      const summary = `Recovered merge outcome for ${pr.url} after an interrupted request under merge grant ${reservation.grant_id}; GitHub confirms head ${state.headRefOid} merged.`
      hooks.pushToRenderer?.('project:statusChanged', { projectId: reservation.project_id })
      hooks.report?.(reservation.project_id, 'merged_under_grant', summary, reservation.grant_id, reservation.snapshot.authorization_context)
    } catch {
      // Keep the durable reservation and original snapshot until GitHub can confirm it.
    }
  }
}

/** One line for lists: the grant, its status and its uses. */
export function mergeGrantSummary(grant: MergeGrant): Record<string, unknown> {
  return {
    id: grant.id,
    project_id: grant.project_id,
    status: mergeGrantStatus(grant),
    allows: describeMergeGrant(grant),
    user_text: grant.user_text.length > 300 ? `${grant.user_text.slice(0, 299)}…` : grant.user_text,
    source: grant.source,
    uses: grant.uses,
    max_uses: grant.max_uses,
    created_at: grant.created_at,
    expires_at: grant.expires_at
  }
}
