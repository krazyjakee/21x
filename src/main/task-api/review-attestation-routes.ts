import type { DatabaseManager } from '../database'
import type { TaskMcpScope } from '../mcp-servers/task-management-core'
import { createPullRequestReviewHandoff, recordPullRequestReviewAttestation } from '../pr-review-attestations'
import type { PullRequestReviewVerdict } from '../../shared/pr-readiness'

export function handleReviewAttestationRoute(
  db: DatabaseManager,
  route: string,
  params: Record<string, unknown>,
  trustedScope?: TaskMcpScope
): unknown {
  if (!['/create_pull_request_review_handoff', '/record_pull_request_review_attestation'].includes(route)) return undefined
  const taskId = trustedScope?.taskId
  const agentId = trustedScope?.agentId
  const task = taskId ? db.getTask(taskId) : undefined
  if (!taskId || !agentId || !task?.project_id) {
    return { error: 'A signed task- and agent-scoped session is required' }
  }
  if (route === '/create_pull_request_review_handoff') {
    const result = createPullRequestReviewHandoff(db, {
      projectId: task.project_id,
      implementationTaskId: taskId,
      implementationAgentId: agentId,
      reviewTaskId: String(params.review_task_id ?? ''),
      prUrl: String(params.pr_url ?? ''),
      headSha: String(params.head_sha ?? ''),
      baseSha: String(params.base_sha ?? '')
    })
    return result.ok ? { status: 'recorded', handoff: result.handoff } : { error: result.error }
  }
  const result = recordPullRequestReviewAttestation(db, {
    projectId: task.project_id,
    reviewTaskId: taskId,
    reviewerAgentId: agentId,
    implementationTaskId: String(params.implementation_task_id ?? ''),
    prUrl: String(params.pr_url ?? ''),
    headSha: String(params.head_sha ?? ''),
    baseSha: String(params.base_sha ?? ''),
    verdict: String(params.verdict ?? '') as PullRequestReviewVerdict,
    summary: typeof params.summary === 'string' ? params.summary : undefined
  })
  return result.ok ? { status: 'recorded', attestation: result.attestation } : { error: result.error }
}
