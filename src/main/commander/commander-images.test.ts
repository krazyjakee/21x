import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc-sender', () => ({ assertTrustedSender: vi.fn() }))
vi.mock('../guarded-ipc-send', () => ({ guardedIpcSend: vi.fn(() => true) }))

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { ipcMain } from 'electron'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { MAX_CHAT_IMAGE_BYTES, chatImageErrors, type ChatImageInput } from '../../shared/chat-images'
import type { CommanderEvent } from '../../shared/commander'
import { readClipboardImages, type ClipboardItemLike } from '../chat/clipboard-images'
import { saveImagesAsTaskAttachments, uniqueAttachmentName } from '../chat/task-image-attachments'
import type { ChatProvider, ChatProviderEvent, ChatProviderRequest } from '../chat/providers/types'
import { imagesUnsupportedMessage } from '../chat/providers/types'
import type { DatabaseManager } from '../database'
import { registerCommanderHandlers } from '../ipc/commander'
import type { IpcDeps } from '../ipc/deps'
import { CommanderService } from './commander-service'
import { CommanderStore } from './commander-store'
import { DeliveryStore } from '../sessions/delivery-store'
import { COMMANDER_SUMMARY_PROMPT, COMMANDER_TITLE_PROMPT } from './prompts'

/** Commander images end to end in main (#144): storage, context, refusal, IPC, clipboard, task attachments. */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function pngBytes(size = 64): Buffer {
  const bytes = Buffer.alloc(size)
  Buffer.from(PNG_MAGIC).copy(bytes)
  return bytes
}

const png = (name = 'shot.png', size = 64): ChatImageInput => ({ name, mimeType: 'image/png', data: pngBytes(size).toString('base64') })

function recordingProvider(options: { supportsImages?: boolean } = {}): ChatProvider & { requests: ChatProviderRequest[] } {
  const requests: ChatProviderRequest[] = []
  return {
    id: 'fake',
    model: 'fake-vision',
    ...(options.supportsImages === undefined ? {} : { supportsImages: options.supportsImages }),
    requests,
    async *stream(request): AsyncGenerator<ChatProviderEvent> {
      requests.push(request)
      yield { type: 'text_delta', text: 'Seen.' }
      yield { type: 'message_end', stopReason: 'end_turn' }
    }
  }
}

function chatRequests(provider: { requests: ChatProviderRequest[] }): ChatProviderRequest[] {
  return provider.requests.filter((r) => r.system !== COMMANDER_TITLE_PROMPT && r.system !== COMMANDER_SUMMARY_PROMPT)
}

let db: DatabaseManager
let store: CommanderStore
let events: CommanderEvent[]

beforeEach(() => {
  vi.clearAllMocks()
  db = createTestDb().db
  store = new CommanderStore(db)
  events = []
})

