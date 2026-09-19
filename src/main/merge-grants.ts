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
  mergeGrantStatus,
  prNumbersMentioned,
  parseGitHubPullRequestUrl,
  type MergeGrant,
  type MergeGrantAuditEntry,
  type MergeGrantScopeInput,
  type MergeGrantSource,
  type PullRequestRef
} from '../shared/merge-grants'

export type MergeGrantDb = Pick<
  DatabaseManager,
  | 'getProject'
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

export type GrantResult = { ok: true; grant: MergeGrant; notes: string[] } | { ok: false; error: string }

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
  if (!project) return { ok: false, error: `Project not found: ${projectId}` }
  if (project.archived) return { ok: false, error: `Project "${project.name}" is archived.` }
  if (!mergeGrantSettingsFrom(project.settings).enabled) {
    return { ok: false, error: `Merge grants are turned off for "${project.name}". The user can turn them on in the project's settings (Escalation → Merge grants).` }
  }
  if (!binding.messageId || typeof binding.text !== 'string' || !binding.text.trim()) {
    return { ok: false, error: 'No message typed by the user is available to bind the grant to.' }
  }
  if (binding.text.length > MAX_GRANT_USER_TEXT_CHARS) return { ok: false, error: `Use a separate merge instruction of at most ${MAX_GRANT_USER_TEXT_CHARS} characters; the audit must retain it verbatim.` }
  const intent = checkMergeIntent(binding.text)
  if (!intent.ok) return { ok: false, error: intent.reason ?? 'The user did not ask for merging.' }

  if (intent.projectName && intent.projectName.toLowerCase() !== project.name.toLowerCase()) {
    return { ok: false, error: 'The instruction names a different project.' }
  }
  if (intent.repo && scope.repo && intent.repo.toLowerCase() !== scope.repo.trim().toLowerCase()) {
    return { ok: false, error: 'The grant cannot cover a different repository from the user instruction.' }
  }
  if (intent.baseBranch && scope.base_branch && intent.baseBranch !== scope.base_branch.trim()) {
    return { ok: false, error: 'The grant cannot cover a different base branch from the user instruction.' }
  }
  scope = { ...scope, repo: intent.repo ?? scope.repo, base_branch: intent.baseBranch ?? scope.base_branch }

  const notes: string[] = []
  const repos = githubRepoNames(db, projectId)
  if (repos.length === 0) return { ok: false, error: `"${project.name}" has no GitHub repository; merge grants cover GitHub pull requests only.` }

  let repo: string | null = null
  if (scope.repo !== undefined && scope.repo !== null && scope.repo !== '') {
    if (typeof scope.repo !== 'string') return { ok: false, error: 'repo must be "owner/name"' }
    const match = repos.find((name) => name.toLowerCase() === scope.repo!.trim().toLowerCase())
    if (!match) return { ok: false, error: `repo must be one of the project's GitHub repositories: ${repos.join(', ')}` }
    repo = match
  }

  let baseBranch: string | null = null
  if (scope.base_branch !== undefined && scope.base_branch !== null && scope.base_branch !== '') {
    if (typeof scope.base_branch !== 'string' || !BRANCH_NAME.test(scope.base_branch.trim())) return { ok: false, error: 'base_branch is not a valid branch name' }
    baseBranch = scope.base_branch.trim()
    return { ok: false, error: 'Base-branch-restricted merge grants are unavailable: GitHub cannot atomically pin the PR base during a merge. No grant was created.' }
  }

  let prNumbers: number[] = []
  if (scope.pr_numbers !== undefined && scope.pr_numbers !== null) {
    if (!Array.isArray(scope.pr_numbers) || scope.pr_numbers.some((n) => !Number.isInteger(n) || n <= 0)) {
      return { ok: false, error: 'pr_numbers must be positive integers' }
    }
    prNumbers = [...new Set(scope.pr_numbers)].sort((a, b) => a - b)
    if (prNumbers.length > MAX_PR_FILTER) return { ok: false, error: `pr_numbers holds at most ${MAX_PR_FILTER} numbers` }
  }
  const mentioned = prNumbersMentioned(binding.text)
  if (mentioned.length > 0) {
    if (prNumbers.length === 0) {
      prNumbers = mentioned
      notes.push(`Narrowed to the PRs the user named: ${mentioned.map((n) => `#${n}`).join(', ')}.`)
    } else {
      const outside = prNumbers.filter((n) => !mentioned.includes(n))
      if (outside.length > 0) {
        return { ok: false, error: `The user named ${mentioned.map((n) => `#${n}`).join(', ')}; the grant cannot also cover ${outside.map((n) => `#${n}`).join(', ')}.` }
      }
    }
  }

  if (prNumbers.length > 0 && !repo) {
    if (repos.length !== 1) return { ok: false, error: 'Name a repository or use a full PR URL: PR numbers are ambiguous across this project’s repositories.' }
    repo = repos[0]
  }

  let hours = DEFAULT_MERGE_GRANT_HOURS
  if (scope.expires_in_hours !== undefined && scope.expires_in_hours !== null) {
    const value = Number(scope.expires_in_hours)
    if (!Number.isFinite(value) || value <= 0) return { ok: false, error: 'expires_in_hours must be a positive number' }
    hours = value
    if (hours > MAX_MERGE_GRANT_HOURS) {
      hours = MAX_MERGE_GRANT_HOURS
      notes.push(`Expiry capped at ${MAX_MERGE_GRANT_HOURS} hours (7 days).`)
    }
  }

  let maxUses: number | null = null
  if (scope.max_merges !== undefined && scope.max_merges !== null) {
    if (!Number.isInteger(scope.max_merges) || scope.max_merges <= 0 || scope.max_merges > MAX_MERGES_CAP) {
      return { ok: false, error: `max_merges must be an integer from 1 to ${MAX_MERGES_CAP}` }
    }
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
    return { ok: false, error: 'That user message already backs a merge grant. One instruction grants one project; ask the user for a separate instruction for each project.' }
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

const PR_VIEW_FIELDS = 'url,number,title,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,baseRefName,statusCheckRollup'

/** Reads what the gate needs from GitHub, through the user's gh CLI. */
export async function readPullRequestGate(pr: PullRequestRef): Promise<PullRequestGateState> {
  const stdout = await ghRunner(['pr', 'view', pr.url, '--json', PR_VIEW_FIELDS])
  const raw = JSON.parse(stdout) as Record<string, unknown>
  if (!raw || typeof raw !== 'object' || raw.url !== pr.url || raw.number !== pr.number ||
      typeof raw.isDraft !== 'boolean' || typeof raw.baseRefName !== 'string' || !raw.baseRefName ||
      !Array.isArray(raw.statusCheckRollup) || raw.statusCheckRollup.some((check) => !check || typeof check !== 'object')) {
    throw new Error('GitHub returned incomplete or mismatched PR/check data')
  }
  const rollup = raw.statusCheckRollup as RawCheck[]
  return {
    url: typeof raw.url === 'string' ? raw.url : pr.url,
    number: typeof raw.number === 'number' ? raw.number : pr.number,
    title: typeof raw.title === 'string' ? raw.title : '',
    state: String(raw.state ?? '').toUpperCase(),
    isDraft: raw.isDraft === true,
    mergeable: String(raw.mergeable ?? '').toUpperCase(),
    mergeStateStatus: String(raw.mergeStateStatus ?? '').toUpperCase(),
    reviewDecision: String(raw.reviewDecision ?? '').toUpperCase(),
    headRefOid: typeof raw.headRefOid === 'string' ? raw.headRefOid : '',
    baseRefName: typeof raw.baseRefName === 'string' ? raw.baseRefName : '',
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
  report?: (projectId: string, kind: 'merged_under_grant' | 'needs_user', summary: string, grantId?: string) => void
}

export interface MergeRequest {
  projectId: string
  pr: PullRequestRef
  method: MergeMethod
  authority: MergeAuthority
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
 * Checks and merges one pull request under an authority the caller already
 * established. The PR must be in one of the project's GitHub repos and pass
 * {@link evaluatePullRequestGate}. A grant's use is reserved before the
 * merge runs and given back if it fails. Never throws: failures are results.
 */
export async function performMerge(db: MergeGrantDb, request: MergeRequest, hooks: MergeHooks = {}): Promise<Record<string, unknown>> {
  const { projectId, pr, method, authority } = request
  const project = db.getProject(projectId)
  if (!project) return { error: 'Project not found' }
  const repos = githubRepoNames(db, projectId).map((name) => name.toLowerCase())
  if (!repos.includes(`${pr.owner}/${pr.repo}`.toLowerCase())) {
    return { error: `${pr.owner}/${pr.repo} is not one of this project's GitHub repositories.` }
  }
  if (!isMergeMethod(method)) return { error: `merge_method must be one of ${MERGE_METHODS.join(', ')}` }

  let state: PullRequestGateState
  try {
    state = request.state ?? await readPullRequestGate(pr)
  } catch (error) {
    return { error: `Could not read ${pr.url} from GitHub: ${error instanceof Error ? error.message : String(error)}` }
  }

  const blocked = refuseUnmergeable(projectId, pr, state, hooks)
  if (blocked) return blocked

  let grant: MergeGrant | undefined
  let reservationId: string | undefined
  if (authority.kind === 'grant') {
    const current = findCoveringGrant(db, projectId, { ...pr, baseRefName: state.baseRefName }, authority.grantId)
    if (!current) return { error: 'The merge grant is no longer active or the project disabled it. Ask the user.' }
    if (current.base_branch) return { status: 'blocked', needs_external_approval: true, message: 'This grant restricts the base branch, which GitHub cannot pin atomically. Ask the user to handle this merge on GitHub; no grant authority was spent.' }
    const reserved = db.reserveMergeGrantUse(authority.grantId, {
      pr_url: pr.url, pr_title: state.title, base_branch: state.baseRefName,
      head_sha: state.headRefOid, method, merge_state: state.mergeStateStatus,
      review_decision: state.reviewDecision, checks: state.checks
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
      return { status: 'unknown', pr_url: pr.url, reservation_id: reservationId, message: `GitHub did not confirm the merge outcome. ${reservationId ? 'The grant use remains reserved. ' : ''}Inspect the PR before retrying.` }
    }
  } catch (error) {
    if (!confirmedMergeFailure(error)) return { status: 'unknown', pr_url: pr.url, reservation_id: reservationId, message: `The merge outcome is unknown. ${reservationId ? 'The grant use remains reserved. ' : ''}Inspect the PR before retrying.` }
    if (reservationId) { db.refundMergeGrantUse(reservationId); grantsChanged(projectId) }
    const detail = error instanceof Error ? error.message : String(error)
    return { error: `GitHub refused the merge of ${pr.url}: ${detail.slice(0, 1_000)}`, pr_url: pr.url }
  }

  if (reservationId) db.recordMergeGrantUse(reservationId)
  const { line } = authorityText(db, authority)
  const title = state.title ? ` "${state.title.slice(0, 120)}"` : ''
  const summary = `Merged ${pr.url}${title} (${method}, ${state.headRefOid.slice(0, 7)}) ${line}`
  db.appendProjectStatusJournal(projectId, {
    summary,
    completed: [`Merged ${pr.owner}/${pr.repo}#${pr.number}${title}`],
    decisions: [authority.kind === 'grant' ? `Merge authorised by merge grant ${authority.grantId}` : `Merge authorised ${line}`]
  })
  hooks.pushToRenderer?.('project:statusChanged', { projectId })
  hooks.notifyUser?.(`Captain of ${project.name} merged a PR`, summary)
  hooks.pushToRenderer?.('mergeGrants:merged', { projectId, prUrl: pr.url, authority, at: new Date().toISOString() })
  if (grant) {
    grantsChanged(projectId)
    hooks.report?.(projectId, 'merged_under_grant', summary, grant.id)
  }
  return {
    status: 'merged',
    pr_url: pr.url,
    head_sha: state.headRefOid,
    method,
    authorized_by: authority.kind === 'grant'
      ? { kind: 'grant', grant_id: authority.grantId, user_text: grant?.user_text, uses: grant?.uses, max_uses: grant?.max_uses, expires_at: grant?.expires_at }
      : authority,
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
export async function reconcileMergeGrantReservations(db: MergeGrantDb, projectId?: string): Promise<void> {
  for (const reservation of db.listPendingMergeGrantReservations(projectId)) {
    try {
      const pr = parseGitHubPullRequestUrl(reservation.snapshot.pr_url)
      if (!pr) continue
      const state = await readPullRequestGate(pr)
      if (state.state !== 'MERGED' || state.headRefOid !== reservation.snapshot.head_sha || state.baseRefName !== reservation.snapshot.base_branch) continue
      const use = db.recordMergeGrantUse(reservation.id)
      if (!use) continue
      db.appendProjectStatusJournal(reservation.project_id, {
        summary: `Recovered merge outcome for ${pr.url} after an interrupted request under merge grant ${reservation.grant_id}; GitHub confirms head ${state.headRefOid} merged.`,
        completed: [`Confirmed merged: ${pr.url}`]
      })
      grantsChanged(reservation.project_id)
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
