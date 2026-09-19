import { readFile, stat } from 'fs/promises'
import { fileURLToPath } from 'url'
import {
  CHAT_IMAGE_MIME_TYPES,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGES_PER_MESSAGE,
  chatImageErrors,
  chatImageExtension,
  chatImageMimeTypeForName,
  sanitizeChatImageName,
  sniffChatImageMimeType,
  type ChatImageInput
} from '../../shared/chat-images'

/**
 * Reads images from the OS clipboard in main (#144), for the pastes where
 * Chromium's paste event carries no image:
 *
 * - a file copied in a Linux file manager (`text/uri-list`, or GNOME's
 *   `x-special/gnome-copied-files`) or in Finder (`public.file-url`) arrives
 *   in the renderer as a path or a file icon, not the file;
 * - an image offered under a type the renderer's paste event does not map.
 *
 * Electron's clipboard is asynchronous from v44 (`clipboard.read()` returns
 * W3C-style items), so this module takes that shape and never the removed
 * `readImage()`.
 */

export interface ClipboardItemLike {
  readonly types: string[]
  getType(type: string): Promise<Blob | unknown>
}

export interface ClipboardImageDeps {
  read: () => Promise<ClipboardItemLike[]>
  readFile?: (path: string) => Promise<Uint8Array>
  fileSize?: (path: string) => Promise<number>
}

export interface ClipboardImagesResult {
  images: ChatImageInput[]
  /** One user-facing line per file that could not be attached. */
  errors: string[]
}

export const MACOS_FILE_URL_FORMAT = 'electron application/osclipboard;format="public.file-url"'
const URI_LIST_FORMAT = 'text/uri-list'
const GNOME_COPIED_FILES_FORMAT = 'x-special/gnome-copied-files'

async function blobText(value: unknown): Promise<string> {
  if (typeof value === 'string') return value
  if (value && typeof (value as Blob).text === 'function') return (value as Blob).text()
  return ''
}

async function blobBytes(value: unknown): Promise<Uint8Array | null> {
  if (value && typeof (value as Blob).arrayBuffer === 'function') return new Uint8Array(await (value as Blob).arrayBuffer())
  return null
}

/** file:// URLs out of a uri-list, a GNOME file list or a single file URL. */
export function parseFileUrls(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\0/g, ''))
    .filter((line) => line.startsWith('file://'))
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

export async function readClipboardImages(deps: ClipboardImageDeps): Promise<ClipboardImagesResult> {
  const readBytes = deps.readFile ?? (async (path: string) => new Uint8Array(await readFile(path)))
  const fileSize = deps.fileSize ?? (async (path: string) => (await stat(path)).size)
  const images: ChatImageInput[] = []
  const errors: string[] = []
  const items = await deps.read()

  // Copied files first: a copied file also puts its icon or a preview on the
  // clipboard, and the user meant the file.
  const urls: string[] = []
  for (const item of items) {
    for (const format of [URI_LIST_FORMAT, GNOME_COPIED_FILES_FORMAT, MACOS_FILE_URL_FORMAT]) {
      if (!item.types.includes(format)) continue
      try {
        for (const url of parseFileUrls(await blobText(await item.getType(format)))) {
          if (!urls.includes(url)) urls.push(url)
        }
      } catch {
        // An unreadable format is only one of several places to look.
      }
    }
  }
  for (const url of urls) {
    if (images.length >= MAX_CHAT_IMAGES_PER_MESSAGE) {
      errors.push(chatImageErrors.tooMany())
      break
    }
    let path: string
    try {
      path = fileURLToPath(url)
    } catch {
      continue
    }
    const declared = chatImageMimeTypeForName(path)
    const name = sanitizeChatImageName(path, declared ?? 'image/png')
    // Copied files that are not images are not this feature's business.
    if (!declared) continue
    try {
      const size = await fileSize(path)
      if (size > MAX_CHAT_IMAGE_BYTES) {
        errors.push(chatImageErrors.tooLarge(name, size))
        continue
      }
      const bytes = await readBytes(path)
      const mimeType = sniffChatImageMimeType(bytes)
      if (!mimeType) {
        errors.push(chatImageErrors.unsupportedType(name))
        continue
      }
      images.push({ name: sanitizeChatImageName(path, mimeType), mimeType, data: toBase64(bytes) })
    } catch {
      errors.push(chatImageErrors.readFailed(name))
    }
  }
  if (urls.length > 0) return { images, errors }

  // No copied file: take the first supported image the clipboard offers.
  for (const item of items) {
    const type = CHAT_IMAGE_MIME_TYPES.find((mime) => item.types.includes(mime))
    if (!type) continue
    try {
      const bytes = await blobBytes(await item.getType(type))
      if (!bytes || bytes.byteLength === 0) continue
      const name = `image.${chatImageExtension(type)}`
      if (bytes.byteLength > MAX_CHAT_IMAGE_BYTES) {
        errors.push(chatImageErrors.tooLarge(name, bytes.byteLength))
        break
      }
      const mimeType = sniffChatImageMimeType(bytes)
      if (!mimeType) {
        errors.push(chatImageErrors.unsupportedType(name))
        break
      }
      images.push({ name: `image.${chatImageExtension(mimeType)}`, mimeType, data: toBase64(bytes) })
    } catch {
      errors.push(chatImageErrors.readFailed('the clipboard image'))
    }
    break
  }
  return { images, errors }
}
