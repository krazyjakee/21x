import { setTimeout as sleep } from 'timers/promises'
import type { CreateTaskData, DatabaseManager, TaskRecord, UpdateTaskData } from '../database'
import type { TaskRow } from '../database/types'
import { deserializeTask } from '../database/serializers'
import { TaskStatus } from '../../shared/constants'
import { buildSimilarTasksQuery } from '../task-search'
import { afterTaskCreated, afterTaskUpdated, triggerTaskAutomation } from '../task-updates'
import { agentController, notifyRenderer } from './state'

type ApiTask = Record<string, unknown>

/**
 * The task shape this API has always returned: the row's JSON array columns
 * parsed, and flags left as 0/1.
 */
function toApiTask(task: TaskRecord): ApiTask {
  const flag = (value: boolean): number => (value ? 1 : 0)
  return {
    ...task,
    skill_ids: task.skill_ids ?? [],
    recurrence_pattern: task.recurrence_pattern == null || typeof task.recurrence_pattern === 'string'
      ? task.recurrence_pattern
      : JSON.stringify(task.recurrence_pattern),
    is_recurring: flag(task.is_recurring),
    heartbeat_enabled: flag(task.heartbeat_enabled),
    auto_start_agent: flag(task.auto_start_agent),
    auto_complete_without_review: flag(task.auto_complete_without_review),
    complete_at_source: task.complete_at_source == null ? null : flag(task.complete_at_source)
  }
}

function rowToApiTask(row: TaskRow): ApiTask {
  return toApiTask(deserializeTask(row))
}

/** db.createTask has no agent/skill columns, so those are applied as a follow-up write. */
function createTask(db: DatabaseManager, data: CreateTaskData, params: Record<string, unknown>): TaskRecord | undefined {
  const created = db.createTask(data)
  if (!created) return undefined
  const assignment: UpdateTaskData = {}
  if (params.agent_id) assignment.agent_id = params.agent_id as string
  if (params.skill_ids) assignment.skill_ids = params.skill_ids as string[]
  if (Object.keys(assignment).length > 0) db.updateTask(created.id, assignment)
  afterTaskCreated(created)
  const task = db.getTask(created.id)
  if (task) notifyRenderer?.('task:created', { task })
  return task
}

function listTasks(db: DatabaseManager, params: Record<string, unknown>): ApiTask[] {
  // Recurring parent templates are not actionable tasks.
  let query = 'SELECT * FROM tasks WHERE NOT (is_recurring = 1 AND recurrence_parent_id IS NULL)'
  const qParams: unknown[] = []

  if (params.status) { query += ' AND status = ?'; qParams.push(params.status) }
  if (params.priority) { query += ' AND priority = ?'; qParams.push(params.priority) }
  if (params.has_agent !== undefined) {
    query += params.has_agent ? ' AND agent_id IS NOT NULL' : ' AND agent_id IS NULL'
  }
  if (params.agent_id) { query += ' AND agent_id = ?'; qParams.push(params.agent_id) }
  const labels = params.labels as string[] | undefined
  if (labels?.length) {
    query += ` AND (${labels.map(() => 'labels LIKE ?').join(' OR ')})`
    labels.forEach((l) => qParams.push(`%"${l}"%`))
  }

  query += ' ORDER BY created_at DESC'
  if (params.limit) { query += ' LIMIT ?'; qParams.push(params.limit) }

  return (db.db.prepare(query).all(...qParams) as TaskRow[]).map(rowToApiTask)
}

function findSimilarTasks(db: DatabaseManager, params: Record<string, unknown>): ApiTask[] {
  const limit = (params.limit as number) || 10
  // Stemming and synonym expansion happen in here, so near-miss wording still
  // finds the relevant history. See task-search.ts.
  const query = buildSimilarTasksQuery(params)

  if (!query) {
    // No keywords at all: recent tasks.
    const status = params.completed_only ? ' WHERE status = ?' : ''
    const rows = db.db.prepare(`SELECT * FROM tasks${status} ORDER BY created_at DESC LIMIT ?`)
      .all(...(params.completed_only ? ['completed'] : []), limit) as TaskRow[]
    return rows.map(rowToApiTask)
  }

  // Tasks matching the caller's literal wording sort ahead of ones found only
  // through a synonym, because BM25 scores the two alike and would otherwise
  // let a loose match crowd a real one out of the limit. Ranking stays BM25
  // within each tier.
  const tier = query.exactMatch
    ? `CASE WHEN tasks_fts.rowid IN
         (SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH ?) THEN 0 ELSE 1 END`
    : '0'
  const selectClause = `
    SELECT t.*, bm25(tasks_fts, 10.0, 5.0, 2.0, 1.0) AS rank, ${tier} AS exact_tier
    FROM tasks_fts
    JOIN tasks t ON tasks_fts.rowid = t.rowid
    WHERE tasks_fts MATCH ?`
  // Bind order follows the SQL text: the tier subquery precedes the WHERE.
  const baseParams: unknown[] = query.exactMatch ? [query.exactMatch, query.match] : [query.match]
  const run = (completedOnly: boolean): TaskRow[] =>
    db.db.prepare(`${selectClause}${completedOnly ? ' AND t.status = ?' : ''} ORDER BY exact_tier, rank LIMIT ?`)
      .all(...baseParams, ...(completedOnly ? ['completed'] : []), limit) as TaskRow[]

  let rows = run(!!params.completed_only)
  // Nothing completed matched: fall back to every status.
  if (rows.length === 0 && params.completed_only) rows = run(false)
  return rows.map(rowToApiTask)
}

