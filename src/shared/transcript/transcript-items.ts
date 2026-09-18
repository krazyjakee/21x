import type { AgentMessage, AgentTodo } from './types'
import { isCompactActivityMessage } from './tool-format'

export type TranscriptItem =
  | { type: 'message'; key: string; message: AgentMessage }
  | { type: 'activity'; key: string; messages: AgentMessage[] }

/** Groups consecutive tool/reasoning messages into single activity rows. */
export function buildTranscriptItems(messages: AgentMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (!isCompactActivityMessage(message)) {
      items.push({ type: 'message', key: message.id, message })
      continue
    }

    const group: AgentMessage[] = [message]
    while (index + 1 < messages.length && isCompactActivityMessage(messages[index + 1])) {
      index += 1
      group.push(messages[index])
    }
    // Key on the first member only: the trailing group grows as the agent
    // streams tool calls, and a key built from all member ids would change on
    // every addition — remounting the whole group (losing expanded state) and
    // forcing the virtualizer to re-measure the row from scratch.
    items.push({ type: 'activity', key: group[0].id, messages: group })
  }
  return items
}

function collectSearchableText(value: unknown, output: string[]): void {
  if (value == null) return
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    output.push(String(value))
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectSearchableText(item, output))
    return
  }
  if (typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => collectSearchableText(item, output))
  }
}

// Search runs over the whole transcript on every keystroke AND every streamed
// delta, and serializing large tool payloads each time allocates megabytes.
// Message objects are identity-stable per part (projection cache), so a
// WeakMap makes this compute-once-per-message.
const messageSearchTextCache = new WeakMap<AgentMessage, string>()

function getMessageSearchText(message: AgentMessage): string {
  const cached = messageSearchTextCache.get(message)
  if (cached !== undefined) return cached
  const parts: string[] = []
  collectSearchableText(message.role, parts)
  collectSearchableText(message.partType, parts)
  collectSearchableText(message.content, parts)
  collectSearchableText(message.tool, parts)
  collectSearchableText(message.taskProgress, parts)
  const text = parts.join('\n').toLowerCase()
  messageSearchTextCache.set(message, text)
  return text
}

function itemMessages(item: TranscriptItem): AgentMessage[] {
  return item.type === 'activity' ? item.messages : [item.message]
}

/** Indexes of items matching an already trimmed + lowercased query. */
export function findTranscriptMatches(items: TranscriptItem[], normalizedQuery: string): number[] {
  if (!normalizedQuery) return []
  const matches: number[] = []
  items.forEach((item, index) => {
    if (itemMessages(item).map(getMessageSearchText).join('\n').includes(normalizedQuery)) matches.push(index)
  })
  return matches
}

export function getTranscriptItemContentLength(item: TranscriptItem | undefined): number {
  if (!item) return 0
  return itemMessages(item).reduce(
    (total, message) => total + (typeof message.content === 'string' ? message.content.length : 0),
    0
  )
}

/** The latest question, if the user has not replied since it was asked. */
export function findActiveQuestionId(messages: AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'user') return null
    if (message.partType === 'question' && message.tool?.questions) return message.id
  }
  return null
}

/** Todos from the latest todowrite message, pinned above the transcript. */
export function findLatestTodos(messages: AgentMessage[]): AgentTodo[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const todos = messages[i].tool?.todos
    if (messages[i].partType === 'todowrite' && todos?.length) return todos
  }
  return null
}
