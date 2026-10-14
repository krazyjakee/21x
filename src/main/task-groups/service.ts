import type { DatabaseManager, TaskRecord } from '../database'
import type { AgentManager } from '../agent-manager-core'
import type { SyncManager } from '../sync-manager'
import { TaskStatus } from '../../shared/constants'
import type { CreateTaskGroupData, TaskGroupProgressState, TaskGroupRecord, TaskGroupReviewData, TaskGroupReviewResult, TaskGroupSnapshot } from '../../shared/task-groups'
import { AsyncLocalStorage } from 'node:async_hooks'
import { getTaskCompletionAction } from '../../shared/task-completion'

type Controller = Pick<AgentManager, 'runTaskGroupMutation' | 'hasTaskStartOwnership' | 'findSessionByTaskId'
  | 'retireTaskGroupContext' | 'stopSession' | 'stopByTaskId' | 'startTask' | 'sendByTaskId'> & Partial<Pick<AgentManager, 'withTaskGroupRequestGuard'>>
type Notify = (channel: 'task:updated' | 'tasks:refresh', data: unknown) => void
export interface TaskGroupRequestControls { beforeEffect(): void; signal: AbortSignal }
type RequestScope = TaskGroupRequestControls & { pending: Set<Promise<unknown>>; active: boolean }

/** User review and definition edits share the actual session owner's admission
 * fence. Progress has no completion authority and performs no source effect. */
