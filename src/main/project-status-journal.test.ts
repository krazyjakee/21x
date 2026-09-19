/**
 * The project status journal (#72): every `update_project_status` appends an
 * entry beside the unchanged snapshot; history reads are newest first,
 * cursor-stable and capped; old entries roll up by month, idempotently.
 */
import { describe, it, expect } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import type { DatabaseManager } from './database'
import { decodeHistoryCursor, encodeHistoryCursor, readProjectStatusHistory } from './project-status'
import { handleTaskRoute } from './task-api/task-routes'
import { createCommanderProjectTools, ProjectMutationConfirmations } from './commander/project-tools'
import {
  PROJECT_STATUS_HISTORY_MAX_LIMIT,
  PROJECT_STATUS_JOURNAL_COMPACT_AFTER_DAYS,
  PROJECT_STATUS_JOURNAL_ITEM_MAX_CHARS,
  PROJECT_STATUS_JOURNAL_MAX_ITEMS
} from '../shared/project-status'

function seed() {
  const { db, rawDb } = createTestDb()
  const project = db.createProject({ name: 'Alpha' })!
  return { db, rawDb, project }
}

const DAY = 24 * 60 * 60 * 1000
const at = (now: Date, daysAgo: number, extraMs = 0): string => new Date(now.getTime() - daysAgo * DAY + extraMs).toISOString()

function commanderTool(db: DatabaseManager, name: string) {
  const tool = createCommanderProjectTools({ db, context: { sessionId: 's', userMessage: '' }, confirmations: new ProjectMutationConfirmations() })
    .find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`Missing tool ${name}`)
  return async (input: Record<string, unknown>) => {
    const output = await tool.handler(input, { signal: new AbortController().signal, toolCallId: 'c' })
    return typeof output === 'string' ? output : output.content
  }
}