function getTaskStatistics(db: DatabaseManager, metric: unknown): unknown {
  switch (metric) {
    case 'label_usage': {
      const rows = db.db.prepare('SELECT labels FROM tasks').all() as Array<{ labels: string | null }>
      const counts = new Map<string, number>()
      rows.forEach((row) => {
        JSON.parse(row.labels || '[]').forEach((l: string) => counts.set(l, (counts.get(l) || 0) + 1))
      })
      return Object.fromEntries(Array.from(counts.entries()).sort((a, b) => b[1] - a[1]))
    }
    case 'agent_workload':
      return db.db.prepare(`
        SELECT agent_id, COUNT(*) as task_count,
               SUM(CASE WHEN status = 'agent_working' THEN 1 ELSE 0 END) as active_count
        FROM tasks WHERE agent_id IS NOT NULL GROUP BY agent_id
      `).all()
    case 'priority_distribution': {
      const dist = db.db.prepare('SELECT priority, COUNT(*) as count FROM tasks GROUP BY priority').all() as Array<{ priority: string; count: number }>
      return Object.fromEntries(dist.map((d) => [d.priority, d.count]))
    }
    case 'completion_rate': {
      const stats = db.db.prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
               SUM(CASE WHEN status = 'agent_working' THEN 1 ELSE 0 END) as in_progress,
               SUM(CASE WHEN status = 'not_started' THEN 1 ELSE 0 END) as not_started
        FROM tasks
      `).get() as { total: number; completed: number; in_progress: number; not_started: number }
      return { ...stats, completion_rate: stats.total > 0 ? (stats.completed / stats.total * 100).toFixed(1) + '%' : '0%' }
    }
    default:
      return { error: 'Unknown metric' }
  }
}

function updateTask(db: DatabaseManager, params: Record<string, unknown>): unknown {
  const taskId = params.task_id as string
  const current = db.getTask(taskId)
  if (!current) return { error: 'Task not found' }

  const data: UpdateTaskData = {}
  // 'in_progress' is the legacy name for 'agent_working'
  const status = params.status === 'in_progress' ? TaskStatus.AgentWorking : params.status
  // A triage agent must not move its own task; transitionToIdle sets the
  // status once triage ends. Other fields (agent, labels, repos) still apply.
  if (status && current.status !== TaskStatus.Triaging) data.status = status as TaskStatus

  if (params.title !== undefined) {
    const title = typeof params.title === 'string' ? params.title.trim() : ''
    if (!title) return { error: 'Title cannot be empty' }
    data.title = title
  }
  if (params.description !== undefined) data.description = params.description as string
  if (params.resolution !== undefined) data.resolution = params.resolution as string
  if (params.attachments !== undefined) data.attachments = params.attachments as UpdateTaskData['attachments']
  if (params.labels !== undefined) data.labels = params.labels as string[]
  if (params.skill_ids !== undefined) data.skill_ids = params.skill_ids as string[]
  if (params.agent_id !== undefined) data.agent_id = params.agent_id as string | null
  // These let a caller with no window hand a task to its agent, or let it finish by itself.
  if (params.auto_start_agent !== undefined) data.auto_start_agent = params.auto_start_agent === true
  if (params.auto_complete_without_review !== undefined) {
    data.auto_complete_without_review = params.auto_complete_without_review === true
  }
  if (params.repos !== undefined) {
    data.repos = Array.isArray(params.repos)
      ? params.repos
      : (typeof params.repos === 'string' && params.repos.length > 0 ? [params.repos] : [])
  }
  if (params.priority) data.priority = params.priority as UpdateTaskData['priority']
  if (params.output_fields !== undefined) data.output_fields = params.output_fields as UpdateTaskData['output_fields']

  if (Object.keys(data).length === 0) return { error: 'No updates provided' }

  // One write through DatabaseManager so its status rules (source-confirmed
  // completion, agent-learning hold, locally closed tasks) always apply.
  let updated: TaskRecord | undefined
  try {
    updated = db.updateTask(taskId, data)
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Task update refused' }
  }
  if (!updated) return { error: 'Task not found' }

  notifyRenderer?.('task:updated', { taskId, updates: updated })
  afterTaskUpdated(db, agentController, current, data, updated)
  return { success: true, task: toApiTask(updated) }
}

function createSubtask(db: DatabaseManager, params: Record<string, unknown>): unknown {
  if (!params.parent_task_id) return { error: 'parent_task_id is required' }
  if (!params.title) return { error: 'title is required' }
  const parent = db.getTask(String(params.parent_task_id))
  if (!parent) return { error: 'Parent task not found' }

  const subtask = createTask(db, {
    title: String(params.title),
    description: (params.description as string) || '',
    type: (params.type as string) || 'general',
    priority: (params.priority as string) || parent.priority || 'medium',
    labels: (params.labels as string[]) || [],
    repos: (params.repos as string[]) || parent.repos,
    output_fields: (params.output_fields as CreateTaskData['output_fields']) || [],
    parent_task_id: parent.id,
    // A child of a parent told to finish without review must not stop for one
    // either, or an unattended chain parks in review at the first step.
    // auto_start_agent is deliberately NOT inherited: children are started
    // through their parent, one at a time, in sort_order.
    auto_complete_without_review: params.auto_complete_without_review === undefined
      ? parent.auto_complete_without_review
      : params.auto_complete_without_review === true
  }, params)
  if (!subtask) return { error: 'Failed to create subtask' }

  // A coordinator that creates children and then stops leaves them for the
  // automation loop. Poke it now so the first child starts at once.
  triggerTaskAutomation()
  return { success: true, task: toApiTask(subtask) }
}

async function waitForSubtasks(db: DatabaseManager, params: Record<string, unknown>): Promise<unknown> {
  if (!params.parent_task_id) return { error: 'parent_task_id is required' }
  const parentId = String(params.parent_task_id)

  const timeoutMs = typeof params.timeout_ms === 'number' ? Math.max(1_000, params.timeout_ms) : 300_000
  const pollMs = 2_000
  const returnWhen = params.return_when === 'any_terminal' ? 'any_terminal' : 'all_terminal'
  const terminalStatuses = Array.isArray(params.terminal_statuses) && params.terminal_statuses.length > 0
    ? (params.terminal_statuses as string[])
    : [TaskStatus.ReadyForReview, TaskStatus.Completed]
  const targetIds = Array.isArray(params.subtask_ids) && params.subtask_ids.length > 0
    ? new Set((params.subtask_ids as string[]).map(String))
    : null

  const readSubtasks = (): TaskRecord[] => {
    const subtasks = db.getSubtasks(parentId)
    return targetIds ? subtasks.filter((task) => targetIds.has(task.id)) : subtasks
  }
  const result = (timedOut: boolean, subtasks: TaskRecord[]) => ({
    success: !timedOut,
    timed_out: timedOut,
    return_when: returnWhen,
    terminal_statuses: terminalStatuses,
    subtasks: subtasks.map(toApiTask)
  })

  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const subtasks = readSubtasks()
    const matches = subtasks.filter((task) => terminalStatuses.includes(task.status))
    const done = returnWhen === 'any_terminal' ? matches.length > 0 : matches.length === subtasks.length
    if (subtasks.length > 0 && done) return result(false, subtasks)
    await sleep(pollMs)
  }
  return result(true, readSubtasks())
}

export async function handleTaskRoute(db: DatabaseManager, route: string, params: Record<string, unknown>): Promise<unknown> {
  switch (route) {
    case '/list_tasks':
      return listTasks(db, params)

    case '/create_task': {
      if (!params.title) return { error: 'Title is required' }
      const task = createTask(db, {
        title: String(params.title),
        description: (params.description as string) || '',
        type: (params.type as string) || 'general',
        priority: (params.priority as string) || 'medium',
        assignee: (params.assignee as string) || '',
        due_date: (params.due_date as string) || null,
        labels: (params.labels as string[]) || [],
        // cron is the current field; is_recurring + recurrence_pattern the legacy pair.
        cron: (params.cron as string) || undefined,
        is_recurring: !!params.is_recurring,
        recurrence_pattern: (params.recurrence_pattern as CreateTaskData['recurrence_pattern']) || null,
        parent_task_id: (params.parent_task_id as string) || null,
        auto_start_agent: params.auto_start_agent === true,
        auto_complete_without_review: params.auto_complete_without_review === true
      }, params)
      if (!task) return { error: 'Failed to create task' }
      return { success: true, task: toApiTask(task) }
    }

    case '/get_task': {
      const task = db.getTask(String(params.task_id))
      return task ? toApiTask(task) : { error: 'Task not found' }
    }

    case '/update_task':
      return updateTask(db, params)

    case '/list_agents':
      return db.getAgents()

    case '/find_similar_tasks':
      return findSimilarTasks(db, params)

    case '/get_task_statistics':
      return getTaskStatistics(db, params.metric)

    case '/list_repos': {
      const rows = db.db.prepare('SELECT repos FROM tasks WHERE repos IS NOT NULL AND repos != \'[]\'').all() as Array<{ repos: string }>
      const repoSet = new Set<string>()
      rows.forEach((row) => {
        try {
          JSON.parse(row.repos || '[]').forEach((r: string) => repoSet.add(r))
        } catch { /* a malformed row does not hide the others */ }
      })
      return { repos: Array.from(repoSet), github_org: db.getSetting('github_org') || null }
    }

    case '/list_subtasks':
      if (!params.parent_task_id) return { error: 'parent_task_id is required' }
      return db.getSubtasks(String(params.parent_task_id)).map(toApiTask)

    case '/create_subtask':
      return createSubtask(db, params)

    case '/wait_for_subtasks':
      return waitForSubtasks(db, params)

    default:
      return undefined
  }
}
