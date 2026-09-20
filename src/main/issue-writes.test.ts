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
import { execFile } from 'child_process'
import { createServer } from 'http'
import { promisify } from 'util'
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
  computeIdempotencyKey,
  confirmedIssueWriteFailure,
  hashPayload,
  reconcileIssueWrites,
  setIssueGhRunner,
} from './issue-writes'
import {
  AUTHORIZATION_TTL_MS,
  activateAuthorizationDispatch,
  bindAuthorizationTransport,
  commanderAuthorization,
  delegateAuthorization,
  prepareAuthorizationDispatch,
  recordHumanAuthorization,
  revokeAuthorization,
  type AuthorizationNode
} from './authorization'
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
  captainTaskId: string
  taskIds: Record<string, string>
  scope: TaskMcpScope
  taskAgentScope: TaskMcpScope
  invoke: ReturnType<typeof vi.fn<TaskApiInvoke>>
  gh: ReturnType<typeof vi.fn>
  requests: GhRequest[]
  created: Array<{ repo: string; number: number; title: string; body: string; labels?: string[] }>
  events: EscalationEvent[]
  notifyUser: ReturnType<typeof vi.fn>
  /** Make the next N gh calls behave in a particular way. */
  failNext: (behaviour: 'timeout' | 'refused' | null) => void
}

