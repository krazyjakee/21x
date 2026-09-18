/**
 * Converts buffered ACP `session/update` notifications into transcript parts,
 * including the turn detection that assigns stable per-turn part ids.
 */

import { randomUUID } from 'crypto'
import type { MessagePart } from './coding-agent-adapter'
import { MessagePartType } from './coding-agent-adapter'
import type { JsonRpcNotification } from './shared/json-rpc'

export interface SessionUpdate {
  sessionUpdate?: string
  messageId?: string
  toolCallId?: string
  title?: string
  kind?: string
  status?: string
  rawInput?: unknown
  rawOutput?: unknown
  content?: unknown
  entries?: Array<{
    content: string
    priority: string
    status: string
  }>
}

/** Turn-detection state kept per ACP session. */
export interface AcpTurnState {
  currentUserTurnId: number
  lastChunkTime: number | null
  currentTurnId: number
  lastSessionUpdateType: string | null
  /** Turn tied to an in-flight session/prompt */
  activeTurnId: number | null
  /** True after tool activity; the next assistant chunk must start a new turn */
  pendingAssistantTurnSplit: boolean
  /** Metadata cached from initial tool_call events for the completed update */
  toolCallMetadata: Map<string, { name: string; input: string; title?: string }>
}

/**
 * Caps toolCallMetadata, which caches in-progress tool calls and could grow
 * unbounded from tool calls that never complete.
 */
const MAX_TOOL_CALL_METADATA = 500
const TURN_TIME_GAP_MS = 2000

export function extractTextFromUpdateContent(content: SessionUpdate['content']): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((entry) => extractTextFromUpdateContent(entry))
      .filter(Boolean)
      .join('\n')
  }
  if (typeof content !== 'object') return ''

  const value = content as Record<string, unknown>
  if (typeof value.text === 'string') return value.text
  if (typeof value.content === 'string') return value.content
  if (value.content) {
    const nestedContent = extractTextFromUpdateContent(value.content)
    if (nestedContent) return nestedContent
  }
  if (value.message) {
    const nestedMessage = extractTextFromUpdateContent(value.message)
    if (nestedMessage) return nestedMessage
  }
  return ''
}

/**
 * Appends a streamed chunk to accumulated text. Agents sometimes resend the
 * full text so far, or replay an overlapping tail; both are merged instead of
 * duplicated.
 */
export function mergeStreamingText(currentText: string, incomingChunk: string): string {
  if (!currentText) return incomingChunk
  if (!incomingChunk) return currentText
  if (incomingChunk.startsWith(currentText)) return incomingChunk
  if (currentText.endsWith(incomingChunk)) return currentText

  const MIN_OVERLAP_CHARS = 8

  const maxSkippedPrefix = Math.min(32, currentText.length - MIN_OVERLAP_CHARS)
  for (let skipped = 1; skipped <= maxSkippedPrefix; skipped++) {
    const replayedText = currentText.slice(skipped)
    if (incomingChunk.startsWith(replayedText)) {
      return currentText.slice(0, skipped) + incomingChunk
    }
  }

  const maxOverlap = Math.min(currentText.length, incomingChunk.length)
  for (let length = maxOverlap; length > 0; length--) {
    if (length >= MIN_OVERLAP_CHARS && currentText.endsWith(incomingChunk.slice(0, length))) {
      return currentText + incomingChunk.slice(length)
    }
  }

  return currentText + incomingChunk
}

function isUserUpdateType(sessionUpdate?: string | null): boolean {
  return sessionUpdate === 'user_message_chunk'
    || sessionUpdate === 'human_message_chunk'
    || sessionUpdate === 'user_message'
    || sessionUpdate === 'human_message'
}

export function isAssistantChunkUpdateType(sessionUpdate?: string | null): boolean {
  return sessionUpdate === 'agent_message_chunk'
    || sessionUpdate === 'assistant_message_chunk'
    || sessionUpdate === 'agent_thought_chunk'
}

function isToolingUpdateType(sessionUpdate?: string | null): boolean {
  // Only actual tool calls split turns. `plan` and `available_commands_update`
  // produce no visible parts; splitting on them fragments one response into
  // several message bubbles.
  return sessionUpdate === 'tool_call'
    || sessionUpdate === 'tool_call_update'
}

