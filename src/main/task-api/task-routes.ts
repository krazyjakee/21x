import { inheritTaskAuthorization } from '../authorization'
import type { TaskMcpScope } from '../mcp-servers/task-management-core'
import { setTimeout as sleep } from 'timers/promises'
import type { CreateTaskData, DatabaseManager, TaskRecord, UpdateTaskData } from '../database'
import type { TaskRow } from '../database/types'
import { deserializeTask } from '../database/serializers'
import { userTaskRoleFilter } from '../database/task-roles'
import { TaskStatus } from '../../shared/constants'
import { buildSimilarTasksQuery } from '../task-search'
import { afterTaskCreated, afterTaskUpdated, prepareUserTaskUpdate, startPreparedTask, triggerTaskAutomation } from '../task-updates'
import { DEFAULT_PROJECT_ID } from '../../shared/projects'
import { listProjectRepos, projectGitDefaults, taskProjectId, validateProjectRepos } from '../agent-manager/project-repos'
import { deliverCaptainReport } from '../commander/report-inbox'
import { agentController, notifyRenderer } from './state'
import { validateSkillAssignment } from './skill-routes'

type ApiTask = Record<string, unknown>

/**
 * The project a list or search route is narrowed to. A project-scoped MCP
 * session always sets it (see task-management-core.ts); without it the route
 * spans every project, which only unscoped internal callers get.
 */
function projectFilter(params: Record<string, unknown>): string | undefined {
  return typeof params.project_id === 'string' && params.project_id ? params.project_id : undefined
}

/** Normalizes the `repos` param: an array, one string, or nothing. */
function reposParam(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[]
  return typeof value === 'string' && value.length > 0 ? [value] : []
}

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
function createTask(db: DatabaseManager, data: CreateTaskData, params: Record<string, unknown>, trustedScope?: TaskMcpScope): TaskRecord | undefined {
  const created = db.db.transaction(() => {
    const created = db.createTask(data)
    if (!created) return undefined
    const assignment: UpdateTaskData = {}
    if (params.agent_id) assignment.agent_id = params.agent_id as string
    if (params.skill_ids) assignment.skill_ids = params.skill_ids as string[]
    if (Object.keys(assignment).length > 0) db.updateTask(created.id, assignment)
    if (trustedScope) {
      const caller = trustedScope.taskId ?? trustedScope.artifactTaskId ?? (db.db.prepare("SELECT id FROM tasks WHERE project_id = ? AND role = 'captain'").get(trustedScope.projectId ?? '') as { id: string } | undefined)?.id
      if (caller && db.getTask(caller)?.project_id === created.project_id) {
        inheritTaskAuthorization(db, caller, created.id, JSON.stringify({ title: created.title, description: created.description, repos: created.repos }))
      }
    }
    return created
  })()
  if (!created) return undefined
  afterTaskCreated(created)
  const task = db.getTask(created.id)
  if (task) notifyRenderer?.('task:created', { task })
  return task
}

