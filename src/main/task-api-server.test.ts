import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeTask, makeAgent } from '../../test/helpers/task-fixtures'
import type { DatabaseManager } from './database'
import { getTaskApiToken, handleRoute, setTaskApiAgentController, setTaskApiNotifier, startTaskApiServer, stopTaskApiServer } from './task-api-server'
import { TaskStatus } from '../shared/constants'
import { setTaskAutomationTrigger, setTaskSchedulers } from './task-updates'

let db: DatabaseManager
let rawDb: import('better-sqlite3').Database

beforeEach(() => {
  ;({ db, rawDb } = createTestDb())
})

afterEach(() => {
  setTaskApiAgentController(null)
  setTaskApiNotifier(() => undefined)
  setTaskAutomationTrigger(null)
  stopTaskApiServer()
})

describe('explicit artifact workpiece routes', () => {
  it('creates an artifact, writes its owned file, lists it, and emits an update', async () => {
    const task = db.createTask(makeTask({ title: 'Artifact task' }))!
    const workspaceDir = await mkdtemp(join(tmpdir(), '20x-task-api-artifacts-'))
    vi.spyOn(db, 'getWorkspaceDir').mockReturnValue(workspaceDir)
    const apiPort = await startTaskApiServer(db)
    const notify = vi.fn()
    setTaskApiNotifier(notify)
    const post = async <T>(route: string, body: Record<string, unknown>): Promise<T> => {
      const response = await fetch(`http://127.0.0.1:${apiPort}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getTaskApiToken()}` },
        body: JSON.stringify(body)
      })
      return response.json() as Promise<T>
    }

    const created = await post<{ artifact: { artifactId: string } }>('/create_artifact', {
      task_id: task.id,
      title: 'Release notes',
      type: 'markdown'
    })
    expect(created.artifact.artifactId).toMatch(/^artifact_release-notes_/)

    const written = await post<{ artifact: { id: string; taskId: string; title: string; path: string } }>('/write_artifact_file', {
      task_id: task.id,
      artifact_id: created.artifact.artifactId,
      filename: 'README.md',
      content: '# Ready',
      preview: true
    })
    expect(written.artifact).toEqual(expect.objectContaining({
      taskId: task.id,
      title: 'Release notes',
      path: `artifacts/${created.artifact.artifactId}/README.md`
    }))
    expect(notify).toHaveBeenCalledWith('artifact:updated', expect.objectContaining({
      taskId: task.id,
      artifact: expect.objectContaining({ id: written.artifact.id })
    }))

    const listed = await post<Array<{ artifactId: string; files: string[] }>>('/list_artifacts', { task_id: task.id })
    expect(listed).toEqual([
      expect.objectContaining({ artifactId: created.artifact.artifactId, files: ['README.md'] })
    ])
    await rm(workspaceDir, { recursive: true, force: true })
  })
})

describe('authentication', () => {
  it.each([
    ['no credentials', {}],
    ['a wrong bearer token', { Authorization: 'Bearer wrong' }],
    ['a token of the right length but wrong value', { Authorization: `Bearer ${'0'.repeat(64)}` }]
  ])('rejects a request with %s before touching any route', async (_label, headers) => {
    const task = db.createTask(makeTask({ title: 'Untouched' }))!
    const port = await startTaskApiServer(db)

    const response = await fetch(`http://127.0.0.1:${port}/update_task`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', ...headers },
      body: JSON.stringify({ task_id: task.id, title: 'Changed by a web page' })
    })

    expect(response.status).toBe(401)
    expect(db.getTask(task.id)!.title).toBe('Untouched')
  })

  it('answers a malformed JSON body with 400', async () => {
    const port = await startTaskApiServer(db)

    const response = await fetch(`http://127.0.0.1:${port}/list_agents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getTaskApiToken()}` },
      body: '{not json'
    })

    expect(response.status).toBe(400)
  })

  it('rejects the MCP endpoint without the token', async () => {
    const port = await startTaskApiServer(db)

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' })

    expect(response.status).toBe(401)
  })

  it('accepts the token as a query parameter, which is how MCP sessions send it', async () => {
    const port = await startTaskApiServer(db)

    const response = await fetch(`http://127.0.0.1:${port}/list_agents?token=${getTaskApiToken()}`, { method: 'POST' })

    expect(response.status).toBe(200)
  })
})

