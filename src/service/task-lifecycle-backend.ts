import { TaskGroupRequestScopeError } from '../main/agent-manager/task-group-request-scope'
import type { DatabaseManager } from '../main/database/manager'
import type { CreateTaskData, UpdateTaskData, TaskRecord, FileAttachmentRecord } from '../main/database/types'
import type { AgentManager } from '../main/agent-manager-core'
import type { SyncManager } from '../main/sync-manager'
import type { PluginRegistry } from '../main/plugins/registry'
import type { RecurrenceSchedulerCore } from '../main/recurrence-scheduler-core'
import type { HeartbeatSchedulerCore } from '../main/heartbeat-scheduler-core'
import type { TaskAutomationScheduler } from '../main/task-automation-scheduler'
import { TaskGroups } from '../main/database/task-groups'
import { afterTaskCreated, afterTaskUpdated, assertTaskLifecycleOwners, isExecutionTaskStatus, prepareUserTaskUpdate, startPreparedTask } from '../main/task-updates'
import { updateTaskFromUser } from '../main/session-feedback'
import { validateProjectRepos } from '../main/agent-manager/project-repos'
import { TaskStatus, PluginActionId } from '../shared/constants'
import { DEFAULT_PROJECT_ID } from '../shared/projects'
import { getTaskCompletionAction } from '../shared/task-completion'
import { TASK_LIFECYCLE_CODECS, TASK_LIFECYCLE_OPERATIONS, TASK_LIFECYCLE_EVENTS, TASK_LIFECYCLE_EVENT_CODECS, projectTaskLifecycleTask, taskAttachmentMetadataEqual,
  type TaskLifecycleCodec, type TaskLifecycleOperation, type TaskLifecycleEvent } from '../shared/task-lifecycle-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { isJsonValue, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

