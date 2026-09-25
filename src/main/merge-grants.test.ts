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
  readPullRequestReadiness,
  reconcileMergeGrantReservations,
  revokeMergeGrant,
  setGhRunner,
  type PullRequestGateState
} from './merge-grants'
import { createPullRequestReviewHandoff, recordPullRequestReviewAttestation } from './pr-review-attestations'
import { createCommanderProjectTools, type CommanderAgents } from './commander/project-tools'
import { CaptainDeliveryService } from './commander/captain-delivery'
import { createCommanderMergeGrantTools, grantForRelay } from './commander/merge-grant-tools'
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

function reviewConnection(nodes: Array<Record<string, unknown>>, hasNextPage = false): Record<string, unknown> {
  return { nodes, pageInfo: { hasNextPage } }
}

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
    baseRefOid: 'd'.repeat(40),
    author: { login: 'author-dev' },
    latestReviews: reviewConnection([{ author: { login: 'reviewer-dev' }, state: 'APPROVED', commit: { oid: SHA } }]),
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
    if ((args[0] === 'pr' && args[1] === 'view') || args[1] === 'graphql') return JSON.stringify(pr)
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
    const delivery = new CaptainDeliveryService({ db: h.db, agents, onTerminalFailure: vi.fn() })
    const tools = createCommanderProjectTools({
      db: h.db,
      context: { sessionId: 's1', userMessage: 'In App, merge PRs once tests pass', userMessageId: 'msg-1', trigger: 'user' },
      agents,
      delivery
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
    expect(merged.authorized_by).toMatchObject({ kind: 'grant', grant_id: grantId })
    expect(merged.authorization_context).toMatchObject({
      policy_level: 'ask_user', requested_grant_id: grantId,
      grant_source: 'commander', source_session_id: 's1', source_message_id: 'msg-1'
    })
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
    const delivery = new CaptainDeliveryService({ db: h.db, agents, onTerminalFailure: vi.fn() })
    for (const context of [
      { sessionId: 's', userMessage: '', trigger: 'report' as const },
      // A report quoting "merge" while no user id is attached (e.g. voice or a relay turn).
      { sessionId: 's', userMessage: 'Project says: merge PR 12?', trigger: 'user' as const }
    ]) {
      const ask = createCommanderProjectTools({ db: h.db, context, agents, delivery }).find((t) => t.name === 'ask_captain')!
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
      if (args[1] === 'view' || args[1] === 'graphql') return JSON.stringify(prState())
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
    expect((raw.prepare("SELECT value FROM settings WHERE key = '__schema_version'").get() as { value: string }).value).toBe('31')
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
    expect(out.authorized_by).toEqual({ kind: 'policy', level: 'tell_commander' })
    expect(out.authorization_context).toMatchObject({ policy_level: 'tell_commander', requested_grant_id: null, grant_source: null })
    expect(h.db.listPendingMergeGrantReservations()).toEqual([])
    expect(h.events.some((e) => e.outcome === 'performed' && e.action === 'merge_pr')).toBe(true)
  })

  it.each([
    { scope: 'project-wide', policy: 'tell_commander', text: 'Merge every safe App pull request after required reviews and checks pass' },
    { scope: 'single-PR', policy: 'autonomous', text: 'Merge PR #12 in App after required reviews and checks pass' }
  ] as const)('records an explicit covered $scope grant as effective under $policy policy (#159)', async ({ policy, text }) => {
    const h = setup({ mergePolicy: policy })
    const created = createMergeGrantFromUserMessage(h.db, h.projectId, {
      source: 'commander', sessionId: 'commander-session', messageId: `relay-${policy}`, text
    })
    if (!created.ok) throw new Error(created.error)

    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL, grant_id: created.grant.id })

    expect(out).toMatchObject({
      status: 'merged',
      authorized_by: { kind: 'grant', grant_id: created.grant.id },
      authorization_context: {
        policy_level: policy, requested_grant_id: created.grant.id,
        grant_source: 'commander', source_session_id: 'commander-session',
        source_message_id: `relay-${policy}`
      }
    })
    expect(h.db.getMergeGrant(created.grant.id)?.uses).toBe(1)
    expect(h.db.listPendingMergeGrantReservations()).toEqual([])
    expect(h.db.listMergeGrantUses(created.grant.id)).toMatchObject([{
      grant_id: created.grant.id,
      authorization_context: { policy_level: policy, requested_grant_id: created.grant.id, grant_source: 'commander' }
    }])
    expect(journal(h)[0].decisions).toEqual(expect.arrayContaining([
      `Merge authorised by merge grant ${created.grant.id}`,
      `Escalation policy context: ${policy}`,
      'Grant relayed from the Commander (source message ' + `relay-${policy}` + ')'
    ]))
    expect(h.events.filter((event) => event.outcome === 'performed')).toEqual([])
    const report = h.events.find((event) => event.outcome === 'merged_under_grant')!
    expect(report).toMatchObject({ grantId: created.grant.id, level: policy,
      authorizationContext: { grant_source: 'commander', policy_level: policy } })
    expect(escalationReportText(report)).toMatch(/policy context: (tell_commander|autonomous).*verified Commander relay/)
  })

  it.each([
    { scope: 'project-wide', policy: 'autonomous', text: 'Merge every safe App pull request after required reviews and checks pass' },
    { scope: 'project-wide', policy: 'tell_commander', text: 'Merge every safe App pull request after required reviews and checks pass' },
    { scope: 'single-PR', policy: 'autonomous', text: 'Merge PR #12 in App after required reviews and checks pass' },
    { scope: 'single-PR', policy: 'tell_commander', text: 'Merge PR #12 in App after required reviews and checks pass' }
  ] as const)('selects a covered $scope grant under $policy policy when grant_id is omitted (#159)', async ({ scope, policy, text }) => {
    const h = setup({ mergePolicy: policy })
    const created = createMergeGrantFromUserMessage(h.db, h.projectId, {
      source: 'commander', sessionId: 'commander-session',
      messageId: `automatic-${scope}-${policy}`, text
    })
    if (!created.ok) throw new Error(created.error)

    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })

    expect(out).toMatchObject({
      status: 'merged',
      authorized_by: { kind: 'grant', grant_id: created.grant.id, uses: 1 },
      authorization_context: {
        policy_level: policy, requested_grant_id: null,
        grant_source: 'commander', source_message_id: `automatic-${scope}-${policy}`
      }
    })
    expect(h.merges).toHaveLength(1)
    expect(h.db.getMergeGrant(created.grant.id)?.uses).toBe(1)
    expect(h.db.listMergeGrantUses(created.grant.id)).toHaveLength(1)
    expect(h.events.filter((event) => event.outcome === 'performed')).toEqual([])
    expect(h.events.filter((event) => event.outcome === 'merged_under_grant')).toHaveLength(1)
  })

  it.each(['autonomous', 'tell_commander'] as const)(
    'the authoritative executor selects a covering grant directly under %s policy',
    async (policy) => {
      const h = setup({ mergePolicy: policy })
      const created = createMergeGrantFromUserMessage(h.db, h.projectId, {
        source: 'commander', sessionId: 's', messageId: `direct-${policy}`, text: 'Merge PR #12'
      })
      if (!created.ok) throw new Error(created.error)

      const out = await performMerge(h.db, {
        projectId: h.projectId,
        pr: parseGitHubPullRequestUrl(PR_URL)!,
        method: 'squash',
        authority: { kind: 'policy', level: policy }
      })

      expect(out).toMatchObject({
        status: 'merged',
        authorized_by: { kind: 'grant', grant_id: created.grant.id, uses: 1 },
        authorization_context: { policy_level: policy, requested_grant_id: null }
      })
      expect(h.merges).toHaveLength(1)
      expect(h.db.getMergeGrant(created.grant.id)?.uses).toBe(1)
    }
  )

  it('fails closed instead of falling back to policy when an explicit grant does not cover the PR', async () => {
    const h = setup({ mergePolicy: 'tell_commander' })
    const created = createMergeGrantFromUserMessage(h.db, h.projectId, {
      source: 'commander', sessionId: 's', messageId: 'only-99', text: 'Merge PR #99'
    })
    if (!created.ok) throw new Error(created.error)
    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL, grant_id: created.grant.id })
    expect(out.error).toMatch(/requested merge grant/i)
    expect(h.merges).toEqual([])
    expect(h.db.getMergeGrant(created.grant.id)?.uses).toBe(0)
    expect(h.events).toEqual([])
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
    const binding = { source: 'commander' as const, sessionId: 's', messageId: 'repo', text: `Merge ${PR_URL}` }
    const result = createMergeGrantFromUserMessage(h.db, h.projectId, binding)
    expect(result.ok && result.grant).toMatchObject({ repo: 'acme/app', base_branch: null, pr_numbers: [12] })
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
    expect(h.gh).toHaveBeenCalledTimes(2)
    expect(h.db.getMergeGrant(grant.grant.id)?.uses).toBe(0)
  })

  it.each(['autonomous', 'tell_commander'] as const)(
    'reserves the last use before concurrent %s-policy retries, including one without grant_id',
    async (policy) => {
    const h = setup({ mergePolicy: policy })
    const grant = createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: `race-${policy}`, text: 'merge PRs' }, { max_merges: 1 })
    if (!grant.ok) throw new Error(grant.error)
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    h.gh.mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr' || args[1] === 'graphql') return JSON.stringify(prState())
      expect(h.db.getMergeGrant(grant.grant.id)?.uses).toBe(1)
      h.merges.push(args)
      await pending
      return JSON.stringify({ merged: true, sha: SHA })
    })
    const one = captainCall(h, 'merge_pull_request', { pr_url: PR_URL, grant_id: grant.grant.id })
    await vi.waitFor(() => expect(h.merges).toHaveLength(1))
    const two = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect(two).toMatchObject({ status: 'unknown', authorized_by: { kind: 'grant', grant_id: grant.grant.id },
      authorization_context: { policy_level: policy } })
    release()
    expect(await one).toMatchObject({ status: 'merged', authorized_by: { kind: 'grant', grant_id: grant.grant.id } })
    expect(h.merges).toHaveLength(1)
    expect(h.db.getMergeGrant(grant.grant.id)?.uses).toBe(1)
    expect(h.events.filter((event) => event.outcome === 'merged_under_grant')).toHaveLength(1)
    expect(h.events.filter((event) => event.outcome === 'performed')).toHaveLength(0)
  })

  it.each(['autonomous', 'tell_commander'] as const)(
    'returns original grant attribution on an idempotent %s-policy retry without grant_id',
    async (policy) => {
    const h = setup({ mergePolicy: policy })
    const grant = createMergeGrantFromUserMessage(h.db, h.projectId, {
      source: 'commander', sessionId: 's', messageId: `idempotent-${policy}`, text: 'merge PRs'
    }, { max_merges: 1 })
    if (!grant.ok) throw new Error(grant.error)
    expect(await captainCall(h, 'merge_pull_request', { pr_url: PR_URL, grant_id: grant.grant.id }))
      .toMatchObject({ status: 'merged', authorized_by: { kind: 'grant' } })
    expect(await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).toMatchObject({
      status: 'merged', already_recorded: true,
      authorized_by: { kind: 'grant', grant_id: grant.grant.id },
      authorization_context: { policy_level: policy, grant_source: 'commander' }
    })
    expect(h.merges).toHaveLength(1)
    expect(h.db.getMergeGrant(grant.grant.id)?.uses).toBe(1)
    expect(h.db.listMergeGrantUses(grant.grant.id)).toHaveLength(1)
    expect(journal(h)).toHaveLength(1)
    expect(h.events.filter((event) => event.outcome === 'merged_under_grant')).toHaveLength(1)
  })

  it.each(['autonomous', 'tell_commander'] as const)(
    'serializes simultaneous %s-policy calls that both omit grant_id',
    async (policy) => {
      const h = setup({ mergePolicy: policy })
      const grant = createMergeGrantFromUserMessage(h.db, h.projectId, {
        source: 'commander', sessionId: 's', messageId: `simultaneous-${policy}`, text: 'merge PRs'
      }, { max_merges: 1 })
      if (!grant.ok) throw new Error(grant.error)
      let release!: () => void
      const blocked = new Promise<void>((resolve) => { release = resolve })
      h.gh.mockImplementation(async (args: string[]) => {
        if (args[0] === 'pr' || args[1] === 'graphql') return JSON.stringify(prState())
        h.merges.push(args)
        if (h.merges.length === 1) await blocked
        return JSON.stringify({ merged: true, sha: SHA })
      })

      const one = captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
      const two = captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
      await vi.waitFor(() => expect(h.merges).toHaveLength(1))
      const early = await Promise.race([
        one.then((result) => ({ call: 'one', result })),
        two.then((result) => ({ call: 'two', result }))
      ])

      expect(early.result.status).not.toBe('merged')
      expect(early.result.authorized_by).toMatchObject({ kind: 'grant', grant_id: grant.grant.id, uses: 1 })
      expect(h.merges).toHaveLength(1)
      release()
      const results = await Promise.all([one, two])
      expect(results.filter((result) => result.status === 'merged')).toHaveLength(1)
      expect(h.merges).toHaveLength(1)
      expect(h.db.getMergeGrant(grant.grant.id)?.uses).toBe(1)
      expect(h.db.listMergeGrantUses(grant.grant.id)).toHaveLength(1)
      expect(journal(h)).toHaveLength(1)
      expect(h.events.filter((event) => event.outcome === 'merged_under_grant')).toHaveLength(1)
      expect(h.events.filter((event) => event.outcome === 'performed')).toEqual([])
    }
  )

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
    h.gh.mockImplementation(async (args: string[]) => (args[0] === 'pr' || args[1] === 'graphql') ? JSON.stringify(prState()) : '{}')
    expect((await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).status).toBe('unknown')
    expect(mergeGrantAudit(h.db, h.projectId)[0]).toMatchObject({ grant: { uses: 1 }, uses: [] })
    expect(journal(h)).toEqual([])
  })
  it('retains the reservation when the transport fails after dispatch', async () => {
    const h = setup()
    createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'transport', text: 'merge PRs' })
    h.gh.mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr' || args[1] === 'graphql') return JSON.stringify(prState())
      throw new Error('Connection lost while reading response')
    })
    expect((await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).status).toBe('unknown')
    expect(h.db.listMergeGrants()[0].uses).toBe(1)
  })

  it.each(['autonomous', 'tell_commander'] as const)(
    'keeps pending grant ownership when an uncertain %s-policy retry omits grant_id',
    async (policy) => {
      const h = setup({ mergePolicy: policy })
      const created = createMergeGrantFromUserMessage(h.db, h.projectId, {
        source: 'commander', sessionId: 's', messageId: `uncertain-${policy}`, text: 'merge PRs'
      }, { max_merges: 1 })
      if (!created.ok) throw new Error(created.error)
      h.gh.mockImplementation(async (args: string[]) => {
        if (args[0] === 'pr' || args[1] === 'graphql') return JSON.stringify(prState())
        h.merges.push(args)
        throw new Error('Response lost while GitHub still reports OPEN')
      })

      const first = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL, grant_id: created.grant.id })
      const retry = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })

      expect(first).toMatchObject({ status: 'unknown', authorized_by: { kind: 'grant', grant_id: created.grant.id } })
      expect(retry).toMatchObject({
        status: 'unknown',
        authorized_by: { kind: 'grant', grant_id: created.grant.id, uses: 1 },
        authorization_context: { policy_level: policy }
      })
      expect(h.merges).toHaveLength(1)
      expect(h.db.listPendingMergeGrantReservations()).toHaveLength(1)
      expect(h.db.getMergeGrant(created.grant.id)?.uses).toBe(1)
      expect(journal(h)).toEqual([])
      expect(h.events.filter((event) => event.outcome === 'performed' || event.outcome === 'merged_under_grant')).toEqual([])
    }
  )

  it.each(['autonomous', 'tell_commander'] as const)(
    'returns post-refund grant counters after a definitive %s-policy refusal',
    async (policy) => {
      const h = setup({ mergePolicy: policy })
      const created = createMergeGrantFromUserMessage(h.db, h.projectId, {
        source: 'commander', sessionId: 's', messageId: `refused-${policy}`, text: 'merge PRs'
      }, { max_merges: 1 })
      if (!created.ok) throw new Error(created.error)
      h.gh.mockImplementation(async (args: string[]) =>
        (args[0] === 'pr' || args[1] === 'graphql')
          ? JSON.stringify(prState())
          : JSON.stringify({ merged: false, message: 'GitHub refused' }))

      const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })

      expect(out).toMatchObject({
        authorized_by: { kind: 'grant', grant_id: created.grant.id, uses: 0 },
        authorization_context: { policy_level: policy, requested_grant_id: null }
      })
      expect(out.error).toMatch(/GitHub refused/)
      expect(h.db.getMergeGrant(created.grant.id)?.uses).toBe(0)
      expect(h.db.listPendingMergeGrantReservations()).toEqual([])
      expect(h.db.listMergeGrantUses(created.grant.id)).toEqual([])
      expect(journal(h)).toEqual([])
      expect(h.events).toEqual([])
    }
  )

  it('refuses base-scoped authority instead of racing a PR retarget', async () => {
    const h = setup()
    const binding = { source: 'commander' as const, sessionId: 's', messageId: 'base', text: 'merge PRs into main' }
    expect(createMergeGrantFromUserMessage(h.db, h.projectId, binding).ok).toBe(false)
    const created = createMergeGrantFromUserMessage(h.db, h.projectId, { ...binding, text: 'merge PRs' })
    if (!created.ok) throw new Error(created.error)
    // An existing grant from an earlier build must also fail closed.
    h.db.db.prepare('UPDATE merge_grants SET base_branch = ? WHERE id = ?').run('main', created.grant.id)
    const result = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect(result).toMatchObject({ status: 'blocked', needs_external_approval: true })
    expect(h.merges).toHaveLength(0)
    expect(h.db.getMergeGrant(created.grant.id)?.uses).toBe(0)
  })

  it('recovers an uncertain committed merge after reopening SQLite, exactly once', async () => {
    const h = setup()
    const created = createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'restart', text: 'merge PRs' }, { max_merges: 1 })
    if (!created.ok) throw new Error(created.error)
    h.gh.mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr' || args[1] === 'graphql') return JSON.stringify(prState())
      expect(h.db.listPendingMergeGrantReservations()[0].snapshot).toMatchObject({ pr_url: PR_URL, head_sha: SHA })
      throw new Error('Response lost after GitHub committed')
    })
    expect((await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).status).toBe('unknown')
    const { db: reopened } = createTestDb()
    reopened.db.close()
    reopened.db = new Database(h.db.db.serialize())
    clearUserTypedProjectMessages()
    expect(reopened.listPendingMergeGrantReservations()).toHaveLength(1)
    expect(reopened.getMergeGrant(created.grant.id)?.uses).toBe(1)
    // An open PR or a different merged head cannot free the reservation.
    await reconcileMergeGrantReservations(reopened)
    expect(reopened.listPendingMergeGrantReservations()).toHaveLength(1)
    h.gh.mockImplementation(async () => JSON.stringify(prState({ state: 'MERGED', headRefOid: 'b'.repeat(40) })))
    await reconcileMergeGrantReservations(reopened)
    expect(reopened.listPendingMergeGrantReservations()).toHaveLength(1)
    h.gh.mockImplementation(async () => JSON.stringify(prState({ state: 'MERGED' })))
    await reconcileMergeGrantReservations(reopened)
    await reconcileMergeGrantReservations(reopened)
    expect(reopened.listPendingMergeGrantReservations()).toHaveLength(0)
    expect(reopened.listMergeGrantUses(created.grant.id)).toHaveLength(1)
    expect(reopened.getMergeGrant(created.grant.id)?.uses).toBe(1)
    expect(reopened.listProjectStatusJournal(h.projectId, { limit: 20 }).entries).toHaveLength(1)
    reopened.close()
  })

  it('a repeated refund cannot refund a different reservation', () => {
    const h = setup()
    const created = createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'refund', text: 'merge PRs' })
    if (!created.ok) throw new Error(created.error)
    const snapshot = { pr_url: PR_URL, pr_title: '', base_branch: 'main', head_sha: SHA, method: 'squash', merge_state: 'CLEAN', review_decision: '', checks: [] }
    const first = h.db.reserveMergeGrantUse(created.grant.id, snapshot)!
    expect(h.db.reserveMergeGrantUse(created.grant.id, snapshot)).toBeUndefined()
    const second = h.db.reserveMergeGrantUse(created.grant.id, { ...snapshot, pr_url: 'https://github.com/acme/app/pull/13' })!
    h.db.refundMergeGrantUse(first.reservationId)
    h.db.refundMergeGrantUse(first.reservationId)
    expect(h.db.getMergeGrant(created.grant.id)?.uses).toBe(1)
    expect(h.db.listPendingMergeGrantReservations().map((r) => r.id)).toEqual([second.reservationId])
  })

  it('never widens an eight-digit PR instruction into every PR', () => {
    const h = setup()
    const result = createMergeGrantFromUserMessage(h.db, h.projectId, {
      source: 'commander', sessionId: 's', messageId: 'large-pr', text: 'Merge PR #12345678'
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.grant.pr_numbers).toEqual([12345678])
    expect(checkMergeIntent('Merge PR #0').ok).toBe(false)
    expect(checkMergeIntent('Merge PR #9007199254740993').ok).toBe(false)
    expect(parseGitHubPullRequestUrl('https://github.com/acme/app/pull/9007199254740993')).toBeNull()
  })

  it('reports a recovered merge to the Commander exactly once', async () => {
    const h = setup({ mergePolicy: 'tell_commander' })
    const created = createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'recover-report', text: 'Merge PRs' })
    if (!created.ok) throw new Error(created.error)
    h.gh.mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr' || args[1] === 'graphql') return JSON.stringify(prState())
      throw new Error('Lost response')
    })
    const unknown = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL, grant_id: created.grant.id })
    expect(unknown).toMatchObject({ status: 'unknown', authorized_by: { kind: 'grant', grant_id: created.grant.id },
      authorization_context: { policy_level: 'tell_commander', grant_source: 'commander' } })
    expect(h.db.listPendingMergeGrantReservations()[0].snapshot.authorization_context).toMatchObject({
      policy_level: 'tell_commander', requested_grant_id: created.grant.id, grant_source: 'commander'
    })
    h.setPr({ state: 'MERGED' })
    h.gh.mockImplementation(async () => JSON.stringify(prState({ state: 'MERGED' })))
    await captainCall(h, 'list_merge_grants', {})
    await captainCall(h, 'list_merge_grants', {})
    expect(h.events.filter((event) => event.outcome === 'merged_under_grant')).toHaveLength(1)
    expect(h.events.filter((event) => event.outcome === 'performed')).toHaveLength(0)
    expect(h.db.listMergeGrantUses(created.grant.id)[0].authorization_context).toMatchObject({
      policy_level: 'tell_commander', requested_grant_id: created.grant.id, grant_source: 'commander'
    })
    expect(journal(h)).toHaveLength(1)
  })

  it('rolls back merge finalization when the journal cannot be written', () => {
    const h = setup()
    const result = createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'commander', sessionId: 's', messageId: 'journal', text: 'Merge PRs' })
    if (!result.ok) throw new Error(result.error)
    const pending = h.db.reserveMergeGrantUse(result.grant.id, { pr_url: PR_URL, pr_title: '', base_branch: 'main', head_sha: SHA, method: 'squash', merge_state: 'CLEAN', review_decision: '', checks: [] })!
    const write = vi.spyOn(h.db, 'appendProjectStatusJournal').mockImplementation(() => { throw new Error('disk full') })
    expect(() => h.db.recordMergeGrantUse(pending.reservationId)).toThrow('disk full')
    expect(h.db.listMergeGrantUses(result.grant.id)).toHaveLength(0)
    expect(h.db.listPendingMergeGrantReservations()).toHaveLength(1)
    write.mockRestore()
    h.db.recordMergeGrantUse(pending.reservationId)
    expect(journal(h)).toHaveLength(1)
  })

})

