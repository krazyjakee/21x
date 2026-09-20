import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import type { DatabaseManager } from '../database'
import type { ChatToolDefinition, ChatToolResult } from '../chat/tools'
import { DEFAULT_PROJECT_ID } from '../../shared/projects'
import type { HeldAction } from '../../shared/project-limit-types'
import type { UiCommand } from '../../shared/ui-commands'
import { COMMANDER_TOOL_SEVERITY, commanderToolSeverity, parseCommanderActionResult } from '../../shared/commander-tools'
import {
  buildCommanderRelayMessage,
  COMMANDER_RELAY_BEGIN,
  COMMANDER_RELAY_END,
  createCommanderProjectTools,
  MUTATING_COMMANDER_TOOLS,
  type AskCaptainDispatch,
  type CommanderAgents,
  type ProjectToolOptions
} from './project-tools'
import { createCommanderSkillTools, MUTATING_COMMANDER_SKILL_TOOLS } from './skill-tools'

let db: DatabaseManager
let changes: Array<{ projectId: string; kind: string }>
let extra: Partial<ProjectToolOptions>

/** An agent manager with no live sessions; individual tests override what they need. */
function fakeAgents(over: Partial<CommanderAgents> = {}): CommanderAgents {
  let paused = false
  return {
    getStartQueue: () => [],
    findSessionByTaskId: () => undefined,
    getSessionStatus: () => null,
    getProjectLimitState: (projectId: string) => ({
      projectId, paused: false, allProjectsPaused: paused, maxConcurrentAgents: null, runningAgents: 0,
      dailySessionCap: null, sessionsStartedToday: 0, dailyTokenCap: null, tokensToday: 0, queued: [], blockedBy: null
    }),
    sendMessage: vi.fn(async () => ({})),
    pauseAllProjects: vi.fn((value: boolean) => { paused = value }),
    isAllProjectsPaused: () => paused,
    ...over
  } as unknown as CommanderAgents
}

function tools(): ChatToolDefinition[] {
  return createCommanderProjectTools({
    db,
    context: { sessionId: 'session-1' },
    onProjectChanged: (projectId, kind) => changes.push({ projectId, kind }),
    ...extra
  })
}

function tool(name: string): ChatToolDefinition {
  const found = tools().find((candidate) => candidate.name === name)
  if (!found) throw new Error(`Missing tool: ${name}`)
  return found
}

async function call(name: string, input: Record<string, unknown>): Promise<ChatToolResult> {
  const output = await tool(name).handler(input, { signal: new AbortController().signal, toolCallId: 'call-1' })
  return typeof output === 'string' ? { content: output } : output
}

function body(output: ChatToolResult): Record<string, unknown> {
  return JSON.parse(output.content) as Record<string, unknown>
}

beforeEach(() => {
  ;({ db } = createTestDb())
  changes = []
  extra = {}
})

