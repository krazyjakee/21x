import { useTaskActivity } from '@/lib/activity/use-activity'
import { isQuietActivity } from '@/lib/activity/derive-activity'
import { ActivityBadge } from './ActivityBadge'

/**
 * One task's live activity badge (#95): canvas headers now, board cards in the
 * hook-up follow-up. Separate from the lifecycle column/label: a lifecycle
 * value alone never makes this say "Running".
 *
 * With `hideWhenQuiet` (the default) verified idle and unknown-without-history
 * render nothing; a lost active claim still shows "Status unavailable · Last
 * seen running".
 */
export function TaskActivityBadge({
  taskId,
  title,
  region,
  allowMotion = true,
  hideWhenQuiet = true,
  className
}: {
  taskId: string
  title: string
  region: string
  allowMotion?: boolean
  hideWhenQuiet?: boolean
  className?: string
}) {
  const result = useTaskActivity(taskId)
  if (hideWhenQuiet && isQuietActivity(result)) return null
  return (
    <ActivityBadge
      result={result}
      entityName={title || 'Task'}
      entityKey={`task:${taskId}`}
      region={region}
      allowMotion={allowMotion}
      className={className}
    />
  )
}
