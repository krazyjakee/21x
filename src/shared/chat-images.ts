/**
 * Images attached to a chat message (issue #144).
 *
 * One set of limits and one validator, shared by every chat surface: the
 * renderer checks a pasted image before it shows a chip, and main checks the
 * same bytes again before anything is stored or sent, because a renderer is
 * never trusted with what reaches a provider.
 */

export const CHAT_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ChatImageMimeType = (typeof CHAT_IMAGE_MIME_TYPES)[number]

/** 5 MB: the per-image ceiling of the Anthropic Messages API, the strictest provider. */
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024
/** Per message. */
export const MAX_CHAT_IMAGES_PER_MESSAGE = 5
/**
 * All images of one message together. Base64 grows data by a third, and the
 * Anthropic API refuses requests over 32 MB, so five full-size images would
 * not fit in one request.
 */
export const MAX_CHAT_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024
export const MAX_CHAT_IMAGE_NAME_CHARS = 120

/** What crosses IPC when a message is sent: the bytes, base64 without a data: prefix. */
export interface ChatImageInput {
  name: string
  mimeType: ChatImageMimeType
  /** Base64, no `data:` prefix. */
  data: string
}

/** A stored image's metadata. The bytes are fetched separately so events stay small. */
export interface ChatImageRef {
  id: string
  name: string
  mime_type: ChatImageMimeType
  size: number
}

export function isChatImageMimeType(value: unknown): value is ChatImageMimeType {
  return typeof value === 'string' && (CHAT_IMAGE_MIME_TYPES as readonly string[]).includes(value)
}

const EXTENSION_MIME: Record<string, ChatImageMimeType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

const MIME_EXTENSION: Record<ChatImageMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

/** The supported image type a file name implies, or null. */
export function chatImageMimeTypeForName(name: string): ChatImageMimeType | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  return ext ? EXTENSION_MIME[ext] ?? null : null
}

export function chatImageExtension(mimeType: ChatImageMimeType): string {
  return MIME_EXTENSION[mimeType]
}

/** The image type the first bytes prove, or null. Never trusts a declared type. */
export function sniffChatImageMimeType(bytes: Uint8Array): ChatImageMimeType | null {
  const at = (i: number): number => bytes[i] ?? -1
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif'
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
      at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'image/webp'
  return null
}

export function formatImageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Printable, bounded, path-free. */
export function sanitizeChatImageName(name: unknown, mimeType: ChatImageMimeType): string {
  const base = typeof name === 'string' ? name.split(/[\\/]/).pop() ?? '' : ''
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim()
  const fallback = `image.${chatImageExtension(mimeType)}`
  const value = cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback
  return value.length > MAX_CHAT_IMAGE_NAME_CHARS ? value.slice(value.length - MAX_CHAT_IMAGE_NAME_CHARS) : value
}

/** User-facing validation messages, identical on every surface. */
export const chatImageErrors = {
  unsupportedType: (name: string): string =>
    `"${name}" isn't a supported image type. Use PNG, JPEG, GIF or WebP.`,
  tooLarge: (name: string, size: number): string =>
    `"${name}" is ${formatImageBytes(size)}. Images must be ${formatImageBytes(MAX_CHAT_IMAGE_BYTES)} or smaller.`,
  tooMany: (): string => `You can attach up to ${MAX_CHAT_IMAGES_PER_MESSAGE} images to one message.`,
  totalTooLarge: (): string =>
    `The images in one message can add up to ${formatImageBytes(MAX_CHAT_IMAGE_TOTAL_BYTES)} at most.`,
  readFailed: (name: string): string => `Couldn't read "${name}". Copy it again and paste once more.`
} as const

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

/** Decoded size of a base64 string without decoding it. */
export function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}

function decodeBase64Head(data: string, bytes: number): Uint8Array {
  const chars = Math.ceil(bytes / 3) * 4
  const head = data.slice(0, chars)
  const binary = typeof atob === 'function' ? atob(head) : Buffer.from(head, 'base64').toString('binary')
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export interface ValidatedChatImage extends ChatImageInput {
  size: number
}

/**
 * Validates images that arrived over IPC. Throws one user-facing message for
 * the first problem; returns the images with the type the bytes prove.
 */
export function validateChatImageInputs(raw: unknown): ValidatedChatImage[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('Images must be a list')
  if (raw.length > MAX_CHAT_IMAGES_PER_MESSAGE) throw new Error(chatImageErrors.tooMany())
  const out: ValidatedChatImage[] = []
  let total = 0
  for (const item of raw) {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const data = typeof record.data === 'string' ? record.data : ''
    const declared = isChatImageMimeType(record.mimeType) ? record.mimeType : 'image/png'
    const label = sanitizeChatImageName(record.name, declared)
    if (!data || data.length % 4 !== 0 || !BASE64_RE.test(data)) throw new Error(chatImageErrors.readFailed(label))
    const size = base64ByteLength(data)
    if (size > MAX_CHAT_IMAGE_BYTES) throw new Error(chatImageErrors.tooLarge(label, size))
    const sniffed = sniffChatImageMimeType(decodeBase64Head(data, 12))
    if (!sniffed || !isChatImageMimeType(record.mimeType)) throw new Error(chatImageErrors.unsupportedType(label))
    total += size
    if (total > MAX_CHAT_IMAGE_TOTAL_BYTES) throw new Error(chatImageErrors.totalTooLarge())
    out.push({ name: sanitizeChatImageName(record.name, sniffed), mimeType: sniffed, data, size })
  }
  return out
}
