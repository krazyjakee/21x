/**
 * The project scope of the task-management MCP tools (#56): every tool that
 * names a task refuses one outside the project, and every list and search tool
 * is narrowed to it.
 */
import { describe, it, expect, vi } from 'vitest'
import { callToolForScope, listToolsForScope, FULL_ACCESS_SCOPE, type TaskMcpScope } from './task-management-core'

const PROJECT: TaskMcpScope = { parentTaskId: null, taskId: null, artifactTaskId: null, projectId: 'proj-a' }

const TASKS: Record<string, { id: string; project_id: string }> = {
  'in-a': { id: 'in-a', project_id: 'proj-a' },
  'in-b': { id: 'in-b', project_id: 'proj-b' }
}

function fakeInvoke() {
  return vi.fn(async (route: string, params: Record<string, unknown>) => {
    if (route === '/get_task') return TASKS[params.task_id as string] ?? { error: 'Task not found' }
    return { ok: true, route, params }
  })
}

/** Arguments that satisfy a tool's required fields, pointing every task id at `taskId`. */
function argsFor(tool: { inputSchema: { properties?: Record<string, unknown>; required?: string[] } }, taskId: string): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  const properties = tool.inputSchema.properties ?? {}
  for (const key of Object.keys(properties)) {
    if (key === 'task_id' || key === 'parent_task_id') args[key] = taskId
  }
  for (const key of tool.inputSchema.required ?? []) {
    if (args[key] === undefined) args[key] = key === 'approved' ? true : key === 'x' || key === 'y' ? 0 : 'value'
  }
  return args
}

const errorText = (result: { content: Array<{ text: string }> }): string => result.content[0]?.text ?? ''

describe('project-scoped task-management tools', () => {
  it('serves the orchestration tool set, like full access', () => {
    expect(listToolsForScope(PROJECT).map((t) => t.name)).toEqual(listToolsForScope(FULL_ACCESS_SCOPE).map((t) => t.name))
  })

  const byIdTools = listToolsForScope(PROJECT).filter((tool) => {
    const properties = tool.inputSchema.properties ?? {}
    return 'task_id' in properties || 'parent_task_id' in properties
  })

  it('covers the by-id tools the issue names', () => {
    const names = byIdTools.map((t) => t.name)
    for (const name of ['get_task', 'update_task', 'start_task', 'send_message', 'stop_task', 'respond_to_checkpoint', 'get_messages', 'open_task', 'get_session_status', 'create_subtask', 'list_subtasks', 'wait_for_subtasks']) {
      expect(names).toContain(name)
    }
  })

  for (const tool of byIdTools) {
    it(`${tool.name} refuses a task in another project and never reaches its route`, async () => {
      const invoke = fakeInvoke()
      const result = await callToolForScope(tool.name, argsFor(tool, 'in-b'), PROJECT, invoke)
      expect(result.isError).toBe(true)
      expect(errorText(result)).toContain('not in this project')
      expect(invoke.mock.calls.map(([route]) => route)).not.toContain(`/${tool.name}`)
    })

    it(`${tool.name} refuses a task id that does not exist`, async () => {
      const invoke = fakeInvoke()
      const result = await callToolForScope(tool.name, argsFor(tool, 'missing'), PROJECT, invoke)
      expect(errorText(result)).toContain('not in this project')
    })

    if (tool.name !== 'get_task') {
      it(`${tool.name} passes a task in the project through`, async () => {
        const invoke = fakeInvoke()
        await callToolForScope(tool.name, argsFor(tool, 'in-a'), PROJECT, invoke)
        expect(invoke.mock.calls.map(([route]) => route)).toContain(`/${tool.name}`)
      })
    }
  }

  it('refuses successor and subtask ids from another project', async () => {
    const invoke = fakeInvoke()
    const update = await callToolForScope('update_task', { task_id: 'in-a', next_subtask_ids: ['in-b'] }, PROJECT, invoke)
    expect(update.isError).toBe(true)
    const wait = await callToolForScope('wait_for_subtasks', { parent_task_id: 'in-a', subtask_ids: ['in-b'] }, PROJECT, invoke)
    expect(wait.isError).toBe(true)
  })

  for (const name of ['list_tasks', 'find_similar_tasks', 'get_task_statistics', 'get_recent_activity', 'list_pending_approvals', 'list_repos', 'create_task']) {
    it(`${name} is narrowed to the project, whatever project the caller asks for`, async () => {
      const invoke = fakeInvoke()
      await callToolForScope(name, { title: 't', metric: 'label_usage', project_id: 'proj-b' }, PROJECT, invoke)
      const call = invoke.mock.calls.find(([route]) => route === `/${name}`)
      expect(call?.[1].project_id).toBe('proj-a')
    })
  }

  it('leaves full access unfiltered (internal and debug use only)', async () => {
    const invoke = fakeInvoke()
    await callToolForScope('get_task', { task_id: 'in-b' }, FULL_ACCESS_SCOPE, invoke)
    await callToolForScope('list_tasks', {}, FULL_ACCESS_SCOPE, invoke)
    expect(invoke.mock.calls.find(([route]) => route === '/list_tasks')?.[1].project_id).toBeUndefined()
  })

  it('keeps a subtask session on the subtask scope even when a project is set', () => {
    const subtask: TaskMcpScope = { parentTaskId: 'p', taskId: 'c', artifactTaskId: 'c', projectId: 'proj-a' }
    const names = listToolsForScope(subtask).map((t) => t.name)
    expect(names).toContain('get_own_task')
    expect(names).not.toContain('list_tasks')
  })
})
