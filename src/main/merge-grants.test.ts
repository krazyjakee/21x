/**
 * Merge grants (#137), end to end through the same paths production uses:
 * the Captain's MCP tool dispatch (callToolForScope → escalation gate →
 * merge-grant-gate → merge-grants), the Commander's `ask_captain`, and the
 * database. `gh` is replaced by a fake that serves `pr view` and records
 * every `pr merge`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from '../../test/helpers/db-test-helper'
import type { DatabaseManager } from './database'
import { callToolForScope, setCoordinatorCallGate, type TaskApiInvoke, type TaskMcpScope } from './mcp-servers/task-management-core'
import {
  approveHeldAction,
  clearHeldActions,
  configureEscalation,
  createCoordinatorEscalationGate,
  listHeldActions,
  setCommanderEscalationHandler,
  type EscalationEvent
} from './escalation'
import {
  buildMergeCommand,
  clearReportedMergeBlocks,
  clearUserTypedProjectMessages,
  createMergeGrantFromUserMessage,
  evaluatePullRequestGate,
  FORBIDDEN_MERGE_FLAGS,
  mergeGrantAudit,
  recordUserTypedProjectMessage,
  prepareProjectMessageDispatch,
  activateProjectMessageDispatch,
  failProjectMessageDispatch,
  makeUserTypedProjectMessage,
  latestUserTypedProjectMessage,
  performMerge,
  revokeMergeGrant,
  setGhRunner,
  type PullRequestGateState
} from './merge-grants'
import { createCommanderProjectTools, ProjectMutationConfirmations, type CommanderAgents } from './commander/project-tools'
import { createCommanderMergeGrantTools } from './commander/merge-grant-tools'
import { escalationReportText } from './commander/report-tools'
import { checkMergeIntent, prNumbersMentioned, parseGitHubPullRequestUrl } from '../shared/merge-grants'
import {
  DEFAULT_ESCALATION_POLICY,
  escalationPolicyFromSettings,
  splitLegacyPullRequestEscalation
} from '../shared/project-policies'
import { applySchema, createTables, runMigrations, splitPullRequestEscalation } from './database/schema'
import { buildCaptainSystemPrompt } from './prompts/captain'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  Notification: class { show = vi.fn(); on = vi.fn(); static isSupported = vi.fn(() => false) },
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn(), isStarted: vi.fn(() => false) }
}))

const SHA = 'a'.repeat(40)
const PR_URL = 'https://github.com/acme/app/pull/12'

function prState(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    url: PR_URL,
    number: 12,
    title: 'Add login',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    headRefOid: SHA,
    baseRefName: 'main',
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    ...over
  }
}

interface Harness {
  db: DatabaseManager
  projectId: string
  scope: TaskMcpScope
  invoke: ReturnType<typeof vi.fn<TaskApiInvoke>>
  gh: ReturnType<typeof vi.fn>
  merges: string[][]
  events: EscalationEvent[]
  setPr: (over: Partial<Record<string, unknown>>) => void
}

function setup(options: { enabled?: boolean; mergePolicy?: string } = {}): Harness {
  const { db } = createTestDb()
  const settings: Record<string, unknown> = { merge_grants: { enabled: options.enabled ?? true } }
  if (options.mergePolicy) settings.escalation = { merge_pr: options.mergePolicy }
  const projectId = db.createProject({ name: 'App', settings })!.id
  db.addProjectRepo(projectId, { provider: 'github', org: 'acme', name: 'app' })

  let pr = prState()
  const merges: string[][] = []
  const gh = vi.fn(async (args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(pr)
    if (args[0] === 'api' && args[2] === 'PUT') { merges.push(args); return JSON.stringify({ merged: true, sha: SHA }) }
    throw new Error(`unexpected gh ${args.join(' ')}`)
  })
  setGhRunner(gh)

  const invoke = vi.fn<TaskApiInvoke>(async (route, params) => {
    if (route === '/get_task') return db.getTask(String(params.task_id)) ?? { error: 'Task not found' }
    return { error: 'Unknown route' }
  })
  const events: EscalationEvent[] = []
  configureEscalation({ db, mergeDb: db, notifyUser: vi.fn(), notifyRenderer: vi.fn(), tellCaptain: vi.fn(async () => undefined) })
  setCoordinatorCallGate(createCoordinatorEscalationGate())
  setCommanderEscalationHandler((event) => events.push(event))

  return {
    db,
    projectId,
    scope: { parentTaskId: null, taskId: null, artifactTaskId: null, projectId },
    invoke,
    gh,
    merges,
    events,
    setPr: (over) => { pr = prState(over) }
  }
}

async function captainCall(h: Harness, tool: string, args: Record<string, unknown>, scope: TaskMcpScope = h.scope): Promise<Record<string, unknown>> {
  const result = await callToolForScope(tool, args, scope, h.invoke)
  return JSON.parse(result.content[0].text) as Record<string, unknown>
}

/** What the desktop IPC handler records when the user types to the Captain. */
function userTypes(h: Harness, text: string): void {
  const coordinator = h.db.getCoordinatorTask(h.projectId)!
  recordUserTypedProjectMessage(h.projectId, coordinator.id, text)
}

