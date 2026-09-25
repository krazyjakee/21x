/**
 * Delegated GitHub issue writes: authorization, the audit ledger, idempotency
 * and reconciliation (shared/issue-actions.ts has the taxonomy and the rules).
 *
 * The model, in one paragraph. A Captain may create, update and link issues in
 * its own project's configured GitHub repositories. No per-issue grant is
 * asked for, because an issue is bookkeeping. Everything else an external
 * write can be (merge/approve, deploy, delete, migration or replay, protection
 * bypass, a comment or any other outbound message, credential changes) is
 * refused here.
 *
 * Exactly once. Every write claims an {@link computeIdempotencyKey idempotency
 * key} in the `issue_writes` ledger before GitHub is called, and created
 * issues carry that key as a hidden marker in their body. A default key is
 * derived from durable operation inputs; a caller key is a project-scoped
 * immutable name. The claimed row binds either kind to the full operation and
 * the calling Captain, so an exact retry after a restart finds the
 * claim while any rebinding is refused. A claim whose lease ran out becomes
 * `unresolved` rather than free: the write may well have landed, so
 * {@link reconcileIssueWrites} asks GitHub before anything retries.
 */
import * as childProcess from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { promisify } from 'util'
import type { DatabaseManager } from './database'
import {
  DELEGATED_ACTION_CLASS,
  ISSUE_ACTIONS,
  checkForbiddenIssueArgs,
  checkIssueWriteCapability,
  findIdempotencyMarker,
  normalizeRepoSlug,
  parseGitHubIssueUrl,
  stripIdempotencyMarker,
  validateIssuePayload,
  withIdempotencyMarker,
  type IssueAction,
  type IssuePayload,
  type IssueWriteCapability,
  type IssueWriteDenial,
  type IssueWriteOrigin,
  type IssueWriteRecord
} from '../shared/issue-actions'

export type IssueWriteDb = Pick<
  DatabaseManager,
  | 'getProject'
  | 'getProjectRepos'
  | 'getTask'
  | 'getCoordinatorTask'
  | 'updateTask'
  | 'beginIssueWrite'
  | 'settleIssueWrite'
  | 'applyIssueWriteEffects'
  | 'getIssueWriteByKey'
  | 'listIssueWrites'
  | 'listIssueWritesPendingEffects'
  | 'listUnresolvedIssueWrites'
  | 'appendProjectStatusJournal'
> & Pick<DatabaseManager, 'db'>

// ── gh ────────────────────────────────────────────────────────

const GH_MAX_BUFFER = 10 * 1024 * 1024
/**
 * Deliberately short. A create that outlives it is `unresolved`, not failed:
 * reconciliation finds the issue by its marker instead of making a second one.
 */
export const GH_ISSUE_TIMEOUT_MS = 30_000

/** Runs `gh` with an argument list (never a shell) and returns stdout. Replaceable in tests. */
export type GhRunner = (args: string[]) => Promise<string>

const defaultGhRunner: GhRunner = async (args) => {
  const { stdout } = await promisify(childProcess.execFile)('gh', args, { maxBuffer: GH_MAX_BUFFER, timeout: GH_ISSUE_TIMEOUT_MS })
  return stdout
}

let ghRunner: GhRunner = defaultGhRunner

export function setIssueGhRunner(runner: GhRunner | null): void {
  ghRunner = runner ?? defaultGhRunner
}

/**
 * An error `gh` reports for a request GitHub certainly refused, so nothing was
 * written. Anything else (a timeout, a socket reset, the process dying) leaves
 * the outcome unknown and must not be retried blindly — the same rule
 * `confirmedMergeFailure` applies to merges.
 */
