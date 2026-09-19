import type { ProjectOverviewEntry } from '@shared/project-overview'
import type { ProjectStatusCounts } from '@shared/project-status'
import { describeProjectCounts } from '@/components/projects/ProjectStatusLine'

/** The five counts, in the order the card shows them. */
export const OVERVIEW_COUNT_TILES: Array<{ key: keyof ProjectStatusCounts; label: string }> = [
  { key: 'running', label: 'Running' },
  { key: 'queued', label: 'Queued' },
  { key: 'awaiting_review', label: 'To review' },
  { key: 'awaiting_approval', label: 'Approval' },
  { key: 'blocked', label: 'Blocked' }
]

/** The card's one-line summary: the Captain's, else the counts, else a quiet note. */
export function overviewSummary(entry: ProjectOverviewEntry): string {
  const summary = entry.status.summary.trim()
  if (summary) return summary
  return describeProjectCounts(entry.status.counts) || 'Nothing in flight'
}

/** "Paused", "All projects paused", "Waiting: daily cap" or null when starts run freely. */
export function describeLimitState(entry: Pick<ProjectOverviewEntry, 'paused' | 'all_projects_paused' | 'blocked_by'>): string | null {
  if (entry.all_projects_paused) return 'All projects paused'
  if (entry.paused) return 'Paused'
  switch (entry.blocked_by) {
    case 'project_limit': return 'Waiting: agent limit'
    case 'project_daily_cap': return 'Waiting: daily cap'
    case 'project_paused': return 'Paused'
    case 'global_pause': return 'All projects paused'
    default: return null
  }
}

/** What the project waits on the user for, as short phrases; empty when nothing. */
export function describeAttention(entry: ProjectOverviewEntry): string[] {
  const parts: string[] = []
  if (entry.pending_approvals > 0) parts.push(`${entry.pending_approvals} awaiting approval`)
  if (entry.held_actions > 0) parts.push(`${entry.held_actions} held Captain ${entry.held_actions === 1 ? 'call' : 'calls'}`)
  if (entry.status.counts.awaiting_review > 0) parts.push(`${entry.status.counts.awaiting_review} to review`)
  return parts
}

/** Attention first, then the user's order. */
export function sortOverviewEntries(entries: ProjectOverviewEntry[]): ProjectOverviewEntry[] {
  return [...entries].sort((a, b) => Number(b.needs_attention) - Number(a.needs_attention) || a.sort_order - b.sort_order)
}
