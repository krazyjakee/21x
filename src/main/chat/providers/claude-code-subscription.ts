import { randomUUID } from 'crypto'
import type { ChatUsage } from '../../../shared/chat'
import { findClaudeExecutable } from '../../adapters/claude-code-executable'
import { ChatAbortError, type ChatProvider, type ChatProviderEvent, type ChatProviderRequest } from './types'
import { extractPromptImages, PROMPT_IMAGE_NOTE } from './prompt-images'
import type { ChatImageInput } from '../../../shared/chat-images'

/**
 * Commander transport for a Claude Code agent that authenticates with the
 * user's Claude subscription rather than an Anthropic API key.
 *
 * Claude Code owns authentication. Commander still owns its tools: this
 * transport asks for one structured response (text and/or tool calls), then
 * ChatRuntime executes the calls with the same validation, confirmation and
 * limits used by the direct HTTP providers. A later provider call includes
 * those tool results and produces the final answer.
 */

interface StructuredToolCall {
  id?: string
  name?: string
  input?: unknown
}

interface StructuredReply {
  response?: unknown
  tool_calls?: unknown
}

interface SdkUsage {
  input_tokens?: number
  output_tokens?: number
}

interface SdkResult {
  type: string
  subtype?: string
  is_error?: boolean
  result?: string
  structured_output?: unknown
  errors?: string[]
  usage?: SdkUsage
}

interface SdkQuery extends AsyncIterable<SdkResult> {
  close?: () => void
}

/** One streamed user message: how the SDK takes images alongside the prompt text. */
export interface SdkUserMessage {
  type: 'user'
  message: { role: 'user'; content: Array<Record<string, unknown>> }
  parent_tool_use_id: null
}

type SdkPrompt = string | AsyncIterable<SdkUserMessage>

type SdkQueryFunction = (input: { prompt: SdkPrompt; options: Record<string, unknown> }) => SdkQuery

export interface ClaudeCodeSubscriptionProviderOptions {
  model: string
  reasoningEffort?: string
  query?: SdkQueryFunction
  findExecutable?: () => Promise<string>
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    response: { type: 'string' },
    tool_calls: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          input: { type: 'object' }
        },
        required: ['name', 'input'],
        additionalProperties: false
      }
    }
  },
  required: ['response', 'tool_calls'],
  additionalProperties: false
} as const

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseReply(result: SdkResult): StructuredReply {
  const structured = asObject(result.structured_output)
  if (structured) return structured
  if (typeof result.result === 'string') {
    try {
      const parsed = asObject(JSON.parse(result.result))
      if (parsed) return parsed
    } catch {
      // Older Claude Code versions can return the final text without the
      // structured_output attachment. Treat it as a normal answer.
    }
    return { response: result.result, tool_calls: [] }
  }
  return { response: '', tool_calls: [] }
}

function usageOf(result: SdkResult): ChatUsage {
  return {
    inputTokens: Number(result.usage?.input_tokens) || 0,
    outputTokens: Number(result.usage?.output_tokens) || 0
  }
}

function promptFor(request: ChatProviderRequest, conversation: unknown[], hasImages: boolean): string {
  const tools = request.toolChoice === 'none' ? [] : request.tools
  const instructions = tools.length > 0
    ? [
        'You may answer in response, or request one or more tools in tool_calls.',
        'Only request tools from AVAILABLE_TOOLS and obey each input schema.',
        'When tool_calls is not empty, response must be empty: you will see the tool results and write the one reply to the user in the next step.'
      ]
    : [
        'Answer the user in response.',
        'tool_calls must be an empty array because tools are unavailable for this model call.'
      ]

  return [
    'Produce the next assistant step for this Commander conversation.',
    ...instructions,
    ...(hasImages ? [PROMPT_IMAGE_NOTE] : []),
    '',
    'CONVERSATION_JSON',
    JSON.stringify(conversation),
    '',
    'AVAILABLE_TOOLS_JSON',
    JSON.stringify(tools)
  ].join('\n')
}

/**
 * The prompt as the SDK takes it: a plain string, or, when images are
 * attached, one streamed user message whose content blocks carry the text and
 * the images (streaming input is the SDK's image path).
 */
