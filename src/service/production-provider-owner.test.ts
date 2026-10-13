import { describe, expect, it } from 'vitest'
import { ProductionProviderOwner } from './production-provider-owner'
import type { ChatProvider } from '../main/chat/providers/types'

describe('actual production provider configuration ownership', () => {
  it('retains ignored stream cancellation and rejects obsolete provider references after mutation', async () => {
    let finish!: () => void, entered!: () => void, signal!: AbortSignal
    const gate = new Promise<void>(resolve => { finish = resolve })
    const entry = new Promise<void>(resolve => { entered = resolve })
    const provider: ChatProvider = { id: 'controlled', model: 'controlled', async *stream(_request, requestSignal) {
      signal = requestSignal; entered(); await gate
      yield { type: 'message_end', stopReason: 'end_turn' }
    } }
    const owner = new ProductionProviderOwner(), old = owner.wrap(provider)
    const iterator = old.stream({ messages: [], tools: [], toolChoice: 'none' }, new AbortController().signal)[Symbol.asyncIterator]()
    const next = iterator.next(); await entry
    const lease = owner.beginMutation(); let drained = false
    const draining = lease.drain().then(() => { drained = true })
    expect(signal.aborted).toBe(true); await Promise.resolve(); expect(drained).toBe(false)
    expect(() => owner.wrap(provider)).toThrow('CONFIGURATION_UNAVAILABLE')
    finish(); await next; await iterator.return?.(); await draining; lease.release()
    await expect(old.stream({ messages: [], tools: [], toolChoice: 'none' }, new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toThrow('CONFIGURATION_UNAVAILABLE')
    const fresh = owner.wrap(provider)
    const current = fresh.stream({ messages: [], tools: [], toolChoice: 'none' }, new AbortController().signal)[Symbol.asyncIterator]()
    await current.next(); await current.return?.(); owner.shutdown(); await owner.drain()
  })
})
