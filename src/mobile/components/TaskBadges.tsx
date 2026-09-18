import { Badge } from './Badge'
import { PriorityBadge } from './PriorityBadge'
import { TaskStatusDot } from './TaskStatusDot'
import { STATUS_VARIANT } from '../lib/utils'
import type { Task } from '../stores/task-store'

export function TaskBadges({ task }: { task: Pick<Task, 'status' | 'priority' | 'type'> }) {
  const statusVariant = STATUS_VARIANT[task.status]
  return (
    <>
      <TaskStatusDot status={task.status} />
      {statusVariant && <Badge variant={statusVariant.variant}>{statusVariant.label}</Badge>}
      <PriorityBadge priority={task.priority} />
      {task.type !== 'general' && (
        <Badge variant={task.type === 'coding' ? 'blue' : task.type === 'review' ? 'teal' : 'default'}>
          {task.type}
        </Badge>
      )}
    </>
  )
}
