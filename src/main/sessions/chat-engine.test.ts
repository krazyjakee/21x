import { describe, expect, it } from 'vitest'
import { ChatRuntime } from '../chat/chat-runtime'
import type { ChatProvider } from '../chat/providers/types'
import type { ChatMessage } from '../../shared/chat'
import { ChatEngine, boundChatMessages } from './chat-engine'
import { chatMessageCharacters, managedVerbatimTokens } from '../commander/context'
import { estimateTokens } from './token-estimator'

describe('managed ChatEngine', () => {
  it('uses D7 and retries one rejected model call at half budget without repeating a completed tool', async () => {
    const history: ChatMessage[] = [{ role: 'user', content: 'Earlier request '.repeat(2400) }, { role: 'assistant', content: 'Earlier response' }, { role: 'user', content: 'Start the next task' }]
    const requests: ChatMessage[][] = []
    const steps: ChatMessage[] = []
    const notices: string[] = []
    let tools = 0
    let calls = 0
    const provider: ChatProvider = { id: 'fixture', model: 'unknown-window', async *stream(request) {
      requests.push(request.messages)
      calls++
      if (calls === 2) throw new Error('context_length_exceeded')
      if (calls === 1 || calls === 3) {
        yield { type: 'tool_call', id: `call-${calls}`, name: 'start', input: calls === 1 ? { task: 'next', options: { a: 1, b: 2 } } : { options: { b: 2, a: 1 }, task: 'next' } }
        yield { type: 'message_end', stopReason: 'tool_use' }
      } else {
        yield { type: 'text_delta', text: 'Task started once' }
        yield { type: 'message_end', stopReason: 'end_turn' }
      }
    } }
    const engine = new ChatEngine(new ChatRuntime())
    const result = await engine.startTurn({ provider, messages: history,
      onStep: (message) => { steps.push(message) },
      onContextNotice: (_message, key) => { notices.push(key) },
      tools: [{ name: 'start', description: 'Start task', inputSchema: { type: 'object', properties: {} }, handler: async () => {
        expect(steps.at(-1)?.role).toBe('assistant')
        tools++
        return 'Task started once'
      } }] }, () => {}).done
    expect(result.stopReason).toBe('end_turn')
    expect(calls).toBe(4)
    expect(tools).toBe(1)
    expect(notices.filter((key) => key === 'overflow-retry')).toHaveLength(1)
    expect(requests[2].some((message) => message.role === 'tool' && message.content === 'Task started once')).toBe(true)
    expect(estimateTokens(requests[2].reduce((sum, message) => sum + chatMessageCharacters(message), 0))).toBeLessThanOrEqual(8000)
    expect(result.messages[0].content).toBe(history[0].content)
    expect(steps).toHaveLength(5)
  })

  it('surfaces persistent overflow after exactly one retry with completed steps retained', async () => {
    let calls = 0
    let effects = 0
    const steps: ChatMessage[] = []
    const provider: ChatProvider = { id: 'fixture', model: 'fixture', async *stream() {
      if (++calls === 1) {
        yield { type: 'tool_call', id: 'side-effect', name: 'write', input: {} }
        yield { type: 'message_end', stopReason: 'tool_use' }
      } else throw new Error('maximum context length exceeded')
    } }
    const result = await new ChatEngine(new ChatRuntime()).startTurn({ provider, messages: [{ role: 'user', content: 'Write once' }],
      onStep: (message) => { steps.push(message) }, tools: [{ name: 'write', description: 'Write', inputSchema: { type: 'object', properties: {} }, handler: async () => { effects++; return 'Written' } }] }, () => {}).done
    expect(result.stopReason).toBe('error')
    expect(calls).toBe(3)
    expect(effects).toBe(1)
    expect(steps.map((step) => step.role)).toEqual(['assistant', 'tool'])
    expect(result.messages.at(-1)?.content).toBe('Written')
  })

  it('preserves partial text and refuses to replay a model attempt that already emitted output', async () => {
    let calls = 0
    const steps: ChatMessage[] = []
    const provider: ChatProvider = { id: 'fixture', model: 'fixture', async *stream() {
      calls++
      yield { type: 'text_delta', text: 'Preserve this partial reply' }
      throw new Error('context_length_exceeded')
    } }
    const result = await new ChatEngine(new ChatRuntime()).startTurn({ provider, messages: [{ role: 'user', content: 'Continue' }], onStep: (message) => { steps.push(message) } }, () => {}).done
    expect(calls).toBe(1)
    expect(result.stopReason).toBe('error')
    expect(steps[0].content).toBe('Preserve this partial reply')
  })

  it('shortens only persisted tool output views while preserving user instructions and tool pairing', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Do not change production' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'read-1', name: 'read', input: {} }] },
      { role: 'tool', toolCallId: 'read-1', name: 'read', content: 'Large result '.repeat(1000) }]
    const bounded = boundChatMessages(messages, 200)
    expect(bounded.shortened).toBe(true)
    expect(bounded.messages[0]).toEqual(messages[0])
    expect(bounded.messages[1]).toEqual(messages[1])
    expect(bounded.messages[2].content).toContain('full result is stored')
    expect(estimateTokens(bounded.messages.reduce((sum, message) => sum + chatMessageCharacters(message), 0))).toBeLessThanOrEqual(200)
    expect(messages[2].content.length).toBeGreaterThan(10000)
    expect(managedVerbatimTokens('custom', 1000)).toBe(600)
    expect(() => boundChatMessages([{ role: 'user', content: 'x'.repeat(1000) }], 10)).toThrow('cannot safely fit')
  })

  it('never retries unknown transport failures or cancellation', async () => {
    for (const cancelled of [false, true]) {
      let calls = 0
      const signal = new AbortController()
      const provider: ChatProvider = { id: 'fixture', model: 'fixture', async *stream() {
        calls++
        if (cancelled) signal.abort()
        throw new Error(cancelled ? 'context_length_exceeded' : 'ECONNRESET')
      } }
      const result = await new ChatEngine(new ChatRuntime()).startTurn({ provider, signal: signal.signal, messages: [{ role: 'user', content: 'Continue' }] }, () => {}).done
      expect(calls).toBe(1)
      expect(result.stopReason).toBe(cancelled ? 'cancelled' : 'error')
    }
  })

  it('stops before any tool effect when step persistence fails and retains the unanswered call', async () => {
    let effects = 0
    const provider: ChatProvider = { id: 'fixture', model: 'fixture', async *stream() {
      yield { type: 'tool_call', id: 'write-1', name: 'write', input: {} }
      yield { type: 'message_end', stopReason: 'tool_use' }
    } }
    const result = await new ChatEngine(new ChatRuntime()).startTurn({ provider, messages: [{ role: 'user', content: 'Write' }],
      onStep: () => { throw new Error('Step commit failed') },
      tools: [{ name: 'write', description: 'Write', inputSchema: { type: 'object' }, handler: async () => { effects++; return 'Written' } }] }, () => {}).done
    expect(effects).toBe(0)
    expect(result.stopReason).toBe('error')
    expect(result.messages[1]).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'write-1' }] })
    expect(result.messages[2]).toMatchObject({ role: 'tool', toolCallId: 'write-1', isError: true })
  })

  it('persists a truthful unexecuted tool result for a truncated model call', async () => {
    let effects = 0
    const steps: ChatMessage[] = []
    const provider: ChatProvider = { id: 'fixture', model: 'fixture', async *stream() {
      yield { type: 'tool_call', id: 'partial-1', name: 'write', input: {} }
      yield { type: 'message_end', stopReason: 'max_tokens' }
    } }
    const result = await new ChatEngine(new ChatRuntime()).startTurn({ provider, messages: [{ role: 'user', content: 'Write' }],
      onStep: (message) => { steps.push(message) },
      tools: [{ name: 'write', description: 'Write', inputSchema: { type: 'object' }, handler: async () => { effects++; return 'Written' } }] }, () => {}).done
    expect(effects).toBe(0)
    expect(result.stopReason).toBe('max_tokens')
    expect(steps.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'partial-1', isError: true, content: expect.stringContaining('not executed') })
  })
})
