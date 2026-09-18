import { useCallback, useEffect, useMemo } from 'react'
import { CirclePause, RefreshCw } from 'lucide-react'
import { useOverviewStore } from '@/stores/overview-store'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'
import { ProjectOverviewCard } from './ProjectOverviewCard'
import { sortOverviewEntries } from './overview-helpers'

/**
 * The all-projects overview (#63): one card per active project, projects
 * waiting on the user first. Clicking a card makes it the current project and
 * opens the dashboard. The store keeps the cards live from task, session and
 * escalation events; this view only mounts it.
 */
export function OverviewWorkspace() {
  const entries = useOverviewStore((s) => s.entries)
  const isLoading = useOverviewStore((s) => s.isLoading)
  const error = useOverviewStore((s) => s.error)
  const loadedAt = useOverviewStore((s) => s.loadedAt)
  const start = useOverviewStore((s) => s.start)
  const fetchAll = useOverviewStore((s) => s.fetchAll)
  const currentProjectId = useProjectStore((s) => s.currentProjectId)
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject)
  const setSidebarView = useUIStore((s) => s.setSidebarView)

  useEffect(() => start(), [start])

  const handleSelect = useCallback((projectId: string) => {
    setCurrentProject(projectId)
    setSidebarView('dashboard')
  }, [setCurrentProject, setSidebarView])

  const sorted = useMemo(() => sortOverviewEntries(entries), [entries])
  const attentionCount = useMemo(() => entries.filter((entry) => entry.needs_attention).length, [entries])
  const allPaused = entries.some((entry) => entry.all_projects_paused)

  return (
    <div className="ui-scale h-full overflow-y-auto overflow-x-hidden">
      <div className="mx-auto max-w-[1600px] px-6 pb-8 pt-6">
        <header className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Projects</h2>
            <p className="text-xs text-muted-foreground">
              {entries.length === 0 && loadedAt
                ? 'No active projects.'
                : attentionCount > 0
                  ? `${attentionCount} ${attentionCount === 1 ? 'project needs' : 'projects need'} your input.`
                  : 'Nothing is waiting on you.'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => { void fetchAll() }}
            disabled={isLoading}
            aria-label="Refresh overview"
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`size-3.5 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
            Refresh
          </button>
        </header>

        {allPaused && (
          <div role="status" className="mb-4 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <CirclePause className="size-4" aria-hidden="true" />
            All projects are paused: nothing starts until the pause is lifted.
          </div>
        )}

        {error && (
          <div role="alert" className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            Could not load the overview: {error}
          </div>
        )}

        {sorted.length === 0 && !loadedAt && isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="project-overview-grid">
            {sorted.map((entry) => (
              <ProjectOverviewCard
                key={entry.project_id}
                entry={entry}
                current={entry.project_id === currentProjectId}
                onSelect={handleSelect}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
