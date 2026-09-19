import type Database from 'better-sqlite3'
import { createId } from '@paralleldrive/cuid2'
import { COMMANDER_MESSAGE_ROLES, type ChatToolCall } from '../../shared/commander'
import { DEFAULT_PROJECT_ID } from '../../shared/projects'
import { TaskStatus } from '../../shared/constants'
import { TASK_ROLE_COMMANDER } from '../../shared/task-roles'
import type {
  CommanderMessage,
  CommanderMessageRole,
  CommanderMessageRow,
  CommanderSession,
  CommanderSessionRow
} from '../database/commander-types'

/**
 * Persistence for Commander chat sessions (docs/commander.md).
 *
 * A session is a `commander_sessions` row (title, archive, unread) plus a
 * hidden `tasks` row with the same id and `role = 'commander'`, which hosts
 * the agent conversation exactly as a Captain row does: its transcript is
 * the task's transcript. `commander_messages` keeps what is not part of that
 * conversation: Captain reports (unread until read, relayed to the agent),
 * the `ask_captain` delegations reports are routed by, and the history of
 * sessions written before the Commander ran on agent sessions.
 *
 * Backed by the app's SQLite connection (DatabaseManager.db). Timestamps are
 * epoch ms from a clock that never repeats or goes backwards within a store, so
 * "newer than last_read_at" and message order are exact even inside one ms.
 */

export interface AppendCommanderMessageInput {
  role: CommanderMessageRole
  content: string
  toolCalls?: ChatToolCall[] | null
  toolCallId?: string | null
  toolName?: string | null
  isError?: boolean
  projectId?: string | null
  correlationId?: string | null
}

export interface CommanderStoreOptions {
  now?: () => number
}

const MAX_TITLE_CHARS = 120

/** Unread = reports newer than the last time the session was open. */
const SESSION_SELECT = `
  SELECT s.*, (
    SELECT COUNT(*) FROM commander_messages m
    WHERE m.session_id = s.id AND m.role = 'report' AND m.created_at > COALESCE(s.last_read_at, 0)
  ) AS unread_count
  FROM commander_sessions s`

function toSession(row: CommanderSessionRow): CommanderSession {
  return {
    id: row.id,
    title: row.title ?? '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived: row.archived === 1,
    last_read_at: row.last_read_at ?? null,
    relayed_at: row.relayed_at ?? null,
    unread_count: row.unread_count ?? 0
  }
}

function parseToolCalls(raw: string | null): ChatToolCall[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as ChatToolCall[]) : null
  } catch {
    return null
  }
}

function toMessage(row: CommanderMessageRow): CommanderMessage {
  return {
    id: row.id,
    session_id: row.session_id,
    role: row.role as CommanderMessageRole,
    content: row.content,
    tool_calls: parseToolCalls(row.tool_calls),
    tool_call_id: row.tool_call_id ?? null,
    tool_name: row.tool_name ?? null,
    is_error: row.is_error === 1,
    project_id: row.project_id ?? null,
    correlation_id: row.correlation_id ?? null,
    created_at: row.created_at
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS)
}

export class CommanderStore {
  private lastTs = 0
  private readonly clock: () => number

  constructor(private readonly source: { db: Database.Database }, options: CommanderStoreOptions = {}) {
    this.clock = options.now ?? Date.now
  }

  private get db(): Database.Database {
    return this.source.db
  }

  /** Strictly increasing epoch ms. */
  now(): number {
    const ts = Math.max(this.clock(), this.lastTs + 1)
    this.lastTs = ts
    return ts
  }

  // ── Sessions ──────────────────────────────────────────────

