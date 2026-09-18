import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { createId } from '@paralleldrive/cuid2'
import { TaskStatus } from '../shared/constants'
import { WORKSPACES_DIR, taskAttachmentsDir } from './workspace-paths'
import { applySchema } from './database/schema'
import { seedDefaultAgent, seedMastermindTask, seedOrchestratorSkill, seedTaskManagementMcpServer } from './database/seed'
import { userTaskRoleFilter } from './database/task-roles'
import { TASK_ROLE_MASTERMIND, type TaskRole } from '../shared/task-roles'
import {
  JSON_COLUMNS,
  UPDATABLE_COLUMNS,
  deserializeAgent,
  deserializeInstalledPlugin,
  deserializeMarketplaceSource,
  deserializeMcpServer,
  deserializeOAuthToken,
  deserializeSecret,
  deserializeSecretWithValue,
  deserializeSkill,
  deserializeTask,
  deserializeTaskSource,
  decryptSettingValue,
  encryptSecret,
  encryptSettingValue,
  isApiKeySetting,
  isEncryptedSettingValue,
  normalizePreferredModel,
  parseJsonArray
} from './database/serializers'
import type {
  AgentRecord, AgentRow, CreateAgentData, UpdateAgentData,
  CreateInstalledPluginData, InstalledPluginRecord, InstalledPluginRow, UpdateInstalledPluginData,
  CreateMarketplaceSourceData, MarketplaceSourceRecord, MarketplaceSourceRow,
  CreateMcpServerData, McpServerRecord, McpServerRow, McpServerSource, McpServerToolRecord, UpdateMcpServerData,
  CreateOAuthTokenData, OAuthTokenRecord, OAuthTokenRow,
  CreateSecretData, SecretRecord, SecretRecordWithValue, SecretRow, UpdateSecretData,
  CreateSkillData, SkillRecord, SkillRow, UpdateSkillData,
  CreateTaskData, HeartbeatLogRecord, TaskRecord, TaskRow, UpdateTaskData,
  CreateTaskSourceData, TaskSourceRecord, TaskSourceRow, UpdateTaskSourceData,
  TranscriptPartInput, TranscriptPartRecord
} from './database/types'

export type * from './database/types'

interface TranscriptPartRow {
  task_id: string; part_id: string; seq: number; role: string; content: string
  part_type: string | null; tool: string | null; payload: string | null
  created_at: number; updated_at: number; rev: number
}

