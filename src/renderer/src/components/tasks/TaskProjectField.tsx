import { useMemo, useState } from 'react'
import { FolderKanban, Loader2 } from 'lucide-react'
import { useProjectStore, activeProjects, projectIdOf, projectName } from '@/stores/project-store'
import { useTaskStore } from '@/stores/task-store'
import { useUIStore } from '@/stores/ui-store'
import { dispatchShortcutFeedback } from '@/lib/keyboard-shortcuts'
import type { Task } from '@/types'

/**
 * The task's project, with a picker that moves it elsewhere. Subtasks move
 * with their parent (the main process moves the whole tree), so a subtask
 * only shows its project.
 */
export function TaskProjectField({ task }: { task: Task }) {
  const projects = useProjectStore((s) => s.projects)
  const moveTaskToProject = useTaskStore((s) => s.moveTaskToProject)
  const [moving, setMoving] = useState(false)
  const projectId = projectIdOf(task)
  const name = projectName(projects, projectId)

  const options = useMemo(() => {
    const list = activeProjects(projects)
    // An archived project can still own the task; keep it selectable as the current value.
    return list.some((p) => p.id === projectId) ? list : [...list, ...projects.filter((p) => p.id === projectId)]
  }, [projects, projectId])

  const handleMove = async (targetId: string) => {
    if (targetId === projectId) return
    const target = projectName(projects, targetId)
    const subtaskCount = useTaskStore.getState().tasks.filter((t) => t.parent_task_id === task.id).length
    const what = subtaskCount > 0 ? `"${task.title}" and its ${subtaskCount} subtask${subtaskCount === 1 ? '' : 's'}` : `"${task.title}"`
    if (!confirm(`Move ${what} to ${target}?`)) return
    setMoving(true)
    const moved = await moveTaskToProject(task.id, targetId)
    setMoving(false)
    if (!moved) {
      dispatchShortcutFeedback(`Could not move "${task.title}" to ${target}.`, true)
      return
    }
    // The task has left this project's views.
    if (useTaskStore.getState().selectedTaskId === task.id) useTaskStore.getState().selectTask(null)
    if (useUIStore.getState().dashboardPreviewTaskId === task.id) useUIStore.getState().closeDashboardPreview()
    dispatchShortcutFeedback(`Moved ${what} to ${target}.`)
  }

  if (task.parent_task_id || options.length < 2) {
    return (
      <span className="inline-flex items-center gap-1" title={task.parent_task_id ? 'A subtask moves with its parent' : undefined}>
        <FolderKanban className="size-icon-xs" />
        <span className="text-foreground/80">{name}</span>
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1">
      {moving ? <Loader2 className="size-icon-xs animate-spin" /> : <FolderKanban className="size-icon-xs" />}
      <select
        value={projectId}
        disabled={moving}
        onChange={(e) => void handleMove(e.target.value)}
        aria-label="Project (choose another to move the task)"
        title="Move to another project"
        className="rounded-md border border-transparent bg-transparent px-1 py-0.5 text-xs text-foreground/80 hover:border-input cursor-pointer"
      >
        {options.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
    </span>
  )
}
