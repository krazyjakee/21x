import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ClipboardEvent } from 'react'
import { MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGES_PER_MESSAGE, chatImageErrors, type ChatImageInput } from '@shared/chat-images'
import { clipboardFiles, pastedImageName, useChatAttachments, type UseChatAttachmentsOptions } from './use-chat-attachments'
import { BMP_MAGIC, clipboard, imageBytes, imageFile, toBase64, type FakeClipboard } from '@/components/chat/paste-fixtures'

vi.mock('@/lib/ipc-client', () => ({ chatImageApi: { readClipboard: vi.fn(async () => ({ images: [], errors: [] })) } }))

const NOW = new Date(2026, 8, 19, 20, 8, 11)

function pasteEvent(data: FakeClipboard, field?: HTMLTextAreaElement) {
  const event = {
    clipboardData: data,
    preventDefault: vi.fn(),
    currentTarget: field ?? document.createElement('textarea')
  }
  return event as typeof event & ClipboardEvent<HTMLTextAreaElement>
}

function setup(options: UseChatAttachmentsOptions = {}) {
  const readClipboard = vi.fn(async () => ({ images: [] as ChatImageInput[], errors: [] as string[] }))
  const hook = renderHook(() => useChatAttachments({ readClipboard, now: () => NOW, ...options }))
  const paste = async (data: FakeClipboard, field?: HTMLTextAreaElement) => {
    const event = pasteEvent(data, field)
    act(() => hook.result.current.handlePaste(event))
    await waitFor(() => expect(hook.result.current.isReading).toBe(false))
    return event
  }
  return { hook, readClipboard, paste, current: () => hook.result.current }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('useChatAttachments', () => {
  it('attaches a pasted screenshot, names it, and announces it', async () => {
    const { paste, current, readClipboard } = setup()
    // Chromium names every clipboard bitmap image.png.
    const event = await paste(clipboard({ files: [imageFile('image.png')] }))

    expect(event.preventDefault).toHaveBeenCalled()
    expect(readClipboard).not.toHaveBeenCalled()
    const [attachment] = current().attachments
    expect(attachment).toMatchObject({ name: pastedImageName('image/png', NOW, 0), mimeType: 'image/png', size: 64 })
    expect(attachment.name).toBe('pasted-image-20260919-200811.png')
    expect(attachment.previewUrl).toBe(`data:image/png;base64,${toBase64(imageBytes())}`)
    expect(current().announcement?.text).toBe(`Image attached: ${attachment.name}`)
    expect(current().toInputs()).toEqual([{ name: attachment.name, mimeType: 'image/png', data: toBase64(imageBytes()) }])
    expect(current().errors).toEqual([])
  })

  it('keeps the name of a copied image file', async () => {
    const { paste, current } = setup()
    await paste(clipboard({ files: [imageFile('diagram.jpg', 'image/jpeg')] }))
    expect(current().attachments.map((a) => [a.name, a.mimeType])).toEqual([['diagram.jpg', 'image/jpeg']])
  })

  it('mixed paste: the text pastes as normal and the image is attached', async () => {
    const { paste, current } = setup()
    const event = await paste(clipboard({ files: [imageFile('a.png')], text: 'look at this' }))
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(current().attachments).toHaveLength(1)
  })

  it('leaves a text-only paste completely alone', async () => {
    const { paste, current, readClipboard } = setup()
    const event = await paste(clipboard({ text: 'hello', html: '<b>hello</b>' }))
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(readClipboard).not.toHaveBeenCalled()
    expect(current().attachments).toEqual([])
    expect(current().errors).toEqual([])
    expect(current().announcement).toBeNull()
  })

  it('refuses an unsupported type, by declared type and by content', async () => {
    const { paste, current } = setup()
    await paste(clipboard({ files: [imageFile('old.bmp', 'image/bmp')] }))
    await paste(clipboard({ files: [imageFile('fake.png', 'image/png', 64, BMP_MAGIC)] }))
    expect(current().attachments).toEqual([])
    expect(current().errors).toEqual([chatImageErrors.unsupportedType('fake.png')])

    const first = setup()
    await first.paste(clipboard({ files: [imageFile('old.bmp', 'image/bmp')] }))
    expect(first.current().errors).toEqual([chatImageErrors.unsupportedType('old.bmp')])
  })

  it('refuses an image over the size limit', async () => {
    const { paste, current } = setup()
    await paste(clipboard({ files: [imageFile('huge.png', 'image/png', MAX_CHAT_IMAGE_BYTES + 1)] }))
    expect(current().attachments).toEqual([])
    expect(current().errors).toEqual([chatImageErrors.tooLarge('huge.png', MAX_CHAT_IMAGE_BYTES + 1)])
  })

  it('stops at the per-message maximum', async () => {
    const { paste, current } = setup()
    const files = Array.from({ length: MAX_CHAT_IMAGES_PER_MESSAGE + 1 }, (_, i) => imageFile(`shot-${i}.png`))
    await paste(clipboard({ files }))
    expect(current().attachments).toHaveLength(MAX_CHAT_IMAGES_PER_MESSAGE)
    expect(current().errors).toEqual([chatImageErrors.tooMany()])
    expect(current().announcement?.text).toBe(`${MAX_CHAT_IMAGES_PER_MESSAGE} images attached`)
  })

  it('removes an image and announces it; clear and restore round-trip a failed send', async () => {
    const { paste, current } = setup()
    await paste(clipboard({ files: [imageFile('a.png'), imageFile('b.png', 'image/png', 65)] }))
    const [a, b] = current().attachments
    act(() => current().remove(a.id))
    expect(current().attachments.map((x) => x.id)).toEqual([b.id])
    expect(current().announcement?.text).toBe('Image removed: a.png')

    const before = current().attachments
    act(() => current().clear())
    expect(current().attachments).toEqual([])
    act(() => current().restore(before))
    expect(current().attachments).toEqual(before)
  })

  it('reports a read failure', async () => {
    const { paste, current } = setup()
    const broken = imageFile('broken.png')
    Object.defineProperty(broken, 'arrayBuffer', { value: () => Promise.reject(new Error('gone')) })
    await paste(clipboard({ files: [broken] }))
    expect(current().errors).toEqual([chatImageErrors.readFailed('broken.png')])
  })

  it('asks main for a copied file that arrived as a path, and attaches what it reads', async () => {
    const png: ChatImageInput = { name: 'photo.png', mimeType: 'image/png', data: toBase64(imageBytes()) }
    const { paste, current, readClipboard } = setup()
    readClipboard.mockResolvedValueOnce({ images: [png], errors: [] })
    const event = await paste(clipboard({ uriList: 'file:///home/me/photo.png', text: '/home/me/photo.png' }))
    expect(readClipboard).toHaveBeenCalledTimes(1)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(current().attachments.map((a) => a.name)).toEqual(['photo.png'])
  })

  it('pastes the path as text when main finds no image behind a copied file', async () => {
    const field = document.createElement('textarea')
    document.body.appendChild(field)
    const { paste, current } = setup()
    await paste(clipboard({ uriList: 'file:///home/me/notes.txt', text: '/home/me/notes.txt' }), field)
    expect(field.value).toBe('/home/me/notes.txt')
    expect(current().attachments).toEqual([])
    field.remove()
  })

  it('refuses images with the surface reason when the chat cannot take them, and still pastes text', async () => {
    const { paste, current, readClipboard } = setup({ unsupportedReason: 'No images here.' })
    const image = await paste(clipboard({ files: [imageFile('a.png')] }))
    expect(image.preventDefault).toHaveBeenCalled()
    expect(current().errors).toEqual(['No images here.'])
    const text = await paste(clipboard({ text: 'hi' }))
    expect(text.preventDefault).not.toHaveBeenCalled()
    expect(readClipboard).not.toHaveBeenCalled()
  })

  it('clipboardFiles lists a file offered through both files and items once', () => {
    const file = imageFile('a.png')
    const data = clipboard({ files: [file] })
    expect(clipboardFiles(data as unknown as DataTransfer)).toEqual([file])
  })
})