describe('/update_task - triage status guard', () => {
  it('ignores a status change while the task is triaging but applies the other fields', async () => {
    const agent = db.createAgent(makeAgent({ name: 'Agent 1' }))!
    const task = db.createTask(makeTask({ title: 'Triage me' }))!
    db.updateTask(task.id, { status: TaskStatus.Triaging })

    const result = await handleRoute(db, '/update_task', { task_id: task.id, status: 'not_started', agent_id: agent.id })

    expect(result).toMatchObject({ success: true })
    expect(db.getTask(task.id)).toMatchObject({ status: TaskStatus.Triaging, agent_id: agent.id })
  })

  it('keeps a task in agent_learning while session feedback owns its completion', async () => {
    const task = db.createTask(makeTask({ title: 'Learning' }))!
    db.updateTask(task.id, { status: TaskStatus.AgentLearning })
    db.setSetting(`session-feedback-completion:${task.id}`, '1')

    await handleRoute(db, '/update_task', { task_id: task.id, status: TaskStatus.ReadyForReview })

    expect(db.getTask(task.id)!.status).toBe(TaskStatus.AgentLearning)
  })

  it('does not reopen a sourced task the user closed only locally', async () => {
    const source = db.createTaskSource({ name: 'Notion', plugin_id: 'notion', mcp_server_id: null })!
    const task = db.createTask(makeTask({ title: 'Closed here', source_id: source.id, external_id: 'page-2', source: 'Notion' }))!
    db.updateTask(task.id, { status: TaskStatus.Completed, complete_at_source: false })

    await handleRoute(db, '/update_task', { task_id: task.id, status: TaskStatus.AgentWorking })

    expect(db.getTask(task.id)!.status).toBe(TaskStatus.Completed)
  })

  it('reports a missing task without writing anything', async () => {
    expect(await handleRoute(db, '/update_task', { task_id: 'missing', title: 'x' })).toEqual({ error: 'Task not found' })
  })

  it('allows an agent to complete a source-less task directly', async () => {
    const task = db.createTask(makeTask({ title: 'Normal task' }))!
    expect(task.status).toBe('not_started')
    expect(task.source_id).toBeNull()
    const update = vi.spyOn(db, 'updateTask')
    expect(await handleRoute(db, '/update_task', { task_id: task.id, status: 'completed' })).toMatchObject({
      success: true,
      task: { id: task.id, status: 'completed' }
    })
    expect(update).toHaveBeenCalledWith(task.id, { status: 'completed' })
    expect(db.getTask(task.id)!.status).toBe('completed')
    expect(rawDb.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id)).toEqual({ status: 'completed' })
  })

  it('keeps source completion behind source confirmation', async () => {
    const source = db.createTaskSource({ name: 'Notion', plugin_id: 'notion', mcp_server_id: null })!
    const task = db.createTask(makeTask({ title: 'Sourced task', source_id: source.id, external_id: 'page-1', source: 'Notion' }))!

    expect(await handleRoute(db, '/update_task', { task_id: task.id, status: 'completed' })).toEqual({
      error: 'The task source must confirm completion before this task can close in 20x.'
    })
    expect(db.getTask(task.id)!.status).toBe('not_started')
  })
})

describe('/update_task - repos field', () => {
  it('accepts an array or a single repo string', async () => {
    const task = db.createTask(makeTask({ title: 'Task with repos' }))!

    await handleRoute(db, '/update_task', { task_id: task.id, repos: ['org/repo-1', 'org/repo-2'] })
    expect(db.getTask(task.id)!.repos).toEqual(['org/repo-1', 'org/repo-2'])

    await handleRoute(db, '/update_task', { task_id: task.id, repos: 'org/solo' })
    expect(db.getTask(task.id)!.repos).toEqual(['org/solo'])
  })
})

describe('task response shape', () => {
  it('keeps the legacy row shape: 0/1 flags, parsed arrays, raw recurrence pattern', async () => {
    const result = await handleRoute(db, '/create_task', {
      title: 'Nightly',
      cron: '0 9 * * *',
      labels: ['ops'],
      auto_complete_without_review: true
    }) as { task: Record<string, unknown> }

    expect(result.task).toMatchObject({
      title: 'Nightly',
      labels: ['ops'],
      skill_ids: [],
      is_recurring: 1,
      recurrence_pattern: '0 9 * * *',
      auto_start_agent: 0,
      auto_complete_without_review: 1,
      heartbeat_enabled: 0,
      complete_at_source: null
    })
    expect(result.task.id).not.toMatch(/^task_/)
    expect(await handleRoute(db, '/get_task', { task_id: result.task.id })).toEqual(result.task)
  })

  it('assigns the agent and skills a caller passes to /create_task', async () => {
    const agent = db.createAgent(makeAgent({ name: 'Assignee' }))!

    const result = await handleRoute(db, '/create_task', { title: 'Assigned', agent_id: agent.id, skill_ids: ['s1'] }) as { task: Record<string, unknown> }

    expect(result.task).toMatchObject({ agent_id: agent.id, skill_ids: ['s1'] })
  })

  it('reports a missing task', async () => {
    expect(await handleRoute(db, '/get_task', { task_id: 'missing' })).toEqual({ error: 'Task not found' })
  })

  it('hands a new recurring task to the recurrence scheduler', async () => {
    const initializeRecurringTask = vi.fn()
    setTaskSchedulers({ recurrence: { initializeRecurringTask } })
    try {
      const result = await handleRoute(db, '/create_task', { title: 'Weekly', cron: '0 9 * * 1' }) as { task: { id: string } }
      expect(initializeRecurringTask).toHaveBeenCalledWith(result.task.id)
    } finally {
      setTaskSchedulers({ recurrence: null })
    }
  })
})

