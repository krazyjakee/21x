import type { DatabaseManager, TaskRecord } from '../database'
import type { AgentManager } from '../agent-manager-core'
import type { SyncManager } from '../sync-manager'
import { TaskStatus } from '../../shared/constants'
import type { CreateTaskGroupData, TaskGroupProgressState, TaskGroupRecord, TaskGroupReviewData, TaskGroupReviewResult, TaskGroupSnapshot } from '../../shared/task-groups'
import { completeTaskAtSource } from '../session-feedback'

type Controller = Pick<AgentManager, 'runTaskGroupMutation' | 'hasTaskStartOwnership' | 'findSessionByTaskId'
  | 'retireTaskGroupContext' | 'stopSession' | 'stopByTaskId' | 'startTask' | 'sendByTaskId'>
type Notify = (channel: 'task:updated' | 'tasks:refresh', data: unknown) => void

/** User review and definition edits share the actual session owner's admission
 * fence. Progress has no completion authority and performs no source effect. */
export class TaskGroupService {
  constructor(private readonly db: DatabaseManager, private readonly controller: Controller,
    private readonly sync?: SyncManager, private readonly notify: Notify = () => {}) {}

  list(projectId: string, includeDissolved = false): TaskGroupRecord[] {
    if (typeof projectId !== 'string' || !this.db.getProject(projectId)) throw new Error('Project not found.')
    return this.db.listTaskGroups(projectId, includeDissolved)
  }

  get(id: string): TaskGroupSnapshot<TaskRecord> {
    const group = this.required(id)
    const task = this.db.getTask(group.execution_task_id)
    if (!task) throw new Error('The shared task-group transcript is unavailable.')
    return { group, task, members: this.db.getTaskGroupMembers(id, true) }
  }

  history(taskId: string): TaskGroupRecord[] {
    if (typeof taskId !== 'string' || !this.db.getTask(taskId)) throw new Error('Task not found.')
    return this.db.getTaskGroupHistory(taskId)
  }

  async create(data: CreateTaskGroupData): Promise<TaskGroupRecord> {
    if (!data || !Array.isArray(data.task_ids)) throw new Error('Select the tasks to group.')
    return this.controller.runTaskGroupMutation(data.task_ids, async () => {
      for (const taskId of data.task_ids) if (this.controller.hasTaskStartOwnership(taskId))
        throw new Error('Stop the selected tasks before grouping them.')
      const group = this.db.createTaskGroup(data)
      this.changed(group)
      return group
    })
  }

  async add(id: string, taskIds: string[]): Promise<TaskGroupRecord> {
    const group = this.active(id)
    if (!Array.isArray(taskIds)) throw new Error('Select tasks to add.')
    return this.controller.runTaskGroupMutation([group.execution_task_id, ...group.task_ids, ...taskIds], async () => {
      this.assertInactive(this.active(id))
      for (const taskId of taskIds) if (this.controller.hasTaskStartOwnership(taskId))
        throw new Error('Stop the selected tasks before adding them to a group.')
      await this.controller.retireTaskGroupContext(group.execution_task_id)
      const updated = this.db.addTasksToGroup(id, taskIds)
      this.changed(updated)
      return updated
    })
  }

  async remove(id: string, taskId: string): Promise<TaskGroupRecord> {
    const group = this.active(id)
    if (!group.task_ids.includes(taskId)) throw new Error('This task is not a current group member.')
    return this.controller.runTaskGroupMutation([group.execution_task_id, ...group.task_ids], async () => {
      this.assertInactive(this.active(id))
      await this.controller.retireTaskGroupContext(group.execution_task_id)
      const updated = this.db.removeTaskFromGroup(id, taskId)
      this.changed(updated, [taskId])
      return updated
    })
  }

  async dissolve(id: string): Promise<TaskGroupRecord> {
    const group = this.active(id)
    return this.controller.runTaskGroupMutation([group.execution_task_id, ...group.task_ids], async () => {
      this.assertInactive(this.active(id))
      await this.controller.retireTaskGroupContext(group.execution_task_id)
      const updated = this.db.dissolveTaskGroup(id)
      this.changed(updated, group.task_ids)
      return updated
    })
  }

