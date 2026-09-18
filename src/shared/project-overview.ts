/**
 * One row of the all-projects overview (#63): a project's status (#58) with
 * the facts a card needs beside it, computed by the main process in one pass
 * so the desktop overview and the phone read the same numbers.
 *
 * Every number here is counted (task rows, live sessions, held escalations);
 * only `status.summary` is the Mastermind's narrative.
 */
import type { ProjectLimitReason } from './project-policies'
import type { ProjectStatus } from './project-status'

export interface ProjectOverviewEntry {
  project_id: string
  name: string
  /** The project's description (the brief its Mastermind reads); '' when none. */
  brief: string
  is_default: boolean
  sort_order: number
  status: ProjectStatus
  /** Live sessions waiting for the user to approve a step (`status.counts.awaiting_approval`). */
  pending_approvals: number
  /** Mastermind calls the escalation policy holds for the user (#66). */
  held_actions: number
  /** Working sessions of the project's tasks right now. */
  running_agents: number
  /** The project's own pause (#65). */
  paused: boolean
  /** The `all_projects_paused` setting: nothing starts anywhere while true. */
  all_projects_paused: boolean
  /** Why the next start would wait, or null when it would run. */
  blocked_by: ProjectLimitReason | null
  /** ISO time of the newest task change or status write; null for an untouched project. */
  last_activity_at: string | null
  /** True when the project waits on the user: approvals, held calls or tasks to review. */
  needs_attention: boolean
}

/** The rule behind `needs_attention`, shared so the renderer and the phone agree. */
export function projectNeedsAttention(entry: Pick<ProjectOverviewEntry, 'pending_approvals' | 'held_actions' | 'status'>): boolean {
  return entry.pending_approvals > 0 || entry.held_actions > 0 || entry.status.counts.awaiting_review > 0
}