describe('Commander messages with images', () => {
  it('preserves image metadata and user text alongside Captain terminology read compatibility', () => {
    const legacy = ['Master', 'mind'].join('')
    const session = store.createSession()
    const original = `${legacy} says inspect attachments/${legacy}.png`
    const user = store.appendMessage(session.id, { role: 'user', content: original, images: [png(`${legacy}.png`)] })
    const reply = store.appendMessage(session.id, { role: 'assistant', content: original })
    const reloaded = new CommanderStore(db)
    expect(reloaded.listMessages(session.id)).toEqual([
      expect.objectContaining({ id: user.id, content: original, images: user.images }),
      expect.objectContaining({ id: reply.id, content: `Captain says inspect attachments/${legacy}.png` })
    ])
    expect(reloaded.getMessageImages(user.id)).toEqual([png(`${legacy}.png`)])
    expect(db.db.prepare('SELECT content FROM commander_messages WHERE id = ?').get(reply.id)).toEqual({ content: original })
  })

  it('stores delivery-ID images atomically and preserves the original images on replay after restart', () => {
    const session = store.createSession()
    const deliveries = new DeliveryStore(db)
    const row = deliveries.enqueue({
      idempotencyKey: 'commander-image-delivery', kind: 'agent_message', payload: '{}'
    }).record
    const input = { role: 'user' as const, content: '', images: [png('first.png'), png('second.png')] }
    const first = store.appendMessageOnce(session.id, input, row.id)
    expect(first.inserted).toBe(true)
    expect(first.message.images?.map((image) => image.name)).toEqual(['first.png', 'second.png'])
    expect(deliveries.get(row.id)?.state).toBe('acknowledged')

    const restarted = new CommanderStore(db)
    const replay = restarted.appendMessageOnce(session.id, { ...input, images: [png('replacement.png')] }, row.id)
    expect(replay).toEqual({ message: first.message, inserted: false })
    expect(restarted.getMessageImages(first.message.id)).toEqual(input.images)
    expect(restarted.listMessages(session.id)).toHaveLength(1)
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM commander_images').get()).toEqual({ n: 2 })
  })

  it('rolls back a delivery message and acknowledgement when image persistence fails', () => {
    const session = store.createSession()
    const deliveries = new DeliveryStore(db)
    const row = deliveries.enqueue({ idempotencyKey: 'broken-image', kind: 'agent_message', payload: '{}' }).record
    db.db.exec("CREATE TRIGGER fail_image BEFORE INSERT ON commander_images BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
    expect(() => store.appendMessageOnce(session.id, { role: 'user', content: '', images: [png()] }, row.id)).toThrow('disk failure')
    expect(store.listMessages(session.id)).toEqual([])
    expect(deliveries.get(row.id)?.state).toBe('pending')
    db.db.exec('DROP TRIGGER fail_image')
    expect(store.appendMessageOnce(session.id, { role: 'user', content: '', images: [png()] }, row.id).message.images).toHaveLength(1)
  })

  it('stores the images, sends them to the provider as image input, and returns metadata only', async () => {
    const provider = recordingProvider({ supportsImages: true })
    const service = new CommanderService({ store, createProvider: () => provider, emit: (e) => events.push(e) })
    const session = store.createSession()

    const { message, done } = service.sendUserMessage(session.id, 'What does this show?', 'typed', [png('chart.png'), png('table.png')])
    await done

    expect(message.images).toEqual([
      { id: expect.any(String), name: 'chart.png', mime_type: 'image/png', size: 64 },
      { id: expect.any(String), name: 'table.png', mime_type: 'image/png', size: 64 }
    ])
    // Events carry metadata, never the bytes.
    const appended = events.find((e) => e.type === 'messages_appended')
    expect(JSON.stringify(appended)).not.toContain(png().data)

    const [request] = chatRequests(provider)
    expect(request.messages[0]).toEqual({ role: 'user', content: 'What does this show?', images: [png('chart.png'), png('table.png')] })

    // History reloads with the images, and the bytes come back by id.
    const [stored] = store.listMessages(session.id)
    expect(stored.images?.map((i) => i.name)).toEqual(['chart.png', 'table.png'])
    expect(store.getImage(stored.images![0].id)).toMatchObject({ name: 'chart.png', mime_type: 'image/png', data: png().data })
  })

  it('accepts a message that is only an image and names the session sensibly', async () => {
    const provider = recordingProvider({ supportsImages: true })
    const service = new CommanderService({ store, createProvider: () => provider, emit: () => {} })
    const session = store.createSession()
    await service.sendUserMessage(session.id, '   ', 'typed', [png()]).done
    expect(store.listMessages(session.id)[0]).toMatchObject({ role: 'user', content: '' })
    expect(store.getSession(session.id)?.title).toBeTruthy()
  })

  it('refuses images for a provider that cannot read them, before storing anything', () => {
    const provider = recordingProvider()
    const service = new CommanderService({ store, createProvider: () => provider, emit: (e) => events.push(e) })
    const session = store.createSession()
    expect(() => service.sendUserMessage(session.id, 'Look at this', 'typed', [png()])).toThrow(imagesUnsupportedMessage(provider))
    expect(store.listMessages(session.id)).toEqual([])
    expect(events).toEqual([])
    expect(provider.requests).toEqual([])
    // The same text without images still goes through.
    expect(() => service.sendUserMessage(session.id, 'Look at this')).not.toThrow()
  })

  it('refuses invalid images with the shared messages', () => {
    const service = new CommanderService({ store, createProvider: () => recordingProvider({ supportsImages: true }), emit: () => {} })
    const session = store.createSession()
    expect(() => service.sendUserMessage(session.id, 'x', 'typed', [png('big.png', MAX_CHAT_IMAGE_BYTES + 3)])).toThrow(/Images must be 5.0 MB or smaller/)
    expect(() => service.sendUserMessage(session.id, 'x', 'typed', Array.from({ length: 6 }, () => png()))).toThrow(chatImageErrors.tooMany())
    expect(store.listMessages(session.id)).toEqual([])
  })

  it('names older images in text once the history is over the image budget', async () => {
    const provider = recordingProvider({ supportsImages: true })
    const service = new CommanderService({ store, createProvider: () => provider, emit: () => {} })
    const session = store.createSession()
    const nearFull = (name: string) => png(name, MAX_CHAT_IMAGE_BYTES - 3)
    await service.sendUserMessage(session.id, 'first', 'typed', [nearFull('old-1.png'), nearFull('old-2.png'), nearFull('old-3.png')]).done
    await service.sendUserMessage(session.id, 'second', 'typed', [nearFull('new-1.png'), nearFull('new-2.png')]).done

    const last = chatRequests(provider).at(-1)!
    const [first, , second] = last.messages
    expect(first).toEqual({ role: 'user', content: 'first\n[Earlier images no longer attached: old-1.png, old-2.png, old-3.png]' })
    expect(second.role === 'user' && second.images?.map((i) => i.name)).toEqual(['new-1.png', 'new-2.png'])
  })

  it.each(['images', 'tools'])('rolls back a new message and its images when preparing %s fails, allowing one clean retry', async (failure) => {
    const provider = recordingProvider({ supportsImages: true })
    const getTools = vi.fn(() => [])
    const service = new CommanderService({ store, createProvider: () => provider, getTools, emit: (event) => events.push(event) })
    const session = store.createSession()
    if (failure === 'images') vi.spyOn(store, 'getMessageImages').mockImplementationOnce(() => { throw new Error('cannot load images') })
    else getTools.mockImplementationOnce(() => { throw new Error('cannot prepare tools') })

    expect(() => service.sendUserMessage(session.id, 'look', 'typed', [png()])).toThrow(/cannot/)
    expect(store.listMessages(session.id)).toEqual([])
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM commander_images').get()).toEqual({ count: 0 })
    expect(events).toEqual([])
    expect(service.activeTurnId(session.id)).toBeNull()

    await service.sendUserMessage(session.id, 'look', 'typed', [png()]).done
    expect(store.listMessages(session.id).filter((message) => message.role === 'user')).toHaveLength(1)
    expect(chatRequests(provider)).toHaveLength(1)
  })

  it('replaces earlier image history with notes after switching to a text-only provider', async () => {
    const provider = recordingProvider()
    const service = new CommanderService({ store, createProvider: () => provider, emit: () => {} })
    const session = store.createSession()
    store.appendMessage(session.id, { role: 'user', content: 'previous', images: [png()] })
    store.appendMessage(session.id, { role: 'assistant', content: 'seen' })
    const loader = vi.spyOn(store, 'getMessageImages')
    await service.sendUserMessage(session.id, 'continue').done
    expect(loader).not.toHaveBeenCalled()
    const history = chatRequests(provider)[0].messages
    expect(history[0]).toEqual({ role: 'user', content: 'previous\n[Earlier image no longer attached: shot.png]' })
    expect(history.some((message) => message.role === 'user' && message.images?.length)).toBe(false)
  })

  it('deletes images with their session', () => {
    const session = store.createSession()
    const message = store.appendMessage(session.id, { role: 'user', content: 'x', images: [png()] })
    store.deleteSession(session.id)
    expect(store.getImage(message.images![0].id)).toBeNull()
  })
})

describe('commander IPC', () => {
  type Handler = (event: unknown, payload: unknown) => unknown
  function handler(channel: string): Handler {
    const call = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find(([name]) => name === channel)
    if (!call) throw new Error(`no handler for ${channel}`)
    return call[1] as Handler
  }
  const event = { sender: { once: vi.fn(), isDestroyed: () => false } }

  it('commander:send passes images through validation to the provider, and commander:getImage returns the bytes', async () => {
    const provider = recordingProvider({ supportsImages: true })
    const service = registerCommanderHandlers({ db } as unknown as IpcDeps, { createProvider: () => provider, getTools: () => [] })
    const session = new CommanderStore(db).createSession()

    const reply = await handler('commander:send')(event, { sessionId: session.id, text: 'see', images: [png('a.png')] }) as { message: { images: Array<{ id: string }> } }
    await vi.waitFor(() => expect(chatRequests(provider)).toHaveLength(1))
    expect(chatRequests(provider)[0].messages[0]).toMatchObject({ images: [png('a.png')] })
    service.cancelAll()

    const image = await handler('commander:getImage')(event, { id: reply.message.images[0].id })
    expect(image).toEqual({ id: reply.message.images[0].id, name: 'a.png', mimeType: 'image/png', data: png().data })
    expect(await handler('commander:getImage')(event, { id: 'missing' })).toBeNull()
  })

  it('commander:send rejects spoofed image data and an unsupported provider without storing', async () => {
    registerCommanderHandlers({ db } as unknown as IpcDeps, { createProvider: () => recordingProvider(), getTools: () => [] })
    const session = new CommanderStore(db).createSession()
    const send = handler('commander:send')
    expect(() => send(event, { sessionId: session.id, text: 'x', images: [{ name: 'a.png', mimeType: 'image/png', data: Buffer.from('<svg/>').toString('base64') }] }))
      .toThrow(/isn't a supported image type/)
    expect(() => send(event, { sessionId: session.id, text: 'x', images: [png()] })).toThrow(/can't read images/)
    expect(new CommanderStore(db).listMessages(session.id)).toEqual([])
  })
})

describe('readClipboardImages (main-process paste fallback)', () => {
  const blob = (text: string) => new Blob([text], { type: 'text/plain' })
  const item = (entries: Record<string, Blob>): ClipboardItemLike => ({
    types: Object.keys(entries),
    getType: async (type: string) => entries[type]
  })

  it('reads a copied image file from a Linux uri-list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clip-'))
    const file = join(dir, 'Screenshot 1.png')
    writeFileSync(file, pngBytes())
    writeFileSync(join(dir, 'notes.txt'), 'hello')
    const uriList = `${pathToFileURL(file)}\r\n${pathToFileURL(join(dir, 'notes.txt'))}\r\n`
    const result = await readClipboardImages({ read: async () => [item({ 'text/uri-list': blob(uriList) })] })
    expect(result.errors).toEqual([])
    expect(result.images).toEqual([{ name: 'Screenshot 1.png', mimeType: 'image/png', data: pngBytes().toString('base64') }])
  })

  it('reads a Finder file URL and reports an oversize or fake image', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clip-'))
    const big = join(dir, 'big.png')
    const fake = join(dir, 'fake.jpg')
    writeFileSync(big, pngBytes(MAX_CHAT_IMAGE_BYTES + 1))
    writeFileSync(fake, 'not a jpeg')
    const mac = 'electron application/osclipboard;format="public.file-url"'
    const result = await readClipboardImages({
      read: async () => [item({ [mac]: blob(String(pathToFileURL(big))) }), item({ 'text/uri-list': blob(String(pathToFileURL(fake))) })]
    })
    expect(result.images).toEqual([])
    expect(result.errors).toEqual([
      chatImageErrors.tooLarge('big.png', MAX_CHAT_IMAGE_BYTES + 1),
      chatImageErrors.unsupportedType('fake.jpg')
    ])
  })

  it('falls back to a raw clipboard image when no file was copied', async () => {
    const result = await readClipboardImages({
      read: async () => [item({ 'text/plain': blob('caption'), 'image/png': new Blob([new Uint8Array(pngBytes())], { type: 'image/png' }) })]
    })
    expect(result.images).toEqual([{ name: 'image.png', mimeType: 'image/png', data: pngBytes().toString('base64') }])
  })

  it('finds nothing on a text-only clipboard', async () => {
    await expect(readClipboardImages({ read: async () => [item({ 'text/plain': blob('hello') })] }))
      .resolves.toEqual({ images: [], errors: [] })
  })
})

