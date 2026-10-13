import { createId } from '@paralleldrive/cuid2'
import type { DatabaseManager } from './manager'
import type { TaskRecord, UpdateTaskData } from './types'
import { TaskStatus } from '../../shared/constants'
import { TASK_ROLE_TASK_GROUP } from '../../shared/task-roles'
import { MAX_TASK_GROUP_SIZE, type CreateTaskGroupData, type TaskGroupProgressState, type TaskGroupRecord } from '../../shared/task-groups'

interface GroupRow {
  id: string; title: string; project_id: string; agent_id: string; execution_task_id: string;
  state: 'active' | 'dissolved'; created_at: string; updated_at: string
}
interface MembershipRow {
  id: string; task_id: string; position: number; joined_at: string; left_at: string | null;
  progress_state: TaskGroupProgressState; progress_message: string; progress_updated_at: string
}
const ownedStatuses = new Set<string>([TaskStatus.AgentWorking, TaskStatus.AgentLearning, TaskStatus.Triaging])
const protectedMemberFields = new Set(['status', 'agent_id', 'repos', 'skill_ids', 'session_id', 'project_id', 'group_id', 'role',
  'parent_task_id', 'next_subtask_ids', 'is_recurring', 'recurrence_pattern', 'recurrence_parent_id', 'last_occurrence_at',
  'next_occurrence_at', 'heartbeat_enabled', 'heartbeat_interval_minutes', 'heartbeat_last_check_at', 'heartbeat_next_check_at',
  'auto_start_agent', 'auto_complete_without_review', 'complete_at_source'])
const reviewFields = new Set(['status', 'resolution', 'feedback_rating', 'feedback_comment', 'complete_at_source', 'output_fields', 'priority', 'labels'])
const incompatibleAnchorFields = new Set(['repos', 'project_id', 'group_id', 'role', 'parent_task_id', 'next_subtask_ids',
  'is_recurring', 'recurrence_pattern', 'recurrence_parent_id', 'heartbeat_enabled', 'heartbeat_interval_minutes',
  'heartbeat_next_check_at', 'next_occurrence_at', 'auto_start_agent', 'auto_complete_without_review'])
const repoKey = (repos: string[]): string => JSON.stringify([...new Set(repos)].sort())

/** All changes are local transactions. Native session leases and source
 * confirmation stay with the group service, not progress reports or this store. */
export class TaskGroups {
  constructor(private readonly manager: DatabaseManager) {}
  private get db() { return this.manager.db }

  list(projectId: string, includeDissolved = false): TaskGroupRecord[] {
    return (this.db.prepare(`SELECT * FROM task_groups WHERE project_id=? ${includeDissolved ? '' : "AND state='active'"} ORDER BY created_at,id`)
      .all(projectId) as GroupRow[]).map(row => this.record(row))
  }
  get(id: string): TaskGroupRecord | undefined {
    const row = this.db.prepare('SELECT * FROM task_groups WHERE id=?').get(id) as GroupRow | undefined
    return row && this.record(row)
  }
  byTask(taskId: string): TaskGroupRecord | undefined {
    const row = this.rowByTask(taskId)
    return row && this.record(row)
  }
  private rowByTask(taskId: string): GroupRow | undefined {
    const row = this.db.prepare(`SELECT g.* FROM task_groups g WHERE g.state='active' AND
      (g.execution_task_id=? OR g.id=(SELECT group_id FROM task_group_memberships WHERE task_id=? AND left_at IS NULL))`)
      .get(taskId, taskId) as GroupRow | undefined
    return row
  }
  history(taskId: string): TaskGroupRecord[] {
    return (this.db.prepare(`SELECT g.* FROM task_groups g WHERE g.execution_task_id=? OR EXISTS
      (SELECT 1 FROM task_group_memberships m WHERE m.group_id=g.id AND m.task_id=?) ORDER BY g.created_at,g.id`)
      .all(taskId, taskId) as GroupRow[]).map(row => this.record(row))
  }
  members(id: string, includeFormer = false): TaskRecord[] {
    const rows = this.db.prepare(`SELECT task_id FROM task_group_memberships WHERE group_id=? ${includeFormer ? '' : 'AND left_at IS NULL'} ORDER BY position,joined_at,id`)
      .all(id) as Array<{ task_id: string }>
    return [...new Set(rows.map(row => row.task_id))].map(taskId => this.manager.getTask(taskId)).filter((task): task is TaskRecord => !!task)
  }
  execution(taskId: string): TaskRecord | undefined {
    const group = this.rowByTask(taskId)
    return group && this.manager.getTask(group.execution_task_id)
  }

