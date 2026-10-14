import type { DatabaseManager } from '../main/database/manager'
import type { CreateTaskSourceData, UpdateTaskSourceData, TaskSourceRecord, TaskRecord } from '../main/database/types'
import type { AgentManager } from '../main/agent-manager-core'
import type { SyncManager } from '../main/sync-manager'
import type { PluginRegistry } from '../main/plugins/registry'
import type { OAuthManager } from '../main/oauth/oauth-manager-core'
import type { RecurrenceSchedulerCore } from '../main/recurrence-scheduler-core'
import type { HeartbeatSchedulerCore } from '../main/heartbeat-scheduler-core'
import type { TaskAutomationScheduler } from '../main/task-automation-scheduler'
import { assertTaskLifecycleOwners } from '../main/task-updates'
import { AUTHENTICATED_SECRET_STORAGE_FORMAT, getSecretStorage, type SecretStorage } from '../main/platform/secret-storage'
import { DEFAULT_PROJECT_ID } from '../shared/projects'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { TASK_SOURCE_CODECS, TASK_SOURCE_OPERATIONS, TASK_SOURCE_CONFIG_FIELDS, TASK_SOURCE_KEY_SET_MARKER, isTaskSourceConfigInput, isTaskSourcePluginId, projectTaskSource, projectTaskSourceConfig,
  type TaskSourceCodec, type TaskSourceOperation } from '../shared/task-source-codecs'