export class TaskGroupService {
  private closing = false
  private readonly flights = new Set<Promise<unknown>>()
  private readonly requests = new AsyncLocalStorage<RequestScope>()
  constructor(private readonly db: DatabaseManager, private readonly controller: Controller,
    private readonly sync?: SyncManager, private readonly notify: Notify = () => {}) {
    for (const name of ['create', 'add', 'remove', 'dissolve', 'move', 'review'] as const) {
      const original = this[name].bind(this) as (...args: unknown[]) => Promise<unknown>
      ;(this as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name] = (...args) => {
        try {
          this.current()
          const scope = this.requests.getStore()
          const raw = this.controller.withTaskGroupRequestGuard
            ? this.controller.withTaskGroupRequestGuard(() => original(...args), () => this.current(), scope?.signal ?? new AbortController().signal)
            : original(...args) // Structural legacy controllers retain their existing behavior.
          return this.retain(raw.then(value => { this.current(); return value }))
        }
        catch (cause) { return Promise.reject(cause) }
      }
    }
  }
  get inflightCount(): number { return this.flights.size }
  assertOwners(owners: { database: DatabaseManager; manager: Controller; sync: SyncManager }): void {
    if (owners.database !== this.db || owners.manager !== this.controller || owners.sync !== this.sync || this.closing) throw new Error('TASK_GROUP_OWNER_UNAVAILABLE')
  }
  shutdown(): void { this.closing = true }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid task group shutdown deadline')
    this.shutdown(); let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([(async () => { while (this.flights.size) await Promise.allSettled([...this.flights]) })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('TASK_GROUP_DRAIN_INCOMPLETE')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  withRequestGuard<T>(effect: () => T | Promise<T>, beforeEffect: () => void, signal: AbortSignal): Promise<T> {
    const parent = this.requests.getStore(), scope: RequestScope = { beforeEffect: () => { if (parent && !parent.active) throw new Error('TASK_GROUP_REQUEST_INACTIVE'); if (parent?.signal.aborted) throw new Error('TASK_GROUP_CANCELLED'); parent?.beforeEffect(); beforeEffect() }, signal, pending: new Set(), active: true }
    const raw = this.requests.run(scope, async () => {
      try {
        let value: T | undefined, failure: unknown, failed = false
        try { this.current(); value = await effect() } catch (cause) { failure = cause; failed = true }
        while (scope.pending.size) await Promise.allSettled([...scope.pending])
        this.current(); if (failed) throw failure
        return value as T
      } finally { scope.active = false }
    })
    return this.retain(raw)
  }
  private current(): void {
    if (this.closing) throw new Error('TASK_GROUP_CLOSED')
    const scope = this.requests.getStore()
    if (scope && !scope.active) throw new Error('TASK_GROUP_REQUEST_INACTIVE')
    if (scope?.signal.aborted) throw new Error('TASK_GROUP_CANCELLED')
    scope?.beforeEffect()
  }
  private retain<T>(raw: Promise<T>): Promise<T> {
    this.flights.add(raw); const pending = this.requests.getStore()?.pending; pending?.add(raw)
    const done = () => { this.flights.delete(raw); pending?.delete(raw) }; void raw.then(done, done); return raw
  }
  private async awaited<T>(effect: () => Promise<T>): Promise<T> {
    this.current(); const value = await this.retain(effect()); this.current(); return value
  }

  list(projectId: string, includeDissolved = false): TaskGroupRecord[] {
    this.current()
    if (typeof projectId !== 'string' || !this.db.getProject(projectId)) throw new Error('Project not found.')
    return this.db.listTaskGroups(projectId, includeDissolved)
  }

  get(id: string): TaskGroupSnapshot<TaskRecord> {
    this.current()
    const group = this.required(id)
    const task = this.db.getTask(group.execution_task_id)
    if (!task) throw new Error('The shared task-group transcript is unavailable.')
    return { group, task, members: this.db.getTaskGroupMembers(id, true) }
  }

  history(taskId: string): TaskGroupRecord[] {
    this.current()
    if (typeof taskId !== 'string' || !this.db.getTask(taskId)) throw new Error('Task not found.')
    return this.db.getTaskGroupHistory(taskId)
  }

  async create(data: CreateTaskGroupData): Promise<TaskGroupRecord> {
    if (!data || !Array.isArray(data.task_ids)) throw new Error('Select the tasks to group.')
    return this.controller.runTaskGroupMutation(data.task_ids, async () => {
      this.current()
      for (const taskId of data.task_ids) if (this.controller.hasTaskStartOwnership(taskId))
        throw new Error('Stop the selected tasks before grouping them.')
      this.current(); const group = this.db.createTaskGroup(data)
      this.changed(group)
      return group
    })
  }

  async add(id: string, taskIds: string[]): Promise<TaskGroupRecord> {
    const group = this.active(id)
    if (!Array.isArray(taskIds)) throw new Error('Select tasks to add.')
    return this.controller.runTaskGroupMutation([group.execution_task_id, ...group.task_ids, ...taskIds], async () => {
      this.current()
      this.assertInactive(this.active(id))
      for (const taskId of taskIds) if (this.controller.hasTaskStartOwnership(taskId))
        throw new Error('Stop the selected tasks before adding them to a group.')
      await this.awaited(() => this.controller.retireTaskGroupContext(group.execution_task_id))
      const updated = this.db.addTasksToGroup(id, taskIds)
      this.changed(updated)
      return updated
    })
  }

  async remove(id: string, taskId: string): Promise<TaskGroupRecord> {
    const group = this.active(id)
    if (!group.task_ids.includes(taskId)) throw new Error('This task is not a current group member.')
    return this.controller.runTaskGroupMutation([group.execution_task_id, ...group.task_ids], async () => {
      this.current()
      this.assertInactive(this.active(id))
      await this.awaited(() => this.controller.retireTaskGroupContext(group.execution_task_id))
      const updated = this.db.removeTaskFromGroup(id, taskId)
      this.changed(updated, [taskId])
      return updated
    })
  }

  async dissolve(id: string): Promise<TaskGroupRecord> {
    const group = this.active(id)
    return this.controller.runTaskGroupMutation([group.execution_task_id, ...group.task_ids], async () => {
      this.current()
      this.assertInactive(this.active(id))
      await this.awaited(() => this.controller.retireTaskGroupContext(group.execution_task_id))
      const updated = this.db.dissolveTaskGroup(id)
      this.changed(updated, group.task_ids)
      return updated
    })
  }

  async move(id: string, status: string): Promise<TaskGroupRecord> {
    const group = this.active(id)
    if (status === TaskStatus.AgentWorking) {
      await this.awaited(() => this.controller.startTask(group.execution_task_id, { resumeManualStop: true, explicitUserStart: true, allowTriage: false }))
    } else if (status === TaskStatus.Completed) {
      const result = await this.awaited(() => this.review({ group_id: id, action: 'approve', complete_at_source: true }))
      if (result.failures.length) throw new Error(result.failures.map(failure => failure.message).join('\n'))
    } else if (status === TaskStatus.NotStarted || status === TaskStatus.ReadyForReview) {
      await this.awaited(() => this.controller.stopByTaskId(group.execution_task_id))
      await this.awaited(() => this.controller.runTaskGroupMutation([group.execution_task_id, ...group.task_ids], async () => {
        this.current()
        if (this.controller.hasTaskStartOwnership(group.execution_task_id)) throw new Error('The group is still stopping.')
        this.db.updateTask(group.execution_task_id, { status }, 'task-group')
        this.changed(this.active(id))
      }))
    } else throw new Error('Task groups support Not started, Working, Ready for review and Completed.')
    return this.required(id)
  }

  async review(data: TaskGroupReviewData): Promise<TaskGroupReviewResult> {
    if (!data || !['approve', 'send_back'].includes(data.action)) throw new Error('Select a group review action.')
    if (data.complete_at_source !== undefined && typeof data.complete_at_source !== 'boolean') throw new Error('Select a source completion option.')
    if (data.message !== undefined && (typeof data.message !== 'string' || data.message.length > 4000)) throw new Error('Keep group review feedback within 4,000 characters.')
    const group = this.active(data.group_id)
    let continuation: string | null = null
    const result = await this.controller.runTaskGroupMutation([group.execution_task_id, ...group.task_ids], async () => {
      this.current()
      const current = this.active(group.id)
      this.assertInactive(current)
      const members = this.db.getTaskGroupMembers(current.id).filter(task => task.status !== TaskStatus.Completed)
      const ids = data.task_ids ?? members.map(task => task.id)
      if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !members.some(task => task.id === id)))
        throw new Error('Select current unfinished group members to review.')
      const selected = members.filter(task => ids.includes(task.id))
      if (selected.some(task => task.status !== TaskStatus.ReadyForReview)) throw new Error('The selected tasks must be ready for review.')
      if (data.action === 'send_back') {
        for (const task of selected) { this.current(); this.db.updateTask(task.id, { status: TaskStatus.NotStarted }, 'task-group') }
        this.current()
        this.db.updateTask(current.execution_task_id, { status: TaskStatus.NotStarted }, 'task-group')
        continuation = `Rework only these group tasks: ${selected.map(task => `${task.title} (id: ${task.id})`).join(', ')}.\n`
          + `Preserve other members already in review or completed.\n${data.message?.trim() || 'Address the review findings, verify the affected work and report progress per task.'}`
        this.changed(this.required(current.id))
        return { group: this.required(current.id), completed_task_ids: [], failures: [] }
      }
      // Release an idle backend with acknowledgement before source effects.
      // This preserves review state; an explicit Stop resets the whole group.
      const live = this.controller.findSessionByTaskId(current.execution_task_id)
      if (live) await this.awaited(() => this.controller.stopSession(live.sessionId, false, true))
      const completed: string[] = []
      const failures: TaskGroupReviewResult['failures'] = []
      for (const member of selected) {
        try {
          this.current()
          if (member.source_id && data.complete_at_source !== false) {
            if (!this.sync) throw new Error('Task source is unavailable.')
            const accepted = await this.awaited(() => this.sync!.executeAction(getTaskCompletionAction(member.output_fields), member, undefined, member.source_id!, 'task-group', { beforeEffect: () => this.current(), beforeLocalWrite: () => this.current() }))
            if (!accepted.success) throw new Error(this.requests.getStore() ? 'Source completion failed.' : accepted.error || 'Source completion failed.')
          }
          this.current()
          this.db.updateTask(member.id, { status: TaskStatus.Completed, complete_at_source: data.complete_at_source !== false,
            ...(data.message ? { resolution: data.message } : {}) }, 'task-group')
          completed.push(member.id)
        } catch (error) {
          this.current()
          failures.push({ task_id: member.id, message: this.requests.getStore() ? 'Source completion failed.' : error instanceof Error ? error.message : String(error) })
        }
      }
      this.current(); const remaining = this.db.getTaskGroupMembers(current.id).some(task => task.status !== TaskStatus.Completed)
      this.db.updateTask(current.execution_task_id, { status: remaining ? TaskStatus.ReadyForReview : TaskStatus.Completed }, 'task-group')
      this.changed(this.required(current.id))
      return { group: this.required(current.id), completed_task_ids: completed, failures }
    })
    // A new explicit review instruction uses normal durable delivery after
    // withdrawing the mutation fence, never recursively inside its send lock.
    if (continuation) await this.awaited(() => this.controller.sendByTaskId(group.execution_task_id, continuation!))
    return { ...result, group: this.required(group.id) }
  }

