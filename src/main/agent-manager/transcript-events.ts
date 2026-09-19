import { Notification } from 'electron'
import type { BrowserWindow } from 'electron'
import type { DatabaseManager } from '../database'
import { MessageRole, type SessionMessage } from '../adapters/coding-agent-adapter'
import { assistantTextKey } from './output-dedup'
import { SessionStatus, TaskStatus } from '../../shared/constants'
import { inspectTaskArtifact } from '../artifacts'
import { ArtifactType, pullRequestUrlFromTool, type Artifact } from '../../shared/artifacts'

type TranscriptPart = ReturnType<DatabaseManager['getTranscriptParts']>[number]
type TranscriptUpsert = Parameters<DatabaseManager['upsertTranscriptParts']>[1][number]

interface OutputEventPart {
  id?: string
  role?: string
  content?: string
  partType?: string
  tool?: unknown
  questions?: unknown
  todos?: unknown
  taskProgress?: unknown
  receivedAt?: number
}

/** One transcript part of an `agent:output-batch` event (persisted, not broadcast). */
export interface OutputMessage {
  id: string
  role: string
  content: string
  partType?: string
  tool?: unknown
  update?: boolean
  taskProgress?: unknown
  receivedAt?: number
}

/** Part types absorbed by clients (never rendered as messages), so never persisted. */
const EPHEMERAL_PART_TYPES = new Set(['step-start', 'step-finish', 'system-status'])

/** Projection rows for a session's persisted history (one-time backfill seed). */
export function transcriptPartsFromMessages(messages: SessionMessage[]): TranscriptUpsert[] {
  const parts: TranscriptUpsert[] = []
  for (const message of messages) {
    const role = message.role === MessageRole.USER ? 'user'
      : message.role === MessageRole.SYSTEM ? 'system' : 'assistant'
    for (const part of message.parts) {
      if (!part.id) continue
      const partType = String(part.type)
      if (EPHEMERAL_PART_TYPES.has(partType)) continue
      const content = part.content || part.text || ''
      if (!content && !part.tool && !part.taskProgress) continue
      parts.push({
        id: part.id,
        role,
        content,
        partType,
        tool: part.tool,
        payload: part.taskProgress ? { taskProgress: part.taskProgress } : undefined,
        receivedAt: part.receivedAt
      })
    }
  }
  return parts
}

/**
 * Non-user parts of the full message list that the live stream never
 * delivered, recording them in the session's dedup state as it goes.
 *
 * Dedup is by CONTENT as well as by part id. Some adapters (codex app-server)
 * give a message's live streaming delta a DIFFERENT part id (e.g.
 * `agent-msg_<hash>`) than its finalized thread item (`agent-item-N`), so an
 * id-only check would re-emit every finalized item on each idle transition.
 * Parts whose text was already emitted (reconciled codex text, #427) or
 * persisted (id-scheme mismatch) are skipped, which keeps this safety-net
 * re-read truly additive.
 */
export function collectMissedParts(
  messages: SessionMessage[],
  state: { seenPartIds: Set<string>; partContentLengths: Map<string, string>; assistantTextKeys: Set<string> },
  isPersisted: (content: string) => boolean
): OutputMessage[] {
  const missed: OutputMessage[] = []
  for (const message of messages) {
    if (message.role === MessageRole.USER) continue
    for (const part of message.parts) {
      const partId = part.id
      if (!partId || state.seenPartIds.has(partId)) continue
      const partType = String(part.type)
      if (EPHEMERAL_PART_TYPES.has(partType)) continue
      const content = part.content || part.text || ''
      const key = assistantTextKey(message.role, partType, content, part.tool, part.taskProgress)
      state.seenPartIds.add(partId)
      if ((key && state.assistantTextKeys.has(key)) || (content && isPersisted(content))) continue

      // The actual text, NOT its length: partContentLengths accumulates
      // streamed chunks, and a length string would be prepended to the next one.
      if (content) state.partContentLengths.set(partId, content)
      if (key) state.assistantTextKeys.add(key)
      missed.push({
        id: partId,
        role: message.role,
        content,
        partType,
        tool: part.tool,
        taskProgress: part.taskProgress,
        receivedAt: part.receivedAt
      })
    }
  }
  return missed
}

export interface DebugTranscriptMessage {
  role: string
  parts: Array<{ type: string; content?: string; tool?: { name: string; status?: string; input?: string; output?: string; error?: string } }>
}

const MAX_DEBUG_FIELD = 3000

function truncateField(val: unknown): string | undefined {
  if (val == null) return undefined
  const s = typeof val === 'string' ? val : JSON.stringify(val)
  return s.length > MAX_DEBUG_FIELD ? s.slice(0, MAX_DEBUG_FIELD) + `… (${s.length - MAX_DEBUG_FIELD} more)` : s
}

/** Last 100 messages with every part (tool input/output, thinking, errors), fields truncated. */
export function debugTranscript(messages: SessionMessage[]): DebugTranscriptMessage[] {
  return messages
    .filter(m => m.parts && m.parts.length > 0)
    .slice(-100)
    .map(m => ({
      role: m.role,
      parts: m.parts.map(p => ({
        type: p.type,
        content: truncateField(p.content || p.text),
        tool: p.tool ? {
          name: p.tool.name,
          status: p.tool.status,
          input: truncateField(p.tool.input),
          output: truncateField(p.tool.output),
          error: p.tool.error
        } : undefined
      }))
    }))
}

export function textTranscript(messages: SessionMessage[]): Array<{ role: string; text: string }> {
  return messages
    .filter(m => m.parts && m.parts.length > 0)
    .map(m => ({
      role: m.role,
      text: m.parts
        .filter(p => p.type === 'text')
        .map(p => p.content || '')
        .join('\n')
    }))
    .filter(m => m.text.length > 0)
}

