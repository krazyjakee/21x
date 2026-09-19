import type Database from 'better-sqlite3'
import { createId } from '@paralleldrive/cuid2'
import type { ChatToolCall } from '../../shared/chat'
import { isChatImageMimeType, type ChatImageInput, type ChatImageRef } from '../../shared/chat-images'
import { COMMANDER_MESSAGE_ROLES } from '../../shared/commander'
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
  /** User messages only: images already validated by the caller (#144). */
  images?: ChatImageInput[]
}

interface CommanderImageRow {
  id: string
  message_id: string
  name: string
  mime_type: string
  size: number
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

function toImageRef(row: CommanderImageRow): ChatImageRef | null {
  if (!isChatImageMimeType(row.mime_type)) return null
  return { id: row.id, name: row.name, mime_type: row.mime_type, size: row.size }
}

function toMessage(row: CommanderMessageRow, images?: ChatImageRef[]): CommanderMessage {
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
    created_at: row.created_at,
    ...(images && images.length > 0 ? { images } : {})
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
      .prepare('INSERT INTO commander_sessions (id, title, created_at, updated_at, archived, last_read_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(id, normalizeTitle(title), ts, ts, ts)
    return this.getSession(id)!
  }

  getSession(id: string): CommanderSession | null {
    const row = this.db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as CommanderSessionRow | undefined
    return row ? toSession(row) : null
  }

  /** Most recently active first. `search` matches the title or any message text. */
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
      ))`)
      params.push(pattern, pattern)
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
    return this.db.prepare('DELETE FROM commander_sessions WHERE id = ?').run(id).changes > 0
  }

  /** The user has seen everything up to now: clears the unread count. */
  markRead(id: string): CommanderSession | null {
    this.db.prepare('UPDATE commander_sessions SET last_read_at = ? WHERE id = ?').run(this.now(), id)
    return this.getSession(id)
  }

  // ── Messages ──────────────────────────────────────────────

  /** beforeCommit prepares a turn against the inserted message; a failure rolls back its images too. */
  appendMessage(sessionId: string, input: AppendCommanderMessageInput, beforeCommit?: (message: CommanderMessage) => void): CommanderMessage {
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
      const insertImage = this.db.prepare(
        'INSERT INTO commander_images (id, message_id, position, name, mime_type, size, data) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      ;(input.images ?? []).forEach((image, position) => {
        const bytes = Buffer.from(image.data, 'base64')
        insertImage.run(createId(), id, position, image.name, image.mimeType, bytes.length, bytes)
      })
      const message = this.getMessage(id)!
      beforeCommit?.(message)
      return message
    })
    return insert()
  }

  getMessage(id: string): CommanderMessage | null {
    const row = this.db.prepare('SELECT * FROM commander_messages WHERE id = ?').get(id) as CommanderMessageRow | undefined
    return row ? toMessage(row, this.imageRefs('message_id = ?', id).get(id)) : null
  }

  /** Image metadata by message id, in attachment order. */
  private imageRefs(where: string, param: string): Map<string, ChatImageRef[]> {
    const rows = this.db
      .prepare(`SELECT id, message_id, name, mime_type, size FROM commander_images WHERE ${where} ORDER BY message_id, position`)
      .all(param) as CommanderImageRow[]
    const byMessage = new Map<string, ChatImageRef[]>()
    for (const row of rows) {
      const ref = toImageRef(row)
      if (!ref) continue
      const list = byMessage.get(row.message_id)
      if (list) list.push(ref)
      else byMessage.set(row.message_id, [ref])
    }
    return byMessage
  }

  /** One stored image with its bytes (base64), or null. */
  getImage(id: string): (ChatImageRef & { data: string }) | null {
    const row = this.db
      .prepare('SELECT id, message_id, name, mime_type, size, data FROM commander_images WHERE id = ?')
      .get(id) as (CommanderImageRow & { data: Buffer }) | undefined
    const ref = row ? toImageRef(row) : null
    return row && ref ? { ...ref, data: Buffer.from(row.data).toString('base64') } : null
  }

  /** A message's images with their bytes, ready for a provider. */
  getMessageImages(messageId: string): ChatImageInput[] {
    const rows = this.db
      .prepare('SELECT name, mime_type, data FROM commander_images WHERE message_id = ? ORDER BY position')
      .all(messageId) as Array<{ name: string; mime_type: string; data: Buffer }>
    return rows.flatMap((row) => isChatImageMimeType(row.mime_type)
      ? [{ name: row.name, mimeType: row.mime_type, data: Buffer.from(row.data).toString('base64') }]
      : [])
  }

  /**
   * Moves an already-durable message to the end of its session. Reports that
   * arrive during a model turn are stored immediately, then moved behind that
   * turn's assistant reply so the relay turn sees the report as the newest
   * input rather than splicing it into the turn that was already in flight.
   */
  moveMessageToEnd(id: string): CommanderMessage | null {
    const message = this.getMessage(id)
    if (!message) return null
    const ts = this.now()
    const move = this.db.transaction(() => {
      this.db.prepare('UPDATE commander_messages SET created_at = ? WHERE id = ?').run(ts, id)
      this.db.prepare('UPDATE commander_sessions SET updated_at = ? WHERE id = ?').run(ts, message.session_id)
    })
    move()
    return this.getMessage(id)
  }

  /** Oldest first. */
  listMessages(sessionId: string): CommanderMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM commander_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(sessionId) as CommanderMessageRow[]
    const images = this.imageRefs('message_id IN (SELECT id FROM commander_messages WHERE session_id = ?)', sessionId)
    return rows.map((row) => toMessage(row, images.get(row.id)))
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
