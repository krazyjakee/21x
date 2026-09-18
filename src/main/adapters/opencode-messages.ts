/**
 * Converts OpenCode session messages (session.messages() results) into
 * transcript parts and messages.
 */

import type { MessagePart, SessionMessage } from './coding-agent-adapter'
import { MessagePartType, MessageRole } from './coding-agent-adapter'
import { parseMaybeJson } from './shared/parse-maybe-json'

/** Loose view of one session.messages() entry. */
export interface OpencodeMessage {
  info?: Record<string, unknown> & { id?: string; role?: string }
  parts?: Array<Record<string, unknown>>
}

/**
 * Part ids are scoped by message id: OpenCode part ids are only unique
 * within their message.
 */
function getScopedPartId(messageId: string, rawPartId: string | undefined, fallbackIndex?: number): string | undefined {
  if (rawPartId) return `${messageId}:${rawPartId}`
  if (fallbackIndex !== undefined) return `${messageId}:part-${fallbackIndex}`
  return undefined
}

/**
 * Transforms a raw OpenCode tool part into the structure the renderer expects.
 * OpenCode reports the tool name as `part.tool` and the details in `part.state`.
 */
function transformToolPart(part: Record<string, unknown>): MessagePart {
  const state = (part.state || {}) as Record<string, unknown>
  const stateInput = (state.input && typeof state.input === 'object' ? state.input : {}) as Record<string, unknown>
  const status = (state.status as string) || 'unknown'
  const questions = parseMaybeJson(stateInput.questions)
  const todos = parseMaybeJson(stateInput.todos)
  const hasQuestions = Array.isArray(questions) && questions.length > 0
  const hasTodos = Array.isArray(todos) && todos.length > 0

  return {
    id: part.id as string,
    type: (hasQuestions ? 'question' : hasTodos ? 'todowrite' : 'tool') as MessagePartType,
    text: part.text as string,
    content: part.text as string,
    tool: {
      name: (part.tool as string) || 'unknown',
      status,
      title: (state.title as string) || undefined,
      input: Object.keys(stateInput).length > 0 ? JSON.stringify(stateInput, null, 2) : undefined,
      output: state.output ? String(state.output).slice(0, 2000) : undefined,
      error: status === 'error' && state.error ? String(state.error) : undefined,
      ...(hasQuestions && { questions }),
      ...(hasTodos && { todos })
    },
    state: part.state as MessagePart['state']
  }
}

/** Full history for resume, including provider errors that OpenCode stores without parts. */
export function convertResumedMessages(data: OpencodeMessage[]): SessionMessage[] {
  const messages: SessionMessage[] = []
  for (const msg of data) {
    if (!msg.info) continue
    const messageId = String(msg.info.id)
    const parts: MessagePart[] = (msg.parts || []).map((part, partIndex) => {
      const id = getScopedPartId(messageId, part.id as string | undefined, partIndex)
      if (part.type === 'tool') return { ...transformToolPart(part), id }
      return { id, type: part.type as MessagePartType, text: part.text as string, content: part.text as string }
    })

    // OpenCode records provider errors (e.g. "Payment Required", quota
    // exceeded) on msg.info.error without creating parts, so they would
    // otherwise vanish on resume.
    const msgError = msg.info.error as { name?: string; data?: { message?: string } } | undefined
    if (msgError && parts.length === 0) {
      const errorText = `⚠️ Provider error: ${msgError.data?.message || msgError.name || 'Unknown provider error'}`
      parts.push({ id: `error-${messageId}`, type: MessagePartType.TEXT, text: errorText, content: errorText })
    }

    messages.push({
      id: msg.info.id as string,
      role: (msg.info.role || 'assistant') as MessageRole,
      parts
    })
  }
  return messages
}

/**
 * Returns parts that are new or changed since the last poll. Text, reasoning
 * and tool parts are re-emitted as updates when their fingerprint changes.
 */
export function convertPolledParts(
  data: OpencodeMessage[],
  seenMessageIds: Set<string>,
  seenPartIds: Set<string>,
  partContentLengths: Map<string, string>
): MessagePart[] {
  const newParts: MessagePart[] = []

  for (const msg of data) {
    if (!msg.info) continue
    const msgId = msg.info.id as string
    const msgRole = msg.info.role as MessagePart['role']
    seenMessageIds.add(msgId)

    for (const [partIndex, p] of (Array.isArray(msg.parts) ? msg.parts : []).entries()) {
      const partId = getScopedPartId(String(msgId), p.id as string | undefined, partIndex)
      if (!partId) continue

      const isNewPart = !seenPartIds.has(partId)
      const isUpdatable = p.type === 'text' || p.type === 'reasoning' || p.type === 'tool'

      if (isUpdatable) {
        const state = p.state as Record<string, unknown> | undefined
        const textLength = (p.text as string | undefined)?.length ?? 0
        const fingerprint = p.type === 'tool'
          ? `${state?.status}:${p.type}:${textLength}:${(state?.output as string | undefined)?.length ?? 0}`
          : String(textLength)
        if (!isNewPart && partContentLengths.get(partId) === fingerprint) continue

        seenPartIds.add(partId)
        partContentLengths.set(partId, fingerprint)
        newParts.push(p.type === 'tool'
          ? { ...transformToolPart(p), id: partId, role: msgRole, update: !isNewPart }
          : { id: partId, type: p.type as MessagePartType, text: p.text as string, content: p.text as string, role: msgRole, update: !isNewPart })
      } else if (isNewPart) {
        seenPartIds.add(partId)
        newParts.push({ id: partId, type: p.type as MessagePartType, text: p.text as string, content: p.text as string, role: msgRole })
      }
    }
  }

  return newParts
}

export function convertAllMessages(data: OpencodeMessage[]): SessionMessage[] {
  return data.map((msg, idx) => {
    const messageId = (msg.info?.id as string) || `msg-${idx}`
    return {
      id: messageId,
      role: msg.info?.role === 'user' ? MessageRole.USER : MessageRole.ASSISTANT,
      parts: (msg.parts || []).map((p, partIndex) => ({
        id: getScopedPartId(messageId, p.id as string | undefined, partIndex),
        type: p.type as MessagePartType,
        text: p.text as string,
        content: p.text as string
      }))
    }
  })
}

/** A pending/running tool part in the last assistant message, if any. */
export function findActiveToolInLastAssistantMessage(data: OpencodeMessage[]): { id: string; status: string } | null {
  for (let i = data.length - 1; i >= 0; i--) {
    const msg = data[i]
    if (!msg.info || msg.info.role === 'user') continue
    for (const part of msg.parts || []) {
      if (part.type !== 'tool') continue
      const status = (part.state as Record<string, unknown> | undefined)?.status as string | undefined
      if (status === 'pending' || status === 'running') return { id: part.id as string, status }
    }
    return null
  }
  return null
}

export function listRunningTools(data: OpencodeMessage[]): Array<{
  partId: string
  toolName: string
  startTime?: number
  input?: Record<string, unknown>
}> {
  return data.flatMap((msg) => (Array.isArray(msg.parts) ? msg.parts : []).flatMap((part) => {
    const state = part.state as Record<string, unknown> | undefined
    if (part.type !== 'tool' || state?.status !== 'running') return []
    return [{
      partId: part.id as string,
      toolName: (part.tool as string) || 'unknown',
      startTime: (state.time as Record<string, unknown> | undefined)?.start as number | undefined,
      input: (state.input as Record<string, unknown> | undefined) || undefined
    }]
  }))
}
