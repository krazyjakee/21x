import { useEffect, useMemo } from 'react'
import { useTaskStore } from '@/stores/task-store'
import { useProjectTasks } from './use-project-tasks'
import { useUIStore } from '@/stores/ui-store'
import { PRIORITY_ORDER, STATUS_ORDER } from '@shared/constants'
import type { Task } from '@/types'

export function useTasks() {
  // Use individual selectors to avoid re-renders from unrelated store changes
  // Scoped to the current project: nothing from another project reaches a task view.
  const tasks = useProjectTasks()
  const everyTask = useTaskStore((s) => s.tasks)
  const selectedTaskId = useTaskStore((s) => s.selectedTaskId)
  const isLoading = useTaskStore((s) => s.isLoading)
  const error = useTaskStore((s) => s.error)
  const fetchTasks = useTaskStore((s) => s.fetchTasks)
  const createTask = useTaskStore((s) => s.createTask)
  const updateTask = useTaskStore((s) => s.updateTask)
  const deleteTask = useTaskStore((s) => s.deleteTask)
  const selectTask = useTaskStore((s) => s.selectTask)

  const statusFilter = useUIStore((s) => s.statusFilter)
  const priorityFilter = useUIStore((s) => s.priorityFilter)
  const sourceFilter = useUIStore((s) => s.sourceFilter)
  const sortField = useUIStore((s) => s.sortField)
  const sortDirection = useUIStore((s) => s.sortDirection)
  const searchQuery = useUIStore((s) => s.searchQuery)

  useEffect(() => {
    fetchTasks()
  }, [fetchTasks])

  const filteredTasks = useMemo(() => {
    let result = [...tasks]

    // Source filter
    if (sourceFilter !== 'all') {
      if (sourceFilter === 'local') {
        result = result.filter((t) => !t.source_id)
      } else {
        result = result.filter((t) => t.source_id === sourceFilter)
      }
    }

    // Status filter
    if (statusFilter !== 'all') {
      result = result.filter((t) => t.status === statusFilter)
    }

    // Priority filter
    if (priorityFilter !== 'all') {
      result = result.filter((t) => t.priority === priorityFilter)
    }

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          (Array.isArray(t.labels) && t.labels.some((l) => l.toLowerCase().includes(q)))
      )
    }

    // Date fields are parsed once per task, not once per comparison.
    const dateField = sortField === 'due_date' || sortField === 'updated_at' ? sortField : 'created_at'
    const timestamps = new Map<Task, number>()
    if (sortField !== 'priority' && sortField !== 'status' && sortField !== 'title') {
      for (const t of result) {
        const value = t[dateField]
        // Tasks without a due date sort last.
        timestamps.set(t, dateField === 'due_date' && !value ? Infinity : new Date(value as string).getTime())
      }
    }

    result.sort((a, b) => {
      let cmp: number
      switch (sortField) {
        case 'priority':
          cmp = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
          break
        case 'status':
          cmp = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
          break
        case 'title':
          cmp = a.title.localeCompare(b.title)
          break
        default:
          cmp = timestamps.get(a)! - timestamps.get(b)!
          break
      }
      return sortDirection === 'desc' ? -cmp : cmp
    })

    return result
  }, [tasks, sourceFilter, statusFilter, priorityFilter, searchQuery, sortField, sortDirection])

  const selectedTask: Task | undefined = useMemo(
    () => (selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) : undefined),
    [tasks, selectedTaskId]
  )

  return {
    tasks: filteredTasks,
    /** The current project's tasks, before the sidebar filters. */
    allTasks: tasks,
    /** Every project's tasks — for notifications and auto-start only, never for display. */
    everyTask,
    selectedTask,
    isLoading,
    error,
    createTask,
    updateTask,
    deleteTask,
    selectTask
  }
}
