import type { DatabaseManager } from './database'
import { parseGitHubPullRequestUrl } from '../shared/merge-grants'
import type {
  PullRequestReviewAttestation,
  PullRequestReviewHandoff,
  PullRequestReviewVerdict
} from '../shared/pr-readiness'

const SHA = /^[0-9a-f]{40}$/i
const MAX_SUMMARY = 4_000

export interface ReviewAttestationInput {
  projectId: string
  reviewTaskId: string
  reviewerAgentId: string
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

export interface ReviewHandoffInput {
  projectId: string
  implementationTaskId: string
  implementationAgentId: string
  reviewTaskId: string
  prUrl: string
  headSha: string
  baseSha: string
}

export type ReviewHandoffResult =
  | { ok: true; handoff: PullRequestReviewHandoff }
  | { ok: false; error: string }

type ParsedReviewTarget =
  | { ok: false; error: string }
  | { ok: true; pr: NonNullable<ReturnType<typeof parseGitHubPullRequestUrl>>; repo: string; headSha: string; baseSha: string }

function parsedReviewTarget(
  db: DatabaseManager,
  projectId: string,
  prUrl: string,
  headSha: string,
  baseSha: string
): ParsedReviewTarget {
  const pr = parseGitHubPullRequestUrl(prUrl)
  if (!pr) return { ok: false, error: 'pr_url must be a canonical GitHub pull request URL' }
  if (!SHA.test(headSha) || !SHA.test(baseSha)) {
    return { ok: false, error: 'head_sha and base_sha must be full 40-character commit SHAs' }
  }
  const repo = `${pr.owner}/${pr.repo}`
  const inProject = db.getProjectRepos(projectId).some((candidate) =>
    candidate.provider === 'github' && `${candidate.org}/${candidate.name}`.toLowerCase() === repo.toLowerCase())
  if (!inProject) return { ok: false, error: `${repo} is not a GitHub repository of this project` }
  return { ok: true, pr, repo, headSha: headSha.toLowerCase(), baseSha: baseSha.toLowerCase() }
}

function isReviewTask(task: { type: string; labels: string[] }): boolean {
  return task.type === 'review' || task.labels.some((label) => ['review', 'security'].includes(label.toLowerCase()))
}

/**
 * Binds one immutable PR revision to the exact implementation/review tasks
 * and agents before review begins. The implementation identity comes from the
 * signed MCP session scope, never from model arguments or a later task lookup.
 */
export function createPullRequestReviewHandoff(
  db: DatabaseManager,
  input: ReviewHandoffInput
): ReviewHandoffResult {
  const target = parsedReviewTarget(db, input.projectId, input.prUrl, input.headSha, input.baseSha)
  if (!target.ok) return { ok: false, error: target.error }
  const implementation = db.getTask(input.implementationTaskId)
  const review = db.getTask(input.reviewTaskId)
  if (!implementation || !review || implementation.project_id !== input.projectId || review.project_id !== input.projectId) {
    return { ok: false, error: 'Both review and implementation tasks must belong to this project' }
  }
  if (implementation.id === review.id) return { ok: false, error: 'A task cannot review its own implementation' }
  if (!input.implementationAgentId || implementation.agent_id !== input.implementationAgentId) {
    return { ok: false, error: 'The signed implementation session no longer matches the implementation task assignment' }
  }
  if (!review.agent_id) return { ok: false, error: 'The review task must have an assigned agent before handoff' }
  if (review.agent_id === input.implementationAgentId) {
    return { ok: false, error: 'Independent review requires a different assigned agent from the implementation task' }
  }
  if (!isReviewTask(review)) return { ok: false, error: 'The receiving task must be a review or security task' }
  const handoff = db.createPullRequestReviewHandoff({
    project_id: input.projectId,
    repo: target.repo,
    pr_number: target.pr.number,
    head_sha: target.headSha,
    base_sha: target.baseSha,
    implementation_task_id: implementation.id,
    review_task_id: review.id,
    implementation_agent_id: input.implementationAgentId,
    reviewer_agent_id: review.agent_id
  })
  return handoff
    ? { ok: true, handoff }
    : { ok: false, error: 'The review handoff could not be saved' }
}

/**
 * Records an application-authenticated review assertion. The reviewer comes
 * from the signed session and the implementer from its signed handoff; neither
 * identity is accepted from model arguments or mutable task assignment alone.
 * GitHub COMMENT reviews remain comments and are never imported here.
 */
export function recordPullRequestReviewAttestation(
  db: DatabaseManager,
  input: ReviewAttestationInput
): ReviewAttestationResult {
  const target = parsedReviewTarget(db, input.projectId, input.prUrl, input.headSha, input.baseSha)
  if (!target.ok) return { ok: false, error: target.error }
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
  if (!input.reviewerAgentId || review.agent_id !== input.reviewerAgentId) {
    return { ok: false, error: 'The signed reviewer session no longer matches the review task assignment' }
  }
  if (!isReviewTask(review)) return { ok: false, error: 'The attesting task must be a review or security task' }
  const handoff = db.getPullRequestReviewHandoff({
    projectId: input.projectId,
    repo: target.repo,
    prNumber: target.pr.number,
    headSha: target.headSha,
    baseSha: target.baseSha,
    implementationTaskId: implementation.id,
    reviewTaskId: review.id
  })
  if (!handoff) {
    return { ok: false, error: 'No signed exact-head handoff binds this implementation task to this review task' }
  }
  if (handoff.reviewer_agent_id !== input.reviewerAgentId) {
    return { ok: false, error: 'The signed reviewer session does not match the agent named by the exact-head handoff' }
  }
  if (handoff.implementation_agent_id === input.reviewerAgentId) {
    return { ok: false, error: 'Independent review requires a different signed agent from the implementation handoff' }
  }

  const attestation = db.createPullRequestReviewAttestation({
    project_id: input.projectId,
    repo: target.repo,
    pr_number: target.pr.number,
    head_sha: target.headSha,
    base_sha: target.baseSha,
    implementation_task_id: implementation.id,
    review_task_id: review.id,
    implementation_agent_id: handoff.implementation_agent_id,
    reviewer_agent_id: input.reviewerAgentId,
    handoff_id: handoff.id,
    verdict: input.verdict,
    summary
  })
  return attestation
    ? { ok: true, attestation }
    : { ok: false, error: 'The review attestation could not be saved' }
}
