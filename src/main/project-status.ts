/**
 * A project's status with the live session facts folded in (#58).
 *
 * DatabaseManager.getProjectStatus counts what the task rows say. Two counts
 * are not in any row: starts waiting in the admission queue (#47) and
 * sessions waiting for approval (a session state, never a task status). This
 * reads both from the agent manager and passes them down, so every caller
 * (IPC, the Commander) gets the same numbers without an LLM anywhere.
 */
import type { AgentManager } from './agent-manager'
import type { DatabaseManager, ProjectStatus, ProjectStatusLiveState } from './database'

export type ProjectStatusStore = Pick<DatabaseManager, 'getProjectStatus' | 'getTasks'>
export type ProjectStatusAgents = Pick<AgentManager, 'getStartQueue' | 'findSessionByTaskId' | 'getSessionStatus'> &
  Partial<Pick<AgentManager, 'getProjectLimitState'>>

/** The live state of a project's tasks; empty when no agent manager is around (tests, early start-up). */
export function liveProjectState(db: ProjectStatusStore, agents: ProjectStatusAgents | null | undefined, projectId: string): ProjectStatusLiveState {
  if (!agents) return {}
  const queuedTaskIds = agents.getStartQueue().map((entry) => entry.taskId)
  const approvalTaskIds: string[] = []
  for (const task of db.getTasks({ projectId })) {
    const found = agents.findSessionByTaskId(task.id)
    if (found && agents.getSessionStatus(found.sessionId)?.status === 'waiting_approval') approvalTaskIds.push(task.id)
  }
  return { queuedTaskIds, approvalTaskIds }
}

export function buildProjectStatus(db: ProjectStatusStore, agents: ProjectStatusAgents | null | undefined, projectId: string): ProjectStatus {
  const status = db.getProjectStatus(projectId, liveProjectState(db, agents, projectId))
  // #65: the limit state is live (running counts, queue), so it joins here, not in the row counts.
  const limits = agents?.getProjectLimitState?.(projectId)
  return limits ? { ...status, limits } : status
}
