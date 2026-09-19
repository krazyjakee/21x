/**
 * Merge grants (#137): standing authority, given by the user in words they
 * typed, for a project's Captain to merge ready pull requests without a held
 * call per PR. Renderer-safe shapes and the pure rules; the main process
 * stores grants (database `merge_grants`) and enforces them
 * (src/main/merge-grants.ts, through the escalation gate of #66).
 *
 * The rules that make a grant safe live here so they can be tested alone:
 * - a grant is only ever built from a message the app recorded as typed by
 *   the user, and that message must itself ask for merging
 *   ({@link checkMergeIntent});
 * - when the message names pull requests, the grant cannot reach beyond
 *   them ({@link prNumbersMentioned});
 * - it lasts at most {@link MAX_MERGE_GRANT_HOURS} hours.
 */

/** The one action a grant can carry. Opening PRs is not grantable (see the issue). */
export type MergeGrantAction = 'merge_pr'

/** The only condition a grant can carry; the main process checks it on every merge. */
export const MERGE_GRANT_CONDITION = 'checks_green_and_protection_satisfied' as const
export type MergeGrantCondition = typeof MERGE_GRANT_CONDITION

/** Where the user typed the words the grant is bound to. */
export type MergeGrantSource = 'commander' | 'project_chat'

/** Default and maximum lifetime: seven days. "Until revoked" is deliberately not offered. */
export const DEFAULT_MERGE_GRANT_HOURS = 7 * 24
export const MAX_MERGE_GRANT_HOURS = 7 * 24

/** How long a message typed in a project chat stays available to bind a grant to. */
export const PROJECT_CHAT_GRANT_WINDOW_MS = 30 * 60_000

/** Longest verbatim user text stored with a grant. */
export const MAX_GRANT_USER_TEXT_CHARS = 4_000

export interface MergeGrant {
  id: string
  project_id: string
  action: MergeGrantAction
  condition: MergeGrantCondition
  /** `owner/name`; null = any GitHub repo of the project. */
  repo: string | null
  /** null = any base branch. */
  base_branch: string | null
  /** Empty = any PR (within the repo filter). */
  pr_numbers: number[]
  source: MergeGrantSource
  /** The Commander session, or the Captain task, the message was typed in. */
  source_session_id: string | null
  /** The id of the user's message the grant is bound to. */
  source_message_id: string
  /** The user's words, verbatim. */
  user_text: string
  created_at: string
  expires_at: string
  /** null = no count limit (the expiry still applies). */
  max_uses: number | null
  uses: number
  last_used_at: string | null
  revoked_at: string | null
  /** Who revoked it: `user` (the 21x UI) or `commander` (on the user's request). */
  revoked_by: string | null
}

/** One check as GitHub reported it when the merge ran. */
export interface MergeCheckRecord {
  name: string
  state: 'passed' | 'skipped' | 'failed' | 'pending'
}

/** The audit row of one merge made under a grant. */
export interface MergeGrantUse {
  id: string
  grant_id: string
  project_id: string
  pr_url: string
  pr_title: string
  base_branch: string
  head_sha: string
  method: string
  /** GitHub's mergeStateStatus at merge time (CLEAN / HAS_HOOKS). */
  merge_state: string
  review_decision: string
  checks: MergeCheckRecord[]
  merged_at: string
}

export type MergeGrantUseInput = Omit<MergeGrantUse, 'id' | 'grant_id' | 'project_id' | 'merged_at'>

export interface MergeGrantReservation {
  id: string
  grant_id: string
  project_id: string
  snapshot: MergeGrantUseInput
  created_at: string
}

/** A grant with its merges, newest first: the per-project audit view. */
export interface MergeGrantAuditEntry {
  grant: MergeGrant
  status: MergeGrantStatus
  uses: MergeGrantUse[]
  pending?: MergeGrantReservation[]
}

/** What the model may ask for; everything else about a grant is set by the app. */
export interface MergeGrantScopeInput {
  repo?: string | null
  base_branch?: string | null
  pr_numbers?: number[] | null
  expires_in_hours?: number | null
  max_merges?: number | null
}

