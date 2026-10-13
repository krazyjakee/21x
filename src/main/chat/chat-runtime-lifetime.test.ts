import { describe, expect, it, vi } from 'vitest'
import { ChatRuntime } from './chat-runtime'
import type { ChatProvider, ChatProviderEvent } from './providers/types'

function held() {
  let finish!: () => void
  const promise = new Promise<void>(resolve => { finish = resolve })
  return { promise, finish }
}
const messages = [{ role: 'user' as const, content: 'Fixture request' }]
function provider(stream: ChatProvider['stream']): ChatProvider {
  return { id: 'fixture', model: 'fixture-model', stream }
}

describe('chat raw turn ownership', () => {
  it('joins an abort-ignoring provider and its iterator cleanup through failed close and retry', async () => {
    const gate = held(), cleanup = held()
    const entered = vi.fn(), finalizing = vi.fn(), events = vi.fn()
    const runtime = new ChatRuntime()
    const turn = runtime.startTurn({ messages, provider: provider(async function* () {
      entered()
      try {
        await gate.promise
        yield { type: 'text_delta', text: 'late fixture' }
      } finally { finalizing(); await cleanup.promise }
    }) }, events)
    try {
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
      await expect(runtime.close(5)).rejects.toThrow('CHAT_SHUTDOWN_INCOMPLETE')
      gate.finish()
      await vi.waitFor(() => expect(finalizing).toHaveBeenCalledOnce())
      await expect(runtime.close(5)).rejects.toThrow('CHAT_SHUTDOWN_INCOMPLETE')
      const retry = runtime.close()
      cleanup.finish()
      await retry
      expect((await turn.done).stopReason).toBe('cancelled')
      expect(events).not.toHaveBeenCalled()
      expect(runtime.activeTurnIds).toEqual([])
    } finally { gate.finish(); cleanup.finish(); await turn.done; await runtime.close() }
  })

  it('joins an accepted tool effect after cancellation and never invokes a later tool or provider round', async () => {
    const gate = held(), wrote = vi.fn(), next = vi.fn(), events = vi.fn()
    const stream = vi.fn(async function* (): AsyncGenerator<ChatProviderEvent> {
      yield { type: 'tool_call', id: 'first', name: 'first', input: {} }
      yield { type: 'tool_call', id: 'second', name: 'second', input: {} }
      yield { type: 'message_end', stopReason: 'tool_use' }
    })
    const first = vi.fn(async () => { await gate.promise; wrote(); return 'accepted effect settled' })
    const runtime = new ChatRuntime()
    const turn = runtime.startTurn({ messages, provider: provider(stream), tools: [
      { name: 'first', description: 'fixture', inputSchema: { type: 'object' }, handler: first },
      { name: 'second', description: 'fixture', inputSchema: { type: 'object' }, handler: next }
    ] }, events)
    try {
      await vi.waitFor(() => expect(first).toHaveBeenCalledOnce())
      await expect(runtime.close(5)).rejects.toThrow('CHAT_SHUTDOWN_INCOMPLETE')
      events.mockClear()
      const retry = runtime.close()
      gate.finish()
      await retry
      expect(wrote).toHaveBeenCalledOnce()
      expect(next).not.toHaveBeenCalled()
      expect(stream).toHaveBeenCalledOnce()
      expect(events).not.toHaveBeenCalled()
      expect((await turn.done).stopReason).toBe('cancelled')
    } finally { gate.finish(); await turn.done; await runtime.close() }
  })

  it('cancels queued turns before provider startup and rejects final admission', async () => {
    const stream = vi.fn(async function* (): AsyncGenerator<ChatProviderEvent> { yield { type: 'text_delta', text: 'unexpected' } })
    const runtime = new ChatRuntime(), events = vi.fn()
    const options = { messages, provider: provider(stream) }
    const turn = runtime.startTurn(options, events)
    runtime.shutdown()
    await runtime.close()
    expect((await turn.done).stopReason).toBe('cancelled')
    expect(stream).not.toHaveBeenCalled()
    expect(events).not.toHaveBeenCalled()
    expect(() => runtime.startTurn(options, events)).toThrow('CHAT_RUNTIME_CLOSED')
  })

  it('reports ordinary cancel when an abort-ignoring stream ends, and preserves reusable cancelAll', async () => {
    const gate = held()
    const runtime = new ChatRuntime(), events = vi.fn()
    const turn = runtime.startTurn({ messages, provider: provider(async function* () {
      yield { type: 'text_delta', text: 'accepted text' }
      await gate.promise
    }) }, events)
    await vi.waitFor(() => expect(events).toHaveBeenCalled())
    runtime.cancelAll()
    gate.finish()
    expect((await turn.done).stopReason).toBe('cancelled')
    expect(events).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'done', stopReason: 'cancelled' }))
    await expect(runtime.close(0)).rejects.toBeInstanceOf(RangeError)
    const again = runtime.startTurn({ messages, provider: provider(async function* () {
      yield { type: 'message_end', stopReason: 'end_turn' }
    }) }, events)
    expect((await again.done).stopReason).toBe('end_turn')
    await runtime.close()
  })
})