  async move(id: string, status: string): Promise<TaskGroupRecord> {
    const group = this.active(id)
    if (status === TaskStatus.AgentWorking) {
      await this.controller.startTask(group.execution_task_id, { resumeManualStop: true, explicitUserStart: true, allowTriage: false })
    } else if (status === TaskStatus.Completed) {
      const result = await this.review({ group_id: id, action: 'approve', complete_at_source: true })
      if (result.failures.length) throw new Error(result.failures.map(failure => failure.message).join('\n'))
    } else if (status === TaskStatus.NotStarted || status === TaskStatus.ReadyForReview) {
      await this.controller.stopByTaskId(group.execution_task_id)
      await this.controller.runTaskGroupMutation([group.execution_task_id, ...group.task_ids], async () => {
        if (this.controller.hasTaskStartOwnership(group.execution_task_id)) throw new Error('The group is still stopping.')
        this.db.updateTask(group.execution_task_id, { status }, 'task-group')
        this.changed(this.active(id))
      })
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
      const current = this.active(group.id)
      this.assertInactive(current)
      const members = this.db.getTaskGroupMembers(current.id).filter(task => task.status !== TaskStatus.Completed)
      const ids = data.task_ids ?? members.map(task => task.id)
      if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !members.some(task => task.id === id)))
        throw new Error('Select current unfinished group members to review.')
      const selected = members.filter(task => ids.includes(task.id))
      if (selected.some(task => task.status !== TaskStatus.ReadyForReview)) throw new Error('The selected tasks must be ready for review.')
      if (data.action === 'send_back') {
        for (const task of selected) this.db.updateTask(task.id, { status: TaskStatus.NotStarted }, 'task-group')
        this.db.updateTask(current.execution_task_id, { status: TaskStatus.NotStarted }, 'task-group')
        continuation = `Rework only these group tasks: ${selected.map(task => `${task.title} (id: ${task.id})`).join(', ')}.\n`
          + `Preserve other members already in review or completed.\n${data.message?.trim() || 'Address the review findings, verify the affected work and report progress per task.'}`
        this.changed(this.required(current.id))
        return { group: this.required(current.id), completed_task_ids: [], failures: [] }
      }
      // Release an idle backend with acknowledgement before source effects.
      // This preserves review state; an explicit Stop resets the whole group.
      const live = this.controller.findSessionByTaskId(current.execution_task_id)
      if (live) await this.controller.stopSession(live.sessionId, false, true)
      const completed: string[] = []
      const failures: TaskGroupReviewResult['failures'] = []
      for (const member of selected) {
        try {
          if (member.source_id && data.complete_at_source !== false) await completeTaskAtSource(this.sync, member, 'task-group')
          this.db.updateTask(member.id, { status: TaskStatus.Completed, complete_at_source: data.complete_at_source !== false,
            ...(data.message ? { resolution: data.message } : {}) }, 'task-group')
          completed.push(member.id)
        } catch (error) {
          failures.push({ task_id: member.id, message: error instanceof Error ? error.message : String(error) })
        }
      }
      const remaining = this.db.getTaskGroupMembers(current.id).some(task => task.status !== TaskStatus.Completed)
      this.db.updateTask(current.execution_task_id, { status: remaining ? TaskStatus.ReadyForReview : TaskStatus.Completed }, 'task-group')
      this.changed(this.required(current.id))
      return { group: this.required(current.id), completed_task_ids: completed, failures }
    })
    // A new explicit review instruction uses normal durable delivery after
    // withdrawing the mutation fence, never recursively inside its send lock.
    if (continuation) await this.controller.sendByTaskId(group.execution_task_id, continuation)
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
    const updated = this.db.setTaskGroupProgress(id, taskId, state, message)
    this.changed(updated)
    return updated
  }

  private required(id: string): TaskGroupRecord {
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
    for (const taskId of new Set([group.execution_task_id, ...group.task_ids, ...extraIds])) {
      const task = this.db.getTask(taskId)
      if (task) {
        try { this.notify('task:updated', { taskId, updates: task }) } catch { /* Observer failure cannot repeat an accepted mutation. */ }
      }
    }
    try { this.notify('tasks:refresh', { projectId: group.project_id }) } catch { /* Durable changes remain authoritative. */ }
  }
}
