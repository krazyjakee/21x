// Project status (#58): counts come from the task rows every time (plus the
// caller's live session facts, which no row records); only the Captain's
// narrative is stored, one snapshot per project in `project_status`. A journal
// of earlier snapshots (#72) goes in its own table beside it.
import { createId } from '@paralleldrive/cuid2'
import type { DatabaseManager } from '../database'
import { TaskStatus } from '../../shared/constants'
import { userTaskRoleFilter } from './task-roles'
import {
  PROJECT_STATUS_BLOCKER_MAX_CHARS,
  PROJECT_STATUS_JOURNAL_COMPACT_AFTER_DAYS,
  PROJECT_STATUS_JOURNAL_ITEM_MAX_CHARS,
  PROJECT_STATUS_JOURNAL_MAX_ITEMS,
  PROJECT_STATUS_MAX_BLOCKERS,
  PROJECT_STATUS_SUMMARY_MAX_CHARS,
  type ProjectStatus,
  type ProjectStatusJournalEntry,
  type ProjectStatusJournalInput,
  type ProjectStatusJournalSource
} from '../../shared/project-status'

/** A `project_status_journal` row (#72); the list columns hold JSON arrays. */
interface ProjectStatusJournalRow {
  id: string
  project_id: string
  summary: string
  completed: string
  blockers: string
  decisions: string
  next_steps: string
  source: string
  correlation_id: string | null
  created_at: string
}

/** What `recordProjectStatus` writes: the snapshot fields plus the journal highlights. */
export interface ProjectStatusUpdateInput extends ProjectStatusJournalInput {
  /** The snapshot's top blockers; also the journal entry's `blockers` unless those are given. */
  top_blockers?: string[]
}

/** Caps for a compaction entry: it stands for a month, so it may hold more than one update. */
const JOURNAL_COMPACTION_MAX_ITEMS = PROJECT_STATUS_JOURNAL_MAX_ITEMS * 2
const JOURNAL_COMPACTION_SUMMARY_MAX_CHARS = PROJECT_STATUS_SUMMARY_MAX_CHARS * 2
const JOURNAL_COMPACTION_LINE_MAX_CHARS = 200

function journalStringList(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function toJournalEntry(row: ProjectStatusJournalRow): ProjectStatusJournalEntry {
  return {
    id: row.id,
    project_id: row.project_id,
    summary: row.summary,
    completed: journalStringList(row.completed),
    blockers: journalStringList(row.blockers),
    decisions: journalStringList(row.decisions),
    next_steps: journalStringList(row.next_steps),
    source: row.source === 'compaction' ? 'compaction' : 'captain',
    correlation_id: row.correlation_id ?? null,
    created_at: row.created_at
  }
}

/** Trims, clips and caps one highlight list from the Captain. */
function cleanJournalList(value: unknown, maxItems = PROJECT_STATUS_JOURNAL_MAX_ITEMS): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim().slice(0, PROJECT_STATUS_JOURNAL_ITEM_MAX_CHARS)
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= maxItems) break
  }
  return out
}

/** What only the agent manager knows about a project's tasks (#58): see getProjectStatus. */
export interface ProjectStatusLiveState {
  /** Tasks waiting in the admission queue (#47). */
  queuedTaskIds?: Iterable<string>
  /** Tasks whose live session is in `waiting_approval`. */
  approvalTaskIds?: Iterable<string>
}

/**
 * The project's status: counts from the database and the stored narrative.
 * `live` carries what only the agent manager knows: tasks waiting in the
 * admission queue and tasks whose session is waiting for approval. Without
 * it those two counts are 0, never guessed.
 */
export function getProjectStatus(m: DatabaseManager, projectId: string, live?: ProjectStatusLiveState): ProjectStatus {
  const empty: ProjectStatus = {
    project_id: projectId,
    counts: { running: 0, queued: 0, awaiting_review: 0, awaiting_approval: 0, blocked: 0 },
    summary: '',
    top_blockers: [],
    updated_at: null
  }
  if (!m.db?.open) return empty

  const queued = new Set(live?.queuedTaskIds ?? [])
  const approval = new Set(live?.approvalTaskIds ?? [])
  const rows = m.prepare(
    `SELECT id, status, agent_id FROM tasks WHERE project_id = ? AND ${userTaskRoleFilter()}`
  ).all(projectId) as Array<{ id: string; status: string; agent_id: string | null }>
  const counts = { ...empty.counts }
  for (const row of rows) {
    if (row.status === TaskStatus.AgentWorking || row.status === TaskStatus.Triaging) counts.running += 1
    else if (row.status === TaskStatus.ReadyForReview) counts.awaiting_review += 1
    if (approval.has(row.id)) counts.awaiting_approval += 1
    if (queued.has(row.id)) counts.queued += 1
    else if (row.status === TaskStatus.NotStarted && !row.agent_id) counts.blocked += 1
  }

  const stored = m.prepare('SELECT summary, top_blockers, updated_at FROM project_status WHERE project_id = ?')
    .get(projectId) as { summary: string; top_blockers: string; updated_at: string } | undefined
  let topBlockers: string[] = []
  if (stored) {
    try {
      const parsed = JSON.parse(stored.top_blockers || '[]') as unknown
      if (Array.isArray(parsed)) topBlockers = parsed.filter((item): item is string => typeof item === 'string')
    } catch {
      // An unreadable list is an empty list; the summary still shows.
    }
  }
  return {
    project_id: projectId,
    counts,
    summary: stored?.summary ?? '',
    top_blockers: topBlockers,
    updated_at: stored?.updated_at ?? null
  }
}

