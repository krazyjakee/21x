import { createHash } from 'crypto'
import { MessagePartType, MessageRole, type SessionMessage } from '../adapters/coding-agent-adapter'

// Dedup structures (seenMessageIds, seenPartIds, partContentLengths) grow by
// 1-4+ entries per poll cycle per session. Unbounded, they exhausted the heap
// (~2.9 GB) in long sessions.
const MAX_DEDUP_ENTRIES = 5_000
// Also bound the total size of partContentLengths values: tool outputs can be
// huge. ~10MB per session (100MB let one session take most of the V8 heap).
const MAX_VALUE_CHARS_PER_SESSION = 10_000_000
const ERROR_TEXT_DEDUPE_WINDOW_MS = 5_000
const MIN_ASSISTANT_REPLAY_DEDUPE_CHARS = 40

interface DedupState {
  seenMessageIds: Set<string>
  seenPartIds: Set<string>
  partContentLengths: Map<string, string>
  assistantTextKeys: Set<string>
}

function deleteOldest<T>(items: Set<T> | Map<T, unknown>, count: number): void {
  let remaining = count
  for (const key of items.keys()) {
    if (remaining-- <= 0) break
    items.delete(key)
  }
}

/**
 * Prunes dedup structures past MAX_DEDUP_ENTRIES down to half, so they do not
 * regrow immediately. Sets and Maps keep insertion order, so the oldest entries
 * go first. partContentLengths is also pruned by 50% once its values exceed
 * MAX_VALUE_CHARS_PER_SESSION (10% barely freed memory with large tool outputs).
 */
export function pruneDedup(state: Omit<DedupState, 'assistantTextKeys'> & { assistantTextKeys?: Set<string> }): void {
  const { seenMessageIds, seenPartIds, partContentLengths, assistantTextKeys } = state
  const pruneToSize = Math.floor(MAX_DEDUP_ENTRIES / 2)
  for (const ids of [seenMessageIds, seenPartIds, assistantTextKeys]) {
    if (ids && ids.size > MAX_DEDUP_ENTRIES) deleteOldest(ids, ids.size - pruneToSize)
  }

  let totalChars = 0
  for (const val of partContentLengths.values()) totalChars += val.length
  if (partContentLengths.size > MAX_DEDUP_ENTRIES) {
    deleteOldest(partContentLengths, partContentLengths.size - pruneToSize)
  } else if (totalChars > MAX_VALUE_CHARS_PER_SESSION) {
    deleteOldest(partContentLengths, Math.ceil(partContentLengths.size * 0.5))
  }
}

/**
 * Content key for assistant text/reasoning parts long enough to dedupe safely.
 * Codex reports a message's live delta and its finalized item under different
 * part ids (#427); the key lets the second copy be recognised. A digest, not
 * the text: a streamed part adds a key per growth step, and storing each
 * step's full text grew quadratically with the message length.
 */
export function assistantTextKey(
  role: string | undefined,
  partType: string | undefined,
  content: string,
  tool?: unknown,
  taskProgress?: unknown
): string | null {
  if (role !== MessageRole.ASSISTANT && role !== 'assistant') return null
  if (tool || taskProgress) return null
  if (partType && partType !== MessagePartType.TEXT && partType !== MessagePartType.REASONING && partType !== 'text' && partType !== 'reasoning') {
    return null
  }
  const normalized = (content || '').replace(/\s+/g, ' ').trim()
  if (normalized.length < MIN_ASSISTANT_REPLAY_DEDUPE_CHARS) return null
  return createHash('sha1').update(normalized).digest('base64')
}

function normalizeErrorText(value?: string): string {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** True when a recent error/retry part in the batch already carries this error text. */
export function hasMatchingErrorMessage(
  messages: Array<{ content: string; partType?: string; receivedAt?: number }>,
  errorMessage?: string
): boolean {
  const normalizedError = normalizeErrorText(errorMessage)
  if (!normalizedError) return false

  const now = Date.now()
  return messages.some((message) => {
    if (message.partType !== 'error' && message.partType !== 'retry') return false
    if (message.receivedAt && now - message.receivedAt > ERROR_TEXT_DEDUPE_WINDOW_MS) return false
    return normalizeErrorText(message.content) === normalizedError
  })
}

/** Dedup state for a resumed session, so polling won't re-emit its history. */
export function dedupStateFromHistory(messages: SessionMessage[]): DedupState {
  const state: DedupState = {
    seenMessageIds: new Set(),
    seenPartIds: new Set(),
    partContentLengths: new Map(),
    assistantTextKeys: new Set()
  }
  for (const message of messages) {
    if (message.id) state.seenMessageIds.add(message.id)
    for (const part of message.parts) {
      const partId = part.id || `${message.role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const content = part.content || part.text || ''
      state.seenPartIds.add(partId)
      if (content) state.partContentLengths.set(partId, String(content.length))
      const key = assistantTextKey(message.role, part.type, content, part.tool, part.taskProgress)
      if (key) state.assistantTextKeys.add(key)
    }
  }
  return state
}