describe('/list_repos', () => {
  it('returns distinct repos from historical tasks and the configured org', async () => {
    db.createTask(makeTask({ title: 'Task 1', repos: ['org/repo-a', 'org/repo-b'] }))
    db.createTask(makeTask({ title: 'Task 2', repos: ['org/repo-b', 'org/repo-c'] }))
    db.createTask(makeTask({ title: 'Task 3', repos: [] }))
    db.setSetting('github_org', 'my-org')

    const result = await handleRoute(db, '/list_repos', {}) as { repos: string[]; github_org: string | null }

    expect(result.repos.sort()).toEqual(['org/repo-a', 'org/repo-b', 'org/repo-c'])
    expect(result.github_org).toBe('my-org')
  })

  it('returns no repos and a null org when there are none', async () => {
    expect(await handleRoute(db, '/list_repos', {})).toEqual({ repos: [], github_org: null })
  })
})

describe('skill routes', () => {
  it('lists skills by confidence without their content', async () => {
    db.createSkill({ name: 'Low', description: 'd', content: 'SECRET CONTENT HERE', confidence: 0.2 })
    db.createSkill({ name: 'High', description: 'd', content: 'SECRET CONTENT HERE', confidence: 0.9 })

    const skills = await handleRoute(db, '/list_skills', {}) as Array<Record<string, unknown>>

    expect(skills.map((s) => s.name)).toEqual(['High', 'Low'])
    expect(skills[0]).not.toHaveProperty('content')
  })

  it('returns a skill with its content, or an error', async () => {
    const created = db.createSkill({ name: 'Full Skill', description: 'Desc', content: 'Full content body' })!

    expect(await handleRoute(db, '/get_skill', { skill_id: created.id })).toMatchObject({ name: 'Full Skill', content: 'Full content body' })
    expect(await handleRoute(db, '/get_skill', { skill_id: 'nonexistent' })).toEqual({ error: 'Skill not found' })
  })

  it('refuses a duplicate name on create', async () => {
    const created = db.createSkill({ name: 'Taken', description: 'd', content: 'c' })!

    const result = await handleRoute(db, '/create_skill', { name: 'Taken', description: 'd', content: 'c' }) as { error: string }

    expect(result.error).toContain(created.id)
  })

  it('updates skill fields and increments version', async () => {
    const created = db.createSkill({ name: 'Old Name', description: 'Old Desc', content: 'Old Content', tags: ['old'] })!

    const result = await handleRoute(db, '/update_skill', {
      skill_id: created.id, name: 'New Name', description: 'New Desc', content: 'New Content', tags: ['new', 'updated']
    })

    expect(result).toMatchObject({
      success: true,
      skill: { name: 'New Name', description: 'New Desc', content: 'New Content', tags: ['new', 'updated'], version: 2 }
    })
    expect(await handleRoute(db, '/update_skill', { skill_id: 'nonexistent', name: 'x' })).toEqual({ error: 'Skill not found' })
    expect(await handleRoute(db, '/update_skill', { skill_id: created.id })).toEqual({ error: 'No updates provided' })
  })

  it('soft-deletes a skill once', async () => {
    const created = db.createSkill({ name: 'To Delete', description: 'Will be deleted', content: 'Content' })!

    expect(await handleRoute(db, '/delete_skill', { skill_id: created.id })).toEqual({ success: true })
    expect(db.getSkill(created.id)).toBeUndefined()
    expect(await handleRoute(db, '/delete_skill', { skill_id: created.id })).toEqual({ error: 'Skill not found' })
  })
})

describe('/create_subtask', () => {
  it('creates a subtask under a parent, inheriting its repos and priority', async () => {
    const parentTask = db.createTask(makeTask({ title: 'Parent Task', repos: ['org/repo-1'], priority: 'high' }))!

    const result = await handleRoute(db, '/create_subtask', { parent_task_id: parentTask.id, title: 'Subtask 1', type: 'coding' }) as { task: { id: string } }

    expect(db.getTask(result.task.id)).toMatchObject({
      title: 'Subtask 1',
      type: 'coding',
      parent_task_id: parentTask.id,
      repos: ['org/repo-1'],
      priority: 'high'
    })
  })

  it('refuses an unknown parent', async () => {
    expect(await handleRoute(db, '/create_subtask', { parent_task_id: 'missing', title: 'x' })).toEqual({ error: 'Parent task not found' })
  })
})

