import { useMemo } from 'react'
import { useTaskStore } from '@/stores/task-store'
import { useTaskSourceStore } from '@/stores/task-source-store'
import { useProjectStore, filterToProject } from '@/stores/project-store'
import type { ProjectRecord } from '@shared/projects'
import type { Task, TaskSource } from '@/types'

/** The current project's tasks. Every task-facing view reads tasks through this. */
export function useProjectTasks(): Task[] {
  const tasks = useTaskStore((s) => s.tasks)
  const projectId = useProjectStore((s) => s.currentProjectId)
  return useMemo(() => filterToProject(tasks, projectId), [tasks, projectId])
}

/** The current project's task sources. */
export function useProjectTaskSources(): TaskSource[] {
  const sources = useTaskSourceStore((s) => s.sources)
  const projectId = useProjectStore((s) => s.currentProjectId)
  return useMemo(() => filterToProject(sources, projectId), [sources, projectId])
}

/** The current project's record; undefined until projects have loaded. */
export function useCurrentProject(): ProjectRecord | undefined {
  const projects = useProjectStore((s) => s.projects)
  const projectId = useProjectStore((s) => s.currentProjectId)
  return useMemo(() => projects.find((p) => p.id === projectId), [projects, projectId])
}
