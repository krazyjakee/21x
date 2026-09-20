/**
 * How the escalation gate (escalation.ts, #66) answers the Captain's merge
 * tools (#137; mcp-servers/merge-grant-tools.ts). Kept apart from the gate
 * so the policy module only gains one hook.
 *
 * `merge_pull_request`, by the project's `merge_pr` level:
 * - `autonomous` / `tell_commander`: merge (after the PR gate);
 * - `ask_user`: read the PR; when it cannot be merged anyway, say why without
 *   bothering the user; when an active grant the user gave covers it, merge
 *   under that grant; otherwise hold the call, and merge once the user approves.
 * In every case {@link performMerge} re-checks the PR and never bypasses
 * protection.
 *
 * `grant_merge_authority` binds a grant to the newest message the user typed
 * in this project's chat (reported by the chat composer, ipc/merge-grants.ts). The Captain
 * supplies only the scope.
 */
import {
  activeMergeGrants,
  reconcileMergeGrantReservations,
  createMergeGrantFromUserMessage,
  findCoveringGrant,
  isMergeMethod,
  latestUserTypedProjectMessage,
  mergeGrantSummary,
  performMerge,
  readPullRequestGate,
  refuseUnmergeable,
  type MergeGrantDb,
  type MergeHooks,
  type MergeMethod,
  type PullRequestGateState
} from './merge-grants'
import { GRANT_MERGE_AUTHORITY_TOOL, LIST_MERGE_GRANTS_TOOL, MERGE_PULL_REQUEST_TOOL } from './mcp-servers/merge-grant-tools'
import { describeMergeGrant, mergeGrantScopeFrom, parseGitHubPullRequestUrl } from '../shared/merge-grants'
import type { EscalationLevel } from '../shared/project-policies'

export interface MergeGateContext {
  db: MergeGrantDb
  projectId: string
  args: Record<string, unknown>
  /** The project's `merge_pr` level. */
  level: EscalationLevel
  hooks: MergeHooks
  /** Holds the call for the user (escalation.ts); `run` gets the held id. */
  hold: (summary: string, run: (heldId: string) => Promise<unknown>) => unknown
  /** After a merge made under `tell_commander`: the usual report. */
  reportPerformed: (summary: string) => void
}

async function mergeCall(ctx: MergeGateContext): Promise<unknown> {
  const { db, projectId, args, level, hooks } = ctx
  const pr = parseGitHubPullRequestUrl(args.pr_url)
  if (!pr) return { error: 'pr_url must be a GitHub pull request URL: https://github.com/<owner>/<repo>/pull/<number>' }
  const method: MergeMethod = args.merge_method === undefined || args.merge_method === null ? 'squash' : (args.merge_method as MergeMethod)
  if (!isMergeMethod(method)) return { error: 'merge_method must be squash, merge or rebase' }
  const inProject = db.getProjectRepos(projectId)
    .some((repo) => repo.provider === 'github' && `${repo.org}/${repo.name}`.toLowerCase() === `${pr.owner}/${pr.repo}`.toLowerCase())
  if (!inProject) return { error: `${pr.owner}/${pr.repo} is not one of this project's GitHub repositories.` }

  if (level === 'autonomous' || level === 'tell_commander') {
    const result = await performMerge(db, { projectId, pr, method, authority: { kind: 'policy', level } }, hooks)
    if (level === 'tell_commander' && result.status === 'merged') ctx.reportPerformed(`merge ${pr.url}`)
    return result
  }

  // ask_user: a grant, or the user.
  let state: PullRequestGateState
  try {
    state = await readPullRequestGate(pr)
  } catch (error) {
    return { error: `Could not read ${pr.url} from GitHub: ${error instanceof Error ? error.message : String(error)}` }
  }
  // Not mergeable anyway: say why instead of asking the user to approve a
  // merge that would fail. Nothing is merged, so no authority is needed.
  const blocked = refuseUnmergeable(projectId, pr, state, hooks)
  if (blocked) return blocked

  const grantId = typeof args.grant_id === 'string' && args.grant_id ? args.grant_id : null
  const grant = findCoveringGrant(db, projectId, { ...pr, baseRefName: state.baseRefName }, grantId)
  if (grant) {
    return performMerge(db, { projectId, pr, method, authority: { kind: 'grant', grantId: grant.id }, state }, hooks)
  }

  const note = grantId
    ? ` Grant ${grantId} is not an active grant of this project that covers this PR.`
    : activeMergeGrants(db, projectId).length > 0
      ? ' No active merge grant covers this PR.'
      : ''
  const held = ctx.hold(`merge ${pr.url}${state.title ? ` "${state.title.slice(0, 80)}"` : ''} (${method})`, (heldId) =>
    // Re-read at approval time: the PR may have changed while it waited.
    performMerge(db, { projectId, pr, method, authority: { kind: 'user_approval', heldId } }, hooks))
  if (note && held && typeof held === 'object') return { ...(held as Record<string, unknown>), note: note.trim() }
  return held
}

function grantCall(ctx: MergeGateContext): unknown {
  const { db, projectId, args } = ctx
  const typed = latestUserTypedProjectMessage(projectId)
  const result = createMergeGrantFromUserMessage(db, projectId, {
    source: 'project_chat',
    sessionId: typed?.taskId ?? null,
    messageId: typed?.id ?? '',
    text: typed?.text ?? ''
  }, mergeGrantScopeFrom(args))
  if (!result.ok) return result
  return {
    status: 'granted',
    grant_id: result.grant.id,
    allows: describeMergeGrant(result.grant),
    user_text: result.grant.user_text,
    expires_at: result.grant.expires_at,
    notes: result.notes,
    message: 'Grant recorded. Use merge_pull_request; covered merges run without a held call, and each is logged to the project journal. The user can revoke it at any time.'
  }
}

/**
 * Answers one of the merge tools, or returns `undefined` when `tool` is not
 * one of them (the gate then carries on as before).
 */
export async function handleMergeGrantTool(tool: string, ctx: MergeGateContext): Promise<unknown | undefined> {
  switch (tool) {
    case MERGE_PULL_REQUEST_TOOL:
      return mergeCall(ctx)
    case GRANT_MERGE_AUTHORITY_TOOL:
      return grantCall(ctx)
    case LIST_MERGE_GRANTS_TOOL: {
      await reconcileMergeGrantReservations(ctx.db, ctx.projectId, ctx.hooks)
      const grants = activeMergeGrants(ctx.db, ctx.projectId)
      return { grants: grants.map(mergeGrantSummary), total: grants.length }
    }
    default:
      return undefined
  }
}