describe('Commander tool registry', () => {
  it('registers delegation and project administration only: no task tools at all', () => {
    const names = tools().map((entry) => entry.name)
    expect(names).toEqual([
      'list_projects', 'get_project_summary', 'get_project_status_history', 'ask_captain', 'get_pending_approvals', 'navigate_to_project', 'pause_all_projects',
      'get_project', 'create_project', 'update_project',
      'add_project_repo', 'update_project_repo', 'remove_project_repo', 'reorder_project_repos',
      'add_project_resource', 'update_project_resource', 'remove_project_resource', 'reorder_project_resources',
      'archive_project', 'restore_project'
    ])
    // Structural: nothing named for a task, and nothing that starts, stops or approves anything.
    expect(names.filter((name) => /task|session|checkpoint|approve|reject|start|stop|delete/.test(name))).toEqual([])
    // No tool declares a confirmation token: there is no confirmation step.
    for (const entry of tools()) expect(Object.keys(entry.inputSchema.properties ?? {}), entry.name).not.toContain('confirmation_token')
  })

  /** A fresh database with a project, a repo and a resource, and a valid input for every mutating tool. */
  function mutationFixture(): Record<(typeof MUTATING_COMMANDER_TOOLS)[number], Record<string, unknown>> {
    ;({ db } = createTestDb())
    changes = []
    extra = { agents: fakeAgents() }
    const project = db.createProject({ name: 'Target' })!
    const repo = db.addProjectRepo(project.id, { name: 'api', org: 'acme' })!
    const resource = db.addProjectResource(project.id, { label: 'Runbook' })!
    return {
      pause_all_projects: { paused: true },
      create_project: { name: 'Another' },
      update_project: { project: project.id, changes: { name: 'Renamed' } },
      add_project_repo: { project: project.id, name: 'web' },
      update_project_repo: { project: project.id, repo_id: repo.id, changes: { name: 'api2' } },
      remove_project_repo: { project: project.id, repo_id: repo.id },
      reorder_project_repos: { project: project.id, ordered_ids: [repo.id] },
      add_project_resource: { project: project.id, label: 'Docs' },
      update_project_resource: { project: project.id, resource_id: resource.id, changes: { label: 'Runbook 2' } },
      remove_project_resource: { project: project.id, resource_id: resource.id },
      reorder_project_resources: { project: project.id, ordered_ids: [resource.id] },
      archive_project: { project: project.id },
      restore_project: { project: project.id }
    }
  }

  /** Calls one mutating tool once and proves the write happened on that first call. */
  async function expectActsOnFirstCall(name: (typeof MUTATING_COMMANDER_TOOLS)[number], input: Record<string, unknown>): Promise<void> {
    const output = await call(name, input)
    expect(output.isError, name).toBeUndefined()
    expect(body(output).status, name).toBe('ok')
    const action = parseCommanderActionResult(output.content)
    expect(action, name).not.toBeNull()
    expect(action!.changes.length, name).toBeGreaterThan(0)
    expect(action!.target.id, name).toBeTruthy()
    if (name === 'pause_all_projects') expect(extra.agents!.isAllProjectsPaused(), name).toBe(true)
    else expect(changes, name).toHaveLength(1)
  }

  it('acts on the first call of every mutating tool: no confirmation step', async () => {
    for (const name of MUTATING_COMMANDER_TOOLS) await expectActsOnFirstCall(name, mutationFixture()[name])
  })

  it('ignores a stray confirmation_token from the old two-step flow', async () => {
    for (const name of MUTATING_COMMANDER_TOOLS) await expectActsOnFirstCall(name, { ...mutationFixture()[name], confirmation_token: 'abc123def456' })
    // The token is ignored, not checked: a made-up one still changes exactly what was asked.
    const project = db.createProject({ name: 'Before' })!
    await call('update_project', { project: project.id, changes: { name: 'After' }, confirmation_token: 'made-up' })
    expect(db.getProject(project.id)?.name).toBe('After')
  })

  it('shares the complete severity vocabulary with the renderer', () => {
    const destructive = ['archive_project', 'remove_project_repo', 'remove_project_resource']
    const wide = ['pause_all_projects']
    for (const name of MUTATING_COMMANDER_TOOLS) {
      expect(commanderToolSeverity(name), name).toBe(destructive.includes(name) ? 'destructive' : wide.includes(name) ? 'wide-reaching' : 'neutral')
    }
    expect(Object.keys(COMMANDER_TOOL_SEVERITY).sort()).toEqual(
      [...MUTATING_COMMANDER_TOOLS, ...MUTATING_COMMANDER_SKILL_TOOLS].sort()
    )
  })

  it('caps every read result and rejects ambiguous exact-name lookup', async () => {
    const project = db.createProject({ name: 'Large', description: 'b'.repeat(20_000) })!
    for (let index = 0; index < 30; index++) {
      db.addProjectRepo(project.id, { name: `repo-${index}`, org: 'org' })
      db.addProjectResource(project.id, { label: `resource-${index}`, notes: 'n'.repeat(5_000) })
    }
    for (let index = 0; index < 55; index++) db.createProject({ name: `Project ${index} ${'x'.repeat(160)}`, description: 'd'.repeat(2_000) })

    for (const [name, input] of [
      ['list_projects', { include_archived: true }],
      ['get_project_summary', { project: project.id }],
      ['get_project', { project: project.id }],
      ['get_pending_approvals', {}]
    ] as const) {
      const output = await call(name, input)
      expect(output.content.length).toBeLessThanOrEqual(12_000)
    }
    const detail = body(await call('get_project', { project: project.id }))
    expect((detail.repos as unknown[]).length).toBeGreaterThan(0)
    expect((detail.repos as unknown[]).length).toBeLessThanOrEqual(20)
    expect((detail.resources as unknown[]).length).toBeGreaterThan(0)
    expect((detail.resources as unknown[]).length).toBeLessThanOrEqual(20)
    expect(detail.repos_truncated).toBe(true)
    expect(detail.resources_truncated).toBe(true)
    const listed = body(await call('list_projects', { include_archived: true }))
    expect((listed.projects as unknown[]).length).toBeGreaterThan(0)
    expect((listed.projects as unknown[]).length).toBeLessThanOrEqual(50)
    expect(listed.truncated).toBe(true)
    const summary = body(await call('get_project_summary', { project: project.id }))
    expect((summary.brief as string).length).toBeLessThanOrEqual(300)

    db.createProject({ name: 'Duplicate' })
    db.createProject({ name: 'Duplicate' })
    await expect(call('get_project', { project: 'Duplicate' })).rejects.toThrow(/ambiguous/i)
    await expect(call('get_project', { project: 'No such project' })).rejects.toThrow(/not found/i)
  })

  it('lists projects with the #58 counts and summarises one with its status and Captain state', async () => {
    const project = db.createProject({ name: 'Counted', description: 'First line\nSecond line' })!
    db.createTask({ title: 'Working', project_id: project.id, status: 'agent_working' })
    db.createTask({ title: 'Review me', project_id: project.id, status: 'ready_for_review' })
    db.createTask({ title: 'Nobody', project_id: project.id, status: 'not_started' })
    db.setProjectStatusSummary(project.id, 'Half way there.', ['Waiting on design'])

    const listed = body(await call('list_projects', {}))
    const entry = (listed.projects as Array<Record<string, unknown>>).find((item) => item.id === project.id)!
    expect(entry.name).toBe('Counted')
    expect(entry.brief).toBe('First line Second line')
    expect(entry.counts).toEqual({ running: 1, queued: 0, awaiting_review: 1, awaiting_approval: 0, blocked: 1 })
    expect(entry).not.toHaveProperty('tasks')
    // Archived projects are hidden unless asked for.
    db.archiveProject(project.id, true)
    expect((body(await call('list_projects', {})).projects as Array<Record<string, unknown>>).some((item) => item.id === project.id)).toBe(false)
    expect((body(await call('list_projects', { include_archived: true })).projects as Array<Record<string, unknown>>).some((item) => item.id === project.id)).toBe(true)
    db.archiveProject(project.id, false)

    const summary = body(await call('get_project_summary', { project: 'Counted' }))
    expect(summary).toMatchObject({
      id: project.id,
      counts: { running: 1, awaiting_review: 1, blocked: 1 },
      summary: 'Half way there.',
      top_blockers: ['Waiting on design'],
      captain: { session: 'unknown' }
    })
    expect(summary.limits).toBeNull()

    extra = { agents: fakeAgents() }
    const withAgents = body(await call('get_project_summary', { project: project.id }))
    expect(withAgents.captain).toEqual({ agent: null, session: 'not_running' })
    expect(withAgents.limits).toMatchObject({ paused: false, all_projects_paused: false, queued: 0 })
  })
})

