import { describe, it, expect, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { buildProjectStatus } from './project-status'
import { handleTaskRoute } from './task-api/task-routes'
import { callToolForScope, FULL_ACCESS_SCOPE, listToolsForScope } from './mcp-servers/task-management-core'
import { TaskStatus } from '../shared/constants'
import { DEFAULT_PROJECT_ID } from '../shared/projects'
import { PROJECT_STATUS_MAX_BLOCKERS, PROJECT_STATUS_SUMMARY_MAX_CHARS } from '../shared/project-status'

function seed() {
  const { db, rawDb } = createTestDb()
  const agent = db.createAgent({ name: 'Worker' })!
  const project = db.createProject({ name: 'Alpha' })!
  const task = (title: string, status: string, assigned = true, projectId = project.id) => {
    const created = db.createTask({ title, status, project_id: projectId } as never)!
    if (assigned) db.updateTask(created.id, { agent_id: agent.id })
    return created
  }
  return { db, rawDb, agent, project, task }
}

describe('DatabaseManager.getProjectStatus (#58)', () => {
  it('counts from the task rows and the caller\'s live facts, with no LLM anywhere', () => {
    const { db, project, task } = seed()
    task('working', TaskStatus.AgentWorking)
    task('triaging', TaskStatus.Triaging)
    const review = task('review', TaskStatus.ReadyForReview)
    task('done', TaskStatus.Completed)
    const queued = task('queued', TaskStatus.NotStarted)
    task('blocked: nobody to run it', TaskStatus.NotStarted, false)
    task('assigned, waiting for a slot on its own', TaskStatus.NotStarted)
    // Another project's tasks never leak in.
    task('elsewhere', TaskStatus.AgentWorking, true, DEFAULT_PROJECT_ID)

    const status = db.getProjectStatus(project.id, { queuedTaskIds: [queued.id], approvalTaskIds: [review.id] })
    expect(status.counts).toEqual({ running: 2, queued: 1, awaiting_review: 1, awaiting_approval: 1, blocked: 1 })
    expect(status.summary).toBe('')
    expect(status.top_blockers).toEqual([])
    expect(status.updated_at).toBeNull()

    // Without live facts the two live counts are 0, never guessed.
    expect(db.getProjectStatus(project.id).counts).toEqual({ running: 2, queued: 0, awaiting_review: 1, awaiting_approval: 0, blocked: 1 })
  })

  it('never counts the Captain row', () => {
    const { db, project } = seed()
    expect(db.getCoordinatorTask(project.id)).toBeDefined()
    expect(db.getProjectStatus(project.id).counts).toEqual({ running: 0, queued: 0, awaiting_review: 0, awaiting_approval: 0, blocked: 0 })
  })

  it('stores the narrative snapshot, capped, and reads it back with fresh counts', () => {
    const { db, project, task } = seed()
    task('working', TaskStatus.AgentWorking)

    const written = db.setProjectStatusSummary(project.id, `  ${'s'.repeat(PROJECT_STATUS_SUMMARY_MAX_CHARS + 50)}  `, ['b1', '', 'b2', 'b3', 'b4', 'b5', 'b6'])
    expect(written?.summary).toHaveLength(PROJECT_STATUS_SUMMARY_MAX_CHARS)
    expect(written?.top_blockers).toEqual(['b1', 'b2', 'b3', 'b4', 'b5'].slice(0, PROJECT_STATUS_MAX_BLOCKERS))
    expect(written?.updated_at).toBeTruthy()
    expect(written?.counts.running).toBe(1)

    // A second write replaces the snapshot: one row per project.
    db.setProjectStatusSummary(project.id, 'Second', [])
    const read = db.getProjectStatus(project.id)
    expect(read.summary).toBe('Second')
    expect(read.top_blockers).toEqual([])
    expect(db.setProjectStatusSummary('missing', 'x')).toBeUndefined()
  })
})

describe('buildProjectStatus', () => {
  it('folds the admission queue and waiting sessions in from the agent manager', () => {
    const { db, project, task } = seed()
    const queued = task('queued', TaskStatus.NotStarted)
    const waiting = task('waiting', TaskStatus.AgentWorking)
    const agents = {
      getStartQueue: () => [{ taskId: queued.id, agentId: 'a', reason: 'agent_limit' as const, queuedAt: '', position: 1 }],
      findSessionByTaskId: (taskId: string) => (taskId === waiting.id ? { sessionId: 's1', session: {} } : undefined),
      getSessionStatus: (sessionId: string) => (sessionId === 's1' ? { status: 'waiting_approval', agentId: 'a', taskId: waiting.id } : null)
    }
    const status = buildProjectStatus(db, agents as never, project.id)
    expect(status.counts).toMatchObject({ running: 1, queued: 1, awaiting_approval: 1, blocked: 0 })
    expect(buildProjectStatus(db, null, project.id).counts).toMatchObject({ queued: 0, awaiting_approval: 0 })
  })
})

describe('update_project_status tool (#58)', () => {
  it('is offered to the orchestration scope and writes the snapshot through the route', async () => {
    const { db, project } = seed()
    expect(listToolsForScope(FULL_ACCESS_SCOPE).some((tool) => tool.name === 'update_project_status')).toBe(true)

    const result = await handleTaskRoute(db, '/update_project_status', { project_id: project.id, summary: 'All quiet.', top_blockers: ['Waiting on design', 42] }) as { success: boolean; status: { summary: string; top_blockers: string[] } }
    expect(result.success).toBe(true)
    expect(result.status.summary).toBe('All quiet.')
    expect(result.status.top_blockers).toEqual(['Waiting on design'])
    expect(db.getProjectStatus(project.id).summary).toBe('All quiet.')

    expect(await handleTaskRoute(db, '/update_project_status', { project_id: project.id })).toEqual({ error: 'summary is required' })
    expect(await handleTaskRoute(db, '/update_project_status', { summary: 'x' })).toEqual({ error: 'project_id is required' })
    expect(await handleTaskRoute(db, '/update_project_status', { project_id: 'missing', summary: 'x' })).toEqual({ error: 'Project not found' })
  })

  it('forces the scope\'s project and refuses task agents in the same project', async () => {
    const invoke = vi.fn(async () => ({ success: true }))
    const captain = { parentTaskId: null, taskId: null, artifactTaskId: null, projectId: 'p1' }
    const ok = await callToolForScope('update_project_status', { summary: 'S', project_id: 'other' }, captain, invoke)
    expect(ok.isError).toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('/update_project_status', { summary: 'S', project_id: 'p1' }, captain)

    invoke.mockClear()
    const taskAgent = { parentTaskId: null, taskId: null, artifactTaskId: 't1', projectId: 'p1' }
    const denied = await callToolForScope('update_project_status', { summary: 'S' }, taskAgent, invoke)
    expect(denied.isError).toBe(true)
    expect(denied.content[0].text).toContain('only the project\'s Captain')
    expect(invoke).not.toHaveBeenCalled()

    // Subtask scope does not list the tool at all.
    const subtask = { parentTaskId: 'parent', taskId: 'child', artifactTaskId: 'child', projectId: null }
    const unknown = await callToolForScope('update_project_status', { summary: 'S' }, subtask, invoke)
    expect(unknown.isError).toBe(true)
    expect(unknown.content[0].text).toContain('Unknown tool')
  })
})
