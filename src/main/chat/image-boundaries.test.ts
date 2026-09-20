import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGE_TOTAL_BYTES, sanitizeChatImageName, validateChatImageInputs } from '../../shared/chat-images'
import { readClipboardImages, type ClipboardItemLike } from './clipboard-images'
import { saveImagesAsTaskAttachments, uniqueAttachmentName } from './task-image-attachments'
import type { FileAttachmentRecord } from '../database'

const bytes = (size = 64): Buffer => {
  const out = Buffer.alloc(size)
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return out
}
const image = { name: 'shot.png', mimeType: 'image/png' as const, data: bytes().toString('base64') }
const fileItem = (urls: string): ClipboardItemLike => ({ types: ['text/uri-list'], getType: async () => new Blob([urls]) })
const dirs: string[] = []
const directory = (): string => { const dir = mkdtempSync(join(tmpdir(), 'image-boundaries-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('image input boundaries', () => {
  it.each([[0x89, 0x50, 0x4e, 0x47], [0x47, 0x49, 0x46, 0x38, 0, 0]])('rejects incomplete or invalid magic signatures %j', (...signature) => {
    expect(() => validateChatImageInputs([{ ...image, data: Buffer.from(signature).toString('base64') }])).toThrow(/supported image type/)
  })

  it('bounds filenames in UTF-8 bytes without splitting surrogate pairs', () => {
    const name = sanitizeChatImageName(`${'😀'.repeat(120)}.png`, 'image/png')
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200)
    expect(name.endsWith('.png')).toBe(true)
    expect(name).not.toContain('\ufffd')
  })

  it('makes Windows device names and trailing dots portable', () => {
    expect(sanitizeChatImageName('CON.png. ', 'image/png')).toBe('image-CON.png')
    expect(sanitizeChatImageName('LPT1.png', 'image/png')).toBe('image-LPT1.png')
    expect(sanitizeChatImageName('shot.png... ', 'image/png')).toBe('shot.png')
    expect(sanitizeChatImageName('...', 'image/png')).toBe('image.png')
  })

  it('reserves names across case-insensitive and Unicode-normalizing filesystems', () => {
    expect(uniqueAttachmentName('shot.png', new Set(['SHOT.PNG']))).toBe('shot-2.png')
    expect(uniqueAttachmentName('é.png', new Set(['e\u0301.png']))).toBe('é-2.png')
  })

  it('rejects files that grow between stat and read', async () => {
    const result = await readClipboardImages({ read: async () => [fileItem('file:///secret/location/shot.png')], fileSize: async () => 64, readFile: async () => bytes(MAX_CHAT_IMAGE_BYTES + 1) })
    expect(result.images).toEqual([])
    expect(result.errors[0]).toContain('Images must be')
    expect(result.errors[0]).not.toContain('/secret/')
  })

  it('caps aggregate clipboard data before base64 crosses IPC', async () => {
    const result = await readClipboardImages({ read: async () => [fileItem(Array.from({ length: 5 }, (_, i) => `file:///shot-${i}.png`).join('\n'))], fileSize: async () => MAX_CHAT_IMAGE_BYTES, readFile: async () => bytes(MAX_CHAT_IMAGE_BYTES) })
    expect(result.images).toHaveLength(MAX_CHAT_IMAGE_TOTAL_BYTES / MAX_CHAT_IMAGE_BYTES)
    expect(result.errors).toEqual([expect.stringContaining('add up to')])
  })

  it('rejects oversized clipboard Blobs without allocating their arrayBuffer', async () => {
    const arrayBuffer = vi.fn()
    const result = await readClipboardImages({ read: async () => [{ types: ['image/png'], getType: async () => ({ size: MAX_CHAT_IMAGE_BYTES + 1, arrayBuffer }) }] })
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(result.images).toEqual([])
    expect(result.errors[0]).toContain('Images must be')
  })

  it('does not read copied remote file URLs', async () => {
    const readFile = vi.fn()
    const fileSize = vi.fn()
    expect(await readClipboardImages({ read: async () => [fileItem('file://remote-host/private/shot.png')], readFile, fileSize })).toEqual({ images: [], errors: [] })
    expect(fileSize).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
  })
})

describe('task attachment failure and concurrency', () => {
  it('removes all newly written files when the database refuses the update and hides paths', async () => {
    const dir = directory()
    const store = { getTask: () => ({ attachments: [] }), getAttachmentsDir: () => dir, updateTask: () => { throw new Error(`disk error at ${dir}`) } }
    await expect(saveImagesAsTaskAttachments(store, 'task', [image, image])).rejects.toThrow("Couldn't save the images. Try again.")
    expect(readdirSync(dir)).toEqual([])
  })

  it('rolls back a save if the task disappears during disk writes', async () => {
    const dir = directory()
    const store = { getTask: vi.fn().mockReturnValueOnce({ attachments: [] }).mockReturnValue(undefined), getAttachmentsDir: () => dir, updateTask: vi.fn() }
    await expect(saveImagesAsTaskAttachments(store, 'task', [image])).rejects.toThrow("Couldn't save")
    expect(readdirSync(dir)).toEqual([])
    expect(store.updateTask).not.toHaveBeenCalled()
  })

  it('preserves distinct filenames and both attachments during simultaneous saves', async () => {
    const dir = directory()
    let attachments: FileAttachmentRecord[] = []
    const store = { getTask: () => ({ attachments }), getAttachmentsDir: () => dir, updateTask: (_id: string, update: { attachments: FileAttachmentRecord[] }) => { attachments = update.attachments } }
    await Promise.all([saveImagesAsTaskAttachments(store, 'task', [image]), saveImagesAsTaskAttachments(store, 'task', [image])])
    expect(attachments.map((attachment) => attachment.filename)).toEqual(['shot.png', 'shot-2.png'])
    expect(readdirSync(dir)).toHaveLength(2)
  })
})