describe('Commander tool registry with skill administration (#74)', () => {
  /** The registry ipc/commander.ts builds: project tools, then skill tools. */
  function fullRegistry(): ChatToolDefinition[] {
    const context = { sessionId: 'session-1' }
    return [...tools(), ...createCommanderSkillTools({ db, context })]
  }

  it('adds skill administration and still no task-mutating or skill-assigning tool', () => {
    const names = fullRegistry().map((entry) => entry.name)
    expect(names.slice(-7)).toEqual(['list_skills', 'get_skill', 'create_skill', 'update_skill', 'remove_skill', 'promote_skill', 'move_skill'])
    expect(new Set(names).size).toBe(names.length)
    expect(names.filter((name) => /task|session|checkpoint|approve|reject|start|stop|delete|assign/.test(name))).toEqual([])
    const mutating = new Set<string>([...MUTATING_COMMANDER_TOOLS, ...MUTATING_COMMANDER_SKILL_TOOLS])
    expect(mutating.size).toBe(18)
    for (const entry of fullRegistry()) {
      expect(Object.keys(entry.inputSchema.properties ?? {}), entry.name).not.toContain('confirmation_token')
      // No tool takes a task or skill_ids argument: the Commander cannot assign skills to tasks.
      const properties = Object.keys(entry.inputSchema.properties ?? {})
      expect(properties.filter((key) => /task|skill_ids/.test(key)), entry.name).toEqual([])
    }
  })

  it('says in every admin tool description that it takes effect immediately, and warns on the powerful ones', () => {
    const mutating = new Set<string>([...MUTATING_COMMANDER_TOOLS, ...MUTATING_COMMANDER_SKILL_TOOLS])
    const powerful = ['pause_all_projects', 'archive_project', 'remove_project_repo', 'remove_project_resource', 'remove_skill', 'promote_skill', 'move_skill']
    for (const entry of fullRegistry()) {
      if (!mutating.has(entry.name)) continue
      expect(entry.description, entry.name).toMatch(/immediately/i)
      expect(entry.description, entry.name).not.toMatch(/confirm|token/i)
      if (powerful.includes(entry.name)) expect(entry.description, entry.name).toMatch(/Destructive|Wide-reaching/)
    }
    expect(fullRegistry().find((entry) => entry.name === 'pause_all_projects')!.description).toMatch(/every project/i)
    expect(fullRegistry().find((entry) => entry.name === 'promote_skill')!.description).toMatch(/every project/i)
  })
})

