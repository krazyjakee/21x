import { sniffChatImageMimeType, type ChatImageMimeType } from './chat-images'

export const ATTACHMENT_RASTER_LIMITS = Object.freeze({ edge: 4096, pixels: 8 * 1024 * 1024, frames: 32, chunks: 4096 })
export interface AttachmentRaster { width: number; height: number; frames: number }
/** Header/container admission, not an entropy decoder. Never allocates a raster.
 * PNG/JPEG/GIF/WebP layout references are recorded in the domain documentation.
 * Unknown/compressed PNG metadata, APNG and animated WebP remain unavailable. */
export function attachmentRaster(bytes: Uint8Array, mime: ChatImageMimeType): AttachmentRaster | null {
  if (bytes.length > 512 * 1024 || sniffChatImageMimeType(bytes) !== mime) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const word = (offset: number, little = false) => view.getUint16(offset, little)
  const dword = (offset: number, little = false) => view.getUint32(offset, little)
  const text = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length))
  const valid = (width: number, height: number, frames = 1): AttachmentRaster | null =>
    width > 0 && height > 0 && width <= ATTACHMENT_RASTER_LIMITS.edge && height <= ATTACHMENT_RASTER_LIMITS.edge && frames > 0 && frames <= ATTACHMENT_RASTER_LIMITS.frames && width * height * frames <= ATTACHMENT_RASTER_LIMITS.pixels ? { width, height, frames } : null
  try {
    if (mime === 'image/png') {
      if (bytes.length < 45 || dword(8) !== 13 || text(12, 4) !== 'IHDR') return null
      const result = valid(dword(16), dword(20))
      if (!result || ![1, 2, 4, 8].includes(bytes[24]) || ![0, 2, 3, 4, 6].includes(bytes[25]) || bytes[25] !== 0 && bytes[25] !== 3 && bytes[24] !== 8 || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) return null
      const permitted = new Set(['PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'sBIT', 'bKGD', 'hIST', 'tIME'])
      let offset = 33, chunks = 0, data = false
      while (offset + 12 <= bytes.length && chunks++ < ATTACHMENT_RASTER_LIMITS.chunks) {
        const length = dword(offset), kind = text(offset + 4, 4), next = offset + 12 + length
        if (next > bytes.length || !permitted.has(kind)) return null
        if (kind === 'IDAT') data = true
        if (kind === 'IEND') return data && length === 0 && next === bytes.length ? result : null
        offset = next
      }
      return null
    }
    if (mime === 'image/jpeg') {
      let offset = 2, segments = 0, scans = 0, entropy = false, result: AttachmentRaster | null = null
      while (offset < bytes.length && segments++ < ATTACHMENT_RASTER_LIMITS.chunks) {
        if (entropy) {
          while (offset < bytes.length) {
            if (bytes[offset] !== 255) { offset++; continue }
            if (bytes[offset + 1] === 0 || bytes[offset + 1] >= 0xd0 && bytes[offset + 1] <= 0xd7) { offset += 2; continue }
            break
          }
        }
        if (bytes[offset++] !== 255) return null
        while (bytes[offset] === 255) offset++
        const marker = bytes[offset++]
        if (marker === 0xd9) return result && scans && offset === bytes.length ? result : null
        const length = word(offset)
        if (length < 2 || offset + length > bytes.length) return null
        if (marker === 0xc0 || marker === 0xc2) {
          if (result || bytes[offset + 2] !== 8 || bytes[offset + 7] < 1 || bytes[offset + 7] > 4 || length !== 8 + 3 * bytes[offset + 7]) return null
          result = valid(word(offset + 5), word(offset + 3))
          if (!result) return null
        } else if (marker === 0xda) {
          if (!result || ++scans > 64 || bytes[offset + 2] < 1 || bytes[offset + 2] > 4 || length !== 6 + 2 * bytes[offset + 2]) return null
          entropy = true
        } else {
          // DNL/hierarchical/arithmetic/extra frame headers cannot redefine an
          // admitted canvas after the initial frame. Tables/metadata are finite.
          if (![0xc4, 0xdb, 0xdd, 0xfe].includes(marker) && !(marker >= 0xe0 && marker <= 0xef)) return null
          entropy = false
        }
        offset += length
      }
      return null
    }
    if (mime === 'image/gif') {
      if (bytes.length < 14) return null
      const width = word(6, true), height = word(8, true)
      if (!valid(width, height)) return null
      let offset = 13 + (bytes[10] & 128 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0), frames = 0, blocks = 0
      const skip = (): boolean => {
        while (offset < bytes.length && blocks++ < ATTACHMENT_RASTER_LIMITS.chunks) {
          const length = bytes[offset++]
          if (!length) return true
          offset += length
          if (offset > bytes.length) return false
        }
        return false
      }
      while (offset < bytes.length && blocks++ < ATTACHMENT_RASTER_LIMITS.chunks) {
        const kind = bytes[offset++]
        if (kind === 0x3b) return offset === bytes.length ? valid(width, height, frames) : null
        if (kind === 0x21) {
          const label = bytes[offset++]
          if (![0xf9, 0xfe, 0xff].includes(label) || !skip()) return null
        } else if (kind === 0x2c) {
          if (offset + 9 > bytes.length || !valid(width, height, ++frames)) return null
          const left = word(offset, true), top = word(offset + 2, true), w = word(offset + 4, true), h = word(offset + 6, true), flags = bytes[offset + 8]
          if (!w || !h || left + w > width || top + h > height || flags & 0x18) return null
          offset += 9 + (flags & 128 ? 3 * 2 ** ((flags & 7) + 1) : 0)
          const codeSize = bytes[offset++]
          if (codeSize < 2 || codeSize > 8 || !skip()) return null
        } else return null
      }
      return null
    }
    if (mime === 'image/webp') {
      if (bytes.length < 20 || dword(4, true) + 8 !== bytes.length) return null
      let offset = 12, chunks = 0, canvas: AttachmentRaster | null = null, image: AttachmentRaster | null = null
      while (offset + 8 <= bytes.length && chunks++ < ATTACHMENT_RASTER_LIMITS.chunks) {
        const kind = text(offset, 4), length = dword(offset + 4, true), start = offset + 8, next = start + length + (length % 2)
        if (next > bytes.length) return null
        if (kind === 'VP8X') {
          if (offset !== 12 || canvas || length !== 10 || bytes[start] & 0xc3 || bytes[start + 1] || bytes[start + 2] || bytes[start + 3]) return null
          const number = (at: number) => bytes[at] + 256 * bytes[at + 1] + 65536 * bytes[at + 2] + 1
          canvas = valid(number(start + 4), number(start + 7))
          if (!canvas) return null
        } else if (kind === 'VP8 ' || kind === 'VP8L') {
          if (image) return null
          if (kind === 'VP8 ') {
            if (length < 10 || bytes[start] & 1 || text(start + 3, 3) !== '\u009d\u0001\u002a' || word(start + 6, true) & 0xc000 || word(start + 8, true) & 0xc000) return null
            image = valid(word(start + 6, true), word(start + 8, true))
          } else {
            if (length < 5 || bytes[start] !== 0x2f) return null
            const bits = dword(start + 1, true)
            if (bits >>> 29) return null
            image = valid((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
          }
          if (!image) return null
        } else if (!['ALPH', 'ICCP', 'EXIF', 'XMP '].includes(kind)) return null
        offset = next
      }
      return offset === bytes.length && image && (!canvas || canvas.width === image.width && canvas.height === image.height) ? image : null
    }
  } catch { return null }
  return null
}
