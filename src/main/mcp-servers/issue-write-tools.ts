/**
 * The Captain's delegated GitHub issue tools. Kept in their own module so
 * other Captain tool work touches task-management-tools.ts by one spread only.
 *
 * Like the merge tool, none of them has a Task API route: the main process
 * answers them (issue-write-gate.ts). A raw HTTP call to the Task API, or a
 * session without that handler, gets "Unknown route". Only the
 * project's Captain may call them (COORDINATOR_ONLY_TOOLS).
 *
 * What is deliberately absent: commenting, closing, reopening, assigning,
 * transferring and deleting. Those are not delegated bookkeeping — a comment
 * notifies people, a close is a decision — so they keep their own gate and
 * have no tool here (shared/issue-actions.ts).
 */
import type { Tool } from '@modelcontextprotocol/server'

export const CREATE_ISSUE_TOOL = 'create_github_issue'
export const UPDATE_ISSUE_TOOL = 'update_github_issue'
export const LINK_ISSUE_TOOL = 'link_github_issue'
export const LIST_ISSUE_WRITES_TOOL = 'list_github_issue_writes'

export const ISSUE_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  CREATE_ISSUE_TOOL,
  UPDATE_ISSUE_TOOL,
  LINK_ISSUE_TOOL,
  LIST_ISSUE_WRITES_TOOL
])

export const issueWriteTools: Tool[] = [
  {
    name: CREATE_ISSUE_TOOL,
    description:
      'File a GitHub issue in one of this project\'s configured repositories, for work the user asked for. ' +
      'The write is idempotent: the same issue for the same task and repository is created once, however often this is retried or the app restarts. ' +
      'Every call is recorded in the project\'s issue-write ledger. ' +
      'Returns status created, already_done, unresolved, failed or refused. Only the project Captain may call it; never file issues with gh or an agent instead.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'owner/name, one of this project\'s configured GitHub repositories.' },
        title: { type: 'string', description: 'The issue title, one line.' },
        body: { type: 'string', description: 'The issue body, Markdown. No @mentions: an issue write does not notify people. Never put credentials in it.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply, at most 20.' },
        task_id: { type: 'string', description: 'The 21x task this issue is for. The issue URL is linked back to it, and the task scopes the idempotency key.' },
        idempotency_key: {
          type: 'string',
          description:
            'Optional. Omit it and 21x derives one from the project, repository, task and payload, which is what makes a retry safe. ' +
            'Give a distinct one only when the user genuinely wants a second issue for the same task and content.'
        }
      },
      required: ['repo', 'title']
    }
  },
  {
    name: UPDATE_ISSUE_TOOL,
    description:
      'Change the title, body or labels of an existing GitHub issue in one of this project\'s configured repositories. ' +
      'It cannot close, reopen, assign, comment on or transfer an issue: those are not offered here. ' +
      'Returns status updated, already_done, unresolved, failed or refused.',
    inputSchema: {
      type: 'object',
      properties: {
        issue_url: { type: 'string', description: 'https://github.com/<owner>/<repo>/issues/<number>. Or give repo and issue_number.' },
        repo: { type: 'string', description: 'owner/name, when issue_url is not given.' },
        issue_number: { type: 'integer', description: 'The issue number, when issue_url is not given.' },
        title: { type: 'string', description: 'The new title.' },
        body: { type: 'string', description: 'The new body. It replaces the old one.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'The complete new label set.' },
        task_id: { type: 'string', description: 'The 21x task this issue is for.' },
        idempotency_key: { type: 'string', description: 'Optional; derived when omitted.' }
      }
    }
  },
  {
    name: LINK_ISSUE_TOOL,
    description:
      'Record that an existing GitHub issue belongs to a 21x task. Nothing is written to GitHub; the issue URL is attached to the task and the link is logged in the ledger. ' +
      'The issue must be in one of this project\'s configured repositories.',
    inputSchema: {
      type: 'object',
      properties: {
        issue_url: { type: 'string', description: 'https://github.com/<owner>/<repo>/issues/<number>' },
        task_id: { type: 'string', description: 'The 21x task to link it to. Must be in this project.' }
      },
      required: ['issue_url', 'task_id']
    }
  },
  {
    name: LIST_ISSUE_WRITES_TOOL,
    description:
      'The project\'s GitHub issue-write ledger: what was written, to which repository, with what result. ' +
      'Reading it also reconciles any write whose outcome was never seen, so an issue created just before a crash is recovered rather than filed twice.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Only writes for this task.' },
        limit: { type: 'integer', description: 'How many entries, newest first. Default 20, maximum 100.' }
      }
    }
  }
]
