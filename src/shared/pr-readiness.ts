/** Durable evidence used by the guarded pull-request landing path. */

export type PullRequestReadinessClassification =
  | 'ready'
  | 'pending'
  | 'blocked'
  | 'external_approval_required'
  | 'independent_review_required'

export type PullRequestReviewVerdict = 'CLEAN' | 'CHANGES_REQUIRED'

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
