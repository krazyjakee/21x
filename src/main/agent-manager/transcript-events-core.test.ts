import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import { notifyStatusTransition } from './transcript-events-core'
import type { AgentNotifications, AgentWindow } from './host'
import { SessionStatus, TaskStatus } from '../../shared/constants'
import { HOST_OPERATION_SCHEMAS } from '../../shared/host-services'
import { rmSync } from 'node:fs'
import { dirname } from 'node:path'

type NotificationShow = Extract<AgentNotifications, { kind: 'native' }>['show']
let db: ReturnType<typeof createPortableTestDb>, root: string, show: ReturnType<typeof vi.fn<NotificationShow>>, notifications: AgentNotifications
beforeEach(() => {
  db = createPortableTestDb(); root = dirname(dirname(db.getWorkspaceDir('notification-fixture')))
  show = vi.fn<NotificationShow>(); notifications = { kind: 'native', isSupported: () => true, show }
})
afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(root, { recursive: true, force: true }) })
function status(taskId: string | undefined, next: string = SessionStatus.IDLE) { notifyStatusTransition(db, () => null, SessionStatus.WORKING, next, taskId, notifications) }

describe('bounded actual task status notification projection', () => {
  it('preserves exact short human wording and generic fallback without full task or credential getters', () => {
    const task = db.createTask({ title: 'Review 🌱 output' })!, getter = vi.spyOn(db, 'getTask').mockImplementation(() => { throw new Error('Full task read forbidden') })
    status(task.id); status(task.id, SessionStatus.WAITING_APPROVAL); status('missing-task'); status(undefined, SessionStatus.WAITING_APPROVAL)
    expect(show.mock.calls.map(([value]) => ({ title: value.title, body: value.body }))).toEqual([
      { title: 'Agent finished', body: '"Review 🌱 output" is ready for review' },
      { title: 'Agent needs approval', body: '"Review 🌱 output" is waiting for your approval' },
      { title: 'Agent finished', body: 'A task is ready for review' },
      { title: 'Agent needs approval', body: 'An agent is waiting for your approval' }
    ]); expect(getter).not.toHaveBeenCalled()
  })
  it('preserves leading/trailing whitespace in an otherwise valid short title exactly', () => {
    const task = db.createTask({ title: 'Initial' })!
    db.db.prepare('UPDATE tasks SET title=? WHERE id=?').run('  Human task  ', task.id)
    status(task.id)
    expect(show.mock.calls[0]![0].body).toBe('"  Human task  " is ready for review')
  })
  it('bounds huge stored title and unrelated JSON before materialization while preserving every stored byte', () => {
    const task = db.createTask({ title: 'Initial' })!, title = '🌱'.repeat(20000), privateField = 'private retained field'.repeat(20000)
    db.db.prepare('UPDATE tasks SET title=?,feedback_comment=?,repos=? WHERE id=?').run(title, privateField, 'invalid private JSON'.repeat(20000), task.id)
    const parse = vi.spyOn(JSON, 'parse'), getter = vi.spyOn(db, 'getTask').mockImplementation(() => { throw new Error('Full getter forbidden') })
    status(task.id); const event = show.mock.calls[0]![0]
    expect(event.body).toBe('"' + '🌱'.repeat(400) + '…" is ready for review'); expect(Buffer.byteLength(event.body)).toBeLessThanOrEqual(2048)
    expect(HOST_OPERATION_SCHEMAS['host.notification.status'].validateRequest({ title: event.title, body: event.body })).toBe(true); expect(parse).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled()
    expect(db.db.prepare('SELECT length(CAST(title AS BLOB)) AS bytes FROM tasks WHERE id=?').get(task.id)).toMatchObject({ bytes: Buffer.byteLength(title) })
  })
  it('normalizes controls and malformed stored UTF8 without exporting a malformed native string', () => {
    const task = db.createTask({ title: 'Initial' })!
    for (const title of ['Human\0task\n\tname', 'Only control: \u007f\u0085', Buffer.from([0x48, 0x69, 0xff, 0x20, 0x61])]) {
      if (typeof title === 'string') db.db.prepare('UPDATE tasks SET title=? WHERE id=?').run(title, task.id)
      else db.db.prepare('UPDATE tasks SET title=CAST(? AS TEXT) WHERE id=?').run(title, task.id)
      status(task.id); const value = show.mock.calls.at(-1)![0]
      expect(HOST_OPERATION_SCHEMAS['host.notification.status'].validateRequest({ title: value.title, body: value.body })).toBe(true)
      expect(value.body).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    }
  })
  it('suppresses completed parents using only their scalar status, while incomplete and missing parents stay useful', () => {
    const parent = db.createTask({ title: 'Parent' })!, child = db.createTask({ title: 'Child', parent_task_id: parent.id })!
    db.db.prepare('UPDATE tasks SET status=?,repos=? WHERE id=?').run(TaskStatus.Completed, 'private invalid JSON'.repeat(10000), parent.id)
    const getter = vi.spyOn(db, 'getTask').mockImplementation(() => { throw new Error('Whole parent forbidden') })
    status(child.id); expect(show).not.toHaveBeenCalled()
    db.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(TaskStatus.NotStarted, parent.id); status(child.id); expect(show).toHaveBeenCalledTimes(1)
    db.db.prepare('PRAGMA foreign_keys=OFF').run(); db.db.prepare('UPDATE tasks SET parent_task_id=? WHERE id=?').run('missing-parent', child.id); db.db.prepare('PRAGMA foreign_keys=ON').run()
    status(child.id, SessionStatus.WAITING_APPROVAL); expect(show).toHaveBeenCalledTimes(2); expect(getter).not.toHaveBeenCalled()
  })
  it('avoids DB reads for unsupported host, focused window and non-notifiable transitions; legacy click resolves the current window', () => {
    const task = db.createTask({ title: 'Human title' })!, prepare = vi.spyOn(db.db, 'prepare'), win: AgentWindow = { isDestroyed: () => false, isFocused: () => true, show: vi.fn(), focus: vi.fn(), webContents: { send: vi.fn() } }
    notifyStatusTransition(db, () => win, SessionStatus.WORKING, SessionStatus.IDLE, task.id, notifications)
    notifyStatusTransition(db, () => null, SessionStatus.IDLE, SessionStatus.IDLE, task.id, notifications)
    notifyStatusTransition(db, () => null, SessionStatus.WORKING, SessionStatus.IDLE, task.id, { kind: 'unsupported' })
    expect(prepare).not.toHaveBeenCalled(); expect(show).not.toHaveBeenCalled()
    let current: AgentWindow | null = null; notifyStatusTransition(db, () => current, SessionStatus.WORKING, SessionStatus.IDLE, task.id, notifications)
    current = win; show.mock.calls[0]![0].onClick(); expect(win.show).toHaveBeenCalledTimes(1); expect(win.focus).toHaveBeenCalledTimes(1)
  })
  it('reports optional native refusal with fixed diagnostics and no task/private error reflection', () => {
    const task = db.createTask({ title: 'Human title' })!, diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    show.mockImplementation(() => { throw new Error('private provider token') }); status(task.id)
    expect(diagnostic).toHaveBeenCalledWith('[AgentManager] Failed to show OS notification'); expect(diagnostic.mock.calls.flat().join(' ')).not.toContain('private provider token')
  })
})
