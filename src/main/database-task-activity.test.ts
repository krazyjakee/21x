import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import type { DatabaseManager, UpdateTaskData } from './database'
import { applySchema } from './database/schema'
import { migrateTaskActivity } from './database/task-activity-migration'

let db: DatabaseManager
const start = '2026-01-01T00:00:00.000Z'
const later = '2026-01-02T00:00:00.000Z'
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(start)
  ;({ db } = createTestDb())
})
afterEach(() => { db.close(); vi.useRealTimers() })

const changes: [string, UpdateTaskData][] = [
  ['status', { status: 'agent_working' }],
  ['title', { title: 'Edited' }],
  ['description', { description: 'Edited' }],
  ['priority', { priority: 'high' }],
  ['output result', { resolution: 'PR: https://example.org/pull/1' }],
  ['comment', { feedback_comment: 'Please adjust the spacing' }],
  ['attachment', { attachments: [{ id: 'file', filename: 'screenshot.png', mime_type: 'image/png', size: 1, added_at: later }] }]
]

describe('meaningful task activity', () => {
  it.each(changes)('bumps for %s, once, and not for an identical write', (_, change) => {
    const task = db.createTask({ title: 'Task' })!
    expect(task.last_activity_at).toBe(start)
    vi.setSystemTime(later)
    expect(db.updateTask(task.id, change)?.last_activity_at).toBe(later)
    vi.setSystemTime('2026-01-03T00:00:00.000Z')
    expect(db.updateTask(task.id, change)?.last_activity_at).toBe(later)
  })

  it('ignores heartbeat, session, tracking labels and output-field housekeeping and reads', () => {
    const task = db.createTask({ title: 'Task' })!
    vi.setSystemTime(later)
    const updated = db.updateTask(task.id, {
      session_id: 'session', labels: ['tracked', 'issue:142'],
      output_fields: [{ id: 'pr_url', name: 'PR', type: 'url', value: 'https://example.org/pull/1' }],
      heartbeat_enabled: true, heartbeat_last_check_at: later, heartbeat_next_check_at: later,
      heartbeat_interval_minutes: 60, snoozed_until: later
    })!
    expect(updated.updated_at).toBe(later)
    expect(updated.last_activity_at).toBe(start)
    expect(db.getTasks()[0].last_activity_at).toBe(start)
    expect(db.getTask(task.id)?.last_activity_at).toBe(start)
  })

  it('excludes sync and system resets but counts an explicit source action', () => {
    const task = db.createTask({ title: 'Task', status: 'agent_working' })!
    vi.setSystemTime(later)
    expect(db.updateTask(task.id, { status: 'not_started' }, 'system')?.last_activity_at).toBe(start)
    expect(db.updateTask(task.id, { title: 'Remote title', status: 'completed' }, 'task-source')?.last_activity_at).toBe(start)
    expect(db.updateTask(task.id, { status: 'not_started' }, 'task-source-action')?.last_activity_at).toBe(later)
  })

  it.each([
    { id: 'user', role: 'user', content: 'New comment' },
    { id: 'assistant', role: 'assistant', content: 'Progress on the work' },
    { id: 'tool', role: 'assistant', tool: { name: 'gh', output: 'Created PR' } },
    { id: 'progress', role: 'system', partType: 'task_progress', payload: { status: 'running' } }
  ])('counts new live $id content and streaming changes, not polling or history', (part) => {
    const task = db.createTask({ title: 'Task' })!
    vi.setSystemTime(later)
    db.upsertTranscriptParts(task.id, [part], 'live')
    expect(db.getTask(task.id)?.last_activity_at).toBe(later)
    const next = '2026-01-03T00:00:00.000Z'
    vi.setSystemTime(next)
    db.upsertTranscriptParts(task.id, [part], 'live')
    db.upsertTranscriptParts(task.id, [{ id: 'old', role: 'assistant', content: 'Historical output' }])
    db.upsertTranscriptParts(task.id, [{ id: 'status', role: 'system', content: 'Session connected' }], 'live')
    expect(db.getTask(task.id)?.last_activity_at).toBe(later)
    db.upsertTranscriptParts(task.id, [{ ...part, content: 'More progress' }], 'live')
    expect(db.getTask(task.id)?.last_activity_at).toBe(next)
  })

  it('carries existing child activity into a new parent without changing the child timestamp', () => {
    const parent = db.createTask({ title: 'Parent' })!
    const child = db.createTask({ title: 'Child' })!
    vi.setSystemTime(later)
    db.updateTask(child.id, { title: 'Active child' })
    vi.setSystemTime('2026-01-03T00:00:00.000Z')
    db.updateTask(child.id, { parent_task_id: parent.id })
    expect(db.getTask(parent.id)?.last_activity_at).toBe(later)
    expect(db.getTask(child.id)?.last_activity_at).toBe(later)
  })

  it('rolls activity up through ancestors, broadcasts each changed row, and preserves subtask ranks', () => {
    const parent = db.createTask({ title: 'Parent' })!
    const first = db.createTask({ title: 'First', parent_task_id: parent.id })!
    const second = db.createTask({ title: 'Second', parent_task_id: parent.id })!
    const leaf = db.createTask({ title: 'Leaf', parent_task_id: first.id })!
    db.reorderSubtasks(parent.id, [second.id, first.id])
    const notify = vi.fn()
    db.onTaskActivity = notify
    vi.setSystemTime(later)
    db.upsertTranscriptParts(leaf.id, [{ id: 'message', role: 'assistant', content: 'Working' }], 'live')
    for (const id of [leaf.id, first.id, parent.id]) {
      expect(db.getTask(id)?.last_activity_at).toBe(later)
      expect(notify).toHaveBeenCalledWith(id, later)
    }
    expect(db.getTask(second.id)?.last_activity_at).toBe(start)
    expect(db.getSubtasks(parent.id).map((t) => t.id)).toEqual([second.id, first.id])
    db.recordTaskActivity(leaf.id, start)
    expect(db.getTask(parent.id)?.last_activity_at).toBe(later)
  })
})

describe('activity migration 25', () => {
  it('upgrades version 24, backfills creation and transcript time, rolls up children, and is idempotent', () => {
    const parent = db.createTask({ title: 'Parent' })!
    const child = db.createTask({ title: 'Child', parent_task_id: parent.id })!
    const quiet = db.createTask({ title: 'Quiet' })!
    db.upsertTranscriptParts(child.id, [{ id: 'message', role: 'assistant', content: 'Old message', receivedAt: Date.parse(later) }])
    db.db.exec('DROP TRIGGER tasks_initial_activity; ALTER TABLE tasks DROP COLUMN last_activity_at')
    db.db.prepare('UPDATE tasks SET updated_at = ?').run('2099-01-01T00:00:00.000Z')
    db.setSetting('__schema_version', '24')
    expect(applySchema(db.db)).toBe(true)
    expect(db.getSetting('__schema_version')).toBe('28')
    expect(db.getTask(parent.id)?.last_activity_at).toBe(later)
    expect(db.getTask(child.id)?.last_activity_at).toBe(later)
    expect(db.getTask(quiet.id)?.last_activity_at).toBe(start)
    migrateTaskActivity(db.db)
    expect(applySchema(db.db)).toBe(false)
    expect(db.getTask(quiet.id)?.last_activity_at).toBe(start)
    expect(db.createTask({ title: 'New' })?.last_activity_at).toBe(start)
  })
})