import { TASK_LIFECYCLE_EVENT_CODECS, projectTaskLifecycleTask, type TaskLifecycleEvent } from '../shared/task-lifecycle-codecs'
import { isJsonValue, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

type Access = 'read' | 'write'
type SourceTaskReference = Pick<TaskRecord, 'id' | 'project_id' | 'source_id' | 'role' | 'parent_task_id' | 'recurrence_parent_id'>
export type TaskSourceEvent = Extract<TaskLifecycleEvent, 'task:updated' | 'task:deleted' | 'tasks:refresh'>
export interface TaskSourceOwners {
  database: DatabaseManager
  manager: AgentManager
  sync: SyncManager
  plugins: PluginRegistry
  oauth: OAuthManager
  secretStorage: SecretStorage
}
export interface TaskSourceBackendOptions extends TaskSourceOwners {
  recurrence: RecurrenceSchedulerCore
  heartbeat: HeartbeatSchedulerCore
  automation: TaskAutomationScheduler
  engineEpoch: string
  assertAvailable(): void
  assertOwners(owners: TaskSourceOwners): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canAccessProject(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessTask(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessSource(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessMcpServer(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessConnector(id: string, caller: DesktopCallerContext, access: Access): boolean
  /** Host-established plugin capability, independently of source CRUD grants.
   * Configuring a URL or source never enables a native/worker/network owner. */
  canUseSourcePlugin(id: string, caller: DesktopCallerContext, operation: TaskSourceOperation): boolean
  emit(operation: TaskSourceEvent, payload: JsonValue): void
  onFatalEvent(error: ServiceProtocolError): void
}

/** Eight source commands borrow real production storage/sync/plugin/lifecycle
 * owners. Source edits share the background job's actual admission fence. */
export class TaskSourceBackend {
  readonly registry: DesktopOperationRegistry
  private closing = false
  private failed = false
  private readonly flights = new Set<Promise<unknown>>()
  constructor(private readonly options: TaskSourceBackendOptions) {
    options.assertAvailable(); this.ownersReady()
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    for (const operation of ['task:updated', 'task:deleted', 'tasks:refresh'] as const) {
      const codec = TASK_LIFECYCLE_EVENT_CODECS[operation]
      this.registry.bindEvent(operation, { validatePayload: codec.validatePayload, encodePayload: value => codec.encodePayload(value as never) })
    }
    this.bindCommands()
  }
  get inflightCount(): number { return this.flights.size }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(TASK_SOURCE_OPERATIONS.map(operation => [operation, {
      validatePayload: (value: unknown) => { try { return isJsonValue(value) && TASK_SOURCE_CODECS[operation].validateArguments(TASK_SOURCE_CODECS[operation].decodeArguments(value)) } catch { return false } },
      validateResult: TASK_SOURCE_CODECS[operation].validateWireResult,
      handle: (value: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, value, caller, signal)
    }]))
  }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid task source shutdown deadline')
    this.closing = true
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.allSettled([...this.flights]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  private ownersReady(): void {
    this.options.assertOwners(this.options)
    this.options.sync.assertOwners(this.options.database, this.options.plugins, this.options.oauth)
    assertTaskLifecycleOwners(this.options.recurrence, this.options.heartbeat, this.options.automation)
    if (getSecretStorage() !== this.options.secretStorage || this.options.secretStorage.formatId !== AUTHENTICATED_SECRET_STORAGE_FORMAT || !this.options.secretStorage.isEncryptionAvailable()) throw new ServiceProtocolError('DISCONNECTED')
    const bridge = this.options.plugins.get('connector-bridge') as { assertSourceLifecycle?(owner: SyncManager): void } | undefined
    if (bridge) {
      if (typeof bridge.assertSourceLifecycle !== 'function') throw new ServiceProtocolError('DISCONNECTED')
      bridge.assertSourceLifecycle(this.options.sync)
    }
  }
  private available(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing || this.failed) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertAvailable(); this.ownersReady()
  }
  private retain<T>(flight: Promise<T>): Promise<T> {
    this.flights.add(flight); void flight.then(() => this.flights.delete(flight), () => this.flights.delete(flight)); return flight
  }
  /** Bound legacy storage before JSON.parse/decryption/getter materialization.
   * Refusal preserves the row; masking is never a reason to load 40 MB. */
  private rowBytes(table: 'task_sources' | 'tasks', id: string): number {
    const columns = this.options.database.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    const sum = columns.map(column => `COALESCE(length(CAST("${column.name.replaceAll('"', '""')}" AS BLOB)),0)`).join('+')
    const row = this.options.database.db.prepare(`SELECT ${sum} AS bytes FROM ${table} WHERE id=?`).get(id) as { bytes: number } | undefined
    const bytes = row?.bytes ?? 0
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 512_000) throw new ServiceProtocolError('INVALID_RESULT')
    return bytes
  }
  private source(id: string): TaskSourceRecord | undefined { this.rowBytes('task_sources', id); return this.options.database.getTaskSource(id) }
  private task(id: string): TaskRecord | undefined { this.rowBytes('tasks', id); return this.options.database.getTask(id) }
  private projectAllowed(id: string, caller: DesktopCallerContext, access: Access): boolean { return !!this.options.database.getProject(id) && this.options.canAccessProject(id, caller, access) }
  private sourceAllowed(id: string, caller: DesktopCallerContext, access: Access): boolean {
    if (!this.options.canAccessSource(id, caller, access)) return false
    const row = this.options.database.db.prepare('SELECT project_id,mcp_server_id FROM task_sources WHERE id=?').get(id) as { project_id: string | null; mcp_server_id: string | null } | undefined
    return !row || this.projectAllowed(row.project_id ?? DEFAULT_PROJECT_ID, caller, access) && (!row.mcp_server_id || this.options.canAccessMcpServer(row.mcp_server_id, caller, 'read'))
  }
  private taskAllowed(task: SourceTaskReference, caller: DesktopCallerContext, access: Access): boolean {
    return this.options.canAccessTask(task.id, caller, access) && this.projectAllowed(task.project_id, caller, access) && (!task.source_id || this.sourceAllowed(task.source_id, caller, access))
  }
  private sourceTasks(id: string, descendants = false): SourceTaskReference[] {
    const rows = this.options.database.db.prepare(descendants ? `WITH RECURSIVE owned(id) AS (SELECT id FROM tasks WHERE source_id=? UNION SELECT t.id FROM tasks t JOIN owned ON t.parent_task_id=owned.id OR t.recurrence_parent_id=owned.id)
      SELECT tasks.id,tasks.project_id,tasks.source_id,tasks.role,tasks.parent_task_id,tasks.recurrence_parent_id FROM tasks JOIN owned ON tasks.id=owned.id LIMIT 129` : 'SELECT id,project_id,source_id,role,parent_task_id,recurrence_parent_id FROM tasks WHERE source_id=? LIMIT 129').all(id) as SourceTaskReference[]
    if (rows.length > 128) throw new ServiceProtocolError('INVALID_REQUEST')
    return rows
  }
  private affected(id: string): { deleted: SourceTaskReference[]; all: SourceTaskReference[] } {
    const deleted = this.sourceTasks(id, true), related = [...deleted]
    for (const task of deleted) if (task.parent_task_id) {
      const rows = this.options.database.db.prepare('SELECT id,project_id,source_id,role,parent_task_id,recurrence_parent_id FROM tasks WHERE id=? OR parent_task_id=? LIMIT 129').all(task.parent_task_id, task.parent_task_id) as SourceTaskReference[]
      related.push(...rows)
    }
    const all = [...new Map(related.map(task => [task.id, task])).values()]
    if (all.length > 128) throw new ServiceProtocolError('INVALID_REQUEST')
    return { deleted, all }
  }
  private sameRows(current: SourceTaskReference[], ids: string[]): boolean { return current.length === ids.length && current.every(task => ids.includes(task.id)) }
  private rowsAllowed(rows: SourceTaskReference[], caller: DesktopCallerContext): boolean { return rows.every(task => this.taskAllowed(task, caller, 'write')) }
  private boundedTasks(rows: SourceTaskReference[]): void { if (rows.reduce((bytes, task) => bytes + this.rowBytes('tasks', task.id), 0) > 512_000) throw new ServiceProtocolError('INVALID_RESULT') }
  private deletionAllowed(id: string, caller: DesktopCallerContext): boolean {
    const { deleted, all } = this.affected(id), db = this.options.database
    return this.rowsAllowed(all, caller) && deleted.every(task => task.role === 'task' && !db.getTaskGroupByTask(task.id) && (!task.source_id || task.source_id === id))
  }
  private pluginAllowed(source: TaskSourceRecord, caller: DesktopCallerContext, operation: TaskSourceOperation): boolean {
    const plugin = this.options.plugins.get(source.plugin_id)
    return isTaskSourcePluginId(source.plugin_id) && !!plugin && this.options.canUseSourcePlugin(source.plugin_id, caller, operation) &&
      (operation !== 'taskSource:getUsers' || typeof plugin.getUsers === 'function') && (operation !== 'taskSource:reassign' || typeof plugin.reassignTask === 'function')
  }
  private configAllowed(plugin: string, data: Record<string, unknown> | undefined, previous: TaskSourceRecord | undefined, caller: DesktopCallerContext): boolean {
    if (data === undefined) return true
    if (!isTaskSourcePluginId(plugin) || !isTaskSourceConfigInput(plugin, data)) return false
    const fields = TASK_SOURCE_CONFIG_FIELDS[plugin]
    if (fields.secret.some(key => data[key] === TASK_SOURCE_KEY_SET_MARKER && (!previous || previous.plugin_id !== plugin || typeof previous.config[key] !== 'string' || !previous.config[key]))) return false
    if (plugin === 'connector-bridge') {
      const config = { ...previous?.config, ...data }, instanceId = config.connector_instance_id
      if (instanceId) {
        if (typeof instanceId !== 'string' || !this.options.canAccessConnector(instanceId, caller, 'write')) return false
        const instance = this.options.database.db.prepare('SELECT piece_name FROM connector_instances WHERE id=?').get(instanceId) as { piece_name: string } | undefined
        if (!instance || instance.piece_name !== config.piece_name) return false
        const refs = this.options.database.db.prepare("SELECT id FROM task_sources WHERE plugin_id='connector-bridge' AND id != ? LIMIT 257").all(previous?.id ?? '') as Array<{ id: string }>
        // A cursor/credential instance cannot silently become shared with a
        // different project/source. Its durable identity remains unchanged.
        if (refs.length > 256 || refs.some(row => this.source(row.id)?.config.connector_instance_id === instanceId)) return false
      }
    }
    return true
  }
  private configReferenceAllowed(source: TaskSourceRecord, caller: DesktopCallerContext, access: Access): boolean {
    if (source.plugin_id !== 'connector-bridge' || !source.config.connector_instance_id) return true
    const id = source.config.connector_instance_id
    if (typeof id !== 'string' || !this.options.canAccessConnector(id, caller, access)) return false
    const row = this.options.database.db.prepare('SELECT piece_name FROM connector_instances WHERE id=?').get(id) as { piece_name: string } | undefined
    return !!row && row.piece_name === source.config.piece_name
  }
  private configData(data: Record<string, unknown>, plugin: string): Record<string, unknown> | undefined {
    const secrets = isTaskSourcePluginId(plugin) ? TASK_SOURCE_CONFIG_FIELDS[plugin].secret : []
    const result = Object.fromEntries(Object.entries(data).filter(([key, value]) => !(secrets.includes(key) && value === TASK_SOURCE_KEY_SET_MARKER)))
    return Object.keys(result).length ? result : undefined
  }
  private createAllowed(data: CreateTaskSourceData, caller: DesktopCallerContext): boolean {
    const id = data.project_id ?? DEFAULT_PROJECT_ID
    return this.projectAllowed(id, caller, 'write') && isTaskSourcePluginId(data.plugin_id) && !!this.options.plugins.get(data.plugin_id) && this.options.canUseSourcePlugin(data.plugin_id, caller, 'taskSource:create') &&
      (!data.mcp_server_id || !!this.options.database.getMcpServer(data.mcp_server_id) && this.options.canAccessMcpServer(data.mcp_server_id, caller, 'read')) && this.configAllowed(data.plugin_id, data.config, undefined, caller)
  }
  private updateAllowed(id: string, data: UpdateTaskSourceData, caller: DesktopCallerContext): boolean {
    if (!this.sourceAllowed(id, caller, 'write')) return false
    const source = this.source(id)
    if (!source) return true
    if (!this.configReferenceAllowed(source, caller, 'read')) return false
    if (!this.rowsAllowed(this.sourceTasks(id), caller)) return false
    const plugin = data.plugin_id ?? source.plugin_id
    if (data.enabled === true && !source.enabled && this.options.plugins.get(plugin) && !this.options.canUseSourcePlugin(plugin, caller, 'taskSource:update')) return false
    if (plugin !== source.plugin_id && (!isTaskSourcePluginId(plugin) || !isTaskSourceConfigInput(plugin, source.config))) return false
    if (data.mcp_server_id && (!this.options.database.getMcpServer(data.mcp_server_id) || !this.options.canAccessMcpServer(data.mcp_server_id, caller, 'read'))) return false
    if (data.config !== undefined || plugin !== source.plugin_id || data.mcp_server_id !== undefined) {
      if (!this.options.plugins.get(plugin) || !this.options.canUseSourcePlugin(plugin, caller, 'taskSource:update')) return false
      if (plugin !== source.plugin_id && isTaskSourcePluginId(source.plugin_id) && TASK_SOURCE_CONFIG_FIELDS[source.plugin_id].secret.some(key => !!source.config[key])) return false
    }
    return this.configAllowed(plugin, data.config, source, caller)
  }
  private networkAllowed(id: string, caller: DesktopCallerContext, operation: TaskSourceOperation, write: boolean): boolean {
    if (!this.sourceAllowed(id, caller, write ? 'write' : 'read')) return false
    const source = this.source(id), tasks = write ? this.sourceTasks(id) : []
    if (write) this.boundedTasks(tasks)
    return !!source && this.configReferenceAllowed(source, caller, write ? 'write' : 'read') && this.pluginAllowed(source, caller, operation) && (!write || this.rowsAllowed(tasks, caller)) && this.configAllowed(source.plugin_id, projectTaskSourceConfig(source.plugin_id, source.config), source, caller)
  }
  private taskNetworkAllowed(id: string, caller: DesktopCallerContext, operation: TaskSourceOperation): boolean {
    if (!this.options.canAccessTask(id, caller, 'write')) return false
    const task = this.task(id)
    return !!task && task.role === 'task' && !this.options.database.getTaskGroupByTask(id) && !!task.source_id && !!task.external_id && this.taskAllowed(task, caller, 'write') && this.networkAllowed(task.source_id, caller, operation, true)
  }
  private publish(operation: TaskSourceEvent, payload: unknown): void {
    try { this.options.emit(operation, this.registry.encodeEvent(operation, payload, { principal: 'service', engineEpoch: this.options.engineEpoch })) }
    catch { this.failed = true; try { this.options.onFatalEvent(new ServiceProtocolError('DISCONNECTED')) } finally { throw new ServiceProtocolError('DISCONNECTED') } }
  }
  private updated(ids: string[]): void {
    for (const id of ids) { const task = this.task(id); if (task) this.publish('task:updated', { taskId: id, updates: projectTaskLifecycleTask(task) }) }
  }
  private bind<K extends TaskSourceOperation>(operation: K, authorize: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext) => boolean,
    effect: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext, signal: AbortSignal) => unknown | Promise<unknown>, read = false): void {
    const codec = TASK_SOURCE_CODECS[operation] as TaskSourceCodec<K>
    this.registry.bindCommand(operation, { decodeRequest: payload => codec.decodeArguments(structuredClone(payload)), validateArguments: codec.validateArguments,
      authorize: (args, caller) => { this.available(); return authorize(args, caller) }, invoke: (args, caller, signal) => this.retain((async () => {
        this.available(signal)
        if (!authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const result = await effect(args, caller, signal)
        this.available(signal)
        if (read && !authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const value = codec.encodeResult(result)
        return codec.decodeResult(value.defined ? value.value : undefined)
      })()), validateResult: codec.validateResult, encodeResult: codec.encodeResult })
  }
  private bindCommands(): void {
    const { database: db, sync, manager } = this.options
    this.bind('taskSource:getAll', ([project], caller) => !project || this.projectAllowed(project, caller, 'read'), ([project], caller) => {
      const rows = db.db.prepare(project ? 'SELECT id FROM task_sources WHERE project_id=? ORDER BY created_at,id' : 'SELECT id FROM task_sources ORDER BY created_at,id').iterate(...(project ? [project] : [])) as Iterable<{ id: string }>
      const result: TaskSourceRecord[] = []
      let scanned = 0, bytes = 0
      for (const row of rows) {
        if (++scanned > 4096) throw new ServiceProtocolError('INVALID_RESULT')
        if (!this.sourceAllowed(row.id, caller, 'read')) continue
        if (result.length === 256 || (bytes += this.rowBytes('task_sources', row.id)) > 512_000) throw new ServiceProtocolError('INVALID_RESULT')
        const source = this.source(row.id)!
        if (this.configReferenceAllowed(source, caller, 'read')) result.push(source)
      }
      return result
    }, true)
    this.bind('taskSource:create', ([data], caller) => this.createAllowed(data, caller), ([requested], caller, signal) => {
      this.available(signal)
      if (!this.createAllowed(requested, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
      const config = requested.config === undefined ? undefined : this.configData(requested.config, requested.plugin_id)
      const result = db.db.transaction(() => {
        const source = db.createTaskSource({ ...requested, config })
        if (!source) throw new ServiceProtocolError('INVALID_RESULT')
        this.rowBytes('task_sources', source.id)
        projectTaskSource(source)
        return source
      })()
      if (result) this.publish('tasks:refresh', {})
      return result
    })
    this.bind('taskSource:update', ([id, data], caller) => this.updateAllowed(id, data, caller), async ([id, data], caller, signal) => {
      if (!this.source(id)) return undefined
      return sync.runSourceMutation(id, () => {
        this.available(signal)
        if (!this.updateAllowed(id, data, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const source = this.source(id)!, input = { ...data }
        if (input.config !== undefined) {
          const config = this.configData(input.config, input.plugin_id ?? source.plugin_id)
          if (config === undefined) delete input.config
          else input.config = config
        }
        const result = db.db.transaction(() => {
          const result = db.updateTaskSource(id, input)
          if (result) { this.rowBytes('task_sources', id); projectTaskSource(result) }
          return result
        })()
        if (result && Object.keys(input).length) this.publish('tasks:refresh', {})
        return result
      })
    })
    this.bind('taskSource:delete', ([id], caller) => this.sourceAllowed(id, caller, 'write') && this.deletionAllowed(id, caller), async ([id], caller, signal) => {
      if (!this.source(id)) return false
      return sync.runSourceMutation(id, async () => {
        this.available(signal)
        if (!this.sourceAllowed(id, caller, 'write') || !this.deletionAllowed(id, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const affected = this.affected(id), ids = affected.all.map(task => task.id), deletedIds = affected.deleted.map(task => task.id)
        this.boundedTasks(affected.all)
        const remove = async (): Promise<boolean> => {
          this.available(signal)
          if (!this.deletionAllowed(id, caller) || !this.sameRows(this.affected(id).all, ids)) throw new ServiceProtocolError('INVALID_REQUEST')
          for (const task of affected.deleted) { await manager.stopByTaskId(task.id); await manager.cleanupHeartbeatSession(task.id) }
          this.available(signal)
          const current = this.affected(id)
          if (!this.sourceAllowed(id, caller, 'write') || !this.deletionAllowed(id, caller) || !this.sameRows(current.all, ids) || !this.sameRows(current.deleted, deletedIds)) throw new ServiceProtocolError('INVALID_REQUEST')
          // Run real per-task attachment/transcript/link cleanup instead of
          // relying on the source FK's otherwise silent task cascade.
          const result = db.db.transaction(() => {
            const pending = new Map(current.deleted.map(task => [task.id, task]))
            while (pending.size) {
              const leaves = [...pending.values()].filter(task => ![...pending.values()].some(child => child.parent_task_id === task.id || child.recurrence_parent_id === task.id))
              if (!leaves.length) throw new ServiceProtocolError('INVALID_REQUEST')
              for (const task of leaves) { db.deleteTask(task.id); pending.delete(task.id) }
            }
            return db.deleteTaskSource(id)
          })()
          if (result) { for (const taskId of deletedIds) this.publish('task:deleted', { taskId }); this.updated(ids.filter(taskId => !deletedIds.includes(taskId))); this.publish('tasks:refresh', {}) }
          return result
        }
        return ids.length ? manager.runTaskLifecycleMutation(ids, remove) : remove()
      })
    })
    this.bind('taskSource:sync', ([id], caller) => this.networkAllowed(id, caller, 'taskSource:sync', true), async ([id], caller, signal) => {
      const binding = this.source(id)!, signature = [binding.project_id, binding.plugin_id]
      const result = await sync.importTasks(id, () => {
        this.available(signal)
        const current = this.source(id)
        if (!this.networkAllowed(id, caller, 'taskSource:sync', true) || !current || current.project_id !== signature[0] || current.plugin_id !== signature[1]) throw new ServiceProtocolError('INVALID_REQUEST')
      })
      this.publish('tasks:refresh', {})
      // Provider error strings may contain credentials. Counts remain exact;
      // each error stays visibly represented without exporting provider text.
      return { ...result, errors: result.errors.map(() => 'Source synchronization reported an error.') }
    })
    this.bind('taskSource:getUsers', ([id], caller) => this.networkAllowed(id, caller, 'taskSource:getUsers', false), ([id], caller, signal) => sync.getSourceUsers(id, () => {
      this.available(signal)
      if (!this.networkAllowed(id, caller, 'taskSource:getUsers', false)) throw new ServiceProtocolError('INVALID_REQUEST')
    }), true)
    this.bind('taskSource:exportUpdate', ([id], caller) => this.taskNetworkAllowed(id, caller, 'taskSource:exportUpdate'), async ([id, fields], caller, signal) => {
      const before = this.task(id)!, sourceId = before.source_id
      await manager.runTaskLifecycleMutation([id], async () => {
        this.available(signal)
        await sync.exportTaskUpdate(id, fields, () => {
          this.available(signal)
          if (this.task(id)?.source_id !== sourceId || !this.taskNetworkAllowed(id, caller, 'taskSource:exportUpdate')) throw new ServiceProtocolError('INVALID_REQUEST')
        })
      })
      const current = this.task(id)
      if (!current || current.source_id !== sourceId || current.external_id !== before.external_id || current.project_id !== before.project_id || current.role !== 'task' || db.getTaskGroupByTask(id)) throw new ServiceProtocolError('INVALID_REQUEST')
      this.updated([id])
    })
    this.bind('taskSource:reassign', ([id], caller) => this.taskNetworkAllowed(id, caller, 'taskSource:reassign'), async ([id, users, display], caller, signal) => {
      const before = this.task(id)!, sourceId = before.source_id
      const result = await manager.runTaskLifecycleMutation([id], async () => {
        this.available(signal)
        return sync.reassignTask(id, users, display, () => {
          this.available(signal)
          if (this.task(id)?.source_id !== sourceId || !this.taskNetworkAllowed(id, caller, 'taskSource:reassign')) throw new ServiceProtocolError('INVALID_REQUEST')
        }, () => {
          // Accepted external work still reconciles after cancellation. The
          // task lease blocks ordinary deletion/move/grouping; a foreign raw
          // replacement is rejected without writing to its new binding.
          const task = this.task(id)
          if (!task || task.source_id !== sourceId || task.external_id !== before.external_id || task.project_id !== before.project_id || task.role !== 'task' || db.getTaskGroupByTask(id)) throw new ServiceProtocolError('INVALID_REQUEST')
        })
      })
      if (result.success) this.updated([id])
      return result.error === undefined ? result : { success: result.success, error: 'Source reassignment failed.' }
    })
  }
}