// #155: exercise the explicit project-wide path through the real grant and merge gates.
const PROJECT_WIDE_COMMANDS = [
  'Merge every safe 21x pull request after required reviews and checks pass',
  'Merge all open PRs in 21x when required reviews and checks pass'
]

function setupWide() {
  const h = setup()
  h.db.updateProject(h.projectId, { name: '21x' })
  return h
}

function wideGrant(h: Harness, scope = {}) {
  return createMergeGrantFromUserMessage(h.db, h.projectId, {
    source: 'project_chat', sessionId: 'captain', messageId: 'wide', text: PROJECT_WIDE_COMMANDS[0]
  }, scope)
}

function attestExactHead(h: Harness, options: { baseSha?: string; sameAgent?: boolean; verdict?: 'CLEAN' | 'CHANGES_REQUIRED' } = {}) {
  const implementationAgent = h.db.createAgent({ name: 'Implementation agent' })!
  const reviewerAgent = options.sameAgent ? implementationAgent : h.db.createAgent({ name: 'Independent reviewer' })!
  const implementation = h.db.createTask({
    title: 'Implement PR', type: 'coding', project_id: h.projectId, repos: ['acme/app']
  })!
  const review = h.db.createTask({
    title: 'Independent security review', type: 'review', project_id: h.projectId, repos: ['acme/app'], labels: ['security']
  })!
  h.db.updateTask(implementation.id, { agent_id: implementationAgent.id })
  h.db.updateTask(review.id, { agent_id: reviewerAgent.id })
  const handoff = createPullRequestReviewHandoff(h.db, {
    projectId: h.projectId,
    implementationTaskId: implementation.id,
    implementationAgentId: implementationAgent.id,
    reviewTaskId: review.id,
    prUrl: PR_URL,
    headSha: SHA,
    baseSha: options.baseSha ?? 'd'.repeat(40)
  })
  if (!handoff.ok) return handoff
  return recordPullRequestReviewAttestation(h.db, {
    projectId: h.projectId,
    reviewTaskId: review.id,
    reviewerAgentId: reviewerAgent.id,
    implementationTaskId: implementation.id,
    prUrl: PR_URL,
    headSha: SHA,
    baseSha: options.baseSha ?? 'd'.repeat(40),
    verdict: options.verdict ?? 'CLEAN',
    summary: 'Exact-head security review completed.'
  })
}