export function sdkPrompt(text: string, images: ChatImageInput[]): SdkPrompt {
  if (images.length === 0) return text
  const message: SdkUserMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text },
        ...images.map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } }))
      ]
    },
    parent_tool_use_id: null
  }
  return (async function* () { yield message })()
}

async function defaultQuery(input: { prompt: SdkPrompt; options: Record<string, unknown> }): Promise<SdkQuery> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  return sdk.query(input as Parameters<typeof sdk.query>[0]) as unknown as SdkQuery
}

export class ClaudeCodeSubscriptionChatProvider implements ChatProvider {
  readonly id = 'claude-code-subscription'
  readonly supportsImages = true
  readonly model: string
  private readonly reasoningEffort?: string
  private readonly query?: SdkQueryFunction
  private readonly resolveExecutable: () => Promise<string>

  constructor(options: ClaudeCodeSubscriptionProviderOptions) {
    this.model = options.model
    this.reasoningEffort = options.reasoningEffort
    this.query = options.query
    this.resolveExecutable = options.findExecutable ?? findClaudeExecutable
  }

  async *stream(request: ChatProviderRequest, signal: AbortSignal): AsyncIterable<ChatProviderEvent> {
    if (signal.aborted) throw new ChatAbortError()
    const abortController = new AbortController()
    const abort = (): void => abortController.abort()
    signal.addEventListener('abort', abort, { once: true })
    let iterator: SdkQuery | null = null

    try {
      const executable = await this.resolveExecutable()
      if (signal.aborted) throw new ChatAbortError()
      const env = { ...process.env }
      // Claude Code refuses to nest when 21x itself was launched from a Claude
      // terminal. The regular Claude adapter removes this marker too.
      delete env.CLAUDECODE
      // This provider exists specifically for subscription-backed agents. An
      // ambient key must not silently switch the CLI to pay-per-use API auth.
      delete env.ANTHROPIC_API_KEY
      const options: Record<string, unknown> = {
        pathToClaudeCodeExecutable: executable,
        model: this.model,
        systemPrompt: request.system,
        abortController,
        tools: [],
        permissionMode: 'dontAsk',
        maxTurns: 1,
        persistSession: false,
        outputFormat: { type: 'json_schema', schema: OUTPUT_SCHEMA },
        env
      }
      if (this.reasoningEffort && this.reasoningEffort !== 'minimal') {
        options.effort = this.reasoningEffort
      }

      const { messages: conversation, images } = extractPromptImages(request.messages)
      const prompt = sdkPrompt(promptFor(request, conversation, images.length > 0), images)
      iterator = this.query
        ? this.query({ prompt, options })
        : await defaultQuery({ prompt, options })

      let terminal: SdkResult | null = null
      for await (const message of iterator) {
        if (signal.aborted) throw new ChatAbortError()
        if (message.type === 'result') terminal = message
      }
      if (!terminal) throw new Error('Claude Code ended without a response.')
      if (terminal.subtype !== 'success' || terminal.is_error) {
        throw new Error(terminal.errors?.join('\n') || terminal.result || 'Claude Code could not answer the Commander turn.')
      }

      const reply = parseReply(terminal)
      const text = typeof reply.response === 'string' ? reply.response : ''

      const rawCalls = Array.isArray(reply.tool_calls) ? reply.tool_calls as StructuredToolCall[] : []
      const toolCalls: ChatProviderEvent[] = []
      if (request.toolChoice !== 'none') {
        const allowed = new Set(request.tools.map((tool) => tool.name))
        for (const raw of rawCalls) {
          const input = asObject(raw.input)
          if (typeof raw.name !== 'string' || !allowed.has(raw.name) || !input) continue
          toolCalls.push({
            type: 'tool_call',
            id: typeof raw.id === 'string' && raw.id ? raw.id : `tool_${randomUUID()}`,
            name: raw.name,
            input
          })
        }
      }
      // The reply belongs after the tool results. Text sent with a tool call
      // is a premature answer that the next step repeats, so drop it.
      if (text && toolCalls.length === 0) yield { type: 'text_delta', text }
      yield* toolCalls
      yield { type: 'message_end', stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn', usage: usageOf(terminal) }
    } catch (err) {
      if (signal.aborted || abortController.signal.aborted) throw new ChatAbortError()
      throw err
    } finally {
      signal.removeEventListener('abort', abort)
      iterator?.close?.()
    }
  }
}
