/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeAgent, makeTask } from '../../test/helpers/task-fixtures'
import { AgentManager } from './agent-manager'
import { TaskStatus } from '../shared/constants'
import { FINDINGS_BEGIN, SYSTEM_MESSAGE_MARKER } from '../shared/system-authority'
import type { DatabaseManager, TaskRecord } from './database'

/**
 * Per-project limits and pause (#65) through AgentManager.requestSession,
 * against a real in-memory database. Only the backend spawn (startSessionNow)
 * is replaced, like agent-manager-admission.test.ts: it registers a working
 * session the way a real start does, so counting, idling and the queue drain
 * are the production code.
 */

vi.mock('child_process', () => ({ spawn: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  Notification: class { show = vi.fn(); on = vi.fn(); static isSupported = vi.fn(() => false) },
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn(), isStarted: vi.fn(() => false) }
}))
vi.mock('./adapters/opencode-adapter', () => ({ OpencodeAdapter: vi.fn() }))
vi.mock('./adapters/claude-code-adapter', () => ({ ClaudeCodeAdapter: vi.fn() }))
vi.mock('./adapters/acp-adapter', () => ({ AcpAdapter: vi.fn() }))
vi.mock('./adapters/codex-app-server-adapter', () => ({ CodexAppServerAdapter: vi.fn() }))
vi.mock('./adapters/pi-adapter', () => ({ PiAdapter: vi.fn() }))
vi.mock('./secret-broker', () => ({
  registerSecretSession: vi.fn(),
  unregisterSecretSession: vi.fn(),
  getSecretBrokerPort: vi.fn(),
  writeSecretShellWrapper: vi.fn()
}))

interface Harness {
  db: DatabaseManager
  manager: AgentManager
  agentId: string
  /** Task ids whose session was really started, in order. */
  started: string[]
  createProject: (name: string, limits?: Record<string, unknown>) => string
  createTask: (projectId: string, title?: string) => TaskRecord
}

function setup(): Harness {
  const { db } = createTestDb()
  const manager = new AgentManager(db)
  vi.spyOn(manager as any, 'sendToRenderer').mockImplementation(() => undefined)
  vi.spyOn(manager as any, 'getAdapter').mockReturnValue(null)

  const started: string[] = []
  let sequence = 0
  vi.spyOn(manager as any, 'startSessionNow').mockImplementation(async (...args: unknown[]) => {
    const [agentId, taskId] = args as [string, string]
    const id = `session-${++sequence}`
    ;(manager as any).sessions.set(id, {
      id,
      agentId,
      taskId,
      status: 'working',
      createdAt: new Date(),
      seenMessageIds: new Set(),
      seenPartIds: new Set(),
      partContentLengths: new Map()
    })
    if (db.getTask(taskId)) db.updateTask(taskId, { status: TaskStatus.AgentWorking, session_id: id })
    started.push(taskId)
    return id
  })

  // A roomy agent, so only the project limits decide.
  const agentId = db.createAgent(makeAgent({ name: 'Roomy', config: { max_parallel_sessions: 10 } as any }))!.id

  // Captain control off (#150): the level is the agent's cap, so only the
  // project limits decide. Levels are covered by agent-manager-concurrency.test.ts.
  const createProject = (name: string, limits?: Record<string, unknown>): string =>
    db.createProject({ name, settings: { ...(limits ? { limits } : {}), concurrency: { captain_control: false } } })!.id

  const createTask = (projectId: string, title = 'Task'): TaskRecord => {
    const task = db.createTask(makeTask({ title, project_id: projectId }))!
    return db.updateTask(task.id, { agent_id: agentId })!
  }

  return { db, manager, agentId, started, createProject, createTask }
}

/** Lets the deferred queue drain (setImmediate) and the async starts settle. */
async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