describe('explicit project-wide grants (#155)', () => {
  it.each(PROJECT_WIDE_COMMANDS)('accepts the exact reported command: %s', async (text) => {
    const h = setupWide()
    userTypes(h, text)
    const granted = await captainCall(h, 'grant_merge_authority', {})
    expect(granted.status).toBe('granted')
    expect(granted.allows).toContain('this project only')
    expect(h.db.getMergeGrant(String(granted.grant_id))).toMatchObject({
      project_id: h.projectId, repo: null, pr_numbers: [], user_text: text
    })
    expect((await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).status).toBe('merged')
    expect(h.db.listMergeGrantUses(String(granted.grant_id))).toHaveLength(1)
    expect(journal(h)).toHaveLength(1)
  })

  it.each(PROJECT_WIDE_COMMANDS)('binds verified Commander typed provenance: %s', (text) => {
    const h = setupWide()
    const context = { sessionId: 's', userMessage: text, userMessageId: 'stored', trigger: 'user' as const }
    const grant = grantForRelay(h.db, context, h.db.getProject(h.projectId)!, {})
    expect(grant).toMatchObject({ project_id: h.projectId, source: 'commander', source_message_id: 'stored', user_text: text })
  })

  it.each(['report', 'voice'] as const)('explains rejected Commander %s provenance without creating a grant', (origin) => {
    const h = setupWide()
    const context = { sessionId: 's', userMessage: PROJECT_WIDE_COMMANDS[0],
      userMessageId: origin === 'report' ? 'report-id' : undefined, trigger: origin === 'report' ? 'report' as const : 'user' as const }
    expect(() => grantForRelay(h.db, context, h.db.getProject(h.projectId)!, {})).toThrow(/INELIGIBLE_PROVENANCE.*Accepted wording/)
    expect(h.db.listMergeGrants()).toHaveLength(0)
  })

  it.each([
    [{ pr_numbers: 'all' }, 'PR_SCOPE_UNSUPPORTED'],
    [{ repo: 123 }, 'PR_SCOPE_UNSUPPORTED'],
    [{ max_merges: '1' }, 'INVALID_USE_LIMIT'],
    [{ expires_in_hours: '24' }, 'INVALID_EXPIRY']
  ])('never drops malformed model restrictions: %j', async (scope, code) => {
    const h = setupWide()
    userTypes(h, PROJECT_WIDE_COMMANDS[0])
    expect(await captainCall(h, 'grant_merge_authority', scope as Record<string, unknown>)).toMatchObject({ reason_code: code })
    expect(() => grantForRelay(h.db, { sessionId: 's', userMessage: PROJECT_WIDE_COMMANDS[0], userMessageId: 'stored' }, h.db.getProject(h.projectId)!, scope)).toThrow(String(code))
    expect(h.db.listMergeGrants()).toHaveLength(0)
  })

  it.each(PROJECT_WIDE_COMMANDS)('reports opt-in off separately for valid wording: %s', async (text) => {
    const h = setupWide()
    h.db.updateProject(h.projectId, { settings: {} })
    userTypes(h, text)
    const out = await captainCall(h, 'grant_merge_authority', {})
    expect(out).toMatchObject({ ok: false, reason_code: 'FEATURE_DISABLED', offending_scope: h.projectId })
    expect(out.blockers).toHaveLength(1)
    expect(out.accepted_examples).toContain(text)
    expect(out.error).toMatch(/No merge grant was created.*turned off/)
    expect(h.db.listMergeGrants()).toHaveLength(0)
    expect(h.db.getProject(h.projectId)?.settings).toEqual({})
  })

  it('reports disabled configuration and unsupported wording together, in stable order', () => {
    const h = setupWide()
    h.db.updateProject(h.projectId, { settings: {} })
    const out = createMergeGrantFromUserMessage(h.db, h.projectId, {
      source: 'project_chat', sessionId: 's', messageId: 'bad', text: 'Merge all PRs everywhere'
    })
    expect(out).toMatchObject({ reason_code: 'FEATURE_DISABLED', blockers: [
      { reason_code: 'FEATURE_DISABLED' }, { reason_code: 'PR_SCOPE_UNSUPPORTED', offending_scope: 'Merge all PRs everywhere' }
    ] })
  })

  it.each([
    ['Merge all open PRs when required reviews and checks pass', 'PROJECT_MISSING'],
    ['Merge all open PRs in Missing when required reviews and checks pass', 'PROJECT_MISSING'],
    ['Merge all open PRs in 21x and Other when required reviews and checks pass', 'MULTIPLE_PROJECTS_UNSUPPORTED'],
    ['Merge all open PRs in all projects when required reviews and checks pass', 'MULTIPLE_PROJECTS_UNSUPPORTED'],
    ['Merge every safe 21x pull request', 'PR_SCOPE_UNSUPPORTED'],
    ['Merge all open PRs in 21x when checks pass', 'PR_SCOPE_UNSUPPORTED'],
    ['Merge all open PRs in 21x when required reviews and checks pass without review', 'PR_SCOPE_UNSUPPORTED'],
    ['Merge all open PRs in 21x when required reviews and checks pass; merge Other', 'PR_SCOPE_UNSUPPORTED'],
    ['Do not merge all open PRs in 21x when required reviews and checks pass', 'AMBIGUOUS_COMMAND'],
    ['Can you merge all open PRs in 21x when required reviews and checks pass', 'AMBIGUOUS_COMMAND'],
    ['Merge all open PRs in 21x when required reviews and checks pass?', 'AMBIGUOUS_COMMAND'],
    ['“Merge every safe 21x pull request after required reviews and checks pass”', 'AMBIGUOUS_COMMAND'],
    ["'Merge all open PRs in 21x when required reviews and checks pass'", 'AMBIGUOUS_COMMAND'],
    ['The report says: Merge all open PRs in 21x when required reviews and checks pass', 'AMBIGUOUS_COMMAND']
  ])('rejects %s with %s', (text, code) => {
    const h = setupWide()
    const out = createMergeGrantFromUserMessage(h.db, h.projectId, { source: 'project_chat', sessionId: 's', messageId: 'bad', text })
    expect(out).toMatchObject({ ok: false, reason_code: code, offending_scope: expect.any(String), accepted_examples: expect.any(Array) })
    expect(h.db.listMergeGrants()).toHaveLength(0)
  })

  it('rejects duplicate project names and repositories shared across projects', () => {
    const h = setupWide()
    const other = h.db.createProject({ name: '21x' })!
    expect(wideGrant(h)).toMatchObject({ reason_code: 'PROJECT_AMBIGUOUS' })
    h.db.addProjectRepo(other.id, { provider: 'github', org: 'acme', name: 'app' })
    const out = createMergeGrantFromUserMessage(h.db, h.projectId, {
      source: 'project_chat', sessionId: 's', messageId: 'repo', text: 'Merge all open PRs in acme/app when required reviews and checks pass'
    })
    expect(out).toMatchObject({ reason_code: 'PROJECT_AMBIGUOUS', offending_scope: 'acme/app' })
  })

  it('cannot redirect a named project using model scope or reuse a message across projects', () => {
    const h = setupWide()
    const other = h.db.createProject({ name: 'Other', settings: { merge_grants: { enabled: true } } })!
    h.db.addProjectRepo(other.id, { provider: 'github', org: 'acme', name: 'other' })
    const binding = { source: 'project_chat' as const, sessionId: 's', messageId: 'same', text: PROJECT_WIDE_COMMANDS[0] }
    expect(createMergeGrantFromUserMessage(h.db, other.id, binding)).toMatchObject({ reason_code: 'PROJECT_MISMATCH' })
    expect(createMergeGrantFromUserMessage(h.db, h.projectId, binding, { repo: 'acme/other' })).toMatchObject({ reason_code: 'PR_SCOPE_UNSUPPORTED' })
    expect(createMergeGrantFromUserMessage(h.db, h.projectId, binding).ok).toBe(true)
    expect(createMergeGrantFromUserMessage(h.db, h.projectId, binding)).toMatchObject({ reason_code: 'MESSAGE_ALREADY_USED' })
  })

  it('narrows repository wording and numbered PRs without widening scope', () => {
    const h = setupWide()
    h.db.addProjectRepo(h.projectId, { provider: 'github', org: 'acme', name: 'second' })
    const binding = { source: 'project_chat' as const, sessionId: 's', messageId: 'repo', text: 'Merge every safe acme/app pull request once required reviews and checks pass' }
    const result = createMergeGrantFromUserMessage(h.db, h.projectId, binding)
    expect(result.ok && result.grant).toMatchObject({ repo: 'acme/app', pr_numbers: [] })
    expect(createMergeGrantFromUserMessage(h.db, h.projectId, { ...binding, messageId: 'widen' }, { repo: 'acme/second' })).toMatchObject({ reason_code: 'PR_SCOPE_UNSUPPORTED' })
    const numbered = createMergeGrantFromUserMessage(h.db, h.projectId, { ...binding, messageId: 'numbered', text: 'Merge PR #12 in 21x after required reviews and checks pass' }, { repo: 'acme/app' })
    expect(numbered.ok && numbered.grant).toMatchObject({ repo: 'acme/app', pr_numbers: [12] })
  })

  it.each(['voice', 'report', 'model', 'web', 'commander_relay'])('rejects ineligible source %s even with exact command text', (source) => {
    const h = setupWide()
    expect(createMergeGrantFromUserMessage(h.db, h.projectId, {
      source: source as 'project_chat', sessionId: 's', messageId: 'forged', text: PROJECT_WIDE_COMMANDS[0]
    })).toMatchObject({ reason_code: 'INELIGIBLE_PROVENANCE' })
    expect(h.db.listMergeGrants()).toHaveLength(0)
  })

  it.each([
    [{ expires_in_hours: 0 }, 'INVALID_EXPIRY'],
    [{ expires_in_hours: NaN }, 'INVALID_EXPIRY'],
    [{ max_merges: 0 }, 'INVALID_USE_LIMIT'],
    [{ max_merges: 1.5 }, 'INVALID_USE_LIMIT'],
    [{ base_branch: 'main' }, 'PR_SCOPE_UNSUPPORTED']
  ] as const)('reports invalid scope %j', (scope, code) => {
    expect(wideGrant(setupWide(), scope)).toMatchObject({ reason_code: code })
  })

  it.each(['expired', 'revoked', 'disabled', 'used_up'] as const)('does not merge with a project-wide grant that is %s', async (change) => {
    const h = setupWide()
    const result = wideGrant(h, { max_merges: 1, expires_in_hours: 999 })
    if (!result.ok) throw new Error(result.error)
    expect(Date.parse(result.grant.expires_at) - Date.parse(result.grant.created_at)).toBeLessThanOrEqual(168 * 3_600_000)
    if (change === 'expired') { vi.useFakeTimers(); vi.setSystemTime(Date.now() + 169 * 3_600_000) }
    if (change === 'revoked') revokeMergeGrant(h.db, result.grant.id)
    if (change === 'disabled') h.db.updateProject(h.projectId, { settings: {} })
    if (change === 'used_up') await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect((await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).status).toBe('held')
    expect(h.merges).toHaveLength(change === 'used_up' ? 1 : 0)
  })

  it.each([
    { state: 'CLOSED' }, { state: 'MERGED' }, { isDraft: true },
    { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, { mergeable: 'UNKNOWN' },
    { mergeStateStatus: 'BLOCKED' }, { mergeStateStatus: 'BEHIND' }, { mergeStateStatus: 'UNKNOWN' },
    { reviewDecision: 'REVIEW_REQUIRED' }, { reviewDecision: 'CHANGES_REQUESTED' }, { reviewDecision: 'UNRECOGNIZED' },
    { headRefOid: '' }, { baseRefOid: undefined }, { baseRefOid: 'short' }, { statusCheckRollup: null },
    { statusCheckRollup: [{ name: 'required', status: 'IN_PROGRESS' }] },
    { statusCheckRollup: [{ name: 'required', status: 'COMPLETED', conclusion: 'FAILURE' }] }
  ])('preserves the merge gate for %j', async (over) => {
    const h = setupWide()
    const result = wideGrant(h)
    if (!result.ok) throw new Error(result.error)
    h.setPr(over)
    expect((await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).status).not.toBe('merged')
    expect(h.merges).toHaveLength(0)
    expect(h.db.getMergeGrant(result.grant.id)?.uses).toBe(0)
  })

  it.each(['CLEAN', 'HAS_HOOKS'])('merges ready PRs in %s with pinned SHA and no bypass', async (mergeStateStatus) => {
    const h = setupWide()
    wideGrant(h)
    h.setPr({ mergeStateStatus })
    expect((await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).status).toBe('merged')
    expect(h.merges[0]).toContain(`sha=${SHA}`)
    for (const flag of FORBIDDEN_MERGE_FLAGS) expect(h.merges[0]).not.toContain(flag)
  })

  it('rejects inconsistent GitHub ref reads before spending authority', async () => {
    const h = setupWide()
    wideGrant(h)
    h.gh.mockResolvedValueOnce(JSON.stringify(prState()))
      .mockResolvedValueOnce(JSON.stringify(prState({ headRefOid: 'b'.repeat(40) })))
    expect(await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).toMatchObject({ error: expect.stringContaining('changed PR head/base') })
    expect(h.db.listMergeGrants()[0].uses).toBe(0)
    expect(h.merges).toHaveLength(0)
  })

  it.each([{ headRefOid: 'b'.repeat(40) }, { baseRefName: 'release' }, { baseRefOid: 'c'.repeat(40) }])('stops if the PR changes before merge: %j', async (changed) => {
    const h = setupWide()
    const result = wideGrant(h)
    if (!result.ok) throw new Error(result.error)
    h.gh.mockResolvedValueOnce(JSON.stringify(prState())).mockResolvedValueOnce(JSON.stringify(prState()))
      .mockResolvedValueOnce(JSON.stringify(prState(changed))).mockResolvedValueOnce(JSON.stringify(prState(changed)))
    expect(await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).toMatchObject({ status: 'blocked', reason_code: 'PR_CHANGED' })
    expect(h.db.getMergeGrant(result.grant.id)?.uses).toBe(0)
    expect(h.merges).toHaveLength(0)
  })

  it('reevaluates a stack after its predecessor merges and skips until fresh checks pass', async () => {
    const h = setupWide()
    wideGrant(h)
    expect((await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).status).toBe('merged')
    const successor = 'https://github.com/acme/app/pull/13'
    h.setPr({ url: successor, number: 13, baseRefOid: 'b'.repeat(40), mergeStateStatus: 'BEHIND' })
    expect((await captainCall(h, 'merge_pull_request', { pr_url: successor })).status).toBe('blocked')
    expect(h.merges).toHaveLength(1)
    h.setPr({ url: successor, number: 13, baseRefOid: 'b'.repeat(40), statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS' }] })
    expect((await captainCall(h, 'merge_pull_request', { pr_url: successor })).status).toBe('blocked')
    h.setPr({ url: successor, number: 13, baseRefOid: 'b'.repeat(40) })
    expect((await captainCall(h, 'merge_pull_request', { pr_url: successor })).status).toBe('merged')
    expect(h.merges).toHaveLength(2)
  })

  // #156 review: on a repository whose base branch requires no reviews GitHub
  // reports reviewDecision "", so the mechanical gate alone called an entirely
  // unreviewed PR ready. A standing grant would then land obsolete or
  // duplicate work without anyone looking at it.
  it('refuses a mechanically green but unreviewed PR and spends no grant use', async () => {
    const h = setupWide()
    const result = wideGrant(h)
    if (!result.ok) throw new Error(result.error)
    h.setPr({ reviewDecision: '', latestReviews: reviewConnection([]) })
    expect(await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).toMatchObject({
      status: 'blocked',
      reason_code: 'INDEPENDENT_REVIEW_REQUIRED',
      blocker_class: 'independent_review_required',
      needs_external_approval: false,
      retry_later: false
    })
    expect(h.merges).toHaveLength(0)
    expect(h.db.getMergeGrant(result.grant.id)?.uses).toBe(0)
  })

  it('accepts a verified exact-head 21x attestation when GitHub does not require approval, without treating COMMENT as approval', async () => {
    const h = setupWide()
    const result = wideGrant(h)
    if (!result.ok) throw new Error(result.error)
    expect(attestExactHead(h)).toMatchObject({ ok: true, attestation: { verdict: 'CLEAN' } })
    h.setPr({
      reviewDecision: '',
      latestReviews: reviewConnection([{ author: { login: 'commenter' }, state: 'COMMENTED', commit: { oid: SHA } }])
    })
    expect(await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).toMatchObject({
      status: 'merged', authorized_by: { kind: 'grant' }
    })
    expect(h.merges).toHaveLength(1)
  })

  it('classifies a protected-branch approval as externally owned even with a CLEAN 21x attestation', async () => {
    const h = setupWide()
    const result = wideGrant(h)
    if (!result.ok) throw new Error(result.error)
    expect(attestExactHead(h).ok).toBe(true)
    h.setPr({
      mergeStateStatus: 'BLOCKED',
      reviewDecision: 'REVIEW_REQUIRED',
      reviewRequests: [{ login: 'code-owner' }],
      latestReviews: reviewConnection([{ author: { login: 'commenter' }, state: 'COMMENTED', commit: { oid: SHA } }])
    })
    expect(await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).toMatchObject({
      status: 'blocked',
      blocker_class: 'external_approval_required',
      reason_code: 'EXTERNAL_APPROVAL_REQUIRED',
      needs_external_approval: true,
      retry_later: false,
      approval_ownership: {
        owner: 'github_branch_protection',
        requestedReviewers: ['code-owner'],
        formalApprovalRequired: true
      }
    })
    expect(h.db.getMergeGrant(result.grant.id)?.uses).toBe(0)
    expect(h.merges).toHaveLength(0)
  })

  it('refuses a same-agent attestation and leaves the product review gate closed', async () => {
    const h = setupWide()
    const result = wideGrant(h)
    if (!result.ok) throw new Error(result.error)
    expect(attestExactHead(h, { sameAgent: true })).toMatchObject({
      ok: false,
      error: expect.stringContaining('different assigned agent')
    })
    h.setPr({ reviewDecision: '', latestReviews: reviewConnection([]) })
    expect(await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).toMatchObject({
      reason_code: 'INDEPENDENT_REVIEW_REQUIRED'
    })
    expect(h.db.getMergeGrant(result.grant.id)?.uses).toBe(0)
  })

  it('invalidates an exact-head attestation and its readiness revision when the base advances', async () => {
    const h = setupWide()
    expect(attestExactHead(h).ok).toBe(true)
    h.setPr({ reviewDecision: '', latestReviews: reviewConnection([]) })
    const first = await readPullRequestReadiness(h.db, h.projectId, parseGitHubPullRequestUrl(PR_URL)!)
    expect(first.snapshot).toMatchObject({ classification: 'ready', base_sha: 'd'.repeat(40), invalidated_at: null })

    h.setPr({ reviewDecision: '', latestReviews: reviewConnection([]), baseRefOid: 'e'.repeat(40) })
    const second = await readPullRequestReadiness(h.db, h.projectId, parseGitHubPullRequestUrl(PR_URL)!)
    expect(second.snapshot).toMatchObject({ classification: 'independent_review_required', base_sha: 'e'.repeat(40) })
    const history = h.db.listPullRequestReadinessSnapshots(h.projectId, 'acme/app', 12)
    expect(history).toHaveLength(2)
    expect(history.find((snapshot) => snapshot.invalidated_at)).toMatchObject({
      invalidated_reason: 'base_changed', invalidated_at: expect.any(String)
    })
  })

  it('invalidates on a check rerun and spends no grant use when the result is unchanged', async () => {
    const h = setupWide()
    const result = wideGrant(h)
    if (!result.ok) throw new Error(result.error)
    const first = prState({
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://checks/runs/1' }]
    })
    const rerun = prState({
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://checks/runs/2' }]
    })
    h.gh.mockResolvedValueOnce(JSON.stringify(first)).mockResolvedValueOnce(JSON.stringify(first))
      .mockResolvedValueOnce(JSON.stringify(rerun)).mockResolvedValueOnce(JSON.stringify(rerun))
    expect(await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).toMatchObject({
      status: 'blocked', reason_code: 'PR_CHANGED'
    })
    expect(h.db.getMergeGrant(result.grant.id)?.uses).toBe(0)
    expect(h.merges).toHaveLength(0)
    const history = h.db.listPullRequestReadinessSnapshots(h.projectId, 'acme/app', 12)
    expect(history.find((snapshot) => snapshot.invalidated_at)?.invalidated_reason).toBe('checks_changed')
  })

  it('binds the attestation revision into readiness and spends no grant use after replacement', async () => {
    const h = setupWide()
    const result = wideGrant(h)
    if (!result.ok) throw new Error(result.error)
    expect(attestExactHead(h)).toMatchObject({ ok: true })
    h.setPr({
      reviewDecision: 'APPROVED',
      latestReviews: reviewConnection([{ author: { login: 'github-reviewer' }, state: 'APPROVED', commit: { oid: SHA } }])
    })
    const first = await readPullRequestReadiness(h.db, h.projectId, parseGitHubPullRequestUrl(PR_URL)!)
    expect(first.snapshot.classification).toBe('ready')

    expect(attestExactHead(h, { verdict: 'CHANGES_REQUIRED' })).toMatchObject({ ok: true })
    const outcome = await performMerge(h.db, {
      projectId: h.projectId,
      pr: parseGitHubPullRequestUrl(PR_URL)!,
      method: 'squash',
      authority: { kind: 'grant', grantId: result.grant.id },
      state: first.state,
      readiness: first
    })
    expect(outcome).toMatchObject({ status: 'blocked', reason_code: 'PR_CHANGED' })
    const freshOutcome = await performMerge(h.db, {
      projectId: h.projectId,
      pr: parseGitHubPullRequestUrl(PR_URL)!,
      method: 'squash',
      authority: { kind: 'grant', grantId: result.grant.id }
    })
    expect(freshOutcome).toMatchObject({
      status: 'blocked',
      reason_code: 'INDEPENDENT_REVIEW_REQUIRED',
      reasons: [expect.stringContaining('unresolved changes')]
    })
    expect(h.db.getMergeGrant(result.grant.id)?.uses).toBe(0)
    expect(h.merges).toHaveLength(0)
  })

  it.each([
    ['policy', { kind: 'policy', level: 'autonomous' }],
    ['held user approval', { kind: 'user_approval', heldId: 'held-review-race' }]
  ] as const)('never lets %s authority override a latest verified CHANGES_REQUIRED', async (_label, authority) => {
    const h = setupWide()
    expect(attestExactHead(h)).toMatchObject({ ok: true })
    expect(attestExactHead(h, { verdict: 'CHANGES_REQUIRED' })).toMatchObject({ ok: true })

    const outcome = await performMerge(h.db, {
      projectId: h.projectId,
      pr: parseGitHubPullRequestUrl(PR_URL)!,
      method: 'squash',
      authority
    })

    expect(outcome).toMatchObject({
      status: 'blocked',
      reason_code: 'INDEPENDENT_REVIEW_REQUIRED',
      reasons: [expect.stringContaining('unresolved changes')],
      authorized_by: authority
    })
    expect(h.merges).toHaveLength(0)
    expect(h.db.listMergeGrants()).toHaveLength(0)
    expect(h.db.listPendingMergeGrantReservations()).toHaveLength(0)
  })

  it.each([
    [{ isDraft: true }, 'draft_changed'],
    [{ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }, 'mergeability_changed']
  ] as const)('invalidates durable readiness when live draft/mergeability changes: %j', async (changed, reason) => {
    const h = setupWide()
    await readPullRequestReadiness(h.db, h.projectId, parseGitHubPullRequestUrl(PR_URL)!)
    h.setPr(changed)
    await readPullRequestReadiness(h.db, h.projectId, parseGitHubPullRequestUrl(PR_URL)!)
    const history = h.db.listPullRequestReadinessSnapshots(h.projectId, 'acme/app', 12)
    expect(history).toHaveLength(2)
    expect(history.find((snapshot) => snapshot.invalidated_at)?.invalidated_reason).toContain(reason)
  })

  it('does not count the PR author approving their own PR as independent review', async () => {
    const h = setupWide()
    const result = wideGrant(h)
    if (!result.ok) throw new Error(result.error)
    h.setPr({ reviewDecision: '', author: { login: 'astra' }, latestReviews: reviewConnection([{ author: { login: 'astra' }, state: 'APPROVED', commit: { oid: SHA } }]) })
    expect(await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).toMatchObject({ status: 'blocked', reason_code: 'INDEPENDENT_REVIEW_REQUIRED' })
    expect(h.merges).toHaveLength(0)
    expect(h.db.getMergeGrant(result.grant.id)?.uses).toBe(0)
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', {}],
    ['blank', { login: '' }],
    ['non-string', { login: 7 }]
  ] as const)('fails closed when PR author data is %s', async (_label, author) => {
    const h = setupWide()
    const result = wideGrant(h)
    if (!result.ok) throw new Error(result.error)
    h.setPr({
      author,
      reviewDecision: 'APPROVED',
      latestReviews: reviewConnection([
        { author: { login: 'author-dev' }, state: 'APPROVED', commit: { oid: SHA } }
      ])
    })
    expect(await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).toMatchObject({
      error: expect.stringContaining('author')
    })
    expect(h.merges).toHaveLength(0)
    expect(h.db.getMergeGrant(result.grant.id)?.uses).toBe(0)
  })

  it('fails closed when the pinned reread disagrees about the PR author', async () => {
    const h = setupWide()
    const result = wideGrant(h)
    if (!result.ok) throw new Error(result.error)
    h.gh.mockResolvedValueOnce(JSON.stringify(prState({ author: { login: 'author-dev' } })))
      .mockResolvedValueOnce(JSON.stringify(prState({ author: { login: 'someone-else' } })))
    expect(await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).toMatchObject({
      error: expect.stringContaining('author')
    })
    expect(h.merges).toHaveLength(0)
    expect(h.db.getMergeGrant(result.grant.id)?.uses).toBe(0)
  })

  it('accepts an independent approval on a branch that requires no reviews', async () => {
    const h = setupWide()
    wideGrant(h)
    h.setPr({ reviewDecision: '', author: { login: 'astra' }, latestReviews: reviewConnection([{ author: { login: 'someone-else' }, state: 'APPROVED', commit: { oid: SHA } }]) })
    expect((await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).status).toBe('merged')
    const query = h.gh.mock.calls.find(([args]) => args[1] === 'graphql')![0].join(' ')
      expect(query).toContain('headRefOid baseRefName baseRefOid author { login }')
      expect(query).toContain('latestReviews(first: 100)')
    expect(query).toContain('commit { oid }')
    expect(query).toContain('pageInfo { hasNextPage }')
  })

  it('rejects an independent approval of an older head even when GitHub reports APPROVED', async () => {
    const h = setupWide()
    const result = wideGrant(h)
    if (!result.ok) throw new Error(result.error)
    h.setPr({
      reviewDecision: 'APPROVED',
      author: { login: 'astra' },
      latestReviews: reviewConnection([{ author: { login: 'someone-else' }, state: 'APPROVED', commit: { oid: 'b'.repeat(40) } }])
    })
    expect(await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).toMatchObject({
      status: 'blocked', reason_code: 'INDEPENDENT_REVIEW_REQUIRED'
    })
    expect(h.merges).toHaveLength(0)
    expect(h.db.getMergeGrant(result.grant.id)?.uses).toBe(0)
  })

  it('fails closed when exact-head review data is truncated', async () => {
    const h = setupWide()
    const result = wideGrant(h)
    if (!result.ok) throw new Error(result.error)
    h.setPr({ latestReviews: reviewConnection([
      { author: { login: 'someone-else' }, state: 'APPROVED', commit: { oid: SHA } }
    ], true) })
    expect(await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).toMatchObject({
      error: expect.stringContaining('incomplete exact-head review data')
    })
    expect(h.merges).toHaveLength(0)
    expect(h.db.getMergeGrant(result.grant.id)?.uses).toBe(0)
  })

  it.each([null, {}, { login: '' }, { login: ' ' }, { login: 42 }])('rejects unknown PR author %j before spending authority', async (author) => {
    const h = setupWide()
    const result = wideGrant(h)
    if (!result.ok) throw new Error(result.error)
    h.setPr({ author })
    expect((await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).status).not.toBe('merged')
    expect(h.merges).toHaveLength(0)
    expect(h.db.getMergeGrant(result.grant.id)?.uses).toBe(0)
    expect(h.db.listPendingMergeGrantReservations(h.projectId)).toHaveLength(0)
  })

  it.each([undefined, null, [], {}, { nodes: [] }, { nodes: [], pageInfo: {} },
    { nodes: [], pageInfo: { hasNextPage: 'false' } }])('rejects missing or malformed review connection %j', async (latestReviews) => {
    const h = setupWide()
    const result = wideGrant(h)
    if (!result.ok) throw new Error(result.error)
    h.setPr({ latestReviews })
    expect((await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).status).not.toBe('merged')
    expect(h.merges).toHaveLength(0)
    expect(h.db.getMergeGrant(result.grant.id)?.uses).toBe(0)
  })

  it.each(['COMMENTED', 'DISMISSED', 'CHANGES_REQUESTED'])('does not treat a current-head %s review as approval', async (state) => {
    const h = setupWide()
    const result = wideGrant(h)
    if (!result.ok) throw new Error(result.error)
    h.setPr({ latestReviews: reviewConnection([{ author: { login: 'reviewer' }, state, commit: { oid: SHA } }]) })
    expect(await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).toMatchObject({ reason_code: 'INDEPENDENT_REVIEW_REQUIRED' })
    expect(h.merges).toHaveLength(0)
    expect(h.db.getMergeGrant(result.grant.id)?.uses).toBe(0)
  })

  it('rereads the approval before reserving authority even when refs have not changed', async () => {
    const h = setupWide()
    const result = wideGrant(h)
    if (!result.ok) throw new Error(result.error)
    h.gh.mockResolvedValueOnce(JSON.stringify(prState())).mockResolvedValueOnce(JSON.stringify(prState()))
      .mockResolvedValueOnce(JSON.stringify(prState())).mockResolvedValueOnce(JSON.stringify(prState({
        latestReviews: reviewConnection([{ author: { login: 'reviewer-dev' }, state: 'DISMISSED', commit: { oid: SHA } }])
      })))
    expect(await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).toMatchObject({ reason_code: 'PR_CHANGED' })
    expect(h.merges).toHaveLength(0)
    expect(h.db.getMergeGrant(result.grant.id)?.uses).toBe(0)
  })

  it.each([
    null, {}, { state: 'UNKNOWN' },
    { author: null, state: 'APPROVED', commit: { oid: SHA } },
    { author: { login: ' ' }, state: 'APPROVED', commit: { oid: SHA } },
    { author: { login: 'other' }, state: ['APPROVED'], commit: { oid: SHA } },
    { author: { login: 'other' }, state: 'APPROVED', commit: null },
    { author: { login: 'other' }, state: 'APPROVED', commit: { oid: 'short' } },
    { author: { login: 'REVIEWER-DEV' }, state: 'DISMISSED', commit: { oid: SHA } }
  ])('rejects malformed or inconsistent review node %j even alongside an approval', async (node) => {
    const h = setupWide()
    const result = wideGrant(h)
    if (!result.ok) throw new Error(result.error)
    h.setPr({ latestReviews: { nodes: [
      { author: { login: 'reviewer-dev' }, state: 'APPROVED', commit: { oid: SHA } }, node
    ], pageInfo: { hasNextPage: false } } })
    expect((await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).status).not.toBe('merged')
    expect(h.merges).toHaveLength(0)
    expect(h.db.getMergeGrant(result.grant.id)?.uses).toBe(0)
    expect(h.db.listPendingMergeGrantReservations(h.projectId)).toHaveLength(0)
  })

  it.each([
    'Merge all open PRs in 21x in 22x when required reviews and checks pass',
    'Merge all open PRs in 21x without review when required reviews and checks pass',
    'Merge all safe PRs in 21x skipping required reviews when required reviews and checks pass'
  ])('refuses a scope slot carrying extra conditions: %s', (text) => {
    expect(checkMergeIntent(text)).toMatchObject({ ok: false, reasonCode: 'PR_SCOPE_UNSUPPORTED' })
  })

  // Reported live against this branch: the command names one project and both
  // gates, but the extra "after resolving its conflicts and" clause is outside
  // the grammar, so it must fail closed and say so specifically.
  it('refuses a numbered command with an extra trailing condition', () => {
    const text = 'Merge PR #156 in 21x after resolving its conflicts and after all required reviews and checks pass.'
    expect(checkMergeIntent(text)).toMatchObject({ ok: false, reasonCode: 'AMBIGUOUS_COMMAND' })
  })

  it('requires the Captain to verify independent review, disposition and stack predecessors', () => {
    const prompt = buildCaptainSystemPrompt()
    expect(prompt).toMatch(/Before each merge verify independent review/)
    expect(prompt).toMatch(/Never merge unsafe, obsolete, duplicate, draft, conflicted or failing PRs/)
    expect(prompt).toMatch(/Stop or skip when a predecessor is missing/)
  })
})
