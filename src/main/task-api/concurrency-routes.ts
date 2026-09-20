/**
 * Concurrency tools (#150): `get_concurrency`, `set_concurrency` and
 * `set_task_touches`. The rules live in shared/concurrency.ts and
 * concurrency-control.ts; the live counts in the agent manager.
 *
 * In project scope the MCP layer forces `project_id` to the caller's
 * project (task-management-core.ts), so a Captain can only move its own
 * project's levels; `set_concurrency` is Captain-only there.
 */
import type { DatabaseManager } from '../database'
import { agentController } from './state'

function projectOf(params: Record<string, unknown>): { projectId: string } | { error: string } {
  const forced = typeof params.project_id === 'string' && params.project_id ? params.project_id : ''
  const named = typeof params.project === 'string' && params.project ? params.project : ''
  if (forced && named && forced !== named) return { error: "Access denied: a Captain can only set its own project's concurrency" }
  const projectId = forced || named
  return projectId ? { projectId } : { error: 'project is required' }
}

export async function handleConcurrencyRoute(db: DatabaseManager, route: string, params: Record<string, unknown>): Promise<unknown> {
  switch (route) {
    case '/get_concurrency': {
      const project = projectOf(params)
      if ('error' in project) return project
      if (!db.getProject(project.projectId)) return { error: 'Project not found' }
      if (!agentController) return { error: 'Agent controller not available' }
      const state = agentController.getConcurrencyState(project.projectId)
      const agentId = typeof params.agent_id === 'string' && params.agent_id ? params.agent_id : null
      return agentId ? { ...state, agents: state.agents.filter((agent) => agent.agentId === agentId) } : state
    }

    case '/set_concurrency': {
      const project = projectOf(params)
      if ('error' in project) return project
      if (typeof params.agent_id !== 'string' || !params.agent_id) return { error: 'agent_id is required' }
      if (!agentController) return { error: 'Agent controller not available' }
      return agentController.setConcurrencyLevel({
        projectId: project.projectId,
        agentId: params.agent_id,
        level: params.level,
        reason: params.reason,
        actor: 'captain'
      })
    }

    case '/set_task_touches': {
      const taskId = typeof params.task_id === 'string' ? params.task_id : ''
      if (!taskId || !db.getTask(taskId)) return { error: 'Task not found' }
      if (!Array.isArray(params.paths) || params.paths.some((p) => typeof p !== 'string')) {
        return { error: 'paths must be an array of repo-relative file or directory paths' }
      }
      if (!agentController) return { error: 'Agent controller not available' }
      const stored = agentController.setTaskTouches(taskId, params.paths as string[])
      return {
        success: true,
        task_id: taskId,
        touches: stored,
        note: stored.length
          ? 'Starts in this project that touch any of these paths wait while this task runs, and this task waits while one of them runs.'
          : 'Touches cleared.'
      }
    }

    default:
      return undefined
  }
}