describe('/list_subtasks', () => {
  it('returns subtasks in creation order, then as reordered', async () => {
    const parent = db.createTask(makeTask({ title: 'Parent' }))!
    const first = await handleRoute(db, '/create_subtask', { parent_task_id: parent.id, title: 'Sub 1' }) as { task: { id: string } }
    const second = await handleRoute(db, '/create_subtask', { parent_task_id: parent.id, title: 'Sub 2' }) as { task: { id: string } }

    const titles = async (): Promise<unknown[]> =>
      (await handleRoute(db, '/list_subtasks', { parent_task_id: parent.id }) as Array<Record<string, unknown>>).map((t) => t.title)

    expect(await titles()).toEqual(['Sub 1', 'Sub 2'])
    db.reorderSubtasks(parent.id, [second.task.id, first.task.id])
    expect(await titles()).toEqual(['Sub 2', 'Sub 1'])
  })

  it('returns empty array when no subtasks exist', async () => {
    const parent = db.createTask(makeTask({ title: 'No subtasks parent' }))!
    expect(await handleRoute(db, '/list_subtasks', { parent_task_id: parent.id })).toEqual([])
  })
})

describe('/start_task', () => {
  it('delegates to the agent controller and returns the started task', async () => {
    const agent = db.createAgent(makeAgent({ name: 'Test Agent' }))!
    const task = db.createTask(makeTask({ title: 'Parent task' }))!
    db.updateTask(task.id, { agent_id: agent.id })
    const controller = {
      startTask: vi.fn(async () => ({
        action: 'task_started' as const,
        sessionId: 'session-123',
        startedTaskId: task.id,
        agentId: agent.id
      }))
    }
    setTaskApiAgentController(controller as any)

    const port = await startTaskApiServer(db)
    const response = await fetch(`http://127.0.0.1:${port}/start_task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getTaskApiToken()}` },
      body: JSON.stringify({ task_id: task.id })
    })
    const result = await response.json() as Record<string, unknown>

    expect(controller.startTask).toHaveBeenCalledWith(task.id, {
      preferSubtasks: true,
      allowTriage: true
    })
    expect(result.success).toBe(true)
    expect(result.action).toBe('task_started')
    expect(result.sessionId).toBe('session-123')
    expect((result.task as Record<string, unknown>).id).toBe(task.id)
  })
})

describe('/wait_for_subtasks', () => {
  it('returns immediately when selected subtasks are already terminal', async () => {
    const agent = db.createAgent(makeAgent({ name: 'Subtask Agent' }))!
    const parent = db.createTask(makeTask({ title: 'Parent' }))!
    const subtask = db.createTask(makeTask({
      title: 'Review-ready subtask',
      parent_task_id: parent.id,
      status: TaskStatus.ReadyForReview
    }))!
    db.updateTask(subtask.id, { agent_id: agent.id })

    const port = await startTaskApiServer(db)
    const response = await fetch(`http://127.0.0.1:${port}/wait_for_subtasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getTaskApiToken()}` },
      body: JSON.stringify({ parent_task_id: parent.id, subtask_ids: [subtask.id], timeout_ms: 5_000 })
    })
    const result = await response.json() as Record<string, unknown>

    expect(result.success).toBe(true)
    expect(result.timed_out).toBe(false)
    expect((result.subtasks as Array<Record<string, unknown>>)[0].id).toBe(subtask.id)
    expect((result.subtasks as Array<Record<string, unknown>>)[0].status).toBe(TaskStatus.ReadyForReview)
  })
})

describe('subtask cascade delete', () => {
  it('deletes subtasks when parent is deleted', () => {
    const parent = db.createTask(makeTask({ title: 'Parent to delete' }))!
    const now = new Date().toISOString()

    rawDb.prepare(`
      INSERT INTO tasks (id, title, description, type, priority, status, assignee, labels, attachments, repos, output_fields, source, parent_task_id, created_at, updated_at)
      VALUES (?, ?, '', 'general', 'medium', 'not_started', '', '[]', '[]', '[]', '[]', 'local', ?, ?, ?)
    `).run('cascade-sub', 'Subtask to cascade', parent.id, now, now)

    expect(db.getTask('cascade-sub')).toBeDefined()

    db.deleteTask(parent.id)

    expect(db.getTask(parent.id)).toBeUndefined()
    expect(db.getTask('cascade-sub')).toBeUndefined()
  })
})