/** Durable transcript parts carried by an `agent:output` / `agent:output-batch` event. */
export function transcriptPartsFromEvent(channel: string, data: unknown): { taskId: string; parts: TranscriptUpsert[] } | null {
  if (!data || typeof data !== 'object') return null
  const event = data as { taskId?: string; messages?: OutputEventPart[]; data?: OutputEventPart }
  if (!event.taskId) return null

  const rawParts = channel === 'agent:output-batch'
    ? (event.messages || [])
    : (event.data ? [event.data] : [])

  const parts = rawParts
    .filter((p) => p && p.id)
    .filter((p) => !p.partType || !EPHEMERAL_PART_TYPES.has(p.partType))
    .filter((p) => (p.content && p.content.length > 0) || p.tool || p.questions || p.todos || p.taskProgress)
    .map((p) => ({
      id: p.id as string,
      role: p.role,
      content: p.content,
      partType: p.partType,
      tool: p.tool,
      payload: (p.questions || p.todos || p.taskProgress)
        ? { questions: p.questions, todos: p.todos, taskProgress: p.taskProgress }
        : undefined,
      receivedAt: p.receivedAt
    }))
  return { taskId: event.taskId, parts }
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function findPath(record: Record<string, unknown> | null): string | undefined {
  if (!record) return undefined
  for (const key of ['file_path', 'path', 'filename', 'notebook_path']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function screenshotPath(part: TranscriptPart): string | undefined {
  if (part.partType !== 'tool' || !part.tool || typeof part.tool !== 'object') return undefined
  const tool = part.tool as { name?: string; status?: string; input?: unknown; output?: unknown }
  const name = (tool.name || '').toLowerCase()
  const status = (tool.status || '').toLowerCase()
  const completed = ['success', 'succeeded', 'complete', 'completed'].includes(status)
  if (!completed || !name.includes('screenshot')) return undefined
  return findPath(parseRecord(tool.input)) || findPath(parseRecord(tool.output))
}

/**
 * Broadcasts automatically discovered PR / screenshot artifacts. Durable file
 * workpieces are emitted directly by the task-management artifact tools;
 * generic repository Write/Edit calls must never create artifact identity.
 */
export function emitArtifactUpdatesFromParts(
  db: DatabaseManager,
  taskId: string,
  parts: TranscriptPart[],
  send: (artifact: Artifact) => void
): void {
  const prUrls = new Set<string>()
  for (const part of parts) {
    const url = pullRequestUrlFromTool(part.tool)
    if (url) prUrls.add(url)
  }
  for (const url of prUrls) {
    const number = url.match(/\/(\d+)$/)?.[1]
    send({
      id: `${taskId}:${ArtifactType.PR}:${encodeURIComponent(url)}`,
      taskId,
      type: ArtifactType.PR,
      title: number ? `Pull request #${number}` : 'Pull request',
      url,
      updatedAt: Date.now(),
      reloadTrigger: 0
    })
  }

  const screenshotPaths = new Set<string>()
  for (const part of parts) {
    const path = screenshotPath(part)
    if (path) screenshotPaths.add(path)
  }
  if (screenshotPaths.size === 0) return

  const workspaceDir = db.getWorkspaceDir(taskId)
  void Promise.all([...screenshotPaths].map((path) => inspectTaskArtifact(workspaceDir, path))).then((entries) => {
    for (const discovered of entries) {
      if (!discovered) continue
      send({
        id: `${taskId}:${discovered.type}:${encodeURIComponent(discovered.path)}`,
        taskId,
        type: discovered.type,
        title: discovered.path.split('/').pop() || discovered.title,
        path: discovered.path,
        updatedAt: discovered.updatedAt,
        reloadTrigger: Math.floor(discovered.updatedAt)
      })
    }
  }).catch((error) => {
    console.warn(`[AgentManager] Failed to refresh artifacts for task ${taskId}:`, error)
  })
}

/**
 * OS notification for a working -> idle / waiting_approval transition while the
 * window is not focused. All cheap checks run before the synchronous DB read.
 */
export function notifyStatusTransition(
  db: DatabaseManager,
  getMainWindow: () => BrowserWindow | null,
  prevStatus: string | undefined,
  status: string,
  taskId: string | undefined
): void {
  const mainWindow = getMainWindow()
  const isWindowInactive = !mainWindow || mainWindow.isDestroyed() || !mainWindow.isFocused()
  const isNotifiableTransition = prevStatus === SessionStatus.WORKING && (status === SessionStatus.IDLE || status === SessionStatus.WAITING_APPROVAL)
  if (!isNotifiableTransition || !isWindowInactive) return

  try {
    if (!Notification.isSupported()) return
    const task = taskId ? db.getTask(taskId) : undefined
    const taskTitle = task?.title

    // Subtasks of an already-completed parent are noise.
    if (task?.parent_task_id && db.getTask(task.parent_task_id)?.status === TaskStatus.Completed) return

    const needsApproval = status === SessionStatus.WAITING_APPROVAL
    const title = needsApproval ? 'Agent needs approval' : 'Agent finished'
    const body = needsApproval
      ? (taskTitle ? `"${taskTitle}" is waiting for your approval` : 'An agent is waiting for your approval')
      : (taskTitle ? `"${taskTitle}" is ready for review` : 'A task is ready for review')

    const notification = new Notification({ title, body })
    // Resolve the window on click: on macOS it may have been recreated since.
    notification.on('click', () => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.show()
        win.focus()
      }
    })
    notification.show()
  } catch (err) {
    console.error('[AgentManager] Failed to show OS notification:', err)
  }
}
