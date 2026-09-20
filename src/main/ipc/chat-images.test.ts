import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { ipcMain } from 'electron'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { CommanderStore } from '../commander/commander-store'
import { readClipboardImages } from '../chat/clipboard-images'
import { saveImagesAsTaskAttachments } from '../chat/task-image-attachments'
import { guardedIpcSend } from '../guarded-ipc-send'
import { registerChatImageHandlers } from './chat-images'
import { registerCommanderHandlers } from './commander'
import type { IpcDeps } from './deps'

vi.mock('../chat/clipboard-images', () => ({ readClipboardImages: vi.fn() }))
vi.mock('../chat/task-image-attachments', () => ({ saveImagesAsTaskAttachments: vi.fn() }))
vi.mock('../guarded-ipc-send', () => ({ guardedIpcSend: vi.fn() }))

type Handler = (event: unknown, payload?: unknown) => unknown
function handler(channel: string): Handler {
  const entry = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)
  if (!entry) throw new Error(`Handler not registered: ${channel}`)
  return entry[1] as Handler
}

const trusted = {
  sender: { getType: () => 'window', once: vi.fn(), isDestroyed: () => false },
  senderFrame: { url: pathToFileURL(join(__dirname, '../../renderer/index.html')).href, parent: null }
}

beforeEach(() => vi.clearAllMocks())

describe('chat image IPC boundaries', () => {
  it.each([
    ['webview', { ...trusted, sender: { getType: () => 'webview' } }],
    ['iframe', { ...trusted, senderFrame: { ...trusted.senderFrame, parent: {} } }],
    ['remote page', { ...trusted, senderFrame: { url: 'https://untrusted.example/', parent: null } }],
    ['missing frame', { sender: trusted.sender }]
  ])('refuses clipboard, task image and Commander image access from a %s', async (_name, event) => {
    const { db } = createTestDb()
    registerChatImageHandlers({ db } as IpcDeps)
    const commander = registerCommanderHandlers({ db } as IpcDeps, { getTools: () => [] })
    const payload = { taskId: 'victim-task', id: 'private-image', sessionId: 'victim-session', images: [] }
    for (const channel of ['chatImages:readClipboard', 'chatImages:saveToTask', 'commander:getImage', 'commander:send']) {
      await expect(Promise.resolve().then(() => handler(channel)(event, payload))).rejects.toThrow(/only available to the main window/)
    }
    expect(readClipboardImages).not.toHaveBeenCalled()
    expect(saveImagesAsTaskAttachments).not.toHaveBeenCalled()
    expect(guardedIpcSend).not.toHaveBeenCalled()
    commander.cancelAll()
  })

  it('publishes task metadata only after saving succeeds and returns no local path', async () => {
    const { db } = createTestDb()
    registerChatImageHandlers({ db } as IpcDeps)
    const saved = [{ id: 'attachment', filename: 'image.png', size: 10, mime_type: 'image/png', added_at: 'now' }]
    vi.mocked(saveImagesAsTaskAttachments).mockResolvedValue({ saved, attachments: saved })
    await expect(handler('chatImages:saveToTask')(trusted, { taskId: 'task', images: [] })).resolves.toEqual(saved)
    expect(guardedIpcSend).toHaveBeenCalledWith(trusted.sender, 'task:updated', { taskId: 'task', updates: { attachments: saved } })
    vi.mocked(guardedIpcSend).mockClear()
    vi.mocked(saveImagesAsTaskAttachments).mockRejectedValue(new Error('Cannot save image'))
    await expect(handler('chatImages:saveToTask')(trusted, { taskId: 'task', images: [] })).rejects.toThrow('Cannot save image')
    expect(guardedIpcSend).not.toHaveBeenCalled()
  })

  it('passes typed image messages through the merged Commander service signature', async () => {
    const { db } = createTestDb()
    const commander = registerCommanderHandlers({ db } as IpcDeps, { getTools: () => [] })
    const send = vi.spyOn(commander, 'sendUserMessage').mockReturnValue({ turnId: 'turn', message: {} as never, done: Promise.resolve() })
    const images = [{ name: 'shot.png', mimeType: 'image/png', data: 'aGVsbG8=' }]
    handler('commander:send')(trusted, { sessionId: 'session', text: 'Look', images })
    expect(send).toHaveBeenCalledWith('session', 'Look', 'typed', images)
    expect(new CommanderStore(db).listMessages('session')).toEqual([])
    commander.cancelAll()
  })
})