export function confirmedIssueWriteFailure(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message}` : String(error)
  if (/\bETIMEDOUT\b|\bECONNRESET\b|\bEPIPE\b|timed? ?out|killed|SIGTERM|SIGKILL/i.test(message)) return false
  if (/\bENOENT\b/.test(message)) return true
  return /\(HTTP (?:400|401|403|404|405|409|410|422|451)\)/.test(message)
}

// ── Hashing ───────────────────────────────────────────────────

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

// ── Capability ────────────────────────────────────────────────

/** The project's configured GitHub repositories, as canonical slugs. */
export function projectIssueRepos(db: IssueWriteDb, projectId: string): string[] {
  const slugs = db.getProjectRepos(projectId)
    .filter((repo) => repo.provider === 'github' && repo.org && repo.name)
    .map((repo) => normalizeRepoSlug(`${repo.org}/${repo.name}`))
    .filter((slug): slug is string => !!slug)
  return [...new Set(slugs)]
}

/**
 * What one project's Captain may do right now: every issue action, in the
 * project's configured GitHub repositories. The origin names the Captain, so
 * the ledger records who wrote and a retry finds its own claim.
 */
export function issueWriteCapability(
  db: IssueWriteDb,
  projectId: string,
  captain: { id: string; created_at: string } | null | undefined
): { capability: IssueWriteCapability; origin: IssueWriteOrigin } | { capability: null; denial: IssueWriteDenial } {
  const project = db.getProject(projectId)
  if (!project) {
    return { capability: null, denial: { code: 'capability_unavailable', message: 'That project no longer exists.' } }
  }
  if (project.archived) {
    return { capability: null, denial: { code: 'capability_unavailable', message: `Project "${project.name}" is archived; 21x does not write to its repositories.` } }
  }
  if (!captain) {
    return { capability: null, denial: { code: 'capability_unavailable', actionClass: DELEGATED_ACTION_CLASS, message: 'The project Captain task no longer exists.' } }
  }
  const configured = projectIssueRepos(db, projectId)
  if (configured.length === 0) {
    return {
      capability: null,
      denial: { code: 'repo_not_in_project', actionClass: DELEGATED_ACTION_CLASS, message: `Project "${project.name}" has no configured GitHub repositories, so there is nowhere to file an issue.` }
    }
  }
  return {
    capability: { projectId, actions: ISSUE_ACTIONS, repos: configured },
    origin: {
      kind: 'project_chat',
      messageId: captain.id,
      sessionId: null,
      textHash: hashText(captain.id),
      excerpt: `Captain of ${project.name}`,
      authoredAt: captain.created_at,
      correlationId: null
    }
  }
}

// ── Idempotency ───────────────────────────────────────────────

export function hashPayload(payload: IssuePayload): string {
  // Presence is part of an update's meaning: omitting `body` means "leave it
  // alone", while `body: ''` means "clear it". The same distinction applies
  // to labels. Encoding only present fields prevents those requests from
  // colliding on one idempotency key.
  const canonical: Record<string, unknown> = {}
  if (payload.title !== undefined) canonical.title = payload.title
  if (payload.body !== undefined) canonical.body = stripIdempotencyMarker(payload.body)
  if (payload.labels !== undefined) canonical.labels = [...payload.labels].sort()
  return hashText(JSON.stringify(canonical))
}

export interface IdempotencyInput {
  projectId: string
  repo: string
  action: IssueAction
  targetNumber?: number | null
  taskId?: string | null
  payloadHash: string
  /** What the caller asked to deduplicate on, when it named one. */
  clientKey?: string | null
}

/**
 * The key a write claims. It contains only things that survive a restart, so
 * the retry of an interrupted create computes the same key and finds its own
 * claim instead of filing a second issue. The ledger row, not this digest,
 * holds the immutable full operation and authorization-origin binding.
 */
export function computeIdempotencyKey(input: IdempotencyInput): string {
  const material = input.clientKey
    // A caller-named key is one immutable project-scoped name. Keeping repo,
    // action, target and payload out of the hash makes any attempted rebinding
    // find the original row, where beginIssueWrite rejects the mismatch.
    ? ['client', input.projectId, input.clientKey].join('\u0000')
    : ['derived', input.projectId, input.repo, input.action, String(input.targetNumber ?? ''), input.taskId ?? '', input.payloadHash].join('\u0000')
  return createHash('sha256').update(material).digest('hex').slice(0, 32)
}

/** How long one attempt may hold a claim before it counts as unresolved. */
export const CLAIM_LEASE_MS = 2 * GH_ISSUE_TIMEOUT_MS

// ── Performing a write ────────────────────────────────────────

export interface IssueWriteHooks {
  notifyUser?: (title: string, body: string) => void
  pushToRenderer?: (channel: string, data: unknown) => void
  /** Told after a write settles, so the Commander and the user can hear about it. */
  report?: (projectId: string, kind: 'written' | 'recovered' | 'unresolved', summary: string, record: IssueWriteRecord) => void
}

export interface IssueWriteRequest {
  projectId: string
  action: IssueAction
  /** owner/name, or the issue URL for update/link. */
  repo?: string
  issueUrl?: string
  issueNumber?: number | null
  taskId?: string | null
  payload: IssuePayload
  clientKey?: string | null
  /** Every remaining tool argument, checked for credential escalation. */
  rawArgs?: Record<string, unknown>
}

function denial(d: IssueWriteDenial): Record<string, unknown> {
  return {
    status: 'refused',
    code: d.code,
    ...(d.actionClass ? { action_class: d.actionClass } : {}),
    error: d.message
  }
}

function ledgerView(record: IssueWriteRecord): Record<string, unknown> {
  return {
    ledger_id: record.id,
    idempotency_key: record.idempotency_key,
    repo: record.repo,
    action: record.action,
    issue_url: record.external_url,
    issue_number: record.external_number,
    attempts: record.attempts,
    captain_task_id: record.captain_task_id
  }
}

/** A lease/epoch changed while an external call was in flight. Never report
 * the stale answer as if this attempt still owned the audit row. */
function staleAttemptResult(db: IssueWriteDb, key: string): Record<string, unknown> {
  const current = db.getIssueWriteByKey(key)
  if (current?.status === 'succeeded') {
    return { status: 'already_done', message: 'A newer reconciliation pass already recorded this write.', ...ledgerView(current) }
  }
  return {
    status: 'unresolved',
    error: 'This attempt lost its claim before its answer arrived. 21x kept the write unresolved and will reconcile it instead of trusting a stale result.',
    ...(current ? ledgerView(current) : {})
  }
}

/** Resolves the repository and issue number a request targets, or says why not. */
function resolveTarget(request: IssueWriteRequest): { slug: string; number: number | null } | IssueWriteDenial {
  if (request.action === 'create_issue') {
    const slug = normalizeRepoSlug(request.repo)
    if (!slug) return { code: 'repo_missing', actionClass: DELEGATED_ACTION_CLASS, message: 'Name the repository as owner/name.' }
    return { slug, number: null }
  }
  const parsed = parseGitHubIssueUrl(request.issueUrl)
  if (parsed) return { slug: parsed.slug, number: parsed.number }
  const slug = normalizeRepoSlug(request.repo)
  const number = typeof request.issueNumber === 'number' ? request.issueNumber : null
  if (!slug || !number || !Number.isSafeInteger(number) || number <= 0) {
    return {
      code: 'repo_missing',
      actionClass: DELEGATED_ACTION_CLASS,
      message: 'Name the issue as issue_url (https://github.com/<owner>/<repo>/issues/<number>), or as repo plus issue_number.'
    }
  }
  return { slug, number }
}

interface GhIssueResponse {
  number?: number
  html_url?: string
  title?: string
  state?: string
  body?: string | null
  labels?: Array<string | { name?: string }> | null
  pull_request?: unknown
}

const ISSUE_PAYLOAD_FIELDS = ['title', 'body', 'labels'] as const

/** The exact payload shape is durable reconciliation evidence, not caller input. */
function payloadFields(payload: IssuePayload): Array<typeof ISSUE_PAYLOAD_FIELDS[number]> {
  return ISSUE_PAYLOAD_FIELDS.filter((field) => payload[field] !== undefined)
}

function parsePayloadFields(fieldsJson: string): Array<typeof ISSUE_PAYLOAD_FIELDS[number]> | null {
  let fields: unknown
  try { fields = JSON.parse(fieldsJson) } catch { return null }
  if (!Array.isArray(fields) || fields.some((field) => !(ISSUE_PAYLOAD_FIELDS as readonly unknown[]).includes(field))) return null
  return fields as Array<typeof ISSUE_PAYLOAD_FIELDS[number]>
}

function issueLabels(current: GhIssueResponse): string[] | null {
  if (!Array.isArray(current.labels)) return null
  const labels = current.labels.map((label) => typeof label === 'string' ? label : label.name)
  if (labels.some((label) => typeof label !== 'string')) return null
  return (labels as string[]).sort()
}

function payloadForFields(current: GhIssueResponse, fieldsJson: string): IssuePayload | null {
  const fields = parsePayloadFields(fieldsJson)
  if (!fields) return null
  const payload: IssuePayload = {}
  for (const field of fields) {
    if (field === 'title') {
      if (typeof current.title !== 'string') return null
      payload.title = current.title
    } else if (field === 'body') {
      payload.body = current.body ?? ''
    } else {
      const labels = issueLabels(current)
      if (!labels) return null
      payload.labels = labels
    }
  }
  return payload
}

async function ghJson(args: string[]): Promise<GhIssueResponse> {
  const stdout = await ghRunner(args)
  try {
    return JSON.parse(stdout) as GhIssueResponse
  } catch {
    throw new Error(`GitHub returned something that is not JSON: ${stdout.slice(0, 200)}`)
  }
}

function createArgs(slug: string, payload: Required<Pick<IssuePayload, 'title'>> & IssuePayload, key: string): string[] {
  const args = ['api', '-X', 'POST', `/repos/${slug}/issues`, '-f', `title=${payload.title}`, '-f', `body=${withIdempotencyMarker(payload.body ?? '', key)}`]
  appendLabelFields(args, payload.labels)
  return args
}

function updateArgs(slug: string, number: number, payload: IssuePayload): string[] {
  const args = ['api', '-X', 'PATCH', `/repos/${slug}/issues/${number}`]
  if (payload.title !== undefined) args.push('-f', `title=${payload.title}`)
  if (payload.body !== undefined) args.push('-f', `body=${payload.body}`)
  appendLabelFields(args, payload.labels)
  return args
}

/** Raw nested fields preserve every label as a JSON string. `gh -F` performs
 * scalar coercion (`null` even becomes an empty array), so it is safe only for
 * the valueless sentinel that explicitly constructs an empty array. */
function appendLabelFields(args: string[], labels: string[] | undefined): void {
  if (labels === undefined) return
  if (labels.length === 0) {
    args.push('-F', 'labels[]')
    return
  }
  for (const label of labels) args.push('-f', `labels[]=${label}`)
}

export class AmbiguousIssueMarkerError extends Error {
  constructor(readonly candidates: ReadonlyArray<{ number: number; url: string }>) {
    super(`More than one GitHub issue carries this 21x idempotency marker (${candidates.map((item) => item.url).join(', ')}).`)
    this.name = 'AmbiguousIssueMarkerError'
  }
}

export class IncompleteIssueMarkerSearchError extends Error {
  constructor(readonly totalCount: number | null, readonly returnedCount: number, readonly incomplete: boolean) {
    super(
      `GitHub did not return a complete marker search result set ` +
      `(total=${totalCount ?? 'unknown'}, returned=${returnedCount}, incomplete=${incomplete}).`
    )
    this.name = 'IncompleteIssueMarkerSearchError'
  }
}

/**
 * Looks for an issue this project already created under `key`, by the hidden
 * marker in its body. This is how an external success that 21x never saw the
 * answer to is recovered instead of repeated.
 */
export async function findIssueByIdempotencyKey(
  expected: Pick<IssueWriteRecord, 'repo' | 'action' | 'idempotency_key' | 'payload_hash' | 'payload_fields'>
): Promise<{ number: number; url: string } | null> {
  if (expected.action !== 'create_issue') return null
  const query = `repo:${expected.repo} in:body "21x-issue-write:${expected.idempotency_key}"`
  const response = await ghJson(['api', '-X', 'GET', '/search/issues', '-f', `q=${query}`, '-f', 'per_page=100']) as unknown as {
    total_count?: number
    incomplete_results?: boolean
    items?: GhIssueResponse[]
  }
  const items = Array.isArray(response.items) ? response.items : []
  const totalCount = typeof response.total_count === 'number' && Number.isSafeInteger(response.total_count) && response.total_count >= 0
    ? response.total_count
    : null
  // Search is evidence only when GitHub says this response is complete. A
  // copied marker outside the returned page must not turn an apparently unique
  // hit into arbitrary success. Missing metadata is likewise not proof.
  if (response.incomplete_results !== false || totalCount === null || totalCount !== items.length) {
    throw new IncompleteIssueMarkerSearchError(totalCount, items.length, response.incomplete_results !== false)
  }
  const markerMatches = new Map<string, { number: number; url: string; issue: GhIssueResponse }>()
  for (const item of items) {
    if (item.pull_request) continue
    if (findIdempotencyMarker(item.body) !== expected.idempotency_key) continue
    if (typeof item.number !== 'number' || !item.html_url) continue
    const parsed = parseGitHubIssueUrl(item.html_url)
    if (!parsed || parsed.slug !== expected.repo || parsed.number !== item.number) continue
    markerMatches.set(`${item.number}\u0000${parsed.url}`, { number: item.number, url: parsed.url, issue: item })
  }
  const candidates = [...markerMatches.values()].sort((left, right) => left.number - right.number || left.url.localeCompare(right.url))
  if (candidates.length > 1) throw new AmbiguousIssueMarkerError(candidates)
  const candidate = candidates[0]
  if (!candidate) return null
  const expectedFields = parsePayloadFields(expected.payload_fields)
  if (!expectedFields) return null
  // For creates, omitted body/labels still have exact wire defaults. Require
  // those defaults too, otherwise a copied marker plus a matching title could
  // impersonate a title-only request while carrying unrelated content.
  if (!expectedFields.includes('body') && stripIdempotencyMarker(candidate.issue.body) !== '') return null
  if (!expectedFields.includes('labels')) {
    const labels = issueLabels(candidate.issue)
    if (!labels || labels.length !== 0) return null
  }
  const candidatePayload = payloadForFields(candidate.issue, expected.payload_fields)
  if (!candidatePayload || hashPayload(candidatePayload) !== expected.payload_hash) return null
  return { number: candidate.number, url: candidate.url }
}

async function rejectPullRequestTarget(target: { slug: string; number: number | null }): Promise<IssueWriteDenial | null> {
  if (!target.number) return null
  try {
    const current = await ghJson(['api', '-X', 'GET', `/repos/${target.slug}/issues/${target.number}`])
    if (current.pull_request !== undefined) {
      return {
        code: 'target_not_issue',
        actionClass: DELEGATED_ACTION_CLASS,
        message: `${target.slug}#${target.number} is a pull request. Delegated issue authority cannot update or link pull requests.`
      }
    }
    if (current.number !== target.number) {
      return { code: 'target_not_issue', actionClass: DELEGATED_ACTION_CLASS, message: `GitHub did not confirm ${target.slug}#${target.number} as an issue.` }
    }
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      code: 'target_not_issue',
      actionClass: DELEGATED_ACTION_CLASS,
      message: `21x could not confirm ${target.slug}#${target.number} as an issue, so it will not use issue authority for it: ${message}`
    }
  }
}

