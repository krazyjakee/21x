/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'crypto'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeAgent, makeTask } from '../../test/helpers/task-fixtures'
import { AgentManager } from './agent-manager'
import { handleSessionRoute } from './task-api/session-routes'
import { setTaskApiAgentController } from './task-api/state'
import { TaskAutomationScheduler } from './task-automation-scheduler'
import { prepareUserTaskUpdate } from './task-updates'
import { startMobileApiServer, stopMobileApiServer } from './mobile-api-server'
import { MAX_CONCURRENT_AGENT_SESSIONS_SETTING } from './agent-manager/admission'
import { TaskStatus } from '../shared/constants'
import { DEFAULT_PROJECT_ID } from '../shared/projects'
import type { DatabaseManager, TaskRecord } from './database'

/**
 * Admission control (#47): every start path goes through AgentManager, which
 * enforces agent.config.max_parallel_sessions and the global cap, queues what
 * does not fit, and starts it when a slot frees — with no renderer involved.
 *
 * Runs against a real in-memory database. Only the backend spawn
 * (startSessionNow) is replaced: it registers a working session the way a
 * real start does, so counting, stopping and idling are the production code.
 */

vi.mock('child_process', () => ({ spawn: vi.fn() }))
vi.mock('./agent-manager/workspace-docs', async (importOriginal) => ({
  ...await importOriginal<typeof import('./agent-manager/workspace-docs')>(),
  writeSkillFiles: vi.fn(async () => undefined)
}))
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

const LIMIT = 2

interface Harness {
  db: DatabaseManager
  manager: AgentManager
  agentId: string
  /** Task ids whose session was really started, in order. */
  started: string[]
  createTasks: (count: number, overrides?: Parameters<typeof makeTask>[0], agentId?: string) => TaskRecord[]
  createAgent: (maxParallel: number) => string
}

function setup(maxParallel = LIMIT): Harness {
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

  // Captain control off in the Default project (#150): the working level is
  // the agent's hard cap, so this suite sees only the cap and the global limit.
  // Levels are covered by agent-manager-concurrency.test.ts.
  db.updateProject(DEFAULT_PROJECT_ID, { settings: { concurrency: { captain_control: false } } })

  const createAgent = (limit: number): string =>
    db.createAgent(makeAgent({ name: `Agent ${limit}`, config: { max_parallel_sessions: limit } as any }))!.id
  const agentId = createAgent(maxParallel)

  const createTasks = (count: number, overrides: Parameters<typeof makeTask>[0] = {}, forAgent = agentId): TaskRecord[] =>
    Array.from({ length: count }, (_, i) => {
      const task = db.createTask(makeTask({ title: `Task ${i + 1}`, ...overrides }))!
      return db.updateTask(task.id, { agent_id: forAgent })!
    })

  return { db, manager, agentId, started, createTasks, createAgent }
}

/** Lets the deferred queue drain (setImmediate) and the async starts settle. */
async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

function sessionIdFor(manager: AgentManager, taskId: string): string {
  return manager.findSessionByTaskId(taskId)!.sessionId
}

