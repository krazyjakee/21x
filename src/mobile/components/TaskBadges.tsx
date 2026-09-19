import { Badge } from '@/components/ui/Badge'
import { TaskPriorityBadge } from '@/components/tasks/TaskPriorityBadge'
import { TaskStatusDot } from './TaskStatusDot'
import { taskStatusStyle } from '@shared/task-status-styles'
import type { Task } from '@/types'

export function TaskBadges({ task }: { task: Pick<Task, 'status' | 'priority' | 'type'> }) {
  const status = taskStatusStyle(task.status)
  return (
    <>
      <TaskStatusDot status={task.status} />
      <Badge variant={status.variant}>{status.label}</Badge>
      <TaskPriorityBadge priority={task.priority} />
      {task.type !== 'general' && (
        <Badge variant={task.type === 'coding' ? 'blue' : task.type === 'review' ? 'teal' : 'default'}>
          {task.type}
        </Badge>
      )}
    </>
  )
}