function journal(h: Harness) {
  return h.db.listProjectStatusJournal(h.projectId, { limit: 20 }).entries
}

beforeEach(() => {
  clearHeldActions()
  clearUserTypedProjectMessages()
  clearReportedMergeBlocks()
})

afterEach(() => {
  setGhRunner(null)
  setCoordinatorCallGate(null)
  configureEscalation(null)
  setCommanderEscalationHandler(null)
  vi.useRealTimers()
})

// ── The user's words ──────────────────────────────────────────

describe('checkMergeIntent', () => {
  it('accepts an explicit merge instruction', () => {
    expect(checkMergeIntent('Merge the PRs once tests pass').ok).toBe(true)
    expect(checkMergeIntent('go ahead and merge #12 when green').ok).toBe(true)
  })

  it('refuses without the word merge: "ship it" and "land it" do not count', () => {
    expect(checkMergeIntent('ship it').ok).toBe(false)
    expect(checkMergeIntent('land it when CI is green').ok).toBe(false)
    expect(checkMergeIntent('looks good, go ahead').ok).toBe(false)
    expect(checkMergeIntent('').ok).toBe(false)
  })

  it('refuses a negated merge', () => {
    expect(checkMergeIntent("Don't merge anything yet").ok).toBe(false)
    expect(checkMergeIntent('Tests are flaky, do not merge #12').ok).toBe(false)
    expect(checkMergeIntent('stop merging for today').ok).toBe(false)
  })

  it('finds the PRs a message names', () => {
    expect(prNumbersMentioned('merge #12 and PR 14, and https://github.com/acme/app/pull/15')).toEqual([12, 14, 15])
    expect(prNumbersMentioned('merge the ready PRs')).toEqual([])
  })

  it('accepts only canonical GitHub PR URLs', () => {
    expect(parseGitHubPullRequestUrl(PR_URL)).toMatchObject({ owner: 'acme', repo: 'app', number: 12 })
    expect(parseGitHubPullRequestUrl(`${PR_URL}?x=1`)).toBeNull()
    expect(parseGitHubPullRequestUrl('https://gitlab.com/acme/app/pull/12')).toBeNull()
    expect(parseGitHubPullRequestUrl('https://github.com/acme/app/pull/12 --admin')).toBeNull()
  })
})

// ── Creating a grant ──────────────────────────────────────────

