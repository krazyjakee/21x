/**
 * Escalation policy enforcement for the Captain (#66).
 *
 * The policy (shared/project-policies.ts, `projects.settings.escalation`)
 * says, per action, whether the Captain acts alone (`autonomous`), acts
 * and reports (`tell_commander`), or waits for the user (`ask_user`). The
 * prompt tells the Captain the policy; this module enforces it where it
 * can be checked mechanically: the project-scoped task-management tools
 * (task-management-core.ts installs {@link createCoordinatorEscalationGate}
 * through `setCoordinatorCallGate`, see {@link installEscalation}).
 *
 * - `autonomous`: the call runs.
 * - `tell_commander`: the call runs, then {@link escalateToCommander} and a
 *   user notification. `escalateToCommander` is a seam: #62's
 *   `report_to_commander` wires a handler with
 *   {@link setCommanderEscalationHandler}; until then it is a no-op.
 * - `ask_user`: the call is held. The tool returns `{ status: 'held', id }`,
 *   the user is notified, and the renderer's held-actions notice offers
 *   approve / reject over IPC (ipc/projects.ts). Approval runs the original
 *   call and tells the Captain what happened; rejection tells it too.
 *
 * Held calls are kept in memory: the closure that runs them belongs to the
 * session that made them, and a held call from before a restart could no
 * longer be answered by its Captain anyway. They are listed, not persisted.
 *
 * Which tool call is which action: create_task and create_subtask are
 * `create_task`; start_task, stop_task and respond_to_checkpoint are their
 * own; update_task with a `priority` is `change_priority`;
 * merge_pull_request is `merge_pr` (#137). `open_pr` has no tool behind it
 * (the agent doing the work opens its PR), so it is prompt guidance only.
 *
 * The merge tools (merge_pull_request, grant_merge_authority,
 * list_merge_grants) are answered here, by merge-grant-gate.ts: a merge
 * under `ask_user` runs without a held call only when an active merge grant
 * the user gave covers it (merge-grants.ts), and every merge is checked
 * against the PR's checks and branch protection first.
 */
import { randomUUID } from 'crypto'
import type { DatabaseManager } from './database'
import { agentController, notifyRenderer } from './task-api/state'
import { setCoordinatorCallGate, type CoordinatorCallGate } from './mcp-servers/task-management-core'
import { FINDINGS_BEGIN, FINDINGS_END, SYSTEM_MESSAGE_MARKER } from '../shared/system-authority'
import { escalationPolicyFromSettings, type EscalationAction, type EscalationLevel } from '../shared/project-policies'
import type { HeldAction } from '../shared/project-limit-types'
import { handleMergeGrantTool } from './merge-grant-gate'
import { handleIssueWriteTool } from './issue-write-gate'
import { reconcileIssueWrites, type IssueWriteDb, type IssueWriteHooks } from './issue-writes'
import { MERGE_GRANT_TOOL_NAMES, MERGE_PULL_REQUEST_TOOL } from './mcp-servers/merge-grant-tools'
import { ISSUE_WRITE_TOOL_NAMES } from './mcp-servers/issue-write-tools'
import { reconcileMergeGrantReservations, type MergeGrantDb, type MergeHooks } from './merge-grants'

export type { HeldAction }

// ── Events and the Commander seam ─────────────────────────────

export interface EscalationEvent {
  projectId: string
  action: EscalationAction
  level: Exclude<EscalationLevel, 'autonomous'>
  tool: string
  args: Record<string, unknown>
  /** One line a person can read: what the Captain did or wants to do. */
  summary: string
  /**
   * `performed`: tell_commander ran it. `held` / `approved` / `rejected`: the
   * life of an ask_user call. `merged_under_grant`: a merge ran without a
   * held call because a user's merge grant covered it (#137). `needs_user`:
   * a merge is blocked on a person outside 21x (a required review).
   */
  outcome: 'performed' | 'held' | 'approved' | 'rejected' | 'merged_under_grant' | 'needs_user'
  /** The held call's id for ask_user outcomes. */
  heldId?: string
  /** The merge grant used, for `merged_under_grant`. */
  grantId?: string
  /** ISO time. */
  at: string
}

