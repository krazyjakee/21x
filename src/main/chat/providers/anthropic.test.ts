import { describe, expect, it, vi } from 'vitest'
import { AnthropicChatProvider, DEFAULT_ANTHROPIC_CHAT_MODEL } from './anthropic'
import { ChatAbortError, type ChatProviderEvent, type FetchLike } from './types'

/**
 * The transport is a fake `fetch` that answers with a real SSE body, so the
 * SDK's own parser, message accumulator and abort handling are exercised.
 */

type SseEvent = { event: string; data: unknown }

function encodeSse(events: SseEvent[]): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('')
}

function sseResponse(events: SseEvent[], options: { holdOpen?: boolean; signal?: AbortSignal | null } = {}): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(encodeSse(events)))
      if (options.holdOpen) {
        // Behave like a real fetch: an aborted request errors the body.
        options.signal?.addEventListener('abort', () => {
          try { controller.error(new DOMException('The operation was aborted.', 'AbortError')) } catch { /* closed */ }
        }, { once: true })
      } else {
        controller.close()
      }
    }
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function messageStart(inputTokens = 10): SseEvent {
  return {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id: 'msg_1', type: 'message', role: 'assistant', model: DEFAULT_ANTHROPIC_CHAT_MODEL,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 1 }
      }
    }
  }
}

const toolTurn: SseEvent[] = [
  messageStart(10),
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'check.' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city": ' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Paris"}' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } } },
  { event: 'message_stop', data: { type: 'message_stop' } }
]

const textTurn: SseEvent[] = [
  messageStart(30),
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sunny in Paris.' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } } },
  { event: 'message_stop', data: { type: 'message_stop' } }
]

async function drain(iterable: AsyncIterable<ChatProviderEvent>): Promise<ChatProviderEvent[]> {
  const out: ChatProviderEvent[] = []
  for await (const event of iterable) out.push(event)
  return out
}

const tools = [{
  name: 'get_weather',
  description: 'Weather for a city',
  inputSchema: { type: 'object' as const, properties: { city: { type: 'string' } }, required: ['city'] }
}]

