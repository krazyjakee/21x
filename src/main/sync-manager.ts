import type { DatabaseManager, TaskRecord } from './database'
import { PluginRegistry } from './plugins/registry'
import type { OAuthManager } from './oauth/oauth-manager'
import type { PluginContext, PluginSyncResult, ActionResult } from './plugins/types'
import type { SourceUser, ReassignResult } from '../shared/types'
import { PluginActionId } from '../shared/constants'
import { emitTaskEvent } from './project-events'

export interface SyncResult {
  source_id: string
  imported: number
  updated: number
  errors: string[]
}

export interface SourceLifecycleOwner {
  runSourceWork<T>(sourceId: string, work: () => Promise<T>): Promise<T>
}

export class SyncManager {
  private closing = false
  private readonly pendingWork = new Set<Promise<unknown>>()
  private readonly sourceTails = new Map<string, Promise<unknown>>()
  private readonly sourceMutations = new Set<string>()
  constructor(
    private db: DatabaseManager,
    private pluginRegistry: PluginRegistry,
    private oauthManager?: OAuthManager
  ) {
    const bridge = (pluginRegistry instanceof PluginRegistry ? pluginRegistry.get('connector-bridge') : undefined) as (import('./plugins/types').TaskSourcePlugin & {
      bindSourceLifecycle?(owner: SourceLifecycleOwner): void
    }) | undefined
    bridge?.bindSourceLifecycle?.(this)
  }

  /** Exact borrowed owners, also used by the production boundary before work. */
  assertOwners(db: DatabaseManager, plugins: PluginRegistry, oauth?: OAuthManager): void {
    if (this.db !== db || this.pluginRegistry !== plugins || arguments.length >= 3 && this.oauthManager !== oauth) throw new Error('Task source owners do not match')
  }

