/**
 * The skill scope the MCP dispatcher attaches to skill calls (#74). The
 * routes themselves are covered in task-api/skill-routes.test.ts; here the
 * question is only "which scope does a route see, for which session".
 */
import { describe, it, expect, vi } from 'vitest'
import { callToolForScope, FULL_ACCESS_SCOPE, type TaskMcpScope } from './task-management-core'
import { SKILL_SCOPE_PARAM } from '../task-api/skill-routes'

const CAPTAIN: TaskMcpScope = { parentTaskId: null, taskId: null, artifactTaskId: null, projectId: 'proj-a' }
const TASK_AGENT: TaskMcpScope = { parentTaskId: null, taskId: 'task-1', artifactTaskId: 'task-1', projectId: 'proj-a' }
const SUBTASK: TaskMcpScope = { parentTaskId: 'task-1', taskId: 'sub-1', artifactTaskId: 'sub-1' }

function fakeInvoke() {
  return vi.fn(async (route: string, params: Record<string, unknown>) => {
    if (route === '/get_task') {
      return params.task_id === 'sub-1' ? { id: 'sub-1', project_id: 'proj-b', parent_task_id: 'task-1' } : { error: 'Task not found' }
    }
    return { ok: true, route, params }
  })
}

function scopeSeenBy(invoke: ReturnType<typeof fakeInvoke>, route: string): unknown {
  const call = invoke.mock.calls.find(([r]) => r === route)
  return call?.[1][SKILL_SCOPE_PARAM]
}

describe('skill scope attached by the dispatcher', () => {
  it('marks the Captain as the coordinator of its project', async () => {
    const invoke = fakeInvoke()
    await callToolForScope('list_skills', {}, CAPTAIN, invoke)
    expect(scopeSeenBy(invoke, '/list_skills')).toEqual({ project_id: 'proj-a', role: 'coordinator' })
  })

  it('marks a task agent as a task of its project', async () => {
    const invoke = fakeInvoke()
    await callToolForScope('get_skill', { skill_id: 's' }, TASK_AGENT, invoke)
    expect(scopeSeenBy(invoke, '/get_skill')).toEqual({ project_id: 'proj-a', role: 'task' })
  })

  it('reads a subtask\'s project off its own row', async () => {
    const invoke = fakeInvoke()
    await callToolForScope('create_skill', { name: 'x', description: 'd', content: 'c' }, SUBTASK, invoke)
    expect(scopeSeenBy(invoke, '/create_skill')).toEqual({ project_id: 'proj-b', role: 'task' })
  })

  it('overwrites a scope the caller forged, and attaches none for full access', async () => {
    const invoke = fakeInvoke()
    const forged = { [SKILL_SCOPE_PARAM]: { project_id: 'proj-b', role: 'coordinator' } }
    await callToolForScope('update_skill', { skill_id: 's', content: 'c', ...forged }, TASK_AGENT, invoke)
    expect(scopeSeenBy(invoke, '/update_skill')).toEqual({ project_id: 'proj-a', role: 'task' })

    const full = fakeInvoke()
    await callToolForScope('delete_skill', { skill_id: 's', ...forged }, FULL_ACCESS_SCOPE, full)
    expect(scopeSeenBy(full, '/delete_skill')).toBeUndefined()
  })

  it('leaves non-skill tools alone', async () => {
    const invoke = fakeInvoke()
    await callToolForScope('list_agents', {}, CAPTAIN, invoke)
    expect(scopeSeenBy(invoke, '/list_agents')).toBeUndefined()
  })
})