/** Preserve invalid model arguments so creation can reject them, never drop a restriction. */
export function mergeGrantScopeFrom(input: Record<string, unknown>): MergeGrantScopeInput {
  return Object.fromEntries(['repo', 'base_branch', 'pr_numbers', 'expires_in_hours', 'max_merges']
    .filter((key) => input[key] !== undefined).map((key) => [key, input[key]])) as MergeGrantScopeInput
}

export type MergeGrantStatus = 'active' | 'expired' | 'revoked' | 'used_up'

export function mergeGrantStatus(grant: MergeGrant, now: number = Date.now()): MergeGrantStatus {
  if (grant.revoked_at) return 'revoked'
  if (!Number.isFinite(Date.parse(grant.expires_at)) || Date.parse(grant.expires_at) <= now) return 'expired'
  if (grant.max_uses !== null && grant.uses >= grant.max_uses) return 'used_up'
  return 'active'
}

// ── Per-project opt-in ────────────────────────────────────────

export interface MergeGrantSettings {
  /** Off by default: no grant can be created or used until the user turns it on. */
  enabled: boolean
}

export const DEFAULT_MERGE_GRANT_SETTINGS: MergeGrantSettings = { enabled: false }

/** `projects.settings.merge_grants`; anything but an explicit `enabled: true` is off. */
export function mergeGrantSettingsFrom(settings: Record<string, unknown> | null | undefined): MergeGrantSettings {
  const raw = settings?.merge_grants
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_MERGE_GRANT_SETTINGS }
  return { enabled: (raw as Record<string, unknown>).enabled === true }
}

// ── The user's words ──────────────────────────────────────────

export interface MergeIntentResult {
  ok: boolean
  reason?: string
  reasonCode?: MergeGrantReasonCode
  offendingScope?: string
  scopeKind?: 'project_wide'
  /** Restrictions read from the instruction itself, never from model arguments. */
  repo?: string
  baseBranch?: string
  projectName?: string
}

export type MergeGrantReasonCode =
  | 'FEATURE_DISABLED' | 'INELIGIBLE_PROVENANCE' | 'PROJECT_MISSING'
  | 'PROJECT_AMBIGUOUS' | 'PROJECT_MISMATCH' | 'PROJECT_ARCHIVED'
  | 'MULTIPLE_PROJECTS_UNSUPPORTED' | 'PR_SCOPE_UNSUPPORTED' | 'AMBIGUOUS_COMMAND'
  | 'INVALID_EXPIRY' | 'INVALID_USE_LIMIT' | 'MESSAGE_ALREADY_USED'

export interface MergeGrantProblem {
  reason_code: MergeGrantReasonCode
  message: string
  offending_scope: string
}

export interface MergeGrantFailure {
  ok: false
  error: string
  reason_code: MergeGrantReasonCode
  offending_scope: string
  accepted_examples: string[]
  blockers: MergeGrantProblem[]
}

/** Shared by both tool transports, including failures before grant creation. */
export function mergeGrantFailure(blockers: MergeGrantProblem[], project = '<project>'): MergeGrantFailure {
  const examples = [
    `Merge every safe ${project} pull request after required reviews and checks pass`,
    `Merge all open PRs in ${project} when required reviews and checks pass`,
    `Merge PR #12 in ${project} after required reviews and checks pass`
  ]
  return {
    ok: false,
    reason_code: blockers[0].reason_code,
    offending_scope: blockers[0].offending_scope,
    blockers,
    accepted_examples: examples,
    error: `No merge grant was created. ${blockers.map((b) => `[${b.reason_code}] ${b.message} (scope: ${b.offending_scope})`).join(' ')} Accepted wording (with eligible typed provenance and opt-in enabled): ${examples.map((e) => `"${e}"`).join('; ')}.`
  }
}

/**
 * Recognize a small, complete command grammar, not the presence of a keyword.
 * Quoted material, reports, questions about merging, negations and unrecognized
 * conditions fail closed. The model cannot decide that ambiguous text consents.
 */
