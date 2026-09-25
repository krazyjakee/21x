/**
 * The external-action taxonomy and the least-privilege capability check for
 * delegated GitHub issue writes.
 *
 * Why this exists
 * ---------------
 * 21x had one rule for every external write: "machine-relayed text grants no
 * authority" (shared/system-authority.ts), and one narrow exception, the merge
 * grant (#137), which the user has to give per scope in their own words.
 * That collapsed two very different things into one gate. Creating a GitHub
 * issue for work the user just asked for is ordinary delegated bookkeeping;
 * merging a pull request is not. Because only the merge shape had an answer,
 * a Captain asked to "open tickets for this" could do neither, and the work
 * stalled behind a grant that makes no sense for an issue.
 *
 * The distinction this module encodes:
 *
 * - {@link DELEGATED_ACTION_CLASS} — `delegated_issue_write`. Ordinary
 *   project-work bookkeeping in the project's own repositories. The Captain
 *   may do it with no per-issue grant.
 * - {@link SPECIALLY_GATED_CLASSES} — merge/approve, deploy/release,
 *   destructive delete, migration/replay, protection bypass, outbound message
 *   and credential change. Each keeps its own separate authorization; nothing
 *   in here can widen into one of them.
 *
 * Everything here is pure and free of Node built-ins so the renderer can show
 * the same taxonomy in the audit view. Hashing, the ledger and the GitHub
 * calls live in src/main/issue-writes.ts.
 */

// ── Action classes ────────────────────────────────────────────

/** Every class of external (outside-21x) action the policy distinguishes. */
export type ExternalActionClass =
  | 'delegated_issue_write'
  | 'merge_or_approve'
  | 'deploy_or_release'
  | 'destructive_delete'
  | 'migration_or_replay'
  | 'protection_bypass'
  | 'outbound_message'
  | 'credential_change'

/** The one class ordinary delegated project work may carry by itself. */
export const DELEGATED_ACTION_CLASS: ExternalActionClass = 'delegated_issue_write'

/** Classes that always need their own authorization, whatever the origin says. */
export const SPECIALLY_GATED_CLASSES: readonly ExternalActionClass[] = [
  'merge_or_approve',
  'deploy_or_release',
  'destructive_delete',
  'migration_or_replay',
  'protection_bypass',
  'outbound_message',
  'credential_change'
]

export const EXTERNAL_ACTION_CLASSES: readonly ExternalActionClass[] = [
  DELEGATED_ACTION_CLASS,
  ...SPECIALLY_GATED_CLASSES
]

export function isSpeciallyGated(actionClass: ExternalActionClass): boolean {
  return SPECIALLY_GATED_CLASSES.includes(actionClass)
}

export const EXTERNAL_ACTION_CLASS_LABELS: Record<ExternalActionClass, string> = {
  delegated_issue_write: 'Delegated issue write',
  merge_or_approve: 'Merging or approving',
  deploy_or_release: 'Deploying or releasing',
  destructive_delete: 'Deleting or overwriting',
  migration_or_replay: 'Migration or replay',
  protection_bypass: 'Bypassing protection',
  outbound_message: 'Messaging people outside 21x',
  credential_change: 'Changing credentials or identity'
}

/**
 * How each class is authorized. `delegated` = the Captain may do it as
 * ordinary project work; `separate_authorization` = the class
 * has its own gate (a merge grant, a held call, a human doing it themselves)
 * and this module never satisfies it.
 */
export const EXTERNAL_ACTION_AUTHORIZATION: Record<ExternalActionClass, 'delegated' | 'separate_authorization'> = {
  delegated_issue_write: 'delegated',
  merge_or_approve: 'separate_authorization',
  deploy_or_release: 'separate_authorization',
  destructive_delete: 'separate_authorization',
  migration_or_replay: 'separate_authorization',
  protection_bypass: 'separate_authorization',
  outbound_message: 'separate_authorization',
  credential_change: 'separate_authorization'
}

// ── Issue actions ─────────────────────────────────────────────

/**
 * The delegated issue operations. Deliberately three:
 * - `create_issue` — a new issue in one of the project's repositories;
 * - `update_issue` — title/body/labels of an issue 21x created or imported;
 * - `link_issue` — record an existing issue URL against a 21x task.
 *
 * Closing, commenting, assigning, milestone and transfer are *not* here:
 * closing an issue is a state change people act on, and a comment notifies
 * subscribers, so both sit in a specially gated class.
 */
