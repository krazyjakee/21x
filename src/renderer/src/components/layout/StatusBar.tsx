import { useEffect, useMemo, useState } from 'react'
import { CircleSlash, Clock, Hand, ListChecks, Play, CircleAlert } from 'lucide-react'
import { useProjectTasks } from '@/hooks/use-project-tasks'
import { TaskStatus } from '@/types'
import { isSnoozed } from '@/lib/utils'
import { HeldActionsNotice } from '@/components/projects/HeldActionsNotice'
import { ActivityAnnouncer } from '@/components/activity/ActivityAnnouncer'
import { ActivityBadge } from '@/components/activity/ActivityBadge'
import { useCaptainTaskId } from '@/stores/coordinator-store'
import { useCommanderActivity, useProjectActivitySummary } from '@/lib/activity/use-activity'
import { isQuietActivity } from '@/lib/activity/derive-activity'

/**
 * Slim always-visible strip at the bottom of the shell: project-scoped live
 * activity counts and task totals on the left, the Commander's own global
 * status and app version on the right. Read-only and static: the status bar
 * never animates (#95). It also hosts the one application ActivityAnnouncer.
 */
export function StatusBar() {
  // Counts are the current project's.
  const tasks = useProjectTasks()
  const captainTaskId = useCaptainTaskId()
  const [version, setVersion] = useState('')

  useEffect(() => {
    window.electronAPI?.app?.getVersion().then((v) => v && setVersion(v))
  }, [])

  const { active, total, review, taskIds } = useMemo(() => {
    let a = 0
    let t = 0
    let r = 0
    const ids = new Set<string>()
    for (const task of tasks) {
      ids.add(task.id)
      if (task.parent_task_id) continue
      t++
      if (task.status === TaskStatus.ReadyForReview) r++
      if (task.status !== TaskStatus.Completed && !isSnoozed(task.snoozed_until)) a++
    }
    if (captainTaskId) ids.add(captainTaskId)
    return { active: a, total: t, review: r, taskIds: ids }
  }, [tasks, captainTaskId])

  // Only fresh running/thinking/tool sessions count as running; waiting,
  // queued, failed and unavailable are separate and never "running".
  const summary = useProjectActivitySummary(taskIds)
  const commander = useCommanderActivity()

  return (
    <div className="app-chrome bg-background flex-shrink-0 flex items-center gap-4 h-4 px-3 pb-1 leading-none text-[10px] text-muted-foreground select-none tabular-nums">
      <span
        className="flex items-center gap-1.5"
        title={`${summary.running} agent session${summary.running !== 1 ? 's' : ''} running in this project`}
        data-testid="status-running"
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full ${summary.running > 0 ? 'bg-primary' : 'bg-muted-foreground/40'}`}
        />
        <Play aria-hidden="true" className="h-2.5 w-2.5" />
        {summary.running} running
      </span>
      {summary.needsInput > 0 && (
        <span className="flex items-center gap-1 activity-tone-attention text-[var(--activity-color)]" data-testid="status-needs-input">
          <Hand aria-hidden="true" className="h-2.5 w-2.5" />
          {summary.needsInput} needs input
        </span>
      )}
      {summary.queued > 0 && (
        <span className="flex items-center gap-1" data-testid="status-queued">
          <Clock aria-hidden="true" className="h-2.5 w-2.5" />
          {summary.queued} queued
        </span>
      )}
      {summary.failed > 0 && (
        <span className="flex items-center gap-1 activity-tone-danger text-[var(--activity-color)]" data-testid="status-failed">
          <CircleAlert aria-hidden="true" className="h-2.5 w-2.5" />
          {summary.failed} failed
        </span>
      )}
      {summary.unavailable > 0 && (
        <span
          className="flex items-center gap-1"
          title="Sessions that were active but have not reported for 15 seconds"
          data-testid="status-unavailable"
        >
          <CircleSlash aria-hidden="true" className="h-2.5 w-2.5" />
          {summary.unavailable} unavailable
        </span>
      )}
      <span className="flex items-center gap-1.5" title="Active · total top-level tasks">
        <ListChecks aria-hidden="true" className="h-3 w-3" />
        {active} active · {total} total
      </span>
      {review > 0 && (
        <span className="flex items-center gap-1 activity-tone-review text-[var(--activity-color)]" data-testid="status-review">
          {review} ready for review
        </span>
      )}
      <div className="flex-1" />
      {!isQuietActivity(commander) && (
        <ActivityBadge
          result={commander}
          entityName="Commander"
          entityKey="commander"
          region="status-bar"
          variant="dot"
          size="chrome"
          tooltipPlacement="above"
          allowMotion={false}
        />
      )}
      <HeldActionsNotice />
      {version && <span className="opacity-70">v{version}</span>}
      <ActivityAnnouncer />
    </div>
  )
}