describe('Triage task status lifecycle', () => {
  it('supports the full triage lifecycle: not_started → triaging → not_started (with agent)', () => {
    const agent = db.createAgent(makeAgent({ name: 'Default Agent', is_default: true }))!
    const task = db.createTask(makeTask({ title: 'New task needing triage' }))!

    // Step 1: Task starts as not_started with no agent
    expect(task.status).toBe('not_started')
    expect(task.agent_id).toBeNull()

    // Step 2: Auto-start hook sets status to triaging
    db.updateTask(task.id, { status: 'triaging' as unknown as Parameters<typeof db.updateTask>[1]['status'] })
    const triagingTask = db.getTask(task.id)!
    expect(triagingTask.status).toBe('triaging')

    // Step 3: Triage agent assigns agent_id, skills, labels, priority
    db.updateTask(task.id, {
      agent_id: agent.id,
      skill_ids: ['skill-1', 'skill-2'],
      labels: ['frontend', 'bug'],
      priority: 'high'
    })
    const assignedTask = db.getTask(task.id)!
    expect(assignedTask.agent_id).toBe(agent.id)
    expect(assignedTask.skill_ids).toEqual(['skill-1', 'skill-2'])
    expect(assignedTask.labels).toEqual(['frontend', 'bug'])
    expect(assignedTask.priority).toBe('high')
    expect(assignedTask.status).toBe('triaging') // Still triaging

    // Step 4: transitionToIdle resets status to not_started
    db.updateTask(task.id, { status: 'not_started' as unknown as Parameters<typeof db.updateTask>[1]['status'] })
    const readyTask = db.getTask(task.id)!
    expect(readyTask.status).toBe('not_started')
    expect(readyTask.agent_id).toBe(agent.id) // Agent still assigned

    // Step 5: Auto-run picks up the task (status=not_started + agent_id set)
    // This would be handled by the auto-start hook
  })

  it('task created with agent_id already set skips triage', () => {
    const agent = db.createAgent(makeAgent({ name: 'Specific Agent' }))!
    const task = db.createTask(makeTask({ title: 'Pre-assigned task' }))!

    // Assign agent immediately after creation
    db.updateTask(task.id, { agent_id: agent.id })
    const assignedTask = db.getTask(task.id)!

    expect(assignedTask.status).toBe('not_started')
    expect(assignedTask.agent_id).toBe(agent.id)
    // This task should go directly to auto-run, not triage
  })
})

describe('/update_task - output_fields', () => {
  it('updates output_fields', async () => {
    const task = db.createTask(makeTask({ title: 'Task with outputs' }))!
    const outputFields = [
      { id: 'pr_url', name: 'Pull Request URL', type: 'url', required: true },
      { id: 'summary', name: 'Summary', type: 'textarea', required: false }
    ]

    await handleRoute(db, '/update_task', { task_id: task.id, output_fields: outputFields })

    expect(db.getTask(task.id)!.output_fields).toEqual(outputFields)
  })

  it('preserves existing output_fields when not included in update', async () => {
    const outputFields = [{ id: 'result', name: 'Result', type: 'text', required: true }]
    const task = db.createTask(makeTask({ title: 'Pre-defined outputs', output_fields: outputFields }))!

    await handleRoute(db, '/update_task', { task_id: task.id, labels: ['test'] })

    expect(db.getTask(task.id)).toMatchObject({ output_fields: outputFields, labels: ['test'] })
  })
})

describe('/create_subtask - output_fields', () => {
  it('creates subtask with output_fields', async () => {
    const parentTask = db.createTask(makeTask({ title: 'Parent' }))!
    const outputFields = [
      { id: 'findings', name: 'Findings', type: 'textarea', required: true },
      { id: 'approved', name: 'Approved', type: 'boolean', required: true }
    ]

    const result = await handleRoute(db, '/create_subtask', { parent_task_id: parentTask.id, title: 'With outputs', output_fields: outputFields }) as { task: { id: string } }

    expect(db.getTask(result.task.id)!.output_fields).toEqual(outputFields)
  })

  it('defaults to empty output_fields when not specified', async () => {
    const parentTask = db.createTask(makeTask({ title: 'Parent' }))!

    const result = await handleRoute(db, '/create_subtask', { parent_task_id: parentTask.id, title: 'No outputs' }) as { task: { output_fields: unknown[] } }

    expect(result.task.output_fields).toEqual([])
  })
})

