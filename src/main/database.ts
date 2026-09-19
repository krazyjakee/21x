import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { createId } from '@paralleldrive/cuid2'
import { TaskStatus } from '../shared/constants'
import { WORKSPACES_DIR, taskAttachmentsDir } from './workspace-paths'
import { applySchema } from './database/schema'
import { ensureProjectCaptain, seedDefaultAgent, seedCaptainTasks, seedTaskManagementMcpServer } from './database/seed'
import { seedOrchestratorSkill } from './database/captain-migration'
import { userTaskRoleFilter } from './database/task-roles'
import { TASK_ROLE_CAPTAIN, type TaskRole } from '../shared/task-roles'
import { DEFAULT_PROJECT_ID } from '../shared/projects'
import {
  JSON_COLUMNS,
  UPDATABLE_COLUMNS,
  deserializeAgent,
  deserializeMcpServer,
  deserializeTask,
  deserializeTaskSource,
  parseJsonArray
} from './database/serializers'
import * as transcripts from './database/transcripts'
import * as projects from './database/projects'
import * as projectStatus from './database/project-status-store'
import * as skills from './database/skills'
import * as secrets from './database/secrets'
import * as oauth from './database/oauth-tokens'
import * as plugins from './database/plugins'
import * as mobile from './database/mobile-auth'
import type {
  AgentRecord, AgentRow, CreateAgentData, UpdateAgentData,
  CreateMcpServerData, McpServerRecord, McpServerRow, McpServerSource, McpServerToolRecord, UpdateMcpServerData,
  CreateTaskData, HeartbeatLogRecord, TaskRecord, TaskRow, UpdateTaskData,
  CreateTaskSourceData, TaskSourceRecord, TaskSourceRow, UpdateTaskSourceData
} from './database/types'

export type * from './database/types'
export { SkillVersionConflictError } from './database/types'
export type { ProjectStatus, ProjectStatusJournalEntry, ProjectStatusJournalInput } from '../shared/project-status'

/** A module function's arguments after the manager itself. */
type Args<F> = F extends (m: DatabaseManager, ...args: infer A) => unknown ? A : never

export class DatabaseManager {
  public db!: Database.Database

  private statements = new Map<string, Database.Statement>()
  private statementsDb?: Database.Database

  /** Static SQL is compiled once per connection and reused. Also used by the area modules in database/. */
  prepare(sql: string): Database.Statement {
    if (this.statementsDb !== this.db) {
      this.statements.clear()
      this.statementsDb = this.db
    }
    let stmt = this.statements.get(sql)
    if (!stmt) {
      stmt = this.db.prepare(sql)
      this.statements.set(sql, stmt)
    }
    return stmt
  }

  private ensureDbOpen(): boolean {
    return !!this.db?.open
  }

  close(): void {
    if (this.ensureDbOpen()) {
      this.db.pragma('wal_checkpoint(TRUNCATE)')
      this.db.close()
    }
  }

  initialize(): void {
    this.db = new Database(join(app.getPath('userData'), '21x.db')) // DB_FILE_NAME in app-identity.ts
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000') // Retry on SQLITE_BUSY for up to 5s

    if (applySchema(this.db)) seedDefaultAgent(this.db)
    try {
      const migrated = this.encryptPlaintextApiKeys()
      if (migrated) console.log(`[Database] Encrypted ${migrated} stored API key(s)`)
    } catch (err) {
      console.error('[Database] Failed to encrypt stored API keys:', err)
    }

    seedTaskManagementMcpServer(this.db)
    seedOrchestratorSkill(this.db)
    seedCaptainTasks(this.db)

    // Status journal retention (#72): idempotent, so every start may run it.
    try {
      const { folded, written } = this.compactProjectStatusJournal()
      if (folded > 0) console.log(`[Database] Rolled ${folded} project status journal entries into ${written} monthly entries`)
    } catch (err) {
      console.error('[Database] Project status journal compaction failed:', err)
    }
  }

