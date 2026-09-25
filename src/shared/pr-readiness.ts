/** Durable evidence used by the guarded pull-request landing path. */

export type PullRequestReadinessClassification =
  | 'ready'
  | 'pending'
  | 'blocked'
  | 'external_approval_required'
  | 'independent_review_required'

export type PullRequestReviewVerdict = 'CLEAN' | 'CHANGES_REQUIRED'

export interface PullRequestReviewHandoff {
  id: string
  project_id: string
  repo: string
  pr_number: number
  head_sha: string
  base_sha: string
  implementation_task_id: string
  review_task_id: string
  implementation_agent_id: string
  reviewer_agent_id: string
  created_at: string
}

export type CreatePullRequestReviewHandoff = Omit<PullRequestReviewHandoff, 'id' | 'created_at'>

export interface PullRequestReviewAttestation {
  id: string
  project_id: string
  repo: string
  pr_number: number
  head_sha: string
  base_sha: string
  implementation_task_id: string
  review_task_id: string
  implementation_agent_id: string
  reviewer_agent_id: string
  handoff_id: string
  verdict: PullRequestReviewVerdict
  summary: string
  created_at: string
}

export type CreatePullRequestReviewAttestation = Omit<PullRequestReviewAttestation, 'id' | 'created_at'>

export interface PullRequestReadinessSnapshot {
  id: string
  project_id: string
  repo: string
  pr_number: number
  head_sha: string
  base_sha: string
  state_fingerprint: string
  classification: PullRequestReadinessClassification
  reasons: string[]
  observed_state: Record<string, unknown>
  attestation_id: string | null
  created_at: string
  invalidated_at: string | null
  invalidated_reason: string | null
}

export type CreatePullRequestReadinessSnapshot = Omit<
  PullRequestReadinessSnapshot,
  'id' | 'created_at' | 'invalidated_at' | 'invalidated_reason'
>

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