/** Goes idle through the same status transition the poller uses. */
function goIdle(manager: AgentManager, taskId: string): void {
  const found = manager.findSessionByTaskId(taskId)!
  found.session.status = 'idle'
  ;(manager as any).emitStatus(found.sessionId, found.session, 'idle')
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(async () => {
  vi.useRealTimers()
  setTaskApiAgentController(null)
  await stopMobileApiServer()
})

describe('admission control — AgentManager.startTask', () => {
  it('does not acknowledge a move until an in-flight start is stopped', async () => {
    const { db, manager, createTasks } = setup(1)
    const [task] = createTasks(1)
    const spawn = vi.mocked((manager as any).startSessionNow)
    const original = spawn.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    spawn.mockImplementationOnce(async (...args: unknown[]) => { await gate; return original(...args) })
    const start = manager.startTask(task.id).catch(() => undefined)
    let stopped = false
    const stop = manager.stopByTaskId(task.id).then(() => { stopped = true })
    await settle()
    expect(stopped).toBe(false)
    release()
    await Promise.all([start, stop])
    expect(manager.hasTaskStartOwnership(task.id)).toBe(false)
    expect(db.getTask(task.id)?.status).toBe(TaskStatus.NotStarted)
  })

  it('refuses a move and keeps live ownership when the backend cannot stop', async () => {
    const { db, manager, createTasks } = setup(1)
    const [task] = createTasks(1)
    await manager.startTask(task.id)
    vi.spyOn(manager as any, 'buildSessionConfig').mockResolvedValue({})
    vi.mocked((manager as any).getAdapter).mockReturnValue({ destroySession: vi.fn().mockRejectedValue(new Error('stop refused')) })
    await expect(prepareUserTaskUpdate(manager, db.getTask(task.id)!, { status: TaskStatus.ReadyForReview })).rejects.toThrow('stop refused')
    expect(manager.hasTaskStartOwnership(task.id)).toBe(true)
    expect(db.getTask(task.id)?.status).toBe(TaskStatus.AgentWorking)
  })

  it('preserves the retained session for explicit feedback learning', async () => {
    const { db, manager, createTasks } = setup(1)
    const [task] = createTasks(1)
    await manager.startTask(task.id)
    goIdle(manager, task.id)
    db.updateTask(task.id, { status: TaskStatus.ReadyForReview })
    const stop = vi.spyOn(manager, 'stopByTaskId')
    await prepareUserTaskUpdate(manager, db.getTask(task.id)!, { status: TaskStatus.AgentLearning, feedback_rating: 4 })
    expect(stop).not.toHaveBeenCalled()
    expect(manager.findSessionByTaskId(task.id)).toBeDefined()
  })

  it('runs exactly N of N+1 tasks and queues one, which starts when a slot frees', async () => {
    const { manager, started, createTasks } = setup()
    const tasks = createTasks(LIMIT + 1)

    const results: Awaited<ReturnType<AgentManager['startTask']>>[] = []
    for (const task of tasks) results.push(await manager.startTask(task.id))

    expect(results.slice(0, LIMIT).map((r) => r.action)).toEqual(['task_started', 'task_started'])
    expect(results[LIMIT]).toMatchObject({ action: 'queued', queuePosition: 1, queueReason: 'agent_limit', startedTaskId: tasks[LIMIT].id })
    expect(started).toEqual(tasks.slice(0, LIMIT).map((t) => t.id))
    expect(manager.getStartQueue().map((q) => q.taskId)).toEqual([tasks[LIMIT].id])

    await manager.stopSession(sessionIdFor(manager, tasks[0].id))
    await settle()

    expect(started).toEqual([tasks[0].id, tasks[1].id, tasks[2].id])
    expect(manager.getStartQueue()).toEqual([])
  })

  it('dedupes a repeated start of a queued task', async () => {
    const { manager, createTasks } = setup()
    const tasks = createTasks(LIMIT + 1)
    for (const task of tasks) await manager.startTask(task.id)

    const again = await manager.startTask(tasks[LIMIT].id)

    expect(again).toMatchObject({ action: 'queued', queuePosition: 1 })
    expect(manager.getStartQueue()).toHaveLength(1)
  })

  it('withdraws a queued start when the task is stopped', async () => {
    const { manager, started, createTasks } = setup()
    const tasks = createTasks(LIMIT + 1)
    for (const task of tasks) await manager.startTask(task.id)

    await manager.stopByTaskId(tasks[LIMIT].id)
    await manager.stopSession(sessionIdFor(manager, tasks[0].id))
    await settle()

    expect(manager.getStartQueue()).toEqual([])
    expect(started).not.toContain(tasks[LIMIT].id)
  })

  it('keeps manual stop terminal for automation but lets an explicit board start resume once', async () => {
    const { manager, started, createTasks } = setup(1)
    const [task] = createTasks(1)
    await manager.startTask(task.id)

    await manager.stopByTaskId(task.id)
    expect(manager.getStartRecoveryState(task.id)).toMatchObject({ state: 'cancelled', recoveryCause: 'manual_stop' })
    await expect(manager.startTask(task.id)).rejects.toThrow(/Automatic start stopped/)

    expect(await manager.startTask(task.id, { resumeManualStop: true })).toMatchObject({ action: 'queued' })
    await settle()
    expect(started).toEqual([task.id, task.id])
    expect(manager.getStartRecoveryState(task.id)).toMatchObject({ state: 'started', recoveryResult: 'session_acknowledged' })
  })

  it('lets only a person lift a start that recovery excluded after a failure', async () => {
    const { manager, started, createTasks } = setup(1)
    const [task] = createTasks(1)
    await manager.startTask(task.id)
    await manager.stopSession(sessionIdFor(manager, task.id))
    await settle()
    // The state recovery leaves after a failed start with an unfinished tool call.
    ;(manager as any).db.db.prepare(`
      UPDATE agent_start_queue SET state = 'cancelled', recovery_cause = 'unsafe_side_effect_unknown',
        recovery_action = 'exclude_from_retry', recovery_result = 'excluded_failure_not_retried'
      WHERE task_id = ?
    `).run(task.id)

    await expect(manager.startTask(task.id)).rejects.toThrow(/excluded_failure_not_retried/)
    // The agent task API passes resumeManualStop only; it cannot lift this.
    await expect(manager.startTask(task.id, { resumeManualStop: true })).rejects.toThrow(/excluded_failure_not_retried/)

    expect(await manager.startTask(task.id, { resumeManualStop: true, explicitUserStart: true })).toMatchObject({ action: 'queued' })
    await settle()
    expect(started).toEqual([task.id, task.id])
    expect(manager.getStartRecoveryState(task.id)).toMatchObject({ state: 'started', recoveryResult: 'session_acknowledged' })
  })

  it('restarts only the selected child, leaving a manually stopped parent excluded', async () => {
    const { manager, createTasks, started } = setup(2)
    const [parent] = createTasks(1)
    const [child] = createTasks(1, { parent_task_id: parent.id })
    await manager.stopByTaskId(parent.id)
    await manager.stopByTaskId(child.id)
    expect(await manager.startTask(parent.id, { resumeManualStop: true })).toMatchObject({ action: 'queued', startedTaskId: child.id })
    await settle()
    expect(started).toEqual([child.id])
    expect(manager.getStartRecoveryState(parent.id)).toMatchObject({ state: 'cancelled', recoveryCause: 'manual_stop' })
  })
})

describe('admission control — AgentManager.startSession', () => {
  it('runs exactly N, queues one, and starts it when a running session goes idle', async () => {
    const { manager, agentId, started, createTasks } = setup()
    const tasks = createTasks(LIMIT + 1)

    const ids: string[] = []
    for (const task of tasks) ids.push(await manager.startSession(agentId, task.id))

    expect(ids.slice(0, LIMIT).every(Boolean)).toBe(true)
    expect(ids[LIMIT]).toBe('')
    expect(started).toHaveLength(LIMIT)
    expect(manager.getStartQueue()).toEqual([expect.objectContaining({ taskId: tasks[LIMIT].id, position: 1 })])

    goIdle(manager, tasks[1].id)
    await settle()

    expect(started).toEqual(tasks.map((t) => t.id))
    expect(manager.getStartQueue()).toEqual([])
  })

  it('reports the queue position through requestSession', async () => {
    const { manager, agentId, createTasks } = setup(1)
    const tasks = createTasks(3)

    const outcomes: Awaited<ReturnType<AgentManager['requestSession']>>[] = []
    for (const task of tasks) outcomes.push(await manager.requestSession(agentId, task.id))

    expect(outcomes.map((o) => o.status)).toEqual(['started', 'queued', 'queued'])
    expect(outcomes.slice(1).map((o) => (o as { position: number }).position)).toEqual([1, 2])
  })

  it('persists and retries a recoverable failure from an immediately admitted start', async () => {
    const { manager, agentId, createTasks } = setup(1)
    const [task] = createTasks(1)
    ;(manager as any).startSessionNow.mockRejectedValueOnce(new Error('agent temporarily unavailable'))

    await expect(manager.requestSession(agentId, task.id)).rejects.toThrow('agent temporarily unavailable')

    expect(manager.getStartRecoveryState(task.id)).toMatchObject({
      state: 'retrying',
      retryCount: 1,
      recoveryCause: 'recoverable_start_failure',
      recoveryAction: 'retry'
    })
    expect(manager.getStartQueue()).toEqual([expect.objectContaining({ taskId: task.id, state: 'retrying' })])
    await manager.stopAllSessions()
  })

  it('holds a successor on its durable dependency and drains it after the predecessor finishes', async () => {
    const { db, manager, agentId, started, createTasks } = setup(2)
    const parent = db.createTask(makeTask({ title: 'Parent', auto_start_agent: true }))!
    const [first, second] = createTasks(2, { parent_task_id: parent.id })
    db.updateTask(first.id, { next_subtask_ids: [second.id] })

    await manager.requestSession(agentId, first.id)
    expect(await manager.requestSession(agentId, second.id)).toMatchObject({ status: 'queued', reason: 'dependency' })
    expect(manager.getStartRecoveryState(second.id)).toMatchObject({
      state: 'queued',
      reason: 'dependency',
      dependencyReason: 'predecessor_active'
    })

    db.updateTask(first.id, { status: TaskStatus.ReadyForReview })
    goIdle(manager, first.id)
    await settle()

    expect(started).toEqual([first.id, second.id])
    expect(manager.getStartQueue()).toEqual([])
  })
})

describe('admission control — MCP start_task', () => {
  it('runs exactly N, reports the extra one as queued, and starts it when a slot frees', async () => {
    const { db, manager, started, createTasks } = setup()
    setTaskApiAgentController(manager)
    const tasks = createTasks(LIMIT + 1)

    const results: Record<string, unknown>[] = []
    for (const task of tasks) {
      results.push(await handleSessionRoute(db, '/start_task', { task_id: task.id }) as Record<string, unknown>)
    }

    expect(results.slice(0, LIMIT).map((r) => r.action)).toEqual(['task_started', 'task_started'])
    expect(results[LIMIT]).toMatchObject({ success: true, action: 'queued', queue_position: 1 })
    expect(results[LIMIT].message).toMatch(/Queued at position 1/)
    expect(started).toHaveLength(LIMIT)

    goIdle(manager, tasks[0].id)
    await settle()
    expect(started).toContain(tasks[LIMIT].id)
  })

  it('start_sibling_subtask (prefer_subtasks false) is queued the same way', async () => {
    const { db, manager, started, createTasks } = setup()
    setTaskApiAgentController(manager)
    const parent = db.createTask(makeTask({ title: 'Parent' }))!
    const subtasks = createTasks(LIMIT + 1, { parent_task_id: parent.id })

    const results: Record<string, unknown>[] = []
    for (const subtask of subtasks) {
      results.push(await handleSessionRoute(db, '/start_task', { task_id: subtask.id, prefer_subtasks: false }) as Record<string, unknown>)
    }

    expect(results.map((r) => r.action)).toEqual(['task_started', 'task_started', 'queued'])
    expect(started).toHaveLength(LIMIT)
  })
})

describe('admission control — mobile /api/sessions/start', () => {
  it('runs exactly N, reports the extra one as queued, and starts it when a slot frees', async () => {
    const { db, manager, agentId, started, createTasks } = setup()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const token = 'mobile-token'
    db.createMobileSession('mobile-1', createHash('sha256').update(token).digest('hex'), 'test-device')
    const port = await startMobileApiServer(db, manager, {} as never, 0)
    const tasks = createTasks(LIMIT + 1)

    const results: Record<string, unknown>[] = []
    for (const task of tasks) {
      const response = await fetch(`http://127.0.0.1:${port}/api/sessions/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, taskId: task.id })
      })
      results.push(await response.json() as Record<string, unknown>)
    }

    expect(results.slice(0, LIMIT).every((r) => typeof r.sessionId === 'string' && r.sessionId)).toBe(true)
    expect(results[LIMIT]).toMatchObject({ sessionId: '', queued: true, queuePosition: 1 })
    expect(started).toHaveLength(LIMIT)

    await manager.stopSession(sessionIdFor(manager, tasks[1].id))
    await settle()
    expect(started).toContain(tasks[LIMIT].id)
  })
})

describe('admission control — TaskAutomationScheduler', () => {
  it('runs exactly N auto-start tasks, queues one, and starts it when a slot frees', async () => {
    const { db, manager, started, createTasks } = setup()
    const tasks = createTasks(LIMIT + 1, { auto_start_agent: true })

    await new TaskAutomationScheduler(db, manager).runNow()

    expect(started).toHaveLength(LIMIT)
    expect(manager.getStartQueue()).toHaveLength(1)

    // A second sweep asks again and gets the same queue slot back.
    await new TaskAutomationScheduler(db, manager).runNow()
    expect(started).toHaveLength(LIMIT)
    expect(manager.getStartQueue()).toHaveLength(1)

    const runningTaskId = started[0]
    goIdle(manager, runningTaskId)
    await settle()
    expect(started).toHaveLength(LIMIT + 1)
    expect(new Set(started)).toEqual(new Set(tasks.map((t) => t.id)))
  })
})

describe('admission control — global cap', () => {
  it('caps working sessions across agents and drains in FIFO order', async () => {
    const { db, manager, started, createTasks, createAgent } = setup(5)
    db.setSetting(MAX_CONCURRENT_AGENT_SESSIONS_SETTING, '2')
    const otherAgent = createAgent(5)
    const [a1, a2] = createTasks(2)
    const [b1, b2] = createTasks(2, {}, otherAgent)

    expect((await manager.startTask(a1.id)).action).toBe('task_started')
    expect((await manager.startTask(b1.id)).action).toBe('task_started')
    expect(await manager.startTask(a2.id)).toMatchObject({ action: 'queued', queueReason: 'global_limit', queuePosition: 1 })
    expect(await manager.startTask(b2.id)).toMatchObject({ action: 'queued', queueReason: 'global_limit', queuePosition: 2 })

    goIdle(manager, a1.id)
    await settle()

    expect(started).toEqual([a1.id, b1.id, a2.id])
    expect(manager.getStartQueue().map((q) => q.taskId)).toEqual([b2.id])
  })

  it('treats an empty or zero setting as unlimited', async () => {
    const { db, manager, started, createTasks } = setup(10)
    db.setSetting(MAX_CONCURRENT_AGENT_SESSIONS_SETTING, '0')
    for (const task of createTasks(4)) await manager.startTask(task.id)
    expect(started).toHaveLength(4)
  })
})

describe('admission control — exempt sessions', () => {
  function makeCoordinator(db: DatabaseManager): string {
    const row = db.createTask(makeTask({ title: 'Captain' }))!
    db.db.prepare("UPDATE tasks SET role = 'captain' WHERE id = ?").run(row.id)
    return row.id
  }

  it('a coordinator start bypasses a full agent and does not take a slot', async () => {
    const { db, manager, agentId, started, createTasks } = setup(1)
    const coordinatorId = makeCoordinator(db)
    const [task1, task2] = createTasks(2)

    expect((await manager.startTask(task1.id)).action).toBe('task_started')
    // Agent full, but the Captain is not counted or queued.
    expect(await manager.requestSession(agentId, coordinatorId)).toMatchObject({ status: 'started' })
    expect(started).toEqual([task1.id, coordinatorId])

    await manager.stopSession(sessionIdFor(manager, task1.id))
    // The working Captain does not hold the freed slot.
    expect((await manager.startTask(task2.id)).action).toBe('task_started')
  })

  it('heartbeat and triage sessions bypass the limits', async () => {
    const { db, manager, agentId, started, createTasks } = setup(1)
    const [task1] = createTasks(1)
    await manager.startTask(task1.id)

    expect(await manager.requestSession(agentId, `heartbeat-${task1.id}`)).toMatchObject({ status: 'started' })

    const untriaged = db.createTask(makeTask({ title: 'Needs triage', status: TaskStatus.Triaging }))!
    expect(await manager.requestSession(agentId, untriaged.id)).toMatchObject({ status: 'started' })
    expect(started).toHaveLength(3)
    expect(manager.getStartQueue()).toEqual([])
  })
})

describe('startup self-healing (#148)', () => {
  it('does not replay a crashed triage claim as an ordinary assigned run', async () => {
    const { db, manager, agentId, createTasks, started } = setup(1)
    const [task] = createTasks(1, { status: TaskStatus.Triaging })
    const queue = (manager as any).startQueue
    queue.enqueue({ taskId: task.id, agentId, projectId: task.project_id, reason: 'recovery', queuedAt: new Date().toISOString() })
    const claim = queue.claim(task.id, 'previous-process')
    queue.markStarting(claim.id, claim.generation)
    await manager.reconcileStartup()
    await settle()
    expect(started).toEqual([])
    expect(db.getTask(task.id)?.status).toBe(TaskStatus.NotStarted)
    expect(manager.getStartRecoveryState(task.id)).toMatchObject({ state: 'failed', recoveryCause: 'orphaned_triage' })
  })

  it('immediately repairs a direct agent_working write through one stable durable row', async () => {
    const { db, manager, started, createTasks } = setup(1)
    const [task] = createTasks(1)
    db.updateTask(task.id, { status: TaskStatus.AgentWorking, session_id: null })

    expect(manager.reconcileTaskRuntime(task.id, 'uncommanded_status_write')).toBe(true)
    const first = manager.getStartQueue()
    expect(db.getTask(task.id)).toMatchObject({ status: TaskStatus.NotStarted, session_id: null })
    expect(first).toEqual([expect.objectContaining({ taskId: task.id, state: 'queued', position: 1 })])

    // A duplicate observer cannot create another row or reset FIFO/generation.
    expect(manager.reconcileTaskRuntime(task.id, 'periodic_runtime_reconciliation')).toBe(false)
    expect(manager.getStartQueue()).toEqual(first)

    await settle()
    expect(started).toEqual([task.id])
    expect(db.getTask(task.id)).toMatchObject({ status: TaskStatus.AgentWorking, session_id: 'session-1' })
    expect(manager.getStartRecoveryState(task.id)).toMatchObject({ state: 'started', recoveryResult: 'session_acknowledged' })
  })

  it('makes an orphan with no assigned agent a visible terminal recovery', async () => {
    const { db, manager } = setup(1)
    const task = db.createTask(makeTask({ title: 'Unassigned orphan', status: TaskStatus.AgentWorking }))!

    await manager.reconcileStartup()

    expect(db.getTask(task.id)).toMatchObject({ status: TaskStatus.NotStarted, session_id: null })
    expect(manager.getStartRecoveryState(task.id)).toMatchObject({
      agentId: 'unassigned',
      state: 'failed',
      recoveryCause: 'agent_missing',
      recoveryAction: 'terminal_failure'
    })
  })

  it('requeues orphaned agent_working state and starts it without user intervention', async () => {
    const { db, manager, started, createTasks } = setup(1)
    const [task] = createTasks(1)
    db.updateTask(task.id, { status: TaskStatus.AgentWorking, session_id: null })

    await manager.reconcileStartup()
    await settle()

    expect(started).toEqual([task.id])
    expect(db.getTask(task.id)).toMatchObject({ status: TaskStatus.AgentWorking, session_id: 'session-1' })
    expect(manager.getStartQueue()).toEqual([])
    expect(manager.getStartRecoveryState(task.id)).toMatchObject({ state: 'started', recoveryResult: 'session_acknowledged' })
    const journal = db.listProjectStatusJournal(DEFAULT_PROJECT_ID, { limit: 20 }).entries
    expect(journal.some((entry) => entry.source === 'system_recovery' && entry.summary.includes('session_acknowledged'))).toBe(true)
    setTaskApiAgentController(manager)
    expect(await handleSessionRoute(db, '/get_session_status', { task_id: task.id })).toMatchObject({
      recovery: { state: 'started', recoveryResult: 'session_acknowledged' }
    })
    expect(await handleSessionRoute(db, '/get_recent_activity', {})).toMatchObject({
      activity: expect.arrayContaining([
        expect.objectContaining({ task_id: task.id, recovery_state: 'started', recovery_result: 'session_acknowledged' })
      ])
    })
  })

  it('reclaims a live persisted session and never double-starts it', async () => {
    const { db, manager, agentId, started, createTasks } = setup(1)
    const [task] = createTasks(1)
    db.updateTask(task.id, { status: TaskStatus.AgentWorking, session_id: 'persisted-session' })
    ;(manager as any).startQueue.enqueue({
      taskId: task.id,
      projectId: task.project_id,
      agentId,
      priority: task.priority,
      reason: 'recovery',
      queuedAt: new Date().toISOString()
    })
    vi.spyOn(manager, 'resumeSession').mockImplementation(async () => {
      ;(manager as any).sessions.set('persisted-session', {
        id: 'persisted-session', agentId, taskId: task.id, status: 'working', createdAt: new Date(),
        seenMessageIds: new Set(), seenPartIds: new Set(), partContentLengths: new Map(),
        fallbackAgentIds: [], attemptedAgentIds: new Set()
      })
      return 'persisted-session'
    })

    await manager.reconcileStartup()
    await manager.reconcileStartup()
    await settle()

    expect(started).toEqual([])
    expect(manager.resumeSession).toHaveBeenCalledTimes(1)
    expect(manager.getStartRecoveryState(task.id)).toMatchObject({ state: 'recovered', recoveryResult: 'live_session_reclaimed' })
    const recoveryEntries = db.listProjectStatusJournal(DEFAULT_PROJECT_ID, { limit: 20 }).entries
      .filter((entry) => entry.source === 'system_recovery' && entry.summary.includes('live_session_reclaimed'))
    expect(recoveryEntries).toHaveLength(1)
  })

  it.each(['manual-stop', 'awaiting-approval', 'unsafe', 'destructive', 'irreversible'])(
    'does not retry excluded orphaned work labelled %s',
    async (label) => {
      const { db, manager, started, createTasks } = setup(1)
      const [task] = createTasks(1, { labels: [label] })
      db.updateTask(task.id, { status: TaskStatus.AgentWorking, session_id: null })

      await manager.reconcileStartup()
      await settle()

      expect(started).toEqual([])
      expect(db.getTask(task.id)?.status).toBe(TaskStatus.NotStarted)
      expect(manager.getStartRecoveryState(task.id)).toMatchObject({ state: 'cancelled', recoveryAction: 'exclude_from_retry' })
    }
  )

  it.each([
    { partType: 'question', tool: { name: 'permission', status: 'running' }, cause: 'awaiting_approval' },
    { partType: 'tool', tool: { name: 'external_write', status: 'running' }, cause: 'unsafe_side_effect_unknown' }
  ])('does not replay unresolved $cause work from the durable transcript', async ({ partType, tool, cause }) => {
    const { db, manager, started, createTasks } = setup(1)
    const [task] = createTasks(1)
    db.updateTask(task.id, { status: TaskStatus.AgentWorking, session_id: null })
    db.upsertTranscriptParts(task.id, [{ id: 'unresolved', role: 'assistant', content: 'pending', partType, tool }])

    await manager.reconcileStartup()
    await settle()

    expect(started).toEqual([])
    expect(manager.getStartRecoveryState(task.id)).toMatchObject({ state: 'cancelled', recoveryCause: cause })
  })
})

// Independent review: exercise manager boundaries, not just queue-store methods.
describe('recovery dispatch adversarial regressions', () => {
  it('does not run a deferred drain after shutdown starts', async () => {
    const { manager, agentId, started, createTasks } = setup(1)
    const [running, queued] = createTasks(2)
    await manager.requestSession(agentId, running.id)
    await manager.requestSession(agentId, queued.id)
    goIdle(manager, running.id)
    await manager.stopAllSessions()
    await settle()
    expect(started).toEqual([running.id])
    expect(manager.getStartQueue().map((row) => row.taskId)).toEqual([queued.id])
  })

  it.each(['cancelled', 'awaiting-approval', 'unsafe'])('rechecks %s before dispatch', async (label) => {
    const { db, manager, agentId, started, createTasks } = setup(1)
    const [running, queued] = createTasks(2)
    await manager.requestSession(agentId, running.id)
    await manager.requestSession(agentId, queued.id)
    db.updateTask(queued.id, { labels: [label] })
    goIdle(manager, running.id)
    await settle()
    expect(started).toEqual([running.id])
    expect(manager.getStartRecoveryState(queued.id)?.state).toBe('cancelled')
    await manager.stopAllSessions()
  })

  it('checks every unresolved tool even when a later parallel tool completed', async () => {
    const { db, manager, started, createTasks } = setup(1)
    const [task] = createTasks(1)
    db.updateTask(task.id, { status: TaskStatus.AgentWorking, session_id: null })
    db.upsertTranscriptParts(task.id, [
      { id: 'external', role: 'assistant', content: '', partType: 'tool', tool: { name: 'publish', status: 'running' } },
      { id: 'read', role: 'assistant', content: '', partType: 'tool', tool: { name: 'read', status: 'completed' } }
    ])
    await manager.reconcileStartup()
    await settle()
    expect(started).toEqual([])
    expect(manager.getStartRecoveryState(task.id)?.recoveryCause).toBe('unsafe_side_effect_unknown')
    await manager.stopAllSessions()
  })

  it('does not let automation reset terminal retry exhaustion', async () => {
    const { db, manager, started, createTasks, agentId } = setup(1)
    const [task] = createTasks(1, { auto_start_agent: true })
    const queue = (manager as any).startQueue
    queue.enqueue({ taskId: task.id, projectId: task.project_id, agentId, reason: 'recovery', queuedAt: new Date().toISOString() })
    queue.fail(task.id, 'recoverable_start_failure', 'retry_exhausted_after_5')
    await new TaskAutomationScheduler(db, manager).runNow()
    expect(started).toEqual([])
    expect(manager.getStartRecoveryState(task.id)?.state).toBe('failed')
    await manager.stopAllSessions()
  })

  it('joins concurrent immediate starts of the same task', async () => {
    const { manager, agentId, createTasks } = setup(5)
    const [task] = createTasks(1)
    let finish!: (id: string) => void
    ;(manager as any).startSessionNow.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve }))
    const first = manager.requestSession(agentId, task.id)
    const second = manager.requestSession(agentId, task.id)
    finish('one-session')
    expect((manager as any).startSessionNow).toHaveBeenCalledTimes(1)
    expect(await second).toEqual(await first)
    await manager.stopAllSessions()
  })

  it('keeps a successor waiting while its predecessor is queued, then respects review approval', async () => {
    const { db, manager, agentId, started, createTasks } = setup(2)
    const parent = db.createTask(makeTask({ title: 'Parent' }))!
    const [first, second] = createTasks(2, { parent_task_id: parent.id })
    db.updateTask(first.id, { next_subtask_ids: [second.id] })
    expect(await manager.requestSession(agentId, second.id)).toMatchObject({ status: 'queued', reason: 'dependency' })
    db.updateTask(first.id, { status: TaskStatus.ReadyForReview })
    manager.drainStartQueue()
    await settle()
    expect(started).toEqual([])
    db.updateTask(first.id, { status: TaskStatus.Completed })
    manager.drainStartQueue()
    await settle()
    expect(started).toEqual([second.id])
    await manager.stopAllSessions()
  })
})

describe('recovery ownership adversarial regressions', () => {
  it('rejects a move away when backend destruction fails and keeps the live owner retryable', async () => {
    const { db, manager, createTasks } = setup(1)
    const [task] = createTasks(1)
    await manager.startTask(task.id)
    const live = manager.findSessionByTaskId(task.id)!
    const adapter = {
      destroySession: vi.fn()
        .mockRejectedValueOnce(new Error('backend refused stop'))
        .mockResolvedValueOnce(undefined)
    }
    live.session.adapter = adapter as any
    live.session.pollingStarted = true
    const restoredPolling = vi.spyOn(manager as any, 'startAdapterPolling').mockImplementation(() => undefined)
    vi.spyOn(manager as any, 'buildSessionConfig').mockResolvedValue({})

    await expect(prepareUserTaskUpdate(
      manager,
      db.getTask(task.id)!,
      { status: TaskStatus.ReadyForReview }
    )).rejects.toThrow('backend refused stop')

    expect(db.getTask(task.id)?.status).toBe(TaskStatus.AgentWorking)
    expect(manager.findSessionByTaskId(task.id)?.sessionId).toBe(live.sessionId)
    expect(manager.findSessionByTaskId(task.id)?.session).toBe(live.session)
    expect((manager as any).ownsSessionGeneration(live.sessionId, live.session)).toBe(true)
    expect(restoredPolling).toHaveBeenCalledWith(live.sessionId, adapter, expect.anything(), live.session)
    expect(manager.getStartRecoveryState(task.id)).toMatchObject({ state: 'started', recoveryResult: 'session_acknowledged' })

    // A repeated stop addresses the same retained owner and can complete once
    // the backend acknowledges destruction.
    await expect(manager.stopByTaskId(task.id)).resolves.toEqual({ sessionId: live.sessionId })
    expect(adapter.destroySession).toHaveBeenCalledTimes(2)
    expect(manager.findSessionByTaskId(task.id)).toBeUndefined()
    expect(db.getTask(task.id)?.status).toBe(TaskStatus.NotStarted)
    expect(manager.getStartRecoveryState(task.id)).toMatchObject({ state: 'cancelled', recoveryCause: 'manual_stop' })
    await manager.stopAllSessions()
  })

  it('joins overlapping status moves to one pending Stop result', async () => {
    const { db, manager, createTasks } = setup(1)
    const [task] = createTasks(1)
    await manager.startTask(task.id)
    vi.spyOn(manager as any, 'buildSessionConfig').mockResolvedValue({})
    let refuse!: (error: Error) => void
    const destroySession = vi.fn(() => new Promise<void>((_resolve, reject) => { refuse = reject }))
    vi.mocked((manager as any).getAdapter).mockReturnValue({ destroySession })

    const first = prepareUserTaskUpdate(
      manager,
      db.getTask(task.id)!,
      { status: TaskStatus.ReadyForReview }
    ).catch((error) => error)
    await vi.waitFor(() => expect(destroySession).toHaveBeenCalledTimes(1))
    let secondSettled = false
    const second = prepareUserTaskUpdate(
      manager,
      db.getTask(task.id)!,
      { status: TaskStatus.Completed }
    ).then((prepared) => {
      secondSettled = true
      db.updateTask(task.id, prepared.data)
      return prepared
    }).catch((error) => error)

    await settle()
    expect(secondSettled).toBe(false)
    expect(manager.hasTaskStartOwnership(task.id)).toBe(true)
    refuse(new Error('backend refused Stop'))
    const results = await Promise.all([first, second])

    expect(results[0]).toBeInstanceOf(Error)
    expect(results[1]).toBeInstanceOf(Error)
    expect(destroySession).toHaveBeenCalledTimes(1)
    expect(db.getTask(task.id)?.status).toBe(TaskStatus.AgentWorking)
    expect(manager.findSessionByTaskId(task.id)).toBeDefined()
    vi.mocked((manager as any).getAdapter).mockReturnValue(null)
    await manager.stopAllSessions()
  })

  it('joins duplicate Stop requests until one backend acknowledgement', async () => {
    const { manager, createTasks } = setup(1)
    const [task] = createTasks(1)
    await manager.startTask(task.id)
    vi.spyOn(manager as any, 'buildSessionConfig').mockResolvedValue({})
    let finish!: () => void
    const destroySession = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    vi.mocked((manager as any).getAdapter).mockReturnValue({ destroySession })

    let duplicateSettled = false
    const first = manager.stopByTaskId(task.id)
    await vi.waitFor(() => expect(destroySession).toHaveBeenCalledTimes(1))
    const duplicate = manager.stopByTaskId(task.id).then((result) => {
      duplicateSettled = true
      return result
    })
    await settle()

    expect(duplicateSettled).toBe(false)
    expect(manager.hasTaskStartOwnership(task.id)).toBe(true)
    finish()
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate])
    expect(duplicateResult).toEqual(firstResult)
    expect(destroySession).toHaveBeenCalledTimes(1)
    expect(manager.findSessionByTaskId(task.id)).toBeUndefined()
    await manager.stopAllSessions()
  })

  it('retains admission, reconciliation, and task-start ownership while Stop is pending', async () => {
    const { manager, createTasks, started } = setup(1)
    const [task, other] = createTasks(2)
    await manager.startTask(task.id)
    vi.spyOn(manager as any, 'buildSessionConfig').mockResolvedValue({})
    let finish!: () => void
    const destroySession = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    vi.mocked((manager as any).getAdapter).mockReturnValue({ destroySession })

    const stopping = manager.stopByTaskId(task.id)
    await vi.waitFor(() => expect(destroySession).toHaveBeenCalledTimes(1))
    expect(manager.hasTaskStartOwnership(task.id)).toBe(true)
    await expect(manager.startTask(task.id)).resolves.toMatchObject({
      action: 'already_running',
      startedTaskId: task.id
    })
    await expect(manager.startTask(other.id)).resolves.toMatchObject({
      action: 'queued',
      queueReason: 'agent_limit'
    })
    expect(manager.reconcileTaskRuntime(task.id)).toBe(false)
    await settle()
    expect(started).toEqual([task.id])

    finish()
    await stopping
    vi.mocked((manager as any).getAdapter).mockReturnValue(null)
    manager.cancelQueuedStart(other.id)
    await manager.stopAllSessions()
  })

  it('retains file-overlap ownership while Stop is pending', async () => {
    const { db, manager, createTasks } = setup(2)
    const [task, overlapping] = createTasks(2)
    db.setTaskTouches(task.id, ['src/main/agent-manager.ts'])
    db.setTaskTouches(overlapping.id, ['src/main/agent-manager.ts'])
    await manager.startTask(task.id)
    vi.spyOn(manager as any, 'buildSessionConfig').mockResolvedValue({})
    let finish!: () => void
    const destroySession = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    vi.mocked((manager as any).getAdapter).mockReturnValue({ destroySession })

    const stopping = manager.stopByTaskId(task.id)
    await vi.waitFor(() => expect(destroySession).toHaveBeenCalledTimes(1))
    await expect(manager.startTask(overlapping.id)).resolves.toMatchObject({
      action: 'queued',
      queueReason: 'file_overlap'
    })

    finish()
    await stopping
    vi.mocked((manager as any).getAdapter).mockReturnValue(null)
    manager.cancelQueuedStart(overlapping.id)
    await manager.stopAllSessions()
  })

  it('does not launch a replacement during periodic reconciliation while Stop is pending', async () => {
    const { manager, createTasks, started } = setup(1)
    const [task] = createTasks(1)
    await manager.startTask(task.id)
    vi.spyOn(manager as any, 'buildSessionConfig').mockResolvedValue({})
    let finish!: () => void
    const destroySession = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    vi.mocked((manager as any).getAdapter).mockReturnValue({ destroySession })

    const stopping = manager.stopByTaskId(task.id)
    await vi.waitFor(() => expect(destroySession).toHaveBeenCalledTimes(1))
    ;(manager as any).reconcileRuntimeDivergence()
    await settle()

    expect(started).toEqual([task.id])
    finish()
    await stopping
    expect(manager.findSessionByTaskId(task.id)).toBeUndefined()
    vi.mocked((manager as any).getAdapter).mockReturnValue(null)
    await manager.stopAllSessions()
  })

  it('does not create another initial prompt during pending Stop', async () => {
    const { db, manager, createTasks } = setup(1)
    const [task] = createTasks(1)
    ;(manager as any).startSessionNow.mockRestore()
    let sequence = 0
    let finish!: () => void
    const adapter = {
      initialize: vi.fn(async () => undefined),
      createSession: vi.fn(async () => `real-${++sequence}`),
      getStatus: vi.fn(async () => ({ type: 'idle' })),
      destroySession: vi.fn(() => new Promise<void>((resolve) => { finish = resolve })),
      sendPrompt: vi.fn(async () => undefined)
    }
    vi.mocked((manager as any).getAdapter).mockReturnValue(adapter)
    vi.spyOn(manager as any, 'setupWorktreeIfNeeded').mockResolvedValue('/tmp')
    vi.spyOn(manager as any, 'buildMcpServersForAdapter').mockResolvedValue({})
    vi.spyOn(manager as any, 'setupSecretSession').mockReturnValue(null)
    vi.spyOn(manager as any, 'startAdapterPolling').mockImplementation(() => undefined)
    vi.spyOn(manager as any, 'buildSessionConfig').mockResolvedValue({})

    await manager.startTask(task.id)
    const stopping = manager.stopByTaskId(task.id)
    await vi.waitFor(() => expect(adapter.destroySession).toHaveBeenCalledTimes(1))
    const sending = manager.sendMessage('', 'do not recreate during Stop', task.id, task.agent_id!, undefined, 'pending-stop-send')
      .catch((error) => error)
    ;(manager as any).reconcileRuntimeDivergence()
    await settle(30)

    expect(adapter.createSession).toHaveBeenCalledTimes(1)
    expect(adapter.sendPrompt).toHaveBeenCalledTimes(1)
    expect(manager.hasTaskStartOwnership(task.id)).toBe(true)
    finish()
    await stopping
    await expect(sending).resolves.toBeInstanceOf(Error)
    expect(manager.findSessionByTaskId(task.id)).toBeUndefined()
    expect(db.getTask(task.id)?.status).toBe(TaskStatus.NotStarted)
    expect(manager.getStartRecoveryState(task.id)).toMatchObject({ state: 'cancelled' })
    await manager.stopAllSessions()
  })

  it('durably fences an unassigned triage start before acknowledging move-away, restart, and duplicate stops', async () => {
    const { db, manager } = setup(1)
    const task = db.createTask(makeTask({ title: 'Needs triage' }))!
    ;(manager as any).startSessionNow.mockRestore()
    let finish!: (id: string) => void
    const adapter = {
      initialize: vi.fn(async () => undefined),
      createSession: vi.fn(() => new Promise<string>((resolve) => { finish = resolve })),
      getStatus: vi.fn(async () => ({ type: 'idle' })),
      destroySession: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async () => undefined)
    }
    vi.spyOn(manager as any, 'getAdapter').mockReturnValue(adapter)
    vi.spyOn(manager as any, 'setupWorktreeIfNeeded').mockResolvedValue('/tmp')
    vi.spyOn(manager as any, 'buildMcpServersForAdapter').mockResolvedValue({})
    vi.spyOn(manager as any, 'setupSecretSession').mockReturnValue(null)
    vi.spyOn(manager as any, 'startAdapterPolling').mockImplementation(() => undefined)

    const starting = manager.startTask(task.id)
    const rejected = expect(starting).rejects.toThrow('Start ownership was withdrawn')
    await vi.waitFor(() => expect(adapter.createSession).toHaveBeenCalledTimes(1))

    const preparing = prepareUserTaskUpdate(
      manager,
      db.getTask(task.id)!,
      { status: TaskStatus.ReadyForReview }
    )
    const duplicateStop = manager.stopByTaskId(task.id)
    expect(manager.getStartRecoveryState(task.id)).toMatchObject({ state: 'cancelled', recoveryCause: 'manual_stop' })

    finish('late-triage-session')
    const prepared = await preparing
    await expect(duplicateStop).resolves.toEqual({ sessionId: null })
    db.updateTask(task.id, prepared.data)

    const restarted = new AgentManager(db)
    vi.spyOn(restarted as any, 'sendToRenderer').mockImplementation(() => undefined)
    const restartedStart = vi.spyOn(restarted as any, 'startSessionNow').mockResolvedValue('should-not-start')
    await restarted.reconcileStartup()
    await settle()
    expect(restartedStart).not.toHaveBeenCalled()

    await rejected
    expect(adapter.sendPrompt).not.toHaveBeenCalled()
    expect(adapter.destroySession).toHaveBeenCalledTimes(1)
    expect(manager.findSessionByTaskId(task.id)).toBeUndefined()
    expect(db.getTask(task.id)?.status).toBe(TaskStatus.ReadyForReview)
    await Promise.all([manager.stopAllSessions(), restarted.stopAllSessions()])
  })

  it('restarts only the selected child when a manually stopped parent has pending subtasks', async () => {
    const { manager, agentId, started, createTasks } = setup(2)
    const [parent] = createTasks(1, { title: 'Stopped parent' })
    const [child] = createTasks(1, { title: 'Pending child', parent_task_id: parent.id }, agentId)
    await manager.startTask(parent.id, { preferSubtasks: false })
    await manager.stopByTaskId(parent.id)

    expect(await manager.startTask(parent.id, { resumeManualStop: true })).toMatchObject({
      action: 'subtask_started',
      startedTaskId: child.id
    })
    expect(await manager.startTask(parent.id, { resumeManualStop: true })).toMatchObject({
      action: 'already_running',
      startedTaskId: child.id
    })
    await settle()

    expect(started).toEqual([parent.id, child.id])
    expect(manager.getStartRecoveryState(parent.id)).toMatchObject({ state: 'cancelled', recoveryCause: 'manual_stop' })
    expect(manager.findSessionByTaskId(parent.id)).toBeUndefined()
    expect(manager.findSessionByTaskId(child.id)).toBeDefined()
    await manager.stopAllSessions()
  })

  it('keeps a manual stop terminal across automation and restart', async () => {
    const { db, manager, agentId, started, createTasks } = setup(1)
    const [task] = createTasks(1, { auto_start_agent: true })
    await manager.requestSession(agentId, task.id)
    await manager.stopSession(sessionIdFor(manager, task.id))
    await new TaskAutomationScheduler(db, manager).runNow()
    db.updateTask(task.id, { status: TaskStatus.AgentWorking })
    await manager.reconcileStartup()
    await settle()
    expect(started).toEqual([task.id])
    expect(manager.getStartRecoveryState(task.id)).toMatchObject({ state: 'cancelled', recoveryCause: 'manual_stop' })
    await manager.stopAllSessions()
  })

  it('does not let a late rejected start reset a completed task or retry a cancelled claim', async () => {
    const { db, manager, agentId, createTasks } = setup(1)
    const [task] = createTasks(1)
    let reject!: (error: Error) => void
    ;(manager as any).startSessionNow.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
    const starting = manager.requestSession(agentId, task.id)
    const rejected = expect(starting).rejects.toThrow('late error')
    const stopping = manager.stopByTaskId(task.id)
    db.updateTask(task.id, { status: TaskStatus.Completed })
    reject(new Error('late error'))
    await rejected
    await stopping
    expect(db.getTask(task.id)?.status).toBe(TaskStatus.Completed)
    expect(manager.getStartRecoveryState(task.id)?.state).toBe('cancelled')
    await manager.stopAllSessions()
  })

  it('joins repeated reconciliation and blocks a drain while reconnect is pending', async () => {
    const { db, manager, agentId, started, createTasks } = setup(1)
    const [task] = createTasks(1)
    db.updateTask(task.id, { status: TaskStatus.AgentWorking, session_id: 'saved' })
    ;(manager as any).startQueue.enqueue({ taskId: task.id, projectId: task.project_id, agentId,
      reason: 'recovery', queuedAt: new Date().toISOString() })
    let finish!: () => void
    vi.spyOn(manager, 'resumeSession').mockImplementation(() => new Promise((resolve) => {
      finish = () => {
        ;(manager as any).sessions.set('saved', { id: 'saved', agentId, taskId: task.id, status: 'working',
          seenMessageIds: new Set(), seenPartIds: new Set(), partContentLengths: new Map() })
        resolve('saved')
      }
    }))
    const first = manager.reconcileStartup()
    const second = manager.reconcileStartup()
    await settle()
    manager.drainStartQueue()
    expect(started).toEqual([])
    expect(manager.resumeSession).toHaveBeenCalledTimes(1)
    finish()
    await Promise.all([first, second])
    expect(manager.getStartRecoveryState(task.id)?.state).toBe('recovered')
    await manager.stopAllSessions()
  })

  it('repairs a stale persisted binding without restarting a live owner', async () => {
    const { db, manager, agentId, started, createTasks } = setup(1)
    const [task] = createTasks(1)
    await manager.requestSession(agentId, task.id)
    db.updateTask(task.id, { session_id: null })
    await manager.reconcileStartup()
    await settle()
    expect(started).toEqual([task.id])
    expect(db.getTask(task.id)?.session_id).toBe('session-1')
    await manager.stopAllSessions()
  })
})

describe('real reconnect status and stale callbacks', () => {
  it.each(['busy', 'waiting_approval'] as const)('preserves backend %s state and joins concurrent reconnects', async (type) => {
    const { db, manager, agentId, started, createTasks } = setup(1)
    const [task] = createTasks(1)
    db.updateTask(task.id, { status: TaskStatus.AgentWorking, session_id: 'saved' })
    const adapter = {
      initialize: vi.fn(async () => undefined),
      resumeSession: vi.fn(async () => []),
      getStatus: vi.fn(async () => ({ type })),
      destroySession: vi.fn(async () => undefined)
    }
    vi.spyOn(manager as any, 'getAdapter').mockReturnValue(adapter)
    vi.spyOn(manager as any, 'setupWorktreeIfNeeded').mockResolvedValue('/tmp')
    vi.spyOn(manager as any, 'buildMcpServersForAdapter').mockResolvedValue({})
    vi.spyOn(manager as any, 'setupSecretSession').mockReturnValue(null)
    vi.spyOn(manager as any, 'startAdapterPolling').mockImplementation(() => undefined)
    await Promise.all([manager.resumeSession(agentId, task.id, 'saved'), manager.resumeSession(agentId, task.id, 'saved')])
    await manager.reconcileStartup()
    expect(adapter.resumeSession).toHaveBeenCalledTimes(1)
    expect(manager.getSessionStatus('saved')?.status).toBe(type === 'busy' ? 'working' : 'waiting_approval')
    expect(db.getTask(task.id)?.status).toBe(TaskStatus.AgentWorking)
    expect(started).toEqual([])
    await manager.stopAllSessions()
  })

  it('rejects a late reconnect after the persisted binding changed', async () => {
    const { db, manager, agentId, createTasks } = setup(1)
    const [task] = createTasks(1)
    db.updateTask(task.id, { status: TaskStatus.AgentWorking, session_id: 'saved' })
    let finish!: () => void
    const adapter = {
      initialize: vi.fn(async () => undefined),
      resumeSession: vi.fn(() => new Promise<[]>(resolve => { finish = () => resolve([]) })),
      getStatus: vi.fn(async () => ({ type: 'busy' })),
      destroySession: vi.fn(async () => undefined)
    }
    vi.spyOn(manager as any, 'getAdapter').mockReturnValue(adapter)
    vi.spyOn(manager as any, 'setupWorktreeIfNeeded').mockResolvedValue('/tmp')
    vi.spyOn(manager as any, 'buildMcpServersForAdapter').mockResolvedValue({})
    vi.spyOn(manager as any, 'setupSecretSession').mockReturnValue(null)
    const reconnect = manager.resumeSession(agentId, task.id, 'saved')
    const rejected = expect(reconnect).rejects.toThrow('Resume ownership changed')
    await settle()
    db.updateTask(task.id, { session_id: 'new-owner' })
    finish()
    await rejected
    expect(manager.findSessionByTaskId(task.id)).toBeUndefined()
    expect(db.getTask(task.id)?.session_id).toBe('new-owner')
    expect(adapter.destroySession).toHaveBeenCalledTimes(1)
    await manager.stopAllSessions()
  })

  it('does not let the delivery outbox replay work stopped during recovery', async () => {
    const { manager, agentId, started, createTasks } = setup(1)
    const [task] = createTasks(1, { labels: ['awaiting-approval'] })
    const deliveries = (manager as any).deliveries
    const { record } = deliveries.enqueue({ idempotencyKey: 'pending-before-stop', kind: 'agent_message', taskId: task.id,
      agentId, payload: JSON.stringify({ sessionId: '', taskId: task.id, agentId, message: 'continue' }) })
    const dispatch = vi.spyOn(manager as any, 'dispatchAgentMessage')
    await manager.reconcileStartup()
    expect(dispatch).not.toHaveBeenCalled()
    expect(deliveries.get(record.id)).toMatchObject({ state: 'cancelled', lastError: expect.stringContaining('awaiting_approval') })
    expect(started).toEqual([])
    // A delivery created after startup gets the same exclusion on later sweeps.
    const later = deliveries.enqueue({ idempotencyKey: 'late-before-stop', kind: 'agent_message', taskId: task.id,
      agentId, payload: JSON.stringify({ sessionId: '', taskId: task.id, agentId, message: 'continue' }) }).record
    await (manager as any).recoverAgentMessages()
    expect(deliveries.get(later.id)?.state).toBe('cancelled')
    expect(dispatch).not.toHaveBeenCalled()
    await manager.stopAllSessions()
  })
})

describe('adapter start fencing before effects', () => {
  it('fences an unassigned triage prompt when stopped during backend creation', async () => {
    const { db, manager } = setup(1)
    const task = db.createTask(makeTask({ title: 'Triage race' }))!
    ;(manager as any).startSessionNow.mockRestore()
    let finish!: (id: string) => void
    const adapter = {
      initialize: vi.fn(async () => undefined),
      createSession: vi.fn(() => new Promise<string>(resolve => { finish = resolve })),
      getStatus: vi.fn(async () => ({ type: 'idle' })),
      destroySession: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async () => undefined)
    }
    vi.spyOn(manager as any, 'getAdapter').mockReturnValue(adapter)
    vi.spyOn(manager as any, 'setupWorktreeIfNeeded').mockResolvedValue('/tmp')
    vi.spyOn(manager as any, 'buildMcpServersForAdapter').mockResolvedValue({})
    vi.spyOn(manager as any, 'setupSecretSession').mockReturnValue(null)
    const starting = manager.startTask(task.id)
    const rejected = expect(starting).rejects.toThrow('Start ownership was withdrawn')
    await vi.waitFor(() => expect(adapter.createSession).toHaveBeenCalledTimes(1))
    const stopping = manager.stopByTaskId(task.id)
    expect(manager.getStartRecoveryState(task.id)?.state).toBe('cancelled')
    finish('cancelled-triage')
    await Promise.all([rejected, stopping])
    expect(adapter.sendPrompt).not.toHaveBeenCalled()
    expect(manager.findSessionByTaskId(task.id)).toBeUndefined()
    expect(db.getTask(task.id)?.status).toBe(TaskStatus.NotStarted)

    adapter.createSession.mockResolvedValue('restarted-triage')
    expect(await manager.startTask(task.id, { resumeManualStop: true })).toMatchObject({ action: 'triage_started' })
    expect(adapter.sendPrompt).toHaveBeenCalledTimes(1)
    await manager.stopAllSessions()
  })

  it.each(['stop', 'complete', 'delete', 'shutdown'] as const)('fences a late created session after %s', async (action) => {
    const { db, manager, agentId, createTasks } = setup(1)
    const [task] = createTasks(1)
    ;(manager as any).startSessionNow.mockRestore()
    let finish!: (id: string) => void
    const adapter = {
      initialize: vi.fn(async () => undefined),
      createSession: vi.fn(() => new Promise<string>((resolve) => { finish = resolve })),
      getStatus: vi.fn(async () => ({ type: 'idle' })),
      destroySession: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async () => undefined)
    }
    vi.spyOn(manager as any, 'getAdapter').mockReturnValue(adapter)
    vi.spyOn(manager as any, 'setupWorktreeIfNeeded').mockResolvedValue('/tmp')
    vi.spyOn(manager as any, 'buildMcpServersForAdapter').mockResolvedValue({})
    vi.spyOn(manager as any, 'setupSecretSession').mockReturnValue(null)
    const starting = manager.requestSession(agentId, task.id)
    const rejected = expect(starting).rejects.toThrow('Start ownership was withdrawn')
    await vi.waitFor(() => expect(adapter.createSession).toHaveBeenCalledTimes(1))
    const stopping = action === 'stop' ? manager.stopByTaskId(task.id) : undefined
    if (action === 'complete') db.updateTask(task.id, { status: TaskStatus.Completed })
    if (action === 'delete') db.deleteTask(task.id)
    if (action === 'shutdown') await manager.stopAllSessions()
    finish('late-session')
    await rejected
    await stopping
    expect(adapter.sendPrompt).not.toHaveBeenCalled()
    expect(adapter.destroySession).toHaveBeenCalledTimes(1)
    expect(manager.findSessionByTaskId(task.id)).toBeUndefined()
    if (action === 'complete') expect(db.getTask(task.id)?.status).toBe(TaskStatus.Completed)
    await manager.stopAllSessions()
  })
})

describe('manager retry budget and adapter availability', () => {
  it('dispatches automatically when an unavailable adapter returns after backoff', async () => {
    const { db, manager, agentId, createTasks, started } = setup(1)
    const [task] = createTasks(1)
    ;(manager as any).startSessionNow.mockRejectedValueOnce(new Error('offline'))
    await expect(manager.requestSession(agentId, task.id)).rejects.toThrow('offline')
    expect(manager.getStartRecoveryState(task.id)?.retryCount).toBe(1)
    // Move the persisted deadline forward as if backoff elapsed.
    db.db.prepare('UPDATE agent_start_queue SET next_retry_at = 0 WHERE task_id = ?').run(task.id)
    manager.drainStartQueue()
    await settle()
    expect(started).toEqual([task.id])
    expect(manager.getStartRecoveryState(task.id)).toMatchObject({ state: 'started', retryCount: 1 })
    await manager.stopAllSessions()
  })

  it('exhausts exactly five retries and retains the budget across reconciliation and automation', async () => {
    const { db, manager, agentId, createTasks } = setup(1)
    const [task] = createTasks(1, { auto_start_agent: true })
    const start = (manager as any).startSessionNow.mockRejectedValue(new Error('offline'))
    await expect(manager.requestSession(agentId, task.id)).rejects.toThrow('offline')
    for (let retry = 0; retry < 5; retry++) {
      db.db.prepare('UPDATE agent_start_queue SET next_retry_at = 0 WHERE task_id = ?').run(task.id)
      manager.drainStartQueue()
      await settle()
    }
    expect(start).toHaveBeenCalledTimes(6)
    expect(manager.getStartRecoveryState(task.id)).toMatchObject({ state: 'failed', recoveryResult: 'retry_exhausted_after_5' })
    await manager.reconcileStartup()
    await new TaskAutomationScheduler(db, manager).runNow()
    await settle()
    expect(start).toHaveBeenCalledTimes(6)
    await manager.stopAllSessions()
  })

  it('does not replay an initial prompt whose transport acceptance is unknown or count its reset as activity', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime('2026-01-01T00:00:00.000Z')
    const { db, manager, agentId, createTasks } = setup(1)
    const [task] = createTasks(1)
    ;(manager as any).startSessionNow.mockRestore()
    const adapter = {
      initialize: vi.fn(async () => undefined),
      createSession: vi.fn(async () => 'uncertain-session'),
      getStatus: vi.fn(async () => ({ type: 'idle' })),
      destroySession: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async () => {
        vi.setSystemTime('2026-01-02T00:00:00.000Z')
        throw new Error('connection lost after send')
      })
    }
    vi.spyOn(manager as any, 'getAdapter').mockReturnValue(adapter)
    vi.spyOn(manager as any, 'setupWorktreeIfNeeded').mockResolvedValue('/tmp')
    vi.spyOn(manager as any, 'buildMcpServersForAdapter').mockResolvedValue({})
    vi.spyOn(manager as any, 'setupSecretSession').mockReturnValue(null)
    vi.spyOn(manager as any, 'startAdapterPolling').mockImplementation(() => undefined)
    await expect(manager.requestSession(agentId, task.id)).rejects.toThrow('connection lost after send')
    await settle()
    expect(manager.getStartRecoveryState(task.id)).toMatchObject({ state: 'failed', recoveryResult: 'prompt_delivery_unconfirmed' })
    expect(db.getTask(task.id)?.status).toBe(TaskStatus.NotStarted)
    expect(adapter.sendPrompt).toHaveBeenCalledTimes(1)
    expect(db.getTask(task.id)?.last_activity_at).toBe('2026-01-01T00:00:00.000Z')
    await manager.stopAllSessions()
  })
})

describe('task changes while reconnecting', () => {
  it.each(['completed', 'deleted', 'manual_stop'] as const)('does not resurrect a task %s during reconnect', async (change) => {
    const { db, manager, agentId, createTasks, started } = setup(1)
    const [task] = createTasks(1)
    db.updateTask(task.id, { status: TaskStatus.AgentWorking, session_id: 'saved' })
    let reject!: (error: Error) => void
    vi.spyOn(manager, 'resumeSession').mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
    const reconnect = manager.reconcileStartup()
    await settle()
    if (change === 'completed') db.updateTask(task.id, { status: TaskStatus.Completed })
    if (change === 'deleted') db.deleteTask(task.id)
    if (change === 'manual_stop') await manager.stopByTaskId(task.id)
    reject(new Error('backend disconnected'))
    await reconnect
    await settle()
    expect(started).toEqual([])
    if (change === 'completed') expect(db.getTask(task.id)?.status).toBe(TaskStatus.Completed)
    if (change === 'deleted') expect(db.getTask(task.id)).toBeUndefined()
    if (change === 'manual_stop') expect(manager.getStartRecoveryState(task.id)?.state).toBe('cancelled')
    expect((manager as any).startSessionNow).not.toHaveBeenCalledWith(agentId, task.id, expect.anything(), expect.anything())
    await manager.stopAllSessions()
  })
})


describe('automatic reset activity exclusions (#142)', () => {
  const before = '2026-01-01T00:00:00.000Z'
  const after = '2026-01-02T00:00:00.000Z'
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(before) })

  it.each(['unassigned', 'missing-session', 'failed', 'cancelled', 'reconnect-failure'])('does not lift a %s orphan during startup recovery', async (kind) => {
    const { db, manager, agentId, createTasks } = setup(1)
    const parent = db.createTask({ title: 'Parent' })!
    const [task] = createTasks(1, { status: TaskStatus.AgentWorking, parent_task_id: parent.id })
    if (kind === 'unassigned') db.updateTask(task.id, { agent_id: null })
    if (kind === 'reconnect-failure') {
      db.updateTask(task.id, { session_id: 'lost-session' })
      vi.spyOn(manager, 'resumeSession').mockRejectedValue(new Error('Backend gone'))
    }
    if (kind === 'failed' || kind === 'cancelled') {
      const queue = (manager as any).startQueue
      queue.enqueue({ taskId: task.id, projectId: task.project_id, agentId, reason: 'recovery', queuedAt: before })
      if (kind === 'failed') queue.fail(task.id, 'agent_missing', 'terminal_failure')
      else queue.cancel(task.id, 'manual_stop', 'cancelled')
    }
    // Keep the requeued item waiting so only recovery, not a new agent start,
    // can affect activity during this assertion.
    vi.spyOn(manager, 'drainStartQueue').mockImplementation(() => undefined)
    vi.setSystemTime(after)
    await manager.reconcileStartup()
    expect(db.getTask(task.id)).toMatchObject({ status: TaskStatus.NotStarted, last_activity_at: before })
    expect(db.getTask(parent.id)?.last_activity_at).toBe(before)
    await manager.stopAllSessions()
    db.close()
  })

  it.each(['immediate', 'queued'])('does not lift on a failed %s start reset', async (mode) => {
    const { db, manager, agentId, createTasks } = setup(1)
    const [task] = createTasks(1)
    ;(manager as any).startSessionNow.mockImplementation(async () => {
      db.updateTask(task.id, { status: TaskStatus.AgentWorking })
      vi.setSystemTime(after)
      throw new Error('start failed')
    })
    if (mode === 'immediate') {
      await expect(manager.requestSession(agentId, task.id)).rejects.toThrow('start failed')
    } else {
      ;(manager as any).startQueue.enqueue({ taskId: task.id, projectId: task.project_id, agentId, reason: 'recovery', queuedAt: before })
      manager.drainStartQueue()
      await settle()
    }
    expect(db.getTask(task.id)).toMatchObject({ status: TaskStatus.NotStarted, last_activity_at: before })
    expect(manager.getStartRecoveryState(task.id)?.state).toBe('retrying')
    await manager.stopAllSessions()
    db.close()
  })

  it.each([false, true])('explicit Stop counts activity (live session: %s)', async (live) => {
    const { db, manager, agentId, createTasks } = setup(1)
    const [task] = createTasks(1, { status: TaskStatus.AgentWorking })
    if (live) await manager.requestSession(agentId, task.id)
    vi.setSystemTime(after)
    await manager.stopByTaskId(task.id)
    expect(db.getTask(task.id)).toMatchObject({ status: TaskStatus.NotStarted, last_activity_at: after })
    await manager.stopAllSessions()
    db.close()
  })
})