describe('update_project_status writes the journal (#72)', () => {
  it('reads legacy Captain status prose without overwriting stored history', () => {
    const { db, rawDb, project } = seed()
    const legacy = ['Master', 'mind'].join('')
    const summary = `The ${legacy} reviewed the release.`
    const highlights = [`Ask the ${legacy}.`]
    const result = db.recordProjectStatus(project.id, {
      summary, top_blockers: highlights, completed: highlights,
      blockers: highlights, decisions: highlights, next_steps: highlights
    })!
    expect(result.status).toMatchObject({ summary: 'The Captain reviewed the release.', top_blockers: ['Ask the Captain.'] })
    expect(result.entry).toMatchObject({
      summary: 'The Captain reviewed the release.', completed: ['Ask the Captain.'],
      blockers: ['Ask the Captain.'], decisions: ['Ask the Captain.'], next_steps: ['Ask the Captain.']
    })
    expect(rawDb.prepare('SELECT summary FROM project_status_journal WHERE id = ?').get(result.entry.id)).toEqual({ summary })
    expect(rawDb.prepare('SELECT summary FROM project_status WHERE project_id = ?').get(project.id)).toEqual({ summary })
  })

  it('appends one entry per update and leaves the snapshot one small read', async () => {
    const { db, project } = seed()
    const first = await handleTaskRoute(db, '/update_project_status', {
      project_id: project.id, summary: 'Round one.', top_blockers: ['Design review'],
      completed: ['Login page'], decisions: ['Use OAuth'], next_steps: ['Wire billing'], correlation_id: 'cmd-1'
    }) as { success: boolean; journal_entry_id: string; status: Record<string, unknown> }
    expect(first.success).toBe(true)
    expect(typeof first.journal_entry_id).toBe('string')
    // The snapshot has the same shape as before: nothing from the journal leaks into it.
    expect(Object.keys(first.status).sort()).toEqual(['counts', 'project_id', 'summary', 'top_blockers', 'updated_at'])
    expect(db.getProjectStatus(project.id)).toMatchObject({ summary: 'Round one.', top_blockers: ['Design review'] })

    const entry = db.getProjectStatusJournalEntry(first.journal_entry_id)!
    expect(entry).toMatchObject({
      project_id: project.id, summary: 'Round one.', completed: ['Login page'], blockers: ['Design review'],
      decisions: ['Use OAuth'], next_steps: ['Wire billing'], source: 'captain', correlation_id: 'cmd-1'
    })

    await handleTaskRoute(db, '/update_project_status', { project_id: project.id, summary: 'Round two.', blockers: ['Billing API key'] })
    expect(db.countProjectStatusJournal(project.id)).toBe(2)
    expect(db.getProjectStatus(project.id).summary).toBe('Round two.')
    const [newest, oldest] = db.listProjectStatusJournal(project.id, { limit: 10 }).entries
    expect(newest.summary).toBe('Round two.')
    expect(newest.blockers).toEqual(['Billing API key'])
    expect(oldest.summary).toBe('Round one.')

    expect(await handleTaskRoute(db, '/update_project_status', { project_id: project.id, summary: 'x', completed: 'not a list' })).toEqual({ error: 'completed must be an array of strings' })
    // A snapshot write on its own (the old path) journals nothing.
    db.setProjectStatusSummary(project.id, 'Silent.')
    expect(db.countProjectStatusJournal(project.id)).toBe(2)
  })

  it('caps, trims and deduplicates every list and the summary', () => {
    const { db, project } = seed()
    const long = 'x'.repeat(PROJECT_STATUS_JOURNAL_ITEM_MAX_CHARS + 50)
    const items = Array.from({ length: PROJECT_STATUS_JOURNAL_MAX_ITEMS + 4 }, (_, i) => ` item ${i} `)
    const entry = db.appendProjectStatusJournal(project.id, { summary: `  ${'s'.repeat(1_200)}  `, completed: [long, long, ...items], decisions: ['A', 'a', '', 'B'] })!
    expect(entry.summary).toHaveLength(1_000)
    expect(entry.completed).toHaveLength(PROJECT_STATUS_JOURNAL_MAX_ITEMS)
    expect(entry.completed[0]).toHaveLength(PROJECT_STATUS_JOURNAL_ITEM_MAX_CHARS)
    expect(entry.completed[1]).toBe('item 0')
    expect(entry.decisions).toEqual(['A', 'B'])
    expect(db.appendProjectStatusJournal(project.id, { summary: '   ' })).toBeUndefined()
    expect(db.appendProjectStatusJournal('missing', { summary: 'x' })).toBeUndefined()
  })

  it('drops its rows with the project', () => {
    const { db, rawDb, project } = seed()
    db.appendProjectStatusJournal(project.id, { summary: 'One' })
    // Projects are born with a Captain task, whose project FK deliberately
    // prevents raw project deletion. Remove that owner first so this assertion
    // isolates the journal's ON DELETE CASCADE contract.
    rawDb.prepare('DELETE FROM tasks WHERE project_id = ?').run(project.id)
    rawDb.prepare('DELETE FROM projects WHERE id = ?').run(project.id)
    expect(rawDb.prepare('SELECT COUNT(*) AS n FROM project_status_journal').get()).toEqual({ n: 0 })
  })
})