describe('Triage lifecycle with output_fields', () => {
  it('triage agent can define output_fields during triage', () => {
    const agent = db.createAgent(makeAgent({ name: 'Default Agent', is_default: true }))!
    const task = db.createTask(makeTask({ title: 'Task needing triage and outputs' }))!

    // Task starts with no output_fields
    expect(task.output_fields).toEqual([])

    // Set to triaging
    db.updateTask(task.id, { status: 'triaging' as unknown as Parameters<typeof db.updateTask>[1]['status'] })

    // Triage agent assigns agent_id and output_fields
    const outputFields = [
      { id: 'pr_url', name: 'Pull Request URL', type: 'url', required: true },
      { id: 'test_results', name: 'Test Results', type: 'textarea', required: true },
      { id: 'files_changed', name: 'Files Changed', type: 'number', required: false }
    ]

    // Simulate handleRoute update_task with output_fields
    const updates = ['agent_id = ?', 'output_fields = ?', 'updated_at = ?']
    const params = [agent.id, JSON.stringify(outputFields), new Date().toISOString(), task.id]
    rawDb.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params)

    const triaged = db.getTask(task.id)!
    expect(triaged.agent_id).toBe(agent.id)
    expect(triaged.output_fields).toEqual(outputFields)
    expect(triaged.output_fields).toHaveLength(3)

    // After triage, status resets to not_started — output_fields preserved
    db.updateTask(task.id, { status: 'not_started' as unknown as Parameters<typeof db.updateTask>[1]['status'] })
    const readyTask = db.getTask(task.id)!
    expect(readyTask.status).toBe('not_started')
    expect(readyTask.output_fields).toEqual(outputFields) // Output fields persist
  })

  it('preserves externally-defined output_fields during triage', () => {
    const agent = db.createAgent(makeAgent({ name: 'Agent' }))!
    const existingOutputs = [
      { id: 'invoice_number', name: 'Invoice Number', type: 'text', required: true },
      { id: 'amount', name: 'Amount', type: 'number', required: true }
    ]
    const task = db.createTask(makeTask({
      title: 'Enterprise task with predefined outputs',
      output_fields: existingOutputs
    }))!

    expect(task.output_fields).toEqual(existingOutputs)

    // Triage agent preserves existing and adds more
    const mergedOutputs = [
      ...existingOutputs,
      { id: 'approval_status', name: 'Approval Status', type: 'list', required: true, options: ['approved', 'rejected'] }
    ]

    db.updateTask(task.id, {
      agent_id: agent.id,
      output_fields: mergedOutputs
    })

    const triaged = db.getTask(task.id)!
    expect(triaged.output_fields).toHaveLength(3)
    expect(triaged.output_fields[0].id).toBe('invoice_number')
    expect(triaged.output_fields[1].id).toBe('amount')
    expect(triaged.output_fields[2].id).toBe('approval_status')
    expect(triaged.output_fields[2].options).toEqual(['approved', 'rejected'])
  })
})

describe('/list_tasks - excludes recurring parent templates', () => {
  it('lists instances and ordinary tasks but not recurring templates', async () => {
    db.createTask(makeTask({ title: 'Normal Task' }))
    const template = db.createTask(makeTask({ title: 'Daily Standup Template', cron: '0 9 * * *' }))!
    db.createTask(makeTask({ title: 'Daily Standup - Apr 9', recurrence_parent_id: template.id }))

    const tasks = await handleRoute(db, '/list_tasks', {}) as Array<Record<string, unknown>>

    expect(tasks.map((t) => t.title).sort()).toEqual(['Daily Standup - Apr 9', 'Normal Task'])
  })
})

