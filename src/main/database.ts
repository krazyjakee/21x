import { captainTerminology } from '../shared/captain-compat'
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
import { mergeGrantStatus, type MergeCheckRecord, type MergeGrant, type MergeGrantSource, type MergeGrantReservation, type MergeGrantUse, type MergeGrantUseInput } from '../shared/merge-grants'
import { defaultHardCap, normalizeTouchPath, type ConcurrencyAuditEntry } from '../shared/concurrency'
import type { IssueAction, IssueWriteOrigin, IssueWriteRecord, IssueWriteStatus } from '../shared/issue-actions'
import {
  PROJECT_STATUS_BLOCKER_MAX_CHARS,
  PROJECT_STATUS_JOURNAL_COMPACT_AFTER_DAYS,
  PROJECT_STATUS_JOURNAL_ITEM_MAX_CHARS,
  PROJECT_STATUS_JOURNAL_MAX_ITEMS,
  PROJECT_STATUS_MAX_BLOCKERS,
  PROJECT_STATUS_SUMMARY_MAX_CHARS,
  type ProjectStatus,
  type ProjectStatusJournalEntry,
  type ProjectStatusJournalInput,
  type ProjectStatusJournalSource
} from '../shared/project-status'
import { SkillVersionConflictError } from './database/types'
import {
  JSON_COLUMNS,
  UPDATABLE_COLUMNS,
  deserializeAgent,
  deserializeInstalledPlugin,
  deserializeMarketplaceSource,
  deserializeMcpServer,
  deserializeOAuthToken,
  deserializeProject,
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
  CreateProjectData, ProjectRecord, ProjectRow, UpdateProjectData,
  CreateProjectRepoData, ProjectRepoRecord, UpdateProjectRepoData,
  CreateProjectResourceData, ProjectResourceRecord, UpdateProjectResourceData,
  CreateSecretData, SecretRecord, SecretRecordWithValue, SecretRow, UpdateSecretData,
  CreateSkillData, SkillListFilter, SkillRecord, SkillRow, UpdateSkillData,
  CreateTaskData, HeartbeatLogRecord, TaskRecord, TaskRow, UpdateTaskData,
  CreateTaskSourceData, TaskSourceRecord, TaskSourceRow, UpdateTaskSourceData,
  TranscriptPartInput, TranscriptPartRecord
} from './database/types'

export type * from './database/types'
export { SkillVersionConflictError } from './database/types'
export type { ProjectStatus, ProjectStatusJournalEntry, ProjectStatusJournalInput } from '../shared/project-status'

/**
 * A new agent's config with its hard cap (#150): an explicit cap is kept,
 * otherwise min(max_parallel_sessions, 5), as migration 20 gives existing agents.
 */
function withDefaultHardCap(config: CreateAgentData['config']): NonNullable<CreateAgentData['config']> {
  const next = { ...(config ?? {}) }
  const explicit = Number(next.concurrency_cap)
  if (!(Number.isFinite(explicit) && explicit >= 1)) next.concurrency_cap = defaultHardCap(next.max_parallel_sessions)
  return next
}

/** Most paths one task may declare it touches (#150). */
const MAX_TASK_TOUCHES = 200

/** A `project_status_journal` row (#72); the list columns hold JSON arrays. */
interface ProjectStatusJournalRow {
  id: string
  project_id: string
  summary: string
  completed: string
  blockers: string
  decisions: string
  next_steps: string
  source: string
  correlation_id: string | null
  created_at: string
}

/** A `merge_grants` row (#137); `pr_numbers` holds a JSON array. */
interface MergeGrantRow extends Omit<MergeGrant, 'pr_numbers' | 'action' | 'condition' | 'source'> {
  action: string
  condition: string
  source: string
  pr_numbers: string
}

function toMergeGrant(row: MergeGrantRow): MergeGrant {
  let prNumbers: number[] = []
  try {
    const parsed = JSON.parse(row.pr_numbers) as unknown
    if (Array.isArray(parsed)) prNumbers = parsed.filter((n): n is number => Number.isInteger(n) && n > 0)
  } catch {
    prNumbers = []
  }
  return {
    ...row,
    action: 'merge_pr',
    condition: 'checks_green_and_protection_satisfied',
    source: row.source === 'project_chat' ? 'project_chat' : 'commander',
    pr_numbers: prNumbers
  }
}

/** What the app (never the model) supplies when it stores a grant; see src/main/merge-grants.ts. */
export interface CreateMergeGrantData {
  project_id: string
  repo: string | null
  base_branch: string | null
  pr_numbers: number[]
  source: MergeGrantSource
  source_session_id: string | null
  source_message_id: string
  user_text: string
  expires_at: string
  max_uses: number | null
}

/** What the app (never the model) supplies to claim one delegated issue write. */
export interface BeginIssueWriteInput {
  idempotency_key: string
  project_id: string
  captain_task_id: string | null
  captain_session_id: string | null
  task_id: string | null
  repo: string
  action: IssueAction
  target_number: number | null
  payload_hash: string
  payload_fields: string
  /** Resolved from platform records, never from the caller's arguments. */
  origin: IssueWriteOrigin
  /** How long this attempt may hold the claim before it counts as unresolved. */
  lease_ms: number
}

/** What a claim attempt is allowed to do next. */
export interface BeginIssueWriteResult {
  state: 'reserved' | 'duplicate' | 'in_flight' | 'needs_reconcile' | 'conflict'
  record: IssueWriteRecord
}

export interface ApplyIssueWriteEffectsInput {
  attachment?: { taskId: string; url: string; id: string; addedAt: string }
  journal: ProjectStatusJournalInput
}

/** The outcome of one attempt, written once. */
export interface SettleIssueWriteInput {
  status: Exclude<IssueWriteStatus, 'reserved'>
  /** Must match the attempt that received the external answer. */
  attempt_epoch: number
  external_url?: string | null
  external_number?: number | null
  external_result?: string | null
  error?: string | null
}

/** What `recordProjectStatus` writes: the snapshot fields plus the journal highlights. */
export interface ProjectStatusUpdateInput extends ProjectStatusJournalInput {
  /** The snapshot's top blockers; also the journal entry's `blockers` unless those are given. */
  top_blockers?: string[]
}

/** Caps for a compaction entry: it stands for a month, so it may hold more than one update. */
const JOURNAL_COMPACTION_MAX_ITEMS = PROJECT_STATUS_JOURNAL_MAX_ITEMS * 2
const JOURNAL_COMPACTION_SUMMARY_MAX_CHARS = PROJECT_STATUS_SUMMARY_MAX_CHARS * 2
const JOURNAL_COMPACTION_LINE_MAX_CHARS = 200

