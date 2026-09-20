import type { DatabaseManager } from './database'
import { parseGitHubPullRequestUrl } from '../shared/merge-grants'
import type { PullRequestReviewAttestation, PullRequestReviewVerdict } from '../shared/pr-readiness'

const SHA = /^[0-9a-f]{40}$/i
const MAX_SUMMARY = 4_000

export interface ReviewAttestationInput {
  projectId: string
  reviewTaskId: string
  implementationTaskId: string
  prUrl: string
  headSha: string
  baseSha: string
  verdict: PullRequestReviewVerdict
  summary?: string
}

export type ReviewAttestationResult =
  | { ok: true; attestation: PullRequestReviewAttestation }
  | { ok: false; error: string }

/**
 * Records an application-authenticated review assertion. The caller cannot
 * supply either agent identity: both come from task rows in the same project.
 * GitHub COMMENT reviews remain comments and are never imported here.
 */
export function recordPullRequestReviewAttestation(
  db: DatabaseManager,
  input: ReviewAttestationInput
): ReviewAttestationResult {
  const pr = parseGitHubPullRequestUrl(input.prUrl)
  if (!pr) return { ok: false, error: 'pr_url must be a canonical GitHub pull request URL' }
  if (!SHA.test(input.headSha) || !SHA.test(input.baseSha)) {
    return { ok: false, error: 'head_sha and base_sha must be full 40-character commit SHAs' }
  }
  if (!['CLEAN', 'CHANGES_REQUIRED'].includes(input.verdict)) {
    return { ok: false, error: 'verdict must be CLEAN or CHANGES_REQUIRED' }
  }
  const summary = input.summary?.trim() ?? ''
  if (summary.length > MAX_SUMMARY) return { ok: false, error: `summary must be at most ${MAX_SUMMARY} characters` }

  const review = db.getTask(input.reviewTaskId)
  const implementation = db.getTask(input.implementationTaskId)
  if (!review || !implementation || review.project_id !== input.projectId || implementation.project_id !== input.projectId) {
    return { ok: false, error: 'Both review and implementation tasks must belong to this project' }
  }
  if (review.id === implementation.id) return { ok: false, error: 'A task cannot attest to its own implementation' }
  if (!review.agent_id || !implementation.agent_id) {
    return { ok: false, error: 'Both tasks must have an assigned agent before an attestation can be recorded' }
  }
  if (review.agent_id === implementation.agent_id) {
    return { ok: false, error: 'Independent review requires a different assigned agent from the implementation task' }
  }
  const isReviewTask = review.type === 'review' || review.labels.some((label) => ['review', 'security'].includes(label.toLowerCase()))
  if (!isReviewTask) return { ok: false, error: 'The attesting task must be a review or security task' }
  const repo = `${pr.owner}/${pr.repo}`
  const inProject = db.getProjectRepos(input.projectId).some((candidate) =>
    candidate.provider === 'github' && `${candidate.org}/${candidate.name}`.toLowerCase() === repo.toLowerCase())
  if (!inProject) return { ok: false, error: `${repo} is not a GitHub repository of this project` }

  const attestation = db.createPullRequestReviewAttestation({
    project_id: input.projectId,
    repo,
    pr_number: pr.number,
    head_sha: input.headSha.toLowerCase(),
    base_sha: input.baseSha.toLowerCase(),
    implementation_task_id: implementation.id,
    review_task_id: review.id,
    implementation_agent_id: implementation.agent_id,
    reviewer_agent_id: review.agent_id,
    verdict: input.verdict,
    summary
  })
  return attestation
    ? { ok: true, attestation }
    : { ok: false, error: 'The review attestation could not be saved' }
}
