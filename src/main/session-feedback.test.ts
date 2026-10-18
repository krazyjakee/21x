import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPortableDbFixture as createTestDb } from '../../test/helpers/portable-db-test-helper'
import { makeTask } from '../../test/helpers/task-fixtures'
import type { DatabaseManager } from './database'
import { updateTaskFromUser, finishSessionFeedback, SessionFeedbackOwnershipChangedError } from './session-feedback'
import { SyncManager } from './sync-manager'
import { PluginRegistry } from './plugins/registry'
import type { TaskSourcePlugin, ActionResult } from './plugins/types'

describe('session feedback completion', () => {
  let db: DatabaseManager
  let taskId: string
  beforeEach(() => {
    db = createTestDb().db
    const agent = db.createAgent({name: 'Learning agent', server_url: '', config: {}, is_default: false})!
    const source = db.createTaskSource({name: 'dmitry ai tasks', plugin_id: 'linear', mcp_server_id: null})!
    taskId = db.createTask(makeTask({source_id: source.id, external_id: 'remote-1', source: 'Notion',
      status: 'ready_for_review', output_fields: [{id: 'action', name: 'Action', type: 'text', value: 'approve'}]}))!.id
    db.updateTask(taskId, {agent_id: agent.id})
  })
  afterEach(() => db.close())

  function source(executeAction: TaskSourcePlugin['executeAction']): SyncManager {
    const registry = new PluginRegistry()
    registry.register({ id: 'linear', displayName: 'Controlled feedback source', description: 'Disposable source fixture', icon: '',
      getConfigSchema: () => [], resolveOptions: async () => [], getActions: () => [], importTasks: async () => ({ imported: 0, updated: 0, errors: [] }), exportUpdate: async () => {}, executeAction })
    return new SyncManager(db, registry)
  }

  it.each([true, false])('starts learning and honors source choice %s after learning', async completeAtSource => {
    const executeAction = vi.fn().mockResolvedValue({success: true})
    updateTaskFromUser(db, taskId, {status: 'agent_learning', feedback_rating: 4, feedback_comment: 'Useful', complete_at_source: completeAtSource})
    expect(db.getTask(taskId)).toMatchObject({status: 'agent_learning', complete_at_source: completeAtSource})
    expect(executeAction).not.toHaveBeenCalled()
    db.updateTask(taskId, {status: 'ready_for_review'})
    expect(db.getTask(taskId)?.status).toBe('agent_learning')
    await finishSessionFeedback(db, {executeAction} as never, taskId)
    expect(db.getTask(taskId)?.status).toBe('completed')
    if (completeAtSource) expect(executeAction).toHaveBeenCalledWith('approve', expect.objectContaining({id: taskId}), undefined, expect.any(String))
    else expect(executeAction).not.toHaveBeenCalled()
    await finishSessionFeedback(db, {executeAction} as never, taskId)
    expect(executeAction).toHaveBeenCalledTimes(completeAtSource ? 1 : 0)
  })

  it('does not authorize completion without a user feedback request', async () => {
    const executeAction = vi.fn()
    db.updateTask(taskId, {status: 'agent_learning', feedback_rating: 4})
    await expect(finishSessionFeedback(db, {executeAction} as never, taskId)).resolves.toBeUndefined()
    expect(executeAction).not.toHaveBeenCalled()
    expect(db.getTask(taskId)?.status).toBe('agent_learning')
  })

  it('leaves the task open if the source action fails after learning', async () => {
    updateTaskFromUser(db, taskId, {status: 'agent_learning', feedback_rating: 4, complete_at_source: true})
    const executeAction = vi.fn().mockResolvedValue({success: false, error: 'Notion unavailable'})
    await expect(finishSessionFeedback(db, {executeAction} as never, taskId)).rejects.toThrow('Notion unavailable')
    expect(db.getTask(taskId)?.status).toBe('ready_for_review')
  })

  it('cancels pending completion if learning cannot start', async () => {
    updateTaskFromUser(db, taskId, {status: 'agent_learning', feedback_rating: 4, complete_at_source: true})
    updateTaskFromUser(db, taskId, {status: 'ready_for_review'})
    const executeAction = vi.fn()
    await finishSessionFeedback(db, {executeAction} as never, taskId)
    expect(executeAction).not.toHaveBeenCalled()
  })

  it.each(['success', 'failure'] as const)('preserves newer persisted task bytes after a withdrawn awaited source %s', async outcome => {
    updateTaskFromUser(db, taskId, { status: 'agent_learning', feedback_rating: 4, complete_at_source: true })
    const old = db.getTask(taskId)
    let enter!: () => void, release!: () => void, owned = true
    const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const execute = vi.fn<TaskSourcePlugin['executeAction']>(async (_action, actualTask): Promise<ActionResult> => {
      expect(actualTask).toEqual(old); enter(); await gate
      return outcome === 'success' ? { success: true, taskUpdate: { status: 'completed' } } : { success: false, error: 'Actual controlled source refusal' }
    })
    const sync = source(execute), completion = finishSessionFeedback(db, sync, taskId, () => { if (!owned) throw new Error('Actual generation withdrawn') })
    const refused = expect(completion).rejects.toBeInstanceOf(SessionFeedbackOwnershipChangedError)
    try {
      await entered
      db.db.prepare("UPDATE tasks SET status='not_started',session_id='replacement-native',title='Newer task bytes' WHERE id=?").run(taskId)
      db.setSetting(`session-feedback-completion:${taskId}`, JSON.stringify({ completeAtSource: false }))
      const newer = db.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)
      owned = false; release(); await refused
      expect(db.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)).toEqual(newer)
      expect(db.getSetting(`session-feedback-completion:${taskId}`)).toBe(JSON.stringify({ completeAtSource: false })); expect(execute).toHaveBeenCalledOnce()
    } finally { release(); await completion.catch(() => {}); await sync.close() }
  })

  it.each(['choice', 'project', 'source', 'session', 'status'] as const)('refuses a replaced %s even while the same native generation remains owned', async change => {
    updateTaskFromUser(db, taskId, { status: 'agent_learning', feedback_rating: 4, complete_at_source: true })
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const sync = source(async () => { enter(); await gate; return { success: false, error: 'Late source refusal' } })
    const completion = finishSessionFeedback(db, sync, taskId, () => {}), refused = expect(completion).rejects.toBeInstanceOf(SessionFeedbackOwnershipChangedError)
    try {
      await entered
      if (change === 'choice') db.setSetting(`session-feedback-completion:${taskId}`, JSON.stringify({ completeAtSource: false }))
      if (change === 'project') db.db.prepare('UPDATE tasks SET project_id=? WHERE id=?').run(db.createProject({ name: 'Newer project' })!.id, taskId)
      if (change === 'source') db.db.prepare('UPDATE tasks SET source_id=? WHERE id=?').run(db.createTaskSource({ name: 'Newer source', plugin_id: 'linear', mcp_server_id: null })!.id, taskId)
      if (change === 'session') db.db.prepare("UPDATE tasks SET session_id='replacement-native' WHERE id=?").run(taskId)
      if (change === 'status') db.db.prepare("UPDATE tasks SET status='not_started' WHERE id=?").run(taskId)
      const newer = db.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)
      release(); await refused
      expect(db.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)).toEqual(newer)
      expect(db.getSetting(`session-feedback-completion:${taskId}`)).toBe(change === 'choice' ? JSON.stringify({ completeAtSource: false }) : undefined)
    } finally { release(); await completion.catch(() => {}); await sync.close() }
  })

  it('preserves the actual acknowledged guarded source completion row without a second local overwrite', async () => {
    updateTaskFromUser(db, taskId, { status: 'agent_learning', feedback_rating: 4, complete_at_source: true })
    const sync = source(async () => ({ success: true, taskUpdate: { status: 'completed' } })), writes = vi.spyOn(db, 'updateTask')
    try {
      const completed = await finishSessionFeedback(db, sync, taskId, () => {})
      expect(completed?.status).toBe('completed'); expect(writes).toHaveBeenCalledTimes(1)
      expect(writes).toHaveBeenCalledWith(taskId, { status: 'completed' }, 'task-source-action')
    } finally { await sync.close(); writes.mockRestore() }
  })
})
