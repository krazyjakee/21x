import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { ipcMain } from 'electron'
import { createPortableDbFixture } from '../../../test/helpers/portable-db-test-helper'
import type { IpcDeps } from './deps'
import { closeChatServices, registerChatHandlers, shutdownChatServices } from './chat'

vi.mock('../ipc-sender', () => ({ assertTrustedSender: vi.fn() }))
vi.mock('../guarded-ipc-send', () => ({ guardedIpcSend: vi.fn(() => true) }))

describe('application chat shutdown owner', () => {
  it('joins raw provider cleanup with late SQLite access and rejects settings access after shutdown', async () => {
    const source = createPortableDbFixture()
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const entered = vi.fn()
    const createProvider = vi.fn(() => ({
      id: 'fixture', model: 'fixture',
      async *stream() {
        entered()
        try { await gate; yield { type: 'text_delta' as const, text: 'late fixture' } }
        finally { source.db.setSetting('fixture_chat_cleanup', 'settled') }
      }
    }))
    const runtime = registerChatHandlers({ db: source.db } as IpcDeps, { createProvider })
    const start = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === 'chat:start')![1]
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false })
    try {
      await start({ sender } as never, { messages: [{ role: 'user', content: 'fixture' }] })
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
      shutdownChatServices()
      await expect(runtime.close(5)).rejects.toThrow('CHAT_SHUTDOWN_INCOMPLETE')
      await expect(start({ sender } as never, { messages: [{ role: 'user', content: 'late' }] })).rejects.toThrow('CHAT_RUNTIME_CLOSED')
      expect(createProvider).toHaveBeenCalledOnce()
      const closing = closeChatServices()
      finish()
      await closing
      expect(source.db.getSetting('fixture_chat_cleanup')).toBe('settled')
      expect(sender.listenerCount('destroyed')).toBe(0)
      expect(() => registerChatHandlers({ db: source.db } as IpcDeps)).toThrow('CHAT_RUNTIME_CLOSED')
    } finally { finish(); await closeChatServices(); source.rawDb.close() }
  })
})
