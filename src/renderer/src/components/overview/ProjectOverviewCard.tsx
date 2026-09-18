import { Bot, Clock, CirclePause, ShieldAlert } from 'lucide-react'
import { formatRelativeDate } from '@shared/date-format'
import type { ProjectOverviewEntry } from '@shared/project-overview'
import { OVERVIEW_COUNT_TILES, describeAttention, describeLimitState, overviewSummary } from './overview-helpers'

interface ProjectOverviewCardProps {
  entry: ProjectOverviewEntry
  current: boolean
  onSelect: (projectId: string) => void
}

/**
 * One project on the overview (#63): name, the status line, the five counts
 * as a stat row, then the live facts (agents, approvals, limits, activity).
 * A project waiting on the user gets an amber ring and a labelled badge, so
 * the state is never colour alone. The whole card is the button.
 */
export function ProjectOverviewCard({ entry, current, onSelect }: ProjectOverviewCardProps) {
  const attention = describeAttention(entry)
  const limitState = describeLimitState(entry)
  const summary = overviewSummary(entry)

  return (
    <button
      type="button"
      onClick={() => onSelect(entry.project_id)}
      data-testid="project-overview-card"
      data-project-id={entry.project_id}
      data-attention={entry.needs_attention ? 'true' : 'false'}
      aria-label={`${entry.name}${entry.needs_attention ? ', needs your input' : ''}${current ? ', current project' : ''}`}
      className={`group flex w-full min-w-0 cursor-pointer flex-col gap-3 rounded-2xl border bg-card p-4 text-left shadow-card transition-all duration-150 hover:shadow-pop focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
        entry.needs_attention
          ? 'border-amber-500/50 ring-1 ring-amber-500/30'
          : 'border-border hover:border-primary/40'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">
            {entry.name}
            {current && <span className="ml-2 rounded-full bg-primary/12 px-1.5 py-0.5 text-2xs font-medium text-primary">Current</span>}
          </h3>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground" title={summary}>{summary}</p>
        </div>
        {entry.needs_attention && (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full bg-amber-500/12 px-2 py-0.5 text-2xs font-medium text-amber-700 dark:text-amber-400"
            title={attention.join(' · ')}
          >
            <ShieldAlert className="size-3" aria-hidden="true" />
            Needs you
          </span>
        )}
      </div>

      <dl className="grid grid-cols-5 gap-1 rounded-lg bg-muted/40 px-2 py-1.5" aria-label="Task counts">
        {OVERVIEW_COUNT_TILES.map(({ key, label }) => {
          const value = entry.status.counts[key]
          return (
            <div key={key} className="min-w-0 text-center">
              <dd className={`text-base font-semibold tabular-nums leading-tight ${value > 0 ? 'text-foreground' : 'text-muted-foreground/60'}`}>
                {value}
              </dd>
              <dt className="truncate text-2xs uppercase tracking-wide text-muted-foreground">{label}</dt>
            </div>
          )
        })}
      </dl>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1" title="Agents working right now">
          <Bot className="size-3.5" aria-hidden="true" />
          {entry.running_agents} {entry.running_agents === 1 ? 'agent' : 'agents'}
        </span>
        {attention.length > 0 && (
          <span className="text-amber-700 dark:text-amber-400">{attention.join(' · ')}</span>
        )}
        {limitState && (
          <span className="flex items-center gap-1" title="Starts wait for this">
            <CirclePause className="size-3.5" aria-hidden="true" />
            {limitState}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1" title={entry.last_activity_at ?? 'No activity yet'}>
          <Clock className="size-3.5" aria-hidden="true" />
          {entry.last_activity_at ? formatRelativeDate(entry.last_activity_at) : 'No activity yet'}
        </span>
      </div>
    </button>
  )
}