function taskRepoDenial(repos: readonly string[], slug: string, subject: string): IssueWriteDenial | null {
  if (repos.length === 0) return null
  const scoped = repos.map(normalizeRepoSlug).filter((repo): repo is string => !!repo)
  if (scoped.includes(slug)) return null
  return {
    code: 'repo_not_in_project',
    actionClass: DELEGATED_ACTION_CLASS,
    message: `${subject} is restricted to ${scoped.join(', ') || 'an invalid/unknown repository scope'}, not ${slug}. Issue writes never widen a task's repository scope.`
  }
}

interface IssueWriteAuthorizationSnapshot {
  captainTaskId: string
  captainSessionId: string | null
  origin: IssueWriteOrigin
}

function sameOrigin(left: IssueWriteOrigin, right: IssueWriteOrigin): boolean {
  return left.kind === right.kind &&
    left.messageId === right.messageId &&
    left.sessionId === right.sessionId &&
    left.textHash === right.textHash &&
    left.authoredAt === right.authoredAt &&
    left.correlationId === right.correlationId
}

/** Rebuilds the complete live capability from storage. Callers use it before
 * and after asynchronous preflights, and once more immediately before a
 * claimed write is dispatched, so an earlier snapshot can never outlive a
 * revocation, expiry, origin replacement or repository-scope narrowing. */
