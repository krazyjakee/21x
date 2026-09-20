/**
 * Delegated GitHub issue writes: authorization, the audit ledger, idempotency
 * and reconciliation (shared/issue-actions.ts has the taxonomy and the rules).
 *
 * The model, in one paragraph. A Captain may create, update and link issues in
 * its own project's configured GitHub repositories when 21x can point to an
 * originating human project-work instruction — a message the person typed,
 * recorded by the platform, not text a model claims is from a human. No
 * per-issue grant is asked for, because an issue is bookkeeping. Everything
 * else an external write can be (merge/approve, deploy, delete, migration or
 * replay, protection bypass, a comment or any other outbound message,
 * credential changes) keeps its own separate gate and is refused here.
 *
 * Exactly once. Every write claims an {@link computeIdempotencyKey idempotency
 * key} in the `issue_writes` ledger before GitHub is called, and created
 * issues carry that key as a hidden marker in their body. The key is derived
 * from durable things only (project, repository, action, target, task and a
 * hash of the payload), so a retry after a crash or a restart recomputes the
 * same key and finds the claim. A claim whose lease ran out becomes
 * `unresolved` rather than free: the write may well have landed, so
 * {@link reconcileIssueWrites} asks GitHub before anything retries.
 *
 * Nothing here trusts its caller for provenance. The origin is resolved from
 * platform records ({@link resolveIssueWriteOrigin}); a tool argument claiming
 * one is ignored, and {@link setIssueWriteOriginResolver} is the seam a richer
 * authorization chain plugs into without changing the gate.
 */
import * as childProcess from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { promisify } from 'util'
import type { DatabaseManager } from './database'
import { latestUserTypedProjectMessage } from './merge-grants'
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
  | 'getIssueWriteByKey'
  | 'listIssueWrites'
  | 'listUnresolvedIssueWrites'
  | 'appendProjectStatusJournal'
>

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

// ── Originating human authorization ───────────────────────────

/**
 * How long a human instruction keeps authorizing delegated bookkeeping. Long
 * enough for a Captain to plan and file the tickets the person just asked for;
 * short enough that yesterday's conversation cannot be replayed into new
 * external writes.
 */
export const ORIGIN_WINDOW_MS = 60 * 60 * 1000

/**
 * A Commander delegation 21x knows a human typed. Recorded by the relay path
 * (commander/project-tools.ts) at the moment `ask_captain` runs inside a turn
 * the person themselves started — never from a report-triggered turn, a
 * wake-up, or anything a model wrote. This is the platform record that makes a
 * relay trustworthy; the relay *text* proves nothing.
 */
export interface DelegatedAuthorization {
  projectId: string
  correlationId: string
  /** The Commander chat session the human typed in. */
  sessionId: string
  /** The stored id of the human's own message. */
  messageId: string
  text: string
  at: number
}

const delegationsByProject = new Map<string, DelegatedAuthorization>()

/**
 * Records that a human's own Commander message delegated work to a project.
 * Ignored unless the caller can name the stored human message: a turn with no
 * `userMessageId` was not typed by the person.
 */
export function recordDelegatedAuthorization(input: {
  projectId: string
  correlationId: string
  sessionId: string
  messageId?: string | null
  text: string
  at?: number
}): DelegatedAuthorization | null {
  if (!input.projectId || !input.correlationId || !input.messageId || !input.text.trim()) return null
  const entry: DelegatedAuthorization = {
    projectId: input.projectId,
    correlationId: input.correlationId,
    sessionId: input.sessionId,
    messageId: input.messageId,
    text: input.text,
    at: input.at ?? Date.now()
  }
  delegationsByProject.set(input.projectId, entry)
  return entry
}

export function clearDelegatedAuthorizations(): void {
  delegationsByProject.clear()
}