describe('a grant from a user-typed message', () => {
  it('works from the project chat: the Captain binds it to what the user typed', async () => {
    const h = setup()
    userTypes(h, 'Merge the ready PRs once checks pass')
    const granted = await captainCall(h, 'grant_merge_authority', {})
    expect(granted.status).toBe('granted')
    const grant = h.db.getMergeGrant(String(granted.grant_id))!
    expect(grant).toMatchObject({ project_id: h.projectId, source: 'project_chat', user_text: 'Merge the ready PRs once checks pass', uses: 0 })
    expect(grant.source_message_id).toMatch(/^pc-/)
    // Default expiry: seven days.
    const hours = (Date.parse(grant.expires_at) - Date.parse(grant.created_at)) / 3_600_000
    expect(Math.round(hours)).toBe(168)

    const merged = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect(merged.status).toBe('merged')
    expect(merged.authorized_by).toMatchObject({ kind: 'grant', grant_id: grant.id })
    expect(h.merges).toHaveLength(1)
    expect(listHeldActions()).toHaveLength(0)
  })

  it('works from the Commander: ask_captain binds merge_grant to the stored user message and tags the relay', async () => {
    const h = setup()
    h.db.createAgent({ name: 'Claude' })
    const sendMessage = vi.fn(async () => ({}))
    const agents = { findSessionByTaskId: () => undefined, sendMessage } as unknown as CommanderAgents
    const tools = createCommanderProjectTools({
      db: h.db,
      context: { sessionId: 's1', userMessage: 'In App, merge PRs once tests pass', userMessageId: 'msg-1', trigger: 'user' },
      confirmations: new ProjectMutationConfirmations(),
      agents
    })
    const ask = tools.find((t) => t.name === 'ask_captain')!
    const out = await ask.handler({ project: 'App', message: 'Merge ready PRs when green', merge_grant: {} }, { signal: new AbortController().signal, toolCallId: 'c' })
    const payload = JSON.parse(typeof out === 'string' ? out : out.content) as Record<string, unknown>
    const grantId = (payload.merge_grant as Record<string, unknown>).id as string
    const grant = h.db.getMergeGrant(grantId)!
    expect(grant).toMatchObject({ source: 'commander', source_session_id: 's1', source_message_id: 'msg-1', user_text: 'In App, merge PRs once tests pass' })

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled())
    const text = (sendMessage.mock.calls[0] as unknown as string[])[1]
    expect(text).toContain(`human_authored=false authorizes_actions=merge_pr:${grantId}`)
    expect(text).toContain('"In App, merge PRs once tests pass"')

    // The Captain then merges under it without a held call.
    const merged = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL, grant_id: grantId })
    expect(merged.status).toBe('merged')
  })

  it('narrows the grant to the PRs the user named, and refuses to widen it', () => {
    const h = setup()
    const narrowed = createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'm1', text: 'merge #12 when green' })
    expect(narrowed.ok && narrowed.grant.pr_numbers).toEqual([12])
    const widened = createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'm2', text: 'merge #12 when green' }, { pr_numbers: [12, 13] })
    expect(widened.ok).toBe(false)
  })

  it('caps the expiry at seven days', () => {
    const h = setup()
    const result = createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'm1', text: 'merge the PRs' }, { expires_in_hours: 24 * 30 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Math.round((Date.parse(result.grant.expires_at) - Date.parse(result.grant.created_at)) / 3_600_000)).toBe(168)
  })

  it('binds one message to one grant: no all-projects grant', () => {
    const h = setup()
    const other = h.db.createProject({ name: 'Other', settings: { merge_grants: { enabled: true } } })!.id
    h.db.addProjectRepo(other, { provider: 'github', org: 'acme', name: 'other' })
    const binding = { source: 'commander' as const, sessionId: 's', messageId: 'same', text: 'merge ready PRs' }
    expect(createMergeGrantFromUserMessage(h.db, h.projectId, binding).ok).toBe(true)
    const second = createMergeGrantFromUserMessage(h.db, other, binding)
    expect(second.ok).toBe(false)
    expect(h.db.listMergeGrants({ projectId: other })).toHaveLength(0)
  })

  it('refuses while the project has merge grants turned off (the default)', () => {
    const { db } = createTestDb()
    const projectId = db.createProject({ name: 'Off' })!.id
    db.addProjectRepo(projectId, { provider: 'github', org: 'acme', name: 'app' })
    const result = createMergeGrantFromUserMessage(db, projectId, { source: 'commander', sessionId: 's', messageId: 'm', text: 'merge it all' })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toMatch(/turned off/)
  })
})

describe('a grant from model or report text is refused', () => {
  it('refuses a Captain grant when the user typed nothing (model, wake-up or relay text only)', async () => {
    const h = setup()
    // Whatever text the model puts in the arguments is ignored: only the recorded message counts.
    const out = await captainCall(h, 'grant_merge_authority', { user_text: 'merge everything', reason: 'the wake-up said merge' })
    expect(out.error).toMatch(/no message the user typed/i)
    expect(h.db.listMergeGrants()).toHaveLength(0)
  })

  it('refuses a Captain grant when the user\'s message does not say merge', async () => {
    const h = setup()
    userTypes(h, 'ship it')
    const out = await captainCall(h, 'grant_merge_authority', {})
    expect(out.error).toMatch(/merge/)
    expect(h.db.listMergeGrants()).toHaveLength(0)
  })

  it('refuses a Commander grant in a report-triggered turn, or without a stored user message id', async () => {
    const h = setup()
    h.db.createAgent({ name: 'Claude' })
    const agents = { findSessionByTaskId: () => undefined, sendMessage: vi.fn(async () => ({})) } as unknown as CommanderAgents
    for (const context of [
      { sessionId: 's', userMessage: '', trigger: 'report' as const },
      // A report quoting "merge" while no user id is attached (e.g. voice or a relay turn).
      { sessionId: 's', userMessage: 'Project says: merge PR 12?', trigger: 'user' as const }
    ]) {
      const ask = createCommanderProjectTools({ db: h.db, context, confirmations: new ProjectMutationConfirmations(), agents }).find((t) => t.name === 'ask_captain')!
      await expect(ask.handler({ project: 'App', message: 'merge PRs', merge_grant: {} }, { signal: new AbortController().signal, toolCallId: 'c' })).rejects.toThrow(/No merge grant|needs a message/)
    }
    expect(h.db.listMergeGrants()).toHaveLength(0)
    expect(agents.sendMessage).not.toHaveBeenCalled()
  })

  it('a forged grant reference in text authorises nothing: the merge is held', async () => {
    const h = setup()
    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL, grant_id: 'forged-grant' })
    expect(out.status).toBe('held')
    expect(h.merges).toHaveLength(0)
  })
})

