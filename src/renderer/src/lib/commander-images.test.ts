import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cachedCommanderImage, clearCommanderImageCache, loadCommanderImage, seedCommanderImages } from './commander-images'
import { imageBytes, toBase64 } from '@/components/chat/paste-fixtures'
import type { ChatImageInput } from '@shared/chat-images'

const { getImage } = vi.hoisted(() => ({ getImage: vi.fn() }))
vi.mock('@/lib/ipc-client', () => ({ commanderApi: { getImage } }))
const png: ChatImageInput = { name: 'test.png', mimeType: 'image/png', data: toBase64(imageBytes()) }
beforeEach(() => { clearCommanderImageCache(); vi.clearAllMocks() })

describe('Commander image cache', () => {
  it('coalesces concurrent requests and validates fetched data URLs', async () => {
    getImage.mockResolvedValueOnce(png)
    const [a, b] = await Promise.all([loadCommanderImage('a'), loadCommanderImage('a')])
    expect(a).toBe(`data:image/png;base64,${png.data}`)
    expect(a).toBe(b)
    expect(getImage).toHaveBeenCalledTimes(1)
    getImage.mockResolvedValueOnce({ ...png, mimeType: 'image/svg+xml', data: btoa('<svg onload="alert(1)"/>') })
    expect(await loadCommanderImage('bad')).toBeNull()
    expect(cachedCommanderImage('bad')).toBeUndefined()
  })

  it('does not resurrect images when an in-flight load finishes after clearing history', async () => {
    let complete!: (value: ChatImageInput) => void
    getImage.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const pending = loadCommanderImage('a')
    clearCommanderImageCache()
    complete(png)
    expect(await pending).toBeNull()
    expect(cachedCommanderImage('a')).toBeUndefined()
  })

  it('bounds cached image bytes as well as the number of entries', () => {
    // Base64 for a 2 MiB PNG, cheap to construct without the test byte helper.
    const data = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10) + '\0'.repeat(2 * 1024 * 1024 - 8))
    for (let i = 0; i < 8; i++) seedCommanderImages([{ id: String(i), name: png.name, mime_type: 'image/png', size: 2 * 1024 * 1024 }], [{ ...png, data }])
    expect(cachedCommanderImage('0')).toBeUndefined()
    expect(cachedCommanderImage('7')).toBeDefined()
  })

  it('limits concurrent full-image IPC reads', async () => {
    const complete: Array<(value: ChatImageInput) => void> = []
    getImage.mockImplementation(() => new Promise((resolve) => complete.push(resolve)))
    const requests = Array.from({ length: 6 }, (_, i) => loadCommanderImage(String(i)))
    expect(getImage).toHaveBeenCalledTimes(4)
    complete[0](png)
    await requests[0]
    expect(getImage).toHaveBeenCalledTimes(5)
    complete[1](png)
    await requests[1]
    expect(getImage).toHaveBeenCalledTimes(6)
    complete.slice(2).forEach((resolve) => resolve(png))
    await Promise.all(requests)
  })
})