describe('agent_workload statistics - uses agent_working status', () => {
  it('counts tasks with agent_working status as active', () => {
    const agent = db.createAgent(makeAgent({ name: 'Stats Agent' }))!
    const t1 = db.createTask(makeTask({ title: 'Active task' }))!
    const t2 = db.createTask(makeTask({ title: 'Not started task' }))!
    const t3 = db.createTask(makeTask({ title: 'Another active task' }))!

    // Assign all to the same agent
    db.updateTask(t1.id, { agent_id: agent.id })
    db.updateTask(t2.id, { agent_id: agent.id })
    db.updateTask(t3.id, { agent_id: agent.id })

    // Set statuses
    rawDb.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('agent_working', t1.id)
    rawDb.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('not_started', t2.id)
    rawDb.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('agent_working', t3.id)

    // Simulate the agent_workload query (must use 'agent_working', not 'in_progress')
    const result = rawDb.prepare(`
      SELECT agent_id, COUNT(*) as task_count,
             SUM(CASE WHEN status = 'agent_working' THEN 1 ELSE 0 END) as active_count
      FROM tasks WHERE agent_id IS NOT NULL GROUP BY agent_id
    `).all() as Record<string, unknown>[]

    const agentRow = result.find((r) => r.agent_id === agent.id)
    expect(agentRow).toBeDefined()
    expect(agentRow!.task_count).toBe(3)
    expect(agentRow!.active_count).toBe(2)

    // Verify 'in_progress' would NOT match (regression guard)
    const wrongResult = rawDb.prepare(`
      SELECT SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as active_count
      FROM tasks WHERE agent_id IS NOT NULL
    `).get() as { active_count: number }
    expect(wrongResult.active_count).toBe(0)
  })

  it('completion_rate query counts agent_working tasks correctly', () => {
    db.createTask(makeTask({ title: 'Completed' }))!
    db.createTask(makeTask({ title: 'Working' }))!
    db.createTask(makeTask({ title: 'Not started' }))!

    rawDb.prepare("UPDATE tasks SET status = 'completed' WHERE title = 'Completed'").run()
    rawDb.prepare("UPDATE tasks SET status = 'agent_working' WHERE title = 'Working'").run()

    const stats = rawDb.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
             SUM(CASE WHEN status = 'agent_working' THEN 1 ELSE 0 END) as in_progress,
             SUM(CASE WHEN status = 'not_started' THEN 1 ELSE 0 END) as not_started
      FROM tasks
    `).get() as { total: number; completed: number; in_progress: number; not_started: number }

    expect(stats.total).toBe(3)
    expect(stats.completed).toBe(1)
    expect(stats.in_progress).toBe(1) // agent_working mapped to in_progress key
    expect(stats.not_started).toBe(1)
  })
})

describe('auto_start_agent over the task API', () => {
  /**
   * A caller reaching this server (MCP, a scheduled run) has no window. Before
   * this, `auto_start_agent` was simply dropped here — only
   * `auto_complete_without_review` was accepted — so a recurring task created
   * through MCP could never start itself, and every occurrence sat in
   * not_started.
   */
  const post = async <T>(port: number, route: string, body: Record<string, unknown>): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getTaskApiToken()}` },
      body: JSON.stringify(body)
    })
    return (await response.json()) as T
  }

  it('persists auto_start_agent from /create_task', async () => {
    const port = await startTaskApiServer(db)
    const trigger = vi.fn()
    setTaskAutomationTrigger(trigger)

    const created = await post<{ task: { id: string } }>(port, '/create_task', {
      title: 'Nightly report',
      cron: '0 9 * * *',
      auto_start_agent: true
    })

    const row = rawDb.prepare('SELECT auto_start_agent FROM tasks WHERE id = ?')
      .get(created.task.id) as { auto_start_agent: number }
    expect(row.auto_start_agent).toBe(1)
    expect(trigger).toHaveBeenCalled()
    setTaskAutomationTrigger(null)
  })

  it('defaults auto_start_agent to off when the caller does not ask for it', async () => {
    const port = await startTaskApiServer(db)
    const trigger = vi.fn()
    setTaskAutomationTrigger(trigger)

    const created = await post<{ task: { id: string } }>(port, '/create_task', { title: 'Plain task' })

    const row = rawDb.prepare('SELECT auto_start_agent FROM tasks WHERE id = ?')
      .get(created.task.id) as { auto_start_agent: number }
    expect(row.auto_start_agent).toBe(0)
    expect(trigger).not.toHaveBeenCalled()
    setTaskAutomationTrigger(null)
  })

  it('toggles auto_start_agent through /update_task', async () => {
    const task = db.createTask(makeTask({ title: 'Existing' }))!
    const port = await startTaskApiServer(db)

    await post(port, '/update_task', { task_id: task.id, auto_start_agent: true })
    expect((rawDb.prepare('SELECT auto_start_agent FROM tasks WHERE id = ?')
      .get(task.id) as { auto_start_agent: number }).auto_start_agent).toBe(1)

    await post(port, '/update_task', { task_id: task.id, auto_start_agent: false })
    expect((rawDb.prepare('SELECT auto_start_agent FROM tasks WHERE id = ?')
      .get(task.id) as { auto_start_agent: number }).auto_start_agent).toBe(0)
  })

  it('reconciles the automation flags when /update_task moves a task into review', async () => {
    const task = db.createTask(makeTask({ title: 'Finishing' }))!
    const port = await startTaskApiServer(db)
    const trigger = vi.fn()
    setTaskAutomationTrigger(trigger)

    await post(port, '/update_task', { task_id: task.id, status: TaskStatus.ReadyForReview })

    expect(trigger).toHaveBeenCalled()
    setTaskAutomationTrigger(null)
  })

  it('does not reconcile for an unrelated field change', async () => {
    const task = db.createTask(makeTask({ title: 'Finishing' }))!
    const port = await startTaskApiServer(db)
    const trigger = vi.fn()
    setTaskAutomationTrigger(trigger)

    await post(port, '/update_task', { task_id: task.id, description: 'just a note' })

    expect(trigger).not.toHaveBeenCalled()
    setTaskAutomationTrigger(null)
  })
})

