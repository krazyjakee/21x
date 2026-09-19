import { describe, expect, it, vi } from 'vitest'
import { ChatRuntime } from '../chat-runtime'
import { CodexSubscriptionChatProvider, type CodexExecInput } from './codex-subscription'
import type { ChatProviderEvent } from './types'

async function drain(iterable: AsyncIterable<ChatProviderEvent>): Promise<ChatProviderEvent[]> {
  const events: ChatProviderEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
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

describe('CodexSubscriptionChatProvider', () => {
  it('uses the authenticated Codex CLI and returns a structured answer', async () => {
    const execute = vi.fn(async (_input: CodexExecInput) => JSON.stringify({
      response: 'Alpha is ready.',
      tool_calls: []
    }))
    const provider = new CodexSubscriptionChatProvider({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      execute,
      findExecutable: async () => '/usr/bin/codex'
    })

    await expect(drain(provider.stream(request, new AbortController().signal))).resolves.toEqual([
      { type: 'text_delta', text: 'Alpha is ready.' },
      { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }
    ])
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      executable: '/usr/bin/codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      prompt: expect.stringContaining('Coordinate projects.')
    }))
  })

  it('returns only allowed tool calls and drops a reply sent alongside them', async () => {
    const execute = vi.fn(async () => JSON.stringify({
      response: 'I asked Alpha; its answer will come back as a report.',
      tool_calls: [
        { id: 'call_1', name: 'get_project', input_json: '{"name":"Alpha"}' },
        { id: 'call_2', name: 'not_available', input_json: '{}' },
        { id: 'call_3', name: 'get_project', input_json: 'bad' }
      ]
    }))
    const provider = new CodexSubscriptionChatProvider({
      model: 'gpt-5.6-sol', execute, findExecutable: async () => '/usr/bin/codex'
    })

    await expect(drain(provider.stream(request, new AbortController().signal))).resolves.toEqual([
      { type: 'tool_call', id: 'call_1', name: 'get_project', input: { name: 'Alpha' } },
      { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 0 } }
    ])
  })

  it('completes a Commander tool round trip through ChatRuntime', async () => {
    const replies = [
      JSON.stringify({ response: '', tool_calls: [{ name: 'get_project', input: { name: 'Alpha' } }] }),
      JSON.stringify({ response: 'Alpha is ready.', tool_calls: [] })
    ]
    const execute = vi.fn(async () => replies.shift()!)
    const provider = new CodexSubscriptionChatProvider({
      model: 'gpt-5.6-sol', execute, findExecutable: async () => '/usr/bin/codex'
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
    expect(execute).toHaveBeenCalledTimes(2)
    expect(events).toContainEqual({ type: 'text_delta', text: 'Alpha is ready.' })
  })

  it('aborts an active Codex execution when the chat turn is cancelled', async () => {
    const controller = new AbortController()
    let execSignal: AbortSignal | undefined
    const execute = vi.fn(({ signal }: CodexExecInput) => new Promise<string>((_resolve, reject) => {
      execSignal = signal
      signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
    }))
    const provider = new CodexSubscriptionChatProvider({
      model: 'gpt-5.6-sol', execute, findExecutable: async () => '/usr/bin/codex'
    })
    const running = drain(provider.stream(request, controller.signal))
    await vi.waitFor(() => expect(execSignal).toBeDefined())
    controller.abort()

    await expect(running).rejects.toThrow('Chat turn cancelled')
    expect(execSignal?.aborted).toBe(true)
  })
})
