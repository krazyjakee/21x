import { describe, expect, it, vi } from 'vitest'
import { ChatRuntime } from '../chat-runtime'
import { ClaudeCodeSubscriptionChatProvider } from './claude-code-subscription'
import type { ChatProviderEvent } from './types'

async function drain(iterable: AsyncIterable<ChatProviderEvent>): Promise<ChatProviderEvent[]> {
  const events: ChatProviderEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

function fakeQuery(result: { type: string; [key: string]: unknown }) {
  return vi.fn((_input: { prompt: string | AsyncIterable<unknown>; options: Record<string, unknown> }) => ({
    async *[Symbol.asyncIterator]() {
      yield result
    },
    close: vi.fn()
  }))
}

const request = {
  system: 'Coordinate projects.',
  messages: [{ role: 'user' as const, content: 'Check Alpha' }],
  tools: [{
    name: 'get_project',
    description: 'Read one project',
    inputSchema: { type: 'object' as const, properties: { name: { type: 'string' } }, required: ['name'] }
  }],
  toolChoice: 'auto' as const
}

describe('ClaudeCodeSubscriptionChatProvider', () => {
  it('uses the authenticated Claude CLI and returns a structured answer', async () => {
    const query = fakeQuery({
      type: 'result',
      subtype: 'success',
      is_error: false,
      structured_output: { response: 'Alpha is ready.', tool_calls: [] },
      usage: { input_tokens: 12, output_tokens: 4 }
    })
    const provider = new ClaudeCodeSubscriptionChatProvider({
      model: 'claude-saved',
      reasoningEffort: 'high',
      query,
      findExecutable: async () => '/usr/bin/claude'
    })

    await expect(drain(provider.stream(request, new AbortController().signal))).resolves.toEqual([
      { type: 'text_delta', text: 'Alpha is ready.' },
      { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    ])
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0]![0].options).toMatchObject({
      pathToClaudeCodeExecutable: '/usr/bin/claude',
      model: 'claude-saved',
      effort: 'high',
      tools: [],
      permissionMode: 'dontAsk',
      persistSession: false
    })
    expect((query.mock.calls[0]![0].options.env as Record<string, string | undefined>).ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('returns only allowed tool calls and drops a reply sent alongside them', async () => {
    const query = fakeQuery({
      type: 'result',
      subtype: 'success',
      is_error: false,
      structured_output: {
        response: 'I asked Alpha; its answer will come back as a report.',
        tool_calls: [
          { id: 'call_1', name: 'get_project', input: { name: 'Alpha' } },
          { id: 'call_2', name: 'not_available', input: {} },
          { id: 'call_3', name: 'get_project', input: 'bad' }
        ]
      },
      usage: {}
    })
    const provider = new ClaudeCodeSubscriptionChatProvider({
      model: 'claude-saved',
      query,
      findExecutable: async () => '/usr/bin/claude'
    })

    await expect(drain(provider.stream(request, new AbortController().signal))).resolves.toEqual([
      { type: 'tool_call', id: 'call_1', name: 'get_project', input: { name: 'Alpha' } },
      { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    ])
  })

  it('completes a Commander tool round trip through ChatRuntime', async () => {
    const results = [
      {
        type: 'result', subtype: 'success', is_error: false,
        structured_output: { response: '', tool_calls: [{ name: 'get_project', input: { name: 'Alpha' } }] },
        usage: {}
      },
      {
        type: 'result', subtype: 'success', is_error: false,
        structured_output: { response: 'Alpha is ready.', tool_calls: [] },
        usage: {}
      }
    ]
    const query = vi.fn((_input: { prompt: string | AsyncIterable<unknown>; options: Record<string, unknown> }) => ({
      async *[Symbol.asyncIterator]() {
        yield results.shift()!
      }
    }))
    const provider = new ClaudeCodeSubscriptionChatProvider({
      model: 'claude-saved', query, findExecutable: async () => '/usr/bin/claude'
    })
    const handler = vi.fn(async () => JSON.stringify({ name: 'Alpha', status: 'ready' }))
    const events: Array<{ type: string }> = []
    const turn = new ChatRuntime().startTurn({
      provider,
      messages: [{ role: 'user', content: 'Check Alpha' }],
      tools: [{ ...request.tools[0], handler }]
    }, (event) => events.push(event))

    await expect(turn.done).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(handler).toHaveBeenCalledWith({ name: 'Alpha' }, expect.objectContaining({ toolCallId: expect.any(String) }))
    expect(query).toHaveBeenCalledTimes(2)
    expect(events).toContainEqual({ type: 'text_delta', text: 'Alpha is ready.' })
  })

  it('aborts the Claude query when the Commander turn is cancelled', async () => {
    const controller = new AbortController()
    let sdkSignal: AbortSignal | undefined
    const query = vi.fn(({ options }: { options: Record<string, unknown> }) => ({
      async *[Symbol.asyncIterator]() {
        sdkSignal = (options.abortController as AbortController).signal
        await new Promise<void>((resolve) => sdkSignal!.addEventListener('abort', () => resolve(), { once: true }))
      }
    }))
    const provider = new ClaudeCodeSubscriptionChatProvider({
      model: 'claude-saved',
      query,
      findExecutable: async () => '/usr/bin/claude'
    })
    const running = drain(provider.stream(request, controller.signal))
    await vi.waitFor(() => expect(sdkSignal).toBeDefined())
    controller.abort()

    await expect(running).rejects.toThrow('Chat turn cancelled')
    expect(sdkSignal?.aborted).toBe(true)
  })
})