function authorizeIssueWriteNow(
  db: IssueWriteDb,
  request: IssueWriteRequest,
  target: { slug: string; number: number | null },
  expected?: IssueWriteAuthorizationSnapshot
): { snapshot: IssueWriteAuthorizationSnapshot } | { denial: IssueWriteDenial } {
  let taskProjectId: string | null = null
  let targetTaskRepos: readonly string[] = []
  if (request.taskId) {
    const task = db.getTask(request.taskId)
    if (!task) {
      return { denial: { code: 'cross_project_target', actionClass: DELEGATED_ACTION_CLASS, message: 'That task does not exist in this project.' } }
    }
    taskProjectId = task.project_id ?? null
    targetTaskRepos = task.repos ?? []
  }

  const captain = db.getCoordinatorTask(request.projectId)
  const resolved = issueWriteCapability(db, request.projectId, captain)
  if (!resolved.capability) return { denial: resolved.denial }
  const capabilityDenial = checkIssueWriteCapability(
    { projectId: request.projectId, action: request.action, repo: target.slug, taskProjectId },
    resolved.capability
  )
  if (capabilityDenial) return { denial: capabilityDenial }
  const captainRepoDenial = taskRepoDenial(captain?.repos ?? [], target.slug, 'The calling Captain task')
  if (captainRepoDenial) return { denial: captainRepoDenial }
  const targetTaskRepoDenial = taskRepoDenial(targetTaskRepos, target.slug, 'The target task')
  if (targetTaskRepoDenial) return { denial: targetTaskRepoDenial }
  if (!captain) {
    return { denial: { code: 'capability_unavailable', actionClass: DELEGATED_ACTION_CLASS, message: 'The project Captain task no longer exists.' } }
  }

  const snapshot: IssueWriteAuthorizationSnapshot = {
    captainTaskId: captain.id,
    captainSessionId: captain.session_id ?? null,
    origin: resolved.origin
  }
  if (expected && (
    snapshot.captainTaskId !== expected.captainTaskId ||
    snapshot.captainSessionId !== expected.captainSessionId ||
    !sameOrigin(snapshot.origin, expected.origin)
  )) {
    return {
      denial: {
        code: 'origin_not_trusted',
        actionClass: DELEGATED_ACTION_CLASS,
        message: 'The Captain changed while GitHub was being checked. 21x stopped before writing; retry the request.'
      }
    }
  }
  return { snapshot }
}