function toTranscriptPartRecord(r: TranscriptPartRow): TranscriptPartRecord {
  return {
    taskId: r.task_id,
    partId: r.part_id,
    seq: r.seq,
    role: r.role,
    content: r.content,
    rev: r.rev ?? 0,
    partType: r.part_type ?? undefined,
    tool: r.tool ? (JSON.parse(r.tool) as unknown) : undefined,
    payload: r.payload ? (JSON.parse(r.payload) as unknown) : undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

export class DatabaseManager {
  public db!: Database.Database

  private statements = new Map<string, Database.Statement>()
  private statementsDb?: Database.Database

  /** Static SQL is compiled once per connection and reused. */
  private prepare(sql: string): Database.Statement {
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
    this.db = new Database(join(app.getPath('userData'), 'pf-desktop.db'))
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
    seedMastermindTask(this.db)
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
   */
  getTasks(opts?: { includeCoordinators?: boolean }): TaskRecord[] {
    if (!this.ensureDbOpen()) return []

    const where = opts?.includeCoordinators ? '' : ` WHERE ${userTaskRoleFilter()}`
    const rows = this.prepare(
      `SELECT * FROM tasks${where} ORDER BY created_at DESC`
    ).all() as TaskRow[]

    return rows.map(deserializeTask)
  }

  /** The row that hosts a coordinator conversation, e.g. the Mastermind. */
  getCoordinatorTask(role: TaskRole = TASK_ROLE_MASTERMIND): TaskRecord | undefined {
    if (!this.ensureDbOpen()) return undefined

    const row = this.prepare(
      'SELECT * FROM tasks WHERE role = ? ORDER BY created_at ASC LIMIT 1'
    ).get(role) as TaskRow | undefined

    return row ? deserializeTask(row) : undefined
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

  // ── Durable transcript projection ──────────────────────────────
  // Every transcript part delivered to any client is persisted here first.
  // Parts are upserted by (task_id, part_id): streaming updates replace the
  // content of an existing part while keeping its position (seq).

  /**
   * Upsert a batch of transcript parts for a task inside one transaction.
   * New parts get the next per-task seq; existing parts keep their seq and
   * update content in place (streaming). Re-sending an unchanged part is a
   * no-op: it keeps its rev and is not reported in changedPartIds, so the
   * returned revs stay contiguous (maxRev - changedPartIds.length is the
   * cursor before this batch).
   */
  upsertTranscriptParts(taskId: string, parts: TranscriptPartInput[]): { maxRev: number; changedPartIds: string[] } {
    if (!this.ensureDbOpen() || parts.length === 0) return { maxRev: this.getTranscriptMaxRev(taskId), changedPartIds: [] }

    const nextSeqStmt = this.prepare(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM transcript_parts WHERE task_id = ?'
    )
    // created_at carries the part's ORIGINAL time (receivedAt) when known, not
    // the write time. Otherwise a bulk seed/replay (which writes the whole
    // history in one burst) would stamp every row with a near-identical
    // timestamp and destroy the transcript's chronology. On conflict, created_at
    // is preserved (never overwritten by a later reconcile pass).
    // Each inserted or changed row gets a fresh globally-monotonic `rev` so a
    // client can fetch everything changed since its last rev.
    const upsertStmt = this.prepare(`
      INSERT INTO transcript_parts (task_id, part_id, seq, role, content, part_type, tool, payload, created_at, updated_at, rev)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch('subsec') * 1000, ?)
      ON CONFLICT(task_id, part_id) DO UPDATE SET
        content = excluded.content,
        part_type = COALESCE(excluded.part_type, transcript_parts.part_type),
        tool = COALESCE(excluded.tool, transcript_parts.tool),
        payload = COALESCE(excluded.payload, transcript_parts.payload),
        updated_at = excluded.updated_at,
        rev = excluded.rev
      WHERE excluded.content IS NOT transcript_parts.content
         OR COALESCE(excluded.part_type, transcript_parts.part_type) IS NOT transcript_parts.part_type
         OR COALESCE(excluded.tool, transcript_parts.tool) IS NOT transcript_parts.tool
         OR COALESCE(excluded.payload, transcript_parts.payload) IS NOT transcript_parts.payload
    `)
    // Served by idx_transcript_parts_rev; runs inside every write transaction.
    const maxRevStmt = this.prepare('SELECT COALESCE(MAX(rev), 0) AS m FROM transcript_parts')

    let maxRev = 0
    const changedPartIds: string[] = []
    const txn = this.db.transaction(() => {
      let nextSeq = (nextSeqStmt.get(taskId) as { next: number }).next
      let rev = (maxRevStmt.get() as { m: number }).m
      const writeNow = Date.now()
      for (const part of parts) {
        if (!part.id) continue
        const { changes } = upsertStmt.run(
          taskId,
          part.id,
          nextSeq,
          part.role || 'system',
          part.content || '',
          part.partType ?? null,
          part.tool != null ? JSON.stringify(part.tool) : null,
          part.payload != null ? JSON.stringify(part.payload) : null,
          typeof part.receivedAt === 'number' ? part.receivedAt : writeNow,
          rev + 1
        )
        nextSeq++
        if (changes === 0) continue
        rev += 1
        changedPartIds.push(part.id)
      }
      maxRev = rev
    })
    // Reserve the WAL writer slot before reading seq/rev. A deferred
    // transaction can take a read snapshot while another connection is
    // writing, then fail immediately with SQLITE_BUSY when it tries to upgrade
    // that stale snapshot. BEGIN IMMEDIATE lets busy_timeout wait for the
    // writer and only calculates the counters after the lock is acquired.
    txn.immediate()
    return { maxRev, changedPartIds }
  }

  /**
   * Delta query: all parts for a task whose rev > sinceRev, ordered chronologically.
   * Captures both new parts and streaming content updates to existing ones.
   * Returns the parts and the task's current maxRev so the client can advance its cursor.
   */
  getTranscriptDelta(taskId: string, sinceRev: number): { parts: TranscriptPartRecord[]; maxRev: number } {
    if (!this.ensureDbOpen()) return { parts: [], maxRev: sinceRev }
    const rows = this.prepare(
      'SELECT * FROM transcript_parts WHERE task_id = ? AND rev > ? ORDER BY created_at ASC, seq ASC'
    ).all(taskId, sinceRev) as TranscriptPartRow[]
    const maxRow = this.prepare('SELECT COALESCE(MAX(rev), ?) AS m FROM transcript_parts WHERE task_id = ?').get(sinceRev, taskId) as { m: number }
    return { parts: rows.map(toTranscriptPartRecord), maxRev: maxRow.m }
  }

  /** Current max rev for a task (0 when empty). */
  getTranscriptMaxRev(taskId: string): number {
    if (!this.ensureDbOpen()) return 0
    const row = this.prepare('SELECT COALESCE(MAX(rev), 0) AS m FROM transcript_parts WHERE task_id = ?').get(taskId) as { m: number }
    return row.m
  }

  /** Snapshot query: ordered transcript for a task, optionally only parts after seq. */
  getTranscriptParts(taskId: string, sinceSeq?: number): TranscriptPartRecord[] {
    if (!this.ensureDbOpen()) return []

    // Order by REAL event time (created_at), with seq as a stable tiebreaker.
    // Insertion order (seq) is not chronological when a partial projection is
    // later backfilled with older history — ordering by created_at keeps the
    // transcript correct regardless of when each part was ingested.
    const rows = (sinceSeq != null
      ? this.prepare('SELECT * FROM transcript_parts WHERE task_id = ? AND seq > ? ORDER BY created_at ASC, seq ASC').all(taskId, sinceSeq)
      : this.prepare('SELECT * FROM transcript_parts WHERE task_id = ? ORDER BY created_at ASC, seq ASC').all(taskId)
    ) as TranscriptPartRow[]
    return rows.map(toTranscriptPartRecord)
  }

  /** True when the task already has persisted transcript parts. */
  hasTranscriptParts(taskId: string): boolean {
    if (!this.ensureDbOpen()) return false
    const row = this.prepare('SELECT 1 FROM transcript_parts WHERE task_id = ? LIMIT 1').get(taskId)
    return !!row
  }

  /** Remove a task's transcript (task deletion cleanup). */
  deleteTranscriptParts(taskId: string): void {
    if (!this.ensureDbOpen()) return
    this.prepare('DELETE FROM transcript_parts WHERE task_id = ?').run(taskId)
  }

  /**
   * Batch-update sort_order for subtasks under a parent.
   * @param parentId  The parent task ID
   * @param orderedIds  Subtask IDs in the desired order (index becomes sort_order)
   */
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

  createTask(data: CreateTaskData): TaskRecord | undefined {
    const id = createId()
    const now = new Date().toISOString()

    const isRecurring = data.cron ? true : !!data.is_recurring
    const recurrencePattern = data.cron
      ? data.cron
      : data.recurrence_pattern
        ? (typeof data.recurrence_pattern === 'string' ? data.recurrence_pattern : JSON.stringify(data.recurrence_pattern))
        : null

    // When creating a subtask, place it at the end by using max(sort_order) + 1
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
        parent_task_id, next_subtask_ids, sort_order, role,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    // Auto-set heartbeat_next_check_at when enabling heartbeat without explicit next check time
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

  // ── Heartbeat CRUD ──────────────────────────────────────────

  /** Get all tasks that have heartbeat due (enabled + next_check_at <= now, excluding completed tasks). */
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

  /** Create a heartbeat log entry. */
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

  /** Get heartbeat logs for a task, most recent first. */
  getHeartbeatLogs(taskId: string, limit = 20): HeartbeatLogRecord[] {
    return this.prepare(`
      SELECT * FROM heartbeat_logs
      WHERE task_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(taskId, limit) as HeartbeatLogRecord[]
  }

  /** Count consecutive errors for a task (from most recent). */
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

  // ── Agent CRUD ────────────────────────────────────────────

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

  // ── MCP Server CRUD ────────────────────────────────────────

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

  // ── Task Source CRUD ─────────────────────────────────────────

  getTaskSources(): TaskSourceRecord[] {
    const rows = this.prepare('SELECT * FROM task_sources ORDER BY created_at ASC').all() as TaskSourceRow[]
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
      'INSERT INTO task_sources (id, mcp_server_id, name, plugin_id, config, list_tool, list_tool_args, update_tool, update_tool_args, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)'
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

  // ── Skill CRUD ────────────────────────────────────────────

  getSkills(): SkillRecord[] {
    const rows = this.prepare(
      'SELECT * FROM skills WHERE is_deleted = 0 ORDER BY name ASC'
    ).all() as SkillRow[]
    return rows.map(deserializeSkill)
  }

  getSkill(id: string): SkillRecord | undefined {
    const row = this.prepare(
      'SELECT * FROM skills WHERE id = ? AND is_deleted = 0'
    ).get(id) as SkillRow | undefined
    return row ? deserializeSkill(row) : undefined
  }

  getSkillsByIds(ids: string[]): SkillRecord[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db.prepare(
      `SELECT * FROM skills WHERE id IN (${placeholders}) AND is_deleted = 0 ORDER BY name ASC`
    ).all(...ids) as SkillRow[]
    return rows.map(deserializeSkill)
  }

  createSkill(data: CreateSkillData): SkillRecord | undefined {
    const id = createId()
    const now = new Date().toISOString()
    const confidence = data.confidence ?? 0.5
    const uses = data.uses ?? 0
    const lastUsed = data.last_used ?? null
    const tags = JSON.stringify(data.tags ?? [])
    const preferredModel = normalizePreferredModel(data.preferred_model)
    this.prepare(`
      INSERT INTO skills (id, name, description, content, version, confidence, uses, last_used, tags, preferred_model, is_deleted, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, data.name, data.description, data.content, confidence, uses, lastUsed, tags, preferredModel, now, now)
    return this.getSkill(id)
  }

  updateSkill(id: string, data: UpdateSkillData): SkillRecord | undefined {
    const existing = this.getSkill(id)
    if (!existing) return undefined

    const setClauses: string[] = []
    const values: (string | number | null)[] = []

    if (data.name !== undefined) { setClauses.push('name = ?'); values.push(data.name) }
    if (data.description !== undefined) { setClauses.push('description = ?'); values.push(data.description) }
    if (data.content !== undefined) { setClauses.push('content = ?'); values.push(data.content) }
    if (data.confidence !== undefined) { setClauses.push('confidence = ?'); values.push(data.confidence) }
    if (data.uses !== undefined) { setClauses.push('uses = ?'); values.push(data.uses) }
    if (data.last_used !== undefined) { setClauses.push('last_used = ?'); values.push(data.last_used) }
    if (data.tags !== undefined) { setClauses.push('tags = ?'); values.push(JSON.stringify(data.tags)) }
    if (data.preferred_model !== undefined) {
      setClauses.push('preferred_model = ?'); values.push(normalizePreferredModel(data.preferred_model))
    }

    if (setClauses.length === 0) return existing

    // Only increment version for content changes, not usage updates (uses / last_used)
    const isContentChange = data.name !== undefined || data.description !== undefined ||
      data.content !== undefined || data.confidence !== undefined || data.tags !== undefined ||
      data.preferred_model !== undefined
    if (isContentChange) {
      setClauses.push('version = version + 1')
    }
    // `updated_at` means "when the content last changed", so usage updates
    // leave it alone.
    if (isContentChange) {
      setClauses.push('updated_at = ?')
      values.push(new Date().toISOString())
    }
    values.push(id)

    this.db.prepare(
      `UPDATE skills SET ${setClauses.join(', ')} WHERE id = ?`
    ).run(...values)

    return this.getSkill(id)
  }

  getSkillByName(name: string): SkillRecord | undefined {
    const row = this.prepare(
      'SELECT * FROM skills WHERE name = ? AND is_deleted = 0'
    ).get(name) as SkillRow | undefined
    return row ? deserializeSkill(row) : undefined
  }

  deleteSkill(id: string): boolean {
    const result = this.prepare(
      'UPDATE skills SET is_deleted = 1, updated_at = ? WHERE id = ? AND is_deleted = 0'
    ).run(new Date().toISOString(), id)
    return result.changes > 0
  }

  // ── Secret CRUD ──────────────────────────────────────────

  getSecrets(): SecretRecord[] {
    const rows = this.prepare(
      'SELECT * FROM secrets ORDER BY name ASC'
    ).all() as SecretRow[]
    return rows.map(deserializeSecret)
  }

  getSecret(id: string): SecretRecord | undefined {
    const row = this.prepare(
      'SELECT * FROM secrets WHERE id = ?'
    ).get(id) as SecretRow | undefined
    return row ? deserializeSecret(row) : undefined
  }

  getSecretsByIds(ids: string[]): SecretRecord[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db.prepare(
      `SELECT * FROM secrets WHERE id IN (${placeholders}) ORDER BY name ASC`
    ).all(...ids) as SecretRow[]
    return rows.map(deserializeSecret)
  }

  /**
   * Decrypts and returns secrets with their plaintext values.
   * ONLY for use within the main process (secret broker).
   * NEVER expose this through IPC.
   */
  getSecretsWithValues(ids: string[]): SecretRecordWithValue[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db.prepare(
      `SELECT * FROM secrets WHERE id IN (${placeholders}) ORDER BY name ASC`
    ).all(...ids) as SecretRow[]
    return rows.map(deserializeSecretWithValue)
  }

  createSecret(data: CreateSecretData): SecretRecord | undefined {
    const id = createId()
    const now = new Date().toISOString()
    const encryptedValue = encryptSecret(data.value)
    this.prepare(`
      INSERT INTO secrets (id, name, description, env_var_name, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, data.name, data.description, data.env_var_name, encryptedValue, now, now)
    return this.getSecret(id)
  }

  updateSecret(id: string, data: UpdateSecretData): SecretRecord | undefined {
    const existing = this.getSecret(id)
    if (!existing) return undefined

    const setClauses: string[] = []
    const values: (string | Buffer)[] = []

    if (data.name !== undefined) { setClauses.push('name = ?'); values.push(data.name) }
    if (data.description !== undefined) { setClauses.push('description = ?'); values.push(data.description) }
    if (data.env_var_name !== undefined) { setClauses.push('env_var_name = ?'); values.push(data.env_var_name) }
    if (data.value !== undefined) {
      setClauses.push('value = ?')
      values.push(encryptSecret(data.value))
    }

    if (setClauses.length === 0) return existing

    setClauses.push('updated_at = ?')
    values.push(new Date().toISOString())
    values.push(id)

    this.db.prepare(
      `UPDATE secrets SET ${setClauses.join(', ')} WHERE id = ?`
    ).run(...values)

    return this.getSecret(id)
  }

  deleteSecret(id: string): boolean {
    const result = this.prepare('DELETE FROM secrets WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ── Settings CRUD ──────────────────────────────────────────

  // API keys are encrypted at rest; callers in the main process always see plaintext.
  getSetting(key: string): string | undefined {
    const row = this.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return undefined
    return isApiKeySetting(key) ? decryptSettingValue(row.value) : row.value
  }

  setSetting(key: string, value: string): void {
    const stored = isApiKeySetting(key) ? encryptSettingValue(value) : value
    this.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, stored)
  }

  /**
   * Re-encrypts API keys saved in plaintext by older versions (or while the
   * keychain was unavailable). Runs on every startup and is a no-op once done.
   */
  encryptPlaintextApiKeys(): number {
    const rows = this.prepare("SELECT key, value FROM settings WHERE key LIKE '%\\_api\\_key' ESCAPE '\\'")
      .all() as { key: string; value: string }[]
    let migrated = 0
    for (const row of rows) {
      if (!isApiKeySetting(row.key) || !row.value || isEncryptedSettingValue(row.value)) continue
      const encrypted = encryptSettingValue(row.value)
      if (encrypted === row.value) continue // keychain unavailable: keep the fallback
      this.prepare('UPDATE settings SET value = ? WHERE key = ?').run(encrypted, row.key)
      migrated++
    }
    return migrated
  }

  deleteSetting(key: string): void {
    this.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }

  getAllSettings(): Record<string, string> {
    const rows = this.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
    const result: Record<string, string> = {}
    for (const row of rows) result[row.key] = isApiKeySetting(row.key) ? decryptSettingValue(row.value) : row.value
    return result
  }

  // ── OAuth Token CRUD ────────────────────────────────────────

  createOAuthToken(data: CreateOAuthTokenData): OAuthTokenRecord | undefined {
    const id = createId()
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString()

    this.prepare(`
      INSERT INTO oauth_tokens (id, provider, source_id, mcp_server_id, access_token, refresh_token, expires_at, scope, token_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.provider,
      data.source_id ?? null,
      data.mcp_server_id ?? null,
      encryptSecret(data.access_token),
      data.refresh_token ? encryptSecret(data.refresh_token) : null,
      expiresAt,
      data.scope,
      'Bearer',
      now,
      now
    )

    return this.getOAuthToken(id)
  }

  getOAuthToken(id: string): OAuthTokenRecord | undefined {
    const row = this.prepare(
      'SELECT * FROM oauth_tokens WHERE id = ?'
    ).get(id) as OAuthTokenRow | undefined

    return row ? deserializeOAuthToken(row) : undefined
  }

  getOAuthTokenBySource(sourceId: string): OAuthTokenRecord | undefined {
    const row = this.prepare(
      'SELECT * FROM oauth_tokens WHERE source_id = ?'
    ).get(sourceId) as OAuthTokenRow | undefined

    return row ? deserializeOAuthToken(row) : undefined
  }

  updateOAuthToken(id: string, accessToken: string, refreshToken: string | null, expiresIn: number): OAuthTokenRecord | undefined {
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()

    this.prepare(
      'UPDATE oauth_tokens SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ? WHERE id = ?'
    ).run(encryptSecret(accessToken), refreshToken ? encryptSecret(refreshToken) : null, expiresAt, now, id)

    return this.getOAuthToken(id)
  }

  deleteOAuthToken(id: string): boolean {
    const result = this.prepare('DELETE FROM oauth_tokens WHERE id = ?').run(id)
    return result.changes > 0
  }

  deleteOAuthTokenBySource(sourceId: string): boolean {
    const result = this.prepare('DELETE FROM oauth_tokens WHERE source_id = ?').run(sourceId)
    return result.changes > 0
  }

  getOAuthTokenByMcpServer(mcpServerId: string): OAuthTokenRecord | undefined {
    const row = this.prepare(
      'SELECT * FROM oauth_tokens WHERE mcp_server_id = ?'
    ).get(mcpServerId) as OAuthTokenRow | undefined
    return row ? deserializeOAuthToken(row) : undefined
  }

  deleteOAuthTokenByMcpServer(mcpServerId: string): boolean {
    const result = this.prepare('DELETE FROM oauth_tokens WHERE mcp_server_id = ?').run(mcpServerId)
    return result.changes > 0
  }

  // ── Marketplace Sources ──────────────────────────────────────

  getMarketplaceSources(): MarketplaceSourceRecord[] {
    const rows = this.prepare('SELECT * FROM marketplace_sources ORDER BY created_at DESC').all() as MarketplaceSourceRow[]
    return rows.map(deserializeMarketplaceSource)
  }

  getMarketplaceSource(id: string): MarketplaceSourceRecord | undefined {
    const row = this.prepare('SELECT * FROM marketplace_sources WHERE id = ?').get(id) as MarketplaceSourceRow | undefined
    return row ? deserializeMarketplaceSource(row) : undefined
  }

  getMarketplaceSourceByName(name: string): MarketplaceSourceRecord | undefined {
    const row = this.prepare('SELECT * FROM marketplace_sources WHERE name = ?').get(name) as MarketplaceSourceRow | undefined
    return row ? deserializeMarketplaceSource(row) : undefined
  }

  createMarketplaceSource(data: CreateMarketplaceSourceData): MarketplaceSourceRecord {
    const id = createId()
    const now = new Date().toISOString()
    this.prepare(
      'INSERT INTO marketplace_sources (id, name, source_type, source_url, metadata, auto_update, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, data.name, data.source_type || 'github', data.source_url, JSON.stringify(data.metadata || {}), data.auto_update ? 1 : 0, now, now)
    return this.getMarketplaceSource(id)!
  }

  deleteMarketplaceSource(id: string): boolean {
    const result = this.prepare('DELETE FROM marketplace_sources WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ── Installed Plugins ────────────────────────────────────────

  getInstalledPlugins(): InstalledPluginRecord[] {
    const rows = this.prepare('SELECT * FROM installed_plugins ORDER BY installed_at DESC').all() as InstalledPluginRow[]
    return rows.map(deserializeInstalledPlugin)
  }

  getInstalledPlugin(id: string): InstalledPluginRecord | undefined {
    const row = this.prepare('SELECT * FROM installed_plugins WHERE id = ?').get(id) as InstalledPluginRow | undefined
    return row ? deserializeInstalledPlugin(row) : undefined
  }

  getInstalledPluginByName(name: string, marketplaceId: string): InstalledPluginRecord | undefined {
    const row = this.prepare('SELECT * FROM installed_plugins WHERE name = ? AND marketplace_id = ?').get(name, marketplaceId) as InstalledPluginRow | undefined
    return row ? deserializeInstalledPlugin(row) : undefined
  }

  createInstalledPlugin(data: CreateInstalledPluginData): InstalledPluginRecord {
    const id = createId()
    const now = new Date().toISOString()
    this.prepare(
      'INSERT INTO installed_plugins (id, name, marketplace_id, manifest, source, scope, enabled, version, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id, data.name, data.marketplace_id, JSON.stringify(data.manifest || {}),
      JSON.stringify(data.source || {}), data.scope || 'user', 1, data.version || '1.0.0', now, now
    )
    return this.getInstalledPlugin(id)!
  }

  updateInstalledPlugin(id: string, data: UpdateInstalledPluginData): InstalledPluginRecord | undefined {
    const existing = this.getInstalledPlugin(id)
    if (!existing) return undefined
    const now = new Date().toISOString()
    const sets: string[] = ['updated_at = ?']
    const values: unknown[] = [now]
    if (data.enabled !== undefined) { sets.push('enabled = ?'); values.push(data.enabled ? 1 : 0) }
    if (data.manifest !== undefined) { sets.push('manifest = ?'); values.push(JSON.stringify(data.manifest)) }
    if (data.version !== undefined) { sets.push('version = ?'); values.push(data.version) }
    if (data.scope !== undefined) { sets.push('scope = ?'); values.push(data.scope) }
    values.push(id)
    this.db.prepare(`UPDATE installed_plugins SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    return this.getInstalledPlugin(id)
  }

  deleteInstalledPlugin(id: string): boolean {
    const result = this.prepare('DELETE FROM installed_plugins WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ── Mobile pairing ─────────────────────────────────────────

  createMobilePairCode(id: string, pin: string, expiresAt: number): void {
    this.prepare(
      'INSERT INTO mobile_pair_codes (id, pin, expires_at) VALUES (?, ?, ?)'
    ).run(id, pin, expiresAt)
  }

  getMobilePairCode(id: string): { id: string; pin: string; expires_at: number; attempts: number } | undefined {
    return this.prepare('SELECT * FROM mobile_pair_codes WHERE id = ?').get(id) as { id: string; pin: string; expires_at: number; attempts: number } | undefined
  }

  incrementPairCodeAttempts(id: string): number {
    this.prepare('UPDATE mobile_pair_codes SET attempts = attempts + 1 WHERE id = ?').run(id)
    const row = this.prepare('SELECT attempts FROM mobile_pair_codes WHERE id = ?').get(id) as { attempts: number } | undefined
    return row?.attempts ?? 0
  }

  deleteMobilePairCode(id: string): void {
    this.prepare('DELETE FROM mobile_pair_codes WHERE id = ?').run(id)
  }

  createMobileSession(id: string, tokenHash: string, deviceName: string): void {
    this.prepare(
      'INSERT INTO mobile_sessions (id, token_hash, device_name) VALUES (?, ?, ?)'
    ).run(id, tokenHash, deviceName)
  }

  getMobileSessionByTokenHash(tokenHash: string): { id: string; device_name: string; paired_at: number; last_seen: number; revoked: number } | undefined {
    return this.prepare('SELECT * FROM mobile_sessions WHERE token_hash = ? AND revoked = 0').get(tokenHash) as { id: string; device_name: string; paired_at: number; last_seen: number; revoked: number } | undefined
  }

  getMobileSessions(): { id: string; device_name: string; paired_at: number; last_seen: number; revoked: number }[] {
    return this.prepare('SELECT id, device_name, paired_at, last_seen, revoked FROM mobile_sessions WHERE revoked = 0 ORDER BY last_seen DESC').all() as { id: string; device_name: string; paired_at: number; last_seen: number; revoked: number }[]
  }

  touchMobileSession(tokenHash: string): void {
    this.prepare('UPDATE mobile_sessions SET last_seen = unixepoch() WHERE token_hash = ?').run(tokenHash)
  }

  revokeMobileSession(id: string): boolean {
    const result = this.prepare('UPDATE mobile_sessions SET revoked = 1 WHERE id = ?').run(id)
    return result.changes > 0
  }

  revokeAllMobileSessions(): void {
    this.prepare('UPDATE mobile_sessions SET revoked = 1').run()
  }
}
