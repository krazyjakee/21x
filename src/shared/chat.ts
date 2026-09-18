/**
 * Wire types for the lightweight chat runtime (docs/chat-runtime.md).
 *
 * These are the shapes that cross IPC between the main-process ChatRuntime and
 * the renderer, and the provider-neutral message model the runtime keeps. They
 * deliberately know nothing about any vendor's API: each provider translates
 * to and from its own format inside src/main/chat/providers.
 */

/** One tool invocation requested by the model. */
export interface ChatToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

/**
 * Provider-neutral conversation history. A `tool` message answers exactly one
 * `ChatToolCall` from the preceding assistant message.
 */
export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ChatToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean }

/** Why a turn ended. */
export type ChatStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'cancelled'
  | 'tool_limit'
  | 'error'

export interface ChatUsage {
  inputTokens: number
  outputTokens: number
}

/** Events the runtime emits while a turn runs, in order. */
export type ChatRuntimeEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_start'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_call_result'; id: string; name: string; content: string; isError: boolean }
  | { type: 'done'; stopReason: ChatStopReason; messages: ChatMessage[]; usage: ChatUsage }
  | { type: 'error'; message: string }

/** What the renderer sends to `chat:start`. */
export interface ChatStartRequest {
  /** Full history including the newest user message. */
  messages: ChatMessage[]
  system?: string
  /** Overrides the default per-turn tool-call limit (never raises it above the runtime cap). */
  maxToolCalls?: number
}

/** Every `chat:event` message carries the turn it belongs to. */
export interface ChatIpcEvent {
  turnId: string
  event: ChatRuntimeEvent
}

/** Settings keys read by the provider factory. Keys themselves never hold secrets. */
export const CHAT_SETTING_KEYS = {
  provider: 'chat_provider',
  model: 'chat_model',
  baseUrl: 'chat_base_url'
} as const

export type ChatProviderId = 'anthropic' | 'openai-compatible'

export const CHAT_PROVIDER_IDS: readonly ChatProviderId[] = ['anthropic', 'openai-compatible']

export function isChatProviderId(value: unknown): value is ChatProviderId {
  return typeof value === 'string' && (CHAT_PROVIDER_IDS as readonly string[]).includes(value)
}