/**
 * Replaces the project's narrative snapshot. The text is trimmed and capped
 * (shared/project-status.ts) so the record stays one small read. Undefined
 * for an unknown project: no row is invented for it.
 */
export function setProjectStatusSummary(m: DatabaseManager, projectId: string, summary: string, topBlockers: string[] = []): ProjectStatus | undefined {
  if (!m.db?.open || !m.getProject(projectId)) return undefined
  const text = summary.trim().slice(0, PROJECT_STATUS_SUMMARY_MAX_CHARS)
  const blockers = topBlockers
    .map((item) => String(item).trim().slice(0, PROJECT_STATUS_BLOCKER_MAX_CHARS))
    .filter(Boolean)
    .slice(0, PROJECT_STATUS_MAX_BLOCKERS)
  const now = new Date().toISOString()
  m.prepare(`
    INSERT INTO project_status (project_id, summary, top_blockers, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      summary = excluded.summary,
      top_blockers = excluded.top_blockers,
      updated_at = excluded.updated_at
  `).run(projectId, text, JSON.stringify(blockers), now)
  return getProjectStatus(m, projectId)
}

// ── Project status journal (#72) ─────────────────────────────
// The snapshot above stays the cheap read; every update also lands here as
// one row, so "what changed?" has an answer without a growing blob anywhere.
// Reads are newest first over (created_at, id), which stays stable while new
// rows arrive: a newer row can never fall behind an older cursor.

/**
 * Appends one journal entry. Lists are trimmed, deduplicated and capped
 * (shared/project-status.ts); an empty summary or unknown project writes
 * nothing. `createdAt` is for the roll-up and tests; callers normally omit it.
 */
