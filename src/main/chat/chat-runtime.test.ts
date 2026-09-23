import { describe, expect, it, vi } from 'vitest'
import type { ChatRuntimeEvent } from '../../shared/chat'
import { ChatRuntime, MAX_TOOL_CALLS_PER_TURN_CAP } from './chat-runtime'
import type { ChatProvider, ChatProviderEvent, ChatProviderRequest } from './providers/types'
import { ChatAbortError } from './providers/types'
import type { ChatToolDefinition } from './tools'

/** A provider whose answers are decided by a script, one entry per model call. */
type Script = (request: ChatProviderRequest, signal: AbortSignal) => AsyncGenerator<ChatProviderEvent>

function scriptedProvider(script: Script): ChatProvider & { requests: ChatProviderRequest[] } {
  const requests: ChatProviderRequest[] = []
  return {
    id: 'fake',
    model: 'fake-1',
    requests,
    stream(request, signal) {
      requests.push(request)
      return script(request, signal)
    }
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const weatherTool: ChatToolDefinition = {
  name: 'get_weather',
  description: 'Weather for a city',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  handler: vi.fn(async (input) => `Sunny in ${String(input.city)}`)
}

function collect(): { events: ChatRuntimeEvent[]; listener: (e: ChatRuntimeEvent) => void } {
  const events: ChatRuntimeEvent[] = []
  return { events, listener: (e) => events.push(e) }
}

describe('ChatRuntime', () => {
  it('does not reflect image transport errors containing secrets, image data or local paths into events or logs', async () => {
    const leaked = 'secret-token data:image/png;base64,PRIVATE_IMAGE /home/private/image.png'
    const provider = scriptedProvider(async function* () {
      yield { type: 'text_delta', text: '' }
      throw new Error(leaked)
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { events, listener } = collect()
      const result = await new ChatRuntime().startTurn({ provider, messages: [{ role: 'user', content: 'look', images: [{ name: 'image.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] }] }, listener).done
      expect(result.stopReason).toBe('error')
      expect(result.error).toBe('The chat request with images failed. Check the selected model and try again.')
      for (const secret of ['secret-token', 'PRIVATE_IMAGE', '/home/private/']) {
        expect(JSON.stringify(events)).not.toContain(secret)
        expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
      }
    } finally {
      log.mockRestore()
    }
  })

  it('streams text, runs one tool round trip and returns the extended history', async () => {
    const provider = scriptedProvider(async function* (request) {
      const lastIsTool = request.messages[request.messages.length - 1].role === 'tool'
      if (!lastIsTool) {
        yield { type: 'text_delta', text: 'Let me ' }
        await tick()
        yield { type: 'text_delta', text: 'check.' }
        yield { type: 'tool_call', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } }
        yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } }
      } else {
        yield { type: 'text_delta', text: 'It is sunny in Paris.' }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 7 } }
      }
    })
    const { events, listener } = collect()
    const runtime = new ChatRuntime()
    const handle = runtime.startTurn(
      { provider, tools: [weatherTool], messages: [{ role: 'user', content: 'Weather in Paris?' }], system: 'Be brief.' },
      listener
    )
    expect(events).toEqual([]) // nothing is emitted synchronously
    const result = await handle.done

    expect(result.stopReason).toBe('end_turn')
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0, modelCalls: 2, reportedCalls: 2, lastPromptTokens: 20 })
    expect(weatherTool.handler).toHaveBeenCalledWith({ city: 'Paris' }, expect.objectContaining({ toolCallId: 'call_1' }))
    expect(events.map((e) => e.type)).toEqual([
      'text_delta', 'text_delta', 'tool_call_start', 'tool_call_result', 'text_delta', 'done'
    ])
    expect(events[3]).toEqual({ type: 'tool_call_result', id: 'call_1', name: 'get_weather', content: 'Sunny in Paris', isError: false })
    expect(result.messages).toEqual([
      { role: 'user', content: 'Weather in Paris?' },
      { role: 'assistant', content: 'Let me check.', toolCalls: [{ id: 'call_1', name: 'get_weather', input: { city: 'Paris' } }] },
      { role: 'tool', toolCallId: 'call_1', name: 'get_weather', content: 'Sunny in Paris', isError: false },
      { role: 'assistant', content: 'It is sunny in Paris.' }
    ])
    // The second model call sees the system prompt, the tool schema and the tool result.
    expect(provider.requests[1].system).toBe('Be brief.')
    expect(provider.requests[1].tools.map((t) => t.name)).toEqual(['get_weather'])
    expect(provider.requests[1].toolChoice).toBe('auto')
    expect(runtime.activeTurnIds).toEqual([])
  })

  it('cancels mid-turn, keeps the partial text and reports cancelled', async () => {
    const provider = scriptedProvider(async function* (_request, signal) {
      yield { type: 'text_delta', text: 'Hello' }
      await new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new ChatAbortError()), { once: true }))
    })
    const { events, listener } = collect()
    const runtime = new ChatRuntime()
    const handle = runtime.startTurn({ provider, messages: [{ role: 'user', content: 'Hi' }] }, listener)
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'text_delta', text: 'Hello' }))
    expect(runtime.activeTurnIds).toEqual([handle.turnId])

    expect(runtime.cancel(handle.turnId)).toBe(true)
    const result = await handle.done

    expect(result.stopReason).toBe('cancelled')
    expect(result.messages).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' }
    ])
    expect(events[events.length - 1]).toMatchObject({ type: 'done', stopReason: 'cancelled' })
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(runtime.cancel(handle.turnId)).toBe(false) // already gone
  })

  it('does not run tool handlers once cancelled', async () => {
    const handler = vi.fn(async () => 'never')
    const provider = scriptedProvider(async function* () {
      yield { type: 'tool_call', id: 'c1', name: 't', input: {} }
      yield { type: 'message_end', stopReason: 'tool_use' }
    })
    const runtime = new ChatRuntime()
    const controller = new AbortController()
    const handle = runtime.startTurn(
      { provider, signal: controller.signal, tools: [{ name: 't', description: '', inputSchema: { type: 'object' }, handler }], messages: [{ role: 'user', content: 'go' }] },
      () => {}
    )
    controller.abort()
    const result = await handle.done
    expect(result.stopReason).toBe('cancelled')
    expect(handler).not.toHaveBeenCalled()
  })

  it('answers every tool call when cancelled while tools run, so the history can be resent', async () => {
    const runtime = new ChatRuntime()
    let turnId = ''
    const slow: ChatToolDefinition = {
      name: 'slow',
      description: '',
      inputSchema: { type: 'object' },
      handler: vi.fn(async () => {
        runtime.cancel(turnId)
        return 'first done'
      })
    }
    const provider = scriptedProvider(async function* () {
      yield { type: 'tool_call', id: 'c1', name: 'slow', input: {} }
      yield { type: 'tool_call', id: 'c2', name: 'slow', input: {} }
      yield { type: 'message_end', stopReason: 'tool_use' }
    })
    const handle = runtime.startTurn({ provider, tools: [slow], messages: [{ role: 'user', content: 'go' }] }, () => {})
    turnId = handle.turnId
    const result = await handle.done

    expect(result.stopReason).toBe('cancelled')
    expect(slow.handler).toHaveBeenCalledTimes(1)
    const toolResults = result.messages.filter((m) => m.role === 'tool')
    expect(toolResults.map((m) => m.role === 'tool' && m.toolCallId)).toEqual(['c1', 'c2'])
    expect(toolResults[1]).toMatchObject({ isError: true })
  })

  it('stops calling tools at the per-turn limit and asks for a text answer', async () => {
    let calls = 0
    const provider = scriptedProvider(async function* (request) {
      if (request.toolChoice === 'none') {
        yield { type: 'text_delta', text: 'Here is what I found.' }
        yield { type: 'message_end', stopReason: 'end_turn' }
        return
      }
      calls++
      yield { type: 'tool_call', id: `c${calls}`, name: 'get_weather', input: { city: `City ${calls}` } }
      yield { type: 'message_end', stopReason: 'tool_use' }
    })
    const handler = vi.fn(async () => 'ok')
    const tool: ChatToolDefinition = { ...weatherTool, handler }
    const { events, listener } = collect()
    const result = await new ChatRuntime().startTurn(
      { provider, tools: [tool], maxToolCalls: 2, messages: [{ role: 'user', content: 'loop forever' }] },
      listener
    ).done

    expect(handler).toHaveBeenCalledTimes(2)
    expect(provider.requests).toHaveLength(3)
    expect(provider.requests[2].toolChoice).toBe('none')
    expect(result.stopReason).toBe('tool_limit')
    expect(result.messages[result.messages.length - 1]).toEqual({ role: 'assistant', content: 'Here is what I found.' })
    expect(events[events.length - 1]).toMatchObject({ type: 'done', stopReason: 'tool_limit' })
  })

  it('answers over-limit parallel calls with an error result instead of running them', async () => {
    const provider = scriptedProvider(async function* (request) {
      if (request.toolChoice === 'none') {
        yield { type: 'message_end', stopReason: 'end_turn' }
        return
      }
      yield { type: 'tool_call', id: 'a', name: 'get_weather', input: { city: 'A' } }
      yield { type: 'tool_call', id: 'b', name: 'get_weather', input: { city: 'B' } }
      yield { type: 'message_end', stopReason: 'tool_use' }
    })
    const handler = vi.fn(async () => 'ok')
    const { events, listener } = collect()
    const result = await new ChatRuntime().startTurn(
      { provider, tools: [{ ...weatherTool, handler }], maxToolCalls: 1, messages: [{ role: 'user', content: 'go' }] },
      listener
    ).done

    expect(handler).toHaveBeenCalledTimes(1)
    const results = events.filter((e): e is Extract<ChatRuntimeEvent, { type: 'tool_call_result' }> => e.type === 'tool_call_result')
    expect(results.map((r) => [r.id, r.isError])).toEqual([['a', false], ['b', true]])
    expect(results[1].content).toMatch(/limit/i)
    expect(result.stopReason).toBe('tool_limit')
  })

  it('never lets a caller raise the limit above the cap', async () => {
    let calls = 0
    const provider = scriptedProvider(async function* (request) {
      if (request.toolChoice === 'none') {
        yield { type: 'message_end', stopReason: 'end_turn' }
        return
      }
      calls++
      yield { type: 'tool_call', id: `c${calls}`, name: 'get_weather', input: {} }
      yield { type: 'message_end', stopReason: 'tool_use' }
    })
    const handler = vi.fn(async () => 'ok')
    await new ChatRuntime().startTurn(
      { provider, tools: [{ ...weatherTool, handler }], maxToolCalls: 10_000, messages: [{ role: 'user', content: 'go' }] },
      () => {}
    ).done
    expect(handler).toHaveBeenCalledTimes(MAX_TOOL_CALLS_PER_TURN_CAP)
  })

  it('reports tool failures to the model instead of ending the turn', async () => {
    const provider = scriptedProvider(async function* (request) {
      const last = request.messages[request.messages.length - 1]
      if (last.role === 'tool') {
        expect(last.isError).toBe(true)
        expect(last.content).toBe('boom')
        yield { type: 'text_delta', text: 'Sorry, that failed.' }
        yield { type: 'message_end', stopReason: 'end_turn' }
        return
      }
      yield { type: 'tool_call', id: 'x', name: 'unknown_tool', input: {} }
      yield { type: 'tool_call', id: 'y', name: 'get_weather', input: { city: 'Z' } }
      yield { type: 'message_end', stopReason: 'tool_use' }
    })
    const failing: ChatToolDefinition = { ...weatherTool, handler: async () => { throw new Error('boom') } }
    const { events, listener } = collect()
    const result = await new ChatRuntime().startTurn(
      { provider, tools: [failing], messages: [{ role: 'user', content: 'go' }] },
      listener
    ).done

    expect(result.stopReason).toBe('end_turn')
    const results = events.filter((e) => e.type === 'tool_call_result')
    expect(results).toMatchObject([
      { id: 'x', isError: true, content: 'Unknown tool: unknown_tool' },
      { id: 'y', isError: true, content: 'boom' }
    ])
  })

  it('emits error then done when the provider fails', async () => {
    const provider = scriptedProvider(async function* () {
      yield { type: 'text_delta', text: 'partial' }
      throw new Error('502 from upstream')
    })
    const { events, listener } = collect()
    const result = await new ChatRuntime().startTurn({ provider, messages: [{ role: 'user', content: 'go' }] }, listener).done
    expect(result.stopReason).toBe('error')
    expect(result.error).toBe('502 from upstream')
    expect(events.slice(-2)).toMatchObject([{ type: 'error', message: '502 from upstream' }, { type: 'done', stopReason: 'error' }])
  })

  it('refuses to run a tool whose input was cut off by max_tokens', async () => {
    const handler = vi.fn(async () => 'ok')
    const provider = scriptedProvider(async function* () {
      yield { type: 'tool_call', id: 'c', name: 'get_weather', input: { city: 'Par' } }
      yield { type: 'message_end', stopReason: 'max_tokens' }
    })
    const result = await new ChatRuntime().startTurn(
      { provider, tools: [{ ...weatherTool, handler }], messages: [{ role: 'user', content: 'go' }] },
      () => {}
    ).done
    expect(result.stopReason).toBe('max_tokens')
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects a bad tool list before calling the model', async () => {
    const provider = scriptedProvider(async function* () {
      yield { type: 'message_end', stopReason: 'end_turn' }
    })
    const { events, listener } = collect()
    const result = await new ChatRuntime().startTurn(
      { provider, tools: [weatherTool, weatherTool], messages: [{ role: 'user', content: 'go' }] },
      listener
    ).done
    expect(result.stopReason).toBe('error')
    expect(result.error).toMatch(/Duplicate chat tool name/)
    expect(provider.requests).toHaveLength(0)
    expect(events[0]).toMatchObject({ type: 'error' })
  })

  it('counts every model call but only sums the ones that reported usage', async () => {
    const provider = scriptedProvider(async function* (request) {
      const lastIsTool = request.messages[request.messages.length - 1].role === 'tool'
      if (!lastIsTool) {
        yield { type: 'tool_call', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } }
        // The Codex subscription reports zeros: that is no report at all.
        yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 0 } }
      } else {
        yield { type: 'text_delta', text: 'Sunny.' }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 40, outputTokens: 3, cacheReadTokens: 900, cacheWriteTokens: 60 } }
      }
    })
    const result = await new ChatRuntime().startTurn({ provider, tools: [weatherTool], messages: [{ role: 'user', content: 'Weather?' }] }, () => {}).done
    expect(result.usage).toEqual({
      inputTokens: 40, outputTokens: 3, cacheReadTokens: 900, cacheWriteTokens: 60,
      modelCalls: 2, reportedCalls: 1, lastPromptTokens: 1000
    })
  })

  it('reports no usage when no call did', async () => {
    const provider = scriptedProvider(async function* () {
      yield { type: 'text_delta', text: 'Hi.' }
      yield { type: 'message_end', stopReason: 'end_turn' }
    })
    const result = await new ChatRuntime().startTurn({ provider, messages: [{ role: 'user', content: 'Hi' }] }, () => {}).done
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, modelCalls: 1, reportedCalls: 0 })
  })
})
