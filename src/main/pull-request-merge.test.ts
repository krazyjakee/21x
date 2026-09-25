/**
 * The Captain's `merge_pull_request`, end to end through the same paths
 * production uses: the Captain's MCP tool dispatch (callToolForScope → the
 * Captain call handler → pull-request-merge) and the database. `gh` is
 * replaced by a fake that serves `pr view` and records every merge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import type { DatabaseManager } from './database'
import { callToolForScope, setCoordinatorCallHandler, type TaskApiInvoke, type TaskMcpScope } from './mcp-servers/task-management-core'
import {
  configureCaptainGithubTools,
  createCaptainCallHandler,
  setCaptainActionHandler,
  type CaptainActionEvent
} from './captain-github-tools'
import {
  buildMergeCommand,
  clearReportedMergeBlocks,
  evaluatePullRequestGate,
  FORBIDDEN_MERGE_FLAGS,
  readPullRequestReadiness,
  setGhRunner,
  type PullRequestGateState
} from './pull-request-merge'
import { createPullRequestReviewHandoff, recordPullRequestReviewAttestation } from './pr-review-attestations'
import { captainActionReportText } from './commander/report-tools'
import { parseGitHubPullRequestUrl } from '../shared/pr-readiness'
import { captainTools } from './mcp-servers/task-management-tools'

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
  events: CaptainActionEvent[]
  notifyUser: ReturnType<typeof vi.fn>
  setPr: (over: Partial<Record<string, unknown>>) => void
}

function setup(): Harness {
  const { db } = createTestDb()
  const projectId = db.createProject({ name: 'App' })!.id
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
  const events: CaptainActionEvent[] = []
  const notifyUser = vi.fn()
  configureCaptainGithubTools({ db, mergeDb: db, notifyUser, notifyRenderer: vi.fn() })
  setCoordinatorCallHandler(createCaptainCallHandler())
  setCaptainActionHandler((event) => events.push(event))

  return {
    db,
    projectId,
    scope: { parentTaskId: null, taskId: null, artifactTaskId: null, projectId },
    invoke,
    gh,
    merges,
    events,
    notifyUser,
    setPr: (over) => { pr = prState(over) }
  }
}

async function captainCall(h: Harness, tool: string, args: Record<string, unknown>, scope: TaskMcpScope = h.scope): Promise<Record<string, unknown>> {
  const result = await callToolForScope(tool, args, scope, h.invoke)
  return JSON.parse(result.content[0].text) as Record<string, unknown>
}

function journal(h: Harness) {
  return h.db.listProjectStatusJournal(h.projectId, { limit: 20 }).entries
}

function attestExactHead(h: Harness, verdict: 'CLEAN' | 'CHANGES_REQUIRED' = 'CLEAN') {
  const implementationAgent = h.db.createAgent({ name: 'Implementation agent' })!
  const reviewerAgent = h.db.createAgent({ name: 'Independent reviewer' })!
  const implementation = h.db.createTask({ title: 'Implement PR', type: 'coding', project_id: h.projectId, repos: ['acme/app'] })!
  const review = h.db.createTask({ title: 'Review PR', type: 'review', project_id: h.projectId, repos: ['acme/app'] })!
  h.db.updateTask(implementation.id, { agent_id: implementationAgent.id })
  h.db.updateTask(review.id, { agent_id: reviewerAgent.id })
  const handoff = createPullRequestReviewHandoff(h.db, {
    projectId: h.projectId,
    implementationTaskId: implementation.id,
    implementationAgentId: implementationAgent.id,
    reviewTaskId: review.id,
    prUrl: PR_URL,
    headSha: SHA,
    baseSha: 'd'.repeat(40)
  })
  if (!handoff.ok) return handoff
  return recordPullRequestReviewAttestation(h.db, {
    projectId: h.projectId,
    reviewTaskId: review.id,
    reviewerAgentId: reviewerAgent.id,
    implementationTaskId: implementation.id,
    prUrl: PR_URL,
    headSha: SHA,
    baseSha: 'd'.repeat(40),
    verdict,
    summary: 'Exact-head review completed.'
  })
}

beforeEach(() => {
  clearReportedMergeBlocks()
})

afterEach(() => {
  setGhRunner(null)
  setCoordinatorCallHandler(null)
  configureCaptainGithubTools(null)
  setCaptainActionHandler(null)
})

describe('merging a ready pull request', () => {
  it('merges without asking, writes the journal and reports to the Commander', async () => {
    const h = setup()
    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect(out).toMatchObject({ status: 'merged', pr_url: PR_URL, head_sha: SHA, method: 'squash' })
    expect(h.merges).toHaveLength(1)
    expect(journal(h)[0].summary).toMatch(/Merged https:\/\/github.com\/acme\/app\/pull\/12 "Add login"/)
    expect(h.events).toEqual([expect.objectContaining({ projectId: h.projectId, tool: 'merge_pull_request', outcome: 'performed' })])
    expect(captainActionReportText(h.events[0])).toMatch(/^Captain action: Merged /)
    expect(h.notifyUser).toHaveBeenCalledWith('Captain of App merged a PR', expect.stringContaining(PR_URL))
  })

  it('offers only the merge tool: no grant tools remain', () => {
    const names = captainTools.map((tool) => tool.name)
    expect(names).toContain('merge_pull_request')
    expect(names).not.toContain('grant_merge_authority')
    expect(names).not.toContain('list_merge_grants')
  })

  it('refuses a PR outside the project\'s repositories outright', async () => {
    const h = setup()
    const out = await captainCall(h, 'merge_pull_request', { pr_url: 'https://github.com/evil/app/pull/1' })
    expect(out.error).toMatch(/not one of this project/)
    expect(h.gh).not.toHaveBeenCalled()
  })

  it('only the Captain may call the merge tool; task agents are refused', async () => {
    const h = setup()
    const task = h.db.createTask({ title: 'Work', project_id: h.projectId })!
    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL }, { parentTaskId: null, taskId: task.id, artifactTaskId: task.id, projectId: h.projectId })
    expect(out.error).toMatch(/only the project's Captain/)
    expect(h.gh).not.toHaveBeenCalled()
  })

  it('without the handler (a raw Task API call) there is no merge route at all', async () => {
    const h = setup()
    setCoordinatorCallHandler(null)
    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect(out.error).toBe('Unknown route')
    expect(h.merges).toHaveLength(0)
  })
})

describe('failing checks or branch protection block the merge', () => {
  it('blocks on a failing check', async () => {
    const h = setup()
    h.setPr({ mergeStateStatus: 'UNSTABLE', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] })
    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect(out.status).toBe('blocked')
    expect(String((out.reasons as string[]).join(' '))).toMatch(/failing checks: test/)
    expect(h.merges).toHaveLength(0)
  })

  it('waits while checks are still running', async () => {
    const h = setup()
    h.setPr({ mergeStateStatus: 'BLOCKED', statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS' }] })
    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect(out).toMatchObject({ status: 'blocked', retry_later: true, needs_external_approval: false })
    expect(h.merges).toHaveLength(0)
  })

  it('surfaces a required review (CODEOWNERS) as an external approval, once, and never merges', async () => {
    const h = setup()
    h.setPr({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' })
    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect(out).toMatchObject({ status: 'blocked', needs_external_approval: true })
    await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    const needsUser = h.events.filter((e) => e.outcome === 'needs_user')
    expect(needsUser).toHaveLength(1)
    expect(captainActionReportText(needsUser[0])).toMatch(/Blocked on an external approval/)
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

  it('blocks a PR whose latest verified 21x review asks for changes', async () => {
    const h = setup()
    expect(attestExactHead(h, 'CHANGES_REQUIRED').ok).toBe(true)
    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect(out).toMatchObject({ status: 'blocked', reason_code: 'REVIEW_CHANGES_REQUIRED' })
    expect(h.merges).toHaveLength(0)
  })

  it('merges a PR with no GitHub approval: independent review is not a merge condition', async () => {
    const h = setup()
    h.setPr({ reviewDecision: '', latestReviews: reviewConnection([]) })
    expect(await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).toMatchObject({ status: 'merged' })
    expect(h.merges).toHaveLength(1)
  })

  it('rejects inconsistent GitHub ref reads before merging', async () => {
    const h = setup()
    h.gh.mockResolvedValueOnce(JSON.stringify(prState()))
      .mockResolvedValueOnce(JSON.stringify(prState({ headRefOid: 'b'.repeat(40) })))
    expect(await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).toMatchObject({ error: expect.stringContaining('changed PR head/base') })
    expect(h.merges).toHaveLength(0)
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['blank', { login: '' }]
  ] as const)('fails closed when PR author data is %s', async (_label, author) => {
    const h = setup()
    h.setPr({ author })
    expect(await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).toMatchObject({ error: expect.stringContaining('author') })
    expect(h.merges).toHaveLength(0)
  })
})

describe('no admin bypass', () => {
  it('the merge command is pinned to the checked head and carries no bypass flag', async () => {
    const h = setup()
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

  it('a GitHub refusal is an error and nothing is journalled', async () => {
    const h = setup()
    h.gh.mockImplementation(async (args: string[]) => {
      if (args[1] === 'view' || args[1] === 'graphql') return JSON.stringify(prState())
      throw Object.assign(new Error('Head branch was modified'), { stderr: 'gh: Head branch was modified (HTTP 409)' })
    })
    const out = await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })
    expect(out.error).toMatch(/GitHub refused/)
    expect(journal(h)).toHaveLength(0)
    expect(h.events).toHaveLength(0)
  })

  it('an ambiguous transport failure is reported as unknown, not as a refusal', async () => {
    const h = setup()
    h.gh.mockImplementation(async (args: string[]) => {
      if (args[1] === 'view' || args[1] === 'graphql') return JSON.stringify(prState())
      throw Object.assign(new Error('socket hang up'), { stderr: 'connection reset' })
    })
    expect(await captainCall(h, 'merge_pull_request', { pr_url: PR_URL })).toMatchObject({ status: 'unknown' })
  })
})

describe('readiness snapshots', () => {
  it('invalidates an exact-head attestation and its readiness revision when the base advances', async () => {
    const h = setup()
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
})
