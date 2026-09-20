import type { Tool } from '@modelcontextprotocol/server'

export const RECORD_REVIEW_ATTESTATION_TOOL = 'record_pull_request_review_attestation'
export const CREATE_REVIEW_HANDOFF_TOOL = 'create_pull_request_review_handoff'

export const reviewAttestationTools: Tool[] = [{
  name: CREATE_REVIEW_HANDOFF_TOOL,
  description:
    'Hand one immutable GitHub PR head/base to a specific review task. ' +
    'The implementation task and agent come from the signed session scope; the caller cannot supply them.',
  inputSchema: {
    type: 'object',
    properties: {
      review_task_id: { type: 'string', description: 'The review/security task receiving this exact revision.' },
      pr_url: { type: 'string', description: 'Canonical GitHub pull request URL.' },
      head_sha: { type: 'string', description: 'Exact 40-character PR head SHA to review.' },
      base_sha: { type: 'string', description: 'Exact 40-character base SHA to review.' }
    },
    required: ['review_task_id', 'pr_url', 'head_sha', 'base_sha']
  }
}, {
  name: RECORD_REVIEW_ATTESTATION_TOOL,
  description:
    'Record a 21x independent-review attestation for one immutable GitHub PR head and base. ' +
    'Only a review/security task assigned to a different agent from the implementation task may call it. ' +
    'This is product evidence, not a GitHub APPROVING review, and never satisfies branch protection that requires one.',
  inputSchema: {
    type: 'object',
    properties: {
      implementation_task_id: { type: 'string', description: 'The implementation task reviewed.' },
      pr_url: { type: 'string', description: 'Canonical GitHub pull request URL.' },
      head_sha: { type: 'string', description: 'Exact 40-character reviewed PR head SHA.' },
      base_sha: { type: 'string', description: 'Exact 40-character reviewed base SHA.' },
      verdict: { type: 'string', enum: ['CLEAN', 'CHANGES_REQUIRED'] },
      summary: { type: 'string', description: 'Concise findings/evidence summary (maximum 4,000 characters).' }
    },
    required: ['implementation_task_id', 'pr_url', 'head_sha', 'base_sha', 'verdict']
  }
}]