  createSession(title = ''): CommanderSession {
    const id = createId()
    const ts = this.now()
    this.db
      .prepare('INSERT INTO commander_sessions (id, title, created_at, updated_at, archived, last_read_at, relayed_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
      .run(id, normalizeTitle(title), ts, ts, ts, ts)
    this.ensureTask(id)
    return this.getSession(id)!
  }

  /**
   * The hidden task row that hosts the session's agent conversation, created
   * on first use (sessions written by the old chat runtime have none).
   * Returns whether it was created just now. Throws for an unknown session.
   */
  ensureTask(sessionId: string): { created: boolean } {
    const existing = this.db.prepare('SELECT role FROM tasks WHERE id = ?').get(sessionId) as { role: string } | undefined
    if (existing) {
      if (existing.role !== TASK_ROLE_COMMANDER) throw new Error(`Task ${sessionId} is not a Commander session`)
      return { created: false }
    }
    if (!this.getSession(sessionId)) throw new Error(`Commander session not found: ${sessionId}`)
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO tasks (id, title, description, type, priority, status, assignee, labels, source, role, project_id, created_at, updated_at)
      VALUES (?, 'Commander', 'A Commander chat session. Not a task: never listed, never scheduled.', 'general', 'medium', ?, '', '[]', 'local', ?, ?, ?, ?)
    `).run(sessionId, TaskStatus.NotStarted, TASK_ROLE_COMMANDER, DEFAULT_PROJECT_ID, now, now)
    return { created: true }
  }

  /** Bumps the session to the top of the list. */
  touch(id: string): CommanderSession | null {
    this.db.prepare('UPDATE commander_sessions SET updated_at = ? WHERE id = ?').run(this.now(), id)
    return this.getSession(id)
  }

  getSession(id: string): CommanderSession | null {
    const row = this.db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as CommanderSessionRow | undefined
    return row ? toSession(row) : null
  }

  /** Most recently active first. `search` matches the title, a report, or the conversation text. */
  listSessions(options: { search?: string; includeArchived?: boolean } = {}): CommanderSession[] {
    const where: string[] = []
    const params: unknown[] = []
    if (!options.includeArchived) where.push('s.archived = 0')
    const search = options.search?.trim()
    if (search) {
      const pattern = `%${escapeLike(search)}%`
      where.push(`(s.title LIKE ? ESCAPE '\\' OR EXISTS (
        SELECT 1 FROM commander_messages m
        WHERE m.session_id = s.id AND m.role IN ('user', 'assistant', 'report') AND m.content LIKE ? ESCAPE '\\'
      ) OR EXISTS (
        SELECT 1 FROM transcript_parts t
        WHERE t.task_id = s.id AND t.role IN ('user', 'assistant') AND t.content LIKE ? ESCAPE '\\'
      ))`)
      params.push(pattern, pattern, pattern)
    }
    const sql = `${SESSION_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY s.updated_at DESC, s.rowid DESC`
    return (this.db.prepare(sql).all(...params) as CommanderSessionRow[]).map(toSession)
  }

  renameSession(id: string, title: string): CommanderSession | null {
    this.db.prepare('UPDATE commander_sessions SET title = ? WHERE id = ?').run(normalizeTitle(title), id)
    return this.getSession(id)
  }

  setArchived(id: string, archived: boolean): CommanderSession | null {
    this.db.prepare('UPDATE commander_sessions SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id)
    return this.getSession(id)
  }

  deleteSession(id: string): boolean {
    const remove = this.db.transaction(() => {
      this.db.prepare('DELETE FROM tasks WHERE id = ? AND role = ?').run(id, TASK_ROLE_COMMANDER)
      return this.db.prepare('DELETE FROM commander_sessions WHERE id = ?').run(id).changes > 0
    })
    return remove()
  }

  /** The user has seen everything up to now: clears the unread count. */
  markRead(id: string): CommanderSession | null {
    this.db.prepare('UPDATE commander_sessions SET last_read_at = ? WHERE id = ?').run(this.now(), id)
    return this.getSession(id)
  }

  // ── Messages ──────────────────────────────────────────────

  appendMessage(sessionId: string, input: AppendCommanderMessageInput): CommanderMessage {
    if (!COMMANDER_MESSAGE_ROLES.includes(input.role)) throw new Error(`Unknown Commander message role: ${String(input.role)}`)
    const id = createId()
    const ts = this.now()
    const insert = this.db.transaction(() => {
      const changes = this.db.prepare('UPDATE commander_sessions SET updated_at = ? WHERE id = ?').run(ts, sessionId).changes
      if (changes === 0) throw new Error(`Commander session not found: ${sessionId}`)
      this.db
        .prepare(`INSERT INTO commander_messages
          (id, session_id, role, content, tool_calls, tool_call_id, tool_name, is_error, project_id, correlation_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          id,
          sessionId,
          input.role,
          input.content,
          input.toolCalls && input.toolCalls.length > 0 ? JSON.stringify(input.toolCalls) : null,
          input.toolCallId ?? null,
          input.toolName ?? null,
          input.isError ? 1 : 0,
          input.projectId ?? null,
          input.correlationId ?? null,
          ts
        )
    })
    insert()
    return this.getMessage(id)!
  }

  getMessage(id: string): CommanderMessage | null {
    const row = this.db.prepare('SELECT * FROM commander_messages WHERE id = ?').get(id) as CommanderMessageRow | undefined
    return row ? toMessage(row) : null
  }

  /** Reports stored after the session's agent was last handed its reports, oldest first. */
  reportsToRelay(sessionId: string): CommanderMessage[] {
    const rows = this.db
      .prepare(`SELECT m.* FROM commander_messages m JOIN commander_sessions s ON s.id = m.session_id
        WHERE m.session_id = ? AND m.role = 'report' AND m.created_at > COALESCE(s.relayed_at, 0)
        ORDER BY m.created_at ASC, m.rowid ASC`)
      .all(sessionId) as CommanderMessageRow[]
    return rows.map(toMessage)
  }

  /** Every report up to `upTo` has been handed to the agent. */
  markRelayed(sessionId: string, upTo: number): void {
    this.db.prepare('UPDATE commander_sessions SET relayed_at = MAX(COALESCE(relayed_at, 0), ?) WHERE id = ?').run(upTo, sessionId)
  }

  /** Oldest first. */
  listMessages(sessionId: string): CommanderMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM commander_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(sessionId) as CommanderMessageRow[]
    return rows.map(toMessage)
  }

  unreadCount(sessionId: string): number {
    return this.getSession(sessionId)?.unread_count ?? 0
  }

  // ── Report routing (#62) ──────────────────────────────────

  /**
   * The delegation that carries a correlation id: the `ask_captain` tool
   * row the service tagged when the tool returned. Its session is where the
   * report quoting that id belongs. Null for an unknown id.
   */
  findDelegation(correlationId: string): { sessionId: string; projectId: string | null } | null {
    const row = this.db
      .prepare(`SELECT session_id, project_id FROM commander_messages
        WHERE role = 'tool' AND correlation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(correlationId) as { session_id: string; project_id: string | null } | undefined
    return row ? { sessionId: row.session_id, projectId: row.project_id ?? null } : null
  }
}
