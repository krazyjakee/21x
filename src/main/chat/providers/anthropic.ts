import Anthropic from '@anthropic-ai/sdk'
import type { ChatMessage, ChatReasoningEffort } from '../../../shared/chat'
import {
  ChatAbortError,
  type ChatProvider,
  type ChatProviderEvent,
  type ChatProviderRequest,
  type ChatProviderStopReason,
  type FetchLike
} from './types'

/** A fast, cheap model: the runtime exists for live conversation, not deep work. */
export const DEFAULT_ANTHROPIC_CHAT_MODEL = 'claude-haiku-4-5-20251001'

const DEFAULT_MAX_TOKENS = 4096

export interface AnthropicChatProviderOptions {
  apiKey: string
  model?: string
  /** Model identifier sent to the API; defaults to `model` (see OpenAICompatibleChatProviderOptions). */
  modelId?: string
  /** Only for proxies; the SDK's default is the Anthropic API. */
  baseUrl?: string
  maxTokens?: number
  /** Claude's adaptive thinking level, matching the Claude Code effort control. */
  reasoningEffort?: Exclude<ChatReasoningEffort, 'minimal'>
  /** Injected transport for tests. */
  fetch?: FetchLike
}

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      if (message.images?.length) {
        const content: Anthropic.ContentBlockParam[] = message.images.map((image) => ({
          type: 'image',
          source: { type: 'base64', media_type: image.mimeType, data: image.data }
        }))
        if (message.content) content.push({ type: 'text', text: message.content })
        out.push({ role: 'user', content })
      } else {
        out.push({ role: 'user', content: message.content })
      }
    } else if (message.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = []
      if (message.content) content.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
      }
      // The API rejects an empty assistant turn; a cancelled turn can produce one.
      if (content.length === 0) continue
      out.push({ role: 'assistant', content })
    } else {
      const block: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content,
        ...(message.isError ? { is_error: true } : {})
      }
      // Results for parallel tool calls must share one user message.
      const previous = out[out.length - 1]
      if (previous && previous.role === 'user' && Array.isArray(previous.content) &&
          previous.content.every((b) => b.type === 'tool_result')) {
        previous.content.push(block)
      } else {
        out.push({ role: 'user', content: [block] })
      }
    }
  }
  return out
}

function toStopReason(reason: Anthropic.Message['stop_reason']): ChatProviderStopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn'
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'max_tokens'
    default:
      return 'other'
  }
}

export class AnthropicChatProvider implements ChatProvider {
  readonly id = 'anthropic'
  readonly supportsImages = true
  readonly model: string
  private readonly modelId: string
  private readonly client: Anthropic
  private readonly maxTokens: number
  private readonly reasoningEffort: Exclude<ChatReasoningEffort, 'minimal'> | undefined

  constructor(options: AnthropicChatProviderOptions) {
    if (!options.apiKey) throw new Error('Anthropic API key is required for the chat runtime')
    this.model = options.model || DEFAULT_ANTHROPIC_CHAT_MODEL
    this.modelId = options.modelId || this.model
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
    this.reasoningEffort = options.reasoningEffort
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {})
    })
  }

  async *stream(request: ChatProviderRequest, signal: AbortSignal): AsyncIterable<ChatProviderEvent> {
    if (signal.aborted) throw new ChatAbortError()
    const tools: Anthropic.Tool[] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema
    }))

    const stream = this.client.messages.stream(
      {
        model: this.modelId,
        max_tokens: request.maxTokens ?? this.maxTokens,
        ...(request.system ? { system: request.system } : {}),
        messages: toAnthropicMessages(request.messages),
        ...(this.reasoningEffort ? { output_config: { effort: this.reasoningEffort } } : {}),
        ...(tools.length > 0
          ? { tools, tool_choice: request.toolChoice === 'none' ? { type: 'none' as const } : { type: 'auto' as const } }
          : {})
      },
      { signal }
    )

    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text_delta', text: event.delta.text }
        }
      }
      // finalMessage() carries the SDK-parsed tool inputs and the stop reason.
      const message = await stream.finalMessage()
      // The SDK can end iteration quietly on abort; never report a cut-off turn as complete.
      if (signal.aborted) throw new ChatAbortError()
      for (const block of message.content) {
        if (block.type !== 'tool_use') continue
        const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {}
        yield { type: 'tool_call', id: block.id, name: block.name, input }
      }
      yield {
        type: 'message_end',
        stopReason: toStopReason(message.stop_reason),
        usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens }
      }
    } catch (err) {
      if (signal.aborted || err instanceof Anthropic.APIUserAbortError) throw new ChatAbortError()
      throw err
    }
  }
}