describe('ask_captain', () => {
  it('sends a fenced relay to the project Captain and returns at once with a correlation id', async () => {
    const agent = db.createAgent({ name: 'Claude' })!
    const project = db.createProject({ name: 'Web' })!
    const coordinator = db.getCoordinatorTask(project.id)!
    // A Captain that never answers must not hold the Commander's turn.
    const sendMessage = vi.fn(() => new Promise<{ newSessionId?: string }>(() => {}))
    extra = { agents: fakeAgents({ sendMessage }) }

    const output = body(await call('ask_captain', { project: 'Web', message: 'Ship the landing page' }))
    expect(output).toMatchObject({ status: 'sent', project_id: project.id, project_name: 'Web', captain_session: 'starting' })
    expect(output.correlation_id).toMatch(/^cmd-[0-9a-f]{16}$/)

    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [sessionId, text, taskId, agentId] = sendMessage.mock.calls[0] as unknown as [string, string, string, string]
    expect(sessionId).toBe('')
    expect(taskId).toBe(coordinator.id)
    expect(agentId).toBe(agent.id)
    expect(text).toContain(COMMANDER_RELAY_BEGIN)
    expect(text).toContain(COMMANDER_RELAY_END)
    expect(text).toContain('Ship the landing page')
    expect(text).toContain(`correlation_id=${output.correlation_id}`)
    expect(text).toContain('commander_session=session-1')
    expect(text).toContain('human_authored=false authorizes_actions=false')
  })

  it('rejoins a live Captain session and reports a delivery failure after returning', async () => {
    db.createAgent({ name: 'Claude' })
    const project = db.createProject({ name: 'Live' })!
    const coordinator = db.getCoordinatorTask(project.id)!
    const failures: Array<{ dispatch: AskCaptainDispatch; error: unknown }> = []
    const sendMessage = vi.fn(async () => { throw new Error('runtime down') })
    extra = {
      agents: fakeAgents({
        sendMessage,
        findSessionByTaskId: (taskId: string) => taskId === coordinator.id ? { sessionId: 'live-1', session: { status: 'idle', agentId: 'agent-live' } } : undefined
      } as unknown as Partial<CommanderAgents>),
      onDeliveryFailed: (dispatch, error) => failures.push({ dispatch, error })
    }

    const output = body(await call('ask_captain', { project: project.id, message: 'Status?' }))
    expect(output.captain_session).toBe('running')
    expect(sendMessage.mock.calls[0]).toEqual(['live-1', expect.stringContaining('Status?'), coordinator.id, 'agent-live'])
    await vi.waitFor(() => expect(failures).toHaveLength(1))
    expect(failures[0].dispatch).toEqual({ sessionId: 'session-1', projectId: project.id, projectName: 'Live', correlationId: output.correlation_id })
    expect((failures[0].error as Error).message).toBe('runtime down')
  })

  it('refuses archived projects, missing agents and an absent agent manager', async () => {
    const project = db.createProject({ name: 'Old' })!
    extra = { agents: fakeAgents() }
    await expect(call('ask_captain', { project: project.id, message: 'hi' })).rejects.toThrow(/no agent/i)
    db.createAgent({ name: 'Claude' })
    db.archiveProject(project.id, true)
    await expect(call('ask_captain', { project: project.id, message: 'hi' })).rejects.toThrow(/archived/i)
    extra = {}
    await expect(call('ask_captain', { project: DEFAULT_PROJECT_ID, message: 'hi' })).rejects.toThrow(/not available/i)
    await expect(call('ask_captain', { project: DEFAULT_PROJECT_ID, message: '' })).rejects.toThrow(/message is required/i)
  })

  it('builds a relay message that quotes the request verbatim inside the fence', () => {
    const text = buildCommanderRelayMessage({ commanderSessionId: 's', correlationId: 'cmd-1', message: '  do the thing  ', sentAt: '2026-01-01T00:00:00.000Z' })
    const fenced = text.slice(text.indexOf(COMMANDER_RELAY_BEGIN) + COMMANDER_RELAY_BEGIN.length, text.indexOf(COMMANDER_RELAY_END)).trim()
    expect(fenced).toBe('do the thing')
    expect(text.split('\n')[1]).toBe('provenance: origin=commander-relay commander_session=s correlation_id=cmd-1 sent_at=2026-01-01T00:00:00.000Z human_authored=false authorizes_actions=false')
  })
})