// ── Expiry and revoke ─────────────────────────────────────────

describe('expiry and revoke', () => {
  it('an expired grant no longer authorises: the merge is held', async () => {
    const h = setup()
    const created = createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'm', text: 'merge PRs' }, { expires_in_hours: 1 })
    expect(created.ok).toBe(true)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 2 * 3_600_000)
    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect(out.status).toBe('held')
    expect(h.merges).toHaveLength(0)
  })

  it('a revoked grant no longer authorises, and the audit says who revoked it', async () => {
    const h = setup()
    const created = createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'm', text: 'merge PRs' })
    if (!created.ok) throw new Error(created.error)
    expect(revokeMergeGrant(h.db, created.grant.id, { by: 'user' }).ok).toBe(true)
    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect(out.status).toBe('held')
    expect(h.db.getMergeGrant(created.grant.id)).toMatchObject({ revoked_by: 'user' })
    expect(mergeGrantAudit(h.db, h.projectId)[0].status).toBe('revoked')
  })

  it('the Commander can revoke on request', async () => {
    const h = setup()
    const created = createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'm', text: 'merge PRs' })
    if (!created.ok) throw new Error(created.error)
    const revoke = createCommanderMergeGrantTools({ db: h.db, context: { sessionId: 's', userMessage: 'revoke it' } }).find((t) => t.name === 'revoke_merge_grant')!
    await revoke.handler({ grant_id: created.grant.id }, { signal: new AbortController().signal, toolCallId: 'c' })
    expect(h.db.getMergeGrant(created.grant.id)).toMatchObject({ revoked_by: 'commander' })
  })

  it('max_merges is honoured', async () => {
    const h = setup()
    const created = createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'm', text: 'merge PRs' }, { max_merges: 1 })
    if (!created.ok) throw new Error(created.error)
    expect((await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).status).toBe('merged')
    h.setPr({ url: 'https://github.com/acme/app/pull/13', number: 13, headRefOid: 'b'.repeat(40) })
    expect((await captainCall(h, 'merge_pull_request', { pr_url: 'https://github.com/acme/app/pull/13' })).status).toBe('held')
  })
})

// ── Out of scope ──────────────────────────────────────────────

describe('an out-of-scope merge still needs a held call', () => {
  it('holds a PR the grant does not name, then merges once the user approves', async () => {
    const h = setup()
    createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'm', text: 'merge #99' })
    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect(out.status).toBe('held')
    expect(h.merges).toHaveLength(0)
    const approved = await approveHeldAction(String(out.id))
    expect(approved.ok).toBe(true)
    expect(approved.result).toMatchObject({ status: 'merged', authorized_by: { kind: 'user_approval', heldId: out.id } })
    expect(h.merges).toHaveLength(1)
  })

  it('holds when the grant is for another base branch', async () => {
    const h = setup()
    createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'm', text: 'merge PRs into release' }, { base_branch: 'release' })
    expect((await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).status).toBe('held')
  })

  it('holds when merge grants are turned off for the project, even with an old grant', async () => {
    const h = setup()
    createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'm', text: 'merge PRs' })
    h.db.updateProject(h.projectId, { settings: { merge_grants: { enabled: false } } })
    expect((await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).status).toBe('held')
  })

  it('refuses a PR outside the project\'s repositories outright', async () => {
    const h = setup()
    const out = await captainCall(h, 'merge_pull_request', { pr_url: 'https://github.com/evil/app/pull/1' })
    expect(out.error).toMatch(/not one of this project/)
    expect(h.gh).not.toHaveBeenCalled()
  })

  it('only the Captain may call the merge tools; task agents are refused', async () => {
    const h = setup()
    const task = h.db.createTask({ title: 'Work', project_id: h.projectId })!
    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL }, { parentTaskId: null, taskId: task.id, artifactTaskId: task.id, projectId: h.projectId })
    expect(out.error).toMatch(/only the project's Captain/)
    expect(h.gh).not.toHaveBeenCalled()
  })

  it('without the gate (a raw Task API call) there is no merge route at all', async () => {
    const h = setup()
    setCoordinatorCallGate(null)
    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect(out.error).toBe('Unknown route')
    expect(h.merges).toHaveLength(0)
  })
})

