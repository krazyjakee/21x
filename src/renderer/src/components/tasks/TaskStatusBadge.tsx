import { Badge } from '@/components/ui/Badge'
import { taskStatusStyle } from '@shared/task-status-styles'
import { TaskStatus } from '@/types'

interface TaskStatusBadgeProps {
  status: TaskStatus
}

export function TaskStatusBadge({ status }: TaskStatusBadgeProps) {
  const { label, variant } = taskStatusStyle(status)
  return <Badge variant={variant}>{label}</Badge>
}
