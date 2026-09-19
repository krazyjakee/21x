/**
 * A project's status with the live session facts folded in (#58).
 *
 * DatabaseManager.getProjectStatus counts what the task rows say. Two counts
 * are not in any row: starts waiting in the admission queue (#47) and
 * sessions waiting for approval (a session state, never a task status). This
 * reads both from the agent manager and passes them down, so every caller
 * (IPC, the Commander) gets the same numbers without an LLM anywhere.
 */
import type { AgentManager } from './agent-manager'
import type { DatabaseManager, ProjectStatus } from './database'
import type { ProjectStatusLiveState } from './database/project-status-store'
import {
  PROJECT_STATUS_HISTORY_DEFAULT_LIMIT,
  PROJECT_STATUS_HISTORY_MAX_LIMIT,
  type ProjectStatusHistoryPage,
  type ProjectStatusJournalEntry
} from '../shared/project-status'

export type ProjectStatusStore = Pick<DatabaseManager, 'getProjectStatus' | 'getTasks'>
export type ProjectStatusAgents = Pick<AgentManager, 'getStartQueue' | 'findSessionByTaskId' | 'getSessionStatus'> &
  Partial<Pick<AgentManager, 'getProjectLimitState'>>

/** The live state of a project's tasks; empty when no agent manager is around (tests, early start-up). */
export function liveProjectState(db: ProjectStatusStore, agents: ProjectStatusAgents | null | undefined, projectId: string): ProjectStatusLiveState {
  if (!agents) return {}
  const queuedTaskIds = agents.getStartQueue().map((entry) => entry.taskId)
  const approvalTaskIds: string[] = []
  for (const task of db.getTasks({ projectId })) {
    const found = agents.findSessionByTaskId(task.id)
    if (found && agents.getSessionStatus(found.sessionId)?.status === 'waiting_approval') approvalTaskIds.push(task.id)
  }
  return { queuedTaskIds, approvalTaskIds }
}

export function buildProjectStatus(db: ProjectStatusStore, agents: ProjectStatusAgents | null | undefined, projectId: string): ProjectStatus {
  const status = db.getProjectStatus(projectId, liveProjectState(db, agents, projectId))
  // #65: the limit state is live (running counts, queue), so it joins here, not in the row counts.
  const limits = agents?.getProjectLimitState?.(projectId)
  return limits ? { ...status, limits } : status
}

// ── Status history (#72) ──────────────────────────────────────
// One bounded page of the journal, newest first. The cursor is opaque to
// callers and encodes the (created_at, id) boundary of the last entry served,
// so a page read after new entries arrived continues exactly where the last
// one stopped. Caps apply per entry (summary and list clipping) and to the
// whole page (entries are dropped from the end until it fits; `has_more` and
// the cursor then point at what was dropped).

export type ProjectStatusHistoryStore = Pick<DatabaseManager, 'listProjectStatusJournal'>

export interface ProjectStatusHistoryQuery {
  limit?: unknown
  cursor?: unknown
}

export interface ProjectStatusHistoryCaps {
  /** Longest summary served per entry. */
  summaryChars: number
  /** Items kept per highlight list, and the longest item. */
  listItems: number
  itemChars: number
  /** Ceiling on the JSON size of the whole page. */
  totalChars: number
}

/** Defaults sized for a weak model's context: five entries fit comfortably. */
export const DEFAULT_HISTORY_CAPS: ProjectStatusHistoryCaps = { summaryChars: 600, listItems: 6, itemChars: 160, totalChars: 12_000 }

interface HistoryCursor {
  created_at: string
  id: string
}

export function encodeHistoryCursor(entry: Pick<ProjectStatusJournalEntry, 'created_at' | 'id'>): string {
  return Buffer.from(JSON.stringify({ c: entry.created_at, i: entry.id }), 'utf8').toString('base64url')
}

/** Null for anything that is not a cursor this module produced. */
export function decodeHistoryCursor(value: unknown): HistoryCursor | null {
  if (typeof value !== 'string' || !value || value.length > 300) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { c?: unknown; i?: unknown }
    if (typeof parsed?.c !== 'string' || typeof parsed?.i !== 'string' || !parsed.c || !parsed.i) return null
    return { created_at: parsed.c, id: parsed.i }
  } catch {
    return null
  }
}

/** The page size a caller asked for, within [1, max]; the default when absent. */
export function historyLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return PROJECT_STATUS_HISTORY_DEFAULT_LIMIT
  return Math.min(PROJECT_STATUS_HISTORY_MAX_LIMIT, Math.max(1, Math.floor(value)))
}

function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function clipList(items: string[], caps: ProjectStatusHistoryCaps): string[] {
  return items.slice(0, caps.listItems).map((item) => clipText(item, caps.itemChars))
}

function clipEntry(entry: ProjectStatusJournalEntry, caps: ProjectStatusHistoryCaps): ProjectStatusJournalEntry {
  return {
    ...entry,
    summary: clipText(entry.summary, caps.summaryChars),
    completed: clipList(entry.completed, caps),
    blockers: clipList(entry.blockers, caps),
    decisions: clipList(entry.decisions, caps),
    next_steps: clipList(entry.next_steps, caps)
  }
}

/**
 * Reads one page of a project's status history. An unreadable cursor is an
 * error (the caller asked to continue from somewhere that does not exist);
 * an absent one starts at the newest entry.
 */
export function readProjectStatusHistory(
  db: ProjectStatusHistoryStore,
  projectId: string,
  query: ProjectStatusHistoryQuery = {},
  caps: ProjectStatusHistoryCaps = DEFAULT_HISTORY_CAPS
): ProjectStatusHistoryPage {
  const limit = historyLimit(query.limit)
  let before: HistoryCursor | null = null
  if (query.cursor !== undefined && query.cursor !== null && query.cursor !== '') {
    before = decodeHistoryCursor(query.cursor)
    if (!before) throw new Error('cursor is not valid; start again without one')
  }
  const page = db.listProjectStatusJournal(projectId, { limit, before })
  const entries = page.entries.map((entry) => clipEntry(entry, caps))
  let hasMore = page.has_more
  // The page cap: drop from the end (the oldest) until it fits, keeping at least one entry.
  while (entries.length > 1 && JSON.stringify(entries).length > caps.totalChars) {
    entries.pop()
    hasMore = true
  }
  const last = entries[entries.length - 1]
  return { entries, has_more: hasMore, next_cursor: hasMore && last ? encodeHistoryCursor(last) : null }
}
