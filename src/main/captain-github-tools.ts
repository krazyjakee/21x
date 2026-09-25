/**
 * The Captain's GitHub tools: `merge_pull_request` (pull-request-merge.ts)
 * and the delegated issue tools (issue-write-gate.ts). None of them has a
 * Task API route; the project-scoped task-management tools hand them here
 * through `setCoordinatorCallHandler` (see {@link installCaptainGithubTools}).
 * Every other Captain call just runs.
 *
 * What a person should hear about — a merge, an issue written, a merge
 * blocked on someone outside 21x — becomes a {@link CaptainActionEvent}: an OS
 * notification and, once commander/report-tools.ts installs a handler with
 * {@link setCaptainActionHandler}, a report in the Commander.
 */
import type { DatabaseManager } from './database'
import { notifyRenderer } from './task-api/state'
import { setCoordinatorCallHandler, type CoordinatorCallHandler } from './mcp-servers/task-management-core'
import { parseGitHubPullRequestUrl } from '../shared/pr-readiness'
import { handleIssueWriteTool } from './issue-write-gate'
import { reconcileIssueWrites, type IssueWriteDb, type IssueWriteHooks } from './issue-writes'
import { MERGE_PULL_REQUEST_TOOL, MERGE_TOOL_NAMES } from './mcp-servers/merge-tools'
import { ISSUE_WRITE_TOOL_NAMES } from './mcp-servers/issue-write-tools'
import { isMergeMethod, performMerge, type MergeDb, type MergeHooks, type MergeMethod } from './pull-request-merge'

// ── Events and the Commander seam ─────────────────────────────

export interface CaptainActionEvent {
  projectId: string
  tool: string
  /** One line a person can read: what the Captain did, or what is blocked. */
  summary: string
  /** `performed`: the Captain merged or wrote an issue. `needs_user`: it is blocked on a person outside 21x. */
  outcome: 'performed' | 'needs_user'
  /** ISO time. */
  at: string
}

export type CaptainActionHandler = (event: CaptainActionEvent) => void

let actionHandler: CaptainActionHandler | null = null

/** commander/report-tools.ts installs the handler that turns an event into a Commander report. */
export function setCaptainActionHandler(handler: CaptainActionHandler | null): void {
  actionHandler = handler
}

export function reportCaptainAction(event: CaptainActionEvent): void {
  if (!actionHandler) return
  try {
    actionHandler(event)
  } catch (error) {
    console.error('[CaptainGithubTools] Commander handler failed:', error)
  }
}

// ── Wiring ────────────────────────────────────────────────────

export interface CaptainGithubToolDeps {
  db: Pick<DatabaseManager, 'getProject'>
  /** Merges; without it the merge tool answers "not available". */
  mergeDb?: MergeDb
  /** The delegated issue-write ledger; without it the issue tools answer "not available". */
  issueDb?: IssueWriteDb
  /** Shows the person a notice. Default: an OS notification when supported. */
  notifyUser?: (title: string, body: string) => void
  /** Pushes to the window. Default: the Task API notifier (index.ts sets it). */
  notifyRenderer?: (channel: string, data: unknown) => void
}

let deps: CaptainGithubToolDeps | null = null

export function configureCaptainGithubTools(next: CaptainGithubToolDeps | null): void {
  deps = next
}

// Electron is loaded on demand: this module sits under the Task API server,
// which unit tests (and the stdio MCP entry's import graph) load without it.
function defaultNotifyUser(title: string, body: string): void {
  import('electron')
    .then(({ Notification }) => {
      if (!Notification.isSupported()) return
      new Notification({ title, body }).show()
    })
    .catch((error) => console.error('[CaptainGithubTools] OS notification failed:', error))
}

function notifyUser(title: string, body: string): void {
  ;(deps?.notifyUser ?? defaultNotifyUser)(title, body)
}

function pushToRenderer(channel: string, data: unknown): void {
  const push = deps?.notifyRenderer ?? notifyRenderer
  push?.(channel, data)
}

function projectName(projectId: string): string {
  return deps?.db.getProject(projectId)?.name ?? projectId
}

/** What a merge tells the person and the Commander. `performMerge` sends its own notification for a merge. */
function mergeHooks(): MergeHooks {
  return {
    notifyUser,
    pushToRenderer,
    report: (projectId, kind, summary) => {
      reportCaptainAction({
        projectId,
        tool: MERGE_PULL_REQUEST_TOOL,
        summary,
        outcome: kind === 'merged' ? 'performed' : 'needs_user',
        at: new Date().toISOString()
      })
      if (kind === 'needs_user') notifyUser(`A PR in ${projectName(projectId)} needs a reviewer`, summary)
    }
  }
}

/** What a delegated issue write tells the person and the Commander. */
function issueWriteHooks(): IssueWriteHooks {
  return {
    notifyUser,
    pushToRenderer,
    report: (projectId, kind, summary, record) => {
      reportCaptainAction({
        projectId,
        tool: record.action,
        summary,
        outcome: kind === 'unresolved' ? 'needs_user' : 'performed',
        at: new Date().toISOString()
      })
      if (kind !== 'written') notifyUser(`Issue write in ${projectName(projectId)}`, summary)
    }
  }
}

async function mergeCall(db: MergeDb, projectId: string, args: Record<string, unknown>): Promise<unknown> {
  const pr = parseGitHubPullRequestUrl(args.pr_url)
  if (!pr) return { error: 'pr_url must be a GitHub pull request URL: https://github.com/<owner>/<repo>/pull/<number>' }
  const method: MergeMethod = args.merge_method === undefined || args.merge_method === null ? 'squash' : (args.merge_method as MergeMethod)
  if (!isMergeMethod(method)) return { error: 'merge_method must be squash, merge or rebase' }
  return performMerge(db, { projectId, pr, method }, mergeHooks())
}

export function createCaptainCallHandler(): CoordinatorCallHandler {
  return async ({ projectId, tool, args, run }) => {
    if (!deps) return run()

    if (MERGE_TOOL_NAMES.has(tool)) {
      if (!deps.mergeDb) return { error: 'Merging through 21x is not available right now.' }
      return mergeCall(deps.mergeDb, projectId, args)
    }

    if (ISSUE_WRITE_TOOL_NAMES.has(tool)) {
      if (!deps.issueDb) return { error: 'Writing GitHub issues through 21x is not available right now.' }
      return handleIssueWriteTool(tool, {
        db: deps.issueDb,
        projectId,
        args,
        hooks: issueWriteHooks(),
        reportPerformed: (summary) => {
          reportCaptainAction({ projectId, tool, summary, outcome: 'performed', at: new Date().toISOString() })
          notifyUser(`Captain of ${projectName(projectId)}`, `Did: ${summary}`)
        }
      })
    }

    return run()
  }
}

/** Main-process wiring: answers the Captain's GitHub tools from `db`. */
export function installCaptainGithubTools(db: DatabaseManager): void {
  configureCaptainGithubTools({ db, mergeDb: db, issueDb: db })
  setCoordinatorCallHandler(createCaptainCallHandler())
}

/**
 * Settles issue writes this process never saw the answer to, at startup and
 * whenever the ledger is read. An issue created just before a crash is
 * recovered from its idempotency marker instead of being filed a second time.
 */
export async function recoverIssueWriteOutcomes(db: DatabaseManager): Promise<void> {
  await reconcileIssueWrites(db, undefined, issueWriteHooks())
}