function getAssistantTurnId(session: AcpTurnState): number {
  const now = Date.now()
  const previousType = session.lastSessionUpdateType
  const mustSplitAfterTool = session.pendingAssistantTurnSplit

  if (
    session.activeTurnId &&
    !mustSplitAfterTool &&
    !isToolingUpdateType(previousType) &&
    !isUserUpdateType(previousType)
  ) {
    session.lastChunkTime = now
    return session.activeTurnId
  }

  const timeSinceLastChunk = session.lastChunkTime ? now - session.lastChunkTime : Infinity
  const shouldStartNewTurn = session.currentTurnId === 0
    || mustSplitAfterTool
    || isUserUpdateType(previousType)
    || isToolingUpdateType(previousType)
    || (isAssistantChunkUpdateType(previousType) && timeSinceLastChunk > TURN_TIME_GAP_MS)

  if (shouldStartNewTurn) {
    session.currentTurnId += 1
    console.log(`[AcpAdapter] Detected NEW assistant turn #${session.currentTurnId} (prev=${previousType}, gap=${timeSinceLastChunk}ms, split=${mustSplitAfterTool})`)
  }

  session.pendingAssistantTurnSplit = false
  if (session.activeTurnId) {
    session.activeTurnId = session.currentTurnId
  }
  session.lastChunkTime = now
  return session.currentTurnId
}

function getUserTurnId(session: AcpTurnState): number {
  if (!isUserUpdateType(session.lastSessionUpdateType)) {
    session.currentUserTurnId += 1
    console.log(`[AcpAdapter] Detected NEW user turn #${session.currentUserTurnId} (prev=${session.lastSessionUpdateType})`)
  }
  return session.currentUserTurnId
}

function normalizeToolName(rawToolName?: string): string {
  switch (rawToolName) {
    case 'exec_command':
      return 'command'
    case 'write_stdin':
      return 'stdin'
    case 'update_plan':
      return 'plan'
    default:
      return rawToolName || 'tool'
  }
}

function buildToolTitle(
  rawToolName?: string,
  rawInput?: Record<string, unknown>,
  fallback?: string
): string | undefined {
  const trimmedFallback = fallback?.trim()

  switch (rawToolName) {
    case 'exec_command': {
      const command = rawInput?.command
      if (Array.isArray(command)) return command.join(' ') || trimmedFallback
      if (typeof command === 'string' && command.trim()) return command.trim()
      const cmd = typeof rawInput?.cmd === 'string' ? rawInput.cmd.trim() : ''
      return cmd || trimmedFallback
    }
    case 'write_stdin': {
      const chars = typeof rawInput?.chars === 'string' ? rawInput.chars.trim() : ''
      return chars ? chars.replace(/\s+/g, ' ').slice(0, 80) : 'poll'
    }
    case 'update_plan': {
      const plan = Array.isArray(rawInput?.plan) ? rawInput.plan : []
      const firstStep = plan.find((item): item is { step: string } =>
        typeof item === 'object' && item !== null && typeof (item as { step?: unknown }).step === 'string'
      )
      if (firstStep) return `${plan.length} steps: ${firstStep.step}`
      const explanation = typeof rawInput?.explanation === 'string' ? rawInput.explanation.trim() : ''
      return explanation ? explanation.slice(0, 80) : trimmedFallback
    }
    default:
      return trimmedFallback
  }
}

function joinCommand(command: string | string[] | undefined): string | undefined {
  return Array.isArray(command) ? command.join(' ') : command
}

function cacheToolCallMetadata(session: AcpTurnState, partId: string, metadata: { name: string; input: string; title?: string }): void {
  if (session.toolCallMetadata.size >= MAX_TOOL_CALL_METADATA) {
    // Evict the oldest half (Maps preserve insertion order).
    const toEvict = Math.ceil(MAX_TOOL_CALL_METADATA * 0.5)
    let evicted = 0
    for (const key of session.toolCallMetadata.keys()) {
      if (evicted >= toEvict) break
      session.toolCallMetadata.delete(key)
      evicted++
    }
  }
  session.toolCallMetadata.set(partId, metadata)
}

type ToolRawInput = { cmd?: string; command?: string | string[]; parsed_cmd?: Array<{ cmd?: string }>; tool?: string; server?: string }

