import { taskStatusDotClass } from '@shared/task-status-styles'

export function TaskStatusDot({ status, className = '' }: { status: string; className?: string }) {
  const color = taskStatusDotClass(status)
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${color} ${className}`} />
}
