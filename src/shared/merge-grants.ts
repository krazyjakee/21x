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

/** A grant with its merges, newest first: the per-project audit view. */
export interface MergeGrantAuditEntry {
  grant: MergeGrant
  status: MergeGrantStatus
  uses: MergeGrantUse[]
}

/** What the model may ask for; everything else about a grant is set by the app. */
export interface MergeGrantScopeInput {
  repo?: string | null
  base_branch?: string | null
  pr_numbers?: number[] | null
  expires_in_hours?: number | null
  max_merges?: number | null
}

export type MergeGrantStatus = 'active' | 'expired' | 'revoked' | 'used_up'

export function mergeGrantStatus(grant: MergeGrant, now: number = Date.now()): MergeGrantStatus {
  if (grant.revoked_at) return 'revoked'
  if (Date.parse(grant.expires_at) <= now) return 'expired'
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

const MERGE_WORD = /\bmerg(?:e|es|ed|ing)\b/i
/**
 * A negation shortly before the merge word: "don't merge", "do not merge
 * anything", "never merge", "stop merging", "no merging", "without merging",
 * "hold off on merging". Checked per sentence, so "Tests are flaky, don't
 * merge yet" refuses even though it contains the word.
 */
const NEGATED_MERGE = /\b(?:don'?t|do\s+not|doesn'?t|never|no|not|stop|without|avoid|hold\s+off(?:\s+on)?|wait\s+(?:before|to))\b[^.!?\n]{0,40}\bmerg(?:e|es|ed|ing)\b/i

export interface MergeIntentResult {
  ok: boolean
  reason?: string
}

/**
 * Whether the user's own words ask for merging. Deliberately literal: a
 * grant needs the word "merge" (or merging/merged/merges) in text the user
 * typed, and no negation of it. "Ship it" or "land the PRs" is not enough;
 * the Commander must ask the user to say it.
 */
export function checkMergeIntent(text: string): MergeIntentResult {
  const value = (text ?? '').trim()
  if (!value) return { ok: false, reason: 'There is no message typed by the user to bind the grant to.' }
  if (!MERGE_WORD.test(value)) {
    return { ok: false, reason: 'The user\'s message does not ask for merging. A merge grant needs the user to say "merge" in their own words; ask them.' }
  }
  if (NEGATED_MERGE.test(value)) {
    return { ok: false, reason: 'The user\'s message says not to merge. No grant was created.' }
  }
  return { ok: true }
}

/** PR numbers the text names: `#12`, `PR 12`, `pull request 12`, `/pull/12`. */
export function prNumbersMentioned(text: string): number[] {
  const found = new Set<number>()
  const patterns = [/(?:^|[^\w&])#(\d{1,7})\b/g, /\bPRs?\s*#?(\d{1,7})\b/gi, /\bpull\s+requests?\s*#?(\d{1,7})\b/gi, /\/pull\/(\d{1,7})\b/g]
  for (const pattern of patterns) {
    for (const match of (text ?? '').matchAll(pattern)) found.add(Number(match[1]))
  }
  return [...found].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b)
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
  if (!Number.isInteger(n) || n <= 0) return null
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
  const where = grant.repo ? ` in ${grant.repo}` : ''
  const into = grant.base_branch ? ` into ${grant.base_branch}` : ''
  const count = grant.max_uses !== null ? `, at most ${grant.max_uses}` : ''
  return `Merge ${what}${where}${into} when checks are green and branch protection is satisfied${count}; until ${grant.expires_at}`
}
