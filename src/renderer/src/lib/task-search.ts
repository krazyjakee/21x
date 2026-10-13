import { isCoordinatorTask } from '@shared/task-roles'
import type { Task } from '@/types'

/** Matching is shared by the dashboard, sidebar and command palette. */
export function matchesTaskSearch(task: Task, query: string): boolean {
  if (isCoordinatorTask(task)) return false
  const needle = query.trim().toLowerCase()
  return !needle || [task.title, task.description, ...(Array.isArray(task.labels) ? task.labels : [])]
    .some((value) => value.toLowerCase().includes(needle))
}