describe('saveImagesAsTaskAttachments (task and Captain chats)', () => {
  it('writes the files, appends them to the task with unique names, and validates first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'att-'))
    let task = { attachments: [{ id: 'old', filename: 'shot.png', size: 1, mime_type: 'image/png', added_at: 'x' }] }
    const fake = {
      getTask: () => task,
      getAttachmentsDir: () => dir,
      updateTask: vi.fn((_id: string, data: { attachments: typeof task.attachments }) => { task = { attachments: data.attachments } })
    }
    const { saved } = await saveImagesAsTaskAttachments(fake, 't1', [png('shot.png'), png('shot.png')])
    expect(saved.map((a) => a.filename)).toEqual(['shot-2.png', 'shot-3.png'])
    expect(task.attachments.map((a) => a.filename)).toEqual(['shot.png', 'shot-2.png', 'shot-3.png'])
    const files = readdirSync(dir)
    expect(files).toHaveLength(2)
    expect(readFileSync(join(dir, files[0]))).toEqual(pngBytes())

    await expect(saveImagesAsTaskAttachments(fake, 't1', [{ name: 'x.png', mimeType: 'image/png', data: 'AAAA' }])).rejects.toThrow(/supported image type/)
    await expect(saveImagesAsTaskAttachments({ ...fake, getTask: () => undefined }, 'nope', [png()])).rejects.toThrow('Task not found')
  })

  it('uniqueAttachmentName keeps the extension', () => {
    expect(uniqueAttachmentName('a.png', new Set())).toBe('a.png')
    expect(uniqueAttachmentName('a.png', new Set(['a.png', 'a-2.png']))).toBe('a-3.png')
    expect(uniqueAttachmentName('noext', new Set(['noext']))).toBe('noext-2')
  })
})
