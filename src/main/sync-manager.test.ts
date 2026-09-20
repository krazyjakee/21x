import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { SyncManager } from './sync-manager'
import { PluginActionId, TaskStatus } from '../shared/constants'
import type { DatabaseManager, TaskRecord } from './database'
import type { PluginRegistry } from './plugins/registry'
import type { TaskSourcePlugin } from './plugins/types'

function makeMockDb(): DatabaseManager {
  return {
    getTaskSource: vi.fn(),
    getMcpServer: vi.fn(),
    getTask: vi.fn(),
    updateTask: vi.fn()
  } as unknown as DatabaseManager
}

function makeMockPlugin(overrides: Partial<TaskSourcePlugin> = {}): TaskSourcePlugin {
  return {
    id: 'test',
    displayName: 'Test',
    description: 'Test plugin',
    icon: 'Zap',
    getConfigSchema: () => [],
    resolveOptions: async () => [],
    getActions: () => [],
    importTasks: vi.fn().mockResolvedValue({ imported: 5, updated: 2, errors: [] }),
    exportUpdate: vi.fn().mockResolvedValue(undefined),
    executeAction: vi.fn().mockResolvedValue({ success: true, taskUpdate: { status: TaskStatus.Completed } }),
    ...overrides
  }
}

describe('SyncManager', () => {
  let db: ReturnType<typeof makeMockDb>
  let registry: PluginRegistry
  let syncManager: SyncManager

  beforeEach(() => {
    db = makeMockDb()
    registry = { get: vi.fn() } as unknown as PluginRegistry
    syncManager = new SyncManager(db, registry)
  })

  describe('importTasks', () => {
    it('imports tasks through the source plugin', async () => {
      const plugin = makeMockPlugin({ id: 'linear' })
      vi.mocked(db.getTaskSource).mockReturnValue({
        id: 'src-1', plugin_id: 'linear', config: {}
      } as ReturnType<DatabaseManager['getTaskSource']>)
      vi.mocked(registry.get).mockReturnValue(plugin)
      const result = await syncManager.importTasks('src-1')
      expect(plugin.importTasks).toHaveBeenCalledOnce()
      expect(result.imported).toBe(5)
    })

    it('returns error when source not found', async () => {
      ;(db.getTaskSource as unknown as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
      const result = await syncManager.importTasks('src-1')
      expect(result.errors).toContain('Task source not found')
    })

    it('returns error when plugin not found', async () => {
      ;(db.getTaskSource as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'src-1',
        plugin_id: 'missing',
        mcp_server_id: 'srv-1',
        config: {}
      })
      ;(registry.get as unknown as ReturnType<typeof vi.fn>).mockReturnValue(undefined)

      const result = await syncManager.importTasks('src-1')
      expect(result.errors).toContain('Plugin "missing" not found')
    })

    it('delegates to plugin.importTasks', async () => {
      const plugin = makeMockPlugin()
      ;(db.getTaskSource as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'src-1',
        plugin_id: 'test',
        mcp_server_id: 'srv-1',
        config: { status_filter: 'pending' }
      })
      ;(registry.get as unknown as ReturnType<typeof vi.fn>).mockReturnValue(plugin)
      ;(db.getMcpServer as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'srv-1' })

      const result = await syncManager.importTasks('src-1')
      expect(result.imported).toBe(5)
      expect(result.updated).toBe(2)
      expect(plugin.importTasks).toHaveBeenCalledWith(
        'src-1',
        { status_filter: 'pending' },
        expect.objectContaining({ db })
      )
    })

    it('catches plugin errors', async () => {
      const plugin = makeMockPlugin({
        importTasks: vi.fn().mockRejectedValue(new Error('Network error'))
      })
      ;(db.getTaskSource as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'src-1', plugin_id: 'test', mcp_server_id: 'srv-1', config: {}
      })
      ;(registry.get as unknown as ReturnType<typeof vi.fn>).mockReturnValue(plugin)

      const result = await syncManager.importTasks('src-1')
      expect(result.errors).toContain('Network error')
    })
  })

  describe('exportTaskUpdate', () => {
    it('does nothing when task has no source_id', async () => {
      ;(db.getTask as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ id: 't1', source_id: null })
      await syncManager.exportTaskUpdate('t1', { title: 'New' })
      expect(registry.get).not.toHaveBeenCalled()
    })

    it('does nothing when task has no external_id', async () => {
      ;(db.getTask as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ id: 't1', source_id: 'src-1', external_id: null })
      await syncManager.exportTaskUpdate('t1', { title: 'New' })
      expect(registry.get).not.toHaveBeenCalled()
    })

    it('calls plugin.exportUpdate when task has source', async () => {
      const plugin = makeMockPlugin()
      ;(db.getTask as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ id: 't1', source_id: 'src-1', external_id: 'ext-1' })
      ;(db.getTaskSource as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'src-1', plugin_id: 'test', mcp_server_id: 'srv-1', config: {}
      })
      ;(registry.get as unknown as ReturnType<typeof vi.fn>).mockReturnValue(plugin)
      ;(db.getMcpServer as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'srv-1' })

      await syncManager.exportTaskUpdate('t1', { title: 'New' })
      expect(plugin.exportUpdate).toHaveBeenCalled()
    })

    it('does not push a status change when the user chose "I\'ll do it manually"', async () => {
      const plugin = makeMockPlugin()
      ;(db.getTask as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 't1', source_id: 'src-1', external_id: 'ext-1', complete_at_source: false
      })
      ;(db.getTaskSource as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'src-1', plugin_id: 'test', mcp_server_id: 'srv-1', config: {}
      })
      ;(registry.get as unknown as ReturnType<typeof vi.fn>).mockReturnValue(plugin)
      ;(db.getMcpServer as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'srv-1' })

      await syncManager.exportTaskUpdate('t1', { status: 'completed', complete_at_source: false })
      expect(plugin.exportUpdate).not.toHaveBeenCalled()
    })

    it('still syncs non-status edits when the user chose "I\'ll do it manually"', async () => {
      const plugin = makeMockPlugin()
      ;(db.getTask as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 't1', source_id: 'src-1', external_id: 'ext-1', complete_at_source: false
      })
      ;(db.getTaskSource as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'src-1', plugin_id: 'test', mcp_server_id: 'srv-1', config: {}
      })
      ;(registry.get as unknown as ReturnType<typeof vi.fn>).mockReturnValue(plugin)
      ;(db.getMcpServer as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'srv-1' })

      await syncManager.exportTaskUpdate('t1', { title: 'New', status: 'in_progress' })
      expect(plugin.exportUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ id: 't1' }),
        { title: 'New' },
        {},
        expect.anything()
      )
    })

    it('pushes a status change when the user chose to close it at the source', async () => {
      const plugin = makeMockPlugin()
      ;(db.getTask as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 't1', source_id: 'src-1', external_id: 'ext-1', complete_at_source: true
      })
      ;(db.getTaskSource as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'src-1', plugin_id: 'test', mcp_server_id: 'srv-1', config: {}
      })
      ;(registry.get as unknown as ReturnType<typeof vi.fn>).mockReturnValue(plugin)
      ;(db.getMcpServer as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'srv-1' })

      await syncManager.exportTaskUpdate('t1', { status: 'completed', complete_at_source: true })
      expect(plugin.exportUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ id: 't1' }),
        { status: 'completed' },
        {},
        expect.anything()
      )
    })
  })

  describe('executeAction', () => {
    it('returns error when source not found', async () => {
      ;(db.getTaskSource as unknown as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
      const task = { id: 't1' } as TaskRecord
      const result = await syncManager.executeAction('approve', task, undefined, 'src-1')
      expect(result.success).toBe(false)
      expect(result.error).toContain('Task source not found')
    })

    it('forwards "complete" action to the plugin', async () => {
      const plugin = makeMockPlugin()
      ;(db.getTaskSource as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'src-1', plugin_id: 'test', mcp_server_id: 'srv-1', config: {}
      })
      ;(registry.get as unknown as ReturnType<typeof vi.fn>).mockReturnValue(plugin)
      ;(db.getMcpServer as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'srv-1' })

      const task = { id: 't1' } as TaskRecord
      const result = await syncManager.executeAction('complete', task, undefined, 'src-1')

      expect(result.success).toBe(true)
      expect(plugin.executeAction).toHaveBeenCalledWith(
        'complete', task, undefined, {}, expect.objectContaining({ db })
      )
    })

    it('applies taskUpdate to local task on success', async () => {
      const plugin = makeMockPlugin()
      ;(db.getTaskSource as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'src-1', plugin_id: 'test', mcp_server_id: 'srv-1', config: {}
      })
      ;(registry.get as unknown as ReturnType<typeof vi.fn>).mockReturnValue(plugin)
      ;(db.getMcpServer as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'srv-1' })

      const task = { id: 't1' } as TaskRecord
      const result = await syncManager.executeAction('approve', task, undefined, 'src-1')

      expect(result.success).toBe(true)
      expect(db.updateTask).toHaveBeenCalledWith('t1', { status: TaskStatus.Completed }, 'task-source-action')
    })
  })
})