// ── Checks and branch protection ──────────────────────────────

describe('failing checks or branch protection block the merge', () => {
  function granted(h: Harness): void {
    const created = createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'm', text: 'merge PRs' })
    if (!created.ok) throw new Error(created.error)
  }

  it('blocks on a failing check and does not spend the grant', async () => {
    const h = setup()
    granted(h)
    h.setPr({ mergeStateStatus: 'UNSTABLE', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] })
    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect(out.status).toBe('blocked')
    expect(String((out.reasons as string[]).join(' '))).toMatch(/failing checks: test/)
    expect(h.merges).toHaveLength(0)
    expect(h.db.listMergeGrants({ projectId: h.projectId })[0].uses).toBe(0)
  })

  it('waits while checks are still running', async () => {
    const h = setup()
    granted(h)
    h.setPr({ mergeStateStatus: 'BLOCKED', statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS' }] })
    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect(out).toMatchObject({ status: 'blocked', retry_later: true, needs_external_approval: false })
    expect(h.merges).toHaveLength(0)
  })

  it('surfaces a required review (CODEOWNERS) as an external approval, once, and never merges', async () => {
    const h = setup()
    granted(h)
    h.setPr({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' })
    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect(out).toMatchObject({ status: 'blocked', needs_external_approval: true })
    await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    const needsUser = h.events.filter((e) => e.outcome === 'needs_user')
    expect(needsUser).toHaveLength(1)
    expect(escalationReportText(needsUser[0])).toMatch(/Blocked on an external approval/)
    expect(h.merges).toHaveLength(0)
  })

  it('blocks when branch protection is not satisfied, drafts, conflicts, or unknown state', () => {
    const base = { url: PR_URL, number: 12, title: '', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '', headRefOid: SHA, baseRefName: 'main', checks: [] } as PullRequestGateState
    expect(evaluatePullRequestGate(base).ok).toBe(true)
    expect(evaluatePullRequestGate({ ...base, mergeStateStatus: 'BLOCKED' })).toMatchObject({ ok: false, needsExternalApproval: true })
    expect(evaluatePullRequestGate({ ...base, isDraft: true }).ok).toBe(false)
    expect(evaluatePullRequestGate({ ...base, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }).ok).toBe(false)
    expect(evaluatePullRequestGate({ ...base, mergeStateStatus: 'BEHIND' }).ok).toBe(false)
    expect(evaluatePullRequestGate({ ...base, mergeStateStatus: 'UNKNOWN' })).toMatchObject({ ok: false, pending: true })
    expect(evaluatePullRequestGate({ ...base, state: 'MERGED' }).ok).toBe(false)
    expect(evaluatePullRequestGate({ ...base, reviewDecision: 'CHANGES_REQUESTED' })).toMatchObject({ ok: false, needsExternalApproval: true })
  })

  it('does not hold (and so does not ask the user) for a PR that cannot be merged anyway', async () => {
    const h = setup()
    h.setPr({ mergeStateStatus: 'UNSTABLE', statusCheckRollup: [{ name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }] })
    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect(out.status).toBe('blocked')
    expect(listHeldActions()).toHaveLength(0)
  })
})

// ── No admin bypass ───────────────────────────────────────────

describe('no admin bypass', () => {
  it('the merge command is pinned to the checked head and carries no bypass flag', async () => {
    const h = setup()
    createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'm', text: 'merge PRs' })
    await captainCall(h, 'merge_pull_request', { pr_url: PR_URL, merge_method: 'rebase', admin: true, auto: true, flags: ['--admin'] })
    expect(h.merges).toEqual([['api', '--method', 'PUT', 'repos/acme/app/pulls/12/merge', '-f', `sha=${SHA}`, '-f', 'merge_method=rebase']])
    for (const call of h.gh.mock.calls) {
      for (const flag of FORBIDDEN_MERGE_FLAGS) expect(call[0]).not.toContain(flag)
    }
  })

  it('buildMergeCommand refuses unknown methods and partial SHAs', () => {
    expect(() => buildMergeCommand(PR_URL, 'admin' as never, SHA)).toThrow()
    expect(() => buildMergeCommand(PR_URL, 'squash', 'abc')).toThrow()
    expect(buildMergeCommand(PR_URL, 'squash', SHA)).not.toContain('--admin')
  })

  it('an unknown merge_method is refused before anything runs', async () => {
    const h = setup()
    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL, merge_method: 'admin' })
    expect(out.error).toMatch(/merge_method/)
    expect(h.gh).not.toHaveBeenCalled()
  })

  it('a GitHub refusal gives the grant use back', async () => {
    const h = setup()
    createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'm', text: 'merge PRs' })
    h.gh.mockImplementation(async (args: string[]) => {
      if (args[1] === 'view') return JSON.stringify(prState())
      throw Object.assign(new Error('Head branch was modified'), { stderr: 'gh: Head branch was modified (HTTP 409)' })
    })
    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect(out.error).toMatch(/GitHub refused/)
    expect(h.db.listMergeGrants({ projectId: h.projectId })[0].uses).toBe(0)
  })
})

