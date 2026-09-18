/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'crypto'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeAgent, makeTask } from '../../test/helpers/task-fixtures'
import { AgentManager } from './agent-manager'
import { handleSessionRoute } from './task-api/session-routes'
import { setTaskApiAgentController } from './task-api/state'
import { TaskAutomationScheduler } from './task-automation-scheduler'
import { startMobileApiServer, stopMobileApiServer } from './mobile-api-server'
import { MAX_CONCURRENT_AGENT_SESSIONS_SETTING } from './agent-manager/admission'
import { TaskStatus } from '../shared/constants'
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
  setTaskApiAgentController(null)
  await stopMobileApiServer()
})

describe('admission control — AgentManager.startTask', () => {
  it('runs exactly N of N+1 tasks and queues one, which starts when a slot frees', async () => {
    const { manager, started, createTasks } = setup()
    const tasks = createTasks(LIMIT + 1)

    const results = []
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
})

describe('admission control — AgentManager.startSession', () => {
  it('runs exactly N, queues one, and starts it when a running session goes idle', async () => {
    const { manager, agentId, started, createTasks } = setup()
    const tasks = createTasks(LIMIT + 1)

    const ids = []
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

    const outcomes = []
    for (const task of tasks) outcomes.push(await manager.requestSession(agentId, task.id))

    expect(outcomes.map((o) => o.status)).toEqual(['started', 'queued', 'queued'])
    expect(outcomes.slice(1).map((o) => (o as { position: number }).position)).toEqual([1, 2])
  })
})

describe('admission control — MCP start_task', () => {
  it('runs exactly N, reports the extra one as queued, and starts it when a slot frees', async () => {
    const { db, manager, started, createTasks } = setup()
    setTaskApiAgentController(manager)
    const tasks = createTasks(LIMIT + 1)

    const results = []
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

    const results = []
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

    const results = []
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
    const row = db.createTask(makeTask({ title: 'Mastermind' }))!
    db.db.prepare("UPDATE tasks SET role = 'mastermind' WHERE id = ?").run(row.id)
    return row.id
  }

  it('a coordinator start bypasses a full agent and does not take a slot', async () => {
    const { db, manager, agentId, started, createTasks } = setup(1)
    const coordinatorId = makeCoordinator(db)
    const [task1, task2] = createTasks(2)

    expect((await manager.startTask(task1.id)).action).toBe('task_started')
    // Agent full, but the Mastermind is not counted or queued.
    expect(await manager.requestSession(agentId, coordinatorId)).toMatchObject({ status: 'started' })
    expect(started).toEqual([task1.id, coordinatorId])

    await manager.stopSession(sessionIdFor(manager, task1.id))
    // The working Mastermind does not hold the freed slot.
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
