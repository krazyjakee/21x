import { memo, useMemo } from 'react'
import { Calendar, AlarmClockOff, Repeat, HeartPulse, ListTree, ChevronRight } from 'lucide-react'
import { cn, formatDate, isOverdue, isDueSoon, isSnoozed } from '@/lib/utils'
import { TaskPriorityBadge } from './TaskPriorityBadge'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { TaskStatus } from '@/types'
import type { Task } from '@/types'
import { formatRecurrenceShort } from './recurrence-format'
import { taskListDotClass } from '@shared/task-status-styles'

interface TaskListItemProps {
  task: Task
  isSelected: boolean
  onSelect: (taskId: string) => void
  subtaskCount?: number
  isSubtask?: boolean
  isExpanded?: boolean
  onToggleExpand?: (taskId: string) => void
}

export const TaskListItem = memo(function TaskListItem({ task, isSelected, onSelect, subtaskCount, isSubtask, isExpanded, onToggleExpand }: TaskListItemProps) {
  const isActive = task.status !== TaskStatus.Completed
  const overdue = isActive && isOverdue(task.due_date)
  const dueSoon = isActive && !overdue && isDueSoon(task.due_date)
  const sessionStatus = useAgentStore((s) => s.sessions.get(task.id)?.status)
  const hasActiveAgent = sessionStatus != null && sessionStatus !== SessionStatus.IDLE

  // Determine status indicator color — shared with the mobile list
  const statusColor = useMemo(
    () => taskListDotClass(task.status, hasActiveAgent),
    [task.status, hasActiveAgent]
  )

  return (
    <button
      data-keyboard-task-id={task.id}
      onClick={() => onSelect(task.id)}
      aria-current={isSelected ? 'true' : undefined}
      className={cn(
        'w-full text-left px-3 py-2.5 rounded-md transition-colors cursor-pointer group',
        isSelected ? 'bg-accent' : 'hover:bg-accent/50',
        isSubtask && 'py-2'
      )}
    >
      <div className="flex items-start gap-3">
        <div className={cn(
          'mt-1.5 h-2 w-2 rounded-full shrink-0',
          isSubtask && 'mt-[5px] h-1.5 w-1.5',
          statusColor
        )} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className={cn('text-sm font-medium truncate flex-1', isSubtask && 'text-xs')}>{task.title}</div>
            {onToggleExpand && subtaskCount != null && subtaskCount > 0 && (
              <span
                role="button"
                onClick={(e) => { e.stopPropagation(); onToggleExpand(task.id) }}
                aria-label={isExpanded ? 'Collapse subtasks' : 'Expand subtasks'}
                className="shrink-0 -my-1 flex h-6 min-w-6 items-center justify-center gap-1 rounded-md px-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer"
              >
                {subtaskCount}
                <ChevronRight className={cn('size-icon-sm transition-transform', isExpanded && 'rotate-90')} />
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <TaskPriorityBadge priority={task.priority} />
            {task.due_date && (
              <span className={cn('flex items-center gap-1 text-xs', overdue ? 'text-destructive' : dueSoon ? 'text-amber-400' : 'text-muted-foreground')}>
                <Calendar className="size-icon-sm" />
                {formatDate(task.due_date)}
              </span>
            )}
            {isSnoozed(task.snoozed_until) && (
              <AlarmClockOff className="size-icon-sm text-muted-foreground" />
            )}
            {task.is_recurring && !task.recurrence_parent_id && task.recurrence_pattern && (
              <span
                className="flex items-center gap-1 text-xs text-muted-foreground"
                title={task.next_occurrence_at ? `Next: ${formatDate(task.next_occurrence_at)}` : undefined}
              >
                <Repeat className="size-icon-sm" />
                {formatRecurrenceShort(task.recurrence_pattern)}
              </span>
            )}
            {task.recurrence_parent_id && (
              <span title="From recurring template">
                <Repeat className="size-icon-sm text-muted-foreground opacity-50" />
              </span>
            )}
            {task.heartbeat_enabled && (
              <span title="Heartbeat monitoring active">
                <HeartPulse className="size-icon-sm text-rose-400" />
              </span>
            )}
            {subtaskCount != null && subtaskCount > 0 && !onToggleExpand && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground" title={`${subtaskCount} subtask${subtaskCount !== 1 ? 's' : ''}`}>
                <ListTree className="size-icon-sm" />
                {subtaskCount}
              </span>
            )}
            {task.source !== 'local' && (
              <span className="text-2xs px-1.5 py-0.5 rounded-md bg-accent text-muted-foreground">{task.source}</span>
            )}
          </div>
        </div>
      </div>
    </button>
  )
})
