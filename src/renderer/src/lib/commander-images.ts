import type { ChatImageInput, ChatImageRef } from '@shared/chat-images'
import { commanderApi } from '@/lib/ipc-client'

/**
 * Thumbnails of stored Commander images (#144). Messages carry metadata
 * only; the bytes are fetched once per image and kept as `data:` URLs.
 */

const MAX_CACHED = 60
const cache = new Map<string, string>()
const pending = new Map<string, Promise<string | null>>()

function remember(id: string, url: string): void {
  cache.delete(id)
  cache.set(id, url)
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string)
}

export function cachedCommanderImage(id: string): string | undefined {
  return cache.get(id)
}

/** Stores the bytes a message was just sent with under the ids main gave them. */
export function seedCommanderImages(refs: ChatImageRef[] | undefined, inputs: ChatImageInput[]): void {
  refs?.forEach((ref, index) => {
    const input = inputs[index]
    if (input) remember(ref.id, `data:${input.mimeType};base64,${input.data}`)
  })
}

export function loadCommanderImage(id: string): Promise<string | null> {
  const hit = cache.get(id)
  if (hit) return Promise.resolve(hit)
  let request = pending.get(id)
  if (!request) {
    request = commanderApi.getImage(id)
      .then((image) => {
        if (!image) return null
        const url = `data:${image.mimeType};base64,${image.data}`
        remember(id, url)
        return url
      })
      .catch(() => null)
      .finally(() => pending.delete(id))
    pending.set(id, request)
  }
  return request
}

export function clearCommanderImageCache(): void {
  cache.clear()
  pending.clear()
}
