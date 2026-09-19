import { useCallback, useMemo, useRef, useState, type ClipboardEvent } from 'react'
import {
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGE_TOTAL_BYTES,
  MAX_CHAT_IMAGES_PER_MESSAGE,
  chatImageErrors,
  chatImageExtension,
  chatImageMimeTypeForName,
  isChatImageMimeType,
  sanitizeChatImageName,
  sniffChatImageMimeType,
  type ChatImageInput,
  type ChatImageMimeType
} from '@shared/chat-images'
import { chatImageApi } from '@/lib/ipc-client'

/**
 * Image attachments for any chat composer (#144): paste, validation,
 * previews, announcements and the send payload. The composer wires three
 * things: `handlePaste` on its text field, an `<AttachmentTray>` fed from this
 * controller, and `toInputs()`/`clear()`/`restore()` around its send.
 *
 * Paste rules:
 * - image files on the clipboard (a screenshot, a copied image, a copied image
 *   file) are attached;
 * - text on the same clipboard still pastes as normal (mixed paste);
 * - a text-only paste is left completely alone;
 * - a paste that references files but carries none (a copied file on some
 *   Linux file managers) asks main to read the clipboard; if that finds no
 *   image, the text is inserted as the browser would have.
 */

export interface ChatImageAttachment {
  id: string
  name: string
  mimeType: ChatImageMimeType
  size: number
  /** Base64 without prefix: what is sent. */
  data: string
  /** `data:` URL for the thumbnail. */
  previewUrl: string
}

export interface ChatAttachmentAnnouncement {
  /** Changes on every announcement so a repeated message is read again. */
  key: number
  text: string
}

export interface UseChatAttachmentsOptions {
  /**
   * When set, this chat cannot take images: a pasted image is refused with
   * this message and any text on the clipboard pastes normally.
   */
  unsupportedReason?: string | null
  /** Main-process clipboard fallback; injectable for tests. */
  readClipboard?: () => Promise<{ images: ChatImageInput[]; errors: string[] }>
  /** Clock for generated names; injectable for tests. */
  now?: () => Date
}

export interface ChatAttachmentsController {
  attachments: ChatImageAttachment[]
  errors: string[]
  announcement: ChatAttachmentAnnouncement | null
  /** True while pasted images are being read; sending should wait. */
  isReading: boolean
  handlePaste: (event: ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>) => void
  addFiles: (files: File[]) => Promise<void>
  addInputs: (inputs: ChatImageInput[]) => void
  remove: (id: string) => void
  /** Drops every attachment without announcing (after a send). */
  clear: () => void
  /** Puts attachments back (a send failed). */
  restore: (attachments: ChatImageAttachment[]) => void
  reportError: (message: string) => void
  dismissError: (index: number) => void
  clearErrors: () => void
  /** The current attachments as the send payload. */
  toInputs: () => ChatImageInput[]
}

let nextId = 0
const newId = (): string => `chat-image-${Date.now().toString(36)}-${(nextId++).toString(36)}`

/** Chromium names every clipboard bitmap `image.png`; those get a readable, unique-ish name. */
const GENERIC_NAME = /^(image|blob|unknown|clipboard)?(\.[a-z0-9]+)?$/i

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function pastedImageName(mimeType: ChatImageMimeType, date: Date, index: number): string {
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `pasted-image-${stamp}${index > 0 ? `-${index + 1}` : ''}.${chatImageExtension(mimeType)}`
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function base64ToBytesHead(data: string, count: number): Uint8Array {
  const binary = atob(data.slice(0, Math.ceil(count / 3) * 4))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer())
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsArrayBuffer(file)
  })
}

/** Every file on a clipboard, once each (`files` and `items` overlap). */
export function clipboardFiles(data: DataTransfer): File[] {
  const out: File[] = []
  const seen = new Set<File>()
  const add = (file: File | null): void => {
    if (!file || seen.has(file)) return
    // Chromium can hand the same image out as two File objects.
    if (out.some((f) => f.name === file.name && f.size === file.size && f.type === file.type)) return
    seen.add(file)
    out.push(file)
  }
  for (const file of Array.from(data.files ?? [])) add(file)
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file') add(item.getAsFile())
  }
  return out
}

function isImageCandidate(file: File): boolean {
  return file.type.startsWith('image/') || (!file.type && chatImageMimeTypeForName(file.name) !== null)
}