type Access = 'read' | 'write'
export interface TaskLifecycleBackendOptions {
  database: DatabaseManager
  manager: AgentManager
  sync: SyncManager
  registry: PluginRegistry
  recurrence: RecurrenceSchedulerCore
  heartbeat: HeartbeatSchedulerCore
  automation: TaskAutomationScheduler
  engineEpoch: string
  assertAvailable(): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canAccessTask(taskId: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessProject(projectId: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessAgent(agentId: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessSource(sourceId: string, caller: DesktopCallerContext, access: Access): boolean
  canUseSourcePlugin?(pluginId: string, caller: DesktopCallerContext, operation: 'plugin:executeAction'): boolean
  canAccessMcpServer?(id: string, caller: DesktopCallerContext, access: 'read'): boolean
  canAccessConnector?(id: string, caller: DesktopCallerContext, access: Access): boolean
  emit(operation: TaskLifecycleEvent, payload: JsonValue): void
  beforeTaskDeletion?(taskIds: readonly string[]): void
  beforeAttachmentMetadataWrite?(taskId: string, before: FileAttachmentRecord[], after: FileAttachmentRecord[]): void
  onFatalEvent(error: ServiceProtocolError): void
}

/** Full user task commands bind the real session, source and scheduler owners.
 * Synthetic DatabaseBackend CRUD is deliberately not reused. */
export class TaskLifecycleBackend {
  readonly registry: DesktopOperationRegistry
  private closing = false
  private failed = false
  private readonly flights = new Set<Promise<unknown>>()
  constructor(private readonly options: TaskLifecycleBackendOptions) {
    options.assertAvailable()
    if (typeof options.manager.runTaskLifecycleMutation !== 'function') throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.ownersReady()
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    for (const operation of TASK_LIFECYCLE_EVENTS) {
      const codec = TASK_LIFECYCLE_EVENT_CODECS[operation]
      this.registry.bindEvent(operation, { validatePayload: codec.validatePayload, encodePayload: value => codec.encodePayload(value as never) })
    }
    this.bindCommands()
  }
  get inflightCount(): number { return this.flights.size }
  shutdown(): void { this.closing = true }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid task lifecycle shutdown deadline')
    this.closing = true
    let timer: NodeJS.Timeout | undefined
    try { await Promise.race([Promise.allSettled([...this.flights]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(TASK_LIFECYCLE_OPERATIONS.map(operation => [operation, {
      validatePayload: (value: unknown) => { try { return isJsonValue(value) && TASK_LIFECYCLE_CODECS[operation].validateArguments(TASK_LIFECYCLE_CODECS[operation].decodeArguments(value)) } catch { return false } },
      validateResult: TASK_LIFECYCLE_CODECS[operation].validateWireResult,
      handle: (value: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, value, caller, signal)
    }]))
  }
  private ownersReady(): void { assertTaskLifecycleOwners(this.options.recurrence, this.options.heartbeat, this.options.automation) }
  private available(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing || this.failed) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertAvailable()
  }
  private retain<T>(flight: Promise<T>): Promise<T> {
    this.flights.add(flight)
    void flight.then(() => this.flights.delete(flight), () => this.flights.delete(flight))
    return flight
  }
  private projectAllowed(id: string, caller: DesktopCallerContext, access: Access): boolean {
    return !!this.options.database.getProject(id) && this.options.canAccessProject(id, caller, access)
  }
  private taskAllowed(id: string, caller: DesktopCallerContext, access: Access): boolean {
    const task = this.options.database.getTask(id)
    return this.options.canAccessTask(id, caller, access) && (!task || this.projectAllowed(task.project_id, caller, access))
  }
  private tree(id: string): TaskRecord[] {
    const db = this.options.database
    const rows = db.db.prepare(`WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT t.id FROM tasks t JOIN tree ON t.parent_task_id=tree.id OR t.recurrence_parent_id=tree.id)
      SELECT tasks.id FROM tree JOIN tasks ON tasks.id=tree.id LIMIT 129`).all(id) as Array<{ id: string }>
    if (rows.length > 128) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    return rows.map(row => db.getTask(row.id)!).filter(Boolean)
  }
  private ordinary(task: TaskRecord): boolean { return task.role === 'task' && !this.options.database.getTaskGroupByTask(task.id) }
  private mutationRows(id: string): TaskRecord[] {
    const task = this.options.database.getTask(id)
    if (!task) return []
    const group = this.options.database.getTaskGroupByTask(id)
    if (group) return [this.options.database.getTask(group.execution_task_id)!, ...this.options.database.getTaskGroupMembers(group.id)]
    const rows = this.tree(id)
    if (task.parent_task_id) rows.push(this.options.database.getTask(task.parent_task_id)!, ...this.options.database.getSubtasks(task.parent_task_id))
    return [...new Map(rows.filter(Boolean).map(task => [task.id, task])).values()]
  }
  private rowsAllowed(rows: TaskRecord[], caller: DesktopCallerContext, ordinary = false): boolean {
    return rows.length > 0 && rows.every(task => (!ordinary || this.ordinary(task)) && this.taskAllowed(task.id, caller, 'write'))
  }
  private updateRows(id: string, data: UpdateTaskData): TaskRecord[] {
    const rows = this.mutationRows(id)
    if (data.parent_task_id) {
      const parent = this.options.database.getTask(data.parent_task_id)
      if (parent) rows.push(parent, ...this.options.database.getSubtasks(parent.id))
    }
    return [...new Map(rows.map(task => [task.id, task])).values()]
  }
  private sameRows(current: TaskRecord[], expected: string[]): boolean { return current.length === expected.length && current.every(task => expected.includes(task.id)) }
  private refsAllowed(data: CreateTaskData | UpdateTaskData, caller: DesktopCallerContext, previous?: TaskRecord, destination?: string): boolean {
    const db = this.options.database
    const parentId = data.parent_task_id === undefined ? previous?.parent_task_id : data.parent_task_id
    const parent = parentId ? db.getTask(parentId) : undefined
    const recurrenceId = 'recurrence_parent_id' in data ? data.recurrence_parent_id : undefined
    const template = recurrenceId ? db.getTask(recurrenceId) : undefined
    if (parentId && (!parent || !this.ordinary(parent) || !this.taskAllowed(parentId, caller, 'write'))) return false
    if (previous?.parent_task_id && !this.taskAllowed(previous.parent_task_id, caller, 'write')) return false
    if (recurrenceId && (!template || !this.ordinary(template) || !this.taskAllowed(recurrenceId, caller, 'write'))) return false
    const requestedProject = 'project_id' in data ? data.project_id : undefined
    const project = destination ?? parent?.project_id ?? template?.project_id ?? requestedProject ?? previous?.project_id ?? DEFAULT_PROJECT_ID
    if (!this.projectAllowed(project, caller, 'write') || requestedProject && requestedProject !== project || template && template.project_id !== project) return false
    const agentId = 'agent_id' in data ? data.agent_id : previous?.agent_id
    if (agentId && (!db.getAgent(agentId) || !this.options.canAccessAgent(agentId, caller, 'read'))) return false
    if (isExecutionTaskStatus(data.status) || data.auto_start_agent === true) {
      const children = previous ? db.getSubtasks(previous.id).filter(task => task.status === TaskStatus.NotStarted && task.agent_id) : []
      const agents = db.getAgents()
      const selected = agentId ?? (parentId ? undefined : (agents.find(agent => agent.is_default) ?? agents[0])?.id)
      if ((!selected && !children.length) || (selected && !this.options.canAccessAgent(selected, caller, 'read')) ||
        children.some(child => !this.taskAllowed(child.id, caller, 'write') || !this.options.canAccessAgent(child.agent_id!, caller, 'read'))) return false
    }
    const skills = 'skill_ids' in data ? data.skill_ids : previous?.skill_ids
    if (skills?.some(id => { const skill = db.getSkill(id); return !skill || skill.project_id !== null && (skill.project_id !== project || !this.projectAllowed(skill.project_id, caller, 'read')) })) return false
    const repos = data.repos ?? previous?.repos ?? []
    const alreadyAllowed = destination ? [] : previous?.project_id === project ? previous.repos : parent?.repos ?? []
    if ('error' in validateProjectRepos(db, project, repos, alreadyAllowed)) return false
    if (previous?.source_id) {
      const source = db.getTaskSource(previous.source_id)
      if (!source || source.project_id !== project || !this.options.canAccessSource(source.id, caller, 'write')) return false
    }
    if (data.next_subtask_ids?.some(id => !this.taskAllowed(id, caller, 'write') || db.getTask(id)?.parent_task_id !== parentId || id === previous?.id)) return false
    if (data.next_subtask_ids?.length && !parentId) return false
    if (previous && parentId && this.tree(previous.id).some(task => task.id === parentId)) return false
    if (previous && parent && previous.project_id !== parent.project_id && this.tree(previous.id).length > 1) return false
    const recurring = data.is_recurring ?? previous?.is_recurring
    const pattern = data.recurrence_pattern === undefined ? previous?.recurrence_pattern : data.recurrence_pattern
    if (recurring && (!pattern || !this.options.recurrence.calculateNextOccurrence(pattern, new Date().toISOString()))) return false
    if (data.status === TaskStatus.AgentLearning) {
      if (!previous?.agent_id || !Number.isInteger((data as UpdateTaskData).feedback_rating) || (data as UpdateTaskData).feedback_rating! < 1 || (data as UpdateTaskData).feedback_rating! > 5 || previous.status === TaskStatus.Completed) return false
      if (previous.source_id && typeof data.complete_at_source !== 'boolean') return false
    }
    if (data.status === TaskStatus.Completed && previous && db.getSubtasks(previous.id).some(task => ![TaskStatus.Completed, TaskStatus.ReadyForReview].includes(task.status as TaskStatus))) return false
    if (data.status === TaskStatus.Completed && previous?.source_id && previous.status !== TaskStatus.Completed && data.complete_at_source !== false) return false
    return true
  }
  private updateAllowed(id: string, data: UpdateTaskData, caller: DesktopCallerContext): boolean {
    const task = this.options.database.getTask(id)
    if (!task) return this.options.canAccessTask(id, caller, 'write')
    if (task.role !== 'task' || !this.rowsAllowed(this.updateRows(id, data), caller) || !this.refsAllowed(data, caller, task)) return false
    try { new TaskGroups(this.options.database).guardUpdate(task, data) } catch { return false }
    return true
  }
  private sourceActionAllowed(action: string, id: string, sourceId: string, caller: DesktopCallerContext, input?: string): boolean {
    const db = this.options.database, task = db.getTask(id), source = db.getTaskSource(sourceId)
    if (!task || !source || !task.external_id || task.role !== 'task' || task.group_id || task.source_id !== sourceId || source.project_id !== task.project_id ||
      !this.taskAllowed(id, caller, 'write') || !this.rowsAllowed(this.mutationRows(id), caller) || !this.options.canAccessSource(sourceId, caller, 'write') || !this.projectAllowed(source.project_id, caller, 'write')) return false
    const plugin = this.options.registry.get(source.plugin_id)
    if (!plugin || this.options.canUseSourcePlugin && !this.options.canUseSourcePlugin(source.plugin_id, caller, 'plugin:executeAction')) return false
    if (source.mcp_server_id && !this.options.canAccessMcpServer?.(source.mcp_server_id, caller, 'read')) return false
    if (source.plugin_id === 'connector-bridge' && (typeof source.config.connector_instance_id !== 'string' || !this.options.canAccessConnector?.(source.config.connector_instance_id, caller, 'write'))) return false
    const actions = plugin.getActions({ ...source.config })
    if (!Array.isArray(actions) || actions.length > 128 || !actions.every(item => item && typeof item.id === 'string' && item.id.length <= 512) ||
      action !== PluginActionId.Complete && !actions.some(item => item.id === action)) return false
    const selected = actions.find(item => item.id === action)
    if (selected?.requiresInput && (!input?.trim() || selected.inputOptions && !selected.inputOptions.some(option => option.value === input))) return false
    const completes = action === getTaskCompletionAction(task.output_fields) || [PluginActionId.Complete, PluginActionId.CloseIssue, PluginActionId.Approve, PluginActionId.Reject].includes(action as PluginActionId)
    return !completes || db.getSubtasks(id).every(child => [TaskStatus.Completed, TaskStatus.ReadyForReview].includes(child.status as TaskStatus))
  }
  private publish(operation: TaskLifecycleEvent, payload: JsonValue): void {
    try {
      const encoded = this.registry.encodeEvent(operation, payload, { principal: 'service', engineEpoch: this.options.engineEpoch })
      this.options.emit(operation, encoded)
    }
    catch { this.failed = true; try { this.options.onFatalEvent(new ServiceProtocolError('DISCONNECTED')) } finally { throw new ServiceProtocolError('DISCONNECTED') } }
  }
  private updated(ids: string[]): void {
    for (const id of [...new Set(ids)]) {
      const task = this.options.database.getTask(id)
      if (task) this.publish('task:updated', { taskId: id, updates: projectTaskLifecycleTask(task) })
    }
  }
  private bind<K extends TaskLifecycleOperation>(operation: K, authorize: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext) => boolean,
    effect: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext, signal: AbortSignal) => unknown | Promise<unknown>, read = false): void {
    const codec = TASK_LIFECYCLE_CODECS[operation] as TaskLifecycleCodec<K>
    this.registry.bindCommand(operation, { decodeRequest: payload => codec.decodeArguments(structuredClone(payload)), validateArguments: codec.validateArguments,
      authorize: (args, caller) => { this.available(); return authorize(args, caller) },
      invoke: (args, caller, signal) => this.retain((async () => {
        this.available(signal)
        if (!authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const current = (): void => {
          this.available(signal)
          if (!authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        }
        const value = await this.options.manager.withTaskGroupRequestGuard(async () => effect(args, caller, signal), current, signal).catch(error => {
          if (error instanceof TaskGroupRequestScopeError) throw new ServiceProtocolError(error.code)
          throw error
        })
        this.available(signal)
        if (read && !authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const result = codec.encodeResult(value)
        return codec.decodeResult(result.defined ? result.value : undefined)
      })()), validateResult: codec.validateResult, encodeResult: codec.encodeResult })
  }
  private bindCommands(): void {
    const { database: db, manager } = this.options
    this.bind('db:getTasks', ([project], caller) => project === undefined || this.projectAllowed(project, caller, 'read'), ([project], caller) => {
      const rows = db.db.prepare(`SELECT id, project_id FROM tasks WHERE role='task' ${project === undefined ? '' : 'AND project_id=?'} ORDER BY created_at DESC,id`)
      const result: TaskRecord[] = []
      for (const row of (project === undefined ? rows.iterate() : rows.iterate(project)) as Iterable<{ id: string; project_id: string }>) {
        if (!this.taskAllowed(row.id, caller, 'read')) continue
        if (result.length === 128) throw new ServiceProtocolError('INVALID_RESULT')
        result.push(db.getTask(row.id)!)
      }
      return result
    }, true)
    this.bind('db:getTask', ([id], caller) => this.taskAllowed(id, caller, 'read'), ([id]) => db.getTask(id), true)
    this.bind('db:getSubtasks', ([id], caller) => this.taskAllowed(id, caller, 'read'), ([id], caller) => db.getSubtasks(id).filter(task => this.taskAllowed(task.id, caller, 'read')), true)
    this.bind('tasks:getCoordinatorTaskId', ([id], caller) => this.projectAllowed(id ?? DEFAULT_PROJECT_ID, caller, 'read'), ([id], caller) => {
      const captain = db.getCoordinatorTask(id ?? DEFAULT_PROJECT_ID)
      return captain && this.taskAllowed(captain.id, caller, 'read') ? captain.id : null
    }, true)
    this.bind('db:createTask', ([data], caller) => this.refsAllowed(data, caller), async ([requested], caller, signal) => {
      this.ownersReady(); this.available(signal)
      if (!this.refsAllowed(requested, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
      const start = isExecutionTaskStatus(requested.status)
      const data = { ...requested, ...(start ? { status: TaskStatus.NotStarted } : {}) } as CreateTaskData
      const create = async (): Promise<TaskRecord> => db.db.transaction(() => {
        this.available(signal)
        if (!this.refsAllowed(requested, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const task = db.createTask(data)
        if (!task) throw new ServiceProtocolError('INVALID_RESULT')
        if (data.complete_at_source !== undefined) db.updateTask(task.id, { complete_at_source: data.complete_at_source })
        projectTaskLifecycleTask(db.getTask(task.id))
        return db.getTask(task.id)!
      })()
      const parentIds = [requested.parent_task_id, requested.recurrence_parent_id].filter((id): id is string => !!id)
      const task = parentIds.length ? await manager.runTaskLifecycleMutation(parentIds, create) : await create()
      try {
        manager.runAcceptedTaskEffects(() => afterTaskCreated(task))
        this.available(signal)
        if (start) await startPreparedTask(manager, task.id, true)
        return db.getTask(task.id)
      } finally { this.publish('task:created', { task: projectTaskLifecycleTask(db.getTask(task.id)) }) }
    })
    this.bind('db:updateTask', ([id, data], caller) => this.updateAllowed(id, data, caller), async ([id, data, precondition], caller, signal) => {
      this.ownersReady()
      if (!db.getTask(id)) return undefined
      const rows = this.updateRows(id, data), ids = rows.map(task => task.id)
      const attachmentsBaseline = precondition?.attachmentsBaseline.map(record => ({ ...record }))
      const assertAttachmentBaseline = (): void => {
        if (data.attachments !== undefined && (!attachmentsBaseline || !taskAttachmentMetadataEqual(db.getTask(id)?.attachments, attachmentsBaseline)))
          throw new ServiceProtocolError('INVALID_REQUEST')
      }
      let accepted = false, start = false
      try {
        const effects = await manager.runTaskLifecycleMutation(ids, async () => {
          this.available(signal)
          if (!this.updateAllowed(id, data, caller) || !this.sameRows(this.updateRows(id, data), ids)) throw new ServiceProtocolError('INVALID_REQUEST')
          assertAttachmentBaseline()
          const previous = db.getTask(id)!
          if (data.agent_id !== undefined && data.agent_id !== previous.agent_id || data.parent_task_id !== undefined && data.parent_task_id !== previous.parent_task_id)
            await manager.stopByTaskId(id)
          this.available(signal)
          assertAttachmentBaseline()
          const prepared = await prepareUserTaskUpdate(manager, previous, data)
          this.available(signal)
          if (!this.updateAllowed(id, data, caller) || !this.sameRows(this.updateRows(id, data), ids)) throw new ServiceProtocolError('INVALID_REQUEST')
          const updated = db.db.transaction(() => {
            assertAttachmentBaseline()
            if (prepared.data.attachments !== undefined) this.options.beforeAttachmentMetadataWrite?.(id, db.getTask(id)!.attachments, prepared.data.attachments)
            const updated = updateTaskFromUser(db, id, prepared.data)
            if (updated) projectTaskLifecycleTask(updated)
            return updated
          })()
          accepted = !!updated
          start = prepared.startAfterWrite
          return updated ? { previous, data: prepared.data, updated } : undefined
        })
        if (effects) {
          if (effects.data.heartbeat_enabled === false) this.options.heartbeat.disableHeartbeat(id)
          else if (effects.data.heartbeat_enabled === true || effects.data.heartbeat_interval_minutes !== undefined && effects.updated.heartbeat_enabled)
            this.options.heartbeat.enableHeartbeat(id, effects.data.heartbeat_interval_minutes ?? undefined)
          manager.runAcceptedTaskEffects(() => afterTaskUpdated(db, manager, effects.previous, effects.data, db.getTask(id)!))
        }
        this.available(signal)
        if (!this.updateAllowed(id, data, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        if (start) await startPreparedTask(manager, id, true)
        return db.getTask(id)
      } finally { if (accepted) this.updated([...ids, ...db.getSubtasks(id).map(task => task.id)]) }
    })
    this.bind('db:deleteTask', ([id], caller) => !db.getTask(id) ? this.options.canAccessTask(id, caller, 'write') : this.rowsAllowed(this.tree(id), caller, true) && this.rowsAllowed(this.mutationRows(id), caller), async ([id], caller, signal) => {
      this.ownersReady()
      if (!db.getTask(id)) return false
      const tasks = this.tree(id), ids = tasks.map(task => task.id)
      const affected = this.mutationRows(id).map(task => task.id)
      this.options.beforeTaskDeletion?.(ids)
      let accepted = false
      try {
        return await manager.runTaskLifecycleMutation(affected, async () => {
          this.available(signal)
          if (!this.rowsAllowed(this.tree(id), caller, true) || !this.sameRows(this.tree(id), ids) || !this.rowsAllowed(this.mutationRows(id), caller) || !this.sameRows(this.mutationRows(id), affected)) throw new ServiceProtocolError('INVALID_REQUEST')
          for (const task of tasks) { await manager.stopByTaskId(task.id); await manager.cleanupHeartbeatSession(task.id) }
          this.available(signal)
          if (!this.rowsAllowed(this.tree(id), caller, true) || !this.sameRows(this.tree(id), ids) || !this.rowsAllowed(this.mutationRows(id), caller) || !this.sameRows(this.mutationRows(id), affected)) throw new ServiceProtocolError('INVALID_REQUEST')
          // Delete descendants explicitly so attachment/transcript cleanup runs
          // for each row before the database's parent/recurrence cascade.
          const pending = new Map(tasks.map(task => [task.id, task]))
          while (pending.size) {
            const leaves = [...pending.values()].filter(task => ![...pending.values()].some(child => child.parent_task_id === task.id || child.recurrence_parent_id === task.id))
            if (!leaves.length) throw new ServiceProtocolError('INVALID_REQUEST')
            for (const task of leaves) { this.options.beforeTaskDeletion?.([task.id]); db.deleteTask(task.id); pending.delete(task.id) }
          }
          accepted = true
          return true
        })
      } finally { if (accepted) { for (const taskId of ids) this.publish('task:deleted', { taskId }); this.updated(affected.filter(id => !ids.includes(id))); this.publish('tasks:refresh', {}) } }
    })
    this.bind('db:reorderSubtasks', ([id, ids], caller) => this.taskAllowed(id, caller, 'write') && this.ordinary(db.getTask(id)!) && ids.every(child => this.taskAllowed(child, caller, 'write') && this.ordinary(db.getTask(child)!) && db.getTask(child)?.parent_task_id === id), async ([id, ids], caller, signal) => {
      return manager.runTaskLifecycleMutation([id, ...ids], async () => {
        this.available(signal)
        const children = db.getSubtasks(id)
        if (children.length !== ids.length || children.some(child => !ids.includes(child.id) || !this.taskAllowed(child.id, caller, 'write') || !this.ordinary(child))) throw new ServiceProtocolError('INVALID_ARGUMENTS')
        db.reorderSubtasks(id, ids)
        this.publish('task:subtasks-reordered', { parentId: id, orderedIds: ids }); this.updated(ids)
        return true
      })
    })
    this.bind('project:moveTask', ([id, destination], caller) => this.rowsAllowed(this.tree(id), caller, true) && this.projectAllowed(destination, caller, 'write') &&
      this.tree(id).every(task => this.refsAllowed({}, caller, task, destination)), async ([id, destination], caller, signal) => {
      this.ownersReady()
      const tasks = this.tree(id), ids = tasks.map(task => task.id)
      return manager.runTaskLifecycleMutation(ids, async () => {
        this.available(signal)
        if (db.getTask(id)?.parent_task_id || !this.rowsAllowed(this.tree(id), caller, true) || !this.projectAllowed(destination, caller, 'write') || tasks.some(task => !this.refsAllowed({}, caller, task, destination))) throw new ServiceProtocolError('INVALID_REQUEST')
        for (const task of tasks) { await manager.stopByTaskId(task.id); await manager.cleanupHeartbeatSession(task.id) }
        this.available(signal)
        const current = this.tree(id)
        if (!this.sameRows(current, ids) || !this.rowsAllowed(current, caller, true) || !this.projectAllowed(destination, caller, 'write') || current.some(task => !this.refsAllowed({}, caller, task, destination))) throw new ServiceProtocolError('INVALID_REQUEST')
        const result = db.moveTaskToProject(id, destination) ?? null
        if (result) this.updated(ids)
        return result
      })
    })
    this.bind('plugin:executeAction', ([action, id, source, input], caller) => this.sourceActionAllowed(action, id, source, caller, input), async ([action, id, source, input], caller, signal) => {
      this.ownersReady()
      const ids = this.mutationRows(id).map(task => task.id)
      const { result, effects } = await manager.runTaskLifecycleMutation(ids, async () => {
        this.available(signal)
        const previous = db.getTask(id)!
        if (!this.sourceActionAllowed(action, id, source, caller, input) || !this.sameRows(this.mutationRows(id), ids)) throw new ServiceProtocolError('INVALID_REQUEST')
        if (action !== PluginActionId.AddComment) {
          const live = manager.findSessionByTaskId(id)
          if (live) await manager.stopSession(live.sessionId, false, true)
          if (manager.hasTaskStartOwnership(id)) throw new ServiceProtocolError('INVALID_REQUEST')
        }
        this.available(signal)
        const current = db.getTask(id)!
        if (!current || !this.sourceActionAllowed(action, id, source, caller, input) || !this.sameRows(this.mutationRows(id), ids)) throw new ServiceProtocolError('INVALID_REQUEST')
        const sourceSnapshot = JSON.stringify(db.getTaskSource(source))
        const exactBinding = (): void => {
          this.ownersReady()
          const task = db.getTask(id)
          if (!task || task.external_id !== current.external_id || task.source_id !== source || task.project_id !== current.project_id || task.role !== current.role || task.group_id !== current.group_id ||
            JSON.stringify(db.getTaskSource(source)) !== sourceSnapshot || !this.sourceActionAllowed(action, id, source, caller, input)) throw new ServiceProtocolError('INVALID_REQUEST')
        }
        const result = await this.options.sync.executeAction(action, current, input, source, 'task-source-action', {
          beforeEffect: () => { this.available(signal); exactBinding() },
          // Accepted external effects may finish after cancellation, but cannot
          // apply to a different task/source binding or a withdrawn grant.
          beforeLocalWrite: exactBinding
        })
        // Accepted source work is reconciled even if its reply was cancelled.
        return { result, effects: result.success ? { previous, updated: db.getTask(id)! } : undefined }
      })
      if (effects) {
        try { manager.runAcceptedTaskEffects(() => afterTaskUpdated(db, manager, effects.previous, effects.previous.status === effects.updated.status ? {} : { status: effects.updated.status }, effects.updated)) }
        finally { this.updated(ids) }
      }
      return result.error === undefined ? result : { ...result, error: 'The task source action could not be completed' }
    })
  }
}