/**
 * Authorizes, claims, performs and records one delegated issue write.
 *
 * Every refusal returns `{ status: 'refused', code, error }` and touches
 * nothing; every attempt that reaches GitHub leaves a ledger row behind,
 * whatever happens to it.
 */
export async function performIssueWrite(
  db: IssueWriteDb,
  request: IssueWriteRequest,
  hooks: IssueWriteHooks = {}
): Promise<Record<string, unknown>> {
  // 1. Nothing may change who 21x acts as.
  const credentials = checkForbiddenIssueArgs(request.rawArgs ?? {})
  if (credentials) return denial(credentials)

  // 2. The target, before authority: a malformed call is not an authority question.
  const target = resolveTarget(request)
  if ('code' in target) return denial(target)

  // 3–4. The task scope and trusted human capability, captured once for the
  // origin identity and re-resolved after every asynchronous preflight.
  const initialAuthorization = authorizeIssueWriteNow(db, request, target)
  if ('denial' in initialAuthorization) return denial(initialAuthorization.denial)

  // 5. The payload itself.
  const payloadDenial = validateIssuePayload(request.payload, { requireTitle: request.action === 'create_issue' })
  if (payloadDenial) return denial(payloadDenial)
  if (request.clientKey && (request.clientKey.length > 200 || /[\u0000-\u001f\u007f]/.test(request.clientKey))) {
    return denial({ code: 'payload_rejected', actionClass: DELEGATED_ACTION_CLASS, message: 'idempotency_key must be at most 200 printable characters.' })
  }
  if (request.action === 'update_issue' && request.payload.title === undefined && request.payload.body === undefined && request.payload.labels === undefined) {
    return denial({ code: 'payload_rejected', actionClass: DELEGATED_ACTION_CLASS, message: 'Give a title, a body or labels to change.' })
  }

  // GitHub serves issues and pull requests from the same REST endpoint. A
  // numeric target therefore needs a read preflight; otherwise issue authority
  // could silently PATCH a pull request.
  if (request.action !== 'create_issue') {
    const targetDenial = await rejectPullRequestTarget(target)
    if (targetDenial) return denial(targetDenial)
  }

  // The GET above is a check/use boundary: authorization and every repository
  // intersection may have changed while it was in flight.
  const dispatchAuthorization = authorizeIssueWriteNow(db, request, target, initialAuthorization.snapshot)
  if ('denial' in dispatchAuthorization) return denial(dispatchAuthorization.denial)

  // 6. Claim the key.
  const payloadHash = hashPayload(request.payload)
  const fields = JSON.stringify(payloadFields(request.payload))
  const key = computeIdempotencyKey({
    projectId: request.projectId,
    repo: target.slug,
    action: request.action,
    targetNumber: target.number,
    taskId: request.taskId ?? null,
    payloadHash,
    clientKey: request.clientKey ?? null
  })
  const claim = db.beginIssueWrite({
    idempotency_key: key,
    project_id: request.projectId,
    captain_task_id: dispatchAuthorization.snapshot.captainTaskId,
    captain_session_id: dispatchAuthorization.snapshot.captainSessionId,
    task_id: request.taskId ?? null,
    repo: target.slug,
    action: request.action,
    target_number: target.number,
    payload_hash: payloadHash,
    payload_fields: fields,
    origin: dispatchAuthorization.snapshot.origin,
    lease_ms: CLAIM_LEASE_MS
  })

  if (claim.state === 'conflict') {
    return denial({
      code: 'idempotency_conflict',
      actionClass: DELEGATED_ACTION_CLASS,
      message:
        'That idempotency key is already bound to a different action, repository, target, payload, task or Captain. ' +
        'The original audit record was left unchanged; use its exact request or choose a new key.'
    })
  }

  if (claim.state === 'duplicate') {
    const completed = applyPostSuccessEffects(db, claim.record)
    if (!completed?.effects_applied_at) {
      return {
        status: 'unresolved',
        error: 'The GitHub write already succeeded, but its local task link/journal is still pending recovery. Nothing was sent to GitHub again.',
        ...ledgerView(claim.record)
      }
    }
    return {
      status: 'already_done',
      message: 'This exact write was already made under the same idempotency key; nothing was sent to GitHub again.',
      ...ledgerView(claim.record)
    }
  }
  if (claim.state === 'in_flight') {
    return {
      status: 'in_flight',
      message: 'Another attempt at this write is still running. Wait for it rather than starting a second one.',
      ...ledgerView(claim.record)
    }
  }
  if (claim.state === 'needs_reconcile') {
    const recovered = await reconcileIssueWrites(db, request.projectId, hooks)
    const settled = db.getIssueWriteByKey(key)
    if (settled?.status === 'succeeded') {
      return { status: 'already_done', message: 'A previous interrupted attempt had in fact succeeded; GitHub confirmed it.', recovered, ...ledgerView(settled) }
    }
    if (settled?.status === 'unresolved') {
      return {
        status: 'unresolved',
        error: 'A previous attempt at this write was interrupted and GitHub cannot yet confirm whether it landed. 21x will not repeat it until it can. Inspect the repository, or try again later.',
        ...ledgerView(settled)
      }
    }
    // Reconciliation proved nothing was written: claim again and go on.
    // Rebuild authorization after its asynchronous GitHub search before the
    // retry claim; a revocation or scope change during reconciliation wins.
    const retryAuthorization = authorizeIssueWriteNow(db, request, target, initialAuthorization.snapshot)
    if ('denial' in retryAuthorization) return denial(retryAuthorization.denial)
    const again = db.beginIssueWrite({
      idempotency_key: key,
      project_id: request.projectId,
      captain_task_id: retryAuthorization.snapshot.captainTaskId,
      captain_session_id: retryAuthorization.snapshot.captainSessionId,
      task_id: request.taskId ?? null,
      repo: target.slug,
      action: request.action,
      target_number: target.number,
      payload_hash: payloadHash,
      payload_fields: fields,
      origin: retryAuthorization.snapshot.origin,
      lease_ms: CLAIM_LEASE_MS
    })
    if (again.state !== 'reserved') {
      return { status: 'unresolved', error: 'This write could not be claimed for a retry.', ...ledgerView(again.record) }
    }
    return runClaimedWrite(db, again.record, request, target, key, hooks, initialAuthorization.snapshot)
  }

  return runClaimedWrite(db, claim.record, request, target, key, hooks, initialAuthorization.snapshot)
}