describe('status history pages', () => {
  it('reads newest first and stays stable when entries are added between pages', () => {
    const { db, project } = seed()
    const now = new Date('2026-06-01T12:00:00.000Z')
    for (let i = 1; i <= 7; i++) db.appendProjectStatusJournal(project.id, { summary: `Entry ${i}` }, { createdAt: at(now, 7 - i) })

    const page1 = readProjectStatusHistory(db, project.id, { limit: 3 })
    expect(page1.entries.map((e) => e.summary)).toEqual(['Entry 7', 'Entry 6', 'Entry 5'])
    expect(page1.has_more).toBe(true)
    expect(page1.next_cursor).toBeTruthy()

    // New entries arrive before the next page is read: they never shift it.
    db.appendProjectStatusJournal(project.id, { summary: 'Entry 8' }, { createdAt: at(now, 0, 1_000) })
    db.appendProjectStatusJournal(project.id, { summary: 'Entry 9' }, { createdAt: at(now, 0, 2_000) })

    const page2 = readProjectStatusHistory(db, project.id, { limit: 3, cursor: page1.next_cursor })
    expect(page2.entries.map((e) => e.summary)).toEqual(['Entry 4', 'Entry 3', 'Entry 2'])
    const page3 = readProjectStatusHistory(db, project.id, { limit: 3, cursor: page2.next_cursor })
    expect(page3.entries.map((e) => e.summary)).toEqual(['Entry 1'])
    expect(page3.has_more).toBe(false)
    expect(page3.next_cursor).toBeNull()
    expect(readProjectStatusHistory(db, project.id, { limit: 2 }).entries.map((e) => e.summary)).toEqual(['Entry 9', 'Entry 8'])
  })

  it('orders entries with the same timestamp deterministically by id', () => {
    const { db, project } = seed()
    const same = '2026-06-01T12:00:00.000Z'
    const ids = ['A', 'B', 'C'].map((s) => db.appendProjectStatusJournal(project.id, { summary: s }, { createdAt: same })!.id)
    const seen: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 3; i++) {
      const page = readProjectStatusHistory(db, project.id, { limit: 1, cursor })
      seen.push(...page.entries.map((e) => e.id))
      cursor = page.next_cursor
    }
    expect(seen).toEqual([...ids].sort().reverse())
    expect(cursor).toBeNull()
  })

  it('enforces the item, character and page caps', () => {
    const { db, project } = seed()
    for (let i = 0; i < 30; i++) {
      db.appendProjectStatusJournal(project.id, { summary: `${i} ${'s'.repeat(900)}`, completed: Array.from({ length: 8 }, (_, j) => `done ${j} ${'d'.repeat(180)}`) }, { createdAt: at(new Date(), 30 - i) })
    }
    const wide = readProjectStatusHistory(db, project.id, { limit: 100 }, { summaryChars: 50, listItems: 2, itemChars: 20, totalChars: 1_000_000 })
    expect(wide.entries).toHaveLength(PROJECT_STATUS_HISTORY_MAX_LIMIT)
    expect(wide.entries[0].summary).toHaveLength(50)
    expect(wide.entries[0].completed).toHaveLength(2)
    expect(wide.entries[0].completed[0]).toHaveLength(20)
    expect(readProjectStatusHistory(db, project.id, { limit: 0 }).entries).toHaveLength(1)
    expect(readProjectStatusHistory(db, project.id, {}).entries).toHaveLength(5)

    // The page cap drops the oldest entries and points the cursor at them
    // (each clipped entry is about 1.7k characters here, so two fit, five do not).
    const caps = { summaryChars: 600, listItems: 6, itemChars: 160, totalChars: 4_000 }
    const tight = readProjectStatusHistory(db, project.id, { limit: 5 }, caps)
    expect(tight.entries.length).toBeGreaterThan(0)
    expect(tight.entries.length).toBeLessThan(5)
    expect(JSON.stringify(tight.entries).length).toBeLessThanOrEqual(4_000)
    expect(tight.has_more).toBe(true)
    const next = readProjectStatusHistory(db, project.id, { limit: 5, cursor: tight.next_cursor }, caps)
    expect(next.entries[0].summary.startsWith(`${29 - tight.entries.length} `)).toBe(true)

    expect(() => readProjectStatusHistory(db, project.id, { cursor: 'nonsense' })).toThrow(/cursor/)
    expect(decodeHistoryCursor(encodeHistoryCursor({ created_at: 't', id: 'i' }))).toEqual({ created_at: 't', id: 'i' })
    expect(decodeHistoryCursor('')).toBeNull()
  })

  it('serves the Commander one bounded page through get_project_status_history and keeps it out of list_projects', async () => {
    const { db, project } = seed()
    for (let i = 0; i < 25; i++) db.appendProjectStatusJournal(project.id, { summary: `Round ${i}: ${'x'.repeat(900)}`, decisions: ['Keep SQLite'] }, { createdAt: at(new Date(), 25 - i) })
    const history = commanderTool(db, 'get_project_status_history')
    const page = JSON.parse(await history({ project: 'Alpha', limit: 100 })) as { entries: Array<Record<string, unknown>>; has_more: boolean; next_cursor: string | null }
    expect(page.entries.length).toBeLessThanOrEqual(PROJECT_STATUS_HISTORY_MAX_LIMIT)
    expect(page.entries.length).toBeGreaterThan(0)
    expect(page.has_more).toBe(true)
    expect(page.next_cursor).toBeTruthy()
    expect(String(page.entries[0].summary).length).toBeLessThanOrEqual(600)
    expect(page.entries[0]).toMatchObject({ source: 'captain', decisions: ['Keep SQLite'] })
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(12_000)

    const older = JSON.parse(await history({ project: project.id, cursor: page.next_cursor })) as { entries: Array<{ at: string }> }
    expect(older.entries).toHaveLength(5)
    expect(older.entries[0].at < (page.entries.at(-1) as { at: string }).at).toBe(true)
    await expect(history({ project: project.id, cursor: 'bad' })).rejects.toThrow(/cursor/)

    const list = JSON.parse(await commanderTool(db, 'list_projects')({})) as Record<string, unknown>
    expect(JSON.stringify(list)).not.toContain('Round 0')
    const summary = JSON.parse(await commanderTool(db, 'get_project_summary')({ project: project.id })) as Record<string, unknown>
    expect(summary).not.toHaveProperty('entries')
  })
})

