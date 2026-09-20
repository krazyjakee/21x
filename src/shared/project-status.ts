/**
 * A project's status at a glance (#58): counts the database answers on its
 * own, plus the narrative the project's Captain maintains through the
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
  /** The Captain's one-paragraph summary; '' until it has written one. */
  summary: string
  /** The Captain's short list of what is in the way; empty until written. */
  top_blockers: string[]
  /** ISO time of the last narrative update; null until the first. */
  updated_at: string | null
}

/** Caps applied to what the Captain writes, so a snapshot stays one small read. */
export const PROJECT_STATUS_SUMMARY_MAX_CHARS = 1_000
export const PROJECT_STATUS_BLOCKER_MAX_CHARS = 200
export const PROJECT_STATUS_MAX_BLOCKERS = 5

// ── Status journal (#72) ──────────────────────────────────────
// Every `update_project_status` also appends one entry here, so a project's
// history survives beside the snapshot. Reads are paginated newest first and
// capped; nothing here is ever injected into a system prompt.

/** Where an entry came from: Captain prose, platform recovery, or compaction. */
export type ProjectStatusJournalSource = 'captain' | 'system_recovery' | 'compaction'

export interface ProjectStatusJournalEntry {
  id: string
  project_id: string
  summary: string
  completed: string[]
  blockers: string[]
  decisions: string[]
  next_steps: string[]
  source: ProjectStatusJournalSource
  /** The Commander correlation id the update answered, when the Captain quoted one. */
  correlation_id: string | null
  /** ISO time. For a compaction entry: the newest entry it replaced. */
  created_at: string
}

/** What the Captain may attach to an update besides the summary. */
export interface ProjectStatusJournalInput {
  summary: string
  completed?: string[]
  blockers?: string[]
  decisions?: string[]
  next_steps?: string[]
  correlation_id?: string | null
}

/** One page of history, newest first. `next_cursor` is opaque; pass it back to continue. */
export interface ProjectStatusHistoryPage {
  entries: ProjectStatusJournalEntry[]
  has_more: boolean
  next_cursor: string | null
}

/** Per-list caps on a journal entry's structured highlights. */
export const PROJECT_STATUS_JOURNAL_MAX_ITEMS = 8
export const PROJECT_STATUS_JOURNAL_ITEM_MAX_CHARS = 200
/** Page caps for history reads (the Commander tool and the project editor). */
export const PROJECT_STATUS_HISTORY_DEFAULT_LIMIT = 5
export const PROJECT_STATUS_HISTORY_MAX_LIMIT = 20
/** Entries older than this are rolled into one entry per project and month. */
export const PROJECT_STATUS_JOURNAL_COMPACT_AFTER_DAYS = 90
