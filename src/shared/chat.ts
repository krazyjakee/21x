import type { ChatImageInput } from './chat-images'

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
 * `ChatToolCall` from the preceding assistant message. A user message may
 * carry images (#144); each provider turns them into its own image blocks.
 */
export type ChatMessage =
  | { role: 'user'; content: string; images?: ChatImageInput[] }
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
  /** Prompt tokens billed at the normal rate (for Anthropic, excluding cache reads and writes). */
  inputTokens: number
  outputTokens: number
  /** Prompt tokens served from the provider's prompt cache (Anthropic `cache_read_input_tokens`). */
  cacheReadTokens?: number
  /** Prompt tokens written to the provider's prompt cache (Anthropic `cache_creation_input_tokens`). */
  cacheWriteTokens?: number
  /**
   * Turn totals only (set by ChatRuntime): model calls made, and how many of
   * them reported usage. A provider that reports nothing (or zeros) leaves
   * `reportedCalls` at 0, and the figures above are then meaningless.
   */
  modelCalls?: number
  reportedCalls?: number
  /**
   * Turn totals only: the full prompt size of the last model call that
   * reported usage (input + cache reads + cache writes), i.e. what the model
   * had in context. Absent when no call reported.
   */
  lastPromptTokens?: number
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
  agentId: 'chat_agent_id',
  provider: 'chat_provider',
  model: 'chat_model',
  baseUrl: 'chat_base_url',
  reasoningEffort: 'chat_reasoning_effort'
} as const

export type ChatProviderId = 'anthropic' | 'openai-compatible'

export const CHAT_PROVIDER_IDS: readonly ChatProviderId[] = ['anthropic', 'openai-compatible']

export function isChatProviderId(value: unknown): value is ChatProviderId {
  return typeof value === 'string' && (CHAT_PROVIDER_IDS as readonly string[]).includes(value)
}

/** The thinking controls supported by the chat transports. */
export type ChatReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const CHAT_REASONING_EFFORTS: readonly ChatReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function isChatReasoningEffort(value: unknown): value is ChatReasoningEffort {
  return typeof value === 'string' && (CHAT_REASONING_EFFORTS as readonly string[]).includes(value)
}

/**
 * The chat transport a configured agent's model should use. Any agent that
 * saved a model is a Commander option — the coding backend decides how the
 * agent executes tasks, not which models the Commander may chat with. Claude
 * Code agents serve Anthropic models; other backends (Codex, Pi, Cursor,
 * OpenCode) route by model name: Claude models over the Anthropic transport,
 * everything else over an OpenAI-compatible endpoint.
 */
export function chatProviderForAgentModel(
  codingAgent: string | undefined,
  model: string | undefined
): ChatProviderId | null {
  const trimmed = model?.trim()
  if (!trimmed) return null
  const name = trimmed.toLowerCase()
  if (codingAgent === 'claude-code' || name.startsWith('claude') || name.includes('/claude')) {
    return 'anthropic'
  }
  return 'openai-compatible'
}
