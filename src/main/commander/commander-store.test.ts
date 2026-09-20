import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { CommanderStore } from './commander-store'

let store: CommanderStore
let clock: number

/** Project rows for the project tags these tests use (commander_messages.project_id references projects). */
function seedProjects(rawDb: ReturnType<typeof createTestDb>['rawDb'], ids: string[]): void {
  const insert = rawDb.prepare(
    "INSERT OR IGNORE INTO projects (id, name, description, settings, sort_order, archived, created_at, updated_at) VALUES (?, ?, '', '{}', 0, 0, ?, ?)"
  )
  for (const id of ids) insert.run(id, id, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
}

beforeEach(() => {
  const { db, rawDb } = createTestDb()
  seedProjects(rawDb, ['alpha', 'beta', 'p'])
  clock = 1_000
  store = new CommanderStore(db, { now: () => clock })
})

describe('CommanderStore sessions', () => {
  it('creates, renames, archives and lists sessions, most recent first', () => {
    const a = store.createSession()
    clock += 10
    const b = store.createSession('  Second   session ')
    expect(a.title).toBe('')
    expect(b.title).toBe('Second session')
    expect(store.listSessions().map((s) => s.id)).toEqual([b.id, a.id])

    clock += 10
    store.appendMessage(a.id, { role: 'user', content: 'hello' })
    expect(store.listSessions().map((s) => s.id)).toEqual([a.id, b.id])

    expect(store.renameSession(a.id, 'Renamed')?.title).toBe('Renamed')
    expect(store.setArchived(a.id, true)?.archived).toBe(true)
    expect(store.listSessions().map((s) => s.id)).toEqual([b.id])
    expect(store.listSessions({ includeArchived: true }).map((s) => s.id)).toContain(a.id)
    expect(store.setArchived(a.id, false)?.archived).toBe(false)
  })

  it('searches titles and message text, treating LIKE wildcards literally', () => {
    const a = store.createSession('Release planning')
    const b = store.createSession()
    store.appendMessage(b.id, { role: 'user', content: 'Ship the 100% build of the billing service' })
    store.createSession('Unrelated')

    expect(store.listSessions({ search: 'release' }).map((s) => s.id)).toEqual([a.id])
    expect(store.listSessions({ search: 'billing' }).map((s) => s.id)).toEqual([b.id])
    expect(store.listSessions({ search: '100%' }).map((s) => s.id)).toEqual([b.id])
    expect(store.listSessions({ search: '%' }).map((s) => s.id)).toEqual([b.id])
  })

  it('deleting a session cascades to its messages', () => {
    const s = store.createSession()
    store.appendMessage(s.id, { role: 'user', content: 'hi' })
    expect(store.deleteSession(s.id)).toBe(true)
    expect(store.listMessages(s.id)).toEqual([])
  })
})

describe('CommanderStore messages', () => {
  it('projects old reports and summaries as Captain while preserving stored evidence and routing', () => {
    const { db, rawDb } = createTestDb()
    const history = new CommanderStore(db)
    const session = history.createSession()
    const legacy = ['Master', 'mind'].join('')
    const content = `Open the Daccord ${legacy} chat.`
    for (const role of ['report', 'summary', 'assistant', 'user', 'tool'] as const) {
      const row = history.appendMessage(session.id, { role, content, correlationId: 'original-correlation' })
      expect(row.content).toBe(role === 'report' || role === 'summary' || role === 'assistant' ? 'Open the Daccord Captain chat.' : content)
      expect(row.correlation_id).toBe('original-correlation')
      expect(rawDb.prepare('SELECT content FROM commander_messages WHERE id = ?').get(row.id)).toEqual({ content })
      expect(history.listMessages(session.id).find((m) => m.id === row.id)).toEqual(row)
    }
  })

  it('appends and lists messages in order with tool calls and delegation fields', () => {
    const s = store.createSession()
    store.appendMessage(s.id, { role: 'user', content: 'ask alpha' })
    store.appendMessage(s.id, {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'ask_project', input: { project: 'alpha' } }]
    })
    store.appendMessage(s.id, { role: 'tool', content: 'queued', toolCallId: 'c1', toolName: 'ask_project', isError: false, projectId: 'alpha', correlationId: 'corr-1' })

    const messages = store.listMessages(s.id)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(messages[1].tool_calls).toEqual([{ id: 'c1', name: 'ask_project', input: { project: 'alpha' } }])
    expect(messages[2]).toMatchObject({ tool_call_id: 'c1', tool_name: 'ask_project', project_id: 'alpha', correlation_id: 'corr-1', is_error: false })
    // Same clock value: order still follows insertion.
    expect(messages[0].created_at).toBeLessThan(messages[1].created_at)
  })

  it('rejects unknown roles and missing sessions', () => {
    const s = store.createSession()
    expect(() => store.appendMessage(s.id, { role: 'system' as never, content: 'x' })).toThrow('Unknown Commander message role')
    expect(() => store.appendMessage('nope', { role: 'user', content: 'x' })).toThrow('not found')
  })
})

describe('CommanderStore unread', () => {
  it('counts only reports newer than last_read_at', () => {
    const s = store.createSession()
    store.appendMessage(s.id, { role: 'user', content: 'go' })
    store.appendMessage(s.id, { role: 'assistant', content: 'asked alpha' })
    expect(store.unreadCount(s.id)).toBe(0)

    store.appendMessage(s.id, { role: 'report', content: 'alpha done', projectId: 'alpha' })
    store.appendMessage(s.id, { role: 'report', content: 'beta done', projectId: 'beta' })
    expect(store.unreadCount(s.id)).toBe(2)
    expect(store.listSessions()[0].unread_count).toBe(2)

    store.markRead(s.id)
    expect(store.unreadCount(s.id)).toBe(0)

    // A report in the same millisecond as the read still counts: the clock never repeats.
    store.appendMessage(s.id, { role: 'report', content: 'late', projectId: 'alpha' })
    expect(store.unreadCount(s.id)).toBe(1)
  })

  it('unread counts survive a new store on the same database (restart)', () => {
    const { db, rawDb } = createTestDb()
    seedProjects(rawDb, ['alpha', 'beta', 'p'])
    const first = new CommanderStore(db)
    const s = first.createSession('Persisted')
    first.appendMessage(s.id, { role: 'report', content: 'r', projectId: 'p' })
    const second = new CommanderStore(db)
    expect(second.listSessions()[0]).toMatchObject({ id: s.id, title: 'Persisted', unread_count: 1 })
    expect(second.listMessages(s.id)).toHaveLength(1)
  })
})
