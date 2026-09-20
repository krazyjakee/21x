/**
 * Delegated GitHub issue writes, end to end through the paths production uses:
 * the Captain's MCP tool dispatch (callToolForScope → escalation gate →
 * issue-write-gate → issue-writes), the Commander's `ask_captain` relay, and
 * the database. `gh` is replaced by a fake that records every request and can
 * be made to time out, refuse or vanish mid-call.
 *
 * The fixtures are the two voice tickets that could not be filed before this
 * existed: the Commander voice-input task (ysreze49jdacahwa19ez3r33) and the
 * TTS cost-control task (q0gm69mm4zxgkcx0o6mzdl87). One human instruction has
 * to produce exactly two issues, once, and survive being retried.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeAgent, makeTask } from '../../test/helpers/task-fixtures'
import type { DatabaseManager } from './database'
import { callToolForScope, setCoordinatorCallGate, type TaskApiInvoke, type TaskMcpScope } from './mcp-servers/task-management-core'
import {
  approveHeldAction,
  clearHeldActions,
  configureEscalation,
  createCoordinatorEscalationGate,
  listHeldActions,
  rejectHeldAction,
  setCommanderEscalationHandler,
  type EscalationEvent
} from './escalation'
import {
  clearDelegatedAuthorizations,
  computeIdempotencyKey,
  confirmedIssueWriteFailure,
  hashPayload,
  ORIGIN_WINDOW_MS,
  recordDelegatedAuthorization,
  reconcileIssueWrites,
  resolveIssueWriteOrigin,
  setIssueGhRunner,
  setIssueWriteOriginResolver
} from './issue-writes'
import { clearUserTypedProjectMessages, recordUserTypedProjectMessage } from './merge-grants'
import { findIdempotencyMarker } from '../shared/issue-actions'
import { buildCaptainSystemPrompt } from './prompts/captain'
import { listToolsForScope } from './mcp-servers/task-management-core'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  Notification: class { show = vi.fn(); on = vi.fn(); static isSupported = vi.fn(() => false) },
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn(), isStarted: vi.fn(() => false) }
}))

// The two blocked voice tasks, used as fixtures.
const VOICE_INPUT_TASK = 'ysreze49jdacahwa19ez3r33'
const VOICE_TTS_TASK = 'q0gm69mm4zxgkcx0o6mzdl87'

interface GhRequest { args: string[] }

interface Harness {
  db: DatabaseManager
  projectId: string
  otherProjectId: string
  taskIds: Record<string, string>
  scope: TaskMcpScope
  taskAgentScope: TaskMcpScope
  invoke: ReturnType<typeof vi.fn<TaskApiInvoke>>
  gh: ReturnType<typeof vi.fn>
  requests: GhRequest[]
  created: Array<{ repo: string; number: number; title: string; body: string }>
  events: EscalationEvent[]
  notifyUser: ReturnType<typeof vi.fn>
  /** Make the next N gh calls behave in a particular way. */
  failNext: (behaviour: 'timeout' | 'refused' | null) => void
}

