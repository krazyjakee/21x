import type { ChatMessage, ChatUsage } from '../../../shared/chat'
import type { ChatToolInputSchema } from '../tools'

/** What a provider needs to know about a tool: the schema only, never the handler. */
export interface ChatProviderTool {
  name: string
  description: string
  inputSchema: ChatToolInputSchema
}

export interface ChatProviderRequest {
  system?: string
  messages: ChatMessage[]
  tools: ChatProviderTool[]
  /** `none` forces a text answer (used after the tool-call limit is hit). */
  toolChoice: 'auto' | 'none'
  maxTokens?: number
}

/** Why the model stopped, in provider-neutral terms. */
export type ChatProviderStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'other'

/**
 * Normalized streaming events. `text_delta` arrives as tokens are generated;
 * `tool_call` is emitted once the call's input is complete (inputs are parsed
 * JSON, never partial); `message_end` is always last.
 */
export type ChatProviderEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'message_end'; stopReason: ChatProviderStopReason; usage?: ChatUsage }

/**
 * A text-in, text-out model transport.
 *
 * Realtime/voice seam (issue #64): a realtime provider would implement this same
 * interface for the text path and additionally expose a bidirectional session
 * (audio in, `audio_delta` events out) on a separate `RealtimeChatProvider`
 * interface that extends this one. The runtime's loop only depends on the
 * events above, so it keeps working unchanged for the text half of such a
 * provider.
 */
export interface ChatProvider {
  readonly id: string
  readonly model: string
  /** One model call. Ends after `message_end`; throws on transport failure or abort. */
  stream(request: ChatProviderRequest, signal: AbortSignal): AsyncIterable<ChatProviderEvent>
}

/** Matches the global `fetch` and the SDK's `Fetch` option; injectable for tests. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Thrown by providers when the caller's signal fired. The runtime maps it to `cancelled`. */
export class ChatAbortError extends Error {
  constructor() {
    super('Chat turn cancelled')
    this.name = 'ChatAbortError'
  }
}

export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (err instanceof ChatAbortError) return true
  return err instanceof Error && err.name === 'AbortError'
}