export type CommanderEscalationHandler = (event: EscalationEvent) => void

let commanderHandler: CommanderEscalationHandler | null = null

/** #62 installs the handler that turns an escalation into a report to the Commander. */
export function setCommanderEscalationHandler(handler: CommanderEscalationHandler | null): void {
  commanderHandler = handler
}

/**
 * Seam for #62 (`report_to_commander`). Until a handler is installed this
 * does nothing; the user notification beside it is what reaches a person.
 */
export function escalateToCommander(event: EscalationEvent): void {
  if (!commanderHandler) return
  try {
    commanderHandler(event)
  } catch (error) {
    console.error('[Escalation] Commander handler failed:', error)
  }
}

// ── Wiring ────────────────────────────────────────────────────

export interface EscalationDeps {
  db: Pick<DatabaseManager, 'getProject' | 'getTask' | 'getCoordinatorTask'>
  /** Merge grants and merges (#137); without it the merge tools answer "not available". */
  mergeDb?: MergeGrantDb
  /** The delegated issue-write ledger; without it the issue tools answer "not available". */
  issueDb?: IssueWriteDb
  /** Shows the person a notice. Default: an OS notification when supported. */
  notifyUser?: (title: string, body: string) => void
  /** Pushes to the window. Default: the Task API notifier (index.ts sets it). */
  notifyRenderer?: (channel: string, data: unknown) => void
  /**
   * Tells the project's Captain something. Default: a message to its live
   * session through the agent controller; nothing when it has no live session
   * (the Captain waker, #57, is the place to wake it from).
   */
  tellCaptain?: (projectId: string, text: string) => Promise<void>
}

let deps: EscalationDeps | null = null

export function configureEscalation(next: EscalationDeps | null): void {
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
    .catch((error) => console.error('[Escalation] OS notification failed:', error))
}

async function defaultTellCaptain(projectId: string, text: string): Promise<void> {
  if (!deps || !agentController) return
  const coordinator = deps.db.getCoordinatorTask(projectId)
  if (!coordinator) return
  if (!agentController.findSessionByTaskId(coordinator.id)) return
  await agentController.sendByTaskId(coordinator.id, text)
}

function notifyUser(title: string, body: string): void {
  ;(deps?.notifyUser ?? defaultNotifyUser)(title, body)
}

function pushToRenderer(channel: string, data: unknown): void {
  const push = deps?.notifyRenderer ?? notifyRenderer
  push?.(channel, data)
}

function tellCaptain(projectId: string, text: string): void {
  ;(deps?.tellCaptain ?? defaultTellCaptain)(projectId, text).catch((error) => {
    console.warn(`[Escalation] Could not tell the Captain of project ${projectId}:`, error)
  })
}

/** A short fenced system message, so the Captain cannot read it as a human instruction. */
function systemNote(projectId: string, header: string, finding: string): string {
  return [
    SYSTEM_MESSAGE_MARKER,
    `provenance: origin=escalation-policy project=${projectId} human_authored=false authorizes_actions=false`,
    '',
    header,
    '',
    FINDINGS_BEGIN,
    finding,
    FINDINGS_END
  ].join('\n')
}

// ── Mapping tool calls to policy actions ──────────────────────

export function actionForToolCall(tool: string, args: Record<string, unknown>): EscalationAction | null {
  switch (tool) {
    case 'create_task':
    case 'create_subtask':
      return 'create_task'
    case 'start_task':
      return 'start_task'
    case 'stop_task':
      return 'stop_task'
    case 'respond_to_checkpoint':
      return 'respond_to_checkpoint'
    case 'update_task':
      return args.priority !== undefined && args.priority !== null ? 'change_priority' : null
    case MERGE_PULL_REQUEST_TOOL:
      return 'merge_pr'
    default:
      return null
  }
}