async function runClaimedWrite(
  db: IssueWriteDb,
  record: IssueWriteRecord,
  request: IssueWriteRequest,
  target: { slug: string; number: number | null },
  key: string,
  hooks: IssueWriteHooks,
  expectedAuthorization: IssueWriteAuthorizationSnapshot
): Promise<Record<string, unknown>> {
  // beginIssueWrite is synchronous, but keep a second live check immediately
  // adjacent to the external dispatch. This also protects alternative DB
  // implementations/hooks that may change state while a claim is recorded.
  const currentAuthorization = authorizeIssueWriteNow(db, request, target, expectedAuthorization)
  if ('denial' in currentAuthorization) {
    const failed = db.settleIssueWrite(record.id, {
      status: 'failed',
      attempt_epoch: record.attempt_epoch,
      error: currentAuthorization.denial.message
    })
    hooks.pushToRenderer?.('issueWrites:changed', { projectId: record.project_id })
    if (!failed) return staleAttemptResult(db, key)
    return denial(currentAuthorization.denial)
  }
  // `link_issue` writes nothing to GitHub: it records the association in 21x.
  if (request.action === 'link_issue') {
    const url = `https://github.com/${target.slug}/issues/${target.number}`
    const settled = db.settleIssueWrite(record.id, {
      status: 'succeeded',
      attempt_epoch: record.attempt_epoch,
      external_url: url,
      external_number: target.number,
      external_result: 'linked locally'
    })
    if (!settled) return staleAttemptResult(db, key)
    const completed = applyPostSuccessEffects(db, settled)
    hooks.pushToRenderer?.('issueWrites:changed', { projectId: record.project_id })
    if (!completed?.effects_applied_at) {
      return { status: 'unresolved', error: 'The issue link is durable but its task attachment/journal is awaiting recovery.', ...ledgerView(settled) }
    }
    return { status: 'linked', ...ledgerView(settled) }
  }

  let response: GhIssueResponse
  try {
    response = request.action === 'create_issue'
      ? await ghJson(createArgs(target.slug, { ...request.payload, title: request.payload.title as string }, key))
      : await ghJson(updateArgs(target.slug, target.number as number, request.payload))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (confirmedIssueWriteFailure(error)) {
      const settled = db.settleIssueWrite(record.id, { status: 'failed', attempt_epoch: record.attempt_epoch, error: message.slice(0, 2000) })
      if (!settled) return staleAttemptResult(db, key)
      hooks.pushToRenderer?.('issueWrites:changed', { projectId: record.project_id })
      return { status: 'failed', error: `GitHub refused the write: ${message}`, ...ledgerView(settled) }
    }
    // The outcome is unknown: the issue may exist. Never retry blindly.
    const settled = db.settleIssueWrite(record.id, { status: 'unresolved', attempt_epoch: record.attempt_epoch, error: message.slice(0, 2000) })
    if (!settled) return staleAttemptResult(db, key)
    hooks.report?.(record.project_id, 'unresolved', `An issue write in ${target.slug} was interrupted and is awaiting reconciliation`, settled)
    hooks.pushToRenderer?.('issueWrites:changed', { projectId: record.project_id })
    return {
      status: 'unresolved',
      error:
        `21x did not see GitHub's answer (${message}). The write may have landed, so it will not be repeated: ` +
        'reconciliation checks the repository and records the outcome.',
      ...ledgerView(settled)
    }
  }

  const number = typeof response.number === 'number' ? response.number : target.number
  const url = response.html_url ?? (number ? `https://github.com/${target.slug}/issues/${number}` : null)
  if (!url || !number) {
    const reason = 'GitHub accepted the request but returned no issue identity; the outcome must be reconciled.'
    const unsettled = db.settleIssueWrite(record.id, {
      status: 'unresolved',
      attempt_epoch: record.attempt_epoch,
      external_result: JSON.stringify(response).slice(0, 10_000),
      error: reason
    })
    if (!unsettled) return staleAttemptResult(db, key)
    hooks.report?.(record.project_id, 'unresolved', reason, unsettled)
    hooks.pushToRenderer?.('issueWrites:changed', { projectId: record.project_id })
    return { status: 'unresolved', error: reason, ...ledgerView(unsettled) }
  }
  const settled = db.settleIssueWrite(record.id, {
    status: 'succeeded',
    attempt_epoch: record.attempt_epoch,
    external_url: url,
    external_number: number,
    external_result: JSON.stringify({ number, state: response.state ?? null, title: response.title ?? null })
  })
  if (!settled) return staleAttemptResult(db, key)
  const completed = applyPostSuccessEffects(db, settled)
  hooks.pushToRenderer?.('issueWrites:changed', { projectId: record.project_id })
  if (!completed?.effects_applied_at) {
    return {
      status: 'unresolved',
      error: 'GitHub confirmed the write, but its local task link/journal is awaiting recovery. The external write will not be repeated.',
      ...ledgerView(settled)
    }
  }
  return { status: request.action === 'create_issue' ? 'created' : 'updated', ...ledgerView(settled) }
}