function convertToolUpdate(
  update: SessionUpdate,
  partId: string,
  seenPartIds: Set<string>,
  session?: AcpTurnState
): MessagePart[] {
  const parts: MessagePart[] = []
  if (session) session.pendingAssistantTurnSplit = true

  const rawInput = update.rawInput as ToolRawInput | undefined
  const commandFromParsed = rawInput?.parsed_cmd?.map((c) => c.cmd).join('; ')
  const toolFromTitle = update.title?.startsWith('Tool: ') ? update.title.slice(6) : undefined

  // Cache metadata from the initial tool_call so the completed
  // tool_call_update (which may lack name/input) can still be rendered.
  if (update.status !== 'completed' && session && partId) {
    const cachedInput = joinCommand(rawInput?.command) || rawInput?.cmd || commandFromParsed || update.title || ''
    // Tool name: kind > rawInput.tool (with server prefix) > title without "Tool: "
    const toolFromRawInput = rawInput?.tool
      ? (rawInput.server ? `${rawInput.server}/${rawInput.tool}` : rawInput.tool)
      : undefined
    const cachedName = update.kind || toolFromRawInput || toolFromTitle || ''
    const cachedTitle = buildToolTitle(cachedName || update.title, rawInput as Record<string, unknown>, cachedInput)
    if (cachedName || cachedInput || cachedTitle) {
      cacheToolCallMetadata(session, partId, { name: cachedName, input: cachedInput, title: cachedTitle })
    }

    // Emit the running tool immediately so the user sees a spinner instead of
    // waiting for completion.
    if (!seenPartIds.has(partId)) {
      seenPartIds.add(partId)
      parts.push({
        id: partId,
        type: MessagePartType.TOOL,
        tool: {
          name: normalizeToolName(cachedName || update.title || 'tool'),
          title: cachedTitle,
          status: 'running',
          input: cachedInput || undefined
        }
      })
    }
  }

  if (update.status === 'completed') {
    const alreadySeen = seenPartIds.has(partId)
    seenPartIds.add(partId)
    const cachedMeta = session?.toolCallMetadata.get(partId)
    const rawOutput = update.rawOutput as {
      command?: string | string[]
      stdout?: string
      stderr?: string
      formatted_output?: string
      content?: Array<{ text?: string; type?: string }>
      isError?: boolean
    } | undefined

    // tool_call carries the command in rawInput, tool_call_update in rawOutput;
    // content is [{type:"content", content:{type:"text", text:"..."}}].
    const contentArray = update.content as Array<{ type?: string; content?: { type?: string; text?: string }; text?: string }> | undefined
    const inputFromContent = Array.isArray(contentArray)
      ? contentArray.map((c) => c.content?.text || c.text || '').filter(Boolean).join('\n')
      : undefined
    const command = joinCommand(rawInput?.command) || rawInput?.cmd || joinCommand(rawOutput?.command) || commandFromParsed
      || update.title || cachedMeta?.input || inputFromContent || 'Unknown'

    // Codex output format: {content: [{text: "...", type: "text"}], isError: false}
    const outputFromContent = Array.isArray(rawOutput?.content)
      ? rawOutput.content.map((c) => c.text || '').filter(Boolean).join('\n')
      : undefined
    const output = rawOutput?.formatted_output || rawOutput?.stdout || rawOutput?.stderr || outputFromContent || ''

    session?.toolCallMetadata.delete(partId)

    const rawToolName = update.kind || cachedMeta?.name || toolFromTitle || update.title || 'tool'
    parts.push({
      id: partId,
      type: MessagePartType.TOOL,
      tool: {
        name: normalizeToolName(rawToolName),
        title: buildToolTitle(
          rawToolName,
          rawInput as Record<string, unknown> | undefined,
          cachedMeta?.title || (command && command !== rawToolName ? command : undefined)
        ),
        status: update.status,
        input: command,
        output
      },
      // Replace the running part emitted earlier instead of adding another.
      update: alreadySeen
    })
  }
  return parts
}

/** Accumulates a streamed chunk under `partId` and emits the full text so far. */
function streamedTextPart(
  partId: string,
  chunk: string,
  type: MessagePartType,
  role: 'user' | 'assistant',
  seenPartIds: Set<string>,
  partContentLengths: Map<string, string>
): MessagePart[] {
  if (!chunk) return []
  const text = mergeStreamingText(partContentLengths.get(partId) || '', chunk)
  partContentLengths.set(partId, text)
  const part: MessagePart = { id: partId, type, text, role, update: seenPartIds.has(partId) }
  seenPartIds.add(partId)
  return [part]
}