  report(id: string, taskId: string, state: TaskGroupProgressState, message: string, ownerTaskId?: string): TaskGroupRecord {
    const group = this.active(id)
    const live = this.controller.findSessionByTaskId(group.execution_task_id)
    if (ownerTaskId !== group.execution_task_id || !live || live.session.agentId !== group.agent_id
      || live.sessionId !== this.db.getTask(group.execution_task_id)?.session_id
      || !['working', 'waiting_approval'].includes(live.session.status)) throw new Error('Only the active group execution session may report progress.')
    if (!group.task_ids.includes(taskId) || this.db.getTask(taskId)?.status === TaskStatus.Completed)
      throw new Error('Select an unfinished current group member.')
    this.current(); const updated = this.db.setTaskGroupProgress(id, taskId, state, message)
    this.changed(updated)
    return updated
  }

  private required(id: string): TaskGroupRecord {
    this.current()
    const group = typeof id === 'string' ? this.db.getTaskGroup(id) : undefined
    if (!group) throw new Error('Task group not found.')
    return group
  }

  private active(id: string): TaskGroupRecord {
    const group = this.required(id)
    if (group.state !== 'active') throw new Error('This group was dissolved. Its transcript remains available.')
    return group
  }

  private assertInactive(group: TaskGroupRecord): void {
    const live = this.controller.findSessionByTaskId(group.execution_task_id)
    if (live && ['working', 'waiting_approval'].includes(live.session.status)
      || !live && this.controller.hasTaskStartOwnership(group.execution_task_id)
      || [TaskStatus.AgentWorking, TaskStatus.Triaging, TaskStatus.AgentLearning].includes(group.status as TaskStatus))
      throw new Error('Stop the group before changing its members or reviewing it.')
  }

  private changed(group: TaskGroupRecord, extraIds: string[] = []): void {
    this.current()
    for (const taskId of new Set([group.execution_task_id, ...group.task_ids, ...extraIds])) {
      const task = this.db.getTask(taskId)
      if (task) {
        this.current()
        try { this.notify('task:updated', { taskId, updates: task }) } catch { /* Observer failure cannot repeat an accepted mutation. */ }
      }
    }
    try { this.notify('tasks:refresh', { projectId: group.project_id }) } catch { /* Durable changes remain authoritative. */ }
  }
}