describe('get_pending_approvals, navigate_to_project and pause_all_projects', () => {
  it('lists checkpoints and held actions across projects without any way to approve them', async () => {
    const alpha = db.createProject({ name: 'Alpha' })!
    const beta = db.createProject({ name: 'Beta' })!
    const waiting = db.createTask({ title: 'Deploy step', project_id: alpha.id, status: 'agent_working' })!
    db.createTask({ title: 'Quiet task', project_id: beta.id, status: 'agent_working' })
    const held: HeldAction[] = [
      { id: 'held-1', projectId: beta.id, action: 'start_task', tool: 'start_task', args: {}, summary: 'Start "Quiet task"', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'held-2', projectId: 'unknown-project', action: 'create_task', tool: 'create_task', args: {}, summary: 'Orphan', createdAt: '2026-01-01T00:00:00.000Z' }
    ]
    extra = {
      agents: fakeAgents({
        findSessionByTaskId: (taskId: string) => taskId === waiting.id ? { sessionId: 'sess-w', session: { status: 'waiting_approval', agentId: 'a' } } : undefined,
        getSessionStatus: (sessionId: string) => sessionId === 'sess-w' ? { status: 'waiting_approval', agentId: 'a', taskId: waiting.id } : null
      } as unknown as Partial<CommanderAgents>),
      listHeldActions: () => held
    }
    const output = body(await call('get_pending_approvals', {}))
    expect(output.total).toBe(2)
    expect(output.truncated).toBe(false)
    expect(output.approvals).toEqual([
      { kind: 'checkpoint', project_id: alpha.id, project: 'Alpha', task_id: waiting.id, title: 'Deploy step' },
      { kind: 'held_action', id: 'held-1', project_id: beta.id, project: 'Beta', action: 'start_task', summary: 'Start "Quiet task"', since: '2026-01-01T00:00:00.000Z' }
    ])
    expect(output.live_state_available).toBe(true)

    extra = {}
    expect(body(await call('get_pending_approvals', {}))).toMatchObject({ approvals: [], total: 0, live_state_available: false })
  })

  it('caps the approvals list', async () => {
    const project = db.createProject({ name: 'Busy' })!
    const held: HeldAction[] = Array.from({ length: 40 }, (_, index) => ({
      id: `h-${index}`, projectId: project.id, action: 'start_task', tool: 'start_task', args: {}, summary: 's'.repeat(500), createdAt: '2026-01-01T00:00:00.000Z'
    }))
    extra = { listHeldActions: () => held }
    const output = body(await call('get_pending_approvals', {}))
    expect((output.approvals as unknown[]).length).toBe(30)
    expect(output.total).toBe(40)
    expect(output.truncated).toBe(true)
    expect(((output.approvals as Array<Record<string, string>>)[0].summary).length).toBeLessThanOrEqual(200)
  })

  it('navigates through the UI command channel and refuses when no window is open', async () => {
    const project = db.createProject({ name: 'Shown' })!
    const sent: UiCommand[] = []
    extra = { sendUiCommand: (command) => { sent.push(command); return { ok: true } } }
    expect(body(await call('navigate_to_project', { project: 'Shown' }))).toEqual({ status: 'ok', project_id: project.id, project_name: 'Shown' })
    expect(sent).toEqual([{ kind: 'switch_project', projectId: project.id }])

    extra = { sendUiCommand: () => ({ ok: false, detail: 'No 21x window is open' }) }
    await expect(call('navigate_to_project', { project: project.id })).rejects.toThrow(/no 21x window/i)
    extra = {}
    await expect(call('navigate_to_project', { project: project.id })).rejects.toThrow(/no 21x window/i)
    db.archiveProject(project.id, true)
    extra = { sendUiCommand: () => ({ ok: true }) }
    await expect(call('navigate_to_project', { project: project.id })).rejects.toThrow(/archived/i)
  })

  it('pauses and resumes every project on the first call', async () => {
    const agents = fakeAgents()
    extra = { agents }
    expect(body(await call('pause_all_projects', { paused: true }))).toMatchObject({ status: 'ok', result: { all_projects_paused: true } })
    expect(agents.pauseAllProjects).toHaveBeenCalledWith(true)
    expect(body(await call('pause_all_projects', { paused: false }))).toMatchObject({ status: 'ok', result: { all_projects_paused: false } })
    expect(agents.isAllProjectsPaused()).toBe(false)
    await expect(call('pause_all_projects', { paused: 'yes' })).rejects.toThrow(/true or false/)
  })
})