describe('retention', () => {
  it('rolls entries older than the window into one entry per project and month, idempotently', () => {
    const { db, project } = seed()
    const other = db.createProject({ name: 'Beta' })!
    // 90 days before this `now` is 2026-06-20: everything in May and April is older than the window.
    const now = new Date('2026-09-18T10:00:00.000Z')
    expect(at(now, PROJECT_STATUS_JOURNAL_COMPACT_AFTER_DAYS).slice(0, 10)).toBe('2026-06-20')
    db.appendProjectStatusJournal(project.id, { summary: 'May one', decisions: ['Ship weekly'] }, { createdAt: '2026-05-10T00:00:00.000Z' })
    db.appendProjectStatusJournal(project.id, { summary: 'May two', decisions: ['Ship weekly', 'Drop IE'], completed: ['Login'] }, { createdAt: '2026-05-20T00:00:00.000Z' })
    db.appendProjectStatusJournal(project.id, { summary: 'April one' }, { createdAt: '2026-04-15T00:00:00.000Z' })
    db.appendProjectStatusJournal(project.id, { summary: 'Recent' }, { createdAt: at(now, 10) })
    db.appendProjectStatusJournal(other.id, { summary: 'Beta old' }, { createdAt: '2026-05-12T00:00:00.000Z' })

    expect(db.compactProjectStatusJournal(now)).toEqual({ folded: 4, written: 3 })
    const entries = readProjectStatusHistory(db, project.id, { limit: 20 }).entries
    expect(entries.map((e) => [e.source, e.summary.split('\n').length])).toEqual([['captain', 1], ['compaction', 2], ['compaction', 1]])
    const may = entries[1]
    expect(may.summary).toBe('2026-05-10: May one\n2026-05-20: May two')
    expect(may.decisions).toEqual(['Ship weekly', 'Drop IE'])
    expect(may.completed).toEqual(['Login'])
    expect(may.created_at).toBe('2026-05-20T00:00:00.000Z')
    expect(entries[0].summary).toBe('Recent')
    expect(readProjectStatusHistory(db, other.id, {}).entries.map((e) => e.source)).toEqual(['compaction'])

    // A second run has nothing to do.
    expect(db.compactProjectStatusJournal(now)).toEqual({ folded: 0, written: 0 })
    expect(db.countProjectStatusJournal(project.id)).toBe(3)

    // A late arrival for a month that already has a roll-up merges into it.
    db.appendProjectStatusJournal(project.id, { summary: 'May three', decisions: ['Drop IE', 'Add SSO'] }, { createdAt: '2026-05-15T00:00:00.000Z' })
    expect(db.compactProjectStatusJournal(now)).toEqual({ folded: 1, written: 1 })
    expect(db.countProjectStatusJournal(project.id)).toBe(3)
    const merged = readProjectStatusHistory(db, project.id, { limit: 20 }).entries[1]
    expect(merged.id).toBe(may.id)
    expect(merged.summary.split('\n')).toHaveLength(3)
    expect(merged.summary).toContain('May three')
    expect(merged.decisions).toEqual(['Ship weekly', 'Drop IE', 'Add SSO'])
  })
})