// Exercise the common action boundary with a real database, including ancestor
// activity. These are the four comment-capable source plugins' result shapes.
describe.each(['github-issues', 'linear', 'forgejo-issues', 'youtrack'])('%s comment activity', (pluginId) => {
  let db: DatabaseManager
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime('2026-01-01T00:00:00.000Z')
    ;({ db } = createTestDb())
  })
  afterEach(() => { db.close(); vi.useRealTimers() })

  it.each([
    { name: 'success without taskUpdate', action: PluginActionId.AddComment, result: { success: true }, active: true },
    { name: 'success with empty taskUpdate', action: PluginActionId.AddComment, result: { success: true, taskUpdate: {} }, active: true },
    { name: 'failed comment', action: PluginActionId.AddComment, result: { success: false }, active: false },
    { name: 'passive source action', action: 'open_url', result: { success: true }, active: false }
  ])('$name', async ({ action, result, active }) => {
    const parent = db.createTask({ title: 'Parent' })!
    const task = db.createTask({ title: 'Issue', parent_task_id: parent.id })!
    vi.spyOn(db, 'getTaskSource').mockReturnValue({ id: 'source', plugin_id: pluginId, config: {} } as ReturnType<DatabaseManager['getTaskSource']>)
    const plugin = makeMockPlugin({ id: pluginId, executeAction: vi.fn().mockResolvedValue(result) })
    const registry = { get: vi.fn(() => plugin) } as unknown as PluginRegistry
    const notify = vi.fn()
    db.onTaskActivity = notify
    vi.setSystemTime('2026-01-02T00:00:00.000Z')
    expect(await new SyncManager(db, registry).executeAction(action, task, 'Comment', 'source')).toEqual(result)
    for (const id of [task.id, parent.id]) {
      expect(db.getTask(id)?.last_activity_at).toBe(active ? '2026-01-02T00:00:00.000Z' : task.last_activity_at)
    }
    expect(notify).toHaveBeenCalledTimes(active ? 2 : 0)
  })
})
