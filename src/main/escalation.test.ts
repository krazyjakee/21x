/**
 * Escalation policy (#66): the gate on the Captain's project-scoped tool
 * calls. `ask_user` holds the call until the user approves it, then runs it;
 * `tell_commander` runs it and reports; `autonomous` is untouched. Task
 * agents in the same project are not gated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeAgent, makeTask } from '../../test/helpers/task-fixtures'
import { callToolForScope, setCoordinatorCallGate, type TaskApiInvoke, type TaskMcpScope } from './mcp-servers/task-management-core'
import {
  actionForToolCall,
  approveHeldAction,
  clearHeldActions,
  configureEscalation,
  createCoordinatorEscalationGate,
  listHeldActions,
  rejectHeldAction,
  setCommanderEscalationHandler,
  type EscalationEvent
} from './escalation'
import { buildCaptainSystemPrompt } from './prompts/captain'
import { DEFAULT_ESCALATION_POLICY, escalationPolicyFromSettings, type EscalationPolicy } from '../shared/project-policies'
import { FINDINGS_BEGIN, SYSTEM_MESSAGE_MARKER } from '../shared/system-authority'
import type { DatabaseManager } from './database'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  Notification: class { show = vi.fn(); on = vi.fn(); static isSupported = vi.fn(() => false) },
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn(), isStarted: vi.fn(() => false) }
}))

interface Harness {
  db: DatabaseManager
  projectId: string
  taskId: string
  coordinatorScope: TaskMcpScope
  taskAgentScope: TaskMcpScope
  invoke: ReturnType<typeof vi.fn<TaskApiInvoke>>
  notifyUser: ReturnType<typeof vi.fn>
  notifyRenderer: ReturnType<typeof vi.fn>
  tellCaptain: ReturnType<typeof vi.fn>
  commander: ReturnType<typeof vi.fn>
}

function setup(policy: Partial<EscalationPolicy>): Harness {
  const { db } = createTestDb()
  const projectId = db.createProject({ name: 'Policy', settings: { escalation: policy } })!.id
  const agentId = db.createAgent(makeAgent({ name: 'Worker' }))!.id
  const task = db.createTask(makeTask({ title: 'Ship it', project_id: projectId }))!
  db.updateTask(task.id, { agent_id: agentId })

  // The routes, faked: membership checks read /get_task from the real rows.
  const invoke = vi.fn<TaskApiInvoke>(async (route, params) => {
    if (route === '/get_task') return db.getTask(String(params.task_id)) ?? { error: 'Task not found' }
    if (route === '/start_task') return { success: true, action: 'task_started', task_id: params.task_id }
    return { success: true, route, params }
  })

  const notifyUser = vi.fn()
  const notifyRenderer = vi.fn()
  const tellCaptain = vi.fn(async () => undefined)
  const commander = vi.fn()
  configureEscalation({ db, notifyUser, notifyRenderer, tellCaptain })
  setCoordinatorCallGate(createCoordinatorEscalationGate())
  setCommanderEscalationHandler(commander)

  return {
    db,
    projectId,
    taskId: task.id,
    coordinatorScope: { parentTaskId: null, taskId: null, artifactTaskId: null, projectId },
    taskAgentScope: { parentTaskId: null, taskId: task.id, artifactTaskId: task.id, projectId },
    invoke,
    notifyUser,
    notifyRenderer,
    tellCaptain,
    commander
  }
}

const parse = (result: { content: Array<{ text: string }> }): Record<string, unknown> => JSON.parse(result.content[0].text)
const routeCalls = (h: Harness, route: string) => h.invoke.mock.calls.filter(([r]) => r === route)

beforeEach(() => {
  vi.clearAllMocks()
  clearHeldActions()
})

afterEach(() => {
  setCoordinatorCallGate(null)
  setCommanderEscalationHandler(null)
  configureEscalation(null)
  clearHeldActions()
})

describe('escalation policy: ask_user', () => {
  it("holds the Captain's start_task until the user approves, then starts it (#66 acceptance)", async () => {
    const h = setup({ start_task: 'ask_user' })

    const result = await callToolForScope('start_task', { task_id: h.taskId }, h.coordinatorScope, h.invoke)
    expect(result.isError).toBeFalsy()
    const body = parse(result)
    expect(body).toMatchObject({ status: 'held', action: 'start_task' })
    expect(typeof body.id).toBe('string')
    expect(String(body.message)).toContain('Do not repeat the call')
    // Not started: the route was never reached.
    expect(routeCalls(h, '/start_task')).toHaveLength(0)

    // The user sees it.
    expect(listHeldActions(h.projectId)).toMatchObject([{ id: body.id, tool: 'start_task', action: 'start_task', summary: 'start "Ship it"' }])
    expect(h.notifyUser).toHaveBeenCalledWith(expect.stringContaining('needs approval'), expect.stringContaining('Ship it'))
    expect(h.notifyRenderer).toHaveBeenCalledWith('escalation:heldChanged', { held: expect.arrayContaining([expect.objectContaining({ id: body.id })]) })
    expect(h.commander).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'held', heldId: body.id, level: 'ask_user' }))

    // Approval runs the original call.
    const approved = await approveHeldAction(String(body.id))
    expect(approved).toMatchObject({ ok: true, result: { success: true, action: 'task_started', task_id: h.taskId } })
    expect(routeCalls(h, '/start_task')).toHaveLength(1)
    expect(listHeldActions()).toEqual([])

    // And the Captain is told, in a fenced system note it cannot read as a human order.
    expect(h.tellCaptain).toHaveBeenCalledTimes(1)
    const [projectId, text] = h.tellCaptain.mock.calls[0] as [string, string]
    expect(projectId).toBe(h.projectId)
    expect(text).toContain(SYSTEM_MESSAGE_MARKER)
    expect(text).toContain(FINDINGS_BEGIN)
    expect(text).toContain('approved')
    expect(text).toContain('task_started')
    expect(h.commander).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'approved', heldId: body.id }))
  })

  it('rejecting drops the call and tells the Captain, with the note', async () => {
    const h = setup({ start_task: 'ask_user' })
    const body = parse(await callToolForScope('start_task', { task_id: h.taskId }, h.coordinatorScope, h.invoke))

    expect(rejectHeldAction(String(body.id), 'Not before the release freeze.')).toBe(true)
    expect(rejectHeldAction(String(body.id))).toBe(false)
    expect(routeCalls(h, '/start_task')).toHaveLength(0)
    expect(listHeldActions()).toEqual([])
    const text = h.tellCaptain.mock.calls[0][1] as string
    expect(text).toContain('rejected')
    expect(text).toContain('Not before the release freeze.')
    expect(h.commander).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'rejected' }))
  })

  it('approving a call that then fails reports the failure rather than hiding it', async () => {
    const h = setup({ respond_to_checkpoint: 'ask_user' })
    h.invoke.mockImplementation(async (route: string, params: Record<string, unknown>) => {
      if (route === '/get_task') return h.db.getTask(String(params.task_id)) ?? { error: 'Task not found' }
      return { error: 'That task is not waiting for an answer' }
    })
    const body = parse(await callToolForScope('respond_to_checkpoint', { task_id: h.taskId, approved: true }, h.coordinatorScope, h.invoke))
    expect(body.status).toBe('held')
    expect(listHeldActions()[0].summary).toBe('approve the checkpoint on "Ship it"')

    const outcome = await approveHeldAction(String(body.id))
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('not waiting')
    expect(h.tellCaptain.mock.calls[0][1]).toContain('failed')
  })

  it('does not gate a task agent in the same project', async () => {
    const h = setup({ start_task: 'ask_user' })
    const result = await callToolForScope('start_task', { task_id: h.taskId }, h.taskAgentScope, h.invoke)
    expect(parse(result)).toMatchObject({ success: true, action: 'task_started' })
    expect(listHeldActions()).toEqual([])
    expect(h.notifyUser).not.toHaveBeenCalled()
  })

  it('never holds a call that failed the project membership check', async () => {
    const h = setup({ start_task: 'ask_user' })
    const result = await callToolForScope('start_task', { task_id: 'not-a-task' }, h.coordinatorScope, h.invoke)
    expect(result.isError).toBe(true)
    expect(listHeldActions()).toEqual([])
  })
})

describe('escalation policy: tell_commander', () => {
  it('performs the action, then escalates and notifies the user', async () => {
    const h = setup({ stop_task: 'tell_commander' })
    const result = await callToolForScope('stop_task', { task_id: h.taskId }, h.coordinatorScope, h.invoke)
    expect(result.isError).toBeFalsy()
    expect(parse(result)).toMatchObject({ success: true, route: '/stop_task', escalation: { level: 'tell_commander', reported: true } })
    expect(routeCalls(h, '/stop_task')).toHaveLength(1)
    expect(listHeldActions()).toEqual([])

    expect(h.commander).toHaveBeenCalledTimes(1)
    const event = h.commander.mock.calls[0][0] as EscalationEvent
    expect(event).toMatchObject({ projectId: h.projectId, action: 'stop_task', level: 'tell_commander', tool: 'stop_task', outcome: 'performed', summary: 'stop the agent on "Ship it"' })
    expect(h.notifyUser).toHaveBeenCalledWith(expect.stringContaining('Captain of Policy'), expect.stringContaining('stop the agent on "Ship it"'))
    expect(h.notifyRenderer).toHaveBeenCalledWith('escalation:event', expect.objectContaining({ outcome: 'performed' }))
  })

  it('does not report an action that failed', async () => {
    const h = setup({ stop_task: 'tell_commander' })
    h.invoke.mockImplementation(async (route: string, params: Record<string, unknown>) => {
      if (route === '/get_task') return h.db.getTask(String(params.task_id)) ?? { error: 'Task not found' }
      return { error: 'Agent controller not available' }
    })
    const result = await callToolForScope('stop_task', { task_id: h.taskId }, h.coordinatorScope, h.invoke)
    expect(result.isError).toBe(true)
    expect(h.commander).not.toHaveBeenCalled()
    expect(h.notifyUser).not.toHaveBeenCalled()
  })
})

describe('escalation policy: autonomous and the action mapping', () => {
  it('leaves an autonomous action untouched', async () => {
    const h = setup({ create_task: 'autonomous', start_task: 'autonomous' })
    const created = parse(await callToolForScope('create_task', { title: 'New one' }, h.coordinatorScope, h.invoke))
    expect(created).toMatchObject({ success: true, route: '/create_task' })
    expect(created.escalation).toBeUndefined()
    const started = parse(await callToolForScope('start_task', { task_id: h.taskId }, h.coordinatorScope, h.invoke))
    expect(started).toMatchObject({ success: true, action: 'task_started' })
    expect(h.commander).not.toHaveBeenCalled()
    expect(h.notifyUser).not.toHaveBeenCalled()
    expect(h.tellCaptain).not.toHaveBeenCalled()
  })

  it('uses the defaults when the project has no policy block', async () => {
    const h = setup({})
    // respond_to_checkpoint defaults to ask_user…
    const body = parse(await callToolForScope('respond_to_checkpoint', { task_id: h.taskId, approved: false }, h.coordinatorScope, h.invoke))
    expect(body.status).toBe('held')
    // …stop_task to tell_commander…
    await callToolForScope('stop_task', { task_id: h.taskId }, h.coordinatorScope, h.invoke)
    expect(h.commander).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'stop_task', outcome: 'performed' }))
    // …and create_task to autonomous.
    await callToolForScope('create_task', { title: 'Free' }, h.coordinatorScope, h.invoke)
    expect(routeCalls(h, '/create_task')).toHaveLength(1)
    expect(h.commander).toHaveBeenCalledTimes(2)
  })

  it('maps update_task to change_priority only when a priority is set', async () => {
    expect(actionForToolCall('update_task', { task_id: 't', priority: 'high' })).toBe('change_priority')
    expect(actionForToolCall('update_task', { task_id: 't', labels: ['x'] })).toBeNull()
    expect(actionForToolCall('create_subtask', {})).toBe('create_task')
    expect(actionForToolCall('get_task', {})).toBeNull()

    const h = setup({ change_priority: 'ask_user' })
    const relabel = parse(await callToolForScope('update_task', { task_id: h.taskId, labels: ['x'] }, h.coordinatorScope, h.invoke))
    expect(relabel).toMatchObject({ success: true, route: '/update_task' })
    const reprioritise = parse(await callToolForScope('update_task', { task_id: h.taskId, priority: 'critical' }, h.coordinatorScope, h.invoke))
    expect(reprioritise.status).toBe('held')
    expect(listHeldActions()[0].summary).toBe('set the priority of "Ship it" to critical')
  })
})

describe('the policy in settings and in the prompt', () => {
  it('parses with defaults for anything missing or invalid', () => {
    expect(escalationPolicyFromSettings(undefined)).toEqual(DEFAULT_ESCALATION_POLICY)
    expect(escalationPolicyFromSettings({ escalation: { start_task: 'ask_user', stop_task: 'whatever', extra: 'ask_user' } }))
      .toEqual({ ...DEFAULT_ESCALATION_POLICY, start_task: 'ask_user' })
  })

  it('adds an escalation section to the Captain prompt that names only real tools in backticks', () => {
    const prompt = buildCaptainSystemPrompt({ escalationPolicy: { ...DEFAULT_ESCALATION_POLICY, start_task: 'ask_user' } })
    expect(prompt).toContain('## Escalation policy')
    expect(prompt).toContain('starting agents (`start_task`): ask the user first.')
    expect(prompt).toContain('stopping agents (`stop_task`): do it, then it is reported')
    expect(prompt).toContain('returns status held')
    const section = prompt.slice(prompt.indexOf('## Escalation policy'))
    const referenced = [...section.matchAll(/`([a-z_]+)`/g)].map((m) => m[1])
    for (const name of referenced) {
      expect(['create_task', 'create_subtask', 'start_task', 'stop_task', 'respond_to_checkpoint', 'update_task']).toContain(name)
    }
    // Nothing waits for the user: the section says so instead of explaining held calls.
    const free = buildCaptainSystemPrompt({ escalationPolicy: { ...DEFAULT_ESCALATION_POLICY, respond_to_checkpoint: 'autonomous', pr: 'autonomous' } })
    expect(free).not.toContain('returns status held')
    expect(buildCaptainSystemPrompt()).not.toContain('## Escalation policy')
  })
})
