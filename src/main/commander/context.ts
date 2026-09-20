import type { ChatMessage } from '../../shared/chat'
import { MAX_CHAT_IMAGE_TOTAL_BYTES, type ChatImageInput } from '../../shared/chat-images'
import type { CommanderMessage } from '../../shared/commander'

/**
 * Turning a stored Commander session into model context (docs/commander.md).
 *
 * A turn starts at a `user` or `report` message and runs until the next one.
 * The newest turns go to the model verbatim; older ones are folded into one
 * rolling `summary` message written by the chat model. Folding and trimming
 * always cut on turn boundaries, so an assistant tool call is never separated
 * from its results.
 *
 * Turns are never dropped silently. Turns past the budget that no summary
 * covers yet (the fold failed, or has not run) stay verbatim up to
 * PENDING_FOLD_CHAR_FACTOR × maxChars; any left out beyond that are replaced
 * by a visible "N earlier turns omitted (summary pending)" marker.
 */

export interface ContextBudget {
  /** Newest turns sent verbatim. */
  keepTurns: number
  /** Soft character ceiling for the verbatim turns (the newest turn is always kept). */
  maxChars: number
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = { keepTurns: 8, maxChars: 24_000 }

const TOOL_TEXT_IN_SUMMARY = 600
export const MAX_SUMMARY_TRANSCRIPT_CHARS = 32_000

/**
 * While turns wait to be folded, the verbatim part may grow to this multiple
 * of `maxChars` (ignoring `keepTurns`) rather than lose them. It bounds the
 * context when folding keeps failing.
 */
export const PENDING_FOLD_CHAR_FACTOR = 2

/** The marker standing in for turns left out of the context without a summary. */
export function omittedTurnsMarker(count: number): string {
  return `${count} earlier ${count === 1 ? 'turn' : 'turns'} omitted (summary pending)`
}

/**
 * Image bytes resent with the history, newest first (#144). The newest
 * message's images always fit (it is capped at the same total); older images
 * past the budget are named in text instead, so one request stays well below
 * the providers' request-size limits.
 */
export const MAX_CONTEXT_IMAGE_BYTES = MAX_CHAT_IMAGE_TOTAL_BYTES

/** Loads a stored message's image bytes. */
export type CommanderImageLoader = (messageId: string) => ChatImageInput[]

function imageNote(names: string[]): string {
  return `[Earlier image${names.length === 1 ? '' : 's'} no longer attached: ${names.join(', ')}]`
}

/** Ids of the user messages whose images are resent, newest first within the budget. */
function messagesWithImagesInBudget(messages: CommanderMessage[]): Set<string> {
  const kept = new Set<string>()
  let bytes = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const images = messages[i].images
    if (messages[i].role !== 'user' || !images?.length) continue
    const size = images.reduce((sum, image) => sum + image.size, 0)
    if (bytes + size > MAX_CONTEXT_IMAGE_BYTES) break
    bytes += size
    kept.add(messages[i].id)
  }
  return kept
}

function startsTurn(message: CommanderMessage): boolean {
  return message.role === 'user' || message.role === 'report'
}

function messageChars(message: CommanderMessage): number {
  return message.content.length + (message.tool_calls ? JSON.stringify(message.tool_calls).length : 0)
}

/** The newest summary, or null. */
export function latestSummary(messages: CommanderMessage[]): CommanderMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'summary') return messages[i]
  return null
}

/**
 * The messages the latest summary does not cover, without summaries. A
 * summary's `correlation_id` is the id of the last message it folds in.
 */
export function unfoldedMessages(messages: CommanderMessage[]): { summary: CommanderMessage | null; rest: CommanderMessage[] } {
  const summary = latestSummary(messages)
  const conversation = messages.filter((m) => m.role !== 'summary')
  if (!summary?.correlation_id) return { summary, rest: conversation }
  const cut = conversation.findIndex((m) => m.id === summary.correlation_id)
  return { summary, rest: cut === -1 ? conversation : conversation.slice(cut + 1) }
}

export function splitTurns(messages: CommanderMessage[]): CommanderMessage[][] {
  const turns: CommanderMessage[][] = []
  for (const message of messages) {
    if (message.role === 'summary') continue
    if (turns.length === 0 || startsTurn(message)) turns.push([message])
    else turns[turns.length - 1].push(message)
  }
  return turns
}

/** How many of the newest turns fit the budget (at least one). */
function keptTurnCount(turns: CommanderMessage[][], budget: ContextBudget): number {
  let kept = 0
  let chars = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const size = turns[i].reduce((sum, m) => sum + messageChars(m), 0)
    if (kept > 0 && (kept >= budget.keepTurns || chars + size > budget.maxChars)) break
    kept++
    chars += size
  }
  return kept
}

function reportText(message: CommanderMessage): string {
  const from = message.project_id ? `project ${message.project_id}` : 'a project'
  return `[Report from ${from}]\n${message.content}`
}

/**
 * Provider-neutral history for the model. Reports become user-side notes;
 * adjacent user-side messages are merged; empty assistant messages (a turn
 * cancelled before any text) are dropped; the history never starts with an
 * assistant or tool message.
 */
