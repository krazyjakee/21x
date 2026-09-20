import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { CaptainWaker, buildCaptainWakeMessage, resolveCaptainAgentId, taskIdsTouchedByCall } from './captain-waker'
import { emitTaskEvent, projectEvents, type ProjectEvent } from './project-events'
import { CAPTAIN_WAKEUPS_SETTING } from '../shared/captain-wakeups'
import { FINDINGS_BEGIN, SYSTEM_MESSAGE_MARKER } from '../shared/system-authority'
import { DEFAULT_PROJECT_ID } from '../shared/projects'
import type { DatabaseManager } from './database'

// ── Helpers ──────────────────────────────────────────────

/** Timers and a clock the tests drive by hand; flush() work is awaited after each fired timer. */
function fakeClock() {
  let now = 1_000_000
  let seq = 0
  const timers: Array<{ id: number; at: number; fn: () => void }> = []
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
  }
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = ++seq
      timers.push({ id, at: now + ms, fn })
      return id
    },
    clearTimer: (handle: unknown): void => {
      const index = timers.findIndex((t) => t.id === handle)
      if (index >= 0) timers.splice(index, 1)
    },
    pending: () => timers.length,
    /** Moves time forward, firing due timers in order. */
    advance: async (ms: number): Promise<void> => {
      const target = now + ms
      for (;;) {
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        now = due.at
        timers.splice(timers.indexOf(due), 1)
        due.fn()
        await settle()
      }
      now = target
      await settle()
    },
    settle
  }
}

type SessionStatus = 'idle' | 'working' | 'error' | 'waiting_approval'

function fakeAgents(live?: { sessionId: string; status: SessionStatus; agentId?: string }) {
  const state = { live }
  return {
    state,
    findSessionByTaskId: vi.fn(() =>
      state.live ? { sessionId: state.live.sessionId, session: { status: state.live.status, agentId: state.live.agentId ?? 'agent-1' } } : undefined
    ) as never,
    sendMessage: vi.fn(async () => ({})) as never
  }
}

function event(overrides: Partial<ProjectEvent> & { taskId: string }): ProjectEvent {
  return { kind: 'task_ready_for_review', projectId: DEFAULT_PROJECT_ID, title: `Task ${overrides.taskId}`, at: new Date().toISOString(), ...overrides }
}

/** A DB stub: one project (settings as given), one Captain row, one default agent. */
function fakeStore(settings: Record<string, unknown> = {}, opts: { archived?: boolean; noCoordinator?: boolean } = {}) {
  const project = {
    id: DEFAULT_PROJECT_ID, name: 'Default', description: '', default_agent_id: null, captain_agent_id: null,
    git_provider: null, git_org: null, settings, sort_order: 0, archived: opts.archived ?? false, created_at: '', updated_at: ''
  }
  return {
    getProject: vi.fn((id: string) => (id === project.id ? project : undefined)),
    getCoordinatorTask: vi.fn((id: string) => (id === project.id && !opts.noCoordinator ? { id: 'mm-1', role: 'captain', project_id: id } : undefined)),
    getAgents: vi.fn(() => [{ id: 'agent-1', is_default: true }])
  } as unknown as Pick<DatabaseManager, 'getProject' | 'getCoordinatorTask' | 'getAgents'>
}

const COORDINATOR_SCOPE = { parentTaskId: null, taskId: null, artifactTaskId: null, projectId: DEFAULT_PROJECT_ID }
const TASK_AGENT_SCOPE = { parentTaskId: null, taskId: null, artifactTaskId: 'agent-task', projectId: DEFAULT_PROJECT_ID }

