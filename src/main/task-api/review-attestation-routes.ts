import type { DatabaseManager } from '../database'
import type { TaskMcpScope } from '../mcp-servers/task-management-core'
import { recordPullRequestReviewAttestation } from '../pr-review-attestations'
import type { PullRequestReviewVerdict } from '../../shared/pr-readiness'

export function handleReviewAttestationRoute(
  db: DatabaseManager,
  route: string,
  params: Record<string, unknown>,
  trustedScope?: TaskMcpScope
): unknown {
  if (route !== '/record_pull_request_review_attestation') return undefined
  const reviewTaskId = trustedScope?.taskId
  const reviewTask = reviewTaskId ? db.getTask(reviewTaskId) : undefined
  if (!reviewTaskId || !reviewTask?.project_id) {
    return { error: 'A task-scoped reviewer session is required' }
  }
  const result = recordPullRequestReviewAttestation(db, {
    projectId: reviewTask.project_id,
    reviewTaskId,
    implementationTaskId: String(params.implementation_task_id ?? ''),
    prUrl: String(params.pr_url ?? ''),
    headSha: String(params.head_sha ?? ''),
    baseSha: String(params.base_sha ?? ''),
    verdict: String(params.verdict ?? '') as PullRequestReviewVerdict,
    summary: typeof params.summary === 'string' ? params.summary : undefined
  })
  return result.ok ? { status: 'recorded', attestation: result.attestation } : { error: result.error }
}