export type IssueAction = 'create_issue' | 'update_issue' | 'link_issue'

export const ISSUE_ACTIONS: readonly IssueAction[] = ['create_issue', 'update_issue', 'link_issue']

export function isIssueAction(value: unknown): value is IssueAction {
  return typeof value === 'string' && (ISSUE_ACTIONS as readonly string[]).includes(value)
}

/** Issue operations that exist but are NOT delegated, with the class that owns them. */
export const NON_DELEGATED_ISSUE_OPERATIONS: Record<string, ExternalActionClass> = {
  comment_issue: 'outbound_message',
  close_issue: 'outbound_message',
  reopen_issue: 'outbound_message',
  assign_issue: 'outbound_message',
  delete_issue: 'destructive_delete',
  transfer_issue: 'destructive_delete',
  lock_issue: 'protection_bypass'
}

/**
 * The class of a named external operation, or null when the name is not one
 * 21x knows. Used to answer "may an ordinary delegated instruction do this?"
 * without a per-call allowlist that a new tool could be forgotten from.
 */
export function classifyExternalAction(name: string): ExternalActionClass | null {
  const key = name.trim().toLowerCase()
  if (!key) return null
  if (isIssueAction(key)) return DELEGATED_ACTION_CLASS
  if (key in NON_DELEGATED_ISSUE_OPERATIONS) return NON_DELEGATED_ISSUE_OPERATIONS[key]
  if (/^(merge|approve|dismiss_review|squash|rebase_merge)/.test(key)) return 'merge_or_approve'
  if (/^(deploy|release|promote|rollback|publish_package)/.test(key)) return 'deploy_or_release'
  if (/^(delete|destroy|purge|truncate|force_push)/.test(key)) return 'destructive_delete'
  if (/^(migrate|migration|replay|backfill|reprocess|requeue)/.test(key)) return 'migration_or_replay'
  if (/^(bypass|override|disable_protection|admin_)/.test(key)) return 'protection_bypass'
  if (/^(comment|notify|email|message|send_)/.test(key)) return 'outbound_message'
  if (/^(rotate_|set_token|set_secret|impersonate|auth_)/.test(key)) return 'credential_change'
  return null
}

// ── Repositories ──────────────────────────────────────────────

