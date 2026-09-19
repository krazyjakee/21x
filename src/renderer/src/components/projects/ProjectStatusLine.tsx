import { useCallback, useEffect, useState } from 'react'
import { projectApi } from '@/lib/ipc-client'
import { formatRelativeDate } from '@shared/date-format'
import type { ProjectStatus, ProjectStatusCounts } from '@shared/project-status'

/**
 * Project status for a list of projects (#58): fetched when the list is
 * shown, refetched when the Captain writes a new summary. Counts are
 * computed by the main process from the database and live sessions; nothing
 * here is an LLM's opinion.
 */
export function useProjectStatuses(projectIds: string[], active = true): { statuses: Record<string, ProjectStatus>; refresh: () => void } {
  const [statuses, setStatuses] = useState<Record<string, ProjectStatus>>({})
  const [revision, setRevision] = useState(0)
  const key = projectIds.join('|')

  const refresh = useCallback(() => setRevision((r) => r + 1), [])

  useEffect(() => {
    if (!active || !key) return undefined
    let cancelled = false
    const ids = key.split('|')
    void Promise.all(ids.map((id) => projectApi.getStatus(id).then((status) => [id, status] as const).catch(() => null)))
      .then((entries) => {
        if (cancelled) return
        const next: Record<string, ProjectStatus> = {}
        for (const entry of entries) if (entry) next[entry[0]] = entry[1]
        setStatuses(next)
      })
    return () => { cancelled = true }
  }, [key, active, revision])

  useEffect(() => projectApi.onStatusChanged((event) => {
    if (!key.split('|').includes(event.projectId)) return
    void projectApi.getStatus(event.projectId)
      .then((status) => setStatuses((prev) => ({ ...prev, [event.projectId]: status })))
      .catch(() => undefined)
  }), [key])

  return { statuses, refresh }
}

const COUNT_LABELS: Array<[keyof ProjectStatusCounts, string]> = [
  ['running', 'running'],
  ['queued', 'queued'],
  ['awaiting_review', 'to review'],
  ['awaiting_approval', 'need approval'],
  ['blocked', 'blocked']
]

/** "2 running · 1 to review", or '' when every count is zero. */
export function describeProjectCounts(counts: ProjectStatusCounts): string {
  return COUNT_LABELS
    .filter(([key]) => counts[key] > 0)
    .map(([key, label]) => `${counts[key]} ${label}`)
    .join(' · ')
}

/**
 * One compact line per project: the counts, the Captain's summary and
 * how old that summary is. `compact` keeps it to two short lines for the
 * project switcher; the settings list shows the summary in full.
 */
export function ProjectStatusLine({ status, compact = false }: { status?: ProjectStatus; compact?: boolean }) {
  if (!status) return null
  const counts = describeProjectCounts(status.counts)
  const summary = status.summary.trim()
  return (
    <div className="min-w-0 space-y-0.5" data-testid="project-status">
      <p className="truncate text-[11px] text-muted-foreground">
        {counts || 'Nothing in flight'}
        {status.updated_at && <span className="text-muted-foreground/70"> · status {formatRelativeDate(status.updated_at)}</span>}
      </p>
      {summary && (
        <p className={compact ? 'truncate text-[11px] text-muted-foreground/90' : 'text-xs text-muted-foreground/90'} title={compact ? summary : undefined}>
          {summary}
        </p>
      )}
      {!compact && status.top_blockers.length > 0 && (
        <ul className="list-disc pl-4 text-xs text-muted-foreground">
          {status.top_blockers.map((blocker, i) => <li key={i}>{blocker}</li>)}
        </ul>
      )}
    </div>
  )
}
