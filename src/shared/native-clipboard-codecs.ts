import type { DesktopCommandMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { base64ByteLength } from './chat-images'
import { isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const NATIVE_CLIPBOARD_OPERATIONS = ['chatImages:readClipboard'] as const
export const NATIVE_CLIPBOARD_LIMITS = Object.freeze({ images: 1, errors: 1, imageBytes: 512 * 1024, base64Chars: 4 * Math.ceil((512 * 1024) / 3), wireBytes: 890000 })
export const NATIVE_CLIPBOARD_ERRORS = Object.freeze({
  unavailable: 'Clipboard image reading is unavailable in this desktop host.',
  copiedFiles: 'Copied image files are not available here yet.',
  tooLarge: 'The clipboard image exceeds the supported size.',
  unsupported: 'The clipboard image format is not supported here.',
  failed: 'The clipboard image could not be read.'
})
type Arguments = DesktopCommandMap['chatImages:readClipboard']['apiArguments']
type Result = DesktopCommandMap['chatImages:readClipboard']['result']
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }

/** Native JSON has data properties only. Reject hidden keys and accessors so
 * validation cannot serialize a different value or export extra host fields. */
function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const own = Reflect.ownKeys(value)
  return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)) && keys.every(key => {
    const field = Object.getOwnPropertyDescriptor(value, key)
    return field?.enumerable === true && Object.hasOwn(field, 'value')
  })
}
function finiteArray(value: unknown, max: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) return false
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index))
    if (field?.enumerable !== true || !Object.hasOwn(field, 'value')) return false
  }
  return true
}
/** Size and pad-bit checks precede even the bounded signature decode. This
 * accepts canonical plain base64 only; no full image buffer is allocated. */
function png(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > NATIVE_CLIPBOARD_LIMITS.base64Chars || value.length % 4 !== 0) return false
  const size = base64ByteLength(value)
  if (size < pngMagic.length || size > NATIVE_CLIPBOARD_LIMITS.imageBytes || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const last = alphabet.indexOf(value[value.length - padding - 1]!)
  if (last < 0 || padding === 2 && (last & 15) !== 0 || padding === 1 && (last & 3) !== 0) return false
  let bits = 0, buffer = 0, byte = 0
  for (let index = 0; byte < pngMagic.length && index < value.length; index++) {
    const symbol = alphabet.indexOf(value[index]!)
    if (symbol < 0) return false
    buffer = (buffer << 6) | symbol; bits += 6
    if (bits >= 8) {
      bits -= 8
      if (((buffer >> bits) & 255) !== pngMagic[byte++]) return false
      buffer &= (1 << bits) - 1
    }
  }
  return byte === pngMagic.length
}
function envelopeFits(value: unknown): boolean {
  return new TextEncoder().encode(JSON.stringify({ defined: true, value })).byteLength < NATIVE_CLIPBOARD_LIMITS.wireBytes
}
export function isNativeClipboardResult(value: unknown): value is Result {
  if (!exactObject(value, ['images', 'errors']) || !finiteArray(value.images, NATIVE_CLIPBOARD_LIMITS.images) || !finiteArray(value.errors, NATIVE_CLIPBOARD_LIMITS.errors) || value.images.length > 0 && value.errors.length > 0) return false
  if (value.errors.some(error => typeof error !== 'string' || !(Object.values(NATIVE_CLIPBOARD_ERRORS) as readonly string[]).includes(error))) return false
  for (const image of value.images) if (!exactObject(image, ['name', 'mimeType', 'data']) || image.name !== 'image.png' || image.mimeType !== 'image/png' || !png(image.data)) return false
  return envelopeFits(value)
}
export interface NativeClipboardCodec {
  encodeArguments(value: Arguments): JsonValue
  decodeArguments(value: JsonValue): Arguments
  validateArguments(value: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): Result
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
const clipboard: NativeClipboardCodec = {
  validateArguments: value => finiteArray(value, 0),
  encodeArguments(value) { if (!finiteArray(value, 0)) return fail('INVALID_ARGUMENTS'); return {} },
  decodeArguments(value) { if (!exactObject(value, [])) return fail('INVALID_ARGUMENTS'); return [] },
  validateResult: isNativeClipboardResult,
  encodeResult(value) { if (!isNativeClipboardResult(value)) return fail('INVALID_RESULT'); return { defined: true, value: value as unknown as JsonValue } },
  decodeResult(value) { if (!isNativeClipboardResult(value)) return fail('INVALID_RESULT'); return value },
  validateWireResult(value) { return exactObject(value, ['defined', 'value']) && value.defined === true && isNativeClipboardResult(value.value) }
}
export const NATIVE_CLIPBOARD_CODECS = { 'chatImages:readClipboard': clipboard }
