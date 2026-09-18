/**
 * A project's status at a glance (#58): counts the database answers on its
 * own, plus the narrative the project's Mastermind maintains through the
 * `update_project_status` tool. The Commander and the project switcher read
 * this instead of raw task data.
 *
 * The counts never come from an LLM. The narrative (`summary`, `top_blockers`,
 * `updated_at`) is the latest snapshot; a durable journal of earlier
 * snapshots is a follow-up (#72) that adds a table beside `project_status`.
 */

export interface ProjectStatusCounts {
  /** Tasks whose agent is working right now (`agent_working` or `triaging`). */
  running: number
  /** Tasks waiting in the admission queue for a session slot (#47). */
  queued: number
  /** Tasks in `ready_for_review`. */
  awaiting_review: number
  /** Tasks whose live session is waiting for the user to approve a step. */
  awaiting_approval: number
  /** Tasks in `not_started` with no agent to pick them up and no queued start. */
  blocked: number
}

import type { ProjectLimitState } from './project-limit-types'

export interface ProjectStatus {
  project_id: string
  counts: ProjectStatusCounts
  /** The project's limits, pause and what they block right now (#65). Absent with no agent manager. */
  limits?: ProjectLimitState
  /** The Mastermind's one-paragraph summary; '' until it has written one. */
  summary: string
  /** The Mastermind's short list of what is in the way; empty until written. */
  top_blockers: string[]
  /** ISO time of the last narrative update; null until the first. */
  updated_at: string | null
}

/** Caps applied to what the Mastermind writes, so a snapshot stays one small read. */
export const PROJECT_STATUS_SUMMARY_MAX_CHARS = 1_000
export const PROJECT_STATUS_BLOCKER_MAX_CHARS = 200
export const PROJECT_STATUS_MAX_BLOCKERS = 5