// A component of dots only (`.`, `..`) would traverse the API path if it ever
// reached one. The project allowlist stops it long before that; this stops it
// from existing at all.
const OWNER_NAME = /^(?!\.+\/)[A-Za-z0-9._-]{1,100}\/(?!\.+$)[A-Za-z0-9._-]{1,100}$/
const ISSUE_URL = /^https:\/\/github\.com\/([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})\/issues\/(\d{1,12})(?:[/?#].*)?$/i

export interface IssueRef {
  owner: string
  repo: string
  number: number
  /** Canonical `owner/name`, lower-cased for comparison. */
  slug: string
  url: string
}

/** `owner/name` lower-cased, or null when the value is not a repository name. */
export function normalizeRepoSlug(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  if (!OWNER_NAME.test(trimmed)) return null
  return trimmed.toLowerCase()
}

/** Parses a GitHub issue URL. Pull-request URLs are not issue URLs here. */
export function parseGitHubIssueUrl(value: unknown): IssueRef | null {
  if (typeof value !== 'string') return null
  const match = ISSUE_URL.exec(value.trim())
  if (!match) return null
  const [, owner, repo, number] = match
  const parsed = parseInt(number, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null
  return {
    owner,
    repo,
    number: parsed,
    slug: `${owner}/${repo}`.toLowerCase(),
    url: `https://github.com/${owner}/${repo}/issues/${parsed}`
  }
}

// ── Capability ────────────────────────────────────────────────

/**
 * What the Captain of one project may do.
 * Least privilege: the repository list is the project's configured GitHub
 * repositories, never "whatever the caller named", and the action list is a
 * subset of {@link ISSUE_ACTIONS}.
 */
export interface IssueWriteCapability {
  projectId: string
  actions: readonly IssueAction[]
  /** Canonical lower-cased `owner/name` slugs. Empty = the capability is unusable. */
  repos: readonly string[]
}

export type IssueWriteDenialCode =
  | 'capability_unavailable'
  | 'origin_not_trusted'
  | 'action_unknown'
  | 'action_specially_gated'
  | 'action_not_in_capability'
  | 'repo_missing'
  | 'repo_not_in_project'
  | 'cross_project_target'
  | 'target_not_issue'
  | 'idempotency_conflict'
  | 'credential_escalation'
  | 'payload_rejected'

export interface IssueWriteDenial {
  code: IssueWriteDenialCode
  /** The class the caller reached for, when it is a known one. */
  actionClass?: ExternalActionClass
  message: string
}

export interface IssueWriteRequest {
  projectId: string
  /** The issue action asked for, as the caller named it. */
  action: string
  /** `owner/name`, or a GitHub URL the caller gave. */
  repo: string
  /** The 21x task the issue belongs to, when the call names one. */
  taskProjectId?: string | null
}

/**
 * Least-privilege check. Returns null when the request is inside the
 * capability, otherwise the first reason it is not. The order matters: the
 * specially gated classes are refused before anything repository-shaped, so
 * "merge this" can never be answered with "that repo is not configured".
 */
export function checkIssueWriteCapability(
  request: IssueWriteRequest,
  capability: IssueWriteCapability | null
): IssueWriteDenial | null {
  const actionClass = classifyExternalAction(request.action)
  if (!actionClass) {
    return { code: 'action_unknown', message: `"${request.action}" is not an action 21x knows. Use one of: ${ISSUE_ACTIONS.join(', ')}.` }
  }
  if (isSpeciallyGated(actionClass)) {
    return {
      code: 'action_specially_gated',
      actionClass,
      message:
        `"${request.action}" is ${EXTERNAL_ACTION_CLASS_LABELS[actionClass].toLowerCase()}, which is authorized separately. ` +
        'A delegated project-work instruction never carries it: use the tool that owns that action, or ask the user.'
    }
  }
  if (!capability) {
    return { code: 'capability_unavailable', actionClass, message: 'Delegated issue writes are not available for this project right now.' }
  }
  if (capability.projectId !== request.projectId) {
    return { code: 'cross_project_target', actionClass, message: 'This authorization belongs to another project. Issue writes never cross a project boundary.' }
  }
  if (!capability.actions.includes(request.action as IssueAction)) {
    return {
      code: 'action_not_in_capability',
      actionClass,
      message: `This authorization covers ${capability.actions.join(', ') || 'no issue action'}, not "${request.action}".`
    }
  }
  if (request.taskProjectId !== undefined && request.taskProjectId !== null && request.taskProjectId !== request.projectId) {
    return { code: 'cross_project_target', actionClass, message: 'That task is in another project. Issue writes never cross a project boundary.' }
  }
  const slug = normalizeRepoSlug(request.repo)
  if (!slug) {
    return { code: 'repo_missing', actionClass, message: 'Name the repository as owner/name, one of this project\'s configured GitHub repositories.' }
  }
  if (!capability.repos.includes(slug)) {
    return {
      code: 'repo_not_in_project',
      actionClass,
      message:
        `${slug} is not one of this project's configured GitHub repositories` +
        `${capability.repos.length ? ` (${capability.repos.join(', ')})` : ' (the project has none)'}.`
    }
  }
  return null
}

// ── Payload checks ────────────────────────────────────────────

/**
 * Argument names that would change who 21x acts as, or where it acts. None of
 * them is accepted: issue writes always run as the user's own authenticated
 * `gh` CLI, against github.com, for this project's repositories.
 */
export const FORBIDDEN_ISSUE_ARGS: readonly string[] = [
  'token',
  'auth',
  'authorization',
  'gh_token',
  'github_token',
  'app_id',
  'installation_id',
  'private_key',
  'as_user',
  'on_behalf_of',
  'actor',
  'gh_host',
  'api_url',
  'base_url',
  'hostname',
  'admin',
  'bypass'
]

/** Secret shapes that must never be pushed to a public issue body. */
const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'a GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { label: 'a GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { label: 'an Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/ },
  { label: 'an OpenAI API key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { label: 'a Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'an AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'a private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'an Authorization header', pattern: /\bAuthorization:\s*(?:Bearer|token|Basic)\s+\S+/i }
]

/** `@name` outside code spans and e-mail addresses: an issue body pings those people. */
const MENTION = /(^|[^\w`/.@-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\b/

export const MAX_ISSUE_TITLE = 256
export const MAX_ISSUE_BODY = 60_000
export const MAX_ISSUE_LABELS = 20
export const MAX_ISSUE_LABEL_LENGTH = 50
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,49}$/

export interface IssuePayload {
  title?: string
  body?: string
  labels?: string[]
}

/**
 * Rejects a payload that would escalate the capability: a credential in the
 * body, an `@mention` (which makes an issue an outbound message to people who
 * never agreed to it), or something outside GitHub's own limits.
 */
export function validateIssuePayload(payload: IssuePayload, options: { requireTitle: boolean }): IssueWriteDenial | null {
  const title = payload.title
  if (options.requireTitle && (typeof title !== 'string' || !title.trim())) {
    return { code: 'payload_rejected', actionClass: DELEGATED_ACTION_CLASS, message: 'An issue needs a title.' }
  }
  if (title !== undefined) {
    if (typeof title !== 'string') return { code: 'payload_rejected', actionClass: DELEGATED_ACTION_CLASS, message: 'title must be text.' }
    if (title.length > MAX_ISSUE_TITLE) {
      return { code: 'payload_rejected', actionClass: DELEGATED_ACTION_CLASS, message: `The title is longer than ${MAX_ISSUE_TITLE} characters.` }
    }
    if (/[\r\n]/.test(title)) return { code: 'payload_rejected', actionClass: DELEGATED_ACTION_CLASS, message: 'The title must be a single line.' }
  }
  if (payload.body !== undefined) {
    if (typeof payload.body !== 'string') return { code: 'payload_rejected', actionClass: DELEGATED_ACTION_CLASS, message: 'body must be text.' }
    if (payload.body.length > MAX_ISSUE_BODY) {
      return { code: 'payload_rejected', actionClass: DELEGATED_ACTION_CLASS, message: `The body is longer than ${MAX_ISSUE_BODY} characters.` }
    }
    if (findIdempotencyMarker(payload.body)) {
      return {
        code: 'payload_rejected',
        actionClass: DELEGATED_ACTION_CLASS,
        message: 'The body contains a reserved 21x idempotency marker. Remove it; 21x adds its own marker after claiming the write.'
      }
    }
  }
  if (payload.labels !== undefined) {
    if (!Array.isArray(payload.labels)) return { code: 'payload_rejected', actionClass: DELEGATED_ACTION_CLASS, message: 'labels must be a list of strings.' }
    if (payload.labels.length > MAX_ISSUE_LABELS) {
      return { code: 'payload_rejected', actionClass: DELEGATED_ACTION_CLASS, message: `At most ${MAX_ISSUE_LABELS} labels.` }
    }
    for (const label of payload.labels) {
      if (typeof label !== 'string' || !LABEL.test(label)) {
        return { code: 'payload_rejected', actionClass: DELEGATED_ACTION_CLASS, message: `"${String(label).slice(0, 60)}" is not a usable label name.` }
      }
    }
  }
  // Labels leave the process just as title/body do. Treating them as harmless
  // metadata would let a caller publish a token as a label even though the
  // same token is refused everywhere else in the outgoing payload.
  const text = `${title ?? ''}\n${payload.body ?? ''}\n${payload.labels?.join('\n') ?? ''}`
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      return {
        code: 'credential_escalation',
        actionClass: DELEGATED_ACTION_CLASS,
        message: `The text looks like it contains ${label}. 21x will not publish credentials to GitHub. Remove it and try again.`
      }
    }
  }
  const mention = MENTION.exec(text)
  if (mention) {
    return {
      code: 'payload_rejected',
      actionClass: DELEGATED_ACTION_CLASS,
      message:
        `"@${mention[2]}" would notify a person. A delegated issue write is bookkeeping, not an outbound message: ` +
        'write the name without the @, or ask the user to ping them.'
    }
  }
  return null
}

/** Refuses any argument that would change 21x's credentials, host or privilege. */
export function checkForbiddenIssueArgs(args: Record<string, unknown>): IssueWriteDenial | null {
  for (const key of Object.keys(args)) {
    const normalized = key.trim().toLowerCase().replace(/^-+/, '')
    if (FORBIDDEN_ISSUE_ARGS.includes(normalized)) {
      return {
        code: 'credential_escalation',
        actionClass: DELEGATED_ACTION_CLASS,
        message:
          `"${key}" is not accepted. Issue writes always run as the user's own authenticated gh CLI against github.com; ` +
          'nothing may change the credentials, the host or the privilege level of the call.'
      }
    }
  }
  return null
}

// ── Idempotency marker ────────────────────────────────────────

export const IDEMPOTENCY_MARKER_PREFIX = '21x-issue-write'
const MARKER = /<!--\s*21x-issue-write:([A-Za-z0-9_-]{8,128})\s*-->/

/**
 * The hidden marker appended to a created issue's body. GitHub renders
 * nothing for it, and it is what reconciliation searches for when 21x never
 * saw the response to a create it may already have made.
 */
export function idempotencyMarker(key: string): string {
  return `<!-- ${IDEMPOTENCY_MARKER_PREFIX}:${key} -->`
}

export function findIdempotencyMarker(body: string | null | undefined): string | null {
  if (!body) return null
  const match = MARKER.exec(body)
  return match ? match[1] : null
}

/** Body with the marker appended exactly once. */
export function withIdempotencyMarker(body: string, key: string): string {
  if (findIdempotencyMarker(body) === key) return body
  const base = body.trimEnd()
  return `${base}${base ? '\n\n' : ''}${idempotencyMarker(key)}\n`
}

/** Body without the marker, for showing a human what 21x wrote. */
export function stripIdempotencyMarker(body: string | null | undefined): string {
  return (body ?? '').replace(MARKER, '').trimEnd()
}

// ── Ledger vocabulary ─────────────────────────────────────────

/**
 * `reserved` — 21x claimed the key and is about to call GitHub.
 * `succeeded` — GitHub confirmed, `external_url` is set.
 * `failed`    — GitHub refused for a reason that certainly made no change.
 * `unresolved`— the call timed out or the process died; the write may or may
 *               not have happened, so nothing may retry until reconciliation
 *               has looked.
 */
export type IssueWriteStatus = 'reserved' | 'succeeded' | 'failed' | 'unresolved'

export const ISSUE_WRITE_STATUSES: readonly IssueWriteStatus[] = ['reserved', 'succeeded', 'failed', 'unresolved']

/** The ledger's origin kind. New writes record the Captain as `project_chat`. */
export type IssueWriteOriginKind = 'project_chat' | 'commander_relay' | 'user_task_instruction'

export interface IssueWriteOrigin {
  kind: IssueWriteOriginKind
  /** The platform's id for the human's message. */
  messageId: string
  /** The chat or task session the human typed in. */
  sessionId: string | null
  /** Hash of the human's words; the words themselves are not copied to GitHub. */
  textHash: string
  /** A short excerpt, for the audit view. */
  excerpt: string
  authoredAt: string
  /** The Commander correlation this instruction was relayed under, when it was. */
  correlationId: string | null
}

/** One row of the audit ledger, as the rest of the app sees it. */
export interface IssueWriteRecord {
  id: string
  idempotency_key: string
  project_id: string
  /** The Captain's coordinator task. */
  captain_task_id: string | null
  captain_session_id: string | null
  /** The 21x task the issue is for. */
  task_id: string | null
  repo: string
  action: IssueAction
  target_number: number | null
  payload_hash: string
  /** Sorted JSON array of the payload fields included in the request. */
  payload_fields: string
  origin_kind: IssueWriteOriginKind
  origin_message_id: string
  origin_session_id: string | null
  origin_text_hash: string
  origin_excerpt: string
  origin_authored_at: string
  correlation_id: string | null
  status: IssueWriteStatus
  external_url: string | null
  external_number: number | null
  external_result: string | null
  error: string | null
  attempts: number
  /** Monotonic owner token for the current attempt/reconciliation pass. */
  attempt_epoch: number
  lease_expires_at: number | null
  created_at: string
  updated_at: string
  settled_at: string | null
  /** When the task attachment and journal entry were committed atomically. */
  effects_applied_at: string | null
}

/** One line of the audit ledger for a person to read. */
export function describeIssueWrite(record: IssueWriteRecord): string {
  const what = record.action === 'create_issue'
    ? `create an issue in ${record.repo}`
    : record.action === 'update_issue'
      ? `update ${record.repo}#${record.target_number ?? '?'}`
      : `link ${record.repo}#${record.target_number ?? '?'}`
  const outcome = record.status === 'succeeded'
    ? `→ ${record.external_url ?? 'done'}`
    : record.status === 'failed'
      ? `→ failed: ${record.error ?? 'unknown'}`
      : record.status === 'unresolved'
        ? '→ unresolved, awaiting reconciliation'
        : '→ in flight'
  return `${record.created_at} ${what} ${outcome} (origin ${record.origin_kind} ${record.origin_message_id}${record.correlation_id ? `, correlation ${record.correlation_id}` : ''})`
}