describe('CaptainWaker', () => {
  let clock: ReturnType<typeof fakeClock>
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    clock = fakeClock()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function makeWaker(store = fakeStore(), agents = fakeAgents(), options: ConstructorParameters<typeof CaptainWaker>[2] = {}) {
    return new CaptainWaker(store, agents, { debounceMs: 3_000, hourlyCap: 12, ...clock, ...options })
  }

  it('delivers one batched wake-up for a new unassigned task, a finished task and a pending approval', async () => {
    const agents = fakeAgents()
    const waker = makeWaker(fakeStore(), agents)

    waker.handleEvent(event({ kind: 'task_synced', taskId: 'new', title: 'Synced issue', unassigned: true }))
    waker.handleEvent(event({ kind: 'task_ready_for_review', taskId: 'done', title: 'Finished work' }))
    waker.handleEvent(event({ kind: 'approval_pending', taskId: 'ask', title: 'Needs a yes' }))
    expect(agents.sendMessage).not.toHaveBeenCalled()

    await clock.advance(3_000)

    expect(agents.sendMessage).toHaveBeenCalledTimes(1)
    const [sessionId, message, taskId, agentId] = (agents.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, string, string]
    expect(sessionId).toBe('')
    expect(taskId).toBe('mm-1')
    expect(agentId).toBe('agent-1')
    expect(message.startsWith(SYSTEM_MESSAGE_MARKER)).toBe(true)
    expect(message).toContain('origin=coordinator-wakeup')
    expect(message).toContain(FINDINGS_BEGIN)
    expect(message).toContain('3 project events in "Default"')
    expect(message).toContain('"Synced issue" (id: new) — no agent assigned yet')
    expect(message).toContain('[ready for review] "Finished work" (id: done)')
    expect(message).toContain('[waiting for approval] "Needs a yes" (id: ask)')
    expect(message).toContain('`update_project_status`')
    expect(waker.pendingEvents(DEFAULT_PROJECT_ID)).toEqual([])
  })

  it('debounces: events inside the window share one wake-up, a later one starts the next', async () => {
    const agents = fakeAgents()
    const waker = makeWaker(fakeStore(), agents)

    waker.handleEvent(event({ taskId: 'a' }))
    await clock.advance(2_000)
    waker.handleEvent(event({ taskId: 'b' }))
    await clock.advance(1_000)
    expect(agents.sendMessage).toHaveBeenCalledTimes(1)
    expect((agents.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('2 project events')

    waker.handleEvent(event({ taskId: 'c' }))
    await clock.advance(3_000)
    expect(agents.sendMessage).toHaveBeenCalledTimes(2)
    expect((agents.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1][1]).toContain('1 project event in')
  })

  it('lists the same (kind, task) once per batch', async () => {
    const agents = fakeAgents()
    const waker = makeWaker(fakeStore(), agents)
    waker.handleEvent(event({ taskId: 'a' }))
    waker.handleEvent(event({ taskId: 'a' }))
    waker.handleEvent(event({ taskId: 'a', kind: 'task_failed' }))
    expect(waker.pendingEvents(DEFAULT_PROJECT_ID)).toHaveLength(2)
  })

  it('rejoins a live idle session on the Captain agent', async () => {
    const agents = fakeAgents({ sessionId: 'live-1', status: 'idle', agentId: 'agent-1' })
    const waker = makeWaker(fakeStore(), agents)
    waker.handleEvent(event({ taskId: 'a' }))
    await clock.advance(3_000)
    const [sessionId, , taskId, agentId] = (agents.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as string[]
    expect([sessionId, taskId, agentId]).toEqual(['live-1', 'mm-1', 'agent-1'])
  })

  it('does not wake a session left on an agent the Captain was switched away from', async () => {
    const agents = fakeAgents({ sessionId: 'live-1', status: 'idle', agentId: 'agent-old' })
    const waker = makeWaker(fakeStore(), agents)
    waker.handleEvent(event({ taskId: 'a' }))
    await clock.advance(3_000)
    // No session id: main starts the configured agent and stops the old one.
    const [sessionId, , taskId, agentId] = (agents.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as string[]
    expect([sessionId, taskId, agentId]).toEqual(['', 'mm-1', 'agent-1'])
  })

  it('waits for a working Captain instead of interrupting it', async () => {
    const agents = fakeAgents({ sessionId: 'live-1', status: 'working' })
    const waker = makeWaker(fakeStore(), agents)
    waker.handleEvent(event({ taskId: 'a' }))
    await clock.advance(3_000)
    expect(agents.sendMessage).not.toHaveBeenCalled()
    expect(waker.pendingEvents(DEFAULT_PROJECT_ID)).toHaveLength(1)

    // More events join the waiting batch; once idle, one message carries all of them.
    waker.handleEvent(event({ taskId: 'b' }))
    agents.state.live = { sessionId: 'live-1', status: 'idle' }
    await clock.advance(3_000)
    expect(agents.sendMessage).toHaveBeenCalledTimes(1)
    expect((agents.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('2 project events')
  })

  it('drops a batch the Captain never became free for', async () => {
    const agents = fakeAgents({ sessionId: 'live-1', status: 'working' })
    const waker = makeWaker(fakeStore(), agents, { maxDeferMs: 10_000 })
    waker.handleEvent(event({ taskId: 'a' }))
    await clock.advance(15_000)
    expect(agents.sendMessage).not.toHaveBeenCalled()
    expect(waker.pendingEvents(DEFAULT_PROJECT_ID)).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stale event'))
  })

  it('skips events the Captain caused itself, inside the window only', async () => {
    const agents = fakeAgents()
    const waker = makeWaker(fakeStore(), agents, { selfCausedWindowMs: 20_000 })

    // The Captain's own update_task call: coordinator-shaped scope, no artifact pin.
    waker.observeToolCall(COORDINATOR_SCOPE, { task_id: 'mine' }, { success: true, task: { id: 'mine' } })
    // A task agent's call in the same project is not the Captain.
    waker.observeToolCall(TASK_AGENT_SCOPE, { task_id: 'theirs' }, { success: true })

    waker.handleEvent(event({ taskId: 'mine' }))
    waker.handleEvent(event({ taskId: 'theirs' }))
    expect(waker.pendingEvents(DEFAULT_PROJECT_ID).map((e) => e.taskId)).toEqual(['theirs'])

    await clock.advance(25_000)
    waker.handleEvent(event({ taskId: 'mine', kind: 'task_failed' }))
    expect(waker.pendingEvents(DEFAULT_PROJECT_ID).map((e) => e.taskId)).toEqual(['mine'])
  })

  it('caps wake-ups per project per hour and logs once when capped', async () => {
    const agents = fakeAgents()
    const waker = makeWaker(fakeStore(), agents, { hourlyCap: 2 })

    for (const id of ['a', 'b', 'c', 'd']) {
      waker.handleEvent(event({ taskId: id }))
      await clock.advance(3_000)
    }
    expect(agents.sendMessage).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls.filter(([line]) => String(line).includes('Wake-up cap reached'))).toHaveLength(1)

    await clock.advance(60 * 60_000)
    waker.handleEvent(event({ taskId: 'e' }))
    await clock.advance(3_000)
    expect(agents.sendMessage).toHaveBeenCalledTimes(3)
  })

  it('does nothing when the project turned wake-ups off', async () => {
    const agents = fakeAgents()
    const waker = makeWaker(fakeStore({ [CAPTAIN_WAKEUPS_SETTING]: { enabled: false } }), agents)
    waker.handleEvent(event({ taskId: 'a' }))
    waker.handleEvent(event({ taskId: 'b', kind: 'approval_pending' }))
    await clock.advance(5_000)
    expect(agents.sendMessage).not.toHaveBeenCalled()
    expect(clock.pending()).toBe(0)
  })

  it('honours the per-kind choice', async () => {
    const agents = fakeAgents()
    const waker = makeWaker(fakeStore({ [CAPTAIN_WAKEUPS_SETTING]: { enabled: true, kinds: ['approval_pending'] } }), agents)
    waker.handleEvent(event({ taskId: 'a', kind: 'task_ready_for_review' }))
    waker.handleEvent(event({ taskId: 'b', kind: 'task_synced' }))
    waker.handleEvent(event({ taskId: 'c', kind: 'approval_pending' }))
    await clock.advance(3_000)
    expect(agents.sendMessage).toHaveBeenCalledTimes(1)
    const message = (agents.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(message).toContain('1 project event in')
    expect(message).toContain('(id: c)')
  })

  it('ignores archived projects and projects without a Captain row', async () => {
    const archived = fakeAgents()
    makeWaker(fakeStore({}, { archived: true }), archived).handleEvent(event({ taskId: 'a' }))
    await clock.advance(3_000)
    expect(archived.sendMessage).not.toHaveBeenCalled()

    const noRow = fakeAgents()
    makeWaker(fakeStore({}, { noCoordinator: true }), noRow).handleEvent(event({ taskId: 'a' }))
    await clock.advance(3_000)
    expect(noRow.sendMessage).not.toHaveBeenCalled()
  })

  it('counts events past the listing limit instead of listing them', async () => {
    const agents = fakeAgents()
    const waker = makeWaker(fakeStore(), agents, { maxEventsPerWake: 2 })
    for (const id of ['a', 'b', 'c']) waker.handleEvent(event({ taskId: id }))
    await clock.advance(3_000)
    const message = (agents.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(message).toContain('3 project events')
    expect(message).toContain('and 1 more')
    expect(message).not.toContain('(id: c)')
  })

  it('subscribes to the bus on start and lets go on stop', async () => {
    const agents = fakeAgents()
    const waker = makeWaker(fakeStore(), agents)
    waker.start()
    projectEvents.emitEvent(event({ taskId: 'a' }))
    expect(waker.pendingEvents(DEFAULT_PROJECT_ID)).toHaveLength(1)
    waker.stop()
    expect(clock.pending()).toBe(0)
    projectEvents.emitEvent(event({ taskId: 'b' }))
    expect(waker.pendingEvents(DEFAULT_PROJECT_ID)).toEqual([])
  })
})

describe('emitTaskEvent', () => {
  it('raises an event for the task\'s project with its title, and never for a coordinator row', () => {
    const { db } = createTestDb()
    const project = db.createProject({ name: 'Alpha' })!
    const task = db.createTask({ title: 'Ship it', project_id: project.id } as never)!
    const seen: ProjectEvent[] = []
    const off = projectEvents.onEvent((e) => seen.push(e))
    try {
      const raised = emitTaskEvent(db, 'task_ready_for_review', task.id, '  some   detail  ')
      expect(raised).toMatchObject({ kind: 'task_ready_for_review', projectId: project.id, taskId: task.id, title: 'Ship it', detail: 'some detail' })
      expect(seen).toHaveLength(1)

      const coordinator = db.getCoordinatorTask(project.id)!
      expect(emitTaskEvent(db, 'approval_pending', coordinator.id)).toBeNull()
      expect(emitTaskEvent(db, 'task_failed', 'nope')).toBeNull()
      expect(seen).toHaveLength(1)
    } finally {
      off()
    }
  })

  it('clips long details', () => {
    const { db } = createTestDb()
    const task = db.createTask({ title: 'T' } as never)!
    const raised = emitTaskEvent(db, 'heartbeat_finding', task.id, 'x'.repeat(1_000))
    expect(raised?.detail?.length).toBe(400)
    expect(raised?.detail?.endsWith('…')).toBe(true)
  })
})

describe('helpers', () => {
  it('resolveCaptainAgentId prefers the project agent, then the default agent, skipping unknown ids', () => {
    const db = { getAgents: () => [{ id: 'a' }, { id: 'b', is_default: true }] } as never
    expect(resolveCaptainAgentId(db, { captain_agent_id: 'a', default_agent_id: null })).toBe('a')
    expect(resolveCaptainAgentId(db, { captain_agent_id: 'gone', default_agent_id: 'a' })).toBe('a')
    expect(resolveCaptainAgentId(db, { captain_agent_id: null, default_agent_id: null })).toBe('b')
    expect(resolveCaptainAgentId({ getAgents: () => [] } as never, { captain_agent_id: null, default_agent_id: null })).toBeNull()
  })

  it('taskIdsTouchedByCall reads the argument ids and the created row', () => {
    expect(taskIdsTouchedByCall({ task_id: 't1', subtask_ids: ['s1', 's2'] }, { task: { id: 't1' } })).toEqual(['t1', 's1', 's2', 't1'])
    expect(taskIdsTouchedByCall({}, { id: 'new' })).toEqual(['new'])
    expect(taskIdsTouchedByCall({}, null)).toEqual([])
  })

  it('buildCaptainWakeMessage fences the events and states the boundary', () => {
    const message = buildCaptainWakeMessage('mm', 'P', [event({ taskId: 'x', kind: 'chain_stuck', detail: 'no agent' })])
    expect(message).toContain('[chain stuck] "Task x" (id: x) — no agent')
    expect(message).toContain('AUTHORITY BOUNDARY')
    expect(message).toContain('task=mm')
  })
})