describe('Commander project administration', () => {
  it('creates (with repos and a Captain), renames, archives and restores on the first call, and protects Default', async () => {
    const createdOutput = await call('create_project', { name: 'Lifecycle', brief: 'A brief', repos: [{ org: 'acme', name: 'api' }, { name: 'web', provider: 'gitlab', org: 'acme' }] })
    const created = body(createdOutput).result as Record<string, unknown>
    expect(created.name).toBe('Lifecycle')
    const projectId = created.id as string
    expect((created.repos as Array<Record<string, unknown>>).map((repo) => [repo.provider, repo.org, repo.name])).toEqual([['github', 'acme', 'api'], ['gitlab', 'acme', 'web']])
    expect(db.getCoordinatorTask(projectId)).toBeTruthy()
    expect(changes).toEqual([{ projectId, kind: 'created' }])

    await expect(call('create_project', { name: 'Bad repo', repos: [{ name: 'x', provider: 'svn' }] })).rejects.toThrow(/provider/)

    const renamed = body(await call('update_project', { project: projectId, changes: { name: 'Lifecycle 2', brief: 'Revised' } })).result as Record<string, unknown>
    expect(renamed).toMatchObject({ name: 'Lifecycle 2', brief: 'Revised' })
    await expect(call('update_project', { project: projectId, changes: { settings: {} } })).rejects.toThrow(/may only contain/)

    await expect(call('archive_project', { project: DEFAULT_PROJECT_ID })).rejects.toThrow(/cannot be archived/i)
    expect(db.getProject(DEFAULT_PROJECT_ID)?.archived).toBe(false)

    expect((body(await call('archive_project', { project: projectId })).result as Record<string, unknown>).archived).toBe(true)
    expect(db.getProject(projectId)?.archived).toBe(true)
    expect((body(await call('restore_project', { project: projectId })).result as Record<string, unknown>).archived).toBe(false)
    expect(db.getProject(projectId)?.archived).toBe(false)
    expect(changes.map((change) => change.kind)).toEqual(['created', 'updated', 'archived', 'restored'])
  })

  it('maintains repos and resources through stable IDs', async () => {
    const project = db.createProject({ name: 'Context' })!
    const repo = body(await call('add_project_repo', { project: project.id, name: 'api', org: 'acme' })).result as Record<string, unknown>
    const resource = body(await call('add_project_resource', { project: project.id, label: 'Runbook', url: 'docs.example.com/runbook', notes: 'Ask ops' })).result as Record<string, unknown>
    expect(resource.url).toBe('https://docs.example.com/runbook')

    const repoId = repo.id as string
    const resourceId = resource.id as string

    await call('update_project_repo', { project: project.id, repo_id: repoId, changes: { default_branch: 'develop' } })
    const longNotes = 'Updated details. '.repeat(100).trim()
    const resourceUpdate = await call('update_project_resource', { project: project.id, resource_id: resourceId, changes: { notes: longNotes } })
    expect(db.getProjectRepo(repoId)?.default_branch).toBe('develop')
    expect(db.getProjectResource(resourceId)?.notes).toBe(longNotes)
    expect(parseCommanderActionResult(resourceUpdate.content)?.changes).toContainEqual({
      field: 'notes', before: 'Ask ops', after: longNotes
    })

    // A repo belongs to its project: another project cannot edit it.
    const other = db.createProject({ name: 'Other' })!
    await expect(call('update_project_repo', { project: other.id, repo_id: repoId, changes: { name: 'x' } })).rejects.toThrow(/not found in that project/)
    await expect(call('reorder_project_repos', { project: project.id, ordered_ids: [] })).rejects.toThrow(/every current repository ID/)
    await expect(call('add_project_resource', { project: project.id, label: 'Bad', url: 'javascript:alert(1)' })).rejects.toThrow(/HTTP/)

    await call('reorder_project_repos', { project: project.id, ordered_ids: [repoId] })
    await call('reorder_project_resources', { project: project.id, ordered_ids: [resourceId] })
    await call('remove_project_repo', { project: project.id, repo_id: repoId })
    await call('remove_project_resource', { project: project.id, resource_id: resourceId })
    expect(db.getProjectRepos(project.id)).toEqual([])
    expect(db.getProjectResources(project.id)).toEqual([])
    expect(changes.map((change) => change.kind)).toEqual(['repos', 'resources', 'repos', 'resources', 'repos', 'resources', 'repos', 'resources'])
  })
})