/** The mime type that marks an attachment row as a GitHub issue link. */
export const ISSUE_LINK_MIME = 'text/x-github-issue'

/**
 * Records the issue URL on the 21x task, without disturbing anything else on
 * it. The URL goes in `filename`, because that is the only field a task
 * attachment keeps (database/types.ts) and the mime type says what it is.
 */
function applyPostSuccessEffects(db: IssueWriteDb, record: IssueWriteRecord): IssueWriteRecord | undefined {
  if (record.effects_applied_at) return record
  const verb = record.action === 'create_issue' ? 'created' : record.action === 'update_issue' ? 'updated' : 'linked'
  try {
    return db.applyIssueWriteEffects(record.id, {
      ...(record.task_id && record.external_url
        ? { attachment: { taskId: record.task_id, url: record.external_url, id: randomUUID(), addedAt: new Date().toISOString() } }
        : {}),
      journal: {
        summary: `${verb === 'created' ? 'Filed' : verb === 'updated' ? 'Updated' : 'Linked'} ${record.external_url ?? record.repo} for ${record.task_id ?? 'the project'}.`,
        completed: [`${verb} ${record.external_url ?? record.repo}`],
        decisions: [`Issue write by the project Captain ${record.captain_task_id}`]
      }
    })
  } catch (error) {
    console.error('[IssueWrites] Could not apply post-success effects:', error)
    return undefined
  }
}

