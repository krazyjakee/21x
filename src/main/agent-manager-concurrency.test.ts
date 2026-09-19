/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeAgent, makeTask } from '../../test/helpers/task-fixtures'
import { AgentManager } from './agent-manager'
import { ResourceMonitor } from './concurrency-control'
import { handleRoute } from './task-api-server'
import { setTaskApiAgentController } from './task-api/state'
import { callToolForScope, type TaskMcpScope } from './mcp-servers/task-management-core'
import { TaskStatus } from '../shared/constants'
import type { ResourcePressure } from '../shared/concurrency'
import type { DatabaseManager, TaskRecord } from './database'

/**
 * Captain-managed concurrency under a user-set hard cap (#150), through
 * AgentManager.requestSession and the MCP tools, against a real in-memory
 * database. Only the backend spawn (startSessionNow) is replaced, as in
 * agent-manager-admission.test.ts.
 */

vi.mock('child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }))
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

const CALM: ResourcePressure = { underPressure: false, reasons: [], freeMemRatio: 0.5, loadPerCpu: 0.2 }
const STRAINED: ResourcePressure = { underPressure: true, reasons: ['free memory 0.4 GiB (2%)'], freeMemRatio: 0.02, loadPerCpu: 0.5 }

interface Harness {
  db: DatabaseManager
  manager: AgentManager
  agentId: string
  projectId: string
  started: string[]
  stopSpy: ReturnType<typeof vi.spyOn>
  pressure: { current: ResourcePressure }
  createProject: (name: string, settings?: Record<string, unknown>) => string
  createTask: (overrides?: Parameters<typeof makeTask>[0], agent?: string) => TaskRecord
}

function setup(cap = 5): Harness {
  const { db } = createTestDb()
  const manager = new AgentManager(db)
  vi.spyOn(manager as any, 'sendToRenderer').mockImplementation(() => undefined)
  vi.spyOn(manager as any, 'getAdapter').mockReturnValue(null)
  const pressure = { current: CALM }
  vi.spyOn(manager, 'getResourcePressure').mockImplementation(() => pressure.current)
  const stopSpy = vi.spyOn(manager, 'stopSession').mockResolvedValue(undefined as any)

  const started: string[] = []
  let sequence = 0
  vi.spyOn(manager as any, 'startSessionNow').mockImplementation(async (...args: unknown[]) => {
    const [agentId, taskId] = args as [string, string]
    const id = `session-${++sequence}`
    ;(manager as any).sessions.set(id, {
      id, agentId, taskId, status: 'working', createdAt: new Date(),
      seenMessageIds: new Set(), seenPartIds: new Set(), partContentLengths: new Map()
    })
    if (db.getTask(taskId)) db.updateTask(taskId, { status: TaskStatus.AgentWorking, session_id: id })
    started.push(taskId)
    return id
  })

  const agentId = db.createAgent(makeAgent({ name: 'Builder', config: { concurrency_cap: cap } as any }))!.id
  const createProject = (name: string, settings: Record<string, unknown> = {}): string => db.createProject({ name, settings })!.id
  const projectId = createProject('Alpha')
  const createTask = (overrides: Parameters<typeof makeTask>[0] = {}, agent = agentId): TaskRecord => {
    const task = db.createTask(makeTask({ project_id: projectId, ...overrides }))!
    return db.updateTask(task.id, { agent_id: agent })!
  }
  return { db, manager, agentId, projectId, started, stopSpy, pressure, createProject, createTask }
}

async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

function goIdle(manager: AgentManager, taskId: string): void {
  const found = manager.findSessionByTaskId(taskId)!
  found.session.status = 'idle'
  ;(manager as any).emitStatus(found.sessionId, found.session, 'idle')
}

const captainScope = (projectId: string): TaskMcpScope => ({ parentTaskId: null, taskId: null, artifactTaskId: null, projectId })
const invoke = (db: DatabaseManager) => (route: string, params: Record<string, unknown>) => handleRoute(db, route, params)
const parse = (result: { content: Array<{ text: string }> }): any => JSON.parse(result.content[0].text)

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  setTaskApiAgentController(null)
})