function summarizeCall(action: EscalationAction, tool: string, args: Record<string, unknown>): string {
  const taskId = typeof args.task_id === 'string' ? args.task_id : ''
  const title = taskId ? deps?.db.getTask(taskId)?.title : undefined
  const target = taskId ? `"${title ?? taskId}"` : ''
  switch (action) {
    case 'create_task':
      return tool === 'create_subtask'
        ? `create subtask "${String(args.title ?? '')}"`
        : `create task "${String(args.title ?? '')}"`
    case 'start_task':
      return `start ${target}`
    case 'stop_task':
      return `stop the agent on ${target}`
    case 'respond_to_checkpoint':
      return `${args.approved === true ? 'approve' : 'reject'} the checkpoint on ${target}`
    case 'change_priority':
      return `set the priority of ${target} to ${String(args.priority)}`
    case 'merge_pr':
      return `merge ${String(args.pr_url ?? '')}`
    case 'issue_write':
      return args.issue_url
        ? `write to the GitHub issue ${String(args.issue_url)}`
        : `file a GitHub issue "${String(args.title ?? '')}" in ${String(args.repo ?? 'a project repository')}`
    default:
      return `${tool} ${target}`.trim()
  }
}

// ── Held calls (ask_user) ─────────────────────────────────────

// HeldAction's shape lives in shared/project-limit-types.ts so the renderer can type it.

const heldActions = new Map<string, HeldAction & { run: () => Promise<unknown> }>()

function publicHeld(entry: HeldAction & { run: () => Promise<unknown> }): HeldAction {
  const { run: _run, ...rest } = entry
  return rest
}

export function listHeldActions(projectId?: string): HeldAction[] {
  return [...heldActions.values()]
    .filter((entry) => !projectId || entry.projectId === projectId)
    .map(publicHeld)
}

function emitHeldChanged(): void {
  pushToRenderer('escalation:heldChanged', { held: listHeldActions() })
}

/** Truncated JSON of a tool result, for the Captain's note. */
function briefResult(result: unknown): string {
  let text: string
  try {
    text = JSON.stringify(result) ?? String(result)
  } catch {
    text = String(result)
  }
  return text.length > 1_500 ? `${text.slice(0, 1_500)}…` : text
}

/**
 * Runs a held call. The Captain is told the outcome (result or error) in
 * a fenced note; the Commander seam sees `approved`.
 */
export async function approveHeldAction(id: string): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const entry = heldActions.get(id)
  if (!entry) return { ok: false, error: 'No such held action' }
  heldActions.delete(id)
  emitHeldChanged()
  let result: unknown
  try {
    result = await entry.run()
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) }
  }
  const failed = !!(result && typeof result === 'object' && 'error' in (result as Record<string, unknown>))
  escalateToCommander({ ...eventOf(entry, 'approved'), heldId: id })
  tellCaptain(
    entry.projectId,
    systemNote(
      entry.projectId,
      `The user approved your held ${entry.tool} call (${id}) and it has ${failed ? 'been run but failed' : 'run'}. Continue from its result; do not repeat the call.`,
      `Action: ${entry.summary}\nResult: ${briefResult(result)}`
    )
  )
  return failed ? { ok: false, result, error: String((result as Record<string, unknown>).error) } : { ok: true, result }
}

/** Drops a held call and tells the Captain, with the user's note if any. */
export function rejectHeldAction(id: string, note?: string): boolean {
  const entry = heldActions.get(id)
  if (!entry) return false
  heldActions.delete(id)
  emitHeldChanged()
  escalateToCommander({ ...eventOf(entry, 'rejected'), heldId: id })
  tellCaptain(
    entry.projectId,
    systemNote(
      entry.projectId,
      `The user rejected your held ${entry.tool} call (${id}). Do not retry it; adjust the plan or ask the user what they want instead.`,
      `Action: ${entry.summary}${note?.trim() ? `\nUser's note: ${note.trim()}` : ''}`
    )
  )
  return true
}

/** Tests and shutdown: forgets every held call without telling anyone. */
export function clearHeldActions(): void {
  heldActions.clear()
}