export function appendProjectStatusJournal(
  m: DatabaseManager,
  projectId: string,
  input: ProjectStatusJournalInput,
  options: { source?: ProjectStatusJournalSource; createdAt?: string } = {}
): ProjectStatusJournalEntry | undefined {
  if (!m.db?.open || !m.getProject(projectId)) return undefined
  const summary = (input.summary ?? '').trim().slice(0, PROJECT_STATUS_SUMMARY_MAX_CHARS)
  if (!summary) return undefined
  const id = createId()
  const correlationId = typeof input.correlation_id === 'string' && input.correlation_id.trim() ? input.correlation_id.trim().slice(0, 100) : null
  m.prepare(`
    INSERT INTO project_status_journal
      (id, project_id, summary, completed, blockers, decisions, next_steps, source, correlation_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    projectId,
    summary,
    JSON.stringify(cleanJournalList(input.completed)),
    JSON.stringify(cleanJournalList(input.blockers)),
    JSON.stringify(cleanJournalList(input.decisions)),
    JSON.stringify(cleanJournalList(input.next_steps)),
    options.source ?? 'captain',
    correlationId,
    options.createdAt ?? new Date().toISOString()
  )
  return getProjectStatusJournalEntry(m, id)
}

export function getProjectStatusJournalEntry(m: DatabaseManager, id: string): ProjectStatusJournalEntry | undefined {
  if (!m.db?.open) return undefined
  const row = m.prepare('SELECT * FROM project_status_journal WHERE id = ?').get(id) as ProjectStatusJournalRow | undefined
  return row ? toJournalEntry(row) : undefined
}

/**
 * One status update from the Captain: replaces the snapshot and appends
 * the journal entry in one transaction. The entry's `blockers` default to
 * the snapshot's `top_blockers`. Undefined for an unknown project.
 */
export function recordProjectStatus(m: DatabaseManager, projectId: string, input: ProjectStatusUpdateInput): { status: ProjectStatus; entry: ProjectStatusJournalEntry } | undefined {
  if (!m.db?.open || !m.getProject(projectId)) return undefined
  const write = m.db.transaction((): { status: ProjectStatus; entry: ProjectStatusJournalEntry } | undefined => {
    const status = setProjectStatusSummary(m, projectId, input.summary, input.top_blockers ?? [])
    if (!status) return undefined
    const entry = appendProjectStatusJournal(m, projectId, { ...input, blockers: input.blockers ?? input.top_blockers ?? [] })
    if (!entry) throw new Error('summary is required')
    return { status, entry }
  })
  return write()
}

/**
 * A page of journal entries, newest first. `before` is the (created_at, id)
 * of the last entry of the previous page; the page holds up to `limit`
 * entries and says whether more exist. The caller caps `limit`.
 */
export function listProjectStatusJournal(
  m: DatabaseManager,
  projectId: string,
  options: { limit: number; before?: { created_at: string; id: string } | null }
): { entries: ProjectStatusJournalEntry[]; has_more: boolean } {
  if (!m.db?.open) return { entries: [], has_more: false }
  const limit = Math.max(1, Math.floor(options.limit))
  const rows = (options.before
    ? m.prepare(`
        SELECT * FROM project_status_journal
        WHERE project_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC LIMIT ?
      `).all(projectId, options.before.created_at, options.before.created_at, options.before.id, limit + 1)
    : m.prepare(`
        SELECT * FROM project_status_journal
        WHERE project_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?
      `).all(projectId, limit + 1)) as ProjectStatusJournalRow[]
  return { entries: rows.slice(0, limit).map(toJournalEntry), has_more: rows.length > limit }
}

export function countProjectStatusJournal(m: DatabaseManager, projectId: string): number {
  if (!m.db?.open) return 0
  const row = m.prepare('SELECT COUNT(*) AS n FROM project_status_journal WHERE project_id = ?').get(projectId) as { n: number }
  return row.n
}

/**
 * Retention (#72): Captain entries older than the window (90 days) are
 * rolled into one `compaction` entry per project and calendar month, then
 * deleted. The roll-up keeps a dated line per folded summary (newest lines
 * win when the cap is hit) and the union of each highlight list, so
 * decisions stay findable. An existing roll-up for the month absorbs new
 * arrivals, which makes the run idempotent: a second run folds nothing.
 * Runs at startup; `now` is for tests.
 */
export function compactProjectStatusJournal(m: DatabaseManager, now: Date = new Date()): { folded: number; written: number } {
  if (!m.db?.open) return { folded: 0, written: 0 }
  const cutoff = new Date(now.getTime() - PROJECT_STATUS_JOURNAL_COMPACT_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const stale = m.prepare(`
    SELECT * FROM project_status_journal
    WHERE source = 'captain' AND created_at < ?
    ORDER BY project_id ASC, created_at ASC, id ASC
  `).all(cutoff) as ProjectStatusJournalRow[]
  if (stale.length === 0) return { folded: 0, written: 0 }

  const groups = new Map<string, ProjectStatusJournalRow[]>()
  for (const row of stale) {
    const key = `${row.project_id}::${row.created_at.slice(0, 7)}`
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }

  const run = m.db.transaction((): { folded: number; written: number } => {
    let written = 0
    for (const [key, rows] of groups) {
      const [projectId, month] = key.split('::')
      const existing = m.prepare(`
        SELECT * FROM project_status_journal
        WHERE project_id = ? AND source = 'compaction' AND substr(created_at, 1, 7) = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(projectId, month) as ProjectStatusJournalRow | undefined

      // Newest lines first, so what survives the cap is the latest of the month.
      const lines = rows
        .map((row) => `${row.created_at.slice(0, 10)}: ${row.summary.replace(/\s+/g, ' ').trim().slice(0, JOURNAL_COMPACTION_LINE_MAX_CHARS)}`)
        .reverse()
      if (existing?.summary) lines.push(...existing.summary.split('\n').filter(Boolean).reverse())
      const kept: string[] = []
      let chars = 0
      for (const line of lines) {
        if (kept.length > 0 && chars + line.length + 1 > JOURNAL_COMPACTION_SUMMARY_MAX_CHARS) break
        kept.push(line)
        chars += line.length + 1
      }
      const summary = kept.reverse().join('\n').slice(0, JOURNAL_COMPACTION_SUMMARY_MAX_CHARS)

      const union = (pick: (row: ProjectStatusJournalRow) => string): string[] =>
        cleanJournalList([...(existing ? journalStringList(pick(existing)) : []), ...rows.flatMap((row) => journalStringList(pick(row)))], JOURNAL_COMPACTION_MAX_ITEMS)
      const newest = rows[rows.length - 1].created_at
      const createdAt = existing && existing.created_at > newest ? existing.created_at : newest
      const values = [
        summary,
        JSON.stringify(union((row) => row.completed)),
        JSON.stringify(union((row) => row.blockers)),
        JSON.stringify(union((row) => row.decisions)),
        JSON.stringify(union((row) => row.next_steps)),
        createdAt
      ]
      if (existing) {
        m.prepare(`
          UPDATE project_status_journal
          SET summary = ?, completed = ?, blockers = ?, decisions = ?, next_steps = ?, created_at = ?
          WHERE id = ?
        `).run(...values, existing.id)
      } else {
        m.prepare(`
          INSERT INTO project_status_journal
            (id, project_id, summary, completed, blockers, decisions, next_steps, source, correlation_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'compaction', NULL, ?)
        `).run(createId(), projectId, ...values)
      }
      written += 1
      const remove = m.prepare('DELETE FROM project_status_journal WHERE id = ?')
      for (const row of rows) remove.run(row.id)
    }
    return { folded: stale.length, written }
  })
  return run()
}
