/**
 * The Captain's merge tool (#137). Kept in its own module so other Captain
 * tool work touches task-management-tools.ts by one spread only.
 *
 * It has no Task API route: the main process answers it
 * (captain-github-tools.ts). A raw HTTP call to the Task API, or a session
 * without that handler, gets "Unknown route". Only the project's Captain may
 * call it (COORDINATOR_ONLY_TOOLS).
 */
import type { Tool } from '@modelcontextprotocol/server'

export const MERGE_PULL_REQUEST_TOOL = 'merge_pull_request'

export const MERGE_TOOL_NAMES: ReadonlySet<string> = new Set([MERGE_PULL_REQUEST_TOOL])

export const mergeTools: Tool[] = [
  {
    name: MERGE_PULL_REQUEST_TOOL,
    description:
      'Merge a GitHub pull request of this project, through 21x. 21x checks it first: open, not a draft, every check passed, and branch protection satisfied (required reviews, CODEOWNERS). ' +
      'A PR whose latest verified 21x review of its head asks for changes is not merged. It never uses admin or bypass flags. ' +
      'Returns status merged, blocked (with a durable blocker class; external_approval_required is not retryable), or an error. Only the project Captain may call it. Never merge any other way.',
    inputSchema: {
      type: 'object',
      properties: {
        pr_url: { type: 'string', description: 'The pull request URL: https://github.com/<owner>/<repo>/pull/<number>' },
        merge_method: { type: 'string', enum: ['squash', 'merge', 'rebase'], description: 'Default squash.' }
      },
      required: ['pr_url']
    }
  }
]