  runSourceWork<T>(sourceId: string, work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new SyncManagerClosedError())
    if (this.sourceMutations.has(sourceId)) return Promise.reject(new SourceMutationBusyError())
    return this.enqueueSource(sourceId, work)
  }

  /** Fence new manual/background jobs immediately; drain previously accepted
   * jobs before a source edit. A failed/cancelled edit never replays a job. */
  runSourceMutation<T>(sourceId: string, mutation: () => T | Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new SyncManagerClosedError())
    if (this.sourceMutations.has(sourceId)) return Promise.reject(new SourceMutationBusyError())
    this.sourceMutations.add(sourceId)
    const work = this.enqueueSource(sourceId, async () => mutation())
    void work.then(() => this.sourceMutations.delete(sourceId), () => this.sourceMutations.delete(sourceId))
    return work
  }

  private enqueueSource<T>(sourceId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.sourceTails.get(sourceId)
    const run = this.runOwned(async () => {
      if (previous) await previous.catch(() => undefined)
      if (this.closing) throw new SyncManagerClosedError()
      return work()
    })
    this.sourceTails.set(sourceId, run)
    const settled = (): void => { if (this.sourceTails.get(sourceId) === run) this.sourceTails.delete(sourceId) }
    void run.then(settled, settled)
    return run
  }

  private buildContext(sourceId?: string): PluginContext {
    return { db: this.db, oauthManager: this.oauthManager, sourceId }
  }

  importTasks(sourceId: string, beforeEffect?: () => void): Promise<SyncResult> {
    return this.runSourceWork(sourceId, () => { beforeEffect?.(); return this.importTasksInternal(sourceId) })
  }

  private async importTasksInternal(sourceId: string): Promise<SyncResult> {
    const result: SyncResult = { source_id: sourceId, imported: 0, updated: 0, errors: [] }

    const source = this.db.getTaskSource(sourceId)
    if (!source) {
      result.errors.push('Task source not found')
      console.error('[sync] Source lookup failed')
      return result
    }

    const plugin = this.pluginRegistry.get(source.plugin_id)
    if (!plugin) {
      result.errors.push('Task source plugin unavailable')
      console.error('[sync] Source plugin unavailable')
      return result
    }

    const ctx = this.buildContext(sourceId)
    console.log('[sync] Source import started')

    const config = this.getConfig(source)
    const startedAt = new Date().toISOString()

    try {
      const pluginResult: PluginSyncResult = await plugin.importTasks(sourceId, config, ctx)
      result.imported = pluginResult.imported
      result.updated = pluginResult.updated
      result.errors = pluginResult.errors
      console.log('[sync] Source import result:', { imported: result.imported, updated: result.updated, errorCount: result.errors.length })

      if (result.errors.length === 0) {
        this.db.updateTaskSourceLastSynced(sourceId)
        console.log('[sync] Source sync checkpoint persisted')
      }

      // Project events (#57): each task this run created wakes the project's
      // Captain. Plugins do not report ids, so the rows are found by source
      // and creation time (both set by createTask, in the same clock).
      if (result.imported > 0) {
        for (const task of this.db.getTasks({ projectId: source.project_id })) {
          if (task.source_id !== sourceId || task.created_at < startedAt) continue
          emitTaskEvent(this.db, 'task_synced', task.id, undefined, { unassigned: !task.agent_id })
        }
      }
    } catch {
      result.errors.push('Source import failed')
      console.error('[sync] Source import failed')
    }

    return result
  }

  exportTaskUpdate(taskId: string, changedFields: Record<string, unknown>, beforeEffect?: () => void): Promise<void> {
    return this.runOwned(async () => {
      const sourceId = this.db.getTask(taskId)?.source_id
      if (!sourceId) { beforeEffect?.(); return this.exportTaskUpdateInternal(taskId, changedFields) }
      return this.runSourceWork(sourceId, () => {
        beforeEffect?.()
        if (this.db.getTask(taskId)?.source_id !== sourceId) throw new SourceMutationBusyError()
        return this.exportTaskUpdateInternal(taskId, changedFields)
      })
    })
  }

  private async exportTaskUpdateInternal(taskId: string, changedFields: Record<string, unknown>): Promise<void> {
    const task = this.db.getTask(taskId)
    if (!task?.source_id || !task.external_id) return

    const source = this.db.getTaskSource(task.source_id)
    if (!source) return

    const plugin = this.pluginRegistry.get(source.plugin_id)
    if (!plugin) return

    const fields = { ...changedFields }
    // Retained export-only compatibility input. Tasks and provider exports use
    // canonical critical; never mutate the caller's intent or persist urgent.
    if (fields.priority === 'urgent') fields.priority = 'critical'
    // Internal completion control — never a source field.
    delete fields.complete_at_source
    if (task.complete_at_source === false) delete fields.status
    if (Object.keys(fields).length === 0) return

    const ctx = this.buildContext(task.source_id || undefined)
    const config = this.getConfig(source)

    await plugin.exportUpdate(task, fields, config, ctx)
  }

  executeAction(
    actionId: string,
    task: TaskRecord,
    input: string | undefined,
    sourceId: string,
    origin: 'task-source-action' | 'task-group' = 'task-source-action',
    controls?: { beforeEffect(): void; beforeLocalWrite(): void }
  ): Promise<ActionResult> {
    return this.runSourceWork(sourceId, () => this.executeActionInternal(actionId, task, input, sourceId, origin, controls))
  }

  private async executeActionInternal(
    actionId: string,
    task: TaskRecord,
    input: string | undefined,
    sourceId: string,
    origin: 'task-source-action' | 'task-group',
    controls?: { beforeEffect(): void; beforeLocalWrite(): void }
  ): Promise<ActionResult> {
    controls?.beforeEffect()
    if (origin !== 'task-group' && actionId !== PluginActionId.AddComment && this.db.getTask(task.id)?.group_id) {
      return { success: false, error: 'Use the task-group review controls for source actions on a grouped task.' }
    }
    const source = this.db.getTaskSource(sourceId)
    if (!source) return { success: false, error: 'Task source not found' }

    const plugin = this.pluginRegistry.get(source.plugin_id)
    if (!plugin) return { success: false, error: `Plugin "${source.plugin_id}" not found` }

    const ctx = this.buildContext(sourceId)
    const config = this.getConfig(source)

    const execute = () => plugin.executeAction(actionId, task, input, config, ctx)
    const result = await (controls && this.oauthManager
      ? this.oauthManager.withRequestGuard(execute, controls.beforeEffect)
      : execute())
    controls?.beforeLocalWrite()

    if (result.success && result.taskUpdate && Object.keys(result.taskUpdate).length > 0) {
      this.db.updateTask(task.id, result.taskUpdate, origin)
    }

    // Comments are meaningful even when the source returns no local field changes.
    if (result.success && actionId === PluginActionId.AddComment) {
      this.db.recordTaskActivity(task.id)
    }

    return result
  }

  getSourceUsers(sourceId: string, beforeEffect?: () => void): Promise<SourceUser[]> {
    return this.runSourceWork(sourceId, () => { beforeEffect?.(); return this.getSourceUsersInternal(sourceId) })
  }

  private async getSourceUsersInternal(sourceId: string): Promise<SourceUser[]> {
    const source = this.db.getTaskSource(sourceId)
    if (!source) return []

    const plugin = this.pluginRegistry.get(source.plugin_id)
    if (!plugin?.getUsers) return []

    const ctx = this.buildContext(sourceId)
    const config = this.getConfig(source)
    return plugin.getUsers(config, ctx)
  }

  reassignTask(
    taskId: string,
    userIds: string[],
    assigneeDisplay: string,
    beforeEffect?: () => void,
    beforeLocalCommit?: () => void
  ): Promise<ReassignResult> {
    return this.runOwned(async () => {
      const sourceId = this.db.getTask(taskId)?.source_id
      if (!sourceId) { beforeEffect?.(); return this.reassignTaskInternal(taskId, userIds, assigneeDisplay, beforeLocalCommit) }
      return this.runSourceWork(sourceId, () => {
        beforeEffect?.()
        if (this.db.getTask(taskId)?.source_id !== sourceId) throw new SourceMutationBusyError()
        return this.reassignTaskInternal(taskId, userIds, assigneeDisplay, beforeLocalCommit)
      })
    })
  }

  private async reassignTaskInternal(
    taskId: string,
    userIds: string[],
    assigneeDisplay: string,
    beforeLocalCommit?: () => void
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
      beforeLocalCommit?.()
      this.db.updateTask(taskId, { assignee: assigneeDisplay })
    }
    return result
  }

  private getConfig(source: { config: Record<string, unknown> }): Record<string, unknown> {
    return { ...source.config }
  }

  stop(): void { this.closing = true }

  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) {
      throw new RangeError('Source sync shutdown deadline must be an integer from 1 to 3000 ms')
    }
    this.stop()
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new SyncManagerShutdownIncompleteError()), timeoutMs)
    })
    try {
      do { await Promise.race([Promise.allSettled([...this.pendingWork]), expired]) }
      while (this.pendingWork.size)
    } finally { if (timer) clearTimeout(timer) }
  }

  private runOwned<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new SyncManagerClosedError())
    const run = Promise.resolve().then(() => {
      if (this.closing) throw new SyncManagerClosedError()
      return work()
    })
    this.pendingWork.add(run)
    void run.then(() => this.pendingWork.delete(run), () => this.pendingWork.delete(run))
    return run
  }
}

export class SyncManagerClosedError extends Error {
  readonly code = 'SOURCE_SYNC_CLOSED'
  constructor() { super('Source sync is shutting down'); this.name = 'SyncManagerClosedError' }
}

export class SourceMutationBusyError extends Error {
  readonly code = 'SOURCE_MUTATION_BUSY'
  constructor() { super('Task source configuration is changing; retry after it finishes'); this.name = 'SourceMutationBusyError' }
}

export class SyncManagerShutdownIncompleteError extends Error {
  readonly code = 'SOURCE_SYNC_SHUTDOWN_INCOMPLETE'
  constructor() { super('Source sync work has not finished'); this.name = 'SyncManagerShutdownIncompleteError' }
}
