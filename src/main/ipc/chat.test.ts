import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc-sender', () => ({ assertTrustedSender: vi.fn() }))
vi.mock('../guarded-ipc-send', () => ({ guardedIpcSend: vi.fn(() => true) }))

import { ipcMain } from 'electron'
import { guardedIpcSend } from '../guarded-ipc-send'
import { assertTrustedSender } from '../ipc-sender'
import type { ChatIpcEvent } from '../../shared/chat'
import type { ChatProvider, ChatProviderEvent } from '../chat/providers/types'
import { ChatAbortError } from '../chat/providers/types'
import { registerChatHandlers, sanitizeChatMessages } from './chat'
import type { IpcDeps } from './deps'

type Handler = (event: unknown, payload: unknown) => Promise<unknown> | unknown

function handlers(): Record<string, Handler> {
  const out: Record<string, Handler> = {}
  for (const [channel, handler] of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) out[channel as string] = handler as Handler
  return out
}

function fakeSender(): { isDestroyed: () => boolean; once: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> } {
  return { isDestroyed: () => false, once: vi.fn(), removeListener: vi.fn() }
}

function sentEvents(): ChatIpcEvent[] {
  return (guardedIpcSend as ReturnType<typeof vi.fn>).mock.calls
    .filter((call) => call[1] === 'chat:event')
    .map((call) => call[2] as ChatIpcEvent)
}

describe('registerChatHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('streams a turn to the calling window tagged with its turnId', async () => {
    const provider: ChatProvider = {
      id: 'fake', model: 'm',
      async *stream() {
        yield { type: 'text_delta', text: 'Hi ' }
        yield { type: 'text_delta', text: 'there' }
        yield { type: 'message_end', stopReason: 'end_turn' }
      }
    }
    registerChatHandlers({ db: {} } as unknown as IpcDeps, { createProvider: () => provider })
    const sender = fakeSender()
    const { turnId, model } = await handlers()['chat:start']({ sender }, { messages: [{ role: 'user', content: 'hello' }] }) as { turnId: string; model: string }

    expect(assertTrustedSender).toHaveBeenCalledWith(expect.anything(), 'chat:start')
    expect(model).toBe('m')
    await vi.waitFor(() => expect(sentEvents().some((e) => e.event.type === 'done')).toBe(true))
    const events = sentEvents()
    expect(events.every((e) => e.turnId === turnId)).toBe(true)
    expect(events.map((e) => e.event.type)).toEqual(['text_delta', 'text_delta', 'done'])
    expect((guardedIpcSend as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(sender)
  })

  it('cancels only for the window that started the turn', async () => {
    const provider: ChatProvider = {
      id: 'fake', model: 'm',
      async *stream(_request, signal): AsyncGenerator<ChatProviderEvent> {
        yield { type: 'text_delta', text: 'working' }
        await new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new ChatAbortError()), { once: true }))
      }
    }
    registerChatHandlers({ db: {} } as unknown as IpcDeps, { createProvider: () => provider })
    const owner = fakeSender()
    const { turnId } = await handlers()['chat:start']({ sender: owner }, { messages: [{ role: 'user', content: 'go' }] }) as { turnId: string }
    await vi.waitFor(() => expect(sentEvents().length).toBeGreaterThan(0))

    expect(await handlers()['chat:cancel']({ sender: fakeSender() }, { turnId })).toEqual({ cancelled: false })
    expect(await handlers()['chat:cancel']({ sender: owner }, { turnId })).toEqual({ cancelled: true })
    await vi.waitFor(() => expect(sentEvents().at(-1)?.event).toMatchObject({ type: 'done', stopReason: 'cancelled' }))
  })

  it('rejects before spending anything when the provider cannot be built', async () => {
    registerChatHandlers({ db: {} } as unknown as IpcDeps, { createProvider: () => { throw new Error('No Anthropic API key is saved.') } })
    await expect(handlers()['chat:start']({ sender: fakeSender() }, { messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow(/No Anthropic API key/)
    expect(guardedIpcSend).not.toHaveBeenCalled()
  })
})

describe('sanitizeChatMessages', () => {
  it('accepts well-formed history', () => {
    expect(sanitizeChatMessages([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b', toolCalls: [{ id: '1', name: 't', input: { x: 1 } }] },
      { role: 'tool', toolCallId: '1', name: 't', content: 'r', isError: 'yes' }
    ])).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b', toolCalls: [{ id: '1', name: 't', input: { x: 1 } }] },
      { role: 'tool', toolCallId: '1', name: 't', content: 'r', isError: false }
    ])
  })

  it('rejects anything a provider would choke on', () => {
    expect(() => sanitizeChatMessages(undefined)).toThrow(/messages array/)
    expect(() => sanitizeChatMessages([])).toThrow(/at least one/)
    expect(() => sanitizeChatMessages([{ role: 'system', content: 'x' }])).toThrow(/unknown message role/)
    expect(() => sanitizeChatMessages([{ role: 'user', content: 1 }])).toThrow(/string content/)
    expect(() => sanitizeChatMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }])).toThrow(/must not end with an assistant/)
    expect(() => sanitizeChatMessages([{ role: 'assistant', content: 'b', toolCalls: [{ id: 1 }] }, { role: 'user', content: 'a' }])).toThrow(/toolCalls/)
  })
})