export function checkMergeIntent(text: string): MergeIntentResult {
  const refused: MergeIntentResult = { ok: false, reasonCode: 'AMBIGUOUS_COMMAND', offendingScope: text, reason: 'No explicit merge instruction was recognized. Quoted text, reports, questions and ambiguous instructions cannot grant authority.' }
  let value = (text ?? '').trim().replace(/[.!]$/, '')
  if (!value || /[\n\r"“”`?'‘’]/.test(value)) return refused
  // The all/every form requires an explicit single scope and both gates.
  // It never falls through to the older, project-chat command grammar.
  if (/^(?:please\s+)?merge\s+(?:all|every)\b/i.test(value)) {
    const wide = value.match(/^(?:please\s+)?merge (?:all|every) (?:open|safe) (.+) (?:after|when|once) required reviews and checks pass$/i)
    if (!wide) return { ...refused, reasonCode: 'PR_SCOPE_UNSUPPORTED', reason: 'All/every PR commands must name one project or repository and require reviews and checks to pass.' }
    const before = wide[1].match(/^(.+?) (?:PRs?|pull requests?)$/i)
    const after = wide[1].match(/^(?:PRs?|pull requests?) in (.+)$/i)
    const name = (after?.[1] ?? before?.[1])?.trim()
    if (!name) return { ...refused, reasonCode: 'PROJECT_MISSING', reason: 'Name exactly one project or owner/repository in the command.' }
    if (/\b(?:and|or|all projects|every project)\b|[,;&+]/i.test(name)) {
      return { ...refused, reasonCode: 'MULTIPLE_PROJECTS_UNSUPPORTED', offendingScope: name, reason: 'One grant covers one project; cross-project grants are unsupported.' }
    }
    if (!/^[\w.-]+(?:[ /][\w.-]+)*$/.test(name)) return { ...refused, reasonCode: 'PR_SCOPE_UNSUPPORTED', offendingScope: name }
    if (name.includes('/')) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(name)) return { ...refused, reasonCode: 'PR_SCOPE_UNSUPPORTED', offendingScope: name }
      return { ok: true, scopeKind: 'project_wide', repo: name }
    }
    return { ok: true, scopeKind: 'project_wide', projectName: name }
  }
  let projectName: string | undefined
  const project = value.match(/^in ([\w .-]+),\s*/i)
  if (project) {
    projectName = project[1]
    value = value.slice(project[0].length)
  }
  const command = value.match(/^(?:please\s+|go ahead and\s+|I (?:want|instruct|authorize) you to )?merge\s+/i)
  if (!command) return refused
  value = value.slice(command[0].length)
  const target = value.match(/^(?:(?:the )?(?:ready |open |approved )?(?:PRs?|pull requests?)(?:\s+#?\d+)?|#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)(?=$|[ ,])/i)
  if (!target) return refused
  const targets = [target[0]]
  value = value.slice(target[0].length)
  while (true) {
    const next = value.match(/^(?:,\s*(?:and )?| and )((?:PR\s*#?|#)\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)(?=$|[ ,])/i)
    if (!next) break
    targets.push(next[1])
    value = value.slice(next[0].length)
  }
  let repo: string | undefined
  for (const target of targets) {
    const number = target.match(/(\d+)$/)?.[1]
    if (number && (!Number.isSafeInteger(Number(number)) || Number(number) <= 0)) return refused
    const url = target.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\//i)
    if (url) {
      if (repo && repo.toLowerCase() !== url[1].toLowerCase()) return refused
      repo = url[1]
    }
  }
  let baseBranch: string | undefined
  let conditionSeen = false
  while (value) {
    const condition = value.match(/^ (?:when|once|after) (?:required reviews and checks pass|green|(?:checks|tests|CI)(?: pass(?:es)?| (?:are |is )?green))(?=$| )/i)
    const into = value.match(/^ into ([\w./-]+)(?=$| )/i)
    const inRepo = value.match(/^ in ([\w.-]+\/[\w.-]+)(?=$| )/i)
    const inProject = value.match(/^ in ([\w.-]+(?: [\w.-]+)*?)(?= (?:when|once|after) |$)/i)
    if (condition && !conditionSeen) {
      conditionSeen = true
      value = value.slice(condition[0].length)
    } else if (into && !baseBranch) {
      baseBranch = into[1]
      value = value.slice(into[0].length)
    } else if (inRepo && (!repo || repo.toLowerCase() === inRepo[1].toLowerCase())) {
      repo = inRepo[1]
      value = value.slice(inRepo[0].length)
    } else if (inProject && !projectName) {
      projectName = inProject[1]
      if (/\b(?:and|or|every|all)\b/i.test(projectName)) return { ...refused, reasonCode: 'MULTIPLE_PROJECTS_UNSUPPORTED', offendingScope: projectName }
      value = value.slice(inProject[0].length)
    } else return refused
  }
  return { ok: true, repo, baseBranch, projectName }
}

/** PR numbers the text names: `#12`, `PR 12`, `pull request 12`, `/pull/12`. */
export function prNumbersMentioned(text: string): number[] {
  const found = new Set<number>()
  const patterns = [/(?:^|[^\w&])#(\d+)\b/g, /\bPRs?\s*#?(\d+)\b/gi, /\bpull\s+requests?\s*#?(\d+)\b/gi, /\/pull\/(\d+)\b/g]
  for (const pattern of patterns) {
    for (const match of (text ?? '').matchAll(pattern)) found.add(Number(match[1]))
  }
  return [...found].filter((n) => Number.isSafeInteger(n) && n > 0).sort((a, b) => a - b)
}

// ── GitHub pull request URLs ──────────────────────────────────

const GITHUB_PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/

export interface PullRequestRef {
  owner: string
  repo: string
  number: number
  /** Canonical `https://github.com/owner/repo/pull/N`. */
  url: string
}

/** A canonical GitHub PR URL, else null. Query strings, fragments and sub-pages are refused. */
export function parseGitHubPullRequestUrl(value: unknown): PullRequestRef | null {
  if (typeof value !== 'string') return null
  const match = value.trim().match(GITHUB_PR_URL)
  if (!match) return null
  const [, owner, repo, number] = match
  const n = Number(number)
  if (!Number.isSafeInteger(n) || n <= 0) return null
  return { owner, repo, number: n, url: `https://github.com/${owner}/${repo}/pull/${n}` }
}

/** Whether a grant's filters cover a PR (repo, base branch, numbers). Status is checked separately. */
export function grantCoversPullRequest(grant: Pick<MergeGrant, 'repo' | 'base_branch' | 'pr_numbers'>, pr: { owner: string; repo: string; number: number; baseRefName?: string | null }): boolean {
  if (grant.repo && grant.repo.toLowerCase() !== `${pr.owner}/${pr.repo}`.toLowerCase()) return false
  if (grant.pr_numbers.length > 0 && !grant.pr_numbers.includes(pr.number)) return false
  // An unknown base branch never matches a branch filter.
  if (grant.base_branch && grant.base_branch !== pr.baseRefName) return false
  return true
}

/** One line a person can read: what the grant allows. */
export function describeMergeGrant(grant: Pick<MergeGrant, 'repo' | 'base_branch' | 'pr_numbers' | 'max_uses' | 'expires_at'>): string {
  const what = grant.pr_numbers.length > 0 ? `PR${grant.pr_numbers.length > 1 ? 's' : ''} ${grant.pr_numbers.map((n) => `#${n}`).join(', ')}` : 'ready PRs'
  const where = grant.repo ? ` in ${grant.repo}` : ' in this project only'
  const into = grant.base_branch ? ` into ${grant.base_branch}` : ''
  const count = grant.max_uses !== null ? `, at most ${grant.max_uses}` : ''
  return `Merge ${what}${where}${into} when checks are green and branch protection is satisfied${count}; until ${grant.expires_at}`
}
