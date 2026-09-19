import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { onEvent } from '../api/websocket'
import { useTaskStore } from '../stores/task-store'
import { PageHeader } from '../components/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { formatRelativeDate } from '@shared/date-format'
import type { ProjectOverviewEntry } from '@shared/project-overview'
import type { Route } from '../App'

/** Events that change a card fold into one refetch after this pause. */
const REFRESH_DEBOUNCE_MS = 500
/** Slow fallback while the page is visible; the socket carries the real signal. */
const FALLBACK_POLL_MS = 15_000

const COUNT_TILES: Array<{ key: keyof ProjectOverviewEntry['status']['counts']; label: string }> = [
  { key: 'running', label: 'Running' },
  { key: 'queued', label: 'Queued' },
  { key: 'awaiting_review', label: 'Review' },
  { key: 'awaiting_approval', label: 'Approval' },
  { key: 'blocked', label: 'Blocked' }
]

function limitLabel(entry: ProjectOverviewEntry): string | null {
  if (entry.all_projects_paused) return 'All projects paused'
  if (entry.paused || entry.blocked_by === 'project_paused') return 'Paused'
  if (entry.blocked_by === 'project_limit') return 'Waiting: agent limit'
  if (entry.blocked_by === 'project_daily_cap') return 'Waiting: daily cap'
  if (entry.blocked_by === 'global_pause') return 'All projects paused'
  return null
}

function attentionLabel(entry: ProjectOverviewEntry): string {
  const parts: string[] = []
  if (entry.pending_approvals > 0) parts.push(`${entry.pending_approvals} awaiting approval`)
  if (entry.held_actions > 0) parts.push(`${entry.held_actions} held`)
  if (entry.status.counts.awaiting_review > 0) parts.push(`${entry.status.counts.awaiting_review} to review`)
  return parts.join(' · ')
}

/**
 * Read-only all-projects overview for the phone (#63): the same rows the
 * desktop shows, from GET /api/projects/status. Tapping a project makes it
 * the phone's project and returns to its task list.
 */
export function ProjectsOverviewPage({ onNavigate }: { onNavigate: (route: Route) => void }) {
  const [entries, setEntries] = useState<ProjectOverviewEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const currentProjectId = useTaskStore((s) => s.currentProjectId)
  const setCurrentProject = useTaskStore((s) => s.setCurrentProject)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    try {
      const next = await api.projects.status()
      next.sort((a, b) => Number(b.needs_attention) - Number(a.needs_attention) || a.sort_order - b.sort_order)
      setEntries(next)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects')
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void load()
    const schedule = (): void => {
      if (debounce.current) clearTimeout(debounce.current)
      debounce.current = setTimeout(() => { debounce.current = null; void load() }, REFRESH_DEBOUNCE_MS)
    }
    const offs = ['task:updated', 'task:created', 'task:deleted', 'agent:status'].map((type) => onEvent(type, schedule))
    const poll = setInterval(() => { if (document.visibilityState === 'visible') void load() }, FALLBACK_POLL_MS)
    return () => {
      for (const off of offs) off()
      clearInterval(poll)
      if (debounce.current) clearTimeout(debounce.current)
    }
  }, [load])

  const select = async (projectId: string): Promise<void> => {
    await setCurrentProject(projectId)
    onNavigate({ page: 'list' })
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader onBack={() => onNavigate({ page: 'list' })} title="Projects" />
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {error && (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>
        )}
        {loaded && entries.length === 0 && !error && (
          <p className="text-sm text-muted-foreground text-center py-8">No active projects</p>
        )}
        {entries.map((entry) => {
          const summary = entry.status.summary.trim()
          const attention = attentionLabel(entry)
          const limit = limitLabel(entry)
          const current = entry.project_id === currentProjectId
          return (
            <button
              key={entry.project_id}
              type="button"
              onClick={() => { void select(entry.project_id) }}
              data-testid="project-overview-card"
              data-attention={entry.needs_attention ? 'true' : 'false'}
              className={`w-full text-left rounded-lg border bg-card p-3 space-y-2 active:opacity-80 transition-colors ${
                entry.needs_attention ? 'border-amber-500/60 ring-1 ring-amber-500/30' : 'border-border'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <h2 className="text-sm font-semibold truncate">{entry.name}</h2>
                    {current && <Badge variant="blue">Current</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">{summary || 'No status yet'}</p>
                </div>
                {entry.needs_attention && <Badge variant="yellow" className="shrink-0">Needs you</Badge>}
              </div>

              <div className="grid grid-cols-5 gap-1 rounded-md bg-muted/40 px-1 py-1.5">
                {COUNT_TILES.map(({ key, label }) => {
                  const value = entry.status.counts[key]
                  return (
                    <div key={key} className="text-center min-w-0">
                      <div className={`text-sm font-semibold tabular-nums ${value > 0 ? 'text-foreground' : 'text-muted-foreground/60'}`}>{value}</div>
                      <div className="text-[9px] uppercase tracking-wide text-muted-foreground truncate">{label}</div>
                    </div>
                  )
                })}
              </div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                <span>{entry.running_agents} {entry.running_agents === 1 ? 'agent' : 'agents'}</span>
                {attention && <span className="text-amber-500">{attention}</span>}
                {limit && <span>{limit}</span>}
                <span className="ml-auto">{entry.last_activity_at ? formatRelativeDate(entry.last_activity_at) : 'No activity yet'}</span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