function eventOf(entry: HeldAction, outcome: EscalationEvent['outcome']): EscalationEvent {
  return {
    projectId: entry.projectId,
    action: entry.action,
    level: 'ask_user',
    tool: entry.tool,
    args: entry.args,
    summary: entry.summary,
    outcome,
    at: new Date().toISOString()
  }
}

// ── The gate ──────────────────────────────────────────────────

/** Reads the project's policy level for an action; defaults when unreadable. */
export function policyLevelFor(db: Pick<DatabaseManager, 'getProject'>, projectId: string, action: EscalationAction): EscalationLevel {
  return escalationPolicyFromSettings(db.getProject(projectId)?.settings)[action]
}

/**
 * Holds a call for the user (ask_user). `run` gets the held id, so what it
 * does on approval can say whose approval it ran under.
 */
function holdCall(
  projectId: string,
  action: EscalationAction,
  tool: string,
  args: Record<string, unknown>,
  summary: string,
  run: (heldId: string) => Promise<unknown>
): Record<string, unknown> {
  const projectName = deps?.db.getProject(projectId)?.name ?? projectId
  const id = randomUUID()
  const held: HeldAction & { run: () => Promise<unknown> } = {
    id, projectId, action, tool, args, summary, createdAt: new Date().toISOString(), run: () => run(id)
  }
  heldActions.set(id, held)
  const event: EscalationEvent = {
    projectId, action, level: 'ask_user', tool, args, summary, outcome: 'held', heldId: id, at: held.createdAt
  }
  escalateToCommander(event)
  notifyUser(`Captain of ${projectName} needs approval`, `Wants to ${summary}`)
  emitHeldChanged()
  return {
    status: 'held',
    id,
    action,
    message:
      `This project's escalation policy sets "${action}" to ask the user first. The call is held (id ${id}) until the user approves or rejects it in 20x; ` +
      'you will get a message either way. Do not repeat the call. Carry on with anything that does not depend on it, or end your turn.'
  }
}

/** What a merge tells the person and the Commander (#137). */
function mergeHooks(): MergeHooks {
  return {
    notifyUser,
    pushToRenderer,
    report: (id, kind, summary, grantId) => {
      const event: EscalationEvent = {
        projectId: id,
        action: 'merge_pr',
        level: 'ask_user',
        tool: MERGE_PULL_REQUEST_TOOL,
        args: {},
        summary,
        outcome: kind === 'merged_under_grant' ? 'merged_under_grant' : 'needs_user',
        ...(grantId ? { grantId } : {}),
        at: new Date().toISOString()
      }
      escalateToCommander(event)
      pushToRenderer('escalation:event', event)
      if (kind === 'needs_user') notifyUser(`A PR in ${deps?.db.getProject(id)?.name ?? id} needs a reviewer`, summary)
    }
  }
}

/** What a delegated issue write tells the person and the Commander. */
function issueWriteHooks(): IssueWriteHooks {
  return {
    notifyUser,
    pushToRenderer,
    report: (projectId, kind, summary, record) => {
      const event: EscalationEvent = {
        projectId,
        action: 'issue_write',
        // An `autonomous` write still produces an event when it needs a
        // person (an unresolved outcome); the feed has no silent level.
        level: (deps && policyLevelFor(deps.db, projectId, 'issue_write') === 'ask_user') ? 'ask_user' : 'tell_commander',
        tool: record.action,
        args: { repo: record.repo, issue_url: record.external_url },
        summary,
        outcome: kind === 'unresolved' ? 'needs_user' : 'performed',
        at: new Date().toISOString()
      }
      escalateToCommander(event)
      pushToRenderer('escalation:event', event)
      if (kind !== 'written') notifyUser(`Issue write in ${deps?.db.getProject(projectId)?.name ?? projectId}`, summary)
    }
  }
}