  create(data: CreateTaskGroupData): TaskGroupRecord {
    return this.db.transaction(() => {
      const ids = this.ids(data.task_ids, 2)
      const title = this.title(data.title)
      const members = ids.map(id => this.eligible(id))
      const first = members[0]
      const assigned = new Set(members.map(task => task.agent_id))
      if (assigned.size !== 1) throw new Error('Task group members must have the same assignment, or all be unassigned.')
      this.compatible(members, first.project_id, first.repos)
      const project = this.manager.getProject(first.project_id)
      const agentId = data.agent_id ?? first.agent_id ?? project?.default_agent_id ?? this.manager.getSetting('default_agent_id')
        ?? this.manager.getAgents().find(agent => agent.is_default)?.id ?? this.manager.getAgents()[0]?.id
      if (!agentId || !this.manager.getAgent(agentId)) throw new Error('Choose an available agent for this task group.')
      if (first.agent_id && first.agent_id !== agentId) throw new Error('Task group agent must match the member assignment.')
      const id = createId(), now = new Date().toISOString()
      const anchor = this.manager.createTask({ title, description: this.description(members), repos: first.repos,
        project_id: first.project_id, priority: first.priority, role: TASK_ROLE_TASK_GROUP })!
      this.db.prepare('INSERT INTO task_groups (id,title,project_id,agent_id,execution_task_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, title, first.project_id, agentId, anchor.id, now, now)
      this.db.prepare('UPDATE tasks SET agent_id=?, skill_ids=?, group_id=? WHERE id=?')
        .run(agentId, JSON.stringify(this.skills(members)), id, anchor.id)
      members.forEach((member, position) => this.join(id, member.id, position, now))
      return this.get(id)!
    })()
  }
  add(id: string, taskIds: string[]): TaskGroupRecord {
    return this.db.transaction(() => {
      const group = this.editable(id)
      const ids = this.ids(taskIds, 1)
      if (group.task_ids.length + ids.length > MAX_TASK_GROUP_SIZE) throw new Error(`A task group holds at most ${MAX_TASK_GROUP_SIZE} tasks.`)
      const members = ids.map(taskId => this.eligible(taskId))
      const anchor = this.manager.getTask(group.execution_task_id)!
      this.compatible(members, group.project_id, anchor.repos)
      if (members.some(task => task.agent_id && task.agent_id !== group.agent_id)) throw new Error('Task group agent must match the member assignment.')
      const now = new Date().toISOString()
      const last = this.db.prepare('SELECT COALESCE(MAX(position),-1) AS position FROM task_group_memberships WHERE group_id=?').get(id) as { position: number }
      members.forEach((member, index) => this.join(id, member.id, last.position + index + 1, now))
      this.refresh(id)
      // Newly joined work has not run. A prior review/completion cannot count
      // as evidence for that new work; completed members remain untouched.
      this.manager.updateTask(anchor.id, { status: TaskStatus.NotStarted }, 'task-group')
      return this.get(id)!
    })()
  }
  remove(id: string, taskId: string): TaskGroupRecord {
    return this.db.transaction(() => {
      const group = this.editable(id)
      if (!group.task_ids.includes(taskId)) throw new Error('This task is not a current member of the group.')
      const now = new Date().toISOString()
      this.leave(id, taskId, now)
      if (group.task_ids.length === 1) this.db.prepare("UPDATE task_groups SET state='dissolved',updated_at=? WHERE id=?").run(now, id)
      else this.refresh(id)
      return this.get(id)!
    })()
  }
  dissolve(id: string): TaskGroupRecord {
    return this.db.transaction(() => {
      const group = this.editable(id), now = new Date().toISOString()
      group.task_ids.forEach(taskId => this.leave(id, taskId, now))
      this.db.prepare("UPDATE task_groups SET state='dissolved',updated_at=? WHERE id=?").run(now, id)
      return this.get(id)!
    })()
  }
  progress(id: string, taskId: string, state: TaskGroupProgressState, message: string): TaskGroupRecord {
    return this.db.transaction(() => {
      const group = this.get(id)
      if (!group || group.state !== 'active' || !group.task_ids.includes(taskId)) throw new Error('Progress must name a current task group member.')
      if (!['pending', 'working', 'done', 'blocked'].includes(state) || typeof message !== 'string' || message.length > 4000)
        throw new Error('Task group progress requires a valid state and a message of at most 4000 characters.')
      const now = new Date().toISOString()
      this.db.prepare('UPDATE task_group_memberships SET progress_state=?,progress_message=?,progress_updated_at=? WHERE group_id=? AND task_id=? AND left_at IS NULL')
        .run(state, message, now, id, taskId)
      this.db.prepare('UPDATE task_groups SET updated_at=? WHERE id=?').run(now, id)
      return this.get(id)!
    })()
  }

  /** Called inside updateTask's transaction, before any task write. */
  guardUpdate(task: TaskRecord, data: UpdateTaskData, origin?: string): UpdateTaskData {
    const row = this.rowByTask(task.id)
    const group = row && { ...row, status: this.manager.getTask(row.execution_task_id)!.status }
    if (!group) {
      if (task.role === TASK_ROLE_TASK_GROUP && Object.keys(data).some(key => incompatibleAnchorFields.has(key)))
        throw new Error('The retained group execution task cannot become an ordinary task.')
      return data
    }
    const keys = Object.keys(data).filter(key => data[key as keyof UpdateTaskData] !== undefined)
    if (task.id === group.execution_task_id) {
      if (keys.some(key => incompatibleAnchorFields.has(key))) throw new Error('Change the task group through its group controls.')
      if (data.status === TaskStatus.Triaging) throw new Error('A task group already has an execution agent and cannot enter auto-triage.')
      if (data.status === TaskStatus.Completed && this.members(group.id).some(member => member.status !== TaskStatus.Completed))
        throw new Error('Review every unfinished member before completing the task group.')
      if (data.agent_id !== undefined && (!data.agent_id || !this.manager.getAgent(data.agent_id))) throw new Error('A task group requires an available agent.')
      return data
    }
    let next = data
    if (task.status === TaskStatus.Completed && origin === 'task-source' && data.status !== undefined && data.status !== TaskStatus.Completed) {
      next = { ...data }; delete next.status
    }
    const changes = Object.keys(next).filter(key => next[key as keyof UpdateTaskData] !== undefined)
    if (origin === 'task-group') {
      if (changes.some(key => !reviewFields.has(key))) throw new Error('Group review may only change member review and completion fields.')
      if (task.status === TaskStatus.Completed && next.status !== undefined && next.status !== TaskStatus.Completed)
        throw new Error('A completed group member remains completed; remove it before reopening it.')
    } else if (changes.some(key => protectedMemberFields.has(key) && JSON.stringify(next[key as keyof UpdateTaskData]) !== JSON.stringify(task[key as keyof TaskRecord]))) throw new Error('Change grouped task lifecycle and assignment through its group controls.')
    if (ownedStatuses.has(group.status) && changes.some(key => ['title', 'description'].includes(key))) throw new Error('Stop the task group before editing its work instructions.')
    return next
  }

  /** Same transaction as the anchor lifecycle write. Members never acquire
   * native session ownership; completion comes only from individual review. */
  afterUpdate(task: TaskRecord, data: UpdateTaskData, origin?: string): void {
    const group = this.rowByTask(task.id)
    if (!group) return
    if (task.id === group.execution_task_id) {
      const now = new Date().toISOString()
      if (data.status !== undefined) {
        const pending = this.members(group.id).some(member => member.status === TaskStatus.NotStarted)
        const selectedWork = data.status === TaskStatus.AgentWorking && (pending || task.status === TaskStatus.AgentWorking)
          || data.status === TaskStatus.NotStarted && origin === 'task-group' && pending
        const selection = selectedWork ? "AND status IN ('not_started','agent_working','agent_learning','triaging')" : ''
        this.db.prepare(`UPDATE tasks SET status=?,session_id=NULL,updated_at=? WHERE group_id=? AND id<>? AND status<>? ${selection}`)
          .run(data.status, now, group.id, task.id, TaskStatus.Completed)
      }
      if (data.agent_id) {
        this.db.prepare('UPDATE task_groups SET agent_id=? WHERE id=?').run(data.agent_id, group.id)
        this.db.prepare('UPDATE tasks SET agent_id=?,updated_at=? WHERE group_id=? AND id<>? AND status<>?')
          .run(data.agent_id, now, group.id, task.id, TaskStatus.Completed)
      }
      if (data.title !== undefined) this.db.prepare('UPDATE task_groups SET title=? WHERE id=?').run(this.title(data.title), group.id)
      this.db.prepare('UPDATE task_groups SET updated_at=? WHERE id=?').run(now, group.id)
    } else if (data.title !== undefined || data.description !== undefined || data.status !== undefined) this.refresh(group.id)
  }

  private eligible(taskId: string): TaskRecord {
    const task = this.manager.getTask(taskId)
    if (!task || task.role !== 'task' || task.group_id || task.status !== TaskStatus.NotStarted || task.session_id || task.parent_task_id
      || task.next_subtask_ids.length || task.is_recurring || task.recurrence_pattern || task.recurrence_parent_id || task.heartbeat_enabled
      || this.db.prepare('SELECT 1 FROM tasks WHERE parent_task_id=? OR recurrence_parent_id=? LIMIT 1').get(taskId, taskId))
      throw new Error(`Only ordinary, unstarted root tasks without sessions, dependencies, recurrence or heartbeat may join: ${taskId}`)
    return task
  }
  private compatible(tasks: TaskRecord[], projectId: string, repos: string[]): void {
    if (tasks.some(task => task.project_id !== projectId || repoKey(task.repos) !== repoKey(repos))) throw new Error('Task group members must share one project and exactly the same repositories.')
  }
  private editable(id: string): TaskGroupRecord {
    const group = this.get(id)
    if (!group || group.state !== 'active') throw new Error('Task group is missing or dissolved.')
    if (ownedStatuses.has(group.status)) throw new Error('Stop the task group before changing its members.')
    return group
  }
  private ids(ids: string[], minimum: number): string[] {
    if (!Array.isArray(ids) || ids.length < minimum || ids.length > MAX_TASK_GROUP_SIZE || ids.some(id => typeof id !== 'string' || !id)
      || new Set(ids).size !== ids.length) throw new Error(`Choose ${minimum}–${MAX_TASK_GROUP_SIZE} distinct tasks for the group.`)
    return ids
  }
  private title(value: string): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) throw new Error('Task group title must contain 1–200 characters.')
    return value.trim()
  }
  private skills(tasks: TaskRecord[]): string[] { return [...new Set(tasks.flatMap(task => task.skill_ids ?? []))] }
  private description(tasks: TaskRecord[]): string {
    return 'Complete these small tasks in one shared session. Report progress for each member ID. Progress is not human approval; do not close source tasks or repeat completed work.\n\n'
      + tasks.map(task => `## ${task.title}\nTask ID: ${task.id}\nStatus: ${task.status}\n${task.description}`).join('\n\n')
  }
  private join(groupId: string, taskId: string, position: number, now: string): void {
    this.db.prepare('INSERT INTO task_group_memberships (id,group_id,task_id,position,joined_at,progress_updated_at) VALUES (?,?,?,?,?,?)')
      .run(createId(), groupId, taskId, position, now, now)
    this.db.prepare('UPDATE tasks SET group_id=?,session_id=NULL,updated_at=? WHERE id=?').run(groupId, now, taskId)
  }
  private leave(groupId: string, taskId: string, now: string): void {
    this.db.prepare('UPDATE task_group_memberships SET left_at=? WHERE group_id=? AND task_id=? AND left_at IS NULL').run(now, groupId, taskId)
    this.db.prepare('UPDATE tasks SET group_id=NULL,updated_at=? WHERE id=? AND group_id=?').run(now, taskId, groupId)
    this.db.prepare('UPDATE task_groups SET updated_at=? WHERE id=?').run(now, groupId)
  }
  private refresh(id: string): void {
    const group = this.db.prepare('SELECT * FROM task_groups WHERE id=?').get(id) as GroupRow
    const members = this.members(id), now = new Date().toISOString()
    this.db.prepare('UPDATE tasks SET description=?,skill_ids=?,updated_at=? WHERE id=?')
      .run(this.description(members), JSON.stringify(this.skills(members)), now, group.execution_task_id)
    this.db.prepare('UPDATE task_groups SET updated_at=? WHERE id=?').run(now, id)
  }
  private memberships(id: string): MembershipRow[] {
    return this.db.prepare('SELECT * FROM task_group_memberships WHERE group_id=? ORDER BY position,joined_at,id').all(id) as MembershipRow[]
  }
  private record(row: GroupRow): TaskGroupRecord {
    const memberships = this.memberships(row.id)
    const current = memberships.filter(member => member.left_at === null).map(member => member.task_id)
    const latest = new Map<string, MembershipRow>()
    for (const member of memberships) latest.set(member.task_id, member)
    return { ...row, status: this.manager.getTask(row.execution_task_id)?.status ?? TaskStatus.NotStarted, task_ids: current,
      former_task_ids: [...new Set(memberships.filter(member => member.left_at !== null && !current.includes(member.task_id)).map(member => member.task_id))],
      progress: [...latest.values()].map(member => ({ task_id: member.task_id, state: member.progress_state, message: member.progress_message, updated_at: member.progress_updated_at })) }
  }
}