describe('AnthropicChatProvider', () => {
  it('streams one turn with a tool-call round trip over the messages API', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const urls: string[] = []
    const apiKeys: Array<string | null> = []
    const responses = [toolTurn, textTurn]
    // No assertions inside the mock: a throw here would look like a network
    // failure to the SDK and be retried.
    const fetchMock: FetchLike = vi.fn(async (input, init) => {
      urls.push(String(input))
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      apiKeys.push(new Headers(init?.headers).get('x-api-key'))
      return sseResponse(responses.shift()!)
    })
    const provider = new AnthropicChatProvider({ apiKey: 'sk-test', fetch: fetchMock })
    expect(provider.model).toBe(DEFAULT_ANTHROPIC_CHAT_MODEL)

    const first = await drain(provider.stream({
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'Weather in Paris?' }],
      tools,
      toolChoice: 'auto'
    }, new AbortController().signal))

    expect(first).toEqual([
      { type: 'text_delta', text: 'Let me ' },
      { type: 'text_delta', text: 'check.' },
      { type: 'tool_call', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
      { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    ])
    expect(urls[0]).toContain('/v1/messages')
    expect(apiKeys[0]).toBe('sk-test')
    expect(bodies[0]).toMatchObject({
      model: DEFAULT_ANTHROPIC_CHAT_MODEL,
      stream: true,
      system: 'Be brief.',
      tool_choice: { type: 'auto' },
      tools: [{ name: 'get_weather', description: 'Weather for a city', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'Weather in Paris?' }]
    })

    const second = await drain(provider.stream({
      system: 'Be brief.',
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
        { role: 'assistant', content: 'Let me check.', toolCalls: [{ id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }] },
        { role: 'tool', toolCallId: 'toolu_1', name: 'get_weather', content: 'Sunny', isError: false }
      ],
      tools,
      toolChoice: 'auto'
    }, new AbortController().signal))

    expect(second).toEqual([
      { type: 'text_delta', text: 'Sunny in Paris.' },
      { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    ])
    // History is rebuilt as tool_use / tool_result blocks the API understands.
    expect(bodies[1].messages).toEqual([
      { role: 'user', content: 'Weather in Paris?' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Sunny' }] }
    ])
  })

  it('sends the selected Claude thinking effort', async () => {
    let body: Record<string, unknown> = {}
    const provider = new AnthropicChatProvider({
      apiKey: 'k',
      reasoningEffort: 'high',
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body))
        return sseResponse(textTurn)
      }
    })
    await drain(provider.stream({
      messages: [{ role: 'user', content: 'Think about this' }],
      tools: [],
      toolChoice: 'none'
    }, new AbortController().signal))
    expect(body.output_config).toEqual({ effort: 'high' })
  })

  it('groups parallel tool results into one user message and flags errors', async () => {
    let body: Record<string, unknown> = {}
    const provider = new AnthropicChatProvider({
      apiKey: 'k',
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body))
        return sseResponse(textTurn)
      }
    })
    await drain(provider.stream({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [
          { id: 'a', name: 'get_weather', input: { city: 'A' } },
          { id: 'b', name: 'get_weather', input: { city: 'B' } }
        ] },
        { role: 'tool', toolCallId: 'a', name: 'get_weather', content: 'ok' },
        { role: 'tool', toolCallId: 'b', name: 'get_weather', content: 'failed', isError: true }
      ],
      tools,
      toolChoice: 'none'
    }, new AbortController().signal))

    expect(body.tool_choice).toEqual({ type: 'none' })
    expect(body.messages).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'a', name: 'get_weather', input: { city: 'A' } },
        { type: 'tool_use', id: 'b', name: 'get_weather', input: { city: 'B' } }
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'b', content: 'failed', is_error: true }
      ] }
    ])
  })

  it('omits tools and tool_choice when the caller has none', async () => {
    let body: Record<string, unknown> = {}
    const provider = new AnthropicChatProvider({
      apiKey: 'k',
      model: 'claude-sonnet-4-6',
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body))
        return sseResponse(textTurn)
      }
    })
    await drain(provider.stream({ messages: [{ role: 'user', content: 'hi' }], tools: [], toolChoice: 'auto' }, new AbortController().signal))
    expect(body.model).toBe('claude-sonnet-4-6')
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('tool_choice')
    expect(body).not.toHaveProperty('system')
  })

  it('turns an abort mid-stream into ChatAbortError', async () => {
    const controller = new AbortController()
    const provider = new AnthropicChatProvider({
      apiKey: 'k',
      fetch: async (_input, init) => sseResponse([
        messageStart(),
        { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } } }
      ], { holdOpen: true, signal: init?.signal })
    })
    const seen: ChatProviderEvent[] = []
    const consume = (async () => {
      for await (const event of provider.stream({ messages: [{ role: 'user', content: 'hi' }], tools: [], toolChoice: 'auto' }, controller.signal)) {
        seen.push(event)
        if (event.type === 'text_delta') controller.abort()
      }
    })()
    await expect(consume).rejects.toBeInstanceOf(ChatAbortError)
    expect(seen).toEqual([{ type: 'text_delta', text: 'Hel' }])
  })

  it('throws immediately when the signal is already aborted', async () => {
    const fetchMock = vi.fn()
    const provider = new AnthropicChatProvider({ apiKey: 'k', fetch: fetchMock })
    const controller = new AbortController()
    controller.abort()
    await expect(drain(provider.stream({ messages: [{ role: 'user', content: 'hi' }], tools: [], toolChoice: 'auto' }, controller.signal)))
      .rejects.toBeInstanceOf(ChatAbortError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires an API key', () => {
    expect(() => new AnthropicChatProvider({ apiKey: '' })).toThrow(/API key/)
  })
})
