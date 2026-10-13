import { afterEach, describe, expect, it, vi } from 'vitest'
import { callToolForScope, FULL_ACCESS_SCOPE, listToolsForScope, setCoordinatorCallHandler, type TaskMcpScope } from './task-management-core'
import { TASK_GROUP_MUTATION_TOOL_NAMES } from './task-management-tools'

const captain: TaskMcpScope = { parentTaskId: null, taskId: null, artifactTaskId: null, projectId: 'project' }
const task: TaskMcpScope = { ...captain, taskId: 'anchor', artifactTaskId: 'anchor', agentId: 'agent', sessionNonce: 'nonce' }
afterEach(() => setCoordinatorCallHandler(null))
describe('task group MCP authority', () => {
  it('advertises and accepts group definition mutations only for a project Captain', async () => {
    for (const scope of [task, { ...task, parentTaskId: 'parent' }, FULL_ACCESS_SCOPE]) {
      const names = listToolsForScope(scope).map(tool => tool.name)
      for (const name of TASK_GROUP_MUTATION_TOOL_NAMES) {
        expect(names).not.toContain(name)
        const invoke = vi.fn(async () => ({ ok: true }))
        expect((await callToolForScope(name, {}, scope, invoke)).isError).toBe(true)
        expect(invoke).not.toHaveBeenCalled()
      }
    }
    for (const name of TASK_GROUP_MUTATION_TOOL_NAMES) expect(listToolsForScope(captain).map(tool => tool.name)).toContain(name)
    expect(listToolsForScope(captain).map(tool => tool.name)).not.toContain('report_group_task')
    expect(listToolsForScope(task).map(tool => tool.name)).toContain('report_group_task')
  })
  it('refuses foreign members within a create/add array before any mutation or Captain hook', async () => {
    const hook = vi.fn(async ({ run }: { run(): Promise<unknown> }) => run())
    setCoordinatorCallHandler(hook)
    const invoke = vi.fn(async (route: string, params: Record<string, unknown>) => route === '/get_task'
      ? { id: params.task_id, project_id: params.task_id === 'foreign' ? 'other' : 'project' } : { ok: true })
    for (const name of ['create_task_group', 'add_to_task_group']) {
      const result = await callToolForScope(name, { title: 'Batch', group_id: 'group', task_ids: ['own', 'foreign'] }, captain, invoke)
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('not in this project')
      expect(invoke.mock.calls.some(([route]) => route === `/${name}`)).toBe(false)
    }
    expect(hook).not.toHaveBeenCalled()
  })
  it('pins list project and passes actual report owner provenance out of band', async () => {
    const invoke = vi.fn(async (route: string, params: Record<string, unknown>, scope?: TaskMcpScope) => route === '/get_task'
      ? { id: params.task_id, project_id: 'project' } : { route, params, scope })
    await callToolForScope('list_task_groups', { project_id: 'foreign' }, captain, invoke)
    expect(invoke.mock.calls.find(([route]) => route === '/list_task_groups')?.slice(1)).toEqual([{ project_id: 'project' }, captain])
    await callToolForScope('report_group_task', { group_id: 'group', task_id: 'member', state: 'done', message: 'Implemented', owner_task_id: 'spoofed' }, task, invoke)
    expect(invoke.mock.calls.find(([route]) => route === '/report_group_task')?.[2]).toBe(task)
    expect(task.taskId).toBe('anchor')
  })
})
