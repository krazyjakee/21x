import type { DatabaseManager, TaskRecord } from './database'
import type { PluginRegistry } from './plugins/registry'
import type { OAuthManager } from './oauth/oauth-manager'
import type { PluginContext, PluginSyncResult, ActionResult } from './plugins/types'
import type { SourceUser, ReassignResult } from '../shared/types'
import { emitTaskEvent } from './project-events'

export interface SyncResult {
  source_id: string
  imported: number
  updated: number
  errors: string[]
}

export class SyncManager {
  constructor(
    private db: DatabaseManager,
    private pluginRegistry: PluginRegistry,
    private oauthManager?: OAuthManager
  ) {}

  private buildContext(sourceId?: string): PluginContext {
    return { db: this.db, oauthManager: this.oauthManager, sourceId }
  }

  async importTasks(sourceId: string): Promise<SyncResult> {
    const result: SyncResult = { source_id: sourceId, imported: 0, updated: 0, errors: [] }

    const source = this.db.getTaskSource(sourceId)
    if (!source) {
      result.errors.push('Task source not found')
      console.error('[sync] Task source not found:', sourceId)
      return result
    }

    const plugin = this.pluginRegistry.get(source.plugin_id)
    if (!plugin) {
      result.errors.push(`Plugin "${source.plugin_id}" not found`)
      console.error('[sync] Plugin not found:', source.plugin_id)
      return result
    }

    const ctx = this.buildContext(sourceId)
    console.log('[sync] Importing from:', source.name)

    const config = this.getConfig(source)
    const startedAt = new Date().toISOString()

    try {
      const pluginResult: PluginSyncResult = await plugin.importTasks(sourceId, config, ctx)
      result.imported = pluginResult.imported
      result.updated = pluginResult.updated
      result.errors = pluginResult.errors
      console.log('[sync] Result:', { imported: result.imported, updated: result.updated, errors: result.errors })

      this.db.updateTaskSourceLastSynced(sourceId)
      console.log('[sync] Updated last_synced_at for source:', sourceId)

      // Project events (#57): each task this run created wakes the project's
      // Captain. Plugins do not report ids, so the rows are found by source
      // and creation time (both set by createTask, in the same clock).
      if (result.imported > 0) {
        for (const task of this.db.getTasks({ projectId: source.project_id })) {
          if (task.source_id !== sourceId || task.created_at < startedAt) continue
          emitTaskEvent(this.db, 'task_synced', task.id, undefined, { unassigned: !task.agent_id })
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Import failed'
      result.errors.push(msg)
      console.error('[sync] Import error:', err)
    }

    return result
  }

  async exportTaskUpdate(taskId: string, changedFields: Record<string, unknown>): Promise<void> {
    const task = this.db.getTask(taskId)
    if (!task?.source_id || !task.external_id) return

    const source = this.db.getTaskSource(task.source_id)
    if (!source) return

    const plugin = this.pluginRegistry.get(source.plugin_id)
    if (!plugin) return

    const fields = { ...changedFields }
    // Internal completion control — never a source field.
    delete fields.complete_at_source
    if (task.complete_at_source === false) delete fields.status
    if (Object.keys(fields).length === 0) return

    const ctx = this.buildContext(task.source_id || undefined)
    const config = this.getConfig(source)

    await plugin.exportUpdate(task, fields, config, ctx)
  }

  async executeAction(
    actionId: string,
    task: TaskRecord,
    input: string | undefined,
    sourceId: string
  ): Promise<ActionResult> {
    const source = this.db.getTaskSource(sourceId)
    if (!source) return { success: false, error: 'Task source not found' }

    const plugin = this.pluginRegistry.get(source.plugin_id)
    if (!plugin) return { success: false, error: `Plugin "${source.plugin_id}" not found` }

    const ctx = this.buildContext(sourceId)
    const config = this.getConfig(source)

    const result = await plugin.executeAction(actionId, task, input, config, ctx)

    if (result.success && result.taskUpdate && Object.keys(result.taskUpdate).length > 0) {
      this.db.updateTask(task.id, result.taskUpdate, 'task-source')
    }

    return result
  }

  async getSourceUsers(sourceId: string): Promise<SourceUser[]> {
    const source = this.db.getTaskSource(sourceId)
    if (!source) return []

    const plugin = this.pluginRegistry.get(source.plugin_id)
    if (!plugin?.getUsers) return []

    const ctx = this.buildContext(sourceId)
    const config = this.getConfig(source)
    return plugin.getUsers(config, ctx)
  }

  async reassignTask(
    taskId: string,
    userIds: string[],
    assigneeDisplay: string
  ): Promise<ReassignResult> {
    const task = this.db.getTask(taskId)
    if (!task?.source_id || !task.external_id) {
      return { success: false, error: 'Task not found or not linked to a source' }
    }

    const source = this.db.getTaskSource(task.source_id)
    if (!source) return { success: false, error: 'Task source not found' }

    const plugin = this.pluginRegistry.get(source.plugin_id)
    if (!plugin?.reassignTask) {
      return { success: false, error: 'Plugin does not support reassignment' }
    }

    const ctx = this.buildContext(task.source_id || undefined)
    const config = this.getConfig(source)

    const result = await plugin.reassignTask(task, userIds, config, ctx)
    if (result.success) {
      this.db.updateTask(taskId, { assignee: assigneeDisplay })
    }
    return result
  }

  private getConfig(source: { config: Record<string, unknown> }): Record<string, unknown> {
    return { ...source.config }
  }
}