/** Goes idle through the same status transition the poller uses. */
function goIdle(manager: AgentManager, taskId: string): void {
  const found = manager.findSessionByTaskId(taskId)!
  found.session.status = 'idle'
  ;(manager as any).emitStatus(found.sessionId, found.session, 'idle')
}

function setLimits(db: DatabaseManager, projectId: string, limits: Record<string, unknown>): void {
  const project = db.getProject(projectId)!
  const current = (project.settings.limits as Record<string, unknown> | undefined) ?? {}
  db.updateProject(projectId, { settings: { ...project.settings, limits: { ...current, ...limits } } })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('per-project limits (#65)', () => {
  it('queues a start over the project cap with project_limit, while another project still starts', async () => {
    const h = setup()
    const p1 = h.createProject('Capped', { max_concurrent_agents: 1 })
    const p2 = h.createProject('Free')
    const [a, b] = [h.createTask(p1, 'A'), h.createTask(p1, 'B')]
    const c = h.createTask(p2, 'C')

    expect((await h.manager.requestSession(h.agentId, a.id)).status).toBe('started')
    const queued = await h.manager.requestSession(h.agentId, b.id)
    expect(queued).toMatchObject({ status: 'queued', reason: 'project_limit', position: 1 })
    expect((await h.manager.requestSession(h.agentId, c.id)).status).toBe('started')
    expect(h.started).toEqual([a.id, c.id])

    const state = h.manager.getProjectLimitState(p1)
    expect(state).toMatchObject({ runningAgents: 1, maxConcurrentAgents: 1, blockedBy: 'project_limit' })
    expect(state.queued.map((entry) => entry.taskId)).toEqual([b.id])

    // A slot in the project frees: the queued start runs.
    goIdle(h.manager, a.id)
    await settle()
    expect(h.started).toEqual([a.id, c.id, b.id])
    expect(h.manager.getStartQueue()).toEqual([])
  })

  it('queues with project_daily_cap once the day is used up, and a freed slot does not help', async () => {
    const h = setup()
    const p1 = h.createProject('Daily', { daily_session_cap: 1 })
    const [a, b] = [h.createTask(p1, 'A'), h.createTask(p1, 'B')]

    expect((await h.manager.requestSession(h.agentId, a.id)).status).toBe('started')
    expect(h.manager.getProjectLimitState(p1).sessionsStartedToday).toBe(1)
    expect(await h.manager.requestSession(h.agentId, b.id)).toMatchObject({ status: 'queued', reason: 'project_daily_cap' })

    goIdle(h.manager, a.id)
    await settle()
    expect(h.started).toEqual([a.id])
    expect(h.manager.getStartQueue().map((entry) => entry.taskId)).toEqual([b.id])

    // Raising the cap and re-checking (what saving the project does) lets it through.
    setLimits(h.db, p1, { daily_session_cap: 5 })
    h.manager.recheckStartQueue()
    await settle()
    expect(h.started).toEqual([a.id, b.id])
  })

  it('pausing a project stops new starts, leaves running sessions alone, and unpausing drains the queue', async () => {
    const h = setup()
    const p1 = h.createProject('Pausable')
    const [a, b, c] = [h.createTask(p1, 'A'), h.createTask(p1, 'B'), h.createTask(p1, 'C')]
    expect((await h.manager.requestSession(h.agentId, a.id)).status).toBe('started')

    setLimits(h.db, p1, { paused: true })
    expect(await h.manager.requestSession(h.agentId, b.id)).toMatchObject({ status: 'queued', reason: 'project_paused' })
    expect(await h.manager.requestSession(h.agentId, c.id)).toMatchObject({ status: 'queued', reason: 'project_paused', position: 2 })
    // The session that was already running is untouched.
    expect(h.manager.findSessionByTaskId(a.id)?.session.status).toBe('working')
    expect(h.manager.getProjectLimitState(p1)).toMatchObject({ paused: true, blockedBy: 'project_paused', runningAgents: 1 })

    // A freed slot changes nothing while paused.
    goIdle(h.manager, a.id)
    await settle()
    expect(h.started).toEqual([a.id])

    setLimits(h.db, p1, { paused: false })
    h.manager.recheckStartQueue()
    await settle()
    expect(h.started).toEqual([a.id, b.id, c.id])
    expect(h.manager.getStartQueue()).toEqual([])
  })

  it('the global pause stops starts in every project and lifting it drains them', async () => {
    const h = setup()
    const p1 = h.createProject('One')
    const p2 = h.createProject('Two')
    const [a, b] = [h.createTask(p1, 'A'), h.createTask(p2, 'B')]

    h.manager.pauseAllProjects(true)
    expect(h.manager.isAllProjectsPaused()).toBe(true)
    expect(await h.manager.requestSession(h.agentId, a.id)).toMatchObject({ status: 'queued', reason: 'global_pause' })
    expect(await h.manager.requestSession(h.agentId, b.id)).toMatchObject({ status: 'queued', reason: 'global_pause' })
    expect(h.manager.getProjectLimitState(p2)).toMatchObject({ allProjectsPaused: true, blockedBy: 'global_pause' })

    h.manager.pauseAllProjects(false)
    await settle()
    expect(h.started).toEqual([a.id, b.id])
  })

  it('a queued start takes on the current reason: a project that pauses while its start waits', async () => {
    const h = setup()
    const p1 = h.createProject('Shifting', { max_concurrent_agents: 1 })
    const [a, b] = [h.createTask(p1, 'A'), h.createTask(p1, 'B')]
    await h.manager.requestSession(h.agentId, a.id)
    expect(await h.manager.requestSession(h.agentId, b.id)).toMatchObject({ reason: 'project_limit' })

    setLimits(h.db, p1, { paused: true })
    goIdle(h.manager, a.id)
    await settle()
    expect(h.started).toEqual([a.id])
    expect(h.manager.getStartQueue()[0]).toMatchObject({ taskId: b.id, reason: 'project_paused' })
  })

  it('the Captain (coordinator row) bypasses a paused project and the global pause', async () => {
    const h = setup()
    const p1 = h.createProject('Paused', { paused: true })
    h.manager.pauseAllProjects(true)
    const coordinator = h.db.getCoordinatorTask(p1)!
    expect(coordinator).toBeTruthy()
    expect((await h.manager.requestSession(h.agentId, coordinator.id)).status).toBe('started')
    // And it does not count against the project's concurrency.
    expect(h.manager.getProjectLimitState(p1).runningAgents).toBe(0)
  })

  it('tells a live, idle Captain why a start waits, once per project and reason', async () => {
    const h = setup()
    const p1 = h.createProject('Told', { paused: true })
    const coordinator = h.db.getCoordinatorTask(p1)!
    await h.manager.requestSession(h.agentId, coordinator.id)
    goIdle(h.manager, coordinator.id)
    const sendMessage = vi.spyOn(h.manager, 'sendMessage').mockResolvedValue({})

    const [a, b] = [h.createTask(p1, 'Alpha'), h.createTask(p1, 'Beta')]
    await h.manager.requestSession(h.agentId, a.id)
    await h.manager.requestSession(h.agentId, b.id)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [sessionId, message, taskId] = sendMessage.mock.calls[0]
    expect(sessionId).toBe(h.manager.findSessionByTaskId(coordinator.id)!.sessionId)
    expect(taskId).toBe(coordinator.id)
    expect(message).toContain(SYSTEM_MESSAGE_MARKER)
    expect(message).toContain(FINDINGS_BEGIN)
    expect(message).toContain('Alpha')
    expect(message).toContain('paused')

    // No live session, or a busy one: nothing is sent.
    const p2 = h.createProject('Silent', { paused: true })
    await h.manager.requestSession(h.agentId, h.createTask(p2, 'Gamma').id)
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
})
