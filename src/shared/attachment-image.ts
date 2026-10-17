import { attachmentRaster } from './attachment-raster'
import { isChatImageMimeType, sniffChatImageMimeType, type ChatImageMimeType } from './chat-images'
import { hasExactKeys, isRecord } from './service-protocol'

/** Saved raster bytes only. No filename, path, URL or native grant is returned. */
export interface AttachmentImage { mimeType: ChatImageMimeType; data: string }
export const ATTACHMENT_IMAGE_BYTES = 512 * 1024
export function isAttachmentImage(value: unknown): value is AttachmentImage {
  if (!isRecord(value) || !hasExactKeys(value, ['mimeType', 'data']) || !isChatImageMimeType(value.mimeType) || typeof value.data !== 'string') return false
  const data = value.data
  if (!data.length || data.length > Math.ceil(ATTACHMENT_IMAGE_BYTES / 3) * 4 || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return false
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  if (data.endsWith('==') && (alphabet.indexOf(data[data.length - 3]) & 15) || data.endsWith('=') && !data.endsWith('==') && (alphabet.indexOf(data[data.length - 2]) & 3)) return false
  const bytes = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
  if (bytes < 3 || bytes > ATTACHMENT_IMAGE_BYTES) return false
  try {
    const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0))
    return sniffChatImageMimeType(bytes) === value.mimeType && attachmentRaster(bytes, value.mimeType) !== null
  } catch { return false }
}