export function toChatMessages(messages: CommanderMessage[], loadImages?: CommanderImageLoader): ChatMessage[] {
  const out: ChatMessage[] = []
  const withImages = loadImages ? messagesWithImagesInBudget(messages) : new Set<string>()
  for (const message of messages) {
    if (message.role === 'summary') continue
    if (message.role === 'user' || message.role === 'report') {
      let text = message.role === 'report' ? reportText(message) : message.content
      let images: ChatImageInput[] = []
      if (message.role === 'user' && message.images?.length) {
        if (withImages.has(message.id)) images = loadImages?.(message.id) ?? []
        if (images.length === 0) text = [text, imageNote(message.images.map((image) => image.name))].filter(Boolean).join('\n')
      }
      const previous = out[out.length - 1]
      if (previous && previous.role === 'user') {
        previous.content = [previous.content, text].filter(Boolean).join('\n\n')
        if (images.length > 0) previous.images = [...(previous.images ?? []), ...images]
      } else {
        out.push({ role: 'user', content: text, ...(images.length > 0 ? { images } : {}) })
      }
      continue
    }
    if (out.length === 0) continue
    if (message.role === 'assistant') {
      const toolCalls = message.tool_calls ?? []
      if (!message.content && toolCalls.length === 0) continue
      out.push({ role: 'assistant', content: message.content, ...(toolCalls.length > 0 ? { toolCalls } : {}) })
    } else if (message.role === 'tool') {
      if (!message.tool_call_id) continue
      out.push({
        role: 'tool',
        toolCallId: message.tool_call_id,
        name: message.tool_name ?? 'tool',
        content: message.content,
        isError: message.is_error
      })
    }
  }
  return out
}

export interface BuiltContext {
  summary: string | null
  messages: ChatMessage[]
  /** Turns not covered by the summary that are left out of `messages`; the first message then carries the omitted-turns marker. */
  droppedTurns: number
  /** Turns past the budget kept verbatim because no summary covers them yet. */
  pendingFoldTurns: number
}

/**
 * The context for the next model call: latest summary + newest turns within
 * budget, plus any unsummarised turns past the budget (see
 * PENDING_FOLD_CHAR_FACTOR). Turns still left out are named by a marker at the
 * start of the history.
 */
export function buildContext(
  messages: CommanderMessage[],
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
  loadImages?: CommanderImageLoader
): BuiltContext {
  const { summary, rest } = unfoldedMessages(messages)
  const turns = splitTurns(rest)
  const withinBudget = keptTurnCount(turns, budget)
  const kept = Math.max(
    withinBudget,
    keptTurnCount(turns, { keepTurns: Number.POSITIVE_INFINITY, maxChars: budget.maxChars * PENDING_FOLD_CHAR_FACTOR })
  )
  const droppedTurns = turns.length - kept
  const history = toChatMessages(turns.slice(turns.length - kept).flat(), loadImages)
  if (droppedTurns > 0 && history[0]?.role === 'user') {
    history[0] = { ...history[0], content: `[${omittedTurnsMarker(droppedTurns)}]\n\n${history[0].content}` }
  }
  return {
    summary: summary?.content ?? null,
    messages: history,
    droppedTurns,
    pendingFoldTurns: kept - withinBudget
  }
}

export interface FoldPlan {
  previousSummary: string | null
  /** Oldest unfolded turns, to be merged into the summary. */
  toFold: CommanderMessage[]
  /** The id the new summary's `correlation_id` must point at. */
  lastFoldedId: string
}

/** What to fold so the verbatim part fits the budget again, or null when it already does. */
export function planFold(messages: CommanderMessage[], budget: ContextBudget = DEFAULT_CONTEXT_BUDGET): FoldPlan | null {
  const { summary, rest } = unfoldedMessages(messages)
  const turns = splitTurns(rest)
  const kept = keptTurnCount(turns, budget)
  if (kept >= turns.length) return null
  // Catch up a failed fold in bounded oldest-first batches. Never advance
  // correlation_id past turns that were not included in this request.
  const toFold: CommanderMessage[] = []
  let chars = 0
  for (const turn of turns.slice(0, turns.length - kept)) {
    const size = transcriptForSummary(turn).length + 1
    if (toFold.length > 0 && chars + size > MAX_SUMMARY_TRANSCRIPT_CHARS) break
    toFold.push(...turn)
    chars += size
  }
  return { previousSummary: summary?.content ?? null, toFold, lastFoldedId: toFold[toFold.length - 1].id }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** A plain-text transcript of messages for the summariser. */
export function transcriptForSummary(messages: CommanderMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const images = m.images?.length ? ` [attached image${m.images.length === 1 ? '' : 's'}: ${m.images.map((i) => i.name).join(', ')}]` : ''
      lines.push(`User: ${m.content}${images}`)
    }
    else if (m.role === 'report') lines.push(`Report from ${m.project_id ? `project ${m.project_id}` : 'a project'}: ${m.content}`)
    else if (m.role === 'assistant') {
      if (m.content) lines.push(`Commander: ${m.content}`)
      for (const call of m.tool_calls ?? []) lines.push(`Commander called ${call.name}(${clip(JSON.stringify(call.input), TOOL_TEXT_IN_SUMMARY)})`)
    } else if (m.role === 'tool') {
      lines.push(`${m.tool_name ?? 'Tool'} ${m.is_error ? 'failed' : 'returned'}: ${clip(m.content, TOOL_TEXT_IN_SUMMARY)}`)
    }
  }
  return lines.join('\n')
}