describe('/create_subtask automation inheritance', () => {
  const post = async <T>(port: number, route: string, body: Record<string, unknown>): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getTaskApiToken()}` },
      body: JSON.stringify(body)
    })
    return (await response.json()) as T
  }

  const flagsOf = (id: string): { auto_start_agent: number; auto_complete_without_review: number } =>
    rawDb.prepare('SELECT auto_start_agent, auto_complete_without_review FROM tasks WHERE id = ?')
      .get(id) as { auto_start_agent: number; auto_complete_without_review: number }

  it('passes the parent auto-complete intent to its child', async () => {
    // A subtask cannot set itself to completed (the scoped MCP tools forbid it),
    // so without this a child of a self-resolving parent parks in review and
    // stalls the whole chain.
    const parent = db.createTask(makeTask({ title: 'Parent', auto_complete_without_review: true }))!
    const port = await startTaskApiServer(db)

    const created = await post<{ task: { id: string } }>(port, '/create_subtask', {
      parent_task_id: parent.id,
      title: 'Child'
    })

    expect(flagsOf(created.task.id).auto_complete_without_review).toBe(1)
  })

  it('does not pass auto_start_agent down — the parent and successor graph start children', async () => {
    const parent = db.createTask(makeTask({ title: 'Parent', auto_start_agent: true }))!
    const port = await startTaskApiServer(db)

    const created = await post<{ task: { id: string } }>(port, '/create_subtask', {
      parent_task_id: parent.id,
      title: 'Child'
    })

    expect(flagsOf(created.task.id).auto_start_agent).toBe(0)
  })

  it('leaves a child of an ordinary parent with both flags off', async () => {
    const parent = db.createTask(makeTask({ title: 'Parent' }))!
    const port = await startTaskApiServer(db)

    const created = await post<{ task: { id: string } }>(port, '/create_subtask', {
      parent_task_id: parent.id,
      title: 'Child'
    })

    expect(flagsOf(created.task.id)).toEqual({ auto_start_agent: 0, auto_complete_without_review: 0 })
  })

  it('lets an explicit value beat the inherited one', async () => {
    const parent = db.createTask(makeTask({ title: 'Parent', auto_complete_without_review: true }))!
    const port = await startTaskApiServer(db)

    const created = await post<{ task: { id: string } }>(port, '/create_subtask', {
      parent_task_id: parent.id,
      title: 'Child',
      auto_complete_without_review: false
    })

    expect(flagsOf(created.task.id).auto_complete_without_review).toBe(0)
  })

  it('asks the automation loop to start the new child straight away', async () => {
    const parent = db.createTask(makeTask({ title: 'Parent', auto_start_agent: true }))!
    const port = await startTaskApiServer(db)
    const trigger = vi.fn()
    setTaskAutomationTrigger(trigger)

    await post(port, '/create_subtask', { parent_task_id: parent.id, title: 'Child' })

    expect(trigger).toHaveBeenCalled()
    setTaskAutomationTrigger(null)
  })
})

describe('successor edges over the task API', () => {
  const post = async <T>(port: number, route: string, body: Record<string, unknown>): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getTaskApiToken()}` },
      body: JSON.stringify(body)
    })
    return (await response.json()) as T
  }

  it('sets sibling successors through /update_task and rejects non-siblings', async () => {
    const parent = db.createTask(makeTask({ title: 'Parent' }))!
    const first = db.createTask(makeTask({ title: 'First', parent_task_id: parent.id }))!
    const second = db.createTask(makeTask({ title: 'Second', parent_task_id: parent.id }))!
    const outsider = db.createTask(makeTask({ title: 'Outsider' }))!
    const port = await startTaskApiServer(db)

    const ok = await post<{ task: { next_subtask_ids: string[] } }>(port, '/update_task', {
      task_id: first.id, next_subtask_ids: [second.id]
    })
    expect(ok.task.next_subtask_ids).toEqual([second.id])

    const rejected = await post<{ error?: string }>(port, '/update_task', {
      task_id: first.id, next_subtask_ids: [outsider.id]
    })
    expect(rejected.error).toContain('must be a sibling')
    expect(db.getTask(first.id)?.next_subtask_ids).toEqual([second.id])
  })

  it('creates a subtask with successors and drops it when the edge is invalid', async () => {
    const parent = db.createTask(makeTask({ title: 'Parent' }))!
    const existing = db.createTask(makeTask({ title: 'Existing', parent_task_id: parent.id }))!
    const port = await startTaskApiServer(db)

    const created = await post<{ task: { id: string; next_subtask_ids: string[] } }>(port, '/create_subtask', {
      parent_task_id: parent.id, title: 'New', next_subtask_ids: [existing.id]
    })
    expect(created.task.next_subtask_ids).toEqual([existing.id])

    const rejected = await post<{ error?: string }>(port, '/create_subtask', {
      parent_task_id: parent.id, title: 'Bad', next_subtask_ids: ['missing-task']
    })
    expect(rejected.error).toContain('must be a sibling')
    expect(db.getSubtasks(parent.id).map((t) => t.title)).not.toContain('Bad')
  })
})
