import type { DatabaseManager } from '../database'
import { TaskStatus } from '../../shared/constants'
import { DEFAULT_PROJECT_ID } from '../../shared/projects'
import { buildProjectOverview } from '../project-overview'
import { deps, type MobileRoute } from './state'

/**
 * The desktop's current-project setting, written by the desktop project
 * switcher. Tasks a phone creates without a project_id land there.
 */
const CURRENT_PROJECT_SETTING = 'current_project_id'

/** The desktop's current project when it is set and active, else Default. */
export function resolveDefaultProjectId(db: DatabaseManager): string {
  const current = db.getSetting(CURRENT_PROJECT_SETTING)
  if (current) {
    const project = db.getProject(current)
    if (project && !project.archived) return project.id
  }
  return DEFAULT_PROJECT_ID
}

export const projectRoutes: MobileRoute[] = [
  {
    // Active projects with cheap task counts. `current` marks the project a
    // task created without a project_id lands in.
    method: 'GET',
    path: '/api/projects',
    handle: () => {
      const { db } = deps
      const counts = new Map<string, { total: number; open: number }>()
      for (const task of db.getTasks()) {
        const entry = counts.get(task.project_id) ?? { total: 0, open: 0 }
        entry.total++
        if (task.status !== TaskStatus.Completed) entry.open++
        counts.set(task.project_id, entry)
      }
      const currentId = resolveDefaultProjectId(db)
      return db.getProjects().map(project => ({
        id: project.id,
        name: project.name,
        brief: project.description,
        is_default: project.id === DEFAULT_PROJECT_ID,
        current: project.id === currentId,
        task_count: counts.get(project.id)?.total ?? 0,
        open_task_count: counts.get(project.id)?.open ?? 0,
        sort_order: project.sort_order
      }))
    }
  },
  {
    // The all-projects overview (#63): the same read-only rows the desktop
    // overview shows.
    method: 'GET',
    path: '/api/projects/status',
    handle: () => buildProjectOverview(deps.db, deps.agentManager)
  }
]