/** Inserts text at the caret the way a native paste would, undo included where supported. */
export function insertPlainText(field: HTMLTextAreaElement | HTMLInputElement, text: string): void {
  field.focus()
  const exec = (document as Document & { execCommand?: (cmd: string, ui: boolean, value: string) => boolean }).execCommand
  if (typeof exec === 'function') {
    try {
      if (exec.call(document, 'insertText', false, text)) return
    } catch {
      // Fall through to the manual insert.
    }
  }
  const start = field.selectionStart ?? field.value.length
  const end = field.selectionEnd ?? start
  field.setRangeText(text, start, end, 'end')
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

function announceAdded(added: ChatImageAttachment[]): string {
  return added.length === 1 ? `Image attached: ${added[0].name}` : `${added.length} images attached`
}

export function useChatAttachments(options: UseChatAttachmentsOptions = {}): ChatAttachmentsController {
  const { unsupportedReason = null } = options
  // Read through a ref so callers may pass fresh functions without making
  // every callback (and the composer's props) change on each render.
  const injected = useRef(options)
  injected.current = options
  // Resolved on use: a paste is the only time main is asked.
  const readClipboard = useCallback(
    () => (injected.current.readClipboard ?? (() => chatImageApi.readClipboard()))(),
    []
  )
  const now = useCallback(() => (injected.current.now ?? (() => new Date()))(), [])
  const [attachments, setAttachments] = useState<ChatImageAttachment[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [announcement, setAnnouncement] = useState<ChatAttachmentAnnouncement | null>(null)
  const [readingCount, setReadingCount] = useState(0)
  // The source of truth for limits while reads are in flight: state lags.
  const current = useRef<ChatImageAttachment[]>([])
  const reserved = useRef({ count: 0, bytes: 0 })
  const announceKey = useRef(0)

  const commit = useCallback((next: ChatImageAttachment[]) => {
    current.current = next
    setAttachments(next)
  }, [])

  const announce = useCallback((text: string) => {
    announceKey.current += 1
    setAnnouncement({ key: announceKey.current, text })
  }, [])

  const reportError = useCallback((message: string) => {
    setErrors((prev) => (prev.includes(message) ? prev : [...prev, message]))
  }, [])

  /** Checks count and totals, reserving room for an image being read. */
  const reserve = useCallback((name: string, size: number): string | null => {
    const count = current.current.length + reserved.current.count
    const bytes = current.current.reduce((sum, a) => sum + a.size, 0) + reserved.current.bytes
    if (size > MAX_CHAT_IMAGE_BYTES) return chatImageErrors.tooLarge(name, size)
    if (count >= MAX_CHAT_IMAGES_PER_MESSAGE) return chatImageErrors.tooMany()
    if (bytes + size > MAX_CHAT_IMAGE_TOTAL_BYTES) return chatImageErrors.totalTooLarge()
    reserved.current = { count: reserved.current.count + 1, bytes: reserved.current.bytes + size }
    return null
  }, [])

  const release = useCallback((size: number) => {
    reserved.current = { count: reserved.current.count - 1, bytes: reserved.current.bytes - size }
  }, [])

  const displayName = useCallback((rawName: string, mimeType: ChatImageMimeType, index: number): string => {
    const cleaned = sanitizeChatImageName(rawName, mimeType)
    return GENERIC_NAME.test(rawName.trim()) ? pastedImageName(mimeType, now(), index) : cleaned
  }, [now])

  const addFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    if (unsupportedReason) {
      reportError(unsupportedReason)
      return
    }
    setErrors([])
    const added: ChatImageAttachment[] = []
    setReadingCount((n) => n + 1)
    try {
      for (const [index, file] of files.entries()) {
        const declared = isChatImageMimeType(file.type) ? file.type : file.type ? null : chatImageMimeTypeForName(file.name)
        const label = file.name?.trim() || 'The pasted image'
        if (!declared) {
          reportError(chatImageErrors.unsupportedType(label))
          continue
        }
        const name = displayName(file.name ?? '', declared, index)
        const refusal = reserve(name, file.size)
        if (refusal) {
          reportError(refusal)
          if (refusal === chatImageErrors.tooMany()) break
          continue
        }
        try {
          const bytes = await readFileBytes(file)
          const mimeType = sniffChatImageMimeType(bytes)
          if (!mimeType) {
            reportError(chatImageErrors.unsupportedType(name))
            continue
          }
          const data = bytesToBase64(bytes)
          const attachment: ChatImageAttachment = {
            id: newId(),
            name,
            mimeType,
            size: bytes.byteLength,
            data,
            previewUrl: `data:${mimeType};base64,${data}`
          }
          added.push(attachment)
          commit([...current.current, attachment])
        } catch {
          reportError(chatImageErrors.readFailed(name))
        } finally {
          release(file.size)
        }
      }
    } finally {
      setReadingCount((n) => n - 1)
    }
    if (added.length > 0) announce(announceAdded(added))
  }, [announce, commit, displayName, release, reportError, reserve, unsupportedReason])

  /** Images read by main (the clipboard fallback), already base64. */
  const addInputs = useCallback((inputs: ChatImageInput[]) => {
    if (inputs.length === 0) return
    if (unsupportedReason) {
      reportError(unsupportedReason)
      return
    }
    const added: ChatImageAttachment[] = []
    for (const [index, input] of inputs.entries()) {
      const size = Math.floor((input.data.length * 3) / 4) - (input.data.endsWith('==') ? 2 : input.data.endsWith('=') ? 1 : 0)
      const mimeType = sniffChatImageMimeType(base64ToBytesHead(input.data, 12))
      const name = displayName(input.name, mimeType ?? 'image/png', index)
      if (!mimeType) {
        reportError(chatImageErrors.unsupportedType(name))
        continue
      }
      const refusal = reserve(name, size)
      if (refusal) {
        reportError(refusal)
        if (refusal === chatImageErrors.tooMany()) break
        continue
      }
      release(size)
      const attachment: ChatImageAttachment = {
        id: newId(), name, mimeType, size, data: input.data, previewUrl: `data:${mimeType};base64,${input.data}`
      }
      added.push(attachment)
      commit([...current.current, attachment])
    }
    if (added.length > 0) announce(announceAdded(added))
  }, [announce, commit, displayName, release, reportError, reserve, unsupportedReason])

  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    const data = event.clipboardData
    if (!data) return
    const files = clipboardFiles(data)
    const images = files.filter(isImageCandidate)
    const types = Array.from(data.types ?? [])
    const text = data.getData('text/plain')

    if (images.length > 0) {
      // Mixed paste: the text still goes in through the browser's own paste.
      if (!text) event.preventDefault()
      void addFiles(images)
      return
    }
    if (files.length > 0) {
      // Only non-image files (a PDF, say): unsupported for chat images.
      if (!text) {
        event.preventDefault()
        if (!unsupportedReason) for (const file of files) reportError(chatImageErrors.unsupportedType(file.name || 'The pasted file'))
      }
      return
    }
    if (unsupportedReason) return

    const referencesFiles = types.includes('Files') || types.includes('text/uri-list')
    const carriesNothing = !text && !types.includes('text/html')
    if (!referencesFiles && !carriesNothing) return // plain text: untouched

    const field = event.currentTarget
    // A file reference would otherwise paste as a path; hold it until main has looked.
    if (referencesFiles) event.preventDefault()
    setReadingCount((n) => n + 1)
    void readClipboard()
      .then((result) => {
        for (const error of result.errors) reportError(error)
        if (result.images.length > 0) addInputs(result.images)
        else if (referencesFiles && text) insertPlainText(field, text)
      })
      .catch(() => {
        if (referencesFiles && text) insertPlainText(field, text)
        else reportError(chatImageErrors.readFailed('the clipboard image'))
      })
      .finally(() => setReadingCount((n) => n - 1))
  }, [addFiles, addInputs, readClipboard, reportError, unsupportedReason])

  const remove = useCallback((id: string) => {
    const target = current.current.find((a) => a.id === id)
    if (!target) return
    commit(current.current.filter((a) => a.id !== id))
    announce(`Image removed: ${target.name}`)
  }, [announce, commit])

  const clear = useCallback(() => {
    commit([])
    setErrors([])
  }, [commit])

  const restore = useCallback((list: ChatImageAttachment[]) => {
    const ids = new Set(current.current.map((a) => a.id))
    commit([...list.filter((a) => !ids.has(a.id)), ...current.current].slice(0, MAX_CHAT_IMAGES_PER_MESSAGE))
  }, [commit])

  const dismissError = useCallback((index: number) => {
    setErrors((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const clearErrors = useCallback(() => setErrors([]), [])

  const toInputs = useCallback(
    () => current.current.map(({ name, mimeType, data }) => ({ name, mimeType, data })),
    []
  )

  return useMemo(() => ({
    attachments,
    errors,
    announcement,
    isReading: readingCount > 0,
    handlePaste,
    addFiles,
    addInputs,
    remove,
    clear,
    restore,
    reportError,
    dismissError,
    clearErrors,
    toInputs
  }), [addFiles, addInputs, announcement, attachments, clear, clearErrors, dismissError, errors, handlePaste, readingCount, remove, reportError, restore, toInputs])
}