describe('working level (#150)', () => {
  it('starts at 1: the second job of the agent in the project waits with concurrency_level', async () => {
    const { manager, createTask, started } = setup()
    const [a, b] = [createTask({ title: 'A' }), createTask({ title: 'B' })]
    expect((await manager.startTask(a.id)).action).toBe('task_started')
    expect(await manager.startTask(b.id)).toMatchObject({ action: 'queued', queueReason: 'concurrency_level' })
    expect(started).toEqual([a.id])
  })

  it('a raise drains the queue at once', async () => {
    const { manager, createTask, started, projectId, agentId } = setup()
    const [a, b, c] = [createTask({ title: 'A' }), createTask({ title: 'B' }), createTask({ title: 'C' })]
    await manager.startTask(a.id)
    await manager.startTask(b.id)
    await manager.startTask(c.id)
    expect(started).toEqual([a.id])
    expect(manager.setConcurrencyLevel({ projectId, agentId, level: 3, reason: 'three independent tickets' })).toMatchObject({ success: true, previous_level: 1, level: 3 })
    await settle()
    expect(started).toEqual([a.id, b.id, c.id])
  })

  it('clamps at the hard cap of 5: 5 is accepted, 6 is refused and nothing changes', () => {
    const { manager, projectId, agentId, db } = setup(5)
    expect(manager.setConcurrencyLevel({ projectId, agentId, level: 5, reason: 'deep queue' })).toMatchObject({ success: true, level: 5, cap: 5 })
    const refused = manager.setConcurrencyLevel({ projectId, agentId, level: 6, reason: 'deeper queue' })
    expect(refused).toEqual({ error: expect.stringMatching(/Refused: level 6 is above this agent's hard cap of 5/) })
    expect(manager.getConcurrencyState(projectId).agents.find((a) => a.agentId === agentId)).toMatchObject({ level: 5, cap: 5 })
    // Refusals are not audited as changes.
    expect(db.listConcurrencyAudit(projectId)).toHaveLength(1)
  })

  it('never admits more than the hard cap across projects, whatever the levels', async () => {
    const { manager, createTask, createProject, started, agentId, projectId } = setup(2)
    const other = createProject('Beta', { concurrency: { captain_control: false } })
    manager.setConcurrencyLevel({ projectId, agentId, level: 2, reason: 'parallel work' })
    const [a, b] = [createTask({ title: 'A' }), createTask({ title: 'B' })]
    const c = createTask({ title: 'C', project_id: other })
    await manager.startTask(a.id)
    await manager.startTask(b.id)
    expect(await manager.startTask(c.id)).toMatchObject({ action: 'queued', queueReason: 'agent_limit' })
    expect(started).toEqual([a.id, b.id])
  })

  it('lowering defers new starts but never stops running work', async () => {
    const { manager, createTask, started, projectId, agentId, stopSpy } = setup()
    manager.setConcurrencyLevel({ projectId, agentId, level: 3, reason: 'parallel work' })
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((title) => createTask({ title }))
    for (const t of [a, b, c]) await manager.startTask(t.id)
    expect(started).toEqual([a.id, b.id, c.id])

    const lowered = manager.setConcurrencyLevel({ projectId, agentId, level: 1, reason: 'the rest is a serial chain' })
    expect(lowered).toMatchObject({ success: true, previous_level: 3, level: 1, running_in_project: 3 })
    expect((lowered as any).note).toMatch(/Running work is never stopped/)
    expect(stopSpy).not.toHaveBeenCalled()
    for (const t of [a, b, c]) expect(manager.findSessionByTaskId(t.id)!.session.status).toBe('working')

    expect(await manager.startTask(d.id)).toMatchObject({ action: 'queued', queueReason: 'concurrency_level' })
    goIdle(manager, a.id)
    goIdle(manager, b.id)
    await settle()
    expect(started).toEqual([a.id, b.id, c.id]) // one still runs: level 1 is reached
    goIdle(manager, c.id)
    await settle()
    expect(started).toEqual([a.id, b.id, c.id, d.id])
  })

  it('a pin and Captain control off are the user\'s: the Captain is refused, the user is audited', () => {
    const { manager, projectId, agentId, db, createTask } = setup()
    createTask({ title: 'Work for the agent' })
    expect(manager.setUserConcurrency(projectId, { agentId, pinnedLevel: 2 })).toEqual({ success: true })
    expect(manager.setConcurrencyLevel({ projectId, agentId, level: 3, reason: 'more' })).toEqual({ error: expect.stringMatching(/pinned/) })
    expect(manager.setUserConcurrency(projectId, { agentId, pinnedLevel: 9 })).toEqual({ error: expect.stringMatching(/hard cap of 5/) })
    manager.setUserConcurrency(projectId, { agentId, pinnedLevel: null })
    manager.setUserConcurrency(projectId, { captainControl: false })
    expect(manager.setConcurrencyLevel({ projectId, agentId, level: 3, reason: 'more' })).toEqual({ error: expect.stringMatching(/Captain control/) })
    expect(manager.getConcurrencyState(projectId).agents[0]).toMatchObject({ level: 5, source: 'cap' })
    expect(db.listConcurrencyAudit(projectId).map((e) => [e.kind, e.actor])).toEqual([
      ['control_off', 'user'],
      ['unpin', 'user'],
      ['pin', 'user']
    ])
  })
})

describe('resource pressure (#150)', () => {
  it('refuses a raise while the machine is under pressure, but allows a lower', () => {
    const { manager, projectId, agentId, pressure } = setup()
    manager.setConcurrencyLevel({ projectId, agentId, level: 3, reason: 'parallel work' })
    pressure.current = STRAINED
    expect(manager.setConcurrencyLevel({ projectId, agentId, level: 4, reason: 'more' })).toEqual({ error: expect.stringMatching(/resource pressure/) })
    expect(manager.setConcurrencyLevel({ projectId, agentId, level: 2, reason: 'machine is busy' })).toMatchObject({ success: true, level: 2 })
  })

  it('auto-lowers Captain-controlled levels one step per confirmed reading, leaving pins and running work alone', async () => {
    const { manager, projectId, agentId, db, createTask, createProject, stopSpy, started } = setup()
    const pinnedProject = createProject('Pinned')
    manager.setConcurrencyLevel({ projectId, agentId, level: 3, reason: 'parallel work' })
    manager.setUserConcurrency(pinnedProject, { agentId, pinnedLevel: 3 })
    const tasks = ['A', 'B', 'C'].map((title) => createTask({ title }))
    for (const t of tasks) await manager.startTask(t.id)
    expect(started).toHaveLength(3)

    let now = 0
    const samples = [
      { freeMemBytes: 0.2 * 1024 ** 3, totalMemBytes: 16 * 1024 ** 3, loadAvg1: 0, cpuCount: 8 }
    ]
    const monitor = new ResourceMonitor({
      sample: () => samples[0],
      confirmSamples: 2,
      cooldownMs: 60_000,
      now: () => now,
      onPressure: (p) => (manager as any).lowerLevelsForPressure(p)
    })
    monitor.tick() // first reading: not yet confirmed
    expect(manager.getConcurrencyState(projectId).agents[0].level).toBe(3)
    monitor.tick() // confirmed: one step down
    expect(manager.getConcurrencyState(projectId).agents[0].level).toBe(2)
    now = 30_000
    monitor.tick() // within the cooldown: no further step
    expect(manager.getConcurrencyState(projectId).agents[0].level).toBe(2)
    now = 61_000
    monitor.tick()
    expect(manager.getConcurrencyState(projectId).agents[0].level).toBe(1)

    expect(manager.getConcurrencyState(pinnedProject).agents[0]).toMatchObject({ level: 3, source: 'pinned' })
    expect(stopSpy).not.toHaveBeenCalled()
    for (const t of tasks) expect(manager.findSessionByTaskId(t.id)!.session.status).toBe('working')

    const system = db.listConcurrencyAudit(projectId).filter((e) => e.actor === 'system')
    expect(system).toHaveLength(2)
    expect(system[0].reason).toMatch(/^Resource pressure: free memory/)
  })
})

describe('file overlap (#150)', () => {
  it('serialises tickets that declare the same files, and lets others through', async () => {
    const { manager, createTask, started, projectId, agentId } = setup()
    manager.setConcurrencyLevel({ projectId, agentId, level: 5, reason: 'parallel work' })
    const [a, b, c] = [createTask({ title: 'A' }), createTask({ title: 'B' }), createTask({ title: 'C' })]
    manager.setTaskTouches(a.id, ['src/main/agent-manager.ts'])
    manager.setTaskTouches(b.id, ['src/main/'])
    manager.setTaskTouches(c.id, ['docs/concurrency.md'])

    await manager.startTask(a.id)
    expect(await manager.startTask(b.id)).toMatchObject({ action: 'queued', queueReason: 'file_overlap' })
    expect((await manager.startTask(c.id)).action).toBe('task_started')

    goIdle(manager, a.id)
    await settle()
    expect(started).toEqual([a.id, c.id, b.id])
  })

  it('uses the branch diff of a running task that declared nothing', async () => {
    const { manager, createTask, projectId, agentId } = setup()
    manager.setConcurrencyLevel({ projectId, agentId, level: 5, reason: 'parallel work' })
    const [a, b] = [createTask({ title: 'A' }), createTask({ title: 'B' })]
    await manager.startTask(a.id)
    ;(manager as any).branchDiffs.set(a.id, ['src/shared/concurrency.ts'])
    manager.setTaskTouches(b.id, ['src/shared/concurrency.ts'])
    expect(await manager.startTask(b.id)).toMatchObject({ action: 'queued', queueReason: 'file_overlap' })
  })

  it('ignores the same path in different repos', async () => {
    const { manager, createTask, projectId, agentId } = setup()
    manager.setConcurrencyLevel({ projectId, agentId, level: 5, reason: 'parallel work' })
    const a = createTask({ title: 'A', repos: ['org/one'] })
    const b = createTask({ title: 'B', repos: ['org/two'] })
    manager.setTaskTouches(a.id, ['README.md'])
    manager.setTaskTouches(b.id, ['README.md'])
    await manager.startTask(a.id)
    expect((await manager.startTask(b.id)).action).toBe('task_started')
  })
})

describe('priority-aware queue (#150)', () => {
  it('starts a critical ticket before older, lower-priority ones of its project', async () => {
    const { manager, createTask, started } = setup()
    const running = createTask({ title: 'Running', priority: 'low' })
    await manager.startTask(running.id)
    const low = createTask({ title: 'Low', priority: 'low' })
    const medium = createTask({ title: 'Medium', priority: 'medium' })
    const medium2 = createTask({ title: 'Medium 2', priority: 'medium' })
    const critical = createTask({ title: 'Critical', priority: 'critical' })
    for (const t of [low, medium, medium2, critical]) await manager.startTask(t.id)

    expect(manager.getStartQueue().map((q) => q.taskId)).toEqual([critical.id, medium.id, medium2.id, low.id])
    goIdle(manager, running.id)
    await settle()
    expect(started).toEqual([running.id, critical.id])
  })

  it('picks up a priority raised while the ticket waits', async () => {
    const { manager, createTask, db } = setup()
    await manager.startTask(createTask({ title: 'Running' }).id)
    const first = createTask({ title: 'First' })
    const second = createTask({ title: 'Second' })
    await manager.startTask(first.id)
    await manager.startTask(second.id)
    db.updateTask(second.id, { priority: 'critical' })
    manager.drainStartQueue()
    expect(manager.getStartQueue().map((q) => q.taskId)).toEqual([second.id, first.id])
  })

  it('does not starve another project: its low ticket runs before the busy project\'s later critical ones', async () => {
    const { manager, createTask, createProject, started } = setup(1)
    const busy = createProject('Busy', { concurrency: { captain_control: false } })
    const quiet = createProject('Quiet', { concurrency: { captain_control: false } })
    const running = createTask({ title: 'Running', project_id: busy })
    await manager.startTask(running.id)
    const crit1 = createTask({ title: 'Crit 1', priority: 'critical', project_id: busy })
    const crit2 = createTask({ title: 'Crit 2', priority: 'critical', project_id: busy })
    await manager.startTask(crit1.id)
    await manager.startTask(crit2.id)
    const quietLow = createTask({ title: 'Quiet low', priority: 'low', project_id: quiet })
    await manager.startTask(quietLow.id)

    // Busy already has a job running; Quiet has had nothing, so it goes first.
    expect(manager.getStartQueue().map((q) => q.taskId)).toEqual([quietLow.id, crit1.id, crit2.id])
    goIdle(manager, running.id)
    await settle()
    expect(started).toEqual([running.id, quietLow.id])
    goIdle(manager, quietLow.id)
    await settle()
    expect(started).toEqual([running.id, quietLow.id, crit1.id])
  })
})

describe('Captain tools and audit (#150)', () => {
  it('set_concurrency from the Captain is audited in the feed and the status journal', async () => {
    const { manager, db, projectId, agentId } = setup()
    setTaskApiAgentController(manager)
    const result = await callToolForScope('set_concurrency', { agent_id: agentId, level: 2, reason: 'two independent UI tickets' }, captainScope(projectId), invoke(db))
    expect(result.isError).toBeFalsy()
    expect(parse(result)).toMatchObject({ success: true, previous_level: 1, level: 2, cap: 5 })

    const [row] = db.listConcurrencyAudit(projectId)
    expect(row).toMatchObject({ agent_id: agentId, kind: 'level', previous_level: 1, level: 2, cap: 5, actor: 'captain', reason: 'two independent UI tickets' })
    const journal = db.listProjectStatusJournal(projectId, { limit: 5 }).entries
    expect(journal[0].summary).toMatch(/^Concurrency: The Captain set Builder's working level from 1 to 2 \(hard cap 5\)\. Reason: two independent UI tickets/)
    expect(journal[0].decisions[0]).toMatch(/two independent UI tickets/)

    const state = parse(await callToolForScope('get_concurrency', {}, captainScope(projectId), invoke(db)))
    expect(state.agents[0]).toMatchObject({ agentId, cap: 5, level: 2, source: 'captain' })
    expect(state.recentChanges[0].reason).toBe('two independent UI tickets')
  })

  it('refuses above the cap through the tool, and only the Captain may call it', async () => {
    const { manager, db, projectId, agentId, createTask } = setup()
    setTaskApiAgentController(manager)
    const above = await callToolForScope('set_concurrency', { agent_id: agentId, level: 6, reason: 'more' }, captainScope(projectId), invoke(db))
    expect(above.isError).toBe(true)
    expect(parse(above).error).toMatch(/hard cap of 5/)

    const task = createTask()
    const taskAgent: TaskMcpScope = { parentTaskId: null, taskId: task.id, artifactTaskId: task.id, projectId }
    const denied = await callToolForScope('set_concurrency', { agent_id: agentId, level: 2, reason: 'x' }, taskAgent, invoke(db))
    expect(parse(denied).error).toMatch(/only the project's Captain/)

    const elsewhere = await callToolForScope('set_concurrency', { agent_id: agentId, level: 2, reason: 'x', project: 'another' }, captainScope(projectId), invoke(db))
    expect(parse(elsewhere).error).toMatch(/its own project/)
    expect(db.listConcurrencyAudit(projectId)).toHaveLength(0)
  })

  it('set_task_touches stores normalised paths for a task agent of the project', async () => {
    const { manager, db, projectId, createTask } = setup()
    setTaskApiAgentController(manager)
    const task = createTask()
    const taskAgent: TaskMcpScope = { parentTaskId: null, taskId: task.id, artifactTaskId: task.id, projectId }
    const result = parse(await callToolForScope('set_task_touches', { task_id: task.id, paths: ['./src/a.ts', 'src\\b.ts', 'src/a.ts', ''] }, taskAgent, invoke(db)))
    expect(result.touches).toEqual(['src/a.ts', 'src/b.ts'])
    expect(db.getTaskTouches(task.id)).toEqual(['src/a.ts', 'src/b.ts'])
  })
})


describe('independent concurrency review', () => {
  it('reserves slots during a simultaneous cross-project burst and clamps lowered caps', async () => {
    const { manager, db, createTask, createProject, projectId, agentId, started, stopSpy } = setup(5)
    const beta = createProject('Beta')
    manager.setConcurrencyLevel({ projectId, agentId, level: 3, reason: 'independent work' })
    manager.setConcurrencyLevel({ projectId: beta, agentId, level: 3, reason: 'independent work' })
    const tasks = Array.from({ length: 40 }, (_, i) => createTask({
      title: `Burst ${i}`, project_id: i % 2 ? beta : projectId
    }))
    await Promise.all(tasks.map((t) => manager.startTask(t.id)))
    expect(started).toHaveLength(5)
    for (const id of [projectId, beta]) {
      expect(manager.getConcurrencyState(id).agents[0].runningInProject).toBeLessThanOrEqual(3)
    }
    db.updateAgent(agentId, { config: { concurrency_cap: 2 } as any })
    manager.recheckStartQueue()
    await settle()
    expect(started).toHaveLength(5)
    expect(stopSpy).not.toHaveBeenCalled()
    expect(manager.getConcurrencyState(projectId).agents[0]).toMatchObject({ cap: 2, level: 2 })
    for (const id of started.slice(0, 3)) goIdle(manager, id)
    await settle()
    expect(started).toHaveLength(5) // two still hold the lowered cap
    goIdle(manager, started[3])
    await settle()
    expect(started).toHaveLength(6)
  })

  it('stops resource sampling and automatic writes at shutdown', async () => {
    vi.useFakeTimers()
    try {
      const { manager } = setup()
      const tick = vi.spyOn((manager as any).resourceMonitor, 'tick')
      await manager.stopAllSessions()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(tick).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