/** The newest delegation for a project, while it is still inside the window. */
export function latestDelegatedAuthorization(projectId: string, now = Date.now()): DelegatedAuthorization | null {
  const entry = delegationsByProject.get(projectId)
  if (!entry) return null
  if (now - entry.at > ORIGIN_WINDOW_MS) {
    delegationsByProject.delete(projectId)
    return null
  }
  return entry
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function excerpt(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * What the gate asks the resolver about. The caller identity comes from the
 * server-side scope (the project's Captain row), never from a tool argument.
 */
export interface IssueWriteAuthorizationQuery {
  projectId: string
  /** The Captain's coordinator task: the caller, as the platform knows it. */
  captainTaskId: string | null
  action: IssueAction
  /** The canonical `owner/name` this call targets. */
  repo: string
  now: number
}

/**
 * What a resolver answers with: the originating human instruction, and any
 * narrowing it imposes. `actions` and `repos` can only ever *narrow* — they
 * are intersected with the project's configured set, so a resolver cannot
 * widen a capability even if it wanted to.
 */
export interface IssueWriteAuthorizationResult {
  origin: IssueWriteOrigin
  actions?: readonly IssueAction[]
  repos?: readonly string[]
}

export type OriginResolver = (query: IssueWriteAuthorizationQuery) => IssueWriteAuthorizationResult | null

let originResolver: OriginResolver | null = null

/**
 * Replaces how the originating human instruction is found.
 *
 * The seam exists so the durable, cryptographically chained authorization
 * record (src/main/authorization.ts, PR #158) can take over from the default
 * below without this module or the gate changing. Once that lands the adapter
 * is mechanical, because {@link AUTHORIZATION_ACTION_FOR_ISSUE_ACTION} already
 * reconciles the two vocabularies:
 *
 * ```ts
 * setIssueWriteOriginResolver((query) => {
 *   if (!query.captainTaskId) return null
 *   const evidence = resolveTaskAuthorization({ db: raw }, {
 *     taskId: query.captainTaskId,
 *     projectId: query.projectId,
 *     action: AUTHORIZATION_ACTION_FOR_ISSUE_ACTION[query.action],
 *     repo: query.repo
 *   }, query.now)
 *   if (!evidence.allowed || !evidence.origin) return null
 *   return {
 *     origin: {
 *       kind: evidence.origin.source === 'project-chat' ? 'project_chat' : 'commander_relay',
 *       messageId: evidence.origin.messageId,
 *       sessionId: evidence.origin.sessionId,
 *       textHash: evidence.origin.textHash,
 *       excerpt: excerpt(evidence.origin.text),
 *       authoredAt: new Date(evidence.origin.at).toISOString(),
 *       correlationId: evidence.origin.correlationId
 *     },
 *     repos: evidence.scope.find((s) => s.projectId === query.projectId)?.repos
 *   }
 * })
 * ```
 *
 * A resolver may only return records the platform itself stored; nothing a
 * model can write may reach one.
 */
export function setIssueWriteOriginResolver(resolver: OriginResolver | null): void {
  originResolver = resolver
}

/**
 * The originating human instruction for delegated work in a project, or null.
 *
 * The interim default, until the durable chain above replaces it: two trusted
 * sources, newest first — a Commander relay the person started, and a message
 * the person typed in this project's own chat. Both are in-memory platform
 * records with a lifetime, which is why the ledger persists a snapshot of the
 * origin rather than a pointer to one.
 */
export function resolveIssueWriteAuthorization(query: IssueWriteAuthorizationQuery): IssueWriteAuthorizationResult | null {
  if (originResolver) return originResolver(query)
  const origin = defaultOrigin(query.projectId, query.now)
  return origin ? { origin } : null
}

/** The interim default, also exported so a test can assert it directly. */
export function resolveIssueWriteOrigin(projectId: string, now = Date.now()): IssueWriteOrigin | null {
  return defaultOrigin(projectId, now)
}

function defaultOrigin(projectId: string, now: number): IssueWriteOrigin | null {
  const delegation = latestDelegatedAuthorization(projectId, now)
  const typed = latestUserTypedProjectMessage(projectId, now)
  const useDelegation = delegation && (!typed || delegation.at >= typed.at)
  if (useDelegation && delegation) {
    return {
      kind: 'commander_relay',
      messageId: delegation.messageId,
      sessionId: delegation.sessionId,
      textHash: hashText(delegation.text),
      excerpt: excerpt(delegation.text),
      authoredAt: new Date(delegation.at).toISOString(),
      correlationId: delegation.correlationId
    }
  }
  if (typed) {
    return {
      kind: 'project_chat',
      messageId: typed.id,
      sessionId: typed.taskId,
      textHash: hashText(typed.text),
      excerpt: excerpt(typed.text),
      authoredAt: new Date(typed.at).toISOString(),
      correlationId: null
    }
  }
  return null
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
 * What one project's Captain may do right now, or null when no originating
 * human instruction backs it. The capability is built from the project and
 * then narrowed by the authorization: least privilege is the default, the
 * caller cannot widen it, and neither can the resolver.
 */
export function issueWriteCapability(
  db: IssueWriteDb,
  query: IssueWriteAuthorizationQuery
): { capability: IssueWriteCapability; origin: IssueWriteOrigin } | { capability: null; denial: IssueWriteDenial } {
  const { projectId } = query
  const project = db.getProject(projectId)
  if (!project) {
    return { capability: null, denial: { code: 'capability_unavailable', message: 'That project no longer exists.' } }
  }
  if (project.archived) {
    return { capability: null, denial: { code: 'capability_unavailable', message: `Project "${project.name}" is archived; 21x does not write to its repositories.` } }
  }
  const authorization = resolveIssueWriteAuthorization(query)
  if (!authorization) {
    return {
      capability: null,
      denial: {
        code: 'no_human_origin',
        actionClass: DELEGATED_ACTION_CLASS,
        message:
          'No originating human instruction backs this work right now. 21x writes to GitHub only for something the user asked for: ' +
          'ask them in this chat, or have the request come through the Commander. A wake-up, a heartbeat finding, an issue body or your own plan is not an instruction.'
      }
    }
  }
  const configured = projectIssueRepos(db, projectId)
  if (configured.length === 0) {
    return {
      capability: null,
      denial: { code: 'repo_not_in_project', actionClass: DELEGATED_ACTION_CLASS, message: `Project "${project.name}" has no configured GitHub repositories, so there is nowhere to file an issue.` }
    }
  }
  // Intersection, never union: a narrowing the authorization asks for is
  // honoured, a widening it attempts is discarded.
  const narrowedRepos = authorization.repos
    ? configured.filter((slug) => authorization.repos!.some((allowed) => normalizeRepoSlug(allowed) === slug))
    : configured
  const narrowedActions = authorization.actions
    ? ISSUE_ACTIONS.filter((action) => authorization.actions!.includes(action))
    : ISSUE_ACTIONS
  return { capability: { projectId, actions: narrowedActions, repos: narrowedRepos }, origin: authorization.origin }
}

// ── Idempotency ───────────────────────────────────────────────

export function hashPayload(payload: IssuePayload): string {
  return hashText(JSON.stringify({
    title: payload.title ?? null,
    body: stripIdempotencyMarker(payload.body ?? '') || null,
    labels: [...(payload.labels ?? [])].sort()
  }))
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
 * The key a write claims. Derived only from things that survive a restart, so
 * the retry of an interrupted create computes the same key and finds its own
 * claim instead of filing a second issue. The originating instruction is
 * deliberately *not* part of it: the same ticket asked for twice, or asked for
 * again after a crash, is still one ticket.
 */
export function computeIdempotencyKey(input: IdempotencyInput): string {
  const material = input.clientKey
    ? ['client', input.projectId, input.repo, input.action, input.clientKey].join('\u0000')
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
  /**
   * Run every check and stop before the claim. Used by the `ask_user` path, so
   * the person is only ever asked about a write that would really happen and a
   * refusal never becomes a held call. Returns `{ status: 'allowed' }`.
   */
  checkOnly?: boolean
}

function denial(d: IssueWriteDenial): Record<string, unknown> {
  return { status: 'refused', code: d.code, ...(d.actionClass ? { action_class: d.actionClass } : {}), error: d.message }
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
    authorized_by: {
      origin: record.origin_kind,
      human_message: record.origin_message_id,
      correlation_id: record.correlation_id,
      authored_at: record.origin_authored_at
    }
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
}

const ISSUE_PAYLOAD_FIELDS = ['title', 'body', 'labels'] as const

/** The exact payload shape is durable reconciliation evidence, not caller input. */
function payloadFields(payload: IssuePayload): Array<typeof ISSUE_PAYLOAD_FIELDS[number]> {
  return ISSUE_PAYLOAD_FIELDS.filter((field) => payload[field] !== undefined)
}

function payloadForFields(current: GhIssueResponse, fieldsJson: string): IssuePayload | null {
  let fields: unknown
  try { fields = JSON.parse(fieldsJson) } catch { return null }
  if (!Array.isArray(fields) || fields.some((field) => !(ISSUE_PAYLOAD_FIELDS as readonly unknown[]).includes(field))) return null
  const payload: IssuePayload = {}
  for (const field of fields as Array<typeof ISSUE_PAYLOAD_FIELDS[number]>) {
    if (field === 'title') {
      if (typeof current.title !== 'string') return null
      payload.title = current.title
    } else if (field === 'body') {
      payload.body = current.body ?? ''
    } else {
      if (!Array.isArray(current.labels)) return null
      const labels = current.labels.map((label) => typeof label === 'string' ? label : label.name)
      if (labels.some((label) => typeof label !== 'string')) return null
      payload.labels = (labels as string[]).sort()
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
  if (payload.labels?.length) args.push('--raw-field', `labels=${JSON.stringify(payload.labels)}`)
  return args
}

function updateArgs(slug: string, number: number, payload: IssuePayload): string[] {
  const args = ['api', '-X', 'PATCH', `/repos/${slug}/issues/${number}`]
  if (payload.title !== undefined) args.push('-f', `title=${payload.title}`)
  if (payload.body !== undefined) args.push('-f', `body=${payload.body}`)
  if (payload.labels !== undefined) args.push('--raw-field', `labels=${JSON.stringify(payload.labels)}`)
  return args
}

/**
 * Looks for an issue this project already created under `key`, by the hidden
 * marker in its body. This is how an external success that 21x never saw the
 * answer to is recovered instead of repeated.
 */
export async function findIssueByIdempotencyKey(slug: string, key: string): Promise<{ number: number; url: string } | null> {
  const query = `repo:${slug} in:body "21x-issue-write:${key}"`
  const response = await ghJson(['api', '-X', 'GET', '/search/issues', '-f', `q=${query}`, '-f', 'per_page=10']) as unknown as {
    items?: Array<{ number?: number; html_url?: string; body?: string | null; pull_request?: unknown }>
  }
  for (const item of response.items ?? []) {
    if (item.pull_request) continue
    if (findIdempotencyMarker(item.body) !== key) continue
    if (typeof item.number !== 'number' || !item.html_url) continue
    return { number: item.number, url: item.html_url }
  }
  return null
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

  // 3. The task the issue belongs to must be in this project.
  let taskProjectId: string | null = null
  if (request.taskId) {
    const task = db.getTask(request.taskId)
    if (!task) return denial({ code: 'cross_project_target', actionClass: DELEGATED_ACTION_CLASS, message: 'That task does not exist in this project.' })
    taskProjectId = task.project_id ?? null
  }

  // 4. The capability, from the project and a trusted human origin.
  const captain = db.getCoordinatorTask(request.projectId)
  const resolved = issueWriteCapability(db, {
    projectId: request.projectId,
    captainTaskId: captain?.id ?? null,
    action: request.action,
    repo: target.slug,
    now: Date.now()
  })
  if (!resolved.capability) return denial(resolved.denial)
  const { capability, origin } = resolved

  const capabilityDenial = checkIssueWriteCapability(
    { projectId: request.projectId, action: request.action, repo: target.slug, taskProjectId },
    capability
  )
  if (capabilityDenial) return denial(capabilityDenial)

  // 5. The payload itself.
  const payloadDenial = validateIssuePayload(request.payload, { requireTitle: request.action === 'create_issue' })
  if (payloadDenial) return denial(payloadDenial)
  if (request.action === 'update_issue' && request.payload.title === undefined && request.payload.body === undefined && request.payload.labels === undefined) {
    return denial({ code: 'payload_rejected', actionClass: DELEGATED_ACTION_CLASS, message: 'Give a title, a body or labels to change.' })
  }

  if (request.checkOnly) {
    return {
      status: 'allowed',
      repo: target.slug,
      action: request.action,
      authorized_by: { origin: origin.kind, human_message: origin.messageId, correlation_id: origin.correlationId, authored_at: origin.authoredAt }
    }
  }

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
    captain_task_id: captain?.id ?? null,
    captain_session_id: captain?.session_id ?? null,
    task_id: request.taskId ?? null,
    repo: target.slug,
    action: request.action,
    target_number: target.number,
    payload_hash: payloadHash,
    payload_fields: fields,
    origin,
    lease_ms: CLAIM_LEASE_MS
  })

  if (claim.state === 'duplicate') {
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
    const again = db.beginIssueWrite({
      idempotency_key: key,
      project_id: request.projectId,
      captain_task_id: captain?.id ?? null,
      captain_session_id: captain?.session_id ?? null,
      task_id: request.taskId ?? null,
      repo: target.slug,
      action: request.action,
      target_number: target.number,
      payload_hash: payloadHash,
      payload_fields: fields,
      origin,
      lease_ms: CLAIM_LEASE_MS
    })
    if (again.state !== 'reserved') {
      return { status: 'unresolved', error: 'This write could not be claimed for a retry.', ...ledgerView(again.record) }
    }
    return runClaimedWrite(db, again.record, request, target, key, hooks)
  }

  return runClaimedWrite(db, claim.record, request, target, key, hooks)
}

async function runClaimedWrite(
  db: IssueWriteDb,
  record: IssueWriteRecord,
  request: IssueWriteRequest,
  target: { slug: string; number: number | null },
  key: string,
  hooks: IssueWriteHooks
): Promise<Record<string, unknown>> {
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
    if (request.taskId) linkIssueToTask(db, request.taskId, url)
    journal(db, settled, 'linked')
    hooks.pushToRenderer?.('issueWrites:changed', { projectId: record.project_id })
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
  if (request.taskId && url) linkIssueToTask(db, request.taskId, url)
  journal(db, settled, request.action === 'create_issue' ? 'created' : 'updated')
  hooks.pushToRenderer?.('issueWrites:changed', { projectId: record.project_id })
  return { status: request.action === 'create_issue' ? 'created' : 'updated', ...ledgerView(settled) }
}

/** The mime type that marks an attachment row as a GitHub issue link. */
export const ISSUE_LINK_MIME = 'text/x-github-issue'

/**
 * Records the issue URL on the 21x task, without disturbing anything else on
 * it. The URL goes in `filename`, because that is the only field a task
 * attachment keeps (database/types.ts) and the mime type says what it is.
 */
function linkIssueToTask(db: IssueWriteDb, taskId: string, url: string): void {
  try {
    const task = db.getTask(taskId)
    if (!task) return
    const attachments = Array.isArray(task.attachments) ? task.attachments : []
    if (attachments.some((item) => item.filename === url)) return
    db.updateTask(taskId, {
      attachments: [...attachments, { id: randomUUID(), filename: url, size: 0, mime_type: ISSUE_LINK_MIME, added_at: new Date().toISOString() }]
    })
  } catch (error) {
    console.error('[IssueWrites] Could not link the issue to its task:', error)
  }
}

function journal(db: IssueWriteDb, record: IssueWriteRecord, verb: string): void {
  try {
    db.appendProjectStatusJournal(record.project_id, {
      summary: `${verb === 'created' ? 'Filed' : verb === 'updated' ? 'Updated' : 'Linked'} ${record.external_url ?? record.repo} for ${record.task_id ?? 'the project'}.`,
      completed: [`${verb} ${record.external_url ?? record.repo}`],
      decisions: [`Delegated issue write authorized by the user's ${record.origin_kind === 'commander_relay' ? 'Commander instruction' : 'message'} ${record.origin_message_id}${record.correlation_id ? ` (correlation ${record.correlation_id})` : ''}`]
    })
  } catch (error) {
    console.error('[IssueWrites] Could not write the journal entry:', error)
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
  for (const record of db.listUnresolvedIssueWrites(projectId)) {
    try {
      if (record.action === 'create_issue') {
        const found = await findIssueByIdempotencyKey(record.repo, record.idempotency_key)
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
        if (settled.task_id) linkIssueToTask(db, settled.task_id, found.url)
        journal(db, settled, 'created')
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
