/**
 * Test fixtures for chat image paste (#144): real image bytes and a
 * clipboard shaped like the one Chromium hands a paste event.
 */

export const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
export const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0]
export const BMP_MAGIC = [0x42, 0x4d]

export function imageBytes(magic: number[] = PNG_MAGIC, size = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(size))
  bytes.set(magic.slice(0, size))
  return bytes
}

export function imageFile(name = 'shot.png', type = 'image/png', size = 64, magic?: number[]): File {
  const bytes = imageBytes(magic ?? (type === 'image/jpeg' ? JPEG_MAGIC : type === 'image/bmp' ? BMP_MAGIC : PNG_MAGIC), size)
  return new File([bytes], name, { type })
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export interface FakeClipboard {
  files: File[]
  items: Array<{ kind: 'file' | 'string'; type: string; getAsFile: () => File | null }>
  types: string[]
  getData: (type: string) => string
}

/** What `event.clipboardData` looks like for a paste of these files and strings. */
export function clipboard({ files = [], text = '', html = '', uriList = '' }: {
  files?: File[]
  text?: string
  html?: string
  uriList?: string
} = {}): FakeClipboard {
  const strings: Record<string, string> = {}
  if (text) strings['text/plain'] = text
  if (html) strings['text/html'] = html
  if (uriList) strings['text/uri-list'] = uriList
  return {
    files,
    items: [
      ...files.map((file) => ({ kind: 'file' as const, type: file.type, getAsFile: () => file })),
      ...Object.keys(strings).map((type) => ({ kind: 'string' as const, type, getAsFile: () => null }))
    ],
    types: [...Object.keys(strings), ...(files.length > 0 ? ['Files'] : [])],
    getData: (type: string) => strings[type] ?? ''
  }
}