// ── Reconciliation ────────────────────────────────────────────

/**
 * Settles writes whose outcome 21x never saw. For a create, the hidden marker
 * makes the question answerable: an issue carrying the key exists, or it does
 * not. An update cannot be proved that way, so it is only settled when the
 * issue's current content already matches what was asked for.
 *
 * Returns how many rows it settled. A row it cannot decide stays `unresolved`
 * on purpose, so a delayed GitHub write can never turn into a second one.
 */
export async function reconcileIssueWrites(db: IssueWriteDb, projectId?: string, hooks: IssueWriteHooks = {}): Promise<number> {
  let settledCount = 0
  // A crash after the external result was committed but before the local task
  // link/journal transaction is recoverable from the succeeded ledger row.
  for (const record of db.listIssueWritesPendingEffects(projectId)) {
    if (applyPostSuccessEffects(db, record)?.effects_applied_at) settledCount++
  }
  for (const record of db.listUnresolvedIssueWrites(projectId)) {
    try {
      if (record.action === 'create_issue') {
        const found = await findIssueByIdempotencyKey(record)
        if (!found) {
          // Search is not a linearizable negative answer: GitHub may index a
          // create after this query returns. Keep the claim unresolved rather
          // than risk turning a delayed success into a duplicate issue.
          continue
        }
        const settled = db.settleIssueWrite(record.id, {
          status: 'succeeded',
          attempt_epoch: record.attempt_epoch,
          external_url: found.url,
          external_number: found.number,
          external_result: 'recovered by idempotency marker'
        })
        if (!settled) continue
        settledCount++
        applyPostSuccessEffects(db, settled)
        hooks.report?.(settled.project_id, 'recovered', `Recovered an interrupted issue write: ${found.url} already existed and is now recorded.`, settled)
        hooks.pushToRenderer?.('issueWrites:changed', { projectId: settled.project_id })
      } else if (record.action === 'update_issue' && record.target_number) {
        const current = await ghJson(['api', '-X', 'GET', `/repos/${record.repo}/issues/${record.target_number}`])
        const currentPayload = payloadForFields(current, record.payload_fields)
        if (!currentPayload || hashPayload(currentPayload) !== record.payload_hash) continue
        const settled = db.settleIssueWrite(record.id, {
          status: 'succeeded',
          attempt_epoch: record.attempt_epoch,
          external_url: `https://github.com/${record.repo}/issues/${record.target_number}`,
          external_number: record.target_number,
          external_result: 'recovered: the issue already carries the requested content'
        })
        if (!settled) continue
        settledCount++
        applyPostSuccessEffects(db, settled)
        hooks.report?.(settled.project_id, 'recovered', `Recovered an interrupted issue update: ${record.repo}#${record.target_number} already carries it.`, settled)
        hooks.pushToRenderer?.('issueWrites:changed', { projectId: settled.project_id })
      }
    } catch {
      // Leave it unresolved: an unanswerable question is not a negative answer.
    }
  }
  return settledCount
}

/** The audit ledger for a project, newest first. */
export function issueWriteAudit(db: IssueWriteDb, projectId: string, options: { taskId?: string; limit?: number } = {}): IssueWriteRecord[] {
  return db.listIssueWrites({ projectId, taskId: options.taskId, limit: options.limit ?? 50 })
}
