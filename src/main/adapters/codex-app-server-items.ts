/**
 * Pure conversion of Codex app-server thread/turn/item events into transcript
 * parts, plus the identity helpers that keep part ids stable across reconciles.
 */

import { basename } from 'path'
import type { MessagePart } from './coding-agent-adapter'
import { MessagePartType, MessageRole } from './coding-agent-adapter'

const MAX_IPC_TOOL_INPUT_CHARS = 20_000
const MAX_IPC_TOOL_OUTPUT_CHARS = 100_000
const MIN_THREAD_LEVEL_ASSISTANT_DEDUPE_CHARS = 40

export interface RunningTool {
  partId: string
  toolName: string
  startTime?: number
  lastActivityTime?: number
  lastActivityMonotonicTime?: number
  input?: Record<string, unknown>
}

/** Per-session state the conversion reads and updates. */
export interface CodexItemState {
  streamedTextByItemId: Map<string, string>
  assistantTextKeysByTurn: Map<string, Set<string>>
  runningTools: Map<string, RunningTool>
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function extractThreadId(value: unknown): string | null {
  if (!isObject(value)) return null
  const direct = asString(value.threadId) || asString(value.thread_id) || asString(value.id)
  if (direct) return direct
  if (isObject(value.thread)) {
    return asString(value.thread.id) || asString(value.thread.threadId) || asString(value.thread.thread_id) || null
  }
  return null
}

/**
 * Deterministic 32-bit string hash (djb2). Used to build stable dedup keys for
 * thread items that carry no id — never use Date.now()/random here, or the same
 * item would produce a new key on every reconcile pass and be re-emitted.
 */
function hashString(value: string): string {
  let hash = 5381
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

/**
 * Derives a STABLE identity for a Codex thread item. Many item types
 * (function_call_output, custom_tool_call_output, tool_search_output, and
 * user/developer input messages) have no top-level `id` — only a `call_id`, or
 * nothing at all. This must return the same value across reconcile passes for the
 * same logical item, otherwise the transcript repeats older messages after every
 * idle. Returns null when no id-like field exists (caller falls back to a
 * content-based key).
 */
function deriveItemIdentity(item: Record<string, unknown> | undefined): string | null {
  if (!item) return null
  const direct = asString(item.id) || asString(item.itemId) || asString(item.item_id)
  if (direct) return direct
  const callId = asString(item.call_id) || asString(item.callId)
  if (callId) {
    const type = asString(item.type) || 'item'
    return `${type}:${callId}`
  }
  return null
}

function extractItemId(params: Record<string, unknown>): string {
  const item = isObject(params.item) ? params.item : undefined
  const identity = asString(params.itemId) || deriveItemIdentity(item)
  if (identity) return identity
  // Last resort: a deterministic key derived from the item's content so the same
  // item maps to the same part id across reconciles (was `item-${Date.now()}`,
  // which minted a new id every pass and duplicated the message on each idle).
  const fingerprint = item ? `${asString(item.type) || 'item'}:${extractText(item)}` : 'item'
  return `item-${hashString(fingerprint)}`
}

/**
 * Dedup key for a reconciled thread item: its stable identity, or for id-less
 * items (e.g. user/developer input messages) a deterministic key built from
 * turn + type + role + content, so the same item maps to the same key across
 * reconcile passes instead of duplicating.
 */
export function computeThreadItemKey(item: Record<string, unknown>, turnId: string | undefined): string {
  const identity = deriveItemIdentity(item)
  if (identity) return identity
  const type = asString(item.type) || 'item'
  return `synthetic:${turnId || 'noturn'}:${type}:${extractRole(item)}:${hashString(extractText(item))}`
}

function extractText(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n')
  if (!isObject(value)) return ''

  for (const key of ['text', 'content', 'delta', 'message', 'output']) {
    const text = extractText(value[key])
    if (text) return text
  }

  return ''
}

const DEFAULT_APP_SERVER_ERROR = 'Codex app-server error'

/**
 * Codex `codexErrorInfo` is either a plain enum string (`serverOverloaded`,
 * `usageLimitExceeded`, ...) or a single-key object such as
 * `{ responseStreamDisconnected: { httpStatusCode: 502 } }`.
 */
function describeCodexErrorInfo(info: unknown): string | null {
  if (typeof info === 'string') return info || null
  if (!isObject(info)) return null
  const [kind] = Object.keys(info)
  if (!kind) return null
  const detail = isObject(info[kind]) ? info[kind] : {}
  const httpStatus = typeof detail.httpStatusCode === 'number' ? ` HTTP ${detail.httpStatusCode}` : ''
  return `${kind}${httpStatus}`
}

interface AppServerErrorSummary {
  /** Human-readable message, suffixed with the Codex error code when known. */
  message: string
  code: string | null
  /** Codex retries the request itself; the turn is still alive. */
  willRetry: boolean
}

/**
 * Codex app-server `error` notifications carry `{ error: { message,
 * codexErrorInfo, additionalDetails }, willRetry, threadId, turnId }` and a
 * failed `turn/completed` carries `turn.error` with the same `TurnError` shape.
 * `extractText` does not descend into `error`, which is why every provider
 * failure used to surface as the bare "Codex app-server error".
 */
export function summarizeAppServerError(params: Record<string, unknown>): AppServerErrorSummary {
  const error = isObject(params.error) ? params.error : null
  const code = describeCodexErrorInfo(error?.codexErrorInfo ?? error?.codex_error_info)
  const message = (error ? asString(error.message) : undefined) || extractText(params) || DEFAULT_APP_SERVER_ERROR
  const details = error ? asString(error.additionalDetails) : undefined
  const lines = [message.trim()]
  if (details && details.trim() && !message.includes(details.trim())) lines.push(details.trim())
  const text = lines.join('\n')
  return {
    message: code ? `${text} (${code})` : text,
    code,
    willRetry: params.willRetry === true || params.will_retry === true
  }
}

export function extractFailedTurnError(params: Record<string, unknown>): AppServerErrorSummary | null {
  const turn = isObject(params.turn) ? params.turn : null
  if (!turn || asString(turn.status) !== 'failed' || !isObject(turn.error)) return null
  return summarizeAppServerError({ error: turn.error })
}

function extractRole(item: Record<string, unknown>): string {
  return (asString(item.role) || asString(item.author) || asString(item.sender) || '').toLowerCase()
}

function extractToolName(item: Record<string, unknown>): string {
  const server = asString(item.server)
  const tool = asString(item.tool)
  if ((item.type === 'mcpToolCall' || server || tool) && (server || tool)) {
    return [server, tool].filter(Boolean).join('.')
  }

  return (
    asString(item.toolName) ||
    asString(item.tool_name) ||
    asString(item.name) ||
    asString(item.type) ||
    'tool'
  )
}

function extractToolTitle(item: Record<string, unknown>, toolName: string): string {
  if (item.type === 'commandExecution') {
    const actionCommand = Array.isArray(item.commandActions)
      ? item.commandActions
        .filter(isObject)
        .map((action) => asString(action.command))
        .find(Boolean)
      : undefined
    const command = actionCommand || asString(item.command)
    if (command) return command
  }

  if (item.type === 'fileChange') {
    const paths = Array.isArray(item.changes)
      ? item.changes
        .filter(isObject)
        .map((change) => asString(change.path))
        .filter((path): path is string => !!path)
      : []
    const directPath = asString(item.path)
    if (paths.length === 1) return basename(paths[0])
    if (paths.length > 1) return `${basename(paths[0])} +${paths.length - 1}`
    if (directPath) return basename(directPath)
  }

  return toolName
}

function truncateForIpc(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n... (truncated for display)`
}

function stringifyForIpc(value: unknown, maxChars: number): string | undefined {
  if (value == null) return undefined
  if (typeof value === 'string') return truncateForIpc(value, maxChars)
  try {
    const seen = new WeakSet<object>()
    return truncateForIpc(JSON.stringify(value, (_key, nested) => {
      if (typeof nested === 'bigint') return nested.toString()
      if (typeof nested === 'function' || typeof nested === 'symbol') return undefined
      if (nested && typeof nested === 'object') {
        if (seen.has(nested)) return '[Circular]'
        seen.add(nested)
      }
      return nested
    }, 2), maxChars)
  } catch {
    return truncateForIpc(String(value), maxChars)
  }
}

export function convertEventToMessageParts(
  event: unknown,
  seenPartIds: Set<string>,
  partContentLengths: Map<string, string>,
  session: CodexItemState
): MessagePart[] {
  if (!isObject(event) || !asString(event.method)) return []
  const method = event.method
  const params = isObject(event.params) ? event.params : {}
  const item = isObject(params.item) ? params.item : undefined

  if (method === 'item/agentMessage/delta') {
    const itemId = asString(params.itemId) || `agent-${Date.now()}`
    const partId = `agent-${itemId}`
    const delta = asString(params.delta) || ''
    const previous = session.streamedTextByItemId.get(itemId) || ''
    const next = previous + delta
    const update = seenPartIds.has(partId)
    seenPartIds.add(partId)
    session.streamedTextByItemId.set(itemId, next)
    markAssistantTextForTurn(session, params, {}, next)
    partContentLengths.set(partId, String(next.length))
    return [{
      id: partId,
      type: MessagePartType.TEXT,
      text: next,
      role: MessageRole.ASSISTANT,
      update
    }]
  }

  if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
    const itemId = asString(params.itemId) || `reasoning-${Date.now()}`
    const partId = `reasoning-${itemId}`
    const text = asString(params.delta) || ''
    if (!text && seenPartIds.has(partId)) return []
    seenPartIds.add(partId)
    partContentLengths.set(partId, String(text.length))
    return [{
      id: partId,
      type: MessagePartType.REASONING,
      text,
      role: MessageRole.ASSISTANT
    }]
  }

  if (
    method === 'item/commandExecution/outputDelta' ||
    method === 'command/exec/outputDelta' ||
    method === 'process/outputDelta'
  ) {
    return convertOutputDeltaEvent('command', params, seenPartIds, partContentLengths, session)
  }

  if (
    method === 'item/fileChange/outputDelta' ||
    method === 'item/fileChange/patchUpdated'
  ) {
    return convertOutputDeltaEvent('file_change', params, seenPartIds, partContentLengths, session)
  }

  if (
    method === 'item/plan/delta' ||
    method === 'turn/plan/updated'
  ) {
    return convertOutputDeltaEvent('plan', params, seenPartIds, partContentLengths, session)
  }

  if (method === 'item/mcpToolCall/progress') {
    return convertOutputDeltaEvent('mcp_tool', params, seenPartIds, partContentLengths, session)
  }

  if ((method === 'item/started' || method === 'item/completed') && item) {
    return convertThreadItem(method, item, params, seenPartIds, partContentLengths, session)
  }

  if (method === 'error') {
    const failure = summarizeAppServerError(params)
    const turnId = asString(params.turnId) || asString(params.turn_id) || `${Date.now()}`
    if (failure.willRetry) {
      return [{
        id: `retry-${turnId}-${Date.now()}`,
        type: MessagePartType.RETRY,
        text: `Codex is retrying after a recoverable error: ${failure.message}`,
        role: MessageRole.ASSISTANT
      }]
    }
    // One fatal error per turn: the failed `turn/completed` that follows
    // carries the same TurnError and must not print a second copy.
    const partId = `error-${turnId}`
    if (seenPartIds.has(partId)) return []
    seenPartIds.add(partId)
    return [{
      id: partId,
      type: MessagePartType.ERROR,
      text: failure.message,
      role: MessageRole.ASSISTANT
    }]
  }

  if (method === 'turn/completed') {
    const failure = extractFailedTurnError(params)
    if (!failure) return []
    const turn = isObject(params.turn) ? params.turn : {}
    const partId = `error-${asString(turn.id) || Date.now()}`
    if (seenPartIds.has(partId)) return []
    seenPartIds.add(partId)
    return [{
      id: partId,
      type: MessagePartType.ERROR,
      text: failure.message,
      role: MessageRole.ASSISTANT
    }]
  }

  return []
}

function convertOutputDeltaEvent(
  toolName: string,
  params: Record<string, unknown>,
  seenPartIds: Set<string>,
  partContentLengths: Map<string, string>,
  session: CodexItemState
): MessagePart[] {
  const itemId = asString(params.itemId) || asString(params.processId) || asString(params.turnId) || `${toolName}-${Date.now()}`
  const partId = `tool-${itemId}`
  const previous = session.streamedTextByItemId.get(partId) || ''
  const next = truncateForIpc(previous + extractText(params), MAX_IPC_TOOL_OUTPUT_CHARS)
  const update = seenPartIds.has(partId)
  const runningTool = session.runningTools.get(partId)
  if (runningTool) {
    runningTool.lastActivityTime = Date.now()
    runningTool.lastActivityMonotonicTime = performance.now()
  }
  seenPartIds.add(partId)
  session.streamedTextByItemId.set(partId, next)
  partContentLengths.set(partId, `${next.length}:${toolName}`)

  return [{
    id: partId,
    type: MessagePartType.TOOL,
    role: MessageRole.ASSISTANT,
    tool: {
      name: toolName,
      status: 'running',
      title: toolName,
      input: stringifyForIpc(params, MAX_IPC_TOOL_INPUT_CHARS),
      output: next
    },
    update
  }]
}

function convertThreadItem(
  method: string,
  item: Record<string, unknown>,
  params: Record<string, unknown>,
  seenPartIds: Set<string>,
  partContentLengths: Map<string, string>,
  session: CodexItemState
): MessagePart[] {
  const itemId = extractItemId(params)
  const type = asString(item.type) || ''
  const role = extractRole(item)
  const text = extractText(item)

  if (type.includes('reasoning')) {
    const partId = `reasoning-${itemId}`
    if (seenPartIds.has(partId)) return []
    seenPartIds.add(partId)
    partContentLengths.set(partId, String(text.length))
    return [{
      id: partId,
      type: MessagePartType.REASONING,
      text,
      role: MessageRole.ASSISTANT
    }]
  }

  if (role === 'user' || type.includes('user') || type === 'user_message') {
    const partId = `user-${itemId}`
    if (seenPartIds.has(partId)) return []
    seenPartIds.add(partId)
    partContentLengths.set(partId, String(text.length))
    return [{
      id: partId,
      type: MessagePartType.TEXT,
      text,
      role: MessageRole.USER
    }]
  }

  if (role === 'assistant' || type.includes('agent') || type.includes('assistant') || (!type && text)) {
    const partId = `agent-${itemId}`
    if (seenPartIds.has(partId) && method !== 'item/completed') return []
    const finalText = text || session.streamedTextByItemId.get(itemId) || ''
    const alreadySeen = seenPartIds.has(partId)
    if (!alreadySeen && method === 'item/completed' && hasSeenAssistantTextForTurn(session, params, item, finalText)) {
      return []
    }
    seenPartIds.add(partId)
    if (method === 'item/completed') {
      markAssistantTextForTurn(session, params, item, finalText)
    }
    partContentLengths.set(partId, String(finalText.length))
    return [{
      id: partId,
      type: MessagePartType.TEXT,
      text: finalText,
      role: MessageRole.ASSISTANT,
      update: method === 'item/completed' && session.streamedTextByItemId.has(itemId)
    }]
  }

  const toolName = extractToolName(item)
  const toolTitle = extractToolTitle(item, toolName)
  const partId = `tool-${itemId}`
  const isCompleted = method === 'item/completed'
  if (!isCompleted && seenPartIds.has(partId)) return []
  seenPartIds.add(partId)

  const part: MessagePart = {
    id: partId,
    type: MessagePartType.TOOL,
    role: MessageRole.ASSISTANT,
    tool: {
      name: toolName,
      status: isCompleted ? 'completed' : 'running',
      title: toolTitle,
      input: stringifyForIpc(item, MAX_IPC_TOOL_INPUT_CHARS),
      output: isCompleted ? stringifyForIpc(extractText(item) || item, MAX_IPC_TOOL_OUTPUT_CHARS) : undefined
    },
    update: isCompleted
  }

  if (isCompleted) {
    session.runningTools.delete(partId)
  } else {
    const startedAt = typeof params.startedAtMs === 'number' ? params.startedAtMs : Date.now()
    const observedAt = performance.now()
    session.runningTools.set(partId, {
      partId,
      toolName,
      startTime: startedAt,
      lastActivityTime: Date.now(),
      lastActivityMonotonicTime: observedAt,
      input: item
    })
  }

  partContentLengths.set(partId, `${part.tool?.status}:${toolName}`)
  return [part]
}

function hasSeenAssistantTextForTurn(
  session: CodexItemState,
  params: Record<string, unknown>,
  item: Record<string, unknown>,
  text: string
): boolean {
  const key = buildAssistantTextKey(text)
  if (!key) return false
  for (const scopeKey of extractAssistantTextScopeKeys(params, item, key)) {
    if (session.assistantTextKeysByTurn.get(scopeKey)?.has(key)) return true
  }
  return false
}

function markAssistantTextForTurn(
  session: CodexItemState,
  params: Record<string, unknown>,
  item: Record<string, unknown>,
  text: string
): void {
  const key = buildAssistantTextKey(text)
  if (!key) return
  for (const scopeKey of extractAssistantTextScopeKeys(params, item, key)) {
    const seenForScope = session.assistantTextKeysByTurn.get(scopeKey) ?? new Set<string>()
    seenForScope.add(key)
    session.assistantTextKeysByTurn.set(scopeKey, seenForScope)
  }
}

function extractTurnKey(params: Record<string, unknown>, item: Record<string, unknown>): string {
  const metadata = isObject(item.internal_chat_message_metadata_passthrough)
    ? item.internal_chat_message_metadata_passthrough
    : {}
  return (
    asString(params.turnId) ||
    asString(params.turn_id) ||
    asString(item.turnId) ||
    asString(item.turn_id) ||
    asString(metadata.turn_id) ||
    asString(metadata.turnId) ||
    asString(params.threadId) ||
    'unknown-turn'
  )
}

function extractAssistantTextScopeKeys(
  params: Record<string, unknown>,
  item: Record<string, unknown>,
  textKey: string
): string[] {
  const keys = new Set<string>([extractTurnKey(params, item)])
  const threadKey = asString(params.threadId) || asString(item.threadId) || asString(item.thread_id)
  if (threadKey && textKey.length >= MIN_THREAD_LEVEL_ASSISTANT_DEDUPE_CHARS) {
    keys.add(`thread:${threadKey}`)
  }
  return Array.from(keys)
}

function buildAssistantTextKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}