function listTasks(db: DatabaseManager, params: Record<string, unknown>): ApiTask[] {
  // Recurring parent templates are not actionable tasks, and coordinator rows
  // (the Captain) are conversations, not tasks.
  let query = `SELECT * FROM tasks WHERE NOT (is_recurring = 1 AND recurrence_parent_id IS NULL) AND ${userTaskRoleFilter()}`
  const qParams: unknown[] = []

  if (params.status) { query += ' AND status = ?'; qParams.push(params.status) }
  if (params.priority) { query += ' AND priority = ?'; qParams.push(params.priority) }
  if (params.has_agent !== undefined) {
    query += params.has_agent ? ' AND agent_id IS NOT NULL' : ' AND agent_id IS NULL'
  }
  if (params.agent_id) { query += ' AND agent_id = ?'; qParams.push(params.agent_id) }
  const projectId = projectFilter(params)
  if (projectId) { query += ' AND project_id = ?'; qParams.push(projectId) }
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
  const projectId = projectFilter(params)
  // Stemming and synonym expansion happen in here, so near-miss wording still
  // finds the relevant history. See task-search.ts.
  const query = buildSimilarTasksQuery(params)

  if (!query) {
    // No keywords at all: recent tasks.
    const status = params.completed_only ? ' AND status = ?' : ''
    const project = projectId ? ' AND project_id = ?' : ''
    const rows = db.db.prepare(`SELECT * FROM tasks WHERE ${userTaskRoleFilter()}${status}${project} ORDER BY created_at DESC LIMIT ?`)
      .all(...(params.completed_only ? ['completed'] : []), ...(projectId ? [projectId] : []), limit) as TaskRow[]
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
    WHERE tasks_fts MATCH ? AND ${userTaskRoleFilter('t.role')}${projectId ? ' AND t.project_id = ?' : ''}`
  // Bind order follows the SQL text: the tier subquery precedes the WHERE.
  const baseParams: unknown[] = query.exactMatch ? [query.exactMatch, query.match] : [query.match]
  if (projectId) baseParams.push(projectId)
  const run = (completedOnly: boolean): TaskRow[] =>
    db.db.prepare(`${selectClause}${completedOnly ? ' AND t.status = ?' : ''} ORDER BY exact_tier, rank LIMIT ?`)
      .all(...baseParams, ...(completedOnly ? ['completed'] : []), limit) as TaskRow[]

  let rows = run(!!params.completed_only)
  // Nothing completed matched: fall back to every status.
  if (rows.length === 0 && params.completed_only) rows = run(false)
  return rows.map(rowToApiTask)
}

function getTaskStatistics(db: DatabaseManager, metric: unknown, projectId?: string): unknown {
  // Every metric counts the user's tasks, in one project when scoped.
  const where = `${userTaskRoleFilter()}${projectId ? ' AND project_id = ?' : ''}`
  const args = projectId ? [projectId] : []
  switch (metric) {
    case 'label_usage': {
      const rows = db.db.prepare(`SELECT labels FROM tasks WHERE ${where}`).all(...args) as Array<{ labels: string | null }>
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
        FROM tasks WHERE agent_id IS NOT NULL AND ${where} GROUP BY agent_id
      `).all(...args)
    case 'priority_distribution': {
      const dist = db.db.prepare(`SELECT priority, COUNT(*) as count FROM tasks WHERE ${where} GROUP BY priority`).all(...args) as Array<{ priority: string; count: number }>
      return Object.fromEntries(dist.map((d) => [d.priority, d.count]))
    }
    case 'completion_rate': {
      const stats = db.db.prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
               SUM(CASE WHEN status = 'agent_working' THEN 1 ELSE 0 END) as in_progress,
               SUM(CASE WHEN status = 'not_started' THEN 1 ELSE 0 END) as not_started
        FROM tasks WHERE ${where}
      `).get(...args) as { total: number; completed: number; in_progress: number; not_started: number }
      return { ...stats, completion_rate: stats.total > 0 ? (stats.completed / stats.total * 100).toFixed(1) + '%' : '0%' }
    }
    default:
      return { error: 'Unknown metric' }
  }
}

async function updateTask(db: DatabaseManager, params: Record<string, unknown>): Promise<unknown> {
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
  if (params.skill_ids !== undefined) {
    // #74: only global skills and the task's own project's may be assigned.
    const badSkills = validateSkillAssignment(db, params.skill_ids, taskProjectId(current))
    if (badSkills) return badSkills
    data.skill_ids = params.skill_ids as string[]
  }
  if (params.agent_id !== undefined) data.agent_id = params.agent_id as string | null
  // These let a caller with no window hand a task to its agent, or let it finish by itself.
  if (params.auto_start_agent !== undefined) data.auto_start_agent = params.auto_start_agent === true
  if (params.auto_complete_without_review !== undefined) {
    data.auto_complete_without_review = params.auto_complete_without_review === true
  }
  if (params.repos !== undefined) {
    // Repos must belong to the task's project. Ones the task already carries
    // (set in the UI or by a task source) stay allowed.
    const checked = validateProjectRepos(db, taskProjectId(current), reposParam(params.repos), current.repos ?? [])
    if ('error' in checked) return checked
    data.repos = checked.repos
  }
  if (params.priority) data.priority = params.priority as UpdateTaskData['priority']
  if (params.output_fields !== undefined) data.output_fields = params.output_fields as UpdateTaskData['output_fields']
  if (params.next_subtask_ids !== undefined) {
    if (!Array.isArray(params.next_subtask_ids)) return { error: 'next_subtask_ids must be an array' }
    data.next_subtask_ids = params.next_subtask_ids as string[]
  }

  if (Object.keys(data).length === 0) return { error: 'No updates provided' }

  // One write through DatabaseManager so its status rules (source-confirmed
  // completion, agent-learning hold, locally closed tasks) always apply.
  let updated: TaskRecord | undefined
  let prepared: Awaited<ReturnType<typeof prepareUserTaskUpdate>>
  try {
    prepared = await prepareUserTaskUpdate(agentController, current, data)
    updated = Object.keys(prepared.data).length > 0
      ? db.updateTask(taskId, prepared.data)
      : db.getTask(taskId)
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Task update refused' }
  }
  if (!updated) return { error: 'Task not found' }

  if (Object.keys(prepared.data).length > 0) {
    notifyRenderer?.('task:updated', { taskId, updates: updated })
    afterTaskUpdated(db, agentController, current, prepared.data, updated)
  }
  if (prepared.startAfterWrite) {
    try {
      await startPreparedTask(agentController!, taskId)
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Task start refused' }
    }
  }
  return { success: true, task: toApiTask(db.getTask(taskId) ?? updated) }
}

function createSubtask(db: DatabaseManager, params: Record<string, unknown>, trustedScope?: TaskMcpScope): unknown {
  if (!params.parent_task_id) return { error: 'parent_task_id is required' }
  if (!params.title) return { error: 'title is required' }
  const parent = db.getTask(String(params.parent_task_id))
  if (!parent) return { error: 'Parent task not found' }
  if (params.next_subtask_ids !== undefined && !Array.isArray(params.next_subtask_ids)) {
    return { error: 'next_subtask_ids must be an array' }
  }
  // A subtask shares its parent's project, so its repos and skills must belong to it (#74).
  const badSkills = validateSkillAssignment(db, params.skill_ids, taskProjectId(parent))
  if (badSkills) return badSkills
  let repos = parent.repos
  if (params.repos !== undefined) {
    const checked = validateProjectRepos(db, taskProjectId(parent), reposParam(params.repos), parent.repos ?? [])
    if ('error' in checked) return checked
    repos = checked.repos
  }

  let subtask: TaskRecord | undefined
  try {
    subtask = createTask(db, {
      title: String(params.title),
      description: (params.description as string) || '',
      type: (params.type as string) || 'general',
      priority: (params.priority as string) || parent.priority || 'medium',
      labels: (params.labels as string[]) || [],
      repos,
      output_fields: (params.output_fields as CreateTaskData['output_fields']) || [],
      parent_task_id: parent.id,
      next_subtask_ids: params.next_subtask_ids as string[] | undefined,
      // A child of a parent told to finish without review must not stop for one
      // either, or an unattended chain parks in review at the first step.
      // auto_start_agent is deliberately NOT inherited: children are started
      // through their parent and then by explicit successor edges.
      auto_complete_without_review: params.auto_complete_without_review === undefined
        ? parent.auto_complete_without_review
        : params.auto_complete_without_review === true
    }, params, trustedScope)
  } catch (error) {
    // db.createTask removes the row when its successor links are invalid.
    return { error: error instanceof Error ? error.message : String(error) }
  }
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

function createTopLevelTask(db: DatabaseManager, params: Record<string, unknown>, trustedScope?: TaskMcpScope): unknown {
  if (!params.title) return { error: 'Title is required' }
  const parentId = (params.parent_task_id as string) || null
  const parent = parentId ? db.getTask(parentId) : undefined
  if (parentId && !parent) return { error: 'Parent task not found' }
  // A child always joins its parent's project; anything else joins the one asked
  // for, else the Default project.
  const projectId = parent ? taskProjectId(parent) : (projectFilter(params) ?? DEFAULT_PROJECT_ID)
  if (!db.getProject(projectId)) return { error: `Project not found: ${projectId}` }
  const checked = validateProjectRepos(db, projectId, reposParam(params.repos))
  if ('error' in checked) return checked
  // #74: a task carries global skills and its own project's, never another project's.
  const badSkills = validateSkillAssignment(db, params.skill_ids, projectId)
  if (badSkills) return badSkills

  const task = createTask(db, {
    title: String(params.title),
    description: (params.description as string) || '',
    type: (params.type as string) || 'general',
    priority: (params.priority as string) || 'medium',
    assignee: (params.assignee as string) || '',
    due_date: (params.due_date as string) || null,
    labels: (params.labels as string[]) || [],
    repos: checked.repos,
    // cron is the current field; is_recurring + recurrence_pattern the legacy pair.
    cron: (params.cron as string) || undefined,
    is_recurring: !!params.is_recurring,
    recurrence_pattern: (params.recurrence_pattern as CreateTaskData['recurrence_pattern']) || null,
    parent_task_id: parentId,
    project_id: projectId,
    auto_start_agent: params.auto_start_agent === true,
    auto_complete_without_review: params.auto_complete_without_review === true
  }, params, trustedScope)
  if (!task) return { error: 'Failed to create task' }
  return { success: true, task: toApiTask(task) }
}

/**
 * The project's repos with where each lives, for picking `repos` on a task.
 * Scoped sessions get their own project; an unscoped call gets the Default
 * project unless it names one.
 */
function listReposForProject(db: DatabaseManager, params: Record<string, unknown>): unknown {
  const projectId = projectFilter(params) ?? DEFAULT_PROJECT_ID
  if (!db.getProject(projectId)) return { error: `Project not found: ${projectId}` }
  const defaults = projectGitDefaults(db, projectId)
  return {
    project_id: projectId,
    repos: listProjectRepos(db, projectId).map((repo) => ({
      full_name: repo.fullName,
      name: repo.name,
      org: repo.org || null,
      provider: repo.provider,
      default_branch: repo.defaultBranch
    })),
    git_provider: defaults.provider,
    git_org: defaults.org
  }
}

/**
 * The Captain's status snapshot for its project (#58). A project-scoped
 * session has `project_id` forced by the scope (task-management-core.ts);
 * an unscoped internal caller must name the project. The counts are never
 * written: the reply carries the ones the database computed just now.
 */
function updateProjectStatus(db: DatabaseManager, params: Record<string, unknown>): unknown {
  const projectId = projectFilter(params)
  if (!projectId) return { error: 'project_id is required' }
  const summary = typeof params.summary === 'string' ? params.summary.trim() : ''
  if (!summary) return { error: 'summary is required' }
  // #72: the same write appends a journal entry with the structured highlights.
  const lists: Record<string, string[] | undefined> = {}
  for (const key of ['top_blockers', 'completed', 'blockers', 'decisions', 'next_steps'] as const) {
    if (params[key] === undefined) continue
    if (!Array.isArray(params[key])) return { error: `${key} must be an array of strings` }
    lists[key] = (params[key] as unknown[]).filter((item): item is string => typeof item === 'string')
  }
  const written = db.recordProjectStatus(projectId, {
    summary,
    top_blockers: lists.top_blockers ?? [],
    completed: lists.completed,
    blockers: lists.blockers,
    decisions: lists.decisions,
    next_steps: lists.next_steps,
    correlation_id: typeof params.correlation_id === 'string' ? params.correlation_id : null
  })
  if (!written) return { error: 'Project not found' }
  notifyRenderer?.('project:statusChanged', { projectId })
  return { success: true, status: written.status, journal_entry_id: written.entry.id }
}

const MAX_REPORT_CHARS = 4_000

/**
 * A Captain's report to the Commander (#62). The scope forces `project_id`
 * like `update_project_status`; the message is capped and handed to the
 * Commander through the report seam (commander/report-inbox.ts), which
 * routes it to the right session. Nothing is stored here.
 */
function reportToCommander(db: DatabaseManager, params: Record<string, unknown>): unknown {
  const projectId = projectFilter(params)
  if (!projectId) return { error: 'project_id is required' }
  if (!db.getProject(projectId)) return { error: 'Project not found' }
  const message = typeof params.message === 'string' ? params.message.trim() : ''
  if (!message) return { error: 'message is required' }
  if (message.length > MAX_REPORT_CHARS) return { error: `message must be at most ${MAX_REPORT_CHARS} characters` }
  if (typeof params.correlation_id === 'string' && params.correlation_id.trim().length > 100) return { error: 'correlation_id must be at most 100 characters' }
  if (typeof params.delivery_id === 'string' && params.delivery_id.trim().length > 200) return { error: 'delivery_id must be at most 200 characters' }
  const correlationId = typeof params.correlation_id === 'string' && params.correlation_id.trim() ? params.correlation_id.trim().slice(0, 100) : null
  const deliveryId = typeof params.delivery_id === 'string' && params.delivery_id.trim()
    ? params.delivery_id.trim().slice(0, 200)
    : null
  const delivery = deliverCaptainReport({ projectId, message, correlationId, deliveryId, source: 'captain' })
  if (!delivery.delivered) return { error: delivery.detail }
  return {
    success: true,
    session_id: delivery.sessionId,
    routed_by: delivery.routedBy,
    note: delivery.relayed
      ? 'The Commander is relaying your report to the user now.'
      : 'The report is queued in the Commander; the user sees it when they next open that conversation.'
  }
}

export async function handleTaskRoute(db: DatabaseManager, route: string, params: Record<string, unknown>, trustedScope?: TaskMcpScope): Promise<unknown> {
  switch (route) {
    case '/list_tasks':
      return listTasks(db, params)

    case '/create_task':
      return createTopLevelTask(db, params, trustedScope)

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
      return getTaskStatistics(db, params.metric, projectFilter(params))

    case '/list_repos':
      return listReposForProject(db, params)

    case '/list_subtasks':
      if (!params.parent_task_id) return { error: 'parent_task_id is required' }
      return db.getSubtasks(String(params.parent_task_id)).map(toApiTask)

    case '/create_subtask':
      return createSubtask(db, params, trustedScope)

    case '/wait_for_subtasks':
      return waitForSubtasks(db, params)

    case '/update_project_status':
      return updateProjectStatus(db, params)

    case '/report_to_commander':
      return reportToCommander(db, params)

    default:
      return undefined
  }
}
