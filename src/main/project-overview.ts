/**
 * The all-projects overview (#63): every active project's status (#58) plus
 * the card-level facts beside it, computed in one pass.
 *
 * Reads: project rows, buildProjectStatus (task counts, live sessions, limit
 * state) and the escalation module's held calls (#66). The last activity time
 * is the newest task `updated_at` in the project, or the status write if that
 * is newer. Nothing here asks an LLM.
 */
import type { DatabaseManager } from './database'
import { buildProjectStatus, type ProjectStatusAgents } from './project-status'
import { listHeldActions } from './escalation'
import { DEFAULT_PROJECT_ID } from '../shared/projects'
import { projectNeedsAttention, type ProjectOverviewEntry } from '../shared/project-overview'

export type ProjectOverviewStore = Pick<DatabaseManager, 'getProjects' | 'getProjectStatus' | 'getTasks' | 'getLatestTaskUpdate'>

/** Only a real agent manager can answer the live questions; a stub (tests, early start-up) counts as none. */
function usableAgents(agents: unknown): ProjectStatusAgents | null {
  const candidate = agents as Partial<ProjectStatusAgents> | null | undefined
  if (!candidate) return null
  const ready = typeof candidate.getStartQueue === 'function'
    && typeof candidate.findSessionByTaskId === 'function'
    && typeof candidate.getSessionStatus === 'function'
  return ready ? (candidate as ProjectStatusAgents) : null
}

export function buildProjectOverview(db: ProjectOverviewStore, agents: unknown): ProjectOverviewEntry[] {
  const liveAgents = usableAgents(agents)
  const heldByProject = new Map<string, number>()
  for (const held of listHeldActions()) heldByProject.set(held.projectId, (heldByProject.get(held.projectId) ?? 0) + 1)

  return db.getProjects().map((project) => {
    const status = buildProjectStatus(db, liveAgents, project.id)
    const latestTask = db.getLatestTaskUpdate(project.id)
    const lastActivity = latestTask && (!status.updated_at || latestTask > status.updated_at) ? latestTask : status.updated_at
    const limits = status.limits
    const entry: Omit<ProjectOverviewEntry, 'needs_attention'> = {
      project_id: project.id,
      name: project.name,
      brief: project.description ?? '',
      is_default: project.id === DEFAULT_PROJECT_ID,
      sort_order: project.sort_order,
      status,
      pending_approvals: status.counts.awaiting_approval,
      held_actions: heldByProject.get(project.id) ?? 0,
      running_agents: limits?.runningAgents ?? status.counts.running,
      paused: limits?.paused ?? false,
      all_projects_paused: limits?.allProjectsPaused ?? false,
      blocked_by: limits?.blockedBy ?? null,
      last_activity_at: lastActivity
    }
    return { ...entry, needs_attention: projectNeedsAttention(entry) }
  })
}