function setup(options: { issuePolicy?: string; repos?: Array<[string, string]>; projectName?: string } = {}): Harness {
  const { db } = createTestDb()
  const settings: Record<string, unknown> = {}
  if (options.issuePolicy) settings.escalation = { issue_write: options.issuePolicy }
  const projectId = db.createProject({ name: options.projectName ?? 'Voice', settings })!.id
  const otherProjectId = db.createProject({ name: 'Other' })!.id
  for (const [org, name] of options.repos ?? [['krazyjakee', '21x']]) {
    db.addProjectRepo(projectId, { provider: 'github', org, name })
  }
  db.addProjectRepo(otherProjectId, { provider: 'github', org: 'krazyjakee', name: 'other' })
  const agentId = db.createAgent(makeAgent({ name: 'Worker' }))!.id
  const captainTaskId = db.ensureCoordinatorTask(projectId)!.id

  const taskIds: Record<string, string> = {}
  for (const [key, title] of [[VOICE_INPUT_TASK, 'Commander voice input reliability'], [VOICE_TTS_TASK, 'Commander TTS reliability and cost controls']] as const) {
    const task = db.createTask(makeTask({ title, project_id: projectId }))!
    db.updateTask(task.id, { agent_id: agentId })
    taskIds[key] = task.id
  }
  const foreign = db.createTask(makeTask({ title: 'Someone else\'s work', project_id: otherProjectId }))!
  taskIds.foreign = foreign.id

  const requests: GhRequest[] = []
  const created: Array<{ repo: string; number: number; title: string; body: string; labels?: string[] }> = []
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
        .map((issue) => ({
          number: issue.number,
          html_url: `https://github.com/${issue.repo}/issues/${issue.number}`,
          title: issue.title,
          body: issue.body,
          labels: issue.labels ?? []
        }))
      return JSON.stringify({ total_count: items.length, incomplete_results: false, items })
    }

    if (behaviour === 'timeout') { behaviour = null; throw new Error('spawn gh ETIMEDOUT') }
    if (behaviour === 'refused') { behaviour = null; throw new Error('gh: Validation Failed (HTTP 422)') }

    if (method === 'POST' && /\/repos\/.+\/issues$/.test(path)) {
      const repo = /\/repos\/(.+)\/issues$/.exec(path)![1]
      const title = args[args.indexOf('-f', args.indexOf(path)) + 1]?.replace(/^title=/, '') ?? ''
      const body = args.find((a) => a.startsWith('body='))?.slice(5) ?? ''
      const labels = args.flatMap((arg, index) =>
        (args[index - 1] === '-f' || args[index - 1] === '-F') && arg.startsWith('labels[]=') ? [arg.slice('labels[]='.length)] : [])
      const number = nextNumber++
      created.push({ repo, number, title, body, labels })
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
    captainTaskId,
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

let authorizationSequence = 0

function activateNode(h: Harness, node: AuthorizationNode, payload: string): void {
  const key = `test-auth:${++authorizationSequence}`
  bindAuthorizationTransport(h.db, key, node.id, h.captainTaskId, payload)
  activateAuthorizationDispatch(h.db, prepareAuthorizationDispatch(h.db, { key, taskId: h.captainTaskId, text: payload }))
}

/** The user typed a project-work instruction; the platform captured and bound it. */
function userAsked(h: Harness, text = 'Please open GitHub issues and update GitHub issues and link GitHub issues.'): AuthorizationNode {
  const messageId = `project-human-${++authorizationSequence}`
  const node = recordHumanAuthorization(h.db, {
    messageId,
    text,
    at: Date.now(),
    source: 'project-chat',
    sessionId: `project-session-${authorizationSequence}`,
    taskId: h.captainTaskId,
    projectId: h.projectId
  })
  activateAuthorizationDispatch(h.db, prepareAuthorizationDispatch(h.db, {
    key: `project-dispatch:${messageId}`,
    taskId: h.captainTaskId,
    text,
    messageId
  }))
  return node
}

/** A real Commander root + relay + transport binding, as production records it. */
function commanderAsked(h: Harness, options: { correlationId?: string; messageId?: string; text?: string; relay?: string } = {}): AuthorizationNode {
  const correlationId = options.correlationId ?? `cmd-${++authorizationSequence}`
  const messageId = options.messageId ?? `commander-human-${authorizationSequence}`
  const text = options.text ?? 'Please open Voice GitHub issues.'
  const relay = options.relay ?? 'Open the matching GitHub issues for the voice tasks.'
  const sessionId = `commander-session-${authorizationSequence}`
  recordHumanAuthorization(h.db, { messageId, text, at: Date.now(), source: 'commander-chat', sessionId })
  const node = commanderAuthorization(h.db, {
    sessionId,
    userMessageId: messageId,
    userMessage: text,
    trigger: 'user',
    projectId: h.projectId,
    taskId: h.captainTaskId,
    correlationId,
    message: relay
  })
  if (!node) throw new Error('Commander authorization fixture was not created')
  activateNode(h, node, relay)
  return node
}

const creates = (h: Harness): GhRequest[] => h.requests.filter((r) => r.args.includes('POST'))

function holdNextIssuePreflight(h: Harness): { ready: () => boolean; release: () => void } {
  let finish: (() => void) | null = null
  h.gh.mockImplementationOnce((args: string[]) => new Promise<string>((resolve) => {
    h.requests.push({ args })
    finish = () => resolve(JSON.stringify({
      number: 77,
      html_url: 'https://github.com/krazyjakee/21x/issues/77',
      title: 'Existing issue',
      body: '',
      labels: [],
      state: 'open'
    }))
  }))
  return {
    ready: () => finish !== null,
    release: () => {
      if (!finish) throw new Error('GitHub preflight is not pending')
      finish()
    }
  }
}

beforeEach(() => {
  clearHeldActions()
})

afterEach(() => {
  setIssueGhRunner(null)
  setCoordinatorCallGate(null)
  configureEscalation(null)
  setCommanderEscalationHandler(null)
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
    vi.setSystemTime(new Date(Date.now() + AUTHORIZATION_TTL_MS + 1000))
    const result = await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Stale' })
    expect(result).toMatchObject({ status: 'refused', code: 'no_human_origin' })
  })

  it('takes a Commander relay the user started, and refuses one they did not', async () => {
    const h = setup()
    // A relay the Commander generated answering a report cannot produce a
    // human authorization node or an active Captain binding.
    expect(commanderAuthorization(h.db, {
      sessionId: 's1',
      userMessage: 'Please open Voice GitHub issues.',
      trigger: 'report',
      projectId: h.projectId,
      taskId: h.captainTaskId,
      correlationId: 'cmd-aaa',
      message: 'file the tickets'
    })).toBeNull()
    expect(await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'From a bare relay' }))
      .toMatchObject({ status: 'refused', code: 'no_human_origin' })

    // A relay inside a turn the person themselves started.
    commanderAsked(h, {
      correlationId: 'cmd-fcf90bbd68342b0b',
      messageId: 'msg-human-1',
      text: 'Please open Voice GitHub issues.'
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

  it('refuses credentials anywhere in the outgoing payload, or an @mention', async () => {
    const h = setup()
    userAsked(h)
    expect(await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Leak', body: 'token ghp_0123456789abcdefghijABCDEFGHIJ0123' }))
      .toMatchObject({ status: 'refused', code: 'credential_escalation' })
    expect(await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Ping', body: 'cc @krazyjakee' }))
      .toMatchObject({ status: 'refused', code: 'payload_rejected' })
    expect(await captainCall(h, 'create_github_issue', {
      repo: 'krazyjakee/21x', title: 'Label leak', labels: ['ghp_0123456789abcdefghijABCDEFGHIJ0123']
    })).toMatchObject({ status: 'refused', code: 'credential_escalation' })
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

  it('intersects project scope with both target-task and calling-Captain repository scopes', async () => {
    const targetScoped = setup({ repos: [['krazyjakee', '21x'], ['krazyjakee', 'other']] })
    userAsked(targetScoped)
    targetScoped.db.updateTask(targetScoped.taskIds[VOICE_INPUT_TASK], { repos: ['krazyjakee/other'] })
    expect(await captainCall(targetScoped, 'link_github_issue', {
      issue_url: 'https://github.com/krazyjakee/21x/issues/82',
      task_id: targetScoped.taskIds[VOICE_INPUT_TASK]
    })).toMatchObject({ status: 'refused', code: 'repo_not_in_project' })
    expect(targetScoped.requests).toHaveLength(0)

    const callerScoped = setup({ repos: [['krazyjakee', '21x'], ['krazyjakee', 'other']] })
    userAsked(callerScoped)
    callerScoped.db.updateTask(callerScoped.captainTaskId, { repos: ['krazyjakee/other'] })
    expect(await captainCall(callerScoped, 'create_github_issue', {
      repo: 'krazyjakee/21x', title: 'Outside caller task scope'
    })).toMatchObject({ status: 'refused', code: 'repo_not_in_project' })
    expect(creates(callerScoped)).toHaveLength(0)
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

    // Restart: the process is gone and the database is reopened from its own
    // bytes. Both the authorization binding and the idempotency claim survive.
    const bytes = (h.db as unknown as { db: InstanceType<typeof Database> }).db.serialize()
    const { db: reopened } = createTestDb()
    ;(reopened as unknown as { db: InstanceType<typeof Database> }).db.close()
    ;(reopened as unknown as { db: InstanceType<typeof Database> }).db = new Database(bytes)
    configureEscalation({ db: reopened, mergeDb: reopened, issueDb: reopened, notifyUser: vi.fn(), notifyRenderer: vi.fn(), tellCaptain: vi.fn(async () => undefined) })
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

  it('bounds caller-supplied idempotency material before hashing it', async () => {
    const h = setup()
    userAsked(h)
    expect(await captainCall(h, 'create_github_issue', {
      repo: 'krazyjakee/21x',
      title: 'Bounded',
      idempotency_key: 'x'.repeat(201)
    })).toMatchObject({ status: 'refused', code: 'payload_rejected' })
    expect(creates(h)).toHaveLength(0)
  })

  it('binds a client key immutably to the exact operation and human origin, even after failure', async () => {
    const h = setup({ repos: [['krazyjakee', '21x'], ['krazyjakee', 'docs']] })
    const firstOrigin = userAsked(h)
    const original = {
      repo: 'krazyjakee/21x',
      title: 'Original payload',
      body: 'Original body',
      task_id: h.taskIds[VOICE_INPUT_TASK],
      idempotency_key: 'stable-client-key'
    }
    h.failNext('refused')
    expect(await captainCall(h, 'create_github_issue', original)).toMatchObject({ status: 'failed' })
    const before = h.db.listIssueWrites({ projectId: h.projectId })[0]

    expect(await captainCall(h, 'create_github_issue', { ...original, title: 'Changed payload' }))
      .toMatchObject({ status: 'refused', code: 'idempotency_conflict' })
    expect(await captainCall(h, 'create_github_issue', { ...original, repo: 'krazyjakee/docs' }))
      .toMatchObject({ status: 'refused', code: 'idempotency_conflict' })

    userAsked(h)
    expect(await captainCall(h, 'create_github_issue', original))
      .toMatchObject({ status: 'refused', code: 'idempotency_conflict' })

    const after = h.db.listIssueWrites({ projectId: h.projectId })[0]
    expect(after).toMatchObject({
      id: before.id,
      status: 'failed',
      attempts: 1,
      payload_hash: hashPayload({ title: original.title, body: original.body }),
      task_id: h.taskIds[VOICE_INPUT_TASK],
      origin_message_id: firstOrigin.messageId
    })
    expect(h.db.listIssueWrites({ projectId: h.projectId })).toHaveLength(1)
    expect(creates(h)).toHaveLength(1)
  })

  it('rejects rebinding one client key to another action or target', async () => {
    const h = setup()
    userAsked(h)
    h.created.push(
      { repo: 'krazyjakee/21x', number: 10, title: 'Ten', body: '' },
      { repo: 'krazyjakee/21x', number: 11, title: 'Eleven', body: '' }
    )
    h.gh.mockImplementationOnce(async () => JSON.stringify({ number: 10, title: 'Ten', body: '', state: 'open' }))
    h.gh.mockImplementationOnce(async () => { throw new Error('gh: Validation Failed (HTTP 422)') })
    expect(await captainCall(h, 'update_github_issue', {
      repo: 'krazyjakee/21x', issue_number: 10, body: 'Changed', idempotency_key: 'one-binding'
    })).toMatchObject({ status: 'failed' })

    expect(await captainCall(h, 'update_github_issue', {
      repo: 'krazyjakee/21x', issue_number: 11, body: 'Changed', idempotency_key: 'one-binding'
    })).toMatchObject({ status: 'refused', code: 'idempotency_conflict' })
    expect(await captainCall(h, 'create_github_issue', {
      repo: 'krazyjakee/21x', title: 'Different action', idempotency_key: 'one-binding'
    })).toMatchObject({ status: 'refused', code: 'idempotency_conflict' })
    expect(h.db.listIssueWrites({ projectId: h.projectId })).toHaveLength(1)
    expect(h.db.listIssueWrites({ projectId: h.projectId })[0]).toMatchObject({ action: 'update_issue', target_number: 10, status: 'failed' })
  })

  it('computes a key from durable inputs only, never from who authorized it', () => {
    const base = { projectId: 'p', repo: 'o/r', action: 'create_issue' as const, taskId: 't', payloadHash: hashPayload({ title: 'a' }) }
    expect(computeIdempotencyKey(base)).toBe(computeIdempotencyKey({ ...base }))
    expect(computeIdempotencyKey(base)).not.toBe(computeIdempotencyKey({ ...base, taskId: 'other' }))
    expect(computeIdempotencyKey(base)).not.toBe(computeIdempotencyKey({ ...base, repo: 'o/other' }))
    expect(computeIdempotencyKey(base)).not.toBe(computeIdempotencyKey({ ...base, payloadHash: hashPayload({ title: 'b' }) }))
    expect(computeIdempotencyKey({ ...base, clientKey: 'k' })).not.toBe(computeIdempotencyKey(base))
    expect(hashPayload({ title: 'same' })).not.toBe(hashPayload({ title: 'same', body: '' }))
    expect(hashPayload({ title: 'same' })).not.toBe(hashPayload({ title: 'same', labels: [] }))
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

    // A negative search result is not proof of absence: GitHub may index a
    // successful create later. The retry therefore remains held instead of
    // risking a duplicate.
    const retry = await captainCall(h, 'create_github_issue', args)
    expect(retry.status).toBe('unresolved')
    expect(h.created).toHaveLength(0)
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

  it('recovers post-success task links and journal effects exactly once', async () => {
    const h = setup()
    userAsked(h)
    vi.spyOn(h.db, 'applyIssueWriteEffects').mockImplementationOnce(() => {
      throw new Error('crash after external success')
    })

    const result = await captainCall(h, 'create_github_issue', {
      repo: 'krazyjakee/21x',
      title: 'External success, local crash',
      task_id: h.taskIds[VOICE_INPUT_TASK]
    })
    expect(result).toMatchObject({ status: 'unresolved', issue_url: 'https://github.com/krazyjakee/21x/issues/200' })
    expect(h.db.listIssueWrites({ projectId: h.projectId })[0]).toMatchObject({
      status: 'succeeded',
      effects_applied_at: null
    })
    expect(h.db.getTask(h.taskIds[VOICE_INPUT_TASK])!.attachments).toHaveLength(0)
    expect(h.db.countProjectStatusJournal(h.projectId)).toBe(0)

    expect(await reconcileIssueWrites(h.db, h.projectId)).toBe(1)
    expect(h.db.getTask(h.taskIds[VOICE_INPUT_TASK])!.attachments).toHaveLength(1)
    expect(h.db.countProjectStatusJournal(h.projectId)).toBe(1)
    expect(h.db.listIssueWrites({ projectId: h.projectId })[0].effects_applied_at).toBeTruthy()

    expect(await reconcileIssueWrites(h.db, h.projectId)).toBe(0)
    expect(h.db.getTask(h.taskIds[VOICE_INPUT_TASK])!.attachments).toHaveLength(1)
    expect(h.db.countProjectStatusJournal(h.projectId)).toBe(1)
    expect(creates(h)).toHaveLength(1)
  })

  it('keeps duplicate recovery markers unresolved instead of picking a hit', async () => {
    const h = setup()
    userAsked(h)
    h.gh.mockImplementationOnce(async (callArgs: string[]) => {
      const body = callArgs.find((arg) => arg.startsWith('body='))!.slice(5)
      h.created.push(
        { repo: 'krazyjakee/21x', number: 301, title: 'Duplicate marker A', body },
        { repo: 'krazyjakee/21x', number: 302, title: 'Duplicate marker B', body }
      )
      throw new Error('ECONNRESET')
    })
    expect(await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Ambiguous marker' }))
      .toMatchObject({ status: 'unresolved' })

    expect(await reconcileIssueWrites(h.db, h.projectId)).toBe(0)
    expect(h.db.listIssueWrites({ projectId: h.projectId })[0]).toMatchObject({
      status: 'unresolved',
      external_url: null,
      effects_applied_at: null
    })
  })

  it.each([
    { name: 'truncated', totalCount: 11, incomplete: false },
    { name: 'incomplete', totalCount: 10, incomplete: true },
    { name: 'metadata-omitting', totalCount: 10, incomplete: undefined }
  ])('keeps a $name marker search unresolved even when its returned page has one exact hit', async ({ totalCount, incomplete }) => {
    const h = setup()
    userAsked(h)
    h.failNext('timeout')
    expect(await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Incomplete marker evidence' }))
      .toMatchObject({ status: 'unresolved' })
    const row = h.db.listIssueWrites({ projectId: h.projectId })[0]
    const exact = `<!-- 21x-issue-write:${row.idempotency_key} -->`
    const items = [
      { number: 301, html_url: 'https://github.com/krazyjakee/21x/issues/301', body: exact },
      ...Array.from({ length: 9 }, (_, index) => ({
        number: 400 + index,
        html_url: `https://github.com/krazyjakee/21x/issues/${400 + index}`,
        body: `Phrase-only search hit ${index}`
      }))
    ]
    h.gh.mockImplementationOnce(async () => JSON.stringify({
      total_count: totalCount,
      incomplete_results: incomplete,
      items
    }))

    expect(await reconcileIssueWrites(h.db, h.projectId)).toBe(0)
    expect(h.db.listIssueWrites({ projectId: h.projectId })[0]).toMatchObject({
      status: 'unresolved', external_url: null, effects_applied_at: null
    })
  })

  it('keeps a copied marker unresolved when the candidate payload does not match the durable claim', async () => {
    const h = setup()
    userAsked(h)
    h.failNext('timeout')
    expect(await captainCall(h, 'create_github_issue', {
      repo: 'krazyjakee/21x', title: 'Expected title', body: 'Expected body'
    })).toMatchObject({ status: 'unresolved' })
    const row = h.db.listIssueWrites({ projectId: h.projectId })[0]
    const copiedMarker = `<!-- 21x-issue-write:${row.idempotency_key} -->`
    h.gh.mockImplementationOnce(async () => JSON.stringify({
      total_count: 1,
      incomplete_results: false,
      items: [{
        number: 301,
        html_url: 'https://github.com/krazyjakee/21x/issues/301',
        title: 'Attacker-controlled title',
        body: `Attacker-controlled body\n\n${copiedMarker}`,
        labels: []
      }]
    }))

    expect(await reconcileIssueWrites(h.db, h.projectId)).toBe(0)
    expect(h.db.listIssueWrites({ projectId: h.projectId })[0]).toMatchObject({
      status: 'unresolved', external_url: null, effects_applied_at: null
    })
    expect(h.db.countProjectStatusJournal(h.projectId)).toBe(0)
  })

  it('requires create defaults to match when body and labels were omitted from the durable shape', async () => {
    const h = setup()
    userAsked(h)
    h.failNext('timeout')
    expect(await captainCall(h, 'create_github_issue', {
      repo: 'krazyjakee/21x', title: 'Same visible title'
    })).toMatchObject({ status: 'unresolved' })
    const row = h.db.listIssueWrites({ projectId: h.projectId })[0]
    const copiedMarker = `<!-- 21x-issue-write:${row.idempotency_key} -->`
    h.gh.mockImplementationOnce(async () => JSON.stringify({
      total_count: 1,
      incomplete_results: false,
      items: [{
        number: 302,
        html_url: 'https://github.com/krazyjakee/21x/issues/302',
        title: 'Same visible title',
        body: `Unrelated copied-marker content\n\n${copiedMarker}`,
        labels: []
      }]
    }))

    expect(await reconcileIssueWrites(h.db, h.projectId)).toBe(0)
    expect(h.db.listIssueWrites({ projectId: h.projectId })[0]).toMatchObject({ status: 'unresolved', external_url: null })
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

  it('rejects a late answer after its lease epoch was taken away', async () => {
    const h = setup()
    userAsked(h)
    let finish!: () => void
    h.gh.mockImplementationOnce((callArgs: string[]) => new Promise<string>((resolve) => {
      const body = callArgs.find((arg) => arg.startsWith('body='))!.slice(5)
      h.created.push({ repo: 'krazyjakee/21x', number: 654, title: 'Slow success', body })
      finish = () => resolve(JSON.stringify({ number: 654, html_url: 'https://github.com/krazyjakee/21x/issues/654' }))
    }))

    const pending = captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Slow success' })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const claimed = h.db.listIssueWrites({ projectId: h.projectId })[0]
    h.db.db.prepare('UPDATE issue_writes SET lease_expires_at = ? WHERE id = ?').run(Date.now() - 1, claimed.id)
    const [reconcilerOwned] = h.db.listUnresolvedIssueWrites(h.projectId)
    expect(reconcilerOwned.attempt_epoch).toBe(claimed.attempt_epoch + 1)

    finish()
    expect(await pending).toMatchObject({ status: 'unresolved' })
    expect(h.db.getIssueWrite(claimed.id)?.status).toBe('unresolved')
    expect(await reconcileIssueWrites(h.db, h.projectId)).toBe(1)
    expect(h.db.getIssueWrite(claimed.id)).toMatchObject({ status: 'succeeded', external_number: 654 })
  })

  it('reconciles only the fields that an interrupted update actually changed', async () => {
    const h = setup()
    userAsked(h)
    h.created.push({ repo: 'krazyjakee/21x', number: 88, title: 'Keep this title', body: 'Before' })
    h.gh.mockImplementationOnce(async () => JSON.stringify({ number: 88, title: 'Keep this title', body: 'Before', state: 'open' }))
    h.gh.mockImplementationOnce(async () => {
      h.created[0].body = 'After'
      throw new Error('socket hang up')
    })

    expect(await captainCall(h, 'update_github_issue', { repo: 'krazyjakee/21x', issue_number: 88, body: 'After' }))
      .toMatchObject({ status: 'unresolved' })
    expect(h.db.listIssueWrites({ projectId: h.projectId })[0].payload_fields).toBe('["body"]')
    expect(await reconcileIssueWrites(h.db, h.projectId)).toBe(1)
    expect(h.db.listIssueWrites({ projectId: h.projectId })[0].status).toBe('succeeded')
  })

  it('keeps a successful but malformed GitHub response unresolved', async () => {
    const h = setup()
    userAsked(h)
    h.gh.mockImplementationOnce(async () => JSON.stringify({ state: 'open' }))
    expect(await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'No identity' }))
      .toMatchObject({ status: 'unresolved' })
    expect(h.db.listIssueWrites({ projectId: h.projectId })[0]).toMatchObject({ status: 'unresolved', settled_at: null })
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
    commanderAsked(h, {
      correlationId: 'cmd-6f41cf85aa4e9f1a',
      messageId: 'msg-human-42',
      text: 'Please open Voice GitHub issues.'
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
      correlation_id: 'cmd-6f41cf85aa4e9f1a',
      status: 'succeeded',
      external_url: 'https://github.com/krazyjakee/21x/issues/200',
      external_number: 200,
      attempts: 1
    })
    expect(row.payload_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.origin_text_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.origin_excerpt).toBe('Please open Voice GitHub issues.')
    expect(row.external_result).toContain('"number":200')
    expect(row.created_at >= before).toBe(true)
    expect(row.settled_at).not.toBeNull()
    expect(row.error).toBeNull()
  })

  it('never copies the user\'s words to GitHub, only their hash into the ledger', async () => {
    const h = setup()
    const instruction = 'Please open GitHub issues and update GitHub issues and link GitHub issues.'
    userAsked(h, instruction)
    await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Voice work', body: 'Scope only.' })
    expect(h.created[0].body).not.toContain(instruction)
    const [row] = h.db.listIssueWrites({ projectId: h.projectId })
    expect(row.origin_text_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.origin_excerpt).toBe(instruction)
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
  it('links an existing issue to its task without writing to GitHub', async () => {
    const h = setup()
    userAsked(h)
    const result = await captainCall(h, 'link_github_issue', {
      issue_url: 'https://github.com/krazyjakee/21x/issues/82',
      task_id: h.taskIds[VOICE_INPUT_TASK]
    })
    expect(result).toMatchObject({ status: 'linked', issue_number: 82 })
    expect(h.requests.filter((request) => request.args.includes('POST') || request.args.includes('PATCH'))).toHaveLength(0)
    const task = h.db.getTask(h.taskIds[VOICE_INPUT_TASK])!
    expect(task.attachments.some((item) => item.filename === 'https://github.com/krazyjakee/21x/issues/82')).toBe(true)
    // Linking the same issue twice adds one attachment and one ledger row.
    await captainCall(h, 'link_github_issue', { issue_url: 'https://github.com/krazyjakee/21x/issues/82', task_id: h.taskIds[VOICE_INPUT_TASK] })
    expect(h.db.getTask(h.taskIds[VOICE_INPUT_TASK])!.attachments).toHaveLength(1)
    expect(h.db.listIssueWrites({ projectId: h.projectId })).toHaveLength(1)
  })

  it('refuses pull-request numbers on both update and link paths', async () => {
    const h = setup()
    userAsked(h)
    h.gh.mockImplementationOnce(async () => JSON.stringify({
      number: 160,
      html_url: 'https://github.com/krazyjakee/21x/pull/160',
      pull_request: { url: 'https://api.github.com/repos/krazyjakee/21x/pulls/160' }
    }))
    expect(await captainCall(h, 'update_github_issue', {
      repo: 'krazyjakee/21x', issue_number: 160, title: 'Do not PATCH this PR'
    })).toMatchObject({ status: 'refused', code: 'target_not_issue' })

    h.gh.mockImplementationOnce(async () => JSON.stringify({
      number: 160,
      html_url: 'https://github.com/krazyjakee/21x/pull/160',
      pull_request: { url: 'https://api.github.com/repos/krazyjakee/21x/pulls/160' }
    }))
    expect(await captainCall(h, 'link_github_issue', {
      issue_url: 'https://github.com/krazyjakee/21x/issues/160', task_id: h.taskIds[VOICE_INPUT_TASK]
    })).toMatchObject({ status: 'refused', code: 'target_not_issue' })
    expect(h.requests.some((request) => request.args.includes('PATCH'))).toBe(false)
    expect(h.db.listIssueWrites({ projectId: h.projectId })).toHaveLength(0)
    expect(h.db.getTask(h.taskIds[VOICE_INPUT_TASK])!.attachments).toHaveLength(0)
  })

  it('serializes label values as raw strings while retaining an explicit empty array', async () => {
    const h = setup()
    userAsked(h)
    await captainCall(h, 'create_github_issue', {
      repo: 'krazyjakee/21x', title: 'Typed labels', labels: ['bug', 'voice']
    })
    const post = h.requests.find((request) => request.args.includes('POST'))!.args
    expect(post).toEqual(expect.arrayContaining(['-f', 'labels[]=bug', 'labels[]=voice']))
    expect(post.some((arg, index) => arg === '-F' && post[index + 1]?.startsWith('labels[]='))).toBe(false)

    await captainCall(h, 'update_github_issue', {
      repo: 'krazyjakee/21x', issue_number: 200, labels: []
    })
    const patch = h.requests.find((request) => request.args.includes('PATCH'))!.args
    expect(patch).toEqual(expect.arrayContaining(['-F', 'labels[]']))
    expect(patch.some((arg) => arg === '--raw-field' || arg === 'labels=[]' || arg === 'labels="[]"')).toBe(false)
  })

  it('preserves scalar-looking label names as JSON strings on the actual gh wire', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        if (request.method === 'PATCH') {
          bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
        }
        const match = /\/issues\/(\d+)$/.exec(request.url ?? '')
        const number = Number(match?.[1] ?? 77)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          number,
          html_url: `https://github.com/krazyjakee/21x/issues/${number}`,
          title: 'Existing issue',
          body: '',
          labels: [],
          state: 'open'
        }))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Loopback server did not expose a TCP port')
    const host = `127.0.0.1:${address.port}`
    const run = promisify(execFile)
    const h = setup()
    userAsked(h)
    setIssueGhRunner(async (args) => {
      const localArgs = [...args]
      const endpoint = localArgs.findIndex((arg) => arg.startsWith('/'))
      if (endpoint < 0) throw new Error('gh test request has no API endpoint')
      localArgs[endpoint] = `http://${host}${localArgs[endpoint]}`
      const { stdout } = await run('gh', localArgs, {
        env: {
          ...process.env,
          GH_TOKEN: 'ghp_000000000000000000000000000000000000',
          GH_NO_UPDATE_NOTIFIER: '1'
        },
        encoding: 'utf8',
        maxBuffer: 1024 * 1024
      })
      return stdout
    })
    try {
      const scalarResult = await captainCall(h, 'update_github_issue', {
        repo: 'krazyjakee/21x', issue_number: 77, labels: ['true', 'false', '123', '00123', 'null']
      })
      expect(scalarResult).toMatchObject({ status: 'updated' })
      expect(await captainCall(h, 'update_github_issue', {
        repo: 'krazyjakee/21x', issue_number: 78, labels: []
      })).toMatchObject({ status: 'updated' })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }

    expect(bodies).toHaveLength(2)
    expect(bodies[0].labels).toEqual(['true', 'false', '123', '00123', 'null'])
    expect(Array.isArray(bodies[0].labels) && bodies[0].labels.every((label) => typeof label === 'string')).toBe(true)
    expect(bodies[1].labels).toEqual([])
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
    commanderAsked(h, {
      correlationId: 'cmd-9a4a4a2656f4fdef',
      messageId: 'msg-human-one-ask',
      text: 'Please open Voice GitHub issues.'
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

// ── Durable authorization-chain integration ──────────────────

describe('the durable authorization chain', () => {
  it('regresses the exact live Commander correlation through the audited idempotent write', async () => {
    const h = setup({ projectName: '21x' })
    const live = '36 pull requests still open. why have we stalled. come up with a technical solution for 21x that will prevent this stalling in future. open gh issues and tasks for it and prioritise them.'
    const correlationId = 'cmd-c3f16552f0898b5fc7750408f85224d2fefa26250fc38617020d7a9d1352ff36'
    commanderAsked(h, { correlationId, messageId: 'knpu31zj42pjl4j1wsw9mueh', text: live, relay: 'Open the prioritized issue and task work.' })
    const args = { repo: 'krazyjakee/21x', title: 'Prevent pull-request queue stalls', task_id: h.taskIds[VOICE_INPUT_TASK] }
    expect(await captainCall(h, 'create_github_issue', args)).toMatchObject({ status: 'created' })
    expect(await captainCall(h, 'create_github_issue', args)).toMatchObject({ status: 'already_done' })
    expect(creates(h)).toHaveLength(1)
    expect(h.db.listIssueWrites({ projectId: h.projectId })).toHaveLength(1)
    expect(h.db.listIssueWrites({ projectId: h.projectId })[0]).toMatchObject({ correlation_id: correlationId, status: 'succeeded' })
  })

  it.each([
    '1 Sample instructions:\nCreate tasks. Open gh issues for 21x.',
    'How to proceed only upon my go-ahead:\nCreate tasks. Open gh issues for 21x.',
    'Open gh issues for 21x. Start only upon my go-ahead.',
    'Open gh issues for 21x. Do not open anything yet.',
    'Open gh issues for 21x. The gh issues should remain unwritten until I give consent.',
    'Open gh issues for 21x. I do not want recommendations or any actions yet.',
    'Open gh issues for 21x. Implement these instructions only upon my go-ahead.',
    'Open gh issues for 21x. Implement nothing until I give consent.',
    'Open gh issues for 21x. Fix nothing yet.',
    'Open gh issues for 21x. Code nothing until I give consent.',
    'Open gh issues for 21x. Implement the above to demonstrate syntax only.',
    'Open gh issues for 21x. Refactor this plan into a proposal only.',
    'Open gh issues for 21x. Repair nothing until I give consent.',
    'Open gh issues for 21x. Build only a written proposal.',
    'Open gh issues for 21x. Develop the above solely as a paper exercise.',
    'Open gh issues for 21x. Implement:',
    'Open gh issues for 21x. Fix?',
    'Open gh issues for 21x?',
    'Open gh issues and start PRs for 21x.',
    'Open gh issues and link tasks for 21x.',
    'Open gh issues and start for 21x.',
    'Open gh issues and link for 21x.',
    'Open gh issues and create for 21x.',
    'Open gh issues and for 21x.',
    'Open 0 gh issues for 21x.',
    'Create 00 gh issues for 21x.',
    'Open gh issues for 21x. I withhold authorization.',
    'Open gh issues for 21x. The gh issues would need to be part of a plan only and must remain unwritten.',
    'Open gh issues for 21x. The gh issues might need to be part of a proposal and nothing shall be created yet.'
  ])('refuses an unparsed governing restriction before the issue ledger can write: %s', async (text) => {
    const h = setup({ projectName: '21x' })
    commanderAsked(h, { text, relay: 'Open the issue requested by the human.' })
    const result = await captainCall(h, 'create_github_issue', {
      repo: 'krazyjakee/21x',
      title: 'Must remain unwritten',
      task_id: h.taskIds[VOICE_INPUT_TASK]
    })
    expect(result).toMatchObject({ status: 'refused', code: 'action_not_in_capability' })
    expect(creates(h)).toHaveLength(0)
    expect(h.db.listIssueWrites({ projectId: h.projectId }).filter((row) => row.status === 'succeeded')).toHaveLength(0)
  })

  it('uses the bound human root and the platform-derived Captain identity', async () => {
    const h = setup()
    const root = userAsked(h)
    const result = await captainCall(h, 'create_github_issue', {
      repo: 'krazyjakee/21x',
      title: 'Chained',
      task_id: h.taskIds[VOICE_INPUT_TASK]
    })
    expect(result.status).toBe('created')
    expect(h.db.listIssueWrites({ projectId: h.projectId })[0]).toMatchObject({
      captain_task_id: h.captainTaskId,
      origin_kind: 'project_chat',
      origin_message_id: root.messageId
    })
  })

  it('honours a chain narrowing and cannot widen beyond configured repositories', async () => {
    const h = setup({ repos: [['krazyjakee', '21x'], ['krazyjakee', 'docs']] })
    const root = userAsked(h)
    const narrowed = delegateAuthorization(h.db, {
      parentId: root.id,
      author: 'captain',
      text: 'Only update issues in the docs repository.',
      taskId: h.captainTaskId,
      projectId: h.projectId,
      actions: ['github.issue.update'],
      repos: ['krazyjakee/docs', 'someone/elsewhere']
    })
    expect(narrowed).not.toBeNull()
    activateNode(h, narrowed!, narrowed!.text)

    const denied = await captainCall(h, 'create_github_issue', { repo: 'krazyjakee/docs', title: 'Not permitted' })
    expect(denied).toMatchObject({
      status: 'refused',
      code: 'action_not_in_capability',
      missing_capability: 'github.issue.create',
      origin_node_id: root.id,
      origin_message_id: root.messageId,
      failure_dimension: 'capability'
    })
    expect(denied.safe_remediation).toContain('explicitly request')
    expect(await captainCall(h, 'update_github_issue', { repo: 'krazyjakee/21x', issue_number: 5, body: 'Out of scope' }))
      .toMatchObject({ status: 'refused', code: 'repo_not_in_project' })
    expect(await captainCall(h, 'update_github_issue', { repo: 'someone/elsewhere', issue_number: 5, body: 'Never configured' }))
      .toMatchObject({ status: 'refused', code: 'repo_not_in_project' })

    h.created.push({ repo: 'krazyjakee/docs', number: 7, title: 'Existing', body: '' })
    expect(await captainCall(h, 'update_github_issue', { repo: 'krazyjakee/docs', issue_number: 7, body: 'In scope' }))
      .toMatchObject({ status: 'updated' })
  })

  it('fails closed when the human origin is revoked while issue preflight is pending', async () => {
    const h = setup()
    const root = userAsked(h)
    const gate = holdNextIssuePreflight(h)
    const pending = captainCall(h, 'update_github_issue', {
      repo: 'krazyjakee/21x', issue_number: 77, body: 'Must not dispatch'
    })
    await vi.waitFor(() => expect(gate.ready()).toBe(true))
    revokeAuthorization(h.db, root.id, 'withdrawn during GitHub preflight')
    gate.release()

    expect(await pending).toMatchObject({ status: 'refused', code: 'no_human_origin' })
    expect(h.gh.mock.calls.some(([args]) => (args as string[]).includes('PATCH'))).toBe(false)
    expect(h.db.listIssueWrites({ projectId: h.projectId })).toHaveLength(0)
  })

  it('re-resolves authorization immediately after the claim and before external dispatch', async () => {
    const h = setup()
    const root = userAsked(h)
    const begin = h.db.beginIssueWrite.bind(h.db)
    vi.spyOn(h.db, 'beginIssueWrite').mockImplementationOnce((input) => {
      const claim = begin(input)
      revokeAuthorization(h.db, root.id, 'withdrawn while the claim was recorded')
      return claim
    })

    expect(await captainCall(h, 'create_github_issue', {
      repo: 'krazyjakee/21x', title: 'Must not dispatch after claim'
    })).toMatchObject({ status: 'refused', code: 'no_human_origin' })
    expect(h.gh.mock.calls.some(([args]) => (args as string[]).includes('POST'))).toBe(false)
    expect(h.db.listIssueWrites({ projectId: h.projectId })[0]).toMatchObject({ status: 'failed' })
  })

  it('fails closed when the human origin expires while issue preflight is pending', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-20T10:00:00Z'))
    const h = setup()
    userAsked(h)
    const gate = holdNextIssuePreflight(h)
    const pending = captainCall(h, 'update_github_issue', {
      repo: 'krazyjakee/21x', issue_number: 77, body: 'Must not dispatch'
    })
    await vi.waitFor(() => expect(gate.ready()).toBe(true))
    vi.setSystemTime(new Date(Date.now() + AUTHORIZATION_TTL_MS + 1))
    gate.release()

    expect(await pending).toMatchObject({ status: 'refused', code: 'no_human_origin' })
    expect(h.gh.mock.calls.some(([args]) => (args as string[]).includes('PATCH'))).toBe(false)
    expect(h.db.listIssueWrites({ projectId: h.projectId })).toHaveLength(0)
  })

  it('fails closed when a different human origin replaces the authorization during preflight', async () => {
    const h = setup()
    userAsked(h)
    const gate = holdNextIssuePreflight(h)
    const pending = captainCall(h, 'update_github_issue', {
      repo: 'krazyjakee/21x', issue_number: 77, body: 'Must not dispatch'
    })
    await vi.waitFor(() => expect(gate.ready()).toBe(true))
    userAsked(h, 'Please update GitHub issues and link GitHub issues.')
    gate.release()

    expect(await pending).toMatchObject({ status: 'refused', code: 'origin_not_trusted' })
    expect(h.gh.mock.calls.some(([args]) => (args as string[]).includes('PATCH'))).toBe(false)
    expect(h.db.listIssueWrites({ projectId: h.projectId })).toHaveLength(0)
  })

  it.each([
    {
      scope: 'current project configuration',
      mutate: (h: Harness) => {
        const repo = h.db.getProjectRepos(h.projectId).find((item) => item.org === 'krazyjakee' && item.name === '21x')!
        h.db.removeProjectRepo(repo.id)
      },
      taskId: false
    },
    {
      scope: 'calling Captain task',
      mutate: (h: Harness) => h.db.updateTask(h.captainTaskId, { repos: ['krazyjakee/other'] }),
      taskId: false
    },
    {
      scope: 'target task',
      mutate: (h: Harness) => h.db.updateTask(h.taskIds[VOICE_INPUT_TASK], { repos: ['krazyjakee/other'] }),
      taskId: true
    }
  ])('fails closed when the $scope repository scope narrows during preflight', async ({ mutate, taskId }) => {
    const h = setup({ repos: [['krazyjakee', '21x'], ['krazyjakee', 'other']] })
    userAsked(h)
    const gate = holdNextIssuePreflight(h)
    const pending = captainCall(h, 'update_github_issue', {
      repo: 'krazyjakee/21x',
      issue_number: 77,
      body: 'Must not dispatch',
      ...(taskId ? { task_id: h.taskIds[VOICE_INPUT_TASK] } : {})
    })
    await vi.waitFor(() => expect(gate.ready()).toBe(true))
    mutate(h)
    gate.release()

    expect(await pending).toMatchObject({ status: 'refused', code: 'repo_not_in_project' })
    expect(h.gh.mock.calls.some(([args]) => (args as string[]).includes('PATCH'))).toBe(false)
    expect(h.db.listIssueWrites({ projectId: h.projectId })).toHaveLength(0)
  })

  it('rechecks revocation and expiry at the write boundary', async () => {
    const revoked = setup()
    const root = userAsked(revoked)
    revokeAuthorization(revoked.db, root.id, 'user withdrew the instruction')
    expect(await captainCall(revoked, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Revoked' }))
      .toMatchObject({ status: 'refused', code: 'no_human_origin' })

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-20T10:00:00Z'))
    const expired = setup()
    userAsked(expired)
    vi.setSystemTime(new Date(Date.now() + AUTHORIZATION_TTL_MS + 1))
    expect(await captainCall(expired, 'create_github_issue', { repo: 'krazyjakee/21x', title: 'Expired' }))
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