// ── Audit ─────────────────────────────────────────────────────

describe('audit', () => {
  it('a merge under a grant writes the journal, the use record, and a Commander report', async () => {
    const h = setup()
    const created = createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'm', text: 'merge PRs when green' })
    if (!created.ok) throw new Error(created.error)
    await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })

    const entries = journal(h)
    expect(entries).toHaveLength(1)
    expect(entries[0].summary).toContain(PR_URL)
    expect(entries[0].summary).toContain(`merge grant ${created.grant.id}`)
    expect(entries[0].decisions.join(' ')).toContain(created.grant.id)

    const [audit] = mergeGrantAudit(h.db, h.projectId)
    expect(audit.grant).toMatchObject({ uses: 1, user_text: 'merge PRs when green', source: 'commander', source_message_id: 'm' })
    expect(audit.uses).toHaveLength(1)
    expect(audit.uses[0]).toMatchObject({ pr_url: PR_URL, head_sha: SHA, base_branch: 'main', method: 'squash', merge_state: 'CLEAN', review_decision: 'APPROVED', checks: [{ name: 'test', state: 'passed' }] })

    const report = h.events.find((e) => e.outcome === 'merged_under_grant')!
    expect(report.grantId).toBe(created.grant.id)
    expect(escalationReportText(report)).toMatch(/merged under the user's merge grant/)
  })
})

// ── The policy split and its migration ────────────────────────

describe('escalation policy: open_pr and merge_pr', () => {
  it('defaults: opening is done and reported, merging asks the user', () => {
    expect(DEFAULT_ESCALATION_POLICY.open_pr).toBe('tell_commander')
    expect(DEFAULT_ESCALATION_POLICY.merge_pr).toBe('ask_user')
    expect(escalationPolicyFromSettings({})).toMatchObject({ open_pr: 'tell_commander', merge_pr: 'ask_user' })
    expect('pr' in DEFAULT_ESCALATION_POLICY).toBe(false)
  })

  it('reads a legacy pr level as merge_pr', () => {
    expect(escalationPolicyFromSettings({ escalation: { pr: 'autonomous' } })).toMatchObject({ merge_pr: 'autonomous', open_pr: 'tell_commander' })
    expect(escalationPolicyFromSettings({ escalation: { pr: 'autonomous', merge_pr: 'ask_user' } }).merge_pr).toBe('ask_user')
  })

  it('splitLegacyPullRequestEscalation moves pr to merge_pr and defaults open_pr', () => {
    expect(splitLegacyPullRequestEscalation({ escalation: { pr: 'tell_commander', stop_task: 'ask_user' }, x: 1 })).toEqual({
      escalation: { stop_task: 'ask_user', merge_pr: 'tell_commander', open_pr: 'tell_commander' },
      x: 1
    })
    expect(splitLegacyPullRequestEscalation({ escalation: { stop_task: 'ask_user' } })).toBeNull()
    expect(splitLegacyPullRequestEscalation({})).toBeNull()
  })

  it('migration v19 rewrites stored project settings and is a no-op on re-run', () => {
    const raw = new Database(':memory:')
    createTables(raw)
    runMigrations(raw)
    const now = new Date().toISOString()
    const insert = raw.prepare('INSERT INTO projects (id, name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    insert.run('p-auto', 'Auto', JSON.stringify({ escalation: { pr: 'autonomous' }, limits: { paused: true } }), now, now)
    insert.run('p-ask', 'Ask', JSON.stringify({ escalation: { pr: 'ask_user' } }), now, now)
    insert.run('p-none', 'None', JSON.stringify({ limits: { paused: false } }), now, now)
    insert.run('p-bad', 'Bad', 'not json', now, now)
    // A returning user at v17 runs the migrations again.
    raw.prepare("UPDATE settings SET value = '17' WHERE key = '__schema_version'").run()
    applySchema(raw)
    const read = (id: string) => (raw.prepare('SELECT settings FROM projects WHERE id = ?').get(id) as { settings: string }).settings
    expect(JSON.parse(read('p-auto'))).toEqual({ escalation: { merge_pr: 'autonomous', open_pr: 'tell_commander' }, limits: { paused: true } })
    expect(JSON.parse(read('p-ask'))).toEqual({ escalation: { merge_pr: 'ask_user', open_pr: 'tell_commander' } })
    expect(JSON.parse(read('p-none'))).toEqual({ limits: { paused: false } })
    expect(read('p-bad')).toBe('not json')
    expect((raw.prepare("SELECT value FROM settings WHERE key = '__schema_version'").get() as { value: string }).value).toBe('19')
    const before = read('p-auto')
    splitPullRequestEscalation(raw)
    expect(read('p-auto')).toBe(before)
    // The grant tables exist.
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name)
    expect(tables).toEqual(expect.arrayContaining(['merge_grants', 'merge_grant_uses']))
  })

  it('a merge under a policy of tell_commander runs without a grant and is reported', async () => {
    const h = setup({ enabled: false, mergePolicy: 'tell_commander' })
    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect(out.status).toBe('merged')
    expect(h.events.some((e) => e.outcome === 'performed' && e.action === 'merge_pr')).toBe(true)
  })

  it('the Captain prompt describes the split and the merge tool', () => {
    const prompt = buildCaptainSystemPrompt({ escalationPolicy: DEFAULT_ESCALATION_POLICY })
    expect(prompt).toContain('opening pull requests (through the agent doing the work: no tool of yours does this): do it, then it is reported')
    expect(prompt).toContain('merging pull requests (`merge_pull_request`')
    expect(prompt).toContain('## Merging pull requests')
  })
})


