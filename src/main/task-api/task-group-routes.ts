import type { DatabaseManager } from '../database'
import type { TaskMcpScope } from '../mcp-servers/task-management-core'
import { isCoordinatorScope } from '../mcp-servers/task-management-core'
import { TASK_GROUP_MUTATION_TOOL_NAMES, TASK_GROUP_TOOL_NAMES } from '../mcp-servers/task-management-tools'
import { taskGroupService } from './state'
import type { TaskGroupProgressState } from '../../shared/task-groups'
import { TaskStatus } from '../../shared/constants'

const denied = { error: 'Access denied: task group is not in this signed project scope' }
function ids(value: unknown): string[] | null {
  return Array.isArray(value) && value.length > 0 && value.length <= 10 && value.every(id => typeof id === 'string' && id.length > 0)
    && new Set(value).size === value.length ? value : null
}

/** Scope is accepted only out of band from the app-issued signed MCP URL.
 * The plain JSON API token and model-controlled params grant no group rights. */
export async function handleTaskGroupRoute(db: DatabaseManager, route: string, params: Record<string, unknown>, trustedScope?: TaskMcpScope): Promise<unknown> {
  const name = route.slice(1)
  if (!TASK_GROUP_TOOL_NAMES.has(name)) return undefined
  if (!trustedScope) return { error: 'An app-issued signed MCP scope is required for task groups' }
  const ownerId = trustedScope.taskId || trustedScope.artifactTaskId
  const owner = ownerId ? db.getTask(ownerId) : undefined
  const projectId = trustedScope.projectId || owner?.project_id
  if (!projectId || !db.getProject(projectId) || (ownerId && (!owner || owner.project_id !== projectId))) return denied
  const captain = isCoordinatorScope(trustedScope) && Boolean(db.getCoordinatorTask(projectId))
  if (TASK_GROUP_MUTATION_TOOL_NAMES.has(name) && !captain) return { error: 'Only the project Captain may change task groups' }
  if (!taskGroupService) return { error: 'Task groups are unavailable' }
  try {
    if (name === 'list_task_groups') return taskGroupService.list(projectId, params.include_dissolved === true)
    if (name === 'create_task_group') {
      const taskIds = ids(params.task_ids)
      if (!taskIds || taskIds.length < 2 || typeof params.title !== 'string' || !params.title.trim()) return { error: 'A title and 2–10 distinct task IDs are required' }
      if (taskIds.some(id => db.getTask(id)?.project_id !== projectId)) return denied
      return await taskGroupService.create({ title: params.title.trim(), task_ids: taskIds,
        ...(typeof params.agent_id === 'string' ? { agent_id: params.agent_id } : {}) })
    }
    const groupId = typeof params.group_id === 'string' ? params.group_id : ''
    const group = groupId ? db.getTaskGroup(groupId) : undefined
    if (!group || group.project_id !== projectId) return denied
    const snapshot = taskGroupService.get(groupId)
    if (name === 'get_task_group') return snapshot
    if (name === 'add_to_task_group') {
      const taskIds = ids(params.task_ids)
      if (!taskIds) return { error: 'Distinct task IDs are required' }
      if (taskIds.some(id => db.getTask(id)?.project_id !== projectId)) return denied
      return await taskGroupService.add(groupId, taskIds)
    }
    if (name === 'dissolve_task_group') return await taskGroupService.dissolve(groupId)
    const taskId = typeof params.task_id === 'string' ? params.task_id : ''
    const member = taskId ? db.getTask(taskId) : undefined
    if (!member || member.project_id !== projectId || member.group_id !== groupId || !snapshot.group.task_ids.includes(taskId)) return denied
    if (name === 'remove_from_task_group') return await taskGroupService.remove(groupId, taskId)
    if (name === 'report_group_task') {
      const scope = trustedScope
      if (!scope.taskId || scope.artifactTaskId !== scope.taskId || !scope.agentId || !scope.sessionNonce || !owner
        || owner.role !== 'task_group' || snapshot.group.state !== 'active' || snapshot.group.execution_task_id !== owner.id
        || owner.agent_id !== scope.agentId || snapshot.group.agent_id !== scope.agentId || owner.status !== TaskStatus.AgentWorking || !owner.session_id
        || db.getTaskMcpScopeNonce(owner.id) !== scope.sessionNonce) {
        return { error: 'Only the current signed group execution owner may report member progress' }
      }
      if (!['working', 'done', 'blocked'].includes(String(params.state)) || typeof params.message !== 'string' || !params.message.trim() || params.message.length > 4000) {
        return { error: 'Report working, done or blocked with a non-empty message of at most 4,000 characters' }
      }
      return await taskGroupService.report(groupId, taskId, params.state as TaskGroupProgressState, params.message.trim(), owner.id)
    }
    return undefined
  } catch (error) { return { error: error instanceof Error ? error.message : 'Task group operation failed' } }
}
