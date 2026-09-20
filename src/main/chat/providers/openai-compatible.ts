import type { ChatMessage, ChatReasoningEffort } from '../../../shared/chat'
import {
  ChatAbortError,
  type ChatProvider,
  type ChatProviderEvent,
  type ChatProviderRequest,
  type ChatProviderStopReason,
  type FetchLike
} from './types'

/**
 * Speaks the `chat/completions` streaming wire format over plain fetch, so it
 * covers OpenAI itself and every local or hosted server that mimics it
 * (Ollama, LM Studio, vLLM, OpenRouter, ...). No SDK: the format is small and
 * a dependency would only add a second HTTP stack to the main process.
 */

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_OPENAI_CHAT_MODEL = 'gpt-4o-mini'

const DEFAULT_MAX_TOKENS = 4096

export interface OpenAICompatibleChatProviderOptions {
  model?: string
  /**
   * Model identifier sent to the API; defaults to `model`. Selections in
   * `vendor/model` shape keep the full string for display but must send the
   * vendor-local id (e.g. `gpt-oss-120b`, not `cerebras/gpt-oss-120b`).
   */
  modelId?: string
  /** Root of the API, e.g. `http://localhost:11434/v1`. Trailing slash optional. */
  baseUrl?: string
  /** Optional: local servers usually need none. */
  apiKey?: string
  maxTokens?: number
  /** Sent as `reasoning_effort` when explicitly selected. */
  reasoningEffort?: ChatReasoningEffort
  fetch?: FetchLike
}

/* Wire shapes: only the fields we read. */
interface WireToolCallDelta {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}
interface WireChunk {
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: WireToolCallDelta[] }
    finish_reason?: string | null
  }>
  error?: { message?: string } | string
}

type WireUserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

type WireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | WireUserContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string }

function toWireMessages(system: string | undefined, messages: ChatMessage[]): WireMessage[] {
  const out: WireMessage[] = []
  if (system) out.push({ role: 'system', content: system })
  for (const message of messages) {
    if (message.role === 'user') {
      if (message.images?.length) {
        const parts: WireUserContentPart[] = []
        if (message.content) parts.push({ type: 'text', text: message.content })
        for (const image of message.images) {
          parts.push({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } })
        }
        out.push({ role: 'user', content: parts })
      } else {
        out.push({ role: 'user', content: message.content })
      }
    } else if (message.role === 'assistant') {
      const toolCalls = (message.toolCalls ?? []).map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: JSON.stringify(call.input) }
      }))
      if (!message.content && toolCalls.length === 0) continue
      out.push({
        role: 'assistant',
        content: message.content || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
      })
    } else {
      // The format has no error flag on tool results; say it in the text.
      const content = message.isError ? `Error: ${message.content}` : message.content
      out.push({ role: 'tool', tool_call_id: message.toolCallId, content })
    }
  }
  return out
}

function toStopReason(reason: string | null | undefined, sawToolCalls: boolean): ChatProviderStopReason {
  if (reason === 'tool_calls' || (sawToolCalls && (reason == null || reason === 'stop'))) return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  if (reason === 'stop' || reason == null) return 'end_turn'
  return 'other'
}

/** Yields the `data:` payloads of an SSE body, one complete event at a time. */
async function* sseData(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const onAbort = (): void => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', onAbort, { once: true })
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary: number
      // Events are separated by a blank line; tolerate CRLF from some servers.
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '')
        const data = raw
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data) yield data
      }
    }
    const tail = buffer.trim()
    if (tail.startsWith('data:')) yield tail.slice(5).trimStart()
  } finally {
    signal.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}

export class OpenAICompatibleChatProvider implements ChatProvider {
  readonly id = 'openai-compatible'
  /** The wire format takes images; whether the model can see them is the server's call, and its error reaches the user. */
  readonly supportsImages = true
  readonly model: string
  readonly baseUrl: string
  private readonly modelId: string
  private readonly apiKey: string | undefined
  private readonly maxTokens: number
  private readonly reasoningEffort: ChatReasoningEffort | undefined
  private readonly fetchImpl: FetchLike

