import type { Tool } from '@modelcontextprotocol/server'

export const OPEN_DRAFT_PR_TOOL = 'open_draft_pull_request'

/** The only pull-request mutation exposed to an ordinary coding lineage. */
export const prWriteTools: Tool[] = [{
  name: OPEN_DRAFT_PR_TOOL,
  description:
    'Open one draft GitHub pull request from this coding task\'s current branch. ' +
    '21x verifies the immutable human task lineage, configured repository, clean worktree, branch head and base; pushes without force; and creates only a draft. ' +
    'An exact retry returns the existing PR. This tool cannot merge, approve, enable auto-merge, force-push, change protection or use administrator bypasses.',
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'owner/name, assigned to this task and configured in its project.' },
      title: { type: 'string', description: 'Pull request title, one line, at most 256 characters.' },
      body: { type: 'string', description: 'Pull request body in Markdown, at most 20,000 characters and without @mentions.' },
      base: { type: 'string', description: 'Optional base branch. It must equal the repository\'s configured/default branch.' }
    },
    required: ['repo', 'title']
  }
}]