  getWorkspaceDir(taskId: string): string {
    // Not memoised: workspace cleanup can delete the directory at any time.
    const dir = join(WORKSPACES_DIR, taskId)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  getAttachmentsDir(taskId: string): string {
    const dir = taskAttachmentsDir(taskId)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  deleteTaskAttachments(taskId: string): void {
    rmSync(taskAttachmentsDir(taskId), { recursive: true, force: true })
  }

  /**
   * The user's tasks. Coordinator rows (see `role`) are left out, so the board,
   * the sidebar, mobile, the MCP tools and every other consumer inherit the
   * same rule. Pass `includeCoordinators` only for bookkeeping over every row,
   * such as deciding which workspace directories belong to something.
   * `projectId` narrows the list to one project; without it every project's
   * tasks are returned, as before projects existed.
   */
  getTasks(opts?: { includeCoordinators?: boolean; projectId?: string }): TaskRecord[] {
    if (!this.ensureDbOpen()) return []

    const conditions: string[] = []
    const params: string[] = []
    if (!opts?.includeCoordinators) conditions.push(userTaskRoleFilter())
    if (opts?.projectId) {
      conditions.push('project_id = ?')
      params.push(opts.projectId)
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.prepare(
      `SELECT * FROM tasks${where} ORDER BY created_at DESC`
    ).all(...params) as TaskRow[]

    return rows.map(deserializeTask)
  }

  /** Newest `updated_at` among a project's user tasks (coordinator rows excluded, as in getTasks). */
  getLatestTaskUpdate(projectId: string): string | null {
    if (!this.ensureDbOpen()) return null
    const row = this.prepare(
      `SELECT MAX(updated_at) AS latest FROM tasks WHERE project_id = ? AND ${userTaskRoleFilter()}`
    ).get(projectId) as { latest: string | null }
    return row.latest
  }

  /**
   * The row that hosts a project's coordinator conversation: its Captain.
   * One per project (#55); the Default project's is the one every install has.
   */
  getCoordinatorTask(projectId: string = DEFAULT_PROJECT_ID, role: TaskRole = TASK_ROLE_CAPTAIN): TaskRecord | undefined {
    if (!this.ensureDbOpen()) return undefined

    const row = this.prepare(
      'SELECT * FROM tasks WHERE role = ? AND project_id = ? ORDER BY created_at ASC LIMIT 1'
    ).get(role, projectId) as TaskRow | undefined

    return row ? deserializeTask(row) : undefined
  }

  /** Every coordinator row of a role, one per project, in project creation order. */
  getCoordinatorTasks(role: TaskRole = TASK_ROLE_CAPTAIN): TaskRecord[] {
    if (!this.ensureDbOpen()) return []
    const rows = this.prepare(
      'SELECT * FROM tasks WHERE role = ? ORDER BY created_at ASC'
    ).all(role) as TaskRow[]
    return rows.map(deserializeTask)
  }

  /**
   * The project's Captain row, created if the project exists and has none
   * (a project made before per-project Captains, or one restored from an
   * archive). Undefined for an unknown project: no row is invented for it.
   */
  ensureCoordinatorTask(projectId: string): TaskRecord | undefined {
    if (!this.ensureDbOpen() || !this.getProject(projectId)) return undefined
    return this.getTask(ensureProjectCaptain(this.db, projectId))
  }

  getTask(id: string): TaskRecord | undefined {
    if (!this.ensureDbOpen()) return undefined

    const row = this.prepare(
      'SELECT * FROM tasks WHERE id = ?'
    ).get(id) as TaskRow | undefined

    return row ? deserializeTask(row) : undefined
  }

  getSubtasks(parentId: string): TaskRecord[] {
    if (!this.ensureDbOpen()) return []

    const rows = this.prepare(
      'SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY sort_order ASC, created_at ASC'
    ).all(parentId) as TaskRow[]

    return rows.map(deserializeTask)
  }

  // Area CRUD lives in database/<area>.ts; these delegates keep `db.x()` the one API callers use.
  upsertTranscriptParts(...a: Args<typeof transcripts.upsertTranscriptParts>) { return transcripts.upsertTranscriptParts(this, ...a) }
  getTranscriptDelta(...a: Args<typeof transcripts.getTranscriptDelta>) { return transcripts.getTranscriptDelta(this, ...a) }
  getTranscriptMaxRev(...a: Args<typeof transcripts.getTranscriptMaxRev>) { return transcripts.getTranscriptMaxRev(this, ...a) }
  getTranscriptParts(...a: Args<typeof transcripts.getTranscriptParts>) { return transcripts.getTranscriptParts(this, ...a) }
  getTranscriptPage(...a: Args<typeof transcripts.getTranscriptPage>) { return transcripts.getTranscriptPage(this, ...a) }
  hasTranscriptParts(...a: Args<typeof transcripts.hasTranscriptParts>) { return transcripts.hasTranscriptParts(this, ...a) }
  deleteTranscriptParts(...a: Args<typeof transcripts.deleteTranscriptParts>) { return transcripts.deleteTranscriptParts(this, ...a) }

  /** Index in `orderedIds` becomes each subtask's sort_order; ids outside `parentId` are ignored. */
  reorderSubtasks(parentId: string, orderedIds: string[]): void {
    if (!this.ensureDbOpen()) return

    const stmt = this.prepare('UPDATE tasks SET sort_order = ?, updated_at = ? WHERE id = ? AND parent_task_id = ?')
    const now = new Date().toISOString()

    const runAll = this.db.transaction(() => {
      for (let i = 0; i < orderedIds.length; i++) {
        stmt.run(i, now, orderedIds[i], parentId)
      }
    })
    runAll()
  }

  /**
   * Moves a top-level task to another project, with everything that must share
   * its project: its subtasks (at any depth) and its recurrence instances. One
   * transaction, so a failure leaves no task split from its parent.
   * A subtask cannot be moved on its own — it belongs to its parent's project.
   * Returns the moved rows, or undefined when the task, the project or the
   * move is not valid.
   */
  moveTaskToProject(taskId: string, projectId: string): TaskRecord[] | undefined {
    if (!this.ensureDbOpen()) return undefined

    const task = this.prepare('SELECT id, parent_task_id FROM tasks WHERE id = ?').get(taskId) as
      { id: string; parent_task_id: string | null } | undefined
    if (!task || task.parent_task_id) return undefined
    const project = this.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)
    if (!project) return undefined

    const run = this.db.transaction(() => {
      const ids = (this.prepare(`
        WITH RECURSIVE tree(id) AS (
          SELECT ?
          UNION
          SELECT t.id FROM tasks t JOIN tree ON t.parent_task_id = tree.id OR t.recurrence_parent_id = tree.id
        )
        SELECT id FROM tree
      `).all(taskId) as { id: string }[]).map((row) => row.id)
      const now = new Date().toISOString()
      const stmt = this.prepare('UPDATE tasks SET project_id = ?, updated_at = ? WHERE id = ?')
      for (const id of ids) stmt.run(projectId, now, id)
      return ids
    })
    const movedIds = run()
    return movedIds
      .map((id) => this.getTask(id))
      .filter((moved): moved is TaskRecord => !!moved)
  }

  /**
   * `tasks.project_id` is NOT NULL in effect but not in the schema (see
   * migrateToProjects in database/schema.ts), so every write picks one here:
   * a subtask or recurrence instance shares its parent's project; anything
   * else gets the requested project, else its task source's project, else the
   * Default project.
   */
  private resolveTaskProjectId(data: Pick<CreateTaskData, 'parent_task_id' | 'recurrence_parent_id' | 'project_id' | 'source_id'>): string {
    for (const parentId of [data.parent_task_id, data.recurrence_parent_id]) {
      if (!parentId) continue
      const row = this.prepare('SELECT project_id FROM tasks WHERE id = ?').get(parentId) as { project_id: string | null } | undefined
      if (row?.project_id) return row.project_id
    }
    if (data.project_id) return data.project_id
    if (data.source_id) {
      const row = this.prepare('SELECT project_id FROM task_sources WHERE id = ?').get(data.source_id) as { project_id: string | null } | undefined
      if (row?.project_id) return row.project_id
    }
    return DEFAULT_PROJECT_ID
  }

  createTask(data: CreateTaskData): TaskRecord | undefined {
    const id = createId()
    const now = new Date().toISOString()

    const isRecurring = data.cron ? true : !!data.is_recurring
    const recurrencePattern = data.cron
      ? data.cron
      : data.recurrence_pattern
        ? (typeof data.recurrence_pattern === 'string' ? data.recurrence_pattern : JSON.stringify(data.recurrence_pattern))
        : null

    let sortOrder = 0
    if (data.parent_task_id) {
      const maxRow = this.prepare(
        'SELECT COALESCE(MAX(sort_order), -1) as max_order FROM tasks WHERE parent_task_id = ?'
      ).get(data.parent_task_id) as { max_order: number } | undefined
      sortOrder = (maxRow?.max_order ?? -1) + 1
    }

    this.prepare(`
      INSERT INTO tasks (
        id, title, description, type, priority, status, assignee, due_date,
        labels, attachments, repos, output_fields, external_id, source_id, source,
        is_recurring, recurrence_pattern, recurrence_parent_id,
        auto_start_agent, auto_complete_without_review,
        parent_task_id, next_subtask_ids, sort_order, role, project_id,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.title,
      data.description ?? '',
      data.type ?? 'general',
      data.priority ?? 'medium',
      data.status ?? TaskStatus.NotStarted,
      data.assignee ?? '',
      data.due_date ?? null,
      JSON.stringify(data.labels ?? []),
      JSON.stringify(data.attachments ?? []),
      JSON.stringify(data.repos ?? []),
      JSON.stringify(data.output_fields ?? []),
      data.external_id ?? null,
      data.source_id ?? null,
      data.source ?? 'local',
      isRecurring ? 1 : 0,
      recurrencePattern,
      data.recurrence_parent_id ?? null,
      data.auto_start_agent ? 1 : 0,
      data.auto_complete_without_review ? 1 : 0,
      data.parent_task_id ?? null,
      JSON.stringify(data.next_subtask_ids ?? []),
      sortOrder,
      data.role ?? 'task',
      this.resolveTaskProjectId(data),
      now,
      now
    )

    if (data.next_subtask_ids !== undefined) {
      try {
        this.validateNextSubtaskIds(id, data.next_subtask_ids)
      } catch (err) {
        this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
        throw err
      }
    }

    return this.getTask(id)
  }

  updateTask(id: string, data: UpdateTaskData, origin?: 'session-feedback' | 'task-source'): TaskRecord | undefined {
    if (origin !== 'task-source' && ('external_id' in data || 'source_id' in data || 'source' in data)) {
      throw new Error('Only the sync service can change a task source link.')
    }
    if (data.next_subtask_ids !== undefined) {
      this.validateNextSubtaskIds(id, data.next_subtask_ids)
    }
    const currentTask = this.getTask(id)
    const approvedStatusWrite = origin === 'session-feedback' || origin === 'task-source'
    if (!approvedStatusWrite && currentTask?.status === TaskStatus.AgentLearning && this.getSetting(`session-feedback-completion:${id}`) && !(data.status === TaskStatus.Completed && data.complete_at_source === false)) {
      data = { ...data, status: TaskStatus.AgentLearning }
    }
    const manualCompletion = data.status === TaskStatus.Completed && data.complete_at_source === false
    // A source refresh must not reopen a task the user closed only in 20x.
    if (currentTask?.source_id && currentTask.status === TaskStatus.Completed && currentTask.complete_at_source === false && data.complete_at_source !== true) {
      data = { ...data, status: TaskStatus.Completed }
    }
    if (data.status === TaskStatus.Completed && !manualCompletion && !approvedStatusWrite) {
      const task = this.getTask(id)
      if (task?.source_id && task.status !== TaskStatus.Completed) {
        throw new Error('The task source must confirm completion before this task can close in 20x.')
      }
    }
    const setClauses: string[] = []
    const values: (string | number | null)[] = []

    for (const [key, value] of Object.entries(data)) {
      if (value === undefined || !UPDATABLE_COLUMNS.has(key)) continue

      setClauses.push(`${key} = ?`)
      if (JSON_COLUMNS.has(key)) {
        values.push(JSON.stringify(value))
      } else if (key === 'recurrence_pattern') {
        // Cron string stored directly, legacy object JSON-stringified
        values.push(value === null ? null : typeof value === 'string' ? value : JSON.stringify(value))
      } else if (typeof value === 'boolean') {
        values.push(value ? 1 : 0)
      } else {
        values.push(value as string | number | null)
      }
    }

    // A task moved under a parent joins the parent's project.
    if (data.parent_task_id) {
      setClauses.push('project_id = ?')
      values.push(this.resolveTaskProjectId({ parent_task_id: data.parent_task_id, project_id: currentTask?.project_id }))
    }

    if (data.heartbeat_enabled === true && data.heartbeat_next_check_at === undefined) {
      const interval = data.heartbeat_interval_minutes ?? 30
      const nextCheck = new Date(Date.now() + interval * 60_000).toISOString()
      setClauses.push('heartbeat_next_check_at = ?')
      values.push(nextCheck)
    }

    if (setClauses.length === 0) return this.getTask(id)

    setClauses.push('updated_at = ?')
    values.push(new Date().toISOString())
    values.push(id)

    this.db.prepare(
      `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`
    ).run(...values)

    return this.getTask(id)
  }

  validateNextSubtaskIds(taskId: string, nextSubtaskIds: string[]): void {
    if (!Array.isArray(nextSubtaskIds)) throw new Error('next_subtask_ids must be an array')
    if (new Set(nextSubtaskIds).size !== nextSubtaskIds.length) {
      throw new Error('next_subtask_ids must not contain duplicates')
    }
    if (nextSubtaskIds.includes(taskId)) throw new Error('A subtask cannot start itself')

    const task = this.getTask(taskId)
    if (!task) throw new Error(`Task not found: ${taskId}`)
    if (!task.parent_task_id && nextSubtaskIds.length > 0) {
      throw new Error('Only subtasks can define next subtasks')
    }

    for (const nextId of nextSubtaskIds) {
      const nextTask = this.getTask(nextId)
      if (!nextTask || nextTask.parent_task_id !== task.parent_task_id) {
        throw new Error(`Next subtask must be a sibling: ${nextId}`)
      }
    }
  }

  /** Drop `taskId` from its siblings' successor links. A stale ID would make
   *  every later edit of those links fail sibling validation. */
  private removeFromSiblingSuccessors(taskId: string, parentTaskId: string): void {
    const rows = this.db.prepare(
      'SELECT id, next_subtask_ids FROM tasks WHERE parent_task_id = ? AND id != ?'
    ).all(parentTaskId, taskId) as { id: string; next_subtask_ids: string }[]
    const update = this.db.prepare('UPDATE tasks SET next_subtask_ids = ? WHERE id = ?')
    for (const row of rows) {
      const ids = parseJsonArray(row.next_subtask_ids)
      if (ids.includes(taskId)) update.run(JSON.stringify(ids.filter((nextId) => nextId !== taskId)), row.id)
    }
  }

  deleteTask(id: string): boolean {
    const parentTaskId = this.getTask(id)?.parent_task_id
    if (parentTaskId) this.removeFromSiblingSuccessors(id, parentTaskId)
    this.deleteTaskAttachments(id)
    this.deleteTranscriptParts(id)
    const result = this.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    return result.changes > 0
  }

  /** Heartbeat-enabled tasks whose next check is due; completed tasks and subtasks of completed parents are skipped. */
  getHeartbeatDueTasks(): TaskRecord[] {
    const now = new Date().toISOString()
    const rows = this.prepare(`
      SELECT t.* FROM tasks t
      WHERE t.heartbeat_enabled = 1
        AND t.heartbeat_next_check_at IS NOT NULL
        AND t.heartbeat_next_check_at <= ?
        AND t.status != ?
        AND (
          t.parent_task_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM tasks p WHERE p.id = t.parent_task_id AND p.status = ?
          )
        )
      ORDER BY t.heartbeat_next_check_at ASC
    `).all(now, TaskStatus.Completed, TaskStatus.Completed) as TaskRow[]
    return rows.map(deserializeTask)
  }

  createHeartbeatLog(data: {
    task_id: string
    status: string
    summary?: string | null
    session_id?: string | null
  }): HeartbeatLogRecord {
    const id = createId()
    const now = new Date().toISOString()

    this.prepare(`
      INSERT INTO heartbeat_logs (id, task_id, status, summary, session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, data.task_id, data.status, data.summary ?? null, data.session_id ?? null, now)

    return { id, task_id: data.task_id, status: data.status, summary: data.summary ?? null, session_id: data.session_id ?? null, created_at: now }
  }

  /** Most recent first. */
  getHeartbeatLogs(taskId: string, limit = 20): HeartbeatLogRecord[] {
    return this.prepare(`
      SELECT * FROM heartbeat_logs
      WHERE task_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(taskId, limit) as HeartbeatLogRecord[]
  }

  /** Errors in a row, counting back from the most recent log. */
  getHeartbeatConsecutiveErrors(taskId: string): number {
    const logs = this.prepare(`
      SELECT status FROM heartbeat_logs
      WHERE task_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(taskId) as { status: string }[]

    let count = 0
    for (const log of logs) {
      if (log.status === 'error') count++
      else break
    }
    return count
  }

  getAgents(): AgentRecord[] {
    const rows = this.prepare('SELECT * FROM agents ORDER BY created_at ASC').all() as AgentRow[]
    return rows.map(deserializeAgent)
  }

  getAgent(id: string): AgentRecord | undefined {
    const row = this.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined
    return row ? deserializeAgent(row) : undefined
  }

  createAgent(data: CreateAgentData): AgentRecord | undefined {
    const id = createId()
    const now = new Date().toISOString()

    this.prepare(`
      INSERT INTO agents (id, name, server_url, config, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.name,
      data.server_url ?? 'http://localhost:4096',
      JSON.stringify(data.config ?? {}),
      data.is_default ? 1 : 0,
      now,
      now
    )

    return this.getAgent(id)
  }

  updateAgent(id: string, data: UpdateAgentData): AgentRecord | undefined {
    const setClauses: string[] = []
    const values: (string | number | null)[] = []

    if (data.name !== undefined) {
      setClauses.push('name = ?')
      values.push(data.name)
    }
    if (data.server_url !== undefined) {
      setClauses.push('server_url = ?')
      values.push(data.server_url)
    }
    if (data.config !== undefined) {
      setClauses.push('config = ?')
      values.push(JSON.stringify(data.config))
    }
    if (data.is_default !== undefined) {
      setClauses.push('is_default = ?')
      values.push(data.is_default ? 1 : 0)
    }

    if (setClauses.length === 0) return this.getAgent(id)

    setClauses.push('updated_at = ?')
    values.push(new Date().toISOString())
    values.push(id)

    this.db.prepare(
      `UPDATE agents SET ${setClauses.join(', ')} WHERE id = ?`
    ).run(...values)

    return this.getAgent(id)
  }

  deleteAgent(id: string): boolean {
    const result = this.prepare('DELETE FROM agents WHERE id = ?').run(id)
    return result.changes > 0
  }

  getMcpServers(): McpServerRecord[] {
    const rows = this.prepare('SELECT * FROM mcp_servers ORDER BY created_at ASC').all() as McpServerRow[]
    return rows.map(deserializeMcpServer)
  }

  getMcpServer(id: string): McpServerRecord | undefined {
    if (!this.ensureDbOpen()) return undefined

    const row = this.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined
    return row ? deserializeMcpServer(row) : undefined
  }

  createMcpServer(data: CreateMcpServerData): McpServerRecord | undefined {
    const id = createId()
    const now = new Date().toISOString()
    const type = data.type ?? 'local'
    const source: McpServerSource = data.source ?? 'user'
    this.prepare(
      'INSERT INTO mcp_servers (id, name, type, command, args, url, headers, environment, oauth_metadata, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id,
      data.name,
      type,
      data.command ?? '',
      JSON.stringify(data.args ?? []),
      data.url ?? null,
      JSON.stringify(data.headers ?? {}),
      JSON.stringify(data.environment ?? {}),
      JSON.stringify(data.oauth_metadata ?? {}),
      source,
      now,
      now
    )
    return this.getMcpServer(id)
  }

  updateMcpServer(id: string, data: UpdateMcpServerData): McpServerRecord | undefined {
    const setClauses: string[] = []
    const values: (string | null)[] = []

    if (data.name !== undefined) { setClauses.push('name = ?'); values.push(data.name) }
    if (data.type !== undefined) { setClauses.push('type = ?'); values.push(data.type) }
    if (data.command !== undefined) { setClauses.push('command = ?'); values.push(data.command) }
    if (data.args !== undefined) { setClauses.push('args = ?'); values.push(JSON.stringify(data.args)) }
    if (data.url !== undefined) { setClauses.push('url = ?'); values.push(data.url || null) }
    if (data.headers !== undefined) { setClauses.push('headers = ?'); values.push(JSON.stringify(data.headers)) }
    if (data.environment !== undefined) { setClauses.push('environment = ?'); values.push(JSON.stringify(data.environment)) }
    if (data.oauth_metadata !== undefined) { setClauses.push('oauth_metadata = ?'); values.push(JSON.stringify(data.oauth_metadata)) }
    if (data.source !== undefined) { setClauses.push('source = ?'); values.push(data.source) }

    if (setClauses.length === 0) return this.getMcpServer(id)

    setClauses.push('updated_at = ?')
    values.push(new Date().toISOString())
    values.push(id)

    this.db.prepare(`UPDATE mcp_servers SET ${setClauses.join(', ')} WHERE id = ?`).run(...values)
    return this.getMcpServer(id)
  }

  updateMcpServerTools(id: string, tools: McpServerToolRecord[]): void {
    this.prepare('UPDATE mcp_servers SET tools = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(tools), new Date().toISOString(), id)
  }

  deleteMcpServer(id: string): boolean {
    const result = this.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
    return result.changes > 0
  }

  getProjects(...a: Args<typeof projects.getProjects>) { return projects.getProjects(this, ...a) }
  getProject(...a: Args<typeof projects.getProject>) { return projects.getProject(this, ...a) }
  getDefaultProject(...a: Args<typeof projects.getDefaultProject>) { return projects.getDefaultProject(this, ...a) }
  createProject(...a: Args<typeof projects.createProject>) { return projects.createProject(this, ...a) }
  updateProject(...a: Args<typeof projects.updateProject>) { return projects.updateProject(this, ...a) }
  archiveProject(...a: Args<typeof projects.archiveProject>) { return projects.archiveProject(this, ...a) }
  reorderProjects(...a: Args<typeof projects.reorderProjects>) { return projects.reorderProjects(this, ...a) }
  getProjectRepos(...a: Args<typeof projects.getProjectRepos>) { return projects.getProjectRepos(this, ...a) }
  getProjectRepo(...a: Args<typeof projects.getProjectRepo>) { return projects.getProjectRepo(this, ...a) }
  addProjectRepo(...a: Args<typeof projects.addProjectRepo>) { return projects.addProjectRepo(this, ...a) }
  updateProjectRepo(...a: Args<typeof projects.updateProjectRepo>) { return projects.updateProjectRepo(this, ...a) }
  removeProjectRepo(...a: Args<typeof projects.removeProjectRepo>) { return projects.removeProjectRepo(this, ...a) }
  reorderProjectRepos(...a: Args<typeof projects.reorderProjectRepos>) { return projects.reorderProjectRepos(this, ...a) }
  getProjectResources(...a: Args<typeof projects.getProjectResources>) { return projects.getProjectResources(this, ...a) }
  getProjectResource(...a: Args<typeof projects.getProjectResource>) { return projects.getProjectResource(this, ...a) }
  addProjectResource(...a: Args<typeof projects.addProjectResource>) { return projects.addProjectResource(this, ...a) }
  updateProjectResource(...a: Args<typeof projects.updateProjectResource>) { return projects.updateProjectResource(this, ...a) }
  removeProjectResource(...a: Args<typeof projects.removeProjectResource>) { return projects.removeProjectResource(this, ...a) }
  reorderProjectResources(...a: Args<typeof projects.reorderProjectResources>) { return projects.reorderProjectResources(this, ...a) }
  getProjectStatus(...a: Args<typeof projectStatus.getProjectStatus>) { return projectStatus.getProjectStatus(this, ...a) }
  setProjectStatusSummary(...a: Args<typeof projectStatus.setProjectStatusSummary>) { return projectStatus.setProjectStatusSummary(this, ...a) }
  appendProjectStatusJournal(...a: Args<typeof projectStatus.appendProjectStatusJournal>) { return projectStatus.appendProjectStatusJournal(this, ...a) }
  getProjectStatusJournalEntry(...a: Args<typeof projectStatus.getProjectStatusJournalEntry>) { return projectStatus.getProjectStatusJournalEntry(this, ...a) }
  recordProjectStatus(...a: Args<typeof projectStatus.recordProjectStatus>) { return projectStatus.recordProjectStatus(this, ...a) }
  listProjectStatusJournal(...a: Args<typeof projectStatus.listProjectStatusJournal>) { return projectStatus.listProjectStatusJournal(this, ...a) }
  countProjectStatusJournal(...a: Args<typeof projectStatus.countProjectStatusJournal>) { return projectStatus.countProjectStatusJournal(this, ...a) }
  compactProjectStatusJournal(...a: Args<typeof projectStatus.compactProjectStatusJournal>) { return projectStatus.compactProjectStatusJournal(this, ...a) }

  /** Every project's sources unless `projectId` narrows it to one. */
  getTaskSources(projectId?: string): TaskSourceRecord[] {
    const rows = (projectId
      ? this.prepare('SELECT * FROM task_sources WHERE project_id = ? ORDER BY created_at ASC').all(projectId)
      : this.prepare('SELECT * FROM task_sources ORDER BY created_at ASC').all()
    ) as TaskSourceRow[]
    return rows.map(deserializeTaskSource)
  }

  getTaskSource(id: string): TaskSourceRecord | undefined {
    const row = this.prepare('SELECT * FROM task_sources WHERE id = ?').get(id) as TaskSourceRow | undefined
    return row ? deserializeTaskSource(row) : undefined
  }

  createTaskSource(data: CreateTaskSourceData): TaskSourceRecord | undefined {
    const id = createId()
    const now = new Date().toISOString()
    this.prepare(
      'INSERT INTO task_sources (id, mcp_server_id, name, plugin_id, config, list_tool, list_tool_args, update_tool, update_tool_args, enabled, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)'
    ).run(
      id,
      data.mcp_server_id,
      data.name,
      data.plugin_id,
      JSON.stringify(data.config ?? {}),
      data.list_tool ?? '',
      JSON.stringify(data.list_tool_args ?? {}),
      data.update_tool ?? '',
      JSON.stringify(data.update_tool_args ?? {}),
      data.project_id || DEFAULT_PROJECT_ID,
      now,
      now
    )
    return this.getTaskSource(id)
  }

  updateTaskSource(id: string, data: UpdateTaskSourceData): TaskSourceRecord | undefined {
    const setClauses: string[] = []
    const values: (string | number | null)[] = []

    if (data.name !== undefined) { setClauses.push('name = ?'); values.push(data.name) }
    if (data.plugin_id !== undefined) { setClauses.push('plugin_id = ?'); values.push(data.plugin_id) }
    if (data.config !== undefined) {
      // IMPORTANT: Merge new config with existing config to preserve OAuth credentials
      const existing = this.getTaskSource(id)
      const mergedConfig = existing ? { ...existing.config, ...data.config } : data.config

      setClauses.push('config = ?')
      values.push(JSON.stringify(mergedConfig))
      // Reset last_synced_at when config changes (filters changed, need fresh sync)
      setClauses.push('last_synced_at = ?')
      values.push(null)
      console.log(`[Database] Resetting last_synced_at for task source ${id} due to config change`)
    }
    if (data.mcp_server_id !== undefined) { setClauses.push('mcp_server_id = ?'); values.push(data.mcp_server_id) }
    if (data.list_tool !== undefined) { setClauses.push('list_tool = ?'); values.push(data.list_tool) }
    if (data.list_tool_args !== undefined) { setClauses.push('list_tool_args = ?'); values.push(JSON.stringify(data.list_tool_args)) }
    if (data.update_tool !== undefined) { setClauses.push('update_tool = ?'); values.push(data.update_tool) }
    if (data.update_tool_args !== undefined) { setClauses.push('update_tool_args = ?'); values.push(JSON.stringify(data.update_tool_args)) }
    if (data.enabled !== undefined) { setClauses.push('enabled = ?'); values.push(data.enabled ? 1 : 0) }

    if (setClauses.length === 0) return this.getTaskSource(id)

    setClauses.push('updated_at = ?')
    values.push(new Date().toISOString())
    values.push(id)

    this.db.prepare(`UPDATE task_sources SET ${setClauses.join(', ')} WHERE id = ?`).run(...values)
    return this.getTaskSource(id)
  }

  updateTaskSourceLastSynced(id: string): void {
    this.prepare('UPDATE task_sources SET last_synced_at = ?, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), new Date().toISOString(), id)
  }

  deleteTaskSource(id: string): boolean {
    const result = this.prepare('DELETE FROM task_sources WHERE id = ?').run(id)
    return result.changes > 0
  }

  getTaskByExternalId(sourceId: string, externalId: string): TaskRecord | undefined {
    const row = this.prepare(
      'SELECT * FROM tasks WHERE source_id = ? AND external_id = ?'
    ).get(sourceId, externalId) as TaskRow | undefined
    return row ? deserializeTask(row) : undefined
  }

  getSkills(...a: Args<typeof skills.getSkills>) { return skills.getSkills(this, ...a) }
  getSkill(...a: Args<typeof skills.getSkill>) { return skills.getSkill(this, ...a) }
  getSkillsByIds(...a: Args<typeof skills.getSkillsByIds>) { return skills.getSkillsByIds(this, ...a) }
  createSkill(...a: Args<typeof skills.createSkill>) { return skills.createSkill(this, ...a) }
  updateSkill(...a: Args<typeof skills.updateSkill>) { return skills.updateSkill(this, ...a) }
  setSkillProject(...a: Args<typeof skills.setSkillProject>) { return skills.setSkillProject(this, ...a) }
  getTasksUsingSkill(...a: Args<typeof skills.getTasksUsingSkill>) { return skills.getTasksUsingSkill(this, ...a) }
  getSkillByName(...a: Args<typeof skills.getSkillByName>) { return skills.getSkillByName(this, ...a) }
  deleteSkill(...a: Args<typeof skills.deleteSkill>) { return skills.deleteSkill(this, ...a) }
  getSecrets(...a: Args<typeof secrets.getSecrets>) { return secrets.getSecrets(this, ...a) }
  getSecret(...a: Args<typeof secrets.getSecret>) { return secrets.getSecret(this, ...a) }
  getSecretsByIds(...a: Args<typeof secrets.getSecretsByIds>) { return secrets.getSecretsByIds(this, ...a) }
  getSecretsWithValues(...a: Args<typeof secrets.getSecretsWithValues>) { return secrets.getSecretsWithValues(this, ...a) }
  createSecret(...a: Args<typeof secrets.createSecret>) { return secrets.createSecret(this, ...a) }
  updateSecret(...a: Args<typeof secrets.updateSecret>) { return secrets.updateSecret(this, ...a) }
  deleteSecret(...a: Args<typeof secrets.deleteSecret>) { return secrets.deleteSecret(this, ...a) }
  getSetting(...a: Args<typeof secrets.getSetting>) { return secrets.getSetting(this, ...a) }
  setSetting(...a: Args<typeof secrets.setSetting>) { return secrets.setSetting(this, ...a) }
  encryptPlaintextApiKeys(...a: Args<typeof secrets.encryptPlaintextApiKeys>) { return secrets.encryptPlaintextApiKeys(this, ...a) }
  deleteSetting(...a: Args<typeof secrets.deleteSetting>) { return secrets.deleteSetting(this, ...a) }
  getAllSettings(...a: Args<typeof secrets.getAllSettings>) { return secrets.getAllSettings(this, ...a) }
  createOAuthToken(...a: Args<typeof oauth.createOAuthToken>) { return oauth.createOAuthToken(this, ...a) }
  getOAuthToken(...a: Args<typeof oauth.getOAuthToken>) { return oauth.getOAuthToken(this, ...a) }
  getOAuthTokenBySource(...a: Args<typeof oauth.getOAuthTokenBySource>) { return oauth.getOAuthTokenBySource(this, ...a) }
  updateOAuthToken(...a: Args<typeof oauth.updateOAuthToken>) { return oauth.updateOAuthToken(this, ...a) }
  deleteOAuthToken(...a: Args<typeof oauth.deleteOAuthToken>) { return oauth.deleteOAuthToken(this, ...a) }
  deleteOAuthTokenBySource(...a: Args<typeof oauth.deleteOAuthTokenBySource>) { return oauth.deleteOAuthTokenBySource(this, ...a) }
  getOAuthTokenByMcpServer(...a: Args<typeof oauth.getOAuthTokenByMcpServer>) { return oauth.getOAuthTokenByMcpServer(this, ...a) }
  deleteOAuthTokenByMcpServer(...a: Args<typeof oauth.deleteOAuthTokenByMcpServer>) { return oauth.deleteOAuthTokenByMcpServer(this, ...a) }
  getMarketplaceSources(...a: Args<typeof plugins.getMarketplaceSources>) { return plugins.getMarketplaceSources(this, ...a) }
  getMarketplaceSource(...a: Args<typeof plugins.getMarketplaceSource>) { return plugins.getMarketplaceSource(this, ...a) }
  getMarketplaceSourceByName(...a: Args<typeof plugins.getMarketplaceSourceByName>) { return plugins.getMarketplaceSourceByName(this, ...a) }
  createMarketplaceSource(...a: Args<typeof plugins.createMarketplaceSource>) { return plugins.createMarketplaceSource(this, ...a) }
  deleteMarketplaceSource(...a: Args<typeof plugins.deleteMarketplaceSource>) { return plugins.deleteMarketplaceSource(this, ...a) }
  getInstalledPlugins(...a: Args<typeof plugins.getInstalledPlugins>) { return plugins.getInstalledPlugins(this, ...a) }
  getInstalledPlugin(...a: Args<typeof plugins.getInstalledPlugin>) { return plugins.getInstalledPlugin(this, ...a) }
  getInstalledPluginByName(...a: Args<typeof plugins.getInstalledPluginByName>) { return plugins.getInstalledPluginByName(this, ...a) }
  createInstalledPlugin(...a: Args<typeof plugins.createInstalledPlugin>) { return plugins.createInstalledPlugin(this, ...a) }
  updateInstalledPlugin(...a: Args<typeof plugins.updateInstalledPlugin>) { return plugins.updateInstalledPlugin(this, ...a) }
  deleteInstalledPlugin(...a: Args<typeof plugins.deleteInstalledPlugin>) { return plugins.deleteInstalledPlugin(this, ...a) }
  createMobilePairCode(...a: Args<typeof mobile.createMobilePairCode>) { return mobile.createMobilePairCode(this, ...a) }
  getMobilePairCode(...a: Args<typeof mobile.getMobilePairCode>) { return mobile.getMobilePairCode(this, ...a) }
  incrementPairCodeAttempts(...a: Args<typeof mobile.incrementPairCodeAttempts>) { return mobile.incrementPairCodeAttempts(this, ...a) }
  deleteMobilePairCode(...a: Args<typeof mobile.deleteMobilePairCode>) { return mobile.deleteMobilePairCode(this, ...a) }
  createMobileSession(...a: Args<typeof mobile.createMobileSession>) { return mobile.createMobileSession(this, ...a) }
  getMobileSessionByTokenHash(...a: Args<typeof mobile.getMobileSessionByTokenHash>) { return mobile.getMobileSessionByTokenHash(this, ...a) }
  getMobileSessions(...a: Args<typeof mobile.getMobileSessions>) { return mobile.getMobileSessions(this, ...a) }
  touchMobileSession(...a: Args<typeof mobile.touchMobileSession>) { return mobile.touchMobileSession(this, ...a) }
  revokeMobileSession(...a: Args<typeof mobile.revokeMobileSession>) { return mobile.revokeMobileSession(this, ...a) }
  revokeAllMobileSessions(...a: Args<typeof mobile.revokeAllMobileSessions>) { return mobile.revokeAllMobileSessions(this, ...a) }
}
