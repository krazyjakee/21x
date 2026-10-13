import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import type { TaskMcpScope } from '../mcp-servers/task-management-core'
import type { TaskGroupService } from '../task-groups/service'
import type { CreateTaskGroupData, TaskGroupProgressState } from '../../shared/task-groups'
import { setTaskApiTaskGroupService } from './state'
import { handleTaskGroupRoute } from './task-group-routes'
import { TaskStatus } from '../../shared/constants'
import { startTaskApiServer, closeTaskApiServer, getTaskApiToken } from '../task-api-server-core'
import { buildTaskMcpUrl } from '../task-mcp-endpoint'
import { forwardTaskGroupTool, signedTaskMcpForwarding } from '../mcp-servers/task-group-stdio'
import { setCoordinatorCallHandler } from '../mcp-servers/task-management-core'

let db: ReturnType<typeof createPortableTestDb>
let project: string
let foreignProject: string
let agentId: string
let service: ReturnType<typeof makeService>
function makeService() {
  return {
    list: vi.fn((id: string, include?: boolean) => db.listTaskGroups(id, include)),
    get: vi.fn((id: string) => ({ group: db.getTaskGroup(id)!, task: db.getTask(db.getTaskGroup(id)!.execution_task_id)!, members: db.getTaskGroupMembers(id) })),
    create: vi.fn(async (data: CreateTaskGroupData) => db.createTaskGroup(data)),
    add: vi.fn(async (id: string, ids: string[]) => db.addTasksToGroup(id, ids)),
    remove: vi.fn(async (id: string, taskId: string) => db.removeTaskFromGroup(id, taskId)),
    dissolve: vi.fn(async (id: string) => db.dissolveTaskGroup(id)),
    report: vi.fn(async (id: string, taskId: string, state: TaskGroupProgressState, message: string, _owner: string) => db.setTaskGroupProgress(id, taskId, state, message))
  }
}
beforeEach(() => {
  db = createPortableTestDb()
  project = db.createProject({ name: 'Scoped project' })!.id
  foreignProject = db.createProject({ name: 'Foreign project' })!.id
  agentId = db.createAgent({ name: 'Group agent', config: { coding_agent: 'opencode' } })!.id
  service = makeService(); setTaskApiTaskGroupService(service as unknown as TaskGroupService)
})
afterEach(async () => { await closeTaskApiServer(); setTaskApiTaskGroupService(null); setCoordinatorCallHandler(null); db.close() })
const captain = (): TaskMcpScope => ({ parentTaskId: null, taskId: null, artifactTaskId: null, projectId: project })
function tasks(projectId = project) { return [1, 2].map(index => db.createTask({ title: `Small change ${index}`, project_id: projectId })!.id) }
function group(projectId = project) { return db.createTaskGroup({ title: 'Related changes', task_ids: tasks(projectId), agent_id: agentId }) }
async function route(name: string, params: Record<string, unknown>, scope?: TaskMcpScope) {
  return await handleTaskGroupRoute(db, `/${name}`, params, scope) as Record<string, unknown>
}
describe('signed task-group routes', () => {
  it('rejects unsigned and body-spoofed authority before any service effect', async () => {
    const ids = tasks()
    const result = await route('create_task_group', { title: 'Spoofed', task_ids: ids, project_id: project, scope: captain(), trustedScope: captain(), role: 'captain' })
    expect(result.error).toContain('signed MCP scope')
    expect(service.create).not.toHaveBeenCalled()
    expect(await route('list_task_groups', { project_id: project })).toHaveProperty('error')
    expect(service.list).not.toHaveBeenCalled()
  })
  it('lets the Captain create/add/remove/dissolve through the shared service with retained history', async () => {
    const ids = tasks()
    const created = await route('create_task_group', { title: ' Related fixes ', task_ids: ids, agent_id: agentId }, captain())
    expect(created.task_ids).toEqual(ids)
    const id = created.id as string
    const extra = db.createTask({ title: 'One more related fix', project_id: project })!.id
    expect((await route('add_to_task_group', { group_id: id, task_ids: [extra] }, captain())).task_ids).toEqual([...ids, extra])
    await route('remove_from_task_group', { group_id: id, task_id: extra }, captain())
    expect(db.getTask(extra)?.group_id).toBeNull()
    expect(db.getTaskGroupHistory(extra).map(item => item.id)).toContain(id)
    expect(await route('dissolve_task_group', { group_id: id }, captain())).toMatchObject({ state: 'dissolved' })
    expect(db.getTaskGroupHistory(ids[0])).toHaveLength(1)
    expect(service.create).toHaveBeenCalledOnce(); expect(service.add).toHaveBeenCalledOnce(); expect(service.remove).toHaveBeenCalledOnce(); expect(service.dissolve).toHaveBeenCalledOnce()
  })
  it('pins read scope and uniformly refuses foreign/missing groups and foreign member arrays', async () => {
    const own = group(), foreign = group(foreignProject)
    expect(await route('list_task_groups', { project_id: foreignProject }, captain())).toEqual([db.getTaskGroup(own.id)])
    expect(service.list).toHaveBeenCalledWith(project, false)
    expect(await route('get_task_group', { group_id: own.id }, captain())).toMatchObject({ group: { id: own.id } })
    const denied = await route('get_task_group', { group_id: foreign.id }, captain())
    expect(await route('get_task_group', { group_id: 'missing' }, captain())).toEqual(denied)
    expect(service.get).not.toHaveBeenCalledWith(foreign.id)
    const extra = db.createTask({ title: 'Foreign addition', project_id: foreignProject })!.id
    expect(await route('add_to_task_group', { group_id: own.id, task_ids: [extra] }, captain())).toHaveProperty('error')
    expect(service.add).not.toHaveBeenCalled()
    expect(await route('create_task_group', { title: 'Mixed', task_ids: [tasks()[0], extra], agent_id: agentId }, captain())).toHaveProperty('error')
    expect(service.create).not.toHaveBeenCalled()
  })
  it('denies ordinary/task member callers mutation and report authority', async () => {
    const current = group()
    const memberScope: TaskMcpScope = { ...captain(), taskId: current.task_ids[0], artifactTaskId: current.task_ids[0], agentId, sessionNonce: db.rotateTaskMcpScopeNonce(current.task_ids[0]) }
    expect(await route('dissolve_task_group', { group_id: current.id }, memberScope)).toHaveProperty('error')
    expect(await route('report_group_task', { group_id: current.id, task_id: current.task_ids[1], state: 'done', message: 'Spoofed', owner_task_id: current.execution_task_id, task_ids: current.task_ids }, memberScope)).toHaveProperty('error')
    expect(service.report).not.toHaveBeenCalled(); expect(service.dissolve).not.toHaveBeenCalled()
  })
  it('derives current execution ownership from signed task, agent, nonce and DB binding; progress never completes a source', async () => {
    const current = group()
    db.updateTask(current.execution_task_id, { status: TaskStatus.AgentWorking, session_id: 'native-owned' })
    const nonce = db.rotateTaskMcpScopeNonce(current.execution_task_id)
    const ownerScope: TaskMcpScope = { ...captain(), taskId: current.execution_task_id, artifactTaskId: current.execution_task_id, agentId, sessionNonce: nonce }
    const params = { group_id: current.id, task_id: current.task_ids[0], state: 'done', message: ' Implementation complete ', owner_task_id: 'spoofed', task_ids: ['foreign'], status: 'completed', complete_at_source: true }
    expect(await route('report_group_task', params, ownerScope)).toMatchObject({ progress: expect.arrayContaining([{ task_id: current.task_ids[0], state: 'done', message: 'Implementation complete', updated_at: expect.any(String) }]) })
    expect(service.report).toHaveBeenCalledWith(current.id, current.task_ids[0], 'done', 'Implementation complete', current.execution_task_id)
    expect(db.getTask(current.task_ids[0])?.status).toBe(TaskStatus.AgentWorking)
    expect(db.getTask(current.execution_task_id)?.status).toBe(TaskStatus.AgentWorking)
    for (const forged of [{ ...ownerScope, agentId: 'other-agent' }, { ...ownerScope, sessionNonce: 'stale' }, { ...ownerScope, artifactTaskId: current.task_ids[0] }]) {
      expect(await route('report_group_task', params, forged)).toHaveProperty('error')
    }
    db.rotateTaskMcpScopeNonce(current.execution_task_id)
    expect(await route('report_group_task', params, ownerScope)).toHaveProperty('error')
    expect(service.report).toHaveBeenCalledOnce()
  })
  it('rejects stopped, unbound and former-member reports even with a valid signed nonce', async () => {
    const current = group()
    const nonce = db.rotateTaskMcpScopeNonce(current.execution_task_id)
    const ownerScope: TaskMcpScope = { ...captain(), taskId: current.execution_task_id, artifactTaskId: current.execution_task_id, agentId, sessionNonce: nonce }
    const params = { group_id: current.id, task_id: current.task_ids[0], state: 'blocked', message: 'Waiting for input' }
    expect(await route('report_group_task', params, ownerScope)).toHaveProperty('error')
    db.updateTask(current.execution_task_id, { status: TaskStatus.AgentWorking, session_id: null })
    expect(await route('report_group_task', params, ownerScope)).toHaveProperty('error')
    db.updateTask(current.execution_task_id, { status: TaskStatus.NotStarted, session_id: null })
    db.removeTaskFromGroup(current.id, current.task_ids[0])
    db.updateTask(current.execution_task_id, { status: TaskStatus.AgentWorking, session_id: 'owned' })
    expect(await route('report_group_task', params, ownerScope)).toHaveProperty('error')
    expect(service.report).not.toHaveBeenCalled()
  })

  it('uses the same app-signed authority over the stdio forwarding path and rejects URL/body forgery', async () => {
    const port = await startTaskApiServer(db)
    const api = `http://127.0.0.1:${port}`
    const issued = buildTaskMcpUrl(port, getTaskApiToken(), { projectId: project })
    const ids = tasks()
    const forwarded = await forwardTaskGroupTool(signedTaskMcpForwarding(issued, api), 'create_task_group', { title: 'Signed batch', task_ids: ids, agent_id: agentId })
    expect(forwarded.isError).not.toBe(true)
    const created = JSON.parse(forwarded.content[0].text) as { id: string }
    expect(db.getTaskGroup(created.id)?.task_ids).toEqual(ids)
    const ordinary = db.createTask({ title: 'Ordinary caller', project_id: project })!
    const taskUrl = buildTaskMcpUrl(port, getTaskApiToken(), { projectId: project, taskId: ordinary.id, agentId, sessionNonce: db.rotateTaskMcpScopeNonce(ordinary.id) })
    const denied = await forwardTaskGroupTool(signedTaskMcpForwarding(taskUrl, api), 'dissolve_task_group', { group_id: created.id, trustedScope: captain(), role: 'captain' })
    expect(denied.isError).toBe(true)
    expect(db.getTaskGroup(created.id)?.state).toBe('active')
    const forged = new URL(taskUrl)
    forged.searchParams.delete('task'); forged.searchParams.delete('agent'); forged.searchParams.delete('session')
    expect((await forwardTaskGroupTool(signedTaskMcpForwarding(forged.toString(), api), 'dissolve_task_group', { group_id: created.id })).isError).toBe(true)
    expect(service.dissolve).not.toHaveBeenCalled()
    const plain = await fetch(`${api}/dissolve_task_group`, { method: 'POST', headers: { Authorization: `Bearer ${getTaskApiToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ group_id: created.id, trustedScope: captain() }) })
    expect(await plain.json()).toHaveProperty('error')
    expect(service.dissolve).not.toHaveBeenCalled()
  })
})
