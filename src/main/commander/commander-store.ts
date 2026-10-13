import { captainTerminology } from '../../shared/captain-compat'
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
  /** Only authenticated human submission supplies attribution; other rows stay null. */
  inputMode?: 'voice' | 'typed' | null
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
export const COMMANDER_REPORT_INBOX_SETTING = 'commander_report_inbox_session_id'

/** Unread = reports newer than the last time the session was open. */
const SESSION_SELECT = `
  SELECT s.*, s.id = COALESCE((SELECT value FROM settings WHERE key = '${COMMANDER_REPORT_INBOX_SETTING}'), '') AS is_report_inbox, (
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
    unread_count: row.unread_count ?? 0,
    ...(row.is_report_inbox === 1 ? { is_report_inbox: true } : {})
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
    // Compatibility is a read projection over report, summary and assistant
    // prose: stored bytes, routing IDs and user/tool messages stay untouched.
    content: row.role === 'report' || row.role === 'summary' || row.role === 'assistant'
      ? captainTerminology(row.content)
      : row.content,
    tool_calls: parseToolCalls(row.tool_calls),
    tool_call_id: row.tool_call_id ?? null,
    tool_name: row.tool_name ?? null,
    is_error: row.is_error === 1,
    project_id: row.project_id ?? null,
    correlation_id: row.correlation_id ?? null,
    created_at: row.created_at,
    input_mode: row.role === 'user' && (row.input_mode === 'voice' || row.input_mode === 'typed') ? row.input_mode : null,
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

  /** Shared portable accounting stores use the same SQLite connection. */
  get database(): Database.Database {
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

  /** Activity reads only need identity, without counting historical reports. */
  hasSession(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM commander_sessions WHERE id = ?').get(id))
  }

  /** One durable quiet inbox; a rename or restart never changes its identity. */
  ensureReportInbox(): CommanderSession {
    return this.db.transaction(() => {
      const setting = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(COMMANDER_REPORT_INBOX_SETTING) as { value: string } | undefined
      let inbox = setting ? this.getSession(setting.value) : null
      if (!inbox) {
        // Adopt a pre-existing report-only inbox from earlier builds. A chat
        // the user started with the same title remains an ordinary chat.
        inbox = this.listSessions({ includeArchived: true }).find((session) => {
          if (session.title !== 'Project reports') return false
          const messages = this.listMessages(session.id)
          return messages.some((message) => message.role === 'report') && !messages.some((message) => message.role === 'user')
        }) ?? this.createSession('Project reports')
        this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run(COMMANDER_REPORT_INBOX_SETTING, inbox.id)
      }
      if (inbox.archived) this.setArchived(inbox.id, false)
      return this.getSession(inbox.id)!
    })()
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

  /** Only CommanderService's authenticated human submission path calls this. */
  appendHumanMessage(sessionId: string, content: string, images?: ChatImageInput[], beforeCommit?: (message: CommanderMessage) => void, inputMode: 'typed' | 'voice' = 'typed'): CommanderMessage {
    return this.appendMessage(sessionId, { role: 'user', content, images, inputMode }, message => {
      beforeCommit?.(message)
    })
  }

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
          (id, session_id, role, content, tool_calls, tool_call_id, tool_name, is_error, project_id, correlation_id, created_at, input_mode)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
          ts,
          input.role === 'user' ? input.inputMode ?? null : null
        )
      this.insertImages(id, input.images)
      const message = this.getMessage(id)!
      beforeCommit?.(message)
      return message
    })
    return insert()
  }

  /** A runtime step has stable identity before any subsequent tool effect. */
  appendRuntimeStepOnce(sessionId: string, input: AppendCommanderMessageInput, turnId: string, stepIndex: number): { message: CommanderMessage; inserted: boolean } {
    if (!['assistant', 'tool'].includes(input.role) || !Number.isSafeInteger(stepIndex) || stepIndex < 1)
      throw new Error('Invalid managed Commander step')
    const id = `managed-step:${turnId}:${stepIndex}`
    const existing = this.getMessage(id)
    if (existing) {
      if (existing.session_id !== sessionId || existing.role !== input.role || existing.content !== input.content
        || existing.tool_call_id !== (input.toolCallId ?? null) || existing.tool_name !== (input.toolName ?? null)
        || existing.project_id !== (input.projectId ?? null) || existing.correlation_id !== (input.correlationId ?? null)
        || existing.is_error !== (input.isError === true) || JSON.stringify(existing.tool_calls) !== JSON.stringify(input.toolCalls?.length ? input.toolCalls : null))
        throw new Error('Managed step identity belongs to different content or owner')
      return { message: existing, inserted: false }
    }
    const timestamp = this.now()
    this.db.transaction(() => {
      if (!this.db.prepare('UPDATE commander_sessions SET updated_at = ? WHERE id = ?').run(timestamp, sessionId).changes)
        throw new Error(`Commander session not found: ${sessionId}`)
      this.db.prepare(`INSERT INTO commander_messages
        (id, session_id, role, content, tool_calls, tool_call_id, tool_name, is_error, project_id, correlation_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, sessionId, input.role, input.content, input.toolCalls?.length ? JSON.stringify(input.toolCalls) : null,
          input.toolCallId ?? null, input.toolName ?? null, input.isError ? 1 : 0, input.projectId ?? null, input.correlationId ?? null, timestamp)
    })()
    return { message: this.getMessage(id)!, inserted: true }
  }

  /** Bind a durable summary and its visible divider in the same conversation. */
  bindHandoff(input: { sessionId: string; handoffId: string; generationKey: string; summary: string; source: 'model' | 'fallback'; lastFoldedId: string | null }): { messages: CommanderMessage[]; inserted: boolean } {
    const ids = [`rollover-summary:${input.handoffId}`, `rollover-divider:${input.handoffId}`]
    const divider = JSON.stringify({ kind: 'rollover', title: 'Conversation continued in a new generation', summary: input.summary, source: input.source, generationKey: input.generationKey })
    let inserted = false
    this.db.transaction(() => {
      if (!this.hasSession(input.sessionId)) throw new Error('Commander session not found')
      const previous = this.getMessage(ids[0])
      if (previous && (previous.session_id !== input.sessionId || previous.content !== input.summary || previous.correlation_id !== input.lastFoldedId))
        throw new Error('Handoff summary belongs to different source content')
      const existingDivider = this.getMessage(ids[1])
      const handoff = this.db.prepare('SELECT next_generation_key FROM session_handoffs WHERE id = ?').get(input.handoffId) as { next_generation_key: string } | undefined
      if (handoff && handoff.next_generation_key !== input.generationKey) throw new Error('Handoff generation identity changed')
      if (previous && (!existingDivider || existingDivider.session_id !== input.sessionId || existingDivider.role !== 'assistant'
        || existingDivider.tool_name !== 'session_rollover' || existingDivider.content !== divider))
        throw new Error('Handoff divider belongs to different source content')
      if (!previous) {
        const write = this.db.prepare(`INSERT INTO commander_messages
          (id, session_id, role, content, tool_name, correlation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        write.run(ids[0], input.sessionId, 'summary', input.summary, null, input.lastFoldedId, this.now())
        write.run(ids[1], input.sessionId, 'assistant', divider, 'session_rollover', null, this.now())
        inserted = true
        this.db.prepare('UPDATE commander_sessions SET updated_at = ? WHERE id = ?').run(this.now(), input.sessionId)
        this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run(`sessions.commander_generation:${input.sessionId}`, input.generationKey)
      }
    })()
    return { messages: ids.map(id => this.getMessage(id)!), inserted }
  }

  /** Idempotent external report delivery and outbox acknowledgement. */
  appendMessageOnce(
    sessionId: string,
    input: AppendCommanderMessageInput,
    deliveryId: string
  ): { message: CommanderMessage; inserted: boolean } {
    if (!COMMANDER_MESSAGE_ROLES.includes(input.role)) throw new Error(`Unknown Commander message role: ${String(input.role)}`)
    const id = `delivery-${deliveryId}`
    const ts = this.now()
    let inserted = false
    this.db.transaction(() => {
      const session = this.db.prepare('SELECT 1 FROM commander_sessions WHERE id = ?').get(sessionId)
      if (!session) throw new Error(`Commander session not found: ${sessionId}`)
      inserted = this.db.prepare(`INSERT OR IGNORE INTO commander_messages
        (id, session_id, role, content, tool_calls, tool_call_id, tool_name, is_error, project_id, correlation_id, created_at, input_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
          ts,
          input.role === 'user' ? input.inputMode ?? null : null
        ).changes === 1
      if (inserted) {
        this.insertImages(id, input.images)
        this.db.prepare('UPDATE commander_sessions SET updated_at = ? WHERE id = ?').run(ts, sessionId)
      }
      this.db.prepare(`UPDATE delivery_outbox SET
        state = 'acknowledged', destination_id = ?, claim_owner = NULL,
        claim_expires_at = NULL, acknowledged_at = ?, updated_at = ?
        WHERE id = ? AND state NOT IN ('failed', 'timed_out', 'cancelled')`)
        .run(id, ts, ts, deliveryId)
      if (input.correlationId) {
        this.db.prepare(`UPDATE delivery_outbox SET
          state = 'acknowledged', acknowledged_at = ?, updated_at = ?
          WHERE kind = 'captain_request' AND correlation_id = ? AND project_id = ?
            AND source_session_id = ? AND state IN ('pending', 'claimed', 'accepted')`)
          .run(ts, ts, input.correlationId, input.projectId ?? null, sessionId)
      }
    })()
    const message = this.getMessage(id)
    if (!message) throw new Error(`Could not store Commander delivery ${deliveryId}`)
    return { message, inserted }
  }

  /** Called inside the message transaction, including idempotent deliveries. */
  private insertImages(messageId: string, images: ChatImageInput[] = []): void {
    const insert = this.db.prepare(
      'INSERT INTO commander_images (id, message_id, position, name, mime_type, size, data) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    images.forEach((image, position) => {
      const bytes = Buffer.from(image.data, 'base64')
      insert.run(createId(), messageId, position, image.name, image.mimeType, bytes.length, bytes)
    })
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
