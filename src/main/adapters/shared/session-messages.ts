import type { MessagePart, SessionMessage } from '../coding-agent-adapter'
import { MessageRole } from '../coding-agent-adapter'

function roleOf(part: MessagePart): MessageRole {
  if (part.role === 'user') return MessageRole.USER
  if (part.role === 'system') return MessageRole.SYSTEM
  return MessageRole.ASSISTANT
}

/**
 * Rebuilds transcript messages from replayed parts. Only the latest version of
 * each part (by id + role) is kept, in first-seen order. A new message starts
 * whenever the role changes or the part is a new top-level item, which keeps
 * assistant text that arrives after tool calls in its own message instead of
 * appending it to earlier text.
 */
export function groupPartsIntoMessages(parts: Iterable<MessagePart>): SessionMessage[] {
  const latest = new Map<string, MessagePart>()
  for (const part of parts) {
    const key = `${part.id ?? `part-${latest.size}`}-${part.role || 'assistant'}`
    if (!latest.has(key) || part.update) latest.set(key, part)
  }

  const messages: SessionMessage[] = []
  let current: SessionMessage | null = null
  let previous: MessagePart | null = null
  for (const part of latest.values()) {
    const role = roleOf(part)
    if (!current || current.role !== role || !previous || part.id !== previous.id) {
      current = { id: `msg-${messages.length}`, role, parts: [] }
      messages.push(current)
    }
    current.parts.push(part)
    previous = part
  }
  return messages
}
