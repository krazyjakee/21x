import { validateChatImageInputs, type ChatImageInput, type ChatImageRef } from '@shared/chat-images'
import { commanderApi } from '@/lib/ipc-client'

/**
 * Thumbnails of stored Commander images (#144). Messages carry metadata
 * only; the bytes are fetched once per image and kept as `data:` URLs.
 */

const MAX_CACHED = 60
const MAX_CACHE_BYTES = 32 * 1024 * 1024
let cachedBytes = 0
let generation = 0
const cache = new Map<string, string>()
const pending = new Map<string, Promise<string | null>>()
let activeReads = 0
const readQueue: Array<() => void> = []

async function readImage(id: string, started: number): Promise<ChatImageInput | null> {
  if (activeReads >= 4) await new Promise<void>((resolve) => readQueue.push(resolve))
  else activeReads += 1
  try {
    if (started !== generation) return null
    return await commanderApi.getImage(id)
  } finally {
    const next = readQueue.shift()
    if (next) next()
    else activeReads -= 1
  }
}

function remember(id: string, url: string): void {
  cachedBytes -= (cache.get(id)?.length ?? 0) * 2
  cache.delete(id)
  cache.set(id, url)
  cachedBytes += url.length * 2
  while (cache.size > MAX_CACHED || cachedBytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next().value as string
    cachedBytes -= cache.get(oldest)!.length * 2
    cache.delete(oldest)
  }
}

export function cachedCommanderImage(id: string): string | undefined {
  return cache.get(id)
}

/** Stores the bytes a message was just sent with under the ids main gave them. */
export function seedCommanderImages(refs: ChatImageRef[] | undefined, inputs: ChatImageInput[]): void {
  refs?.forEach((ref, index) => {
    const input = inputs[index]
    if (input) {
      const [validated] = validateChatImageInputs([input])
      remember(ref.id, `data:${validated.mimeType};base64,${validated.data}`)
    }
  })
}

export function loadCommanderImage(id: string): Promise<string | null> {
  const hit = cache.get(id)
  if (hit) return Promise.resolve(hit)
  let request = pending.get(id)
  if (!request) {
    const started = generation
    request = readImage(id, started)
      .then((image) => {
        if (!image || started !== generation) return null
        const [validated] = validateChatImageInputs([image])
        const url = `data:${validated.mimeType};base64,${validated.data}`
        remember(id, url)
        return url
      })
      .catch(() => null)
      .finally(() => { if (pending.get(id) === request) pending.delete(id) })
    pending.set(id, request)
  }
  return request
}

export function clearCommanderImageCache(): void {
  generation += 1
  cachedBytes = 0
  cache.clear()
  pending.clear()
}