describe('independent review: fail-closed authority boundaries', () => {
  it.each([
    'I merged PR 12', 'Explain how to merge PR 12', 'Can we merge PR 12?',
    'The issue says: merge PR 12', 'The website says "merge PR 12"',
    '> merge PR 12', 'Do not, under any circumstances whatsoever, merge PR 12',
    'Merge PR 12? No', 'Merge PR 12 only if Alice gives permission',
    'Merge PR 12 but wait for my confirmation', 'merge ready PRs in every project',
    'Merge PR 12\nThis is quoted issue text', 'merge instructions',
    'The PR merges cleanly'
  ])('refuses non-authorizing or unsupported text: %s', async (text) => {
    const h = setup()
    userTypes(h, text)
    expect((await captainCall(h, 'grant_merge_authority', {})).error).toBeTruthy()
    expect(h.db.listMergeGrants()).toEqual([])
  })

  it('keeps accepted text verbatim and refuses an oversized source instead of truncating it', () => {
    const h = setup()
    const binding = { source: 'commander' as const, sessionId: 's', messageId: 'verbatim', text: '  Please merge PR #12 when checks pass  ' }
    const result = createMergeGrantFromUserMessage(h.db, h.projectId, binding)
    expect(result.ok && result.grant.user_text).toBe(binding.text)
    expect(createMergeGrantFromUserMessage(h.db, h.projectId, { ...binding, messageId: 'long', text: ' '.repeat(4000) + 'merge PRs' }).ok).toBe(false)
  })

  it('derives repository and base restrictions and refuses model widening', () => {
    const h = setup()
    h.db.addProjectRepo(h.projectId, { provider: 'github', org: 'acme', name: 'other' })
    const binding = { source: 'commander' as const, sessionId: 's', messageId: 'repo', text: `Merge ${PR_URL} into release` }
    const result = createMergeGrantFromUserMessage(h.db, h.projectId, binding)
    expect(result.ok && result.grant).toMatchObject({ repo: 'acme/app', base_branch: 'release', pr_numbers: [12] })
    expect(createMergeGrantFromUserMessage(h.db, h.projectId, { ...binding, messageId: 'other' }, { repo: 'acme/other' }).ok).toBe(false)
    expect(createMergeGrantFromUserMessage(h.db, h.projectId, { ...binding, messageId: 'base' }, { base_branch: 'main' }).ok).toBe(false)
    expect(createMergeGrantFromUserMessage(h.db, h.projectId, { ...binding, messageId: 'project', text: 'In Other, merge PRs' }).ok).toBe(false)
  })

  it('invalidates typed eligibility on a relay, wake-up or failed send, including delayed resumes', async () => {
    const h = setup()
    const taskId = h.db.getCoordinatorTask(h.projectId)!.id
    const typed = makeUserTypedProjectMessage(h.projectId, taskId, 'merge PRs')
    const first = prepareProjectMessageDispatch(h.projectId, typed)
    expect(latestUserTypedProjectMessage(h.projectId)).toBeNull()
    activateProjectMessageDispatch(first)
    expect(latestUserTypedProjectMessage(h.projectId)?.id).toBe(typed.id)
    prepareProjectMessageDispatch(h.projectId)
    activateProjectMessageDispatch(first) // an old resume cannot reinstate it
    expect((await captainCall(h, 'grant_merge_authority', {})).error).toBeTruthy()
    const second = prepareProjectMessageDispatch(h.projectId, typed)
    activateProjectMessageDispatch(second)
    failProjectMessageDispatch(second)
    expect((await captainCall(h, 'grant_merge_authority', {})).error).toBeTruthy()
    expect(h.db.listMergeGrants()).toEqual([])
  })

  it.each([
    { mergeable: 'UNKNOWN' }, { mergeable: '' }, { statusCheckRollup: null },
    { statusCheckRollup: [null] }, { isDraft: undefined }, { reviewDecision: 'NEW_STATE' },
    { url: 'https://github.com/foreign/repo/pull/12' }, { baseRefName: '' }
  ])('refuses incomplete/mismatched GitHub data: %j', async (override) => {
    const h = setup({ mergePolicy: 'autonomous' })
    h.setPr(override)
    const result = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect(result.status).not.toBe('merged')
    expect(h.merges).toEqual([])
  })

  it.each(['disabled', 'archived', 'revoked', 'expired'] as const)('revalidates authority after the GitHub read: %s', async (change) => {
    const h = setup()
    const grant = createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'race', text: 'merge PRs' })
    if (!grant.ok) throw new Error(grant.error)
    h.gh.mockImplementation(async () => {
      if (change === 'disabled') h.db.updateProject(h.projectId, { settings: { merge_grants: { enabled: false } } })
      if (change === 'archived') h.db.archiveProject(h.projectId)
      if (change === 'revoked') h.db.revokeMergeGrant(grant.grant.id)
      if (change === 'expired') { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 8 * 86400000) }
      return JSON.stringify(prState())
    })
    const result = await performMerge(h.db, { projectId: h.projectId, pr: parseGitHubPullRequestUrl(PR_URL)!, method: 'squash', authority: { kind: 'grant', grantId: grant.grant.id } })
    expect(result.error).toBeTruthy()
    expect(h.gh).toHaveBeenCalledTimes(1)
    expect(h.db.getMergeGrant(grant.grant.id)?.uses).toBe(0)
  })

  it('reserves the last use before the merge request, even with concurrent calls', async () => {
    const h = setup()
    const grant = createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'race', text: 'merge PRs' }, { max_merges: 1 })
    if (!grant.ok) throw new Error(grant.error)
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    h.gh.mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr') return JSON.stringify(prState())
      expect(h.db.getMergeGrant(grant.grant.id)?.uses).toBe(1)
      h.merges.push(args)
      await pending
      return JSON.stringify({ merged: true, sha: SHA })
    })
    const one = captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    await vi.waitFor(() => expect(h.merges).toHaveLength(1))
    const two = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect(two.status).toBe('held')
    release()
    expect((await one).status).toBe('merged')
    expect(h.merges).toHaveLength(1)
    expect(h.db.getMergeGrant(grant.grant.id)?.uses).toBe(1)
  })

  it('records every reported check, including checks after the hundredth', async () => {
    const h = setup()
    createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'checks', text: 'merge PRs' })
    h.setPr({ statusCheckRollup: Array.from({ length: 105 }, (_, i) => ({ name: `check-${i}`, status: 'COMPLETED', conclusion: 'SUCCESS' })) })
    expect((await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).status).toBe('merged')
    expect(mergeGrantAudit(h.db, h.projectId)[0].uses[0].checks).toHaveLength(105)
  })

  it('does not report success or refund possibly spent authority on an ambiguous response', async () => {
    const h = setup()
    createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'ambiguous', text: 'merge PRs' })
    h.gh.mockImplementation(async (args: string[]) => args[0] === 'pr' ? JSON.stringify(prState()) : '{}')
    expect((await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).status).toBe('unknown')
    expect(mergeGrantAudit(h.db, h.projectId)[0]).toMatchObject({ grant: { uses: 1 }, uses: [] })
    expect(journal(h)).toEqual([])
  })
  it('retains the reservation when the transport fails after dispatch', async () => {
    const h = setup()
    createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'transport', text: 'merge PRs' })
    h.gh.mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr') return JSON.stringify(prState())
      throw new Error('Connection lost while reading response')
    })
    expect((await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).status).toBe('unknown')
    expect(h.db.listMergeGrants()[0].uses).toBe(1)
  })

})