function journalStringList(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function toJournalEntry(row: ProjectStatusJournalRow): ProjectStatusJournalEntry {
  return {
    id: row.id,
    project_id: row.project_id,
    summary: captainTerminology(row.summary),
    completed: journalStringList(row.completed).map(captainTerminology),
    blockers: journalStringList(row.blockers).map(captainTerminology),
    decisions: journalStringList(row.decisions).map(captainTerminology),
    next_steps: journalStringList(row.next_steps).map(captainTerminology),
    source: row.source === 'compaction' ? 'compaction' : row.source === 'system_recovery' ? 'system_recovery' : 'captain',
    correlation_id: row.correlation_id ?? null,
    created_at: row.created_at
  }
}

/** Trims, clips and caps one highlight list from the Captain. */
function cleanJournalList(value: unknown, maxItems = PROJECT_STATUS_JOURNAL_MAX_ITEMS): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim().slice(0, PROJECT_STATUS_JOURNAL_ITEM_MAX_CHARS)
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= maxItems) break
  }
  return out
}

/** What only the agent manager knows about a project's tasks (#58): see getProjectStatus. */
export interface ProjectStatusLiveState {
  /** Tasks waiting in the admission queue (#47). */
  queuedTaskIds?: Iterable<string>
  /** Tasks whose live session is in `waiting_approval`. */
  approvalTaskIds?: Iterable<string>
}

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
      JSON.stringify(withDefaultHardCap(data.config)),
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

  // ── Projects ─────────────────────────────────────────────────
  // A project groups tasks and task sources and has zero, one or many repos
  // plus context-only resources. Projects are archived, never deleted: tasks
  // reference them without a cascade.

  /** Active projects in sidebar order; `includeArchived` adds the archived ones. */
  getProjects(opts?: { includeArchived?: boolean }): ProjectRecord[] {
    if (!this.ensureDbOpen()) return []
    const where = opts?.includeArchived ? '' : ' WHERE archived = 0'
    const rows = this.prepare(
      `SELECT * FROM projects${where} ORDER BY sort_order ASC, created_at ASC`
    ).all() as ProjectRow[]
    return rows.map(deserializeProject)
  }

  getProject(id: string): ProjectRecord | undefined {
    if (!this.ensureDbOpen()) return undefined
    const row = this.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
    return row ? deserializeProject(row) : undefined
  }

  /** The project unassigned tasks and sources belong to; created by schema migration 15. */
  getDefaultProject(): ProjectRecord | undefined {
    return this.getProject(DEFAULT_PROJECT_ID)
  }

  createProject(data: CreateProjectData): ProjectRecord | undefined {
    const name = data.name?.trim()
    if (!name) throw new Error('A project needs a name.')
    const id = createId()
    const now = new Date().toISOString()
    const { next } = this.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM projects').get() as { next: number }
    this.prepare(`
      INSERT INTO projects (id, name, description, default_agent_id, captain_agent_id, git_provider, git_org, settings, sort_order, archived, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      id,
      name,
      data.description ?? '',
      data.default_agent_id ?? null,
      data.captain_agent_id ?? null,
      data.git_provider || null,
      data.git_org || null,
      JSON.stringify(data.settings ?? {}),
      next,
      now,
      now
    )
    // A project is born with its Captain (#55); the conversation is ready
    // before the user opens the drawer.
    ensureProjectCaptain(this.db, id)
    return this.getProject(id)
  }

  updateProject(id: string, data: UpdateProjectData): ProjectRecord | undefined {
    const setClauses: string[] = []
    const values: (string | null)[] = []
    if (data.name !== undefined) {
      const name = data.name.trim()
      if (!name) throw new Error('A project needs a name.')
      setClauses.push('name = ?'); values.push(name)
    }
    if (data.description !== undefined) { setClauses.push('description = ?'); values.push(data.description) }
    if (data.default_agent_id !== undefined) { setClauses.push('default_agent_id = ?'); values.push(data.default_agent_id || null) }
    if (data.captain_agent_id !== undefined) { setClauses.push('captain_agent_id = ?'); values.push(data.captain_agent_id || null) }
    if (data.git_provider !== undefined) { setClauses.push('git_provider = ?'); values.push(data.git_provider || null) }
    if (data.git_org !== undefined) { setClauses.push('git_org = ?'); values.push(data.git_org || null) }
    if (data.settings !== undefined) { setClauses.push('settings = ?'); values.push(JSON.stringify(data.settings ?? {})) }
    if (setClauses.length === 0) return this.getProject(id)

    setClauses.push('updated_at = ?')
    values.push(new Date().toISOString(), id)
    this.db.prepare(`UPDATE projects SET ${setClauses.join(', ')} WHERE id = ?`).run(...values)
    return this.getProject(id)
  }

  /**
   * Archive (or restore) a project. The Default project always stays active.
   * The project's Captain row is left alone either way: archiving keeps
   * the conversation (its row is hidden anyway), restoring finds it again.
   */
  archiveProject(id: string, archived = true): ProjectRecord | undefined {
    if (archived && id === DEFAULT_PROJECT_ID) throw new Error('The Default project cannot be archived.')
    this.prepare('UPDATE projects SET archived = ?, updated_at = ? WHERE id = ?')
      .run(archived ? 1 : 0, new Date().toISOString(), id)
    if (!archived && this.getProject(id)) ensureProjectCaptain(this.db, id)
    return this.getProject(id)
  }

  /** Index in `orderedIds` becomes each project's sort_order. */
  reorderProjects(orderedIds: string[]): void {
    this.reorderRows('projects', null, orderedIds)
  }

  // ── Project status (#58) ─────────────────────────────────────
  // Counts come from the task rows every time (plus the caller's live session
  // facts, which no row records); only the Captain's narrative is stored,
  // one snapshot per project in `project_status`. A journal of earlier
  // snapshots (#72) goes in its own table beside it.

  /**
   * The project's status: counts from the database and the stored narrative.
   * `live` carries what only the agent manager knows: tasks waiting in the
   * admission queue and tasks whose session is waiting for approval. Without
   * it those two counts are 0, never guessed.
   */
  getProjectStatus(projectId: string, live?: ProjectStatusLiveState): ProjectStatus {
    const empty: ProjectStatus = {
      project_id: projectId,
      counts: { running: 0, queued: 0, awaiting_review: 0, awaiting_approval: 0, blocked: 0 },
      summary: '',
      top_blockers: [],
      updated_at: null
    }
    if (!this.ensureDbOpen()) return empty

    const queued = new Set(live?.queuedTaskIds ?? [])
    const approval = new Set(live?.approvalTaskIds ?? [])
    const rows = this.prepare(
      `SELECT id, status, agent_id FROM tasks WHERE project_id = ? AND ${userTaskRoleFilter()}`
    ).all(projectId) as Array<{ id: string; status: string; agent_id: string | null }>
    const counts = { ...empty.counts }
    for (const row of rows) {
      if (row.status === TaskStatus.AgentWorking || row.status === TaskStatus.Triaging) counts.running += 1
      else if (row.status === TaskStatus.ReadyForReview) counts.awaiting_review += 1
      if (approval.has(row.id)) counts.awaiting_approval += 1
      if (queued.has(row.id)) counts.queued += 1
      else if (row.status === TaskStatus.NotStarted && !row.agent_id) counts.blocked += 1
    }

    const stored = this.prepare('SELECT summary, top_blockers, updated_at FROM project_status WHERE project_id = ?')
      .get(projectId) as { summary: string; top_blockers: string; updated_at: string } | undefined
    let topBlockers: string[] = []
    if (stored) {
      try {
        const parsed = JSON.parse(stored.top_blockers || '[]') as unknown
        if (Array.isArray(parsed)) topBlockers = parsed.filter((item): item is string => typeof item === 'string')
      } catch {
        // An unreadable list is an empty list; the summary still shows.
      }
    }
    return {
      project_id: projectId,
      counts,
      summary: captainTerminology(stored?.summary ?? ''),
      top_blockers: topBlockers.map(captainTerminology),
      updated_at: stored?.updated_at ?? null
    }
  }

  /**
   * Replaces the project's narrative snapshot. The text is trimmed and capped
   * (shared/project-status.ts) so the record stays one small read. Undefined
   * for an unknown project: no row is invented for it.
   */
  setProjectStatusSummary(projectId: string, summary: string, topBlockers: string[] = []): ProjectStatus | undefined {
    if (!this.ensureDbOpen() || !this.getProject(projectId)) return undefined
    const text = summary.trim().slice(0, PROJECT_STATUS_SUMMARY_MAX_CHARS)
    const blockers = topBlockers
      .map((item) => String(item).trim().slice(0, PROJECT_STATUS_BLOCKER_MAX_CHARS))
      .filter(Boolean)
      .slice(0, PROJECT_STATUS_MAX_BLOCKERS)
    const now = new Date().toISOString()
    this.prepare(`
      INSERT INTO project_status (project_id, summary, top_blockers, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        summary = excluded.summary,
        top_blockers = excluded.top_blockers,
        updated_at = excluded.updated_at
    `).run(projectId, text, JSON.stringify(blockers), now)
    return this.getProjectStatus(projectId)
  }

  // ── Project status journal (#72) ─────────────────────────────
  // The snapshot above stays the cheap read; every update also lands here as
  // one row, so "what changed?" has an answer without a growing blob anywhere.
  // Reads are newest first over (created_at, id), which stays stable while new
  // rows arrive: a newer row can never fall behind an older cursor.

  /**
   * Appends one journal entry. Lists are trimmed, deduplicated and capped
   * (shared/project-status.ts); an empty summary or unknown project writes
   * nothing. `createdAt` is for the roll-up and tests; callers normally omit it.
   */
  appendProjectStatusJournal(
    projectId: string,
    input: ProjectStatusJournalInput,
    options: { source?: ProjectStatusJournalSource; createdAt?: string } = {}
  ): ProjectStatusJournalEntry | undefined {
    if (!this.ensureDbOpen() || !this.getProject(projectId)) return undefined
    const summary = (input.summary ?? '').trim().slice(0, PROJECT_STATUS_SUMMARY_MAX_CHARS)
    if (!summary) return undefined
    const id = createId()
    const correlationId = typeof input.correlation_id === 'string' && input.correlation_id.trim() ? input.correlation_id.trim().slice(0, 100) : null
    this.prepare(`
      INSERT INTO project_status_journal
        (id, project_id, summary, completed, blockers, decisions, next_steps, source, correlation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      projectId,
      summary,
      JSON.stringify(cleanJournalList(input.completed)),
      JSON.stringify(cleanJournalList(input.blockers)),
      JSON.stringify(cleanJournalList(input.decisions)),
      JSON.stringify(cleanJournalList(input.next_steps)),
      options.source ?? 'captain',
      correlationId,
      options.createdAt ?? new Date().toISOString()
    )
    return this.getProjectStatusJournalEntry(id)
  }

  // ── Merge grants (#137) ─────────────────────────────────────
  // Stored and read here; created, checked and used only through
  // src/main/merge-grants.ts, which binds each grant to a user-typed message.

  /**
   * Undefined when the project is unknown or that user message already backs
   * a grant (in any project: one message, one project).
   */
  createMergeGrant(data: CreateMergeGrantData): MergeGrant | undefined {
    if (!this.ensureDbOpen() || !this.getProject(data.project_id)) return undefined
    const existing = this.prepare('SELECT id FROM merge_grants WHERE source = ? AND source_message_id = ?')
      .get(data.source, data.source_message_id)
    if (existing) return undefined
    const id = createId()
    this.prepare(`
      INSERT INTO merge_grants
        (id, project_id, action, condition, repo, base_branch, pr_numbers, source, source_session_id, source_message_id, user_text, created_at, expires_at, max_uses, uses)
      VALUES (?, ?, 'merge_pr', 'checks_green_and_protection_satisfied', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      id,
      data.project_id,
      data.repo,
      data.base_branch,
      JSON.stringify(data.pr_numbers),
      data.source,
      data.source_session_id,
      data.source_message_id,
      data.user_text,
      new Date().toISOString(),
      data.expires_at,
      data.max_uses
    )
    return this.getMergeGrant(id)
  }

  getMergeGrant(id: string): MergeGrant | undefined {
    if (!this.ensureDbOpen()) return undefined
    const row = this.prepare('SELECT * FROM merge_grants WHERE id = ?').get(id) as MergeGrantRow | undefined
    return row ? toMergeGrant(row) : undefined
  }

  /** Newest first. `activeOnly` drops revoked, expired and used-up grants. */
  listMergeGrants(options: { projectId?: string; activeOnly?: boolean } = {}): MergeGrant[] {
    if (!this.ensureDbOpen()) return []
    const rows = (options.projectId
      ? this.prepare('SELECT * FROM merge_grants WHERE project_id = ? ORDER BY created_at DESC, id DESC').all(options.projectId)
      : this.prepare('SELECT * FROM merge_grants ORDER BY created_at DESC, id DESC').all()) as MergeGrantRow[]
    const grants = rows.map(toMergeGrant)
    if (!options.activeOnly) return grants
    const now = Date.now()
    return grants.filter((grant) => mergeGrantStatus(grant, now) === 'active')
  }

  /** Revokes a grant once; false when it does not exist or was already revoked. */
  revokeMergeGrant(id: string, revokedBy: string = 'user'): boolean {
    if (!this.ensureDbOpen()) return false
    const info = this.prepare('UPDATE merge_grants SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL').run(new Date().toISOString(), revokedBy, id)
    return info.changes > 0
  }

  /**
   * Reserves one use of a grant before a merge runs, atomically and only
   * while the grant is active (not revoked, not expired, under its count).
   * Undefined when it is not. A merge that then fails gives the use back
   * with {@link refundMergeGrantUse}; one that succeeds is recorded with
   * {@link recordMergeGrantUse}.
   */
  reserveMergeGrantUse(grantId: string, snapshot: MergeGrantUseInput): { grant: MergeGrant; reservationId: string } | undefined {
    if (!this.ensureDbOpen()) return undefined
    return this.db.transaction(() => {
      const grant = this.getMergeGrant(grantId)
      if (!grant || mergeGrantStatus(grant) !== 'active') return undefined
      // An uncertain/in-flight operation for this PR must be reconciled before
      // another grant can spend authority on it or claim the same merge.
      if (this.listPendingMergeGrantReservations(grant.project_id).some((pending) =>
        pending.snapshot.pr_url.toLowerCase() === snapshot.pr_url.toLowerCase())) return undefined
      const reservationId = createId()
      this.prepare('UPDATE merge_grants SET uses = uses + 1 WHERE id = ?').run(grantId)
      this.prepare('INSERT INTO merge_grant_reservations (id, grant_id, project_id, snapshot, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(reservationId, grantId, grant.project_id, JSON.stringify(snapshot), new Date().toISOString())
      return { grant: this.getMergeGrant(grantId)!, reservationId }
    }).immediate()
  }

  /** Resolves one pending reservation exactly once; retrying cannot refund another merge. */
  refundMergeGrantUse(reservationId: string): void {
    if (!this.ensureDbOpen()) return
    this.db.transaction(() => {
      const row = this.prepare("SELECT grant_id FROM merge_grant_reservations WHERE id = ? AND state = 'pending'").get(reservationId) as { grant_id: string } | undefined
      if (!row) return
      this.prepare("UPDATE merge_grant_reservations SET state = 'failed' WHERE id = ?").run(reservationId)
      this.prepare('UPDATE merge_grants SET uses = uses - 1 WHERE id = ? AND uses > 0').run(row.grant_id)
    }).immediate()
  }

  listPendingMergeGrantReservations(projectId?: string): MergeGrantReservation[] {
    if (!this.ensureDbOpen()) return []
    const rows = (projectId
      ? this.prepare("SELECT * FROM merge_grant_reservations WHERE state = 'pending' AND project_id = ?").all(projectId)
      : this.prepare("SELECT * FROM merge_grant_reservations WHERE state = 'pending'").all()) as Array<Omit<MergeGrantReservation, 'snapshot'> & { snapshot: string }>
    return rows.map((row) => ({ ...row, snapshot: JSON.parse(row.snapshot) as MergeGrantUseInput }))
  }

  /** Finalizes the saved snapshot and audit together; recovery is idempotent. */
  recordMergeGrantUse(reservationId: string): MergeGrantUse | undefined {
    if (!this.ensureDbOpen()) return undefined
    return this.db.transaction(() => {
      const row = this.prepare("SELECT * FROM merge_grant_reservations WHERE id = ? AND state = 'pending'").get(reservationId) as { grant_id: string; project_id: string; snapshot: string } | undefined
      if (!row) return undefined
      const use = JSON.parse(row.snapshot) as MergeGrantUseInput
      const now = new Date().toISOString()
      this.prepare("UPDATE merge_grant_reservations SET state = 'merged' WHERE id = ?").run(reservationId)
      this.prepare('UPDATE merge_grants SET last_used_at = ? WHERE id = ?').run(now, row.grant_id)
      this.prepare(`
        INSERT INTO merge_grant_uses
          (id, grant_id, project_id, pr_url, pr_title, base_branch, head_sha, method, merge_state, review_decision, checks, merged_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(reservationId, row.grant_id, row.project_id, use.pr_url, use.pr_title, use.base_branch, use.head_sha, use.method, use.merge_state, use.review_decision, JSON.stringify(use.checks), now)
      const entry = this.appendProjectStatusJournal(row.project_id, {
        summary: `Merged ${use.pr_url} (${use.method}, ${use.head_sha.slice(0, 7)}) under the user's merge grant ${row.grant_id}.`,
        completed: [`Merged ${use.pr_url}${use.pr_title ? ` "${use.pr_title.slice(0, 120)}"` : ''}`],
        decisions: [`Merge authorised by merge grant ${row.grant_id}`]
      })
      if (!entry) throw new Error('Could not write the merge grant journal entry')
      return { ...use, id: reservationId, grant_id: row.grant_id, project_id: row.project_id, merged_at: now }
    }).immediate()
  }

  listMergeGrantUses(grantId: string): MergeGrantUse[] {
    if (!this.ensureDbOpen()) return []
    const rows = this.prepare('SELECT * FROM merge_grant_uses WHERE grant_id = ? ORDER BY merged_at DESC, id DESC').all(grantId) as Array<Omit<MergeGrantUse, 'checks'> & { checks: string }>
    return rows.map((row) => {
      let checks: MergeCheckRecord[] = []
      try {
        const parsed = JSON.parse(row.checks) as unknown
        if (Array.isArray(parsed)) checks = parsed as MergeCheckRecord[]
      } catch {
        checks = []
      }
      return { ...row, checks }
    })
  }

  // ── Delegated GitHub issue writes ───────────────────────────
  // The ledger is both the audit record and the idempotency claim (see
  // database/issue-writes-migration.ts). Created, checked and settled only
  // through src/main/issue-writes.ts, which resolves the human origin first.

  /**
   * Claims `idempotency_key` for one attempt, or says why the caller may not
   * proceed. One immediate transaction, so two attempts racing on the same key
   * cannot both reserve it:
   *
   * - no row            → `reserved`, the caller calls GitHub;
   * - `succeeded`       → `duplicate`, the write already happened;
   * - `reserved` in lease → `in_flight`, another attempt owns it;
   * - `reserved` expired  → flipped to `unresolved` and returned as
   *                         `needs_reconcile`: the write may have landed, so
   *                         GitHub must be asked before anything retries;
   * - `unresolved`      → `needs_reconcile`, same reason;
   * - `failed`          → `reserved` again, with `attempts` incremented.
   */
  beginIssueWrite(input: BeginIssueWriteInput): BeginIssueWriteResult {
    const fallback: IssueWriteRecord = {
      id: '', idempotency_key: input.idempotency_key, project_id: input.project_id,
      captain_task_id: input.captain_task_id ?? null, captain_session_id: input.captain_session_id ?? null,
      task_id: input.task_id ?? null, repo: input.repo, action: input.action, target_number: input.target_number ?? null,
      payload_hash: input.payload_hash, payload_fields: input.payload_fields, origin_kind: input.origin.kind, origin_message_id: input.origin.messageId,
      origin_session_id: input.origin.sessionId, origin_text_hash: input.origin.textHash, origin_excerpt: input.origin.excerpt,
      origin_authored_at: input.origin.authoredAt, correlation_id: input.origin.correlationId, status: 'unresolved',
      external_url: null, external_number: null, external_result: null, error: 'The database is not open.',
      attempts: 1, attempt_epoch: 1, lease_expires_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), settled_at: null,
      effects_applied_at: null
    }
    if (!this.ensureDbOpen()) return { state: 'needs_reconcile', record: fallback }
    return this.db.transaction((): BeginIssueWriteResult => {
      const now = Date.now()
      const nowIso = new Date(now).toISOString()
      const existing = this.getIssueWriteByKey(input.idempotency_key)
      if (!existing) {
        const id = createId()
        this.prepare(`
          INSERT INTO issue_writes
            (id, idempotency_key, project_id, captain_task_id, captain_session_id, task_id, repo, action, target_number,
             payload_hash, payload_fields, origin_kind, origin_message_id, origin_session_id, origin_text_hash,
             origin_excerpt, origin_authored_at, correlation_id, status, attempts, attempt_epoch, lease_expires_at,
             created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 1, 1, ?, ?, ?)
        `).run(
          id, input.idempotency_key, input.project_id, input.captain_task_id ?? null, input.captain_session_id ?? null,
          input.task_id ?? null, input.repo, input.action, input.target_number ?? null, input.payload_hash,
          input.payload_fields, input.origin.kind, input.origin.messageId, input.origin.sessionId,
          input.origin.textHash, input.origin.excerpt,
          input.origin.authoredAt, input.origin.correlationId, now + input.lease_ms, nowIso, nowIso
        )
        return { state: 'reserved', record: this.getIssueWrite(id)! }
      }
      // An idempotency key is a durable binding, not a mutable slot. Check the
      // complete operation and trusted human origin before *any* status-based
      // retry logic, including failed rows. A mismatch leaves the original
      // audit row byte-for-byte attributable to the operation it recorded.
      const sameNullable = (left: string | number | null, right: string | number | null): boolean => left === right
      const sameBinding =
        existing.project_id === input.project_id &&
        sameNullable(existing.captain_task_id, input.captain_task_id ?? null) &&
        sameNullable(existing.captain_session_id, input.captain_session_id ?? null) &&
        existing.repo === input.repo &&
        existing.action === input.action &&
        sameNullable(existing.target_number, input.target_number ?? null) &&
        sameNullable(existing.task_id, input.task_id ?? null) &&
        existing.payload_hash === input.payload_hash &&
        existing.payload_fields === input.payload_fields &&
        existing.origin_kind === input.origin.kind &&
        existing.origin_message_id === input.origin.messageId &&
        sameNullable(existing.origin_session_id, input.origin.sessionId) &&
        existing.origin_text_hash === input.origin.textHash &&
        existing.origin_excerpt === input.origin.excerpt &&
        existing.origin_authored_at === input.origin.authoredAt &&
        sameNullable(existing.correlation_id, input.origin.correlationId)
      if (!sameBinding) return { state: 'conflict', record: existing }
      if (existing.status === 'succeeded') return { state: 'duplicate', record: existing }
      if (existing.status === 'unresolved') return { state: 'needs_reconcile', record: existing }
      if (existing.status === 'reserved') {
        const lease = this.prepare('SELECT lease_expires_at AS lease FROM issue_writes WHERE id = ?').get(existing.id) as { lease: number | null } | undefined
        if (lease?.lease && lease.lease > now) return { state: 'in_flight', record: existing }
        // The attempt that held this claim never came back. Its write may have
        // landed, so the claim becomes a question, not a free slot.
        this.prepare("UPDATE issue_writes SET status = 'unresolved', attempt_epoch = attempt_epoch + 1, lease_expires_at = NULL, error = ?, updated_at = ? WHERE id = ? AND status = 'reserved'")
          .run('The attempt holding this claim ended without an answer from GitHub.', nowIso, existing.id)
        return { state: 'needs_reconcile', record: this.getIssueWrite(existing.id)! }
      }
      // failed: GitHub certainly refused, so a fresh attempt is safe.
      this.prepare("UPDATE issue_writes SET status = 'reserved', attempts = attempts + 1, attempt_epoch = attempt_epoch + 1, error = NULL, settled_at = NULL, lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'failed'")
        .run(now + input.lease_ms, nowIso, existing.id)
      return { state: 'reserved', record: this.getIssueWrite(existing.id)! }
    }).immediate()
  }

  /**
   * Settles one open attempt exactly once. `reserved` is the live attempt and
   * `unresolved` is the one reconciliation is answering; a row that already
   * reached `succeeded` or `failed` is left alone and undefined is returned,
   * so a late answer can never overwrite what was recorded first.
   */
  settleIssueWrite(id: string, outcome: SettleIssueWriteInput): IssueWriteRecord | undefined {
    if (!this.ensureDbOpen()) return undefined
    return this.db.transaction((): IssueWriteRecord | undefined => {
      const row = this.prepare("SELECT id FROM issue_writes WHERE id = ? AND attempt_epoch = ? AND status IN ('reserved', 'unresolved')")
        .get(id, outcome.attempt_epoch) as { id: string } | undefined
      if (!row) return undefined
      const nowIso = new Date().toISOString()
      const settledAt = outcome.status === 'unresolved' ? null : nowIso
      const nextEpoch = outcome.status === 'unresolved' ? outcome.attempt_epoch + 1 : outcome.attempt_epoch
      this.prepare(`
        UPDATE issue_writes
           SET status = ?, external_url = ?, external_number = ?, external_result = ?, error = ?,
               attempt_epoch = ?, lease_expires_at = NULL, settled_at = ?, updated_at = ?
         WHERE id = ? AND attempt_epoch = ? AND status IN ('reserved', 'unresolved')
      `).run(
        outcome.status, outcome.external_url ?? null, outcome.external_number ?? null,
        outcome.external_result ?? null, outcome.error ?? null, nextEpoch, settledAt, nowIso, id, outcome.attempt_epoch
      )
      return this.getIssueWrite(id)
    }).immediate()
  }

  /**
   * Commits the recoverable local half of a successful issue write exactly
   * once. The task attachment, status-journal entry and durable marker share
   * one SQLite transaction, so a crash can leave either all three or none.
   */
  applyIssueWriteEffects(id: string, input: ApplyIssueWriteEffectsInput): IssueWriteRecord | undefined {
    if (!this.ensureDbOpen()) return undefined
    return this.db.transaction((): IssueWriteRecord | undefined => {
      const record = this.getIssueWrite(id)
      if (!record || record.status !== 'succeeded') return undefined
      if (record.effects_applied_at) return record

      if (input.attachment) {
        if (record.task_id !== input.attachment.taskId || record.external_url !== input.attachment.url) return undefined
        const task = this.getTask(input.attachment.taskId)
        if (!task) return undefined
        if (!task.attachments.some((item) => item.filename === input.attachment!.url)) {
          this.updateTask(task.id, {
            attachments: [...task.attachments, {
              id: input.attachment.id,
              filename: input.attachment.url,
              size: 0,
              mime_type: 'text/x-github-issue',
              added_at: input.attachment.addedAt
            }]
          })
        }
      }

      const entry = this.appendProjectStatusJournal(record.project_id, input.journal)
      if (!entry) throw new Error('Could not write the delegated issue journal entry')
      const now = new Date().toISOString()
      const changed = this.prepare(
        "UPDATE issue_writes SET effects_applied_at = ?, updated_at = ? WHERE id = ? AND status = 'succeeded' AND effects_applied_at IS NULL"
      ).run(now, now, id).changes
      if (changed !== 1) throw new Error('Could not mark delegated issue effects as applied')
      return this.getIssueWrite(id)
    }).immediate()
  }

  getIssueWrite(id: string): IssueWriteRecord | undefined {
    if (!this.ensureDbOpen()) return undefined
    const row = this.prepare('SELECT * FROM issue_writes WHERE id = ?').get(id) as IssueWriteRecord | undefined
    return row
  }

  getIssueWriteByKey(key: string): IssueWriteRecord | undefined {
    if (!this.ensureDbOpen()) return undefined
    return this.prepare('SELECT * FROM issue_writes WHERE idempotency_key = ?').get(key) as IssueWriteRecord | undefined
  }

  /** The ledger, newest first. */
  listIssueWrites(options: { projectId?: string; taskId?: string; limit?: number } = {}): IssueWriteRecord[] {
    if (!this.ensureDbOpen()) return []
    const where: string[] = []
    const params: unknown[] = []
    if (options.projectId) { where.push('project_id = ?'); params.push(options.projectId) }
    if (options.taskId) { where.push('task_id = ?'); params.push(options.taskId) }
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500)
    params.push(limit)
    return this.prepare(
      `SELECT * FROM issue_writes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`
    ).all(...params) as IssueWriteRecord[]
  }

  /**
   * Writes whose outcome is unknown, plus reserved claims whose lease has run
   * out (they are the same question). Reconciliation asks GitHub about these.
   */
  listUnresolvedIssueWrites(projectId?: string): IssueWriteRecord[] {
    if (!this.ensureDbOpen()) return []
    return this.db.transaction((): IssueWriteRecord[] => {
      const now = Date.now()
      const nowIso = new Date(now).toISOString()
      const projectClause = projectId ? ' AND project_id = ?' : ''
      this.prepare(`
        UPDATE issue_writes
           SET status = 'unresolved', attempt_epoch = attempt_epoch + 1,
               lease_expires_at = NULL, error = ?, updated_at = ?
         WHERE status = 'reserved' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?${projectClause}
      `).run('The attempt holding this claim ended without an answer from GitHub.', nowIso, now, ...(projectId ? [projectId] : []))
      return (projectId
        ? this.prepare("SELECT * FROM issue_writes WHERE project_id = ? AND status = 'unresolved' ORDER BY created_at ASC").all(projectId)
        : this.prepare("SELECT * FROM issue_writes WHERE status = 'unresolved' ORDER BY created_at ASC").all()) as IssueWriteRecord[]
    }).immediate()
  }

  /** Successful external writes whose atomic local task/journal effects have
   * not committed yet. Unbounded on purpose: startup recovery must not strand
   * an older row behind a display-oriented page limit. */
  listIssueWritesPendingEffects(projectId?: string): IssueWriteRecord[] {
    if (!this.ensureDbOpen()) return []
    return (projectId
      ? this.prepare("SELECT * FROM issue_writes WHERE project_id = ? AND status = 'succeeded' AND effects_applied_at IS NULL ORDER BY created_at ASC, id ASC").all(projectId)
      : this.prepare("SELECT * FROM issue_writes WHERE status = 'succeeded' AND effects_applied_at IS NULL ORDER BY created_at ASC, id ASC").all()
    ) as IssueWriteRecord[]
  }

  getProjectStatusJournalEntry(id: string): ProjectStatusJournalEntry | undefined {
    if (!this.ensureDbOpen()) return undefined
    const row = this.prepare('SELECT * FROM project_status_journal WHERE id = ?').get(id) as ProjectStatusJournalRow | undefined
    return row ? toJournalEntry(row) : undefined
  }

  /**
   * One status update from the Captain: replaces the snapshot and appends
   * the journal entry in one transaction. The entry's `blockers` default to
   * the snapshot's `top_blockers`. Undefined for an unknown project.
   */
  recordProjectStatus(projectId: string, input: ProjectStatusUpdateInput): { status: ProjectStatus; entry: ProjectStatusJournalEntry } | undefined {
    if (!this.ensureDbOpen() || !this.getProject(projectId)) return undefined
    const write = this.db.transaction((): { status: ProjectStatus; entry: ProjectStatusJournalEntry } | undefined => {
      const status = this.setProjectStatusSummary(projectId, input.summary, input.top_blockers ?? [])
      if (!status) return undefined
      const entry = this.appendProjectStatusJournal(projectId, { ...input, blockers: input.blockers ?? input.top_blockers ?? [] })
      if (!entry) throw new Error('summary is required')
      return { status, entry }
    })
    return write()
  }

  /**
   * A page of journal entries, newest first. `before` is the (created_at, id)
   * of the last entry of the previous page; the page holds up to `limit`
   * entries and says whether more exist. The caller caps `limit`.
   */
  listProjectStatusJournal(
    projectId: string,
    options: { limit: number; before?: { created_at: string; id: string } | null }
  ): { entries: ProjectStatusJournalEntry[]; has_more: boolean } {
    if (!this.ensureDbOpen()) return { entries: [], has_more: false }
    const limit = Math.max(1, Math.floor(options.limit))
    const rows = (options.before
      ? this.prepare(`
          SELECT * FROM project_status_journal
          WHERE project_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC LIMIT ?
        `).all(projectId, options.before.created_at, options.before.created_at, options.before.id, limit + 1)
      : this.prepare(`
          SELECT * FROM project_status_journal
          WHERE project_id = ?
          ORDER BY created_at DESC, id DESC LIMIT ?
        `).all(projectId, limit + 1)) as ProjectStatusJournalRow[]
    return { entries: rows.slice(0, limit).map(toJournalEntry), has_more: rows.length > limit }
  }

  countProjectStatusJournal(projectId: string): number {
    if (!this.ensureDbOpen()) return 0
    const row = this.prepare('SELECT COUNT(*) AS n FROM project_status_journal WHERE project_id = ?').get(projectId) as { n: number }
    return row.n
  }

  /**
   * Retention (#72): Captain entries older than the window (90 days) are
   * rolled into one `compaction` entry per project and calendar month, then
   * deleted. The roll-up keeps a dated line per folded summary (newest lines
   * win when the cap is hit) and the union of each highlight list, so
   * decisions stay findable. An existing roll-up for the month absorbs new
   * arrivals, which makes the run idempotent: a second run folds nothing.
   * Runs at startup; `now` is for tests.
   */
  compactProjectStatusJournal(now: Date = new Date()): { folded: number; written: number } {
    if (!this.ensureDbOpen()) return { folded: 0, written: 0 }
    const cutoff = new Date(now.getTime() - PROJECT_STATUS_JOURNAL_COMPACT_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const stale = this.prepare(`
      SELECT * FROM project_status_journal
      WHERE source = 'captain' AND created_at < ?
      ORDER BY project_id ASC, created_at ASC, id ASC
    `).all(cutoff) as ProjectStatusJournalRow[]
    if (stale.length === 0) return { folded: 0, written: 0 }

    const groups = new Map<string, ProjectStatusJournalRow[]>()
    for (const row of stale) {
      const key = `${row.project_id}::${row.created_at.slice(0, 7)}`
      const group = groups.get(key)
      if (group) group.push(row)
      else groups.set(key, [row])
    }

    const run = this.db.transaction((): { folded: number; written: number } => {
      let written = 0
      for (const [key, rows] of groups) {
        const [projectId, month] = key.split('::')
        const existing = this.prepare(`
          SELECT * FROM project_status_journal
          WHERE project_id = ? AND source = 'compaction' AND substr(created_at, 1, 7) = ?
          ORDER BY created_at DESC LIMIT 1
        `).get(projectId, month) as ProjectStatusJournalRow | undefined

        // Newest lines first, so what survives the cap is the latest of the month.
        const lines = rows
          .map((row) => `${row.created_at.slice(0, 10)}: ${row.summary.replace(/\s+/g, ' ').trim().slice(0, JOURNAL_COMPACTION_LINE_MAX_CHARS)}`)
          .reverse()
        if (existing?.summary) lines.push(...existing.summary.split('\n').filter(Boolean).reverse())
        const kept: string[] = []
        let chars = 0
        for (const line of lines) {
          if (kept.length > 0 && chars + line.length + 1 > JOURNAL_COMPACTION_SUMMARY_MAX_CHARS) break
          kept.push(line)
          chars += line.length + 1
        }
        const summary = kept.reverse().join('\n').slice(0, JOURNAL_COMPACTION_SUMMARY_MAX_CHARS)

        const union = (pick: (row: ProjectStatusJournalRow) => string): string[] =>
          cleanJournalList([...(existing ? journalStringList(pick(existing)) : []), ...rows.flatMap((row) => journalStringList(pick(row)))], JOURNAL_COMPACTION_MAX_ITEMS)
        const newest = rows[rows.length - 1].created_at
        const createdAt = existing && existing.created_at > newest ? existing.created_at : newest
        const values = [
          summary,
          JSON.stringify(union((row) => row.completed)),
          JSON.stringify(union((row) => row.blockers)),
          JSON.stringify(union((row) => row.decisions)),
          JSON.stringify(union((row) => row.next_steps)),
          createdAt
        ]
        if (existing) {
          this.prepare(`
            UPDATE project_status_journal
            SET summary = ?, completed = ?, blockers = ?, decisions = ?, next_steps = ?, created_at = ?
            WHERE id = ?
          `).run(...values, existing.id)
        } else {
          this.prepare(`
            INSERT INTO project_status_journal
              (id, project_id, summary, completed, blockers, decisions, next_steps, source, correlation_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'compaction', NULL, ?)
          `).run(createId(), projectId, ...values)
        }
        written += 1
        const remove = this.prepare('DELETE FROM project_status_journal WHERE id = ?')
        for (const row of rows) remove.run(row.id)
      }
      return { folded: stale.length, written }
    })
    return run()
  }

  // ── Concurrency control (#150) ───────────────────────────────

  /** Appends one row to the project's concurrency audit feed. */
  appendConcurrencyAudit(entry: Omit<ConcurrencyAuditEntry, 'id' | 'created_at'> & { created_at?: string }): ConcurrencyAuditEntry | undefined {
    if (!this.ensureDbOpen() || !this.getProject(entry.project_id)) return undefined
    const row: ConcurrencyAuditEntry = {
      id: createId(),
      project_id: entry.project_id,
      agent_id: entry.agent_id,
      kind: entry.kind,
      previous_level: entry.previous_level,
      level: entry.level,
      cap: entry.cap,
      actor: entry.actor,
      reason: entry.reason.trim().slice(0, 500),
      created_at: entry.created_at ?? new Date().toISOString()
    }
    this.prepare(`
      INSERT INTO concurrency_audit (id, project_id, agent_id, kind, previous_level, level, cap, actor, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.project_id, row.agent_id, row.kind, row.previous_level, row.level, row.cap, row.actor, row.reason, row.created_at)
    return row
  }

  /** The project's concurrency changes, newest first. */
  listConcurrencyAudit(projectId: string, limit = 20): ConcurrencyAuditEntry[] {
    if (!this.ensureDbOpen()) return []
    return this.prepare(`
      SELECT id, project_id, agent_id, kind, previous_level, level, cap, actor, reason, created_at
      FROM concurrency_audit WHERE project_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(projectId, Math.max(1, Math.min(200, Math.floor(limit)))) as ConcurrencyAuditEntry[]
  }

  /** The files a task declared it will change; [] when it declared none. */
  getTaskTouches(taskId: string): string[] {
    if (!this.ensureDbOpen()) return []
    const row = this.prepare('SELECT paths FROM task_touches WHERE task_id = ?').get(taskId) as { paths: string } | undefined
    return row ? parseJsonArray(row.paths) : []
  }

  /** Replaces a task's declared touches; an empty list clears them. Returns what is stored. */
  setTaskTouches(taskId: string, paths: string[]): string[] {
    if (!this.ensureDbOpen() || !this.getTask(taskId)) return []
    const cleaned = [...new Set(paths.map((p) => normalizeTouchPath(String(p))).filter(Boolean))].slice(0, MAX_TASK_TOUCHES)
    if (cleaned.length === 0) {
      this.prepare('DELETE FROM task_touches WHERE task_id = ?').run(taskId)
      return []
    }
    this.prepare(`
      INSERT INTO task_touches (task_id, paths, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET paths = excluded.paths, updated_at = excluded.updated_at
    `).run(taskId, JSON.stringify(cleaned), new Date().toISOString())
    return cleaned
  }

  getProjectRepos(projectId: string): ProjectRepoRecord[] {
    if (!this.ensureDbOpen()) return []
    return this.prepare(
      'SELECT * FROM project_repos WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC'
    ).all(projectId) as ProjectRepoRecord[]
  }

  getProjectRepo(id: string): ProjectRepoRecord | undefined {
    return this.prepare('SELECT * FROM project_repos WHERE id = ?').get(id) as ProjectRepoRecord | undefined
  }

  addProjectRepo(projectId: string, data: CreateProjectRepoData): ProjectRepoRecord | undefined {
    const name = data.name?.trim()
    if (!name) throw new Error('A repo needs a name.')
    const id = createId()
    const { next } = this.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM project_repos WHERE project_id = ?'
    ).get(projectId) as { next: number }
    this.prepare(`
      INSERT INTO project_repos (id, project_id, provider, org, name, default_branch, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, data.provider || 'github', data.org?.trim() ?? '', name, data.default_branch || null, next, new Date().toISOString())
    return this.getProjectRepo(id)
  }

  updateProjectRepo(id: string, data: UpdateProjectRepoData): ProjectRepoRecord | undefined {
    const setClauses: string[] = []
    const values: (string | null)[] = []
    if (data.name !== undefined) {
      const name = data.name.trim()
      if (!name) throw new Error('A repo needs a name.')
      setClauses.push('name = ?'); values.push(name)
    }
    if (data.provider !== undefined) { setClauses.push('provider = ?'); values.push(data.provider || 'github') }
    if (data.org !== undefined) { setClauses.push('org = ?'); values.push(data.org.trim()) }
    if (data.default_branch !== undefined) { setClauses.push('default_branch = ?'); values.push(data.default_branch || null) }
    if (setClauses.length > 0) {
      values.push(id)
      this.db.prepare(`UPDATE project_repos SET ${setClauses.join(', ')} WHERE id = ?`).run(...values)
    }
    return this.getProjectRepo(id)
  }

  removeProjectRepo(id: string): boolean {
    return this.prepare('DELETE FROM project_repos WHERE id = ?').run(id).changes > 0
  }

  reorderProjectRepos(projectId: string, orderedIds: string[]): void {
    this.reorderRows('project_repos', projectId, orderedIds)
  }

  getProjectResources(projectId: string): ProjectResourceRecord[] {
    if (!this.ensureDbOpen()) return []
    return this.prepare(
      'SELECT * FROM project_resources WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC'
    ).all(projectId) as ProjectResourceRecord[]
  }

  getProjectResource(id: string): ProjectResourceRecord | undefined {
    return this.prepare('SELECT * FROM project_resources WHERE id = ?').get(id) as ProjectResourceRecord | undefined
  }

  addProjectResource(projectId: string, data: CreateProjectResourceData): ProjectResourceRecord | undefined {
    const label = data.label?.trim()
    if (!label) throw new Error('A resource needs a label.')
    const id = createId()
    const { next } = this.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM project_resources WHERE project_id = ?'
    ).get(projectId) as { next: number }
    this.prepare(`
      INSERT INTO project_resources (id, project_id, label, url, notes, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, label, data.url?.trim() || null, data.notes ?? '', next, new Date().toISOString())
    return this.getProjectResource(id)
  }

  updateProjectResource(id: string, data: UpdateProjectResourceData): ProjectResourceRecord | undefined {
    const setClauses: string[] = []
    const values: (string | null)[] = []
    if (data.label !== undefined) {
      const label = data.label.trim()
      if (!label) throw new Error('A resource needs a label.')
      setClauses.push('label = ?'); values.push(label)
    }
    if (data.url !== undefined) { setClauses.push('url = ?'); values.push(data.url?.trim() || null) }
    if (data.notes !== undefined) { setClauses.push('notes = ?'); values.push(data.notes) }
    if (setClauses.length > 0) {
      values.push(id)
      this.db.prepare(`UPDATE project_resources SET ${setClauses.join(', ')} WHERE id = ?`).run(...values)
    }
    return this.getProjectResource(id)
  }

  removeProjectResource(id: string): boolean {
    return this.prepare('DELETE FROM project_resources WHERE id = ?').run(id).changes > 0
  }

  reorderProjectResources(projectId: string, orderedIds: string[]): void {
    this.reorderRows('project_resources', projectId, orderedIds)
  }

  /** Index in `orderedIds` becomes sort_order; ids outside `projectId` are ignored. */
  private reorderRows(table: 'projects' | 'project_repos' | 'project_resources', projectId: string | null, orderedIds: string[]): void {
    if (!this.ensureDbOpen()) return
    const stmt = projectId === null
      ? this.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`)
      : this.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ? AND project_id = ?`)
    this.db.transaction(() => {
      orderedIds.forEach((id, index) => {
        if (projectId === null) stmt.run(index, id)
        else stmt.run(index, id, projectId)
      })
    })()
  }

  // ── Task Source CRUD ─────────────────────────────────────────

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

  // ── Skill CRUD ────────────────────────────────────────────
  //
  // Scope (#74): skills.project_id is null for a global skill and a project
  // id for a project skill. Reads take a SkillListFilter; the access policy
  // (who may see, create, change or move a skill) lives with the callers —
  // skill-routes.ts for sessions, commander/skill-tools.ts for the Commander.

  getSkills(filter?: SkillListFilter): SkillRecord[] {
    const clauses = ['is_deleted = 0']
    const params: string[] = []
    if (filter?.visibleToProject !== undefined) {
      clauses.push('(project_id IS NULL OR project_id = ?)')
      params.push(filter.visibleToProject)
    }
    if (filter?.scope !== undefined) {
      if (filter.scope === null) clauses.push('project_id IS NULL')
      else { clauses.push('project_id = ?'); params.push(filter.scope) }
    }
    const rows = this.prepare(
      `SELECT * FROM skills WHERE ${clauses.join(' AND ')} ORDER BY name ASC`
    ).all(...params) as SkillRow[]
    return rows.map(deserializeSkill)
  }

  getSkill(id: string): SkillRecord | undefined {
    const row = this.prepare(
      'SELECT * FROM skills WHERE id = ? AND is_deleted = 0'
    ).get(id) as SkillRow | undefined
    return row ? deserializeSkill(row) : undefined
  }

  /** The named skills; with `visibleToProject`, only the global ones and that project's own. */
  getSkillsByIds(ids: string[], visibleToProject?: string): SkillRecord[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const scope = visibleToProject !== undefined ? ' AND (project_id IS NULL OR project_id = ?)' : ''
    const rows = this.db.prepare(
      `SELECT * FROM skills WHERE id IN (${placeholders}) AND is_deleted = 0${scope} ORDER BY name ASC`
    ).all(...ids, ...(visibleToProject !== undefined ? [visibleToProject] : [])) as SkillRow[]
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
    const projectId = data.project_id || null
    this.prepare(`
      INSERT INTO skills (id, name, description, content, version, confidence, uses, last_used, tags, preferred_model, project_id, is_deleted, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, data.name, data.description, data.content, confidence, uses, lastUsed, tags, preferredModel, projectId, now, now)
    return this.getSkill(id)
  }

  /**
   * Field updates. Throws SkillVersionConflictError when `expected_version`
   * is given and a content change would overwrite a newer version.
   */
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
    if (isContentChange && data.expected_version !== undefined && data.expected_version !== existing.version) {
      throw new SkillVersionConflictError(id, existing.version, data.expected_version)
    }
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

    // The version guard is re-checked in the statement itself, so two writers
    // that both read the same version cannot both get through.
    const guard = isContentChange && data.expected_version !== undefined ? ' AND version = ?' : ''
    if (guard) values.push(data.expected_version as number)
    const changed = this.db.prepare(
      `UPDATE skills SET ${setClauses.join(', ')} WHERE id = ?${guard}`
    ).run(...values).changes
    if (guard && changed === 0) {
      const current = this.getSkill(id)
      throw new SkillVersionConflictError(id, current?.version ?? existing.version, data.expected_version as number)
    }

    return this.getSkill(id)
  }

  /**
   * Moves a skill to a project (an id) or promotes it to global (null). The
   * explicit scope change of #74: not part of updateSkill, so a plain field
   * update can never change who sees a skill. Bumps the version.
   */
  setSkillProject(id: string, projectId: string | null): SkillRecord | undefined {
    const existing = this.getSkill(id)
    if (!existing) return undefined
    const next = projectId || null
    if (existing.project_id === next) return existing
    this.prepare(
      'UPDATE skills SET project_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND is_deleted = 0'
    ).run(next, new Date().toISOString(), id)
    return this.getSkill(id)
  }

  /** Tasks (any project, any status) whose skill_ids name the skill; for scope-move validation. */
  getTasksUsingSkill(skillId: string): Array<{ id: string; title: string; project_id: string }> {
    const rows = this.prepare(
      'SELECT id, title, project_id, skill_ids FROM tasks WHERE skill_ids LIKE ?'
    ).all(`%${skillId}%`) as Array<{ id: string; title: string; project_id: string | null; skill_ids: string | null }>
    return rows
      .filter((row) => {
        try {
          const ids = JSON.parse(row.skill_ids ?? '[]') as unknown
          return Array.isArray(ids) && ids.includes(skillId)
        } catch {
          return false
        }
      })
      .map((row) => ({ id: row.id, title: row.title, project_id: row.project_id ?? DEFAULT_PROJECT_ID }))
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