  constructor(options: OpenAICompatibleChatProviderOptions = {}) {
    this.model = options.model || DEFAULT_OPENAI_CHAT_MODEL
    this.modelId = options.modelId || this.model
    this.baseUrl = (options.baseUrl || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '')
    this.apiKey = options.apiKey || undefined
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
    this.reasoningEffort = options.reasoningEffort
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
    if (!this.apiKey && this.baseUrl === DEFAULT_OPENAI_BASE_URL) {
      throw new Error('OpenAI API key is required for the chat runtime (or set a local chat_base_url)')
    }
  }

  async *stream(request: ChatProviderRequest, signal: AbortSignal): AsyncIterable<ChatProviderEvent> {
    if (signal.aborted) throw new ChatAbortError()
    const tools = request.tools.map((tool) => ({
      type: 'function' as const,
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
    }))
    const body = {
      model: this.modelId,
      messages: toWireMessages(request.system, request.messages),
      stream: true,
      max_tokens: request.maxTokens ?? this.maxTokens,
      ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
      ...(tools.length > 0 ? { tools, tool_choice: request.toolChoice } : {})
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' }
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`

    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal
      })
    } catch (err) {
      if (signal.aborted) throw new ChatAbortError()
      throw err
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Chat request failed (${response.status}): ${text.slice(0, 300) || response.statusText}`)
    }
    if (!response.body) throw new Error('Chat response had no body')

    // Tool-call arguments stream as fragments keyed by index; assemble, then parse once.
    const calls = new Map<number, { id: string; name: string; args: string }>()
    let finishReason: string | null | undefined
    let inputTokens = 0
    let outputTokens = 0

    try {
      for await (const data of sseData(response.body, signal)) {
        if (data === '[DONE]') break
        let chunk: WireChunk
        try {
          chunk = JSON.parse(data) as WireChunk
        } catch {
          continue // Keep-alive comments or partial garbage from a lenient server.
        }
        if (chunk.error) {
          throw new Error(typeof chunk.error === 'string' ? chunk.error : chunk.error.message || 'Chat provider error')
        }
        const usage = (chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
        if (usage) {
          inputTokens = usage.prompt_tokens ?? inputTokens
          outputTokens = usage.completion_tokens ?? outputTokens
        }
        const choice = chunk.choices?.[0]
        if (!choice) continue
        if (choice.delta?.content) yield { type: 'text_delta', text: choice.delta.content }
        for (const delta of choice.delta?.tool_calls ?? []) {
          const index = delta.index ?? 0
          let call = calls.get(index)
          if (!call) {
            call = { id: delta.id || `call_${index}`, name: '', args: '' }
            calls.set(index, call)
          }
          if (delta.id) call.id = delta.id
          if (delta.function?.name) call.name += delta.function.name
          if (delta.function?.arguments) call.args += delta.function.arguments
        }
        if (choice.finish_reason) finishReason = choice.finish_reason
      }
    } catch (err) {
      if (signal.aborted) throw new ChatAbortError()
      throw err
    }
    if (signal.aborted) throw new ChatAbortError()

    for (const [, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      let input: Record<string, unknown> = {}
      if (call.args.trim()) {
        try {
          const parsed: unknown = JSON.parse(call.args)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>
        } catch {
          // Leave the tool to report bad input; the model sees the error and can retry.
          input = { __invalid_json__: call.args }
        }
      }
      yield { type: 'tool_call', id: call.id, name: call.name, input }
    }
    yield {
      type: 'message_end',
      stopReason: toStopReason(finishReason, calls.size > 0),
      ...(inputTokens || outputTokens ? { usage: { inputTokens, outputTokens } } : {})
    }
  }
}
