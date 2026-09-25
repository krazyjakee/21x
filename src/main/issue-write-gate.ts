/**
 * How the Captain's delegated GitHub issue tools
 * (mcp-servers/issue-write-tools.ts) are answered, for captain-github-tools.ts.
 *
 * An issue write is delegated work: filing a ticket for what the person asked
 * for is bookkeeping. Merging, deploying, deleting, replaying, bypassing
 * protection and messaging people are not, and none of them can be reached
 * through these tools. A settled create or update is reported to the user and
 * the Commander.
 *
 * Reading the ledger reconciles it first.
 */
import {
  issueWriteAudit,
  performIssueWrite,
  reconcileIssueWrites,
  type IssueWriteDb,
  type IssueWriteHooks,
  type IssueWriteRequest
} from './issue-writes'
import {
  CREATE_ISSUE_TOOL,
  LINK_ISSUE_TOOL,
  LIST_ISSUE_WRITES_TOOL,
  UPDATE_ISSUE_TOOL
} from './mcp-servers/issue-write-tools'
import { describeIssueWrite, type IssueAction } from '../shared/issue-actions'

export interface IssueWriteGateContext {
  db: IssueWriteDb
  projectId: string
  args: Record<string, unknown>
  hooks: IssueWriteHooks
  /** After a create or update settled: the usual report. */
  reportPerformed: (summary: string) => void
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Arguments that belong to a request, so everything else can be screened for escalation. */
const KNOWN_ARGS = new Set(['repo', 'title', 'body', 'labels', 'task_id', 'idempotency_key', 'issue_url', 'issue_number', 'limit', 'project_id'])

function unexpectedArgs(args: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (!KNOWN_ARGS.has(key)) rest[key] = value
  }
  return rest
}

function requestFrom(ctx: IssueWriteGateContext, action: IssueAction): IssueWriteRequest {
  const { args } = ctx
  return {
    projectId: ctx.projectId,
    action,
    repo: str(args, 'repo'),
    issueUrl: str(args, 'issue_url'),
    issueNumber: typeof args.issue_number === 'number' ? args.issue_number : null,
    taskId: str(args, 'task_id') ?? null,
    payload: action === 'link_issue'
      ? {}
      : {
          title: args.title as string | undefined,
          body: args.body as string | undefined,
          labels: Array.isArray(args.labels) ? (args.labels as string[]) : undefined
        },
    clientKey: str(args, 'idempotency_key') ?? null,
    rawArgs: unexpectedArgs(args)
  }
}

function summarize(action: IssueAction, args: Record<string, unknown>): string {
  if (action === 'create_issue') return `file a GitHub issue "${str(args, 'title') ?? ''}" in ${str(args, 'repo') ?? 'a project repository'}`
  if (action === 'update_issue') return `update the GitHub issue ${str(args, 'issue_url') ?? `${str(args, 'repo') ?? ''}#${String(args.issue_number ?? '')}`}`
  return `link the GitHub issue ${str(args, 'issue_url') ?? ''}`
}

/** Runs the write; a settled create or update is reported. */
async function writeAndReport(ctx: IssueWriteGateContext, action: IssueAction): Promise<Record<string, unknown>> {
  const result = await performIssueWrite(ctx.db, requestFrom(ctx, action), ctx.hooks)
  const settled = result.status === 'created' || result.status === 'updated'
  if (action !== 'link_issue' && settled) {
    ctx.reportPerformed(`${summarize(action, ctx.args)}${result.issue_url ? ` → ${String(result.issue_url)}` : ''}`)
  }
  return result
}

/**
 * Answers one of the issue tools, or returns `undefined` when `tool` is not
 * one of them.
 */
export async function handleIssueWriteTool(tool: string, ctx: IssueWriteGateContext): Promise<unknown | undefined> {
  switch (tool) {
    case CREATE_ISSUE_TOOL:
      return writeAndReport(ctx, 'create_issue')
    case UPDATE_ISSUE_TOOL:
      return writeAndReport(ctx, 'update_issue')
    case LINK_ISSUE_TOOL:
      // Linking writes nothing to GitHub: a 21x-side association, still audited.
      return writeAndReport(ctx, 'link_issue')
    case LIST_ISSUE_WRITES_TOOL: {
      await reconcileIssueWrites(ctx.db, ctx.projectId, ctx.hooks)
      const limit = Math.min(Math.max(typeof ctx.args.limit === 'number' ? ctx.args.limit : 20, 1), 100)
      const entries = issueWriteAudit(ctx.db, ctx.projectId, { taskId: str(ctx.args, 'task_id'), limit })
      return { total: entries.length, entries: entries.map((record) => ({ ...record, summary: describeIssueWrite(record) })) }
    }
    default:
      return undefined
  }
}