function convertFullMessage(
  update: SessionUpdate,
  seenPartIds: Set<string>,
  partContentLengths: Map<string, string>,
  session?: AcpTurnState
): MessagePart[] {
  const text = extractTextFromUpdateContent(update.content)
  if (!text) return []

  const role = update.sessionUpdate === 'user_message' || update.sessionUpdate === 'human_message'
    ? 'user'
    : 'assistant'

  // Assistant messages without a messageId reuse the streaming chunk id
  // (`agent-response-{turnId}`) so the final message does not duplicate the
  // text already streamed under that id.
  let partId: string
  if (update.messageId) {
    partId = update.messageId
  } else if (role === 'assistant' && session) {
    const turnId = getAssistantTurnId(session)
    partId = turnId > 0 ? `agent-response-${turnId}` : 'agent-response'
  } else {
    partId = `${update.sessionUpdate}-${randomUUID()}`
  }

  if (!seenPartIds.has(partId)) {
    seenPartIds.add(partId)
    partContentLengths.set(partId, text)
    return [{ id: partId, type: MessagePartType.TEXT, text, role }]
  }
  // The final agent_message may be more complete than the accumulated chunks.
  if (role === 'assistant' && text.length > (partContentLengths.get(partId) || '').length) {
    partContentLengths.set(partId, text)
    return [{ id: partId, type: MessagePartType.TEXT, text, role, update: true }]
  }
  return []
}

export function convertAcpEventToMessageParts(
  event: unknown,
  seenPartIds: Set<string>,
  partContentLengths: Map<string, string>,
  session?: AcpTurnState,
  debug = false
): MessagePart[] {
  const wrappedEvent = event as Record<string, unknown>
  const actualEvent = (wrappedEvent._notification || event) as Record<string, unknown>

  if (actualEvent._isError) {
    const errorId = `error-${Date.now()}`
    if (seenPartIds.has(errorId)) return []
    seenPartIds.add(errorId)
    return [{
      id: errorId,
      type: MessagePartType.TEXT,
      text: `Error: ${actualEvent.message}${actualEvent.data ? ` - ${actualEvent.data}` : ''}`,
      role: 'assistant'
    }]
  }

  const notification = actualEvent as unknown as JsonRpcNotification
  if (notification.method !== 'session/update') return []

  const update = (notification.params as { update?: SessionUpdate } | undefined)?.update
  if (!update) return []

  let parts: MessagePart[] = []
  switch (update.sessionUpdate) {
    case 'tool_call':
    case 'tool_call_update':
      parts = convertToolUpdate(update, update.toolCallId || randomUUID(), seenPartIds, session)
      break
    case 'agent_message_chunk':
    case 'assistant_message_chunk': {
      const turnId = session ? getAssistantTurnId(session) : 0
      const messageId = turnId > 0 ? `agent-response-${turnId}` : 'agent-response'
      if (debug) console.log(`[AcpAdapter] agent_message_chunk: turnId=${turnId}, messageId=${messageId}`)
      parts = streamedTextPart(messageId, extractTextFromUpdateContent(update.content), MessagePartType.TEXT, 'assistant', seenPartIds, partContentLengths)
      break
    }
    case 'agent_thought_chunk': {
      const turnId = session ? getAssistantTurnId(session) : 0
      const thinkingId = turnId > 0 ? `agent-thinking-${turnId}` : 'agent-thinking'
      parts = streamedTextPart(thinkingId, extractTextFromUpdateContent(update.content), MessagePartType.REASONING, 'assistant', seenPartIds, partContentLengths)
      break
    }
    case 'user_message_chunk':
    case 'human_message_chunk': {
      const turnId = session ? getUserTurnId(session) : 0
      const userId = turnId > 0 ? `user-message-${turnId}` : 'user-message'
      parts = streamedTextPart(userId, extractTextFromUpdateContent(update.content), MessagePartType.TEXT, 'user', seenPartIds, partContentLengths)
      break
    }
    case 'agent_message':
    case 'assistant_message':
    case 'user_message':
    case 'human_message':
      parts = convertFullMessage(update, seenPartIds, partContentLengths, session)
      // An empty full message leaves turn state untouched.
      if (parts.length === 0 && !extractTextFromUpdateContent(update.content)) return parts
      break
    case 'plan':
      console.log(`[AcpAdapter] Received plan with ${(update.entries || []).length} entries`)
      break
  }

  // Only turn-relevant updates may change lastSessionUpdateType. `plan` and
  // `available_commands_update` would otherwise make the next assistant chunk
  // start a spurious new turn.
  if (session && update.sessionUpdate) {
    const isTurnRelevant =
      isAssistantChunkUpdateType(update.sessionUpdate)
      || isToolingUpdateType(update.sessionUpdate)
      || isUserUpdateType(update.sessionUpdate)
      || update.sessionUpdate === 'agent_message'
      || update.sessionUpdate === 'assistant_message'
    if (isTurnRelevant) {
      session.lastSessionUpdateType = update.sessionUpdate
    }
  }

  return parts
}
