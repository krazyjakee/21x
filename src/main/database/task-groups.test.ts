import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import { TaskStatus } from '../../shared/constants'
import { isCoordinatorTask } from '../../shared/task-roles'

const databases: ReturnType<typeof createPortableTestDb>[] = []
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.restoreAllMocks() })
function fixture(count = 3) {
  const db = createPortableTestDb(); databases.push(db)
  const agent = db.createAgent({ name: 'Task agent', is_default: true })!
  const project = db.createProject({ name: 'One checkout', default_agent_id: agent.id })!
  const tasks = Array.from({ length: count }, (_, index) => db.createTask({ title: `Small task ${index}`, description: `Work ${index}`, project_id: project.id, repos: ['owner/repo'] })!)
  const create = () => db.createTaskGroup({ title: 'Small fixes', task_ids: tasks.map(task => task.id) })
  return { db, agent, project, tasks, create }
}

describe('task group database ownership', () => {
  it('creates one hidden counted anchor with matching repos, union skills, member context and a stable execution binding', () => {
    const h = fixture(2)
    h.db.updateTask(h.tasks[0].id, { skill_ids: ['first', 'shared'] })
    h.db.updateTask(h.tasks[1].id, { skill_ids: ['second', 'shared'] })
    const group = h.create(), anchor = h.db.getTask(group.execution_task_id)!
    expect(anchor).toMatchObject({ role: 'task_group', group_id: group.id, agent_id: h.agent.id, repos: ['owner/repo'], skill_ids: ['first', 'shared', 'second'] })
    expect(isCoordinatorTask(anchor)).toBe(false)
    expect(() => h.db.updateTask(anchor.id, { status: TaskStatus.Triaging })).toThrow('cannot enter auto-triage')
    expect(anchor.description).toContain(h.tasks[0].id)
    expect(anchor.description).toContain('Work 1')
    expect(h.db.getTasks({ projectId: h.project.id }).map(task => task.id)).toEqual(expect.arrayContaining(h.tasks.map(task => task.id)))
    expect(h.db.getTasks({ projectId: h.project.id }).some(task => task.id === anchor.id)).toBe(false)
    h.db.updateTask(anchor.id, { session_id: 'native-shared', status: TaskStatus.AgentWorking })
    expect(h.db.getTaskGroupExecution(h.tasks[1].id)?.id).toBe(anchor.id)
    expect(h.db.getTaskGroupExecution(anchor.id)?.id).toBe(anchor.id)
    expect(h.db.getTaskGroupMembers(group.id).every(task => task.status === TaskStatus.AgentWorking && task.session_id === null)).toBe(true)
  })

  it('records per-member done or blocked progress without granting review, source completion or lifecycle authority', () => {
    const h = fixture(2), group = h.create()
    h.db.setTaskGroupProgress(group.id, h.tasks[0].id, 'done', 'File written and checked')
    h.db.setTaskGroupProgress(group.id, h.tasks[1].id, 'blocked', 'Needs a user decision')
    expect(h.db.getTaskGroup(group.id)?.progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ task_id: h.tasks[0].id, state: 'done' }), expect.objectContaining({ task_id: h.tasks[1].id, state: 'blocked' })]))
    expect(h.db.getTaskGroupMembers(group.id).every(task => task.status === TaskStatus.NotStarted)).toBe(true)
    expect(() => h.db.updateTask(group.execution_task_id, { status: TaskStatus.Completed })).toThrow('Review every unfinished member')
    expect(() => h.db.setTaskGroupProgress(group.id, 'foreign', 'done', 'Wrong member')).toThrow('current task group member')
  })

  it('updates the execution assignment atomically without rewriting completed member history', () => {
    const h = fixture(2), group = h.create()
    h.db.updateTask(h.tasks[0].id, { status: TaskStatus.Completed, complete_at_source: false }, 'task-group')
    const other = h.db.createAgent({ name: 'Fallback agent' })!
    h.db.updateTask(group.execution_task_id, { agent_id: other.id })
    expect(h.db.getTaskGroup(group.id)?.agent_id).toBe(other.id)
    expect(h.db.getTask(h.tasks[0].id)?.agent_id).toBeNull()
    expect(h.db.getTask(h.tasks[1].id)?.agent_id).toBe(other.id)
    expect(() => h.db.updateTask(group.execution_task_id, { agent_id: null })).toThrow('available agent')
  })

  it('mirrors lifecycle atomically while preserving completed members and selective send-back review', () => {
    const h = fixture(), group = h.create(), anchor = group.execution_task_id
    h.db.updateTask(anchor, { status: TaskStatus.AgentWorking })
    h.db.updateTask(anchor, { status: TaskStatus.ReadyForReview })
    h.db.updateTask(h.tasks[0].id, { status: TaskStatus.Completed, complete_at_source: false }, 'task-group')
    h.db.updateTask(h.tasks[1].id, { status: TaskStatus.NotStarted }, 'task-group')
    h.db.updateTask(anchor, { status: TaskStatus.NotStarted }, 'task-group')
    expect(h.db.getTask(h.tasks[2].id)?.status).toBe(TaskStatus.ReadyForReview)
    h.db.updateTask(anchor, { status: TaskStatus.AgentWorking })
    h.db.updateTask(anchor, { status: TaskStatus.AgentWorking })
    expect(h.db.getTaskGroupMembers(group.id).map(task => task.status))
      .toEqual([TaskStatus.Completed, TaskStatus.AgentWorking, TaskStatus.ReadyForReview])
    h.db.updateTask(anchor, { status: TaskStatus.ReadyForReview })
    for (const task of h.tasks.slice(1)) h.db.updateTask(task.id, { status: TaskStatus.Completed, complete_at_source: false }, 'task-group')
    h.db.updateTask(anchor, { status: TaskStatus.Completed })
    expect(h.db.getTaskGroup(group.id)?.status).toBe(TaskStatus.Completed)
    h.db.updateTask(anchor, { status: TaskStatus.NotStarted }, 'system')
    expect(h.db.getTaskGroupMembers(group.id).every(task => task.status === TaskStatus.Completed)).toBe(true)
  })

  it('rolls back the anchor write when any mirrored member update fails', () => {
    const h = fixture(2), group = h.create()
    h.db.db.exec(`CREATE TRIGGER refuse_group_mirror BEFORE UPDATE OF status ON tasks WHEN OLD.id='${h.tasks[1].id}' BEGIN SELECT RAISE(ABORT,'mirror failed'); END`)
    expect(() => h.db.updateTask(group.execution_task_id, { status: TaskStatus.AgentWorking, session_id: 'native' })).toThrow('mirror failed')
    expect(h.db.getTask(group.execution_task_id)).toMatchObject({ status: TaskStatus.NotStarted, session_id: null })
    expect(h.db.getTaskGroupMembers(group.id).every(task => task.status === TaskStatus.NotStarted)).toBe(true)
  })

  it('guards direct member edits, deletion, parent creation and project moves while allowing idle prose edits', () => {
    const h = fixture(2), group = h.create(), member = h.tasks[0].id
    for (const data of [{ status: TaskStatus.AgentWorking }, { agent_id: h.agent.id }, { repos: [] }, { session_id: 'foreign' },
      { heartbeat_enabled: true }, { is_recurring: true }, { auto_start_agent: true }, { parent_task_id: h.tasks[1].id }])
      expect(() => h.db.updateTask(member, data)).toThrow('group controls')
    expect(() => h.db.updateTask(member, { session_id: 'foreign' }, 'task-group')).toThrow('only change member review')
    expect(() => h.db.deleteTask(member)).toThrow('Ungroup')
    expect(() => h.db.deleteTask(group.execution_task_id)).toThrow('Ungroup')
    expect(() => h.db.createTask({ title: 'Child', parent_task_id: member })).toThrow('Remove a task from its group')
    const other = h.db.createProject({ name: 'Other project' })!
    expect(() => h.db.moveTaskToProject(member, other.id)).toThrow('Remove a task from its group')
    h.db.updateTask(member, { description: 'Updated details' })
    expect(h.db.getTask(group.execution_task_id)?.description).toContain('Updated details')
    h.db.updateTask(group.execution_task_id, { status: TaskStatus.AgentWorking })
    expect(() => h.db.updateTask(member, { description: 'Late changed work' })).toThrow('Stop the task group')
  })

  it('keeps completed source members closed and requires explicit group review provenance', () => {
    const h = fixture(2)
    const source = h.db.createTaskSource({ name: 'Issues', mcp_server_id: null, plugin_id: 'github', project_id: h.project.id })!
    h.db.updateTask(h.tasks[0].id, { source_id: source.id, external_id: 'issue' }, 'task-source')
    const group = h.create()
    expect(() => h.db.deleteTaskSource(source.id)).toThrow('Ungroup source tasks')
    expect(() => h.db.updateTask(h.tasks[0].id, { status: TaskStatus.Completed }, 'task-source-action')).toThrow('group controls')
    h.db.updateTask(h.tasks[0].id, { status: TaskStatus.Completed, complete_at_source: true }, 'task-group')
    h.db.updateTask(h.tasks[0].id, { status: TaskStatus.NotStarted, title: 'Source refreshed title' }, 'task-source')
    expect(h.db.getTask(h.tasks[0].id)).toMatchObject({ status: TaskStatus.Completed, title: 'Source refreshed title' })
    expect(() => h.db.updateTask(h.tasks[0].id, { status: TaskStatus.NotStarted }, 'task-group')).toThrow('remains completed')
    expect(() => h.db.updateTask(group.execution_task_id, { status: TaskStatus.Completed })).toThrow('unfinished member')
  })

  it('retains transcript and progress history after removing, rejoining and dissolving members', () => {
    const h = fixture(3), group = h.create()
    h.db.upsertTranscriptParts(group.execution_task_id, [{ id: 'answer', role: 'assistant', content: 'Shared work remains saved.' }])
    h.db.setTaskGroupProgress(group.id, h.tasks[0].id, 'blocked', 'Original blocker')
    h.db.removeTaskFromGroup(group.id, h.tasks[0].id)
    expect(h.db.getTaskGroupByTask(h.tasks[0].id)).toBeUndefined()
    expect(h.db.getTaskGroupHistory(h.tasks[0].id)[0]).toMatchObject({ id: group.id, former_task_ids: [h.tasks[0].id] })
    h.db.addTasksToGroup(group.id, [h.tasks[0].id])
    expect(h.db.db.prepare('SELECT COUNT(*) AS count FROM task_group_memberships WHERE task_id=?').get(h.tasks[0].id)).toEqual({ count: 2 })
    h.db.dissolveTaskGroup(group.id)
    expect(h.db.listTaskGroups(h.project.id)).toEqual([])
    expect(h.db.listTaskGroups(h.project.id, true)).toHaveLength(1)
    expect(h.db.getTaskGroupHistory(h.tasks[0].id)[0].state).toBe('dissolved')
    expect(h.db.getTranscriptParts(group.execution_task_id)[0].content).toBe('Shared work remains saved.')
    expect(h.db.getTaskGroupMembers(group.id, true)).toHaveLength(3)
    expect(h.db.getTaskGroupMembers(group.id)).toEqual([])
    expect(h.db.getTask(h.tasks[0].id)?.group_id).toBeNull()
    expect(h.db.deleteAgent(h.agent.id)).toBe(true)
    expect(h.db.getTaskGroup(group.id)?.agent_id).toBe(h.agent.id)
  })

  it('rejects owned definition changes and validates project, repo, assignment and excluded task forms', () => {
    const h = fixture(3), group = h.create()
    expect(() => h.db.deleteAgent(h.agent.id)).toThrow('Switch or dissolve active task groups')
    h.db.updateTask(group.execution_task_id, { status: TaskStatus.AgentWorking })
    expect(() => h.db.removeTaskFromGroup(group.id, h.tasks[0].id)).toThrow('Stop the task group')
    expect(() => h.db.dissolveTaskGroup(group.id)).toThrow('Stop the task group')
    const extra = h.db.createTask({ title: 'New', project_id: h.project.id, repos: ['owner/repo'] })!
    expect(() => h.db.addTasksToGroup(group.id, [extra.id])).toThrow('Stop the task group')
    h.db.updateTask(group.execution_task_id, { status: TaskStatus.NotStarted }, 'system')
    h.db.removeTaskFromGroup(group.id, h.tasks[0].id)
    h.db.updateTask(h.tasks[0].id, { repos: ['different/repo'] })
    expect(() => h.db.addTasksToGroup(group.id, [h.tasks[0].id])).toThrow('same repositories')
    expect(() => h.db.createTaskGroup({ title: 'Invalid', task_ids: [extra.id, extra.id] })).toThrow('distinct tasks')
    h.db.updateTask(extra.id, { heartbeat_enabled: true })
    expect(() => h.db.createTaskGroup({ title: 'Invalid', task_ids: [extra.id, h.tasks[0].id] })).toThrow('Only ordinary')
  })

  it.each([
    { status: TaskStatus.AgentWorking }, { session_id: 'existing-native' }, { is_recurring: true },
    { recurrence_pattern: '0 9 * * *' }, { heartbeat_enabled: true }
  ])('refuses incompatible task definitions before creating any group (%j)', data => {
    const h = fixture(2)
    h.db.updateTask(h.tasks[0].id, data)
    expect(() => h.create()).toThrow('Only ordinary')
    expect(h.db.listTaskGroups(h.project.id, true)).toEqual([])
    expect(h.db.getTasks({ includeCoordinators: true }).filter(task => task.role === 'task_group')).toEqual([])
  })

  it('requires compatible assignments, excludes subtask parents and enforces the initial group size', () => {
    const h = fixture(2)
    h.db.updateTask(h.tasks[0].id, { agent_id: h.agent.id })
    expect(() => h.create()).toThrow('same assignment')
    h.db.updateTask(h.tasks[1].id, { agent_id: h.agent.id })
    const other = h.db.createAgent({ name: 'Other' })!
    expect(() => h.db.createTaskGroup({ title: 'Bad assignment', task_ids: h.tasks.map(task => task.id), agent_id: other.id })).toThrow('match the member assignment')
    h.db.createTask({ title: 'Child', parent_task_id: h.tasks[0].id })
    expect(() => h.create()).toThrow('Only ordinary')
    expect(() => h.db.createTaskGroup({ title: 'Too small', task_ids: [h.tasks[1].id] })).toThrow('distinct tasks')
    const large = fixture(11)
    expect(() => large.create()).toThrow('distinct tasks')
  })

  it('rolls back an interrupted group definition without leaving an anchor or half-grouped member', () => {
    const h = fixture(2)
    h.db.db.exec(`CREATE TRIGGER refuse_second_member BEFORE INSERT ON task_group_memberships WHEN NEW.task_id='${h.tasks[1].id}' BEGIN SELECT RAISE(ABORT,'definition failed'); END`)
    expect(() => h.create()).toThrow('definition failed')
    expect(h.db.listTaskGroups(h.project.id, true)).toEqual([])
    expect(h.db.getTask(h.tasks[0].id)?.group_id).toBeNull()
    expect(h.db.getTasks({ includeCoordinators: true }).filter(task => task.role === 'task_group')).toEqual([])
  })
})
