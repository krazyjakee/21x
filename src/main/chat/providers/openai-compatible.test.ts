import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_OPENAI_BASE_URL, OpenAICompatibleChatProvider } from './openai-compatible'
import { ChatAbortError, type ChatProviderEvent, type FetchLike } from './types'

/** `chat/completions` chunks as a server would send them, split awkwardly across reads. */
function sseResponse(chunks: unknown[], options: { holdOpen?: boolean; signal?: AbortSignal | null; done?: boolean } = {}): Response {
  const encoder = new TextEncoder()
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + (options.done === false ? '' : 'data: [DONE]\n\n')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Two pieces, cut in the middle of a JSON payload, to prove the buffering.
      const cut = Math.floor(text.length / 2)
      controller.enqueue(encoder.encode(text.slice(0, cut)))
      controller.enqueue(encoder.encode(text.slice(cut)))
      if (options.holdOpen) {
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

function chunk(delta: Record<string, unknown>, finish_reason: string | null = null): unknown {
  return { id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] }
}

const toolTurn = [
  chunk({ role: 'assistant', content: '' }),
  chunk({ content: 'Let me ' }),
  chunk({ content: 'check.' }),
  chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city": ' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
  chunk({}, 'tool_calls')
]

const textTurn = [
  chunk({ role: 'assistant', content: 'Sunny ' }),
  chunk({ content: 'in Paris.' }),
  chunk({}, 'stop'),
  { id: 'chatcmpl-2', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 30, completion_tokens: 6 } }
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

describe('OpenAICompatibleChatProvider', () => {
  it('streams one turn with a tool-call round trip against a local server', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const responses = [toolTurn, textTurn]
    const fetchMock: FetchLike = vi.fn(async (input, init) => {
      calls.push({ url: String(input), init })
      return sseResponse(responses.shift()!)
    })
    const provider = new OpenAICompatibleChatProvider({ baseUrl: 'http://localhost:11434/v1/', model: 'llama3.2', fetch: fetchMock })

    const first = await drain(provider.stream({
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'Weather in Paris?' }],
      tools,
      toolChoice: 'auto'
    }, new AbortController().signal))

    expect(first).toEqual([
      { type: 'text_delta', text: 'Let me ' },
      { type: 'text_delta', text: 'check.' },
      { type: 'tool_call', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
      { type: 'message_end', stopReason: 'tool_use' }
    ])
    expect(calls[0].url).toBe('http://localhost:11434/v1/chat/completions')
    const headers = new Headers(calls[0].init?.headers)
    expect(headers.get('authorization')).toBeNull() // no key needed locally
    expect(headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      model: 'llama3.2',
      stream: true,
      max_tokens: 4096,
      tool_choice: 'auto',
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'Weather for a city', parameters: tools[0].inputSchema } }],
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Weather in Paris?' }
      ]
    })

    const second = await drain(provider.stream({
      system: 'Be brief.',
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
        { role: 'assistant', content: 'Let me check.', toolCalls: [{ id: 'call_1', name: 'get_weather', input: { city: 'Paris' } }] },
        { role: 'tool', toolCallId: 'call_1', name: 'get_weather', content: 'Sunny', isError: false }
      ],
      tools,
      toolChoice: 'auto'
    }, new AbortController().signal))

    expect(second).toEqual([
      { type: 'text_delta', text: 'Sunny ' },
      { type: 'text_delta', text: 'in Paris.' },
      { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 6 } }
    ])
    expect(JSON.parse(String(calls[1].init?.body)).messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Weather in Paris?' },
      { role: 'assistant', content: 'Let me check.', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }
      ] },
      { role: 'tool', tool_call_id: 'call_1', content: 'Sunny' }
    ])
  })

  it('sends a bearer token to hosted servers and marks error results in text', async () => {
    let init: RequestInit | undefined
    const provider = new OpenAICompatibleChatProvider({
      apiKey: 'sk-openai',
      fetch: async (input, i) => {
        expect(String(input)).toBe(`${DEFAULT_OPENAI_BASE_URL}/chat/completions`)
        init = i
        return sseResponse(textTurn)
      }
    })
    await drain(provider.stream({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'get_weather', input: {} }] },
        { role: 'tool', toolCallId: 'c', name: 'get_weather', content: 'nope', isError: true }
      ],
      tools,
      toolChoice: 'none'
    }, new AbortController().signal))
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-openai')
    const body = JSON.parse(String(init?.body))
    expect(body.tool_choice).toBe('none')
    expect(body.messages[1]).toEqual({ role: 'assistant', content: null, tool_calls: [
      { id: 'c', type: 'function', function: { name: 'get_weather', arguments: '{}' } }
    ] })
    expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'c', content: 'Error: nope' })
  })

  it('refuses the hosted default without a key but allows keyless local servers', () => {
    expect(() => new OpenAICompatibleChatProvider({})).toThrow(/API key/)
    expect(() => new OpenAICompatibleChatProvider({ baseUrl: 'http://127.0.0.1:1234/v1' })).not.toThrow()
  })

  it('surfaces HTTP errors with the server message', async () => {
    const provider = new OpenAICompatibleChatProvider({
      baseUrl: 'http://localhost:1234/v1',
      fetch: async () => new Response('model not found', { status: 404 })
    })
    await expect(drain(provider.stream({ messages: [{ role: 'user', content: 'hi' }], tools: [], toolChoice: 'auto' }, new AbortController().signal)))
      .rejects.toThrow(/404.*model not found/)
  })

  it('maps length to max_tokens and CRLF framing still parses', async () => {
    const provider = new OpenAICompatibleChatProvider({
      baseUrl: 'http://localhost:1234/v1',
      fetch: async () => new Response(
        `data: ${JSON.stringify(chunk({ content: 'trunc' }, 'length'))}\r\n\r\ndata: [DONE]\r\n\r\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    })
    const events = await drain(provider.stream({ messages: [{ role: 'user', content: 'hi' }], tools: [], toolChoice: 'auto' }, new AbortController().signal))
    expect(events).toEqual([{ type: 'text_delta', text: 'trunc' }, { type: 'message_end', stopReason: 'max_tokens' }])
  })

  it('turns an abort mid-stream into ChatAbortError', async () => {
    const controller = new AbortController()
    const provider = new OpenAICompatibleChatProvider({
      baseUrl: 'http://localhost:1234/v1',
      fetch: async (_input, init) => sseResponse([chunk({ content: 'Hel' })], { holdOpen: true, signal: init?.signal, done: false })
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
})