function setup(options: { issuePolicy?: string; repos?: Array<[string, string]> } = {}): Harness {
  const { db } = createTestDb()
  const settings: Record<string, unknown> = {}
  if (options.issuePolicy) settings.escalation = { issue_write: options.issuePolicy }
  const projectId = db.createProject({ name: 'Voice', settings })!.id
  const otherProjectId = db.createProject({ name: 'Other' })!.id
  for (const [org, name] of options.repos ?? [['krazyjakee', '21x']]) {
    db.addProjectRepo(projectId, { provider: 'github', org, name })
  }
  db.addProjectRepo(otherProjectId, { provider: 'github', org: 'krazyjakee', name: 'other' })
  const agentId = db.createAgent(makeAgent({ name: 'Worker' }))!.id

  const taskIds: Record<string, string> = {}
  for (const [key, title] of [[VOICE_INPUT_TASK, 'Commander voice input reliability'], [VOICE_TTS_TASK, 'Commander TTS reliability and cost controls']] as const) {
    const task = db.createTask(makeTask({ title, project_id: projectId }))!
    db.updateTask(task.id, { agent_id: agentId })
    taskIds[key] = task.id
  }
  const foreign = db.createTask(makeTask({ title: 'Someone else\'s work', project_id: otherProjectId }))!
  taskIds.foreign = foreign.id

  const requests: GhRequest[] = []
  const created: Array<{ repo: string; number: number; title: string; body: string }> = []
  let nextNumber = 200
  let behaviour: 'timeout' | 'refused' | null = null

  const gh = vi.fn(async (args: string[]) => {
    requests.push({ args })
    const path = args[args.indexOf('-X') + 2] ?? ''
    const method = args[args.indexOf('-X') + 1]

    if (path === '/search/issues') {
      const key = /21x-issue-write:([A-Za-z0-9_-]+)/.exec(args.find((a) => a.startsWith('q=')) ?? '')?.[1]
      const items = created
        .filter((issue) => findIdempotencyMarker(issue.body) === key)
        .map((issue) => ({ number: issue.number, html_url: `https://github.com/${issue.repo}/issues/${issue.number}`, body: issue.body }))
      return JSON.stringify({ items })
    }

    if (behaviour === 'timeout') { behaviour = null; throw new Error('spawn gh ETIMEDOUT') }
    if (behaviour === 'refused') { behaviour = null; throw new Error('gh: Validation Failed (HTTP 422)') }

    if (method === 'POST' && /\/repos\/.+\/issues$/.test(path)) {
      const repo = /\/repos\/(.+)\/issues$/.exec(path)![1]
      const title = args[args.indexOf('-f', args.indexOf(path)) + 1]?.replace(/^title=/, '') ?? ''
      const body = args.find((a) => a.startsWith('body='))?.slice(5) ?? ''
      const number = nextNumber++
      created.push({ repo, number, title, body })
      return JSON.stringify({ number, html_url: `https://github.com/${repo}/issues/${number}`, title, state: 'open' })
    }
    if (method === 'PATCH') {
      const [, repo, number] = /\/repos\/(.+)\/issues\/(\d+)$/.exec(path)!
      const title = args.find((a) => a.startsWith('title='))?.slice(6)
      const body = args.find((a) => a.startsWith('body='))?.slice(5)
      const existing = created.find((issue) => issue.repo === repo && issue.number === Number(number))
      if (existing) {
        if (title !== undefined) existing.title = title
        if (body !== undefined) existing.body = body
      }
      return JSON.stringify({ number: Number(number), html_url: `https://github.com/${repo}/issues/${number}`, title: title ?? existing?.title, state: 'open' })
    }
    if (method === 'GET') {
      const [, repo, number] = /\/repos\/(.+)\/issues\/(\d+)$/.exec(path)!
      const existing = created.find((issue) => issue.repo === repo && issue.number === Number(number))
      return JSON.stringify({ number: Number(number), title: existing?.title ?? '', body: existing?.body ?? '', state: 'open' })
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`)
  })
  setIssueGhRunner(gh)

  const invoke = vi.fn<TaskApiInvoke>(async (route, params) => {
    if (route === '/get_task') return db.getTask(String(params.task_id)) ?? { error: 'Task not found' }
    return { error: 'Unknown route' }
  })

  const events: EscalationEvent[] = []
  const notifyUser = vi.fn()
  configureEscalation({ db, mergeDb: db, issueDb: db, notifyUser, notifyRenderer: vi.fn(), tellCaptain: vi.fn(async () => undefined) })
  setCoordinatorCallGate(createCoordinatorEscalationGate())
  setCommanderEscalationHandler((event) => events.push(event))

  return {
    db,
    projectId,
    otherProjectId,
    taskIds,
    scope: { parentTaskId: null, taskId: null, artifactTaskId: null, projectId },
    taskAgentScope: { parentTaskId: null, taskId: taskIds[VOICE_INPUT_TASK], artifactTaskId: taskIds[VOICE_INPUT_TASK], projectId },
    invoke,
    gh,
    requests,
    created,
    events,
    notifyUser,
    failNext: (next) => { behaviour = next }
  }
}

async function captainCall(h: Harness, tool: string, args: Record<string, unknown>, scope = h.scope): Promise<Record<string, unknown>> {
  const result = await callToolForScope(tool, args, scope, h.invoke)
  return JSON.parse(result.content[0].text) as Record<string, unknown>
}

/** The user typed something in this project's chat: the platform recorded it. */
function userAsked(h: Harness, text = 'Please open GitHub issues for the two voice reliability tickets.'): void {
  recordUserTypedProjectMessage(h.projectId, 'captain-task', text)
}

const creates = (h: Harness): GhRequest[] => h.requests.filter((r) => r.args.includes('POST'))

beforeEach(() => {
  clearHeldActions()
  clearUserTypedProjectMessages()
  clearDelegatedAuthorizations()
  setIssueWriteOriginResolver(null)
})

afterEach(() => {
  setIssueGhRunner(null)
  setCoordinatorCallGate(null)
  configureEscalation(null)
  setCommanderEscalationHandler(null)
  setIssueWriteOriginResolver(null)
  clearDelegatedAuthorizations()
  clearUserTypedProjectMessages()
  vi.useRealTimers()
})

// ── The policy distinction ────────────────────────────────────

describe('a delegated issue write needs a human instruction, not a grant', () => {
  it('files the issue from a message the user typed in the project chat', async () => {
    const h = setup()
    userAsked(h)

    const result = await captainCall(h, 'create_github_issue', {
      repo: 'krazyjakee/21x',
      title: 'Commander voice input reliability',
      body: 'Race-safe capture, pre-roll, speech-aware VAD.',
      labels: ['voice', 'reliability'],
      task_id: h.taskIds[VOICE_INPUT_TASK]
    })

    expect(result).toMatchObject({ status: 'created', repo: 'krazyjakee/21x', action: 'create_issue' })
    expect(result.issue_url).toBe('https://github.com/krazyjakee/21x/issues/200')
    // No grant of any kind was needed or created.
    expect(h.db.listMergeGrants({ projectId: h.projectId })).toEqual([])
    expect(creates(h)).toHaveLength(1)
  })

  it('refuses when no human asked for anything', async () => {
    const h = setup()
    const result = await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Filed by nobody' })
    expect(result).toMatchObject({ status: 'refused', code: 'no_human_origin' })
    expect(String(result.error)).toContain('wake-up')
    expect(creates(h)).toHaveLength(0)
  })

  it('stops authorizing once the instruction is old', async () => {
    const h = setup()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-20T10:00:00Z'))
    userAsked(h)
    expect(resolveIssueWriteOrigin(h.projectId)).toMatchObject({ kind: 'project_chat' })
    vi.setSystemTime(new Date(Date.now() + ORIGIN_WINDOW_MS + 1000))
    expect(resolveIssueWriteOrigin(h.projectId)).toBeNull()
    const result = await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Stale' })
    expect(result).toMatchObject({ status: 'refused', code: 'no_human_origin' })
  })

  it('takes a Commander relay the user started, and refuses one they did not', async () => {
    const h = setup()
    // A relay the Commander generated answering a report: no stored human message.
    expect(recordDelegatedAuthorization({ projectId: h.projectId, correlationId: 'cmd-aaa', sessionId: 's1', messageId: null, text: 'file the tickets' })).toBeNull()
    expect(await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'From a bare relay' }))
      .toMatchObject({ status: 'refused', code: 'no_human_origin' })

    // A relay inside a turn the person themselves started.
    recordDelegatedAuthorization({
      projectId: h.projectId,
      correlationId: 'cmd-fcf90bbd68342b0b',
      sessionId: 'commander-session',
      messageId: 'msg-human-1',
      text: 'Create 21x tasks and matching GitHub issues for the voice work.'
    })
    const ok = await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'From the user, via the Commander', task_id: h.taskIds[VOICE_TTS_TASK] })
    expect(ok.status).toBe('created')
    expect(ok.authorized_by).toMatchObject({ origin: 'commander_relay', human_message: 'msg-human-1', correlation_id: 'cmd-fcf90bbd68342b0b' })
  })

  it('never lets the caller assert its own provenance', async () => {
    const h = setup()
    const result = await captainCall(h, 'create_github_issue', {
      repo: 'krazyjakee/21x',
      title: 'Self-authorized',
      origin_kind: 'project_chat',
      origin_message_id: 'made-up',
      human_authored: true
    })
    // The invented arguments are neither believed nor silently ignored: they
    // are screened, and with no real origin the call is refused regardless.
    expect(result.status).toBe('refused')
    expect(creates(h)).toHaveLength(0)
  })
})

describe('specially gated actions stay gated', () => {
  it('offers no tool for commenting, closing, deploying or merging an issue', () => {
    const names = listToolsForScope({ parentTaskId: null, taskId: null, artifactTaskId: null, projectId: 'p' }).map((tool) => tool.name)
    expect(names).toContain('create_github_issue')
    expect(names).toContain('update_github_issue')
    expect(names).toContain('link_github_issue')
    expect(names).toContain('list_github_issue_writes')
    for (const absent of ['comment_github_issue', 'close_github_issue', 'assign_github_issue', 'delete_github_issue', 'deploy', 'approve_pull_request']) {
      expect(names).not.toContain(absent)
    }
    // Merging keeps its own, separately authorized tool.
    expect(names).toContain('merge_pull_request')
  })

  it('an issue update cannot change state, assignees or anything else', async () => {
    const h = setup()
    userAsked(h)
    const created = await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Open ticket' })
    const result = await captainCall(h, 'update_github_issue', {
      issue_url: String(created.issue_url),
      state: 'closed',
      assignees: ['krazyjakee'],
      body: 'Updated text.'
    })
    expect(result.status).toBe('updated')
    const patch = h.requests.find((r) => r.args.includes('PATCH'))!
    expect(patch.args.join(' ')).not.toContain('state=')
    expect(patch.args.join(' ')).not.toContain('assignees')
  })

  it('refuses an argument that would change 21x\'s credentials or host', async () => {
    const h = setup()
    userAsked(h)
    for (const escalation of [{ token: 'ghp_x' }, { gh_host: 'evil.example' }, { as_user: 'someone' }, { admin: true }]) {
      const result = await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Escalate', ...escalation })
      expect(result).toMatchObject({ status: 'refused', code: 'credential_escalation' })
    }
    expect(creates(h)).toHaveLength(0)
  })

  it('refuses a body carrying a credential, or an @mention', async () => {
    const h = setup()
    userAsked(h)
    expect(await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Leak', body: 'token ghp_0123456789abcdefghijABCDEFGHIJ0123' }))
      .toMatchObject({ status: 'refused', code: 'credential_escalation' })
    expect(await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Ping', body: 'cc @krazyjakee' }))
      .toMatchObject({ status: 'refused', code: 'payload_rejected' })
    expect(creates(h)).toHaveLength(0)
  })
})

describe('scope: the project\'s own repositories and tasks only', () => {
  it('refuses a repository that is not configured for the project', async () => {
    const h = setup()
    userAsked(h)
    const result = await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/other', title: 'Wrong repo' })
    expect(result).toMatchObject({ status: 'refused', code: 'repo_not_in_project' })
    expect(String(result.error)).toContain('krazyjakee/21x')
    expect(creates(h)).toHaveLength(0)
  })

  it('refuses a task in another project before it ever reaches the gate', async () => {
    const h = setup()
    userAsked(h)
    const result = await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Cross project', task_id: h.taskIds.foreign })
    // The project-membership check in the MCP dispatcher answers first.
    expect(String(result.error)).toContain('Access denied')
    expect(creates(h)).toHaveLength(0)
  })

  it('refuses an issue URL from a repository outside the project', async () => {
    const h = setup()
    userAsked(h)
    expect(await captainCall(h, 'update_github_issue', { issue_url: 'https://github.com/someone/else/issues/1', body: 'x' }))
      .toMatchObject({ status: 'refused', code: 'repo_not_in_project' })
    expect(await captainCall(h, 'link_github_issue', { issue_url: 'https://github.com/someone/else/issues/1', task_id: h.taskIds[VOICE_INPUT_TASK] }))
      .toMatchObject({ status: 'refused', code: 'repo_not_in_project' })
  })

  it('refuses a project with no configured GitHub repository', async () => {
    const h = setup({ repos: [] })
    userAsked(h)
    expect(await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Nowhere' }))
      .toMatchObject({ status: 'refused', code: 'repo_not_in_project' })
  })

  it('does not offer the tools to a task agent in the same project', async () => {
    const h = setup()
    userAsked(h)
    const result = await callToolForScope('create_github_issue', { repo: 'krazyjakee/21x', title: 'By a task agent' }, h.taskAgentScope, h.invoke)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("only the project's Captain")
    expect(creates(h)).toHaveLength(0)
  })
})

// ── Idempotency ───────────────────────────────────────────────

describe('idempotency', () => {
  it('files one issue however many times the same call is retried', async () => {
    const h = setup()
    userAsked(h)
    const args = { repo: 'krazyjakee/21x', title: 'Commander voice input reliability', body: 'Scope.', task_id: h.taskIds[VOICE_INPUT_TASK] }

    const first = await captainCall(h, 'create_github_issue', args)
    const second = await captainCall(h, 'create_github_issue', args)
    const third = await captainCall(h, 'create_github_issue', args)

    expect(first.status).toBe('created')
    expect(second).toMatchObject({ status: 'already_done', issue_url: first.issue_url })
    expect(third).toMatchObject({ status: 'already_done', issue_url: first.issue_url })
    expect(creates(h)).toHaveLength(1)
    expect(h.created).toHaveLength(1)
    expect(h.db.listIssueWrites({ projectId: h.projectId })).toHaveLength(1)
  })

  it('carries the key into the issue body, so GitHub itself holds the evidence', async () => {
    const h = setup()
    userAsked(h)
    const result = await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Marked', body: 'Text.', task_id: h.taskIds[VOICE_TTS_TASK] })
    expect(findIdempotencyMarker(h.created[0].body)).toBe(result.idempotency_key)
    expect(h.created[0].body).toContain('Text.')
  })

  it('derives the same key across a restart, so a retry cannot duplicate', async () => {
    const h = setup()
    userAsked(h)
    const args = { repo: 'krazyjakee/21x', title: 'Survives a restart', body: 'Scope.', task_id: h.taskIds[VOICE_INPUT_TASK] }
    const first = await captainCall(h, 'create_github_issue', args)
    expect(first.status).toBe('created')

    // Restart: the process is gone, the in-memory origin registry with it, and
    // the database is reopened from its own bytes.
    const bytes = (h.db as unknown as { db: InstanceType<typeof Database> }).db.serialize()
    clearUserTypedProjectMessages()
    clearDelegatedAuthorizations()
    const { db: reopened } = createTestDb()
    ;(reopened as unknown as { db: InstanceType<typeof Database> }).db.close()
    ;(reopened as unknown as { db: InstanceType<typeof Database> }).db = new Database(bytes)
    configureEscalation({ db: reopened, mergeDb: reopened, issueDb: reopened, notifyUser: vi.fn(), notifyRenderer: vi.fn(), tellCaptain: vi.fn(async () => undefined) })
    // The user asks again after the restart: a different message, same ticket.
    recordUserTypedProjectMessage(h.projectId, 'captain-task', 'Did the voice issues get filed? Please make sure they exist.')

    const retry = await captainCall({ ...h, db: reopened }, 'create_github_issue', args)
    expect(retry).toMatchObject({ status: 'already_done', issue_url: first.issue_url })
    expect(creates(h)).toHaveLength(1)
    reopened.close()
  })

  it('lets the user deliberately ask for a second issue with a distinct key', async () => {
    const h = setup()
    userAsked(h)
    const args = { repo: 'krazyjakee/21x', title: 'Same title', task_id: h.taskIds[VOICE_INPUT_TASK] }
    const first = await captainCall(h, 'create_github_issue', args)
    const second = await captainCall(h, 'create_github_issue', { ...args, idempotency_key: 'second-on-purpose' })
    expect(first.status).toBe('created')
    expect(second.status).toBe('created')
    expect(first.issue_url).not.toBe(second.issue_url)
    expect(creates(h)).toHaveLength(2)
  })

  it('computes a key from durable inputs only, never from who authorized it', () => {
    const base = { projectId: 'p', repo: 'o/r', action: 'create_issue' as const, taskId: 't', payloadHash: hashPayload({ title: 'a' }) }
    expect(computeIdempotencyKey(base)).toBe(computeIdempotencyKey({ ...base }))
    expect(computeIdempotencyKey(base)).not.toBe(computeIdempotencyKey({ ...base, taskId: 'other' }))
    expect(computeIdempotencyKey(base)).not.toBe(computeIdempotencyKey({ ...base, repo: 'o/other' }))
    expect(computeIdempotencyKey(base)).not.toBe(computeIdempotencyKey({ ...base, payloadHash: hashPayload({ title: 'b' }) }))
    expect(computeIdempotencyKey({ ...base, clientKey: 'k' })).not.toBe(computeIdempotencyKey(base))
  })
})

// ── Failure, timeout and reconciliation ───────────────────────

describe('an interrupted write is reconciled, never repeated', () => {
  it('leaves a timed-out create unresolved and refuses to retry it blindly', async () => {
    const h = setup()
    userAsked(h)
    h.failNext('timeout')
    const args = { repo: 'krazyjakee/21x', title: 'Timed out', task_id: h.taskIds[VOICE_INPUT_TASK] }

    const first = await captainCall(h, 'create_github_issue', args)
    expect(first).toMatchObject({ status: 'unresolved' })
    expect(String(first.error)).toContain('may have landed')

    // The retry asks GitHub instead of writing: nothing carries the key, so the
    // claim is released and the issue is filed exactly once overall.
    const retry = await captainCall(h, 'create_github_issue', args)
    expect(retry.status).toBe('created')
    expect(h.created).toHaveLength(1)
  })

  it('recovers an external success the app never saw the answer to', async () => {
    const h = setup()
    userAsked(h)
    const args = { repo: 'krazyjakee/21x', title: 'Landed anyway', body: 'Scope.', task_id: h.taskIds[VOICE_TTS_TASK] }

    // GitHub takes the write, then the connection dies before 21x reads it.
    h.gh.mockImplementationOnce(async (callArgs: string[]) => {
      const body = callArgs.find((a) => a.startsWith('body='))!.slice(5)
      h.created.push({ repo: 'krazyjakee/21x', number: 321, title: 'Landed anyway', body })
      h.requests.push({ args: callArgs })
      throw new Error('socket hang up')
    })

    const interrupted = await captainCall(h, 'create_github_issue', args)
    expect(interrupted.status).toBe('unresolved')

    // Reading the ledger reconciles: the marker proves the issue exists.
    const ledger = await captainCall(h, 'list_github_issue_writes', {})
    const entries = ledger.entries as Array<Record<string, unknown>>
    expect(entries[0]).toMatchObject({
      status: 'succeeded',
      external_url: 'https://github.com/krazyjakee/21x/issues/321',
      external_result: 'recovered by idempotency marker'
    })

    // And a retry now says so, without writing again.
    const retry = await captainCall(h, 'create_github_issue', args)
    expect(retry).toMatchObject({ status: 'already_done', issue_url: 'https://github.com/krazyjakee/21x/issues/321' })
    expect(h.created).toHaveLength(1)
  })

  it('reconciles the same interrupted write repeatedly without double-counting it', async () => {
    const h = setup()
    userAsked(h)
    h.gh.mockImplementationOnce(async (callArgs: string[]) => {
      h.created.push({ repo: 'krazyjakee/21x', number: 999, title: 'Once', body: callArgs.find((a) => a.startsWith('body='))!.slice(5) })
      throw new Error('ECONNRESET')
    })
    await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Once', task_id: h.taskIds[VOICE_INPUT_TASK] })

    expect(await reconcileIssueWrites(h.db, h.projectId)).toBe(1)
    expect(await reconcileIssueWrites(h.db, h.projectId)).toBe(0)
    expect(await reconcileIssueWrites(h.db, h.projectId)).toBe(0)
    expect(h.db.listIssueWrites({ projectId: h.projectId }).filter((row) => row.status === 'succeeded')).toHaveLength(1)
  })

  it('treats a refusal GitHub certainly made as a failure a retry may follow', async () => {
    const h = setup()
    userAsked(h)
    h.failNext('refused')
    const args = { repo: 'krazyjakee/21x', title: 'Refused once', task_id: h.taskIds[VOICE_INPUT_TASK] }
    const failed = await captainCall(h, 'create_github_issue', args)
    expect(failed).toMatchObject({ status: 'failed' })
    expect(String(failed.error)).toContain('422')

    const retry = await captainCall(h, 'create_github_issue', args)
    expect(retry.status).toBe('created')
    // One ledger row, two attempts: the audit shows the history, not a second write.
    const rows = h.db.listIssueWrites({ projectId: h.projectId })
    expect(rows).toHaveLength(1)
    expect(rows[0].attempts).toBe(2)
    expect(rows[0].status).toBe('succeeded')
  })

  it('knows a definite refusal from an unknown outcome', () => {
    expect(confirmedIssueWriteFailure(new Error('gh: Validation Failed (HTTP 422)'))).toBe(true)
    expect(confirmedIssueWriteFailure(new Error('gh: Not Found (HTTP 404)'))).toBe(true)
    expect(confirmedIssueWriteFailure(new Error('spawn gh ENOENT'))).toBe(true)
    expect(confirmedIssueWriteFailure(new Error('spawn gh ETIMEDOUT'))).toBe(false)
    expect(confirmedIssueWriteFailure(new Error('socket hang up'))).toBe(false)
    expect(confirmedIssueWriteFailure(new Error('killed'))).toBe(false)
    expect(confirmedIssueWriteFailure(new Error('gh: Server Error (HTTP 502)'))).toBe(false)
  })
})

// ── The ledger ────────────────────────────────────────────────

describe('the audit ledger', () => {
  it('records the whole chain: who authorized it, who carried it out, and what GitHub said', async () => {
    const h = setup()
    recordDelegatedAuthorization({
      projectId: h.projectId,
      correlationId: 'cmd-6f41cf85aa4e9f1a',
      sessionId: 'commander-session-7',
      messageId: 'msg-human-42',
      text: 'Open GitHub issues for the two voice reliability tasks, please.'
    })
    const before = new Date().toISOString()
    const result = await captainCall(h, 'create_github_issue', {
      repo: 'krazyjakee/21x',
      title: 'Commander TTS reliability and ElevenLabs cost controls',
      body: 'Audibility handshake, budgets, epochs.',
      task_id: h.taskIds[VOICE_TTS_TASK]
    })
    expect(result.status).toBe('created')

    const [row] = h.db.listIssueWrites({ projectId: h.projectId })
    const captain = h.db.getCoordinatorTask(h.projectId)!
    expect(row).toMatchObject({
      project_id: h.projectId,
      captain_task_id: captain.id,
      task_id: h.taskIds[VOICE_TTS_TASK],
      repo: 'krazyjakee/21x',
      action: 'create_issue',
      origin_kind: 'commander_relay',
      origin_message_id: 'msg-human-42',
      origin_session_id: 'commander-session-7',
      correlation_id: 'cmd-6f41cf85aa4e9f1a',
      status: 'succeeded',
      external_url: 'https://github.com/krazyjakee/21x/issues/200',
      external_number: 200,
      attempts: 1
    })
    expect(row.payload_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.origin_text_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.origin_excerpt).toContain('Open GitHub issues')
    expect(row.external_result).toContain('"number":200')
    expect(row.created_at >= before).toBe(true)
    expect(row.settled_at).not.toBeNull()
    expect(row.error).toBeNull()
  })

  it('never copies the user\'s words to GitHub, only their hash into the ledger', async () => {
    const h = setup()
    const secretish = 'Open issues for the voice work; the staging password is hunter2.'
    recordUserTypedProjectMessage(h.projectId, 'captain-task', secretish)
    await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Voice work', body: 'Scope only.' })
    expect(h.created[0].body).not.toContain('hunter2')
    const [row] = h.db.listIssueWrites({ projectId: h.projectId })
    expect(row.origin_text_hash).not.toContain('hunter2')
  })

  it('shows the ledger through the Captain\'s tool, scoped to the project', async () => {
    const h = setup()
    userAsked(h)
    await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'One', task_id: h.taskIds[VOICE_INPUT_TASK] })
    await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Two', task_id: h.taskIds[VOICE_TTS_TASK] })

    const all = await captainCall(h, 'list_github_issue_writes', {})
    expect(all.total).toBe(2)
    const scoped = await captainCall(h, 'list_github_issue_writes', { task_id: h.taskIds[VOICE_INPUT_TASK] })
    expect(scoped.total).toBe(1)
    expect(String((scoped.entries as Array<Record<string, unknown>>)[0].summary)).toContain('create an issue in krazyjakee/21x')
  })

  it('writes the project journal so the user can read what was filed and why', async () => {
    const h = setup()
    userAsked(h)
    await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Journalled', task_id: h.taskIds[VOICE_INPUT_TASK] })
    const { entries } = h.db.listProjectStatusJournal(h.projectId, { limit: 5 })
    expect(entries[0].summary).toContain('Filed https://github.com/krazyjakee/21x/issues/200')
    expect(entries[0].decisions.join(' ')).toContain('authorized by the user')
  })
})

// ── The escalation policy on top ──────────────────────────────

describe('the project\'s issue_write level', () => {
  it('reports the write to the Commander by default', async () => {
    const h = setup()
    userAsked(h)
    await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Reported', task_id: h.taskIds[VOICE_INPUT_TASK] })
    const reported = h.events.filter((event) => event.action === 'issue_write' && event.outcome === 'performed')
    expect(reported.length).toBeGreaterThanOrEqual(1)
    expect(reported.some((event) => event.summary.includes('https://github.com/krazyjakee/21x/issues/200'))).toBe(true)
  })

  it('stays silent under autonomous', async () => {
    const h = setup({ issuePolicy: 'autonomous' })
    userAsked(h)
    await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Quiet', task_id: h.taskIds[VOICE_INPUT_TASK] })
    expect(h.events.filter((event) => event.action === 'issue_write' && event.outcome === 'performed')).toHaveLength(0)
    expect(h.created).toHaveLength(1)
  })

  it('holds the write under ask_user, and files it once on approval', async () => {
    const h = setup({ issuePolicy: 'ask_user' })
    userAsked(h)
    const held = await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Needs a nod', task_id: h.taskIds[VOICE_INPUT_TASK] })
    expect(held).toMatchObject({ status: 'held', action: 'issue_write' })
    expect(creates(h)).toHaveLength(0)
    expect(listHeldActions(h.projectId)[0].summary).toContain('file a GitHub issue "Needs a nod"')

    const approved = await approveHeldAction(String(held.id))
    expect(approved.ok).toBe(true)
    expect((approved.result as Record<string, unknown>).status).toBe('created')
    expect(creates(h)).toHaveLength(1)
  })

  it('rejects instead of writing, and never asks about a call that would be refused anyway', async () => {
    const h = setup({ issuePolicy: 'ask_user' })
    userAsked(h)
    const held = await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Not this one', task_id: h.taskIds[VOICE_INPUT_TASK] })
    expect(rejectHeldAction(String(held.id), 'Not yet.')).toBe(true)
    expect(creates(h)).toHaveLength(0)
    expect(h.db.listIssueWrites({ projectId: h.projectId })).toHaveLength(0)

    // A refusal comes straight back rather than becoming a held call.
    const refused = await captainCall(h, 'create_github_issue', { repo: 'someone/else', title: 'Bad repo' })
    expect(refused).toMatchObject({ status: 'refused', code: 'repo_not_in_project' })
    expect(listHeldActions(h.projectId)).toHaveLength(0)
  })
})

// ── Linking, updating and the fixtures ────────────────────────

describe('linking and updating', () => {
  it('links an existing issue to its task without touching GitHub', async () => {
    const h = setup()
    userAsked(h)
    const result = await captainCall(h, 'link_github_issue', {
      issue_url: 'https://github.com/krazyjakee/21x/issues/82',
      task_id: h.taskIds[VOICE_INPUT_TASK]
    })
    expect(result).toMatchObject({ status: 'linked', issue_number: 82 })
    expect(h.requests).toHaveLength(0)
    const task = h.db.getTask(h.taskIds[VOICE_INPUT_TASK])!
    expect(task.attachments.some((item) => item.filename === 'https://github.com/krazyjakee/21x/issues/82')).toBe(true)
    // Linking the same issue twice adds one attachment and one ledger row.
    await captainCall(h, 'link_github_issue', { issue_url: 'https://github.com/krazyjakee/21x/issues/82', task_id: h.taskIds[VOICE_INPUT_TASK] })
    expect(h.db.getTask(h.taskIds[VOICE_INPUT_TASK])!.attachments).toHaveLength(1)
    expect(h.db.listIssueWrites({ projectId: h.projectId })).toHaveLength(1)
  })

  it('updates an issue and refuses an empty update', async () => {
    const h = setup()
    userAsked(h)
    const created = await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Before', task_id: h.taskIds[VOICE_INPUT_TASK] })
    expect(await captainCall(h, 'update_github_issue', { issue_url: String(created.issue_url) }))
      .toMatchObject({ status: 'refused', code: 'payload_rejected' })
    const updated = await captainCall(h, 'update_github_issue', { issue_url: String(created.issue_url), title: 'After' })
    expect(updated.status).toBe('updated')
    expect(h.created[0].title).toBe('After')
  })

  it('accepts repo plus number as well as a URL', async () => {
    const h = setup()
    userAsked(h)
    await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'By number', task_id: h.taskIds[VOICE_INPUT_TASK] })
    const updated = await captainCall(h, 'update_github_issue', { repo: 'krazyjakee/21x', issue_number: 200, body: 'Rewritten.' })
    expect(updated.status).toBe('updated')
    expect(await captainCall(h, 'update_github_issue', { body: 'Nowhere' })).toMatchObject({ status: 'refused', code: 'repo_missing' })
  })
})

describe('the blocked voice tasks, as the user asked for them', () => {
  it('turns one instruction into exactly two issues, and a duplicate delivery changes nothing', async () => {
    const h = setup()
    recordDelegatedAuthorization({
      projectId: h.projectId,
      correlationId: 'cmd-9a4a4a2656f4fdef',
      sessionId: 'commander-session',
      messageId: 'msg-human-one-ask',
      text: 'Make 21x tasks for the voice input and TTS reliability work, and open the matching GitHub issues.'
    })

    const asks = [
      { repo: 'krazyjakee/21x', title: 'Commander voice input reliability', body: 'Race-safe capture, pre-roll, speech-aware VAD.', task_id: h.taskIds[VOICE_INPUT_TASK] },
      { repo: 'krazyjakee/21x', title: 'Commander TTS reliability and ElevenLabs cost controls', body: 'Audibility handshake, budgets, epochs.', task_id: h.taskIds[VOICE_TTS_TASK] }
    ]
    const first = await Promise.all(asks.map((args) => captainCall(h, 'create_github_issue', args)))
    expect(first.map((r) => r.status)).toEqual(['created', 'created'])

    // The same instruction is delivered again (a duplicate relay, a resumed
    // Captain, a replayed outbox row): still two issues.
    const again = await Promise.all(asks.map((args) => captainCall(h, 'create_github_issue', args)))
    expect(again.map((r) => r.status)).toEqual(['already_done', 'already_done'])
    expect(again.map((r) => r.issue_url)).toEqual(first.map((r) => r.issue_url))

    expect(h.created).toHaveLength(2)
    expect(h.db.listIssueWrites({ projectId: h.projectId })).toHaveLength(2)

    // Both issues are linked back to their 21x tasks, and both ledger rows
    // point at the one human instruction.
    for (const [taskId, result] of [[h.taskIds[VOICE_INPUT_TASK], first[0]], [h.taskIds[VOICE_TTS_TASK], first[1]]] as const) {
      expect(h.db.getTask(taskId)!.attachments.some((item) => item.filename === result.issue_url)).toBe(true)
    }
    for (const row of h.db.listIssueWrites({ projectId: h.projectId })) {
      expect(row.origin_message_id).toBe('msg-human-one-ask')
      expect(row.correlation_id).toBe('cmd-9a4a4a2656f4fdef')
    }
  })

  it('files the second issue even when the first one fails', async () => {
    const h = setup()
    userAsked(h)
    h.failNext('refused')
    const one = await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Voice input', task_id: h.taskIds[VOICE_INPUT_TASK] })
    const two = await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'TTS', task_id: h.taskIds[VOICE_TTS_TASK] })
    expect(one.status).toBe('failed')
    expect(two.status).toBe('created')
    const rows = h.db.listIssueWrites({ projectId: h.projectId })
    expect(rows.filter((row) => row.status === 'failed')).toHaveLength(1)
    expect(rows.filter((row) => row.status === 'succeeded')).toHaveLength(1)
  })
})

// ── The seam for a richer provenance chain ────────────────────

describe('the origin resolver seam', () => {
  it('lets a durable authorization chain replace the default without touching the gate', async () => {
    const h = setup()
    setIssueWriteOriginResolver(() => ({
      kind: 'user_task_instruction',
      messageId: 'chain-msg-1',
      sessionId: 'chain-session',
      textHash: 'f'.repeat(64),
      excerpt: 'from a verified chain',
      authoredAt: '2026-09-20T00:00:00.000Z',
      correlationId: 'cmd-chained'
    }))
    const result = await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Chained', task_id: h.taskIds[VOICE_INPUT_TASK] })
    expect(result.status).toBe('created')
    expect(h.db.listIssueWrites({ projectId: h.projectId })[0]).toMatchObject({
      origin_kind: 'user_task_instruction',
      origin_message_id: 'chain-msg-1',
      correlation_id: 'cmd-chained'
    })
  })

  it('a resolver that finds nothing refuses every write', async () => {
    const h = setup()
    userAsked(h)
    setIssueWriteOriginResolver(() => null)
    expect(await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Nope' }))
      .toMatchObject({ status: 'refused', code: 'no_human_origin' })
  })
})

describe('the Captain prompt', () => {
  it('tells the Captain that issues need no grant and merges still do', () => {
    const prompt = buildCaptainSystemPrompt()
    expect(prompt).toContain('## Writing GitHub issues')
    expect(prompt).toContain('You do not need a grant for it')
    expect(prompt).toContain('`create_github_issue`')
    expect(prompt).toContain('`list_github_issue_writes`')
    // The merge rule is untouched and still names its own authority.
    expect(prompt).toContain('merge only with `merge_pull_request`')
    expect(prompt).toContain('A merge grant is standing permission the user gave')
  })
})