export function createCoordinatorEscalationGate(): CoordinatorCallGate {
  return async ({ projectId, tool, args, run }) => {
    if (!deps) return run()

    // #137: the merge tools have no route; they are answered here.
    if (MERGE_GRANT_TOOL_NAMES.has(tool)) {
      if (!deps.mergeDb) return { error: 'Merging through 21x is not available right now.' }
      const projectName = deps.db.getProject(projectId)?.name ?? projectId
      return handleMergeGrantTool(tool, {
        db: deps.mergeDb,
        projectId,
        args,
        level: policyLevelFor(deps.db, projectId, 'merge_pr'),
        hooks: mergeHooks(),
        hold: (summary, runHeld) => holdCall(projectId, 'merge_pr', tool, args, summary, runHeld),
        reportPerformed: (summary) => {
          const event: EscalationEvent = {
            projectId, action: 'merge_pr', level: 'tell_commander', tool, args, summary, outcome: 'performed', at: new Date().toISOString()
          }
          escalateToCommander(event)
          notifyUser(`Captain of ${projectName}`, `Did: ${summary}`)
          pushToRenderer('escalation:event', event)
        }
      })
    }

    // The delegated issue tools have no route either; they are answered here.
    if (ISSUE_WRITE_TOOL_NAMES.has(tool)) {
      if (!deps.issueDb) return { error: 'Writing GitHub issues through 21x is not available right now.' }
      const projectName = deps.db.getProject(projectId)?.name ?? projectId
      return handleIssueWriteTool(tool, {
        db: deps.issueDb,
        projectId,
        args,
        level: policyLevelFor(deps.db, projectId, 'issue_write'),
        hooks: issueWriteHooks(),
        hold: (summary, runHeld) => holdCall(projectId, 'issue_write', tool, args, summary, runHeld),
        reportPerformed: (summary) => {
          const event: EscalationEvent = {
            projectId, action: 'issue_write', level: 'tell_commander', tool, args, summary, outcome: 'performed', at: new Date().toISOString()
          }
          escalateToCommander(event)
          notifyUser(`Captain of ${projectName}`, `Did: ${summary}`)
          pushToRenderer('escalation:event', event)
        }
      })
    }

    const action = actionForToolCall(tool, args)
    if (!action) return run()
    const level = policyLevelFor(deps.db, projectId, action)
    if (level === 'autonomous') return run()

    const projectName = deps.db.getProject(projectId)?.name ?? projectId
    const summary = summarizeCall(action, tool, args)

    if (level === 'tell_commander') {
      const result = await run()
      const failed = !!(result && typeof result === 'object' && 'error' in (result as Record<string, unknown>))
      if (!failed) {
        const event: EscalationEvent = {
          projectId, action, level, tool, args, summary, outcome: 'performed', at: new Date().toISOString()
        }
        escalateToCommander(event)
        notifyUser(`Captain of ${projectName}`, `Did: ${summary}`)
        pushToRenderer('escalation:event', event)
        if (result && typeof result === 'object' && !Array.isArray(result)) {
          return { ...(result as Record<string, unknown>), escalation: { level, reported: true } }
        }
      }
      return result
    }

    // ask_user: hold the call until the user answers.
    return holdCall(projectId, action, tool, args, summary, () => run())
  }
}

/** Main-process wiring: reads the policy from `db` and gates the Captain's tool calls. */
export function installEscalation(db: DatabaseManager): void {
  configureEscalation({ db, mergeDb: db, issueDb: db })
  setCoordinatorCallGate(createCoordinatorEscalationGate())
}

/** Run after the Commander report bridge is ready so recovered outcomes reach it. */
export function recoverMergeGrantOutcomes(db: DatabaseManager): Promise<void> {
  return reconcileMergeGrantReservations(db, undefined, mergeHooks())
}

/**
 * Settles issue writes this process never saw the answer to, at startup and
 * whenever the ledger is read. An issue created just before a crash is
 * recovered from its idempotency marker instead of being filed a second time.
 */
export async function recoverIssueWriteOutcomes(db: DatabaseManager): Promise<void> {
  await reconcileIssueWrites(db, undefined, issueWriteHooks())
}
