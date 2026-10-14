import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { NATIVE_CLIPBOARD_CODECS, NATIVE_CLIPBOARD_OPERATIONS, NATIVE_CLIPBOARD_ERRORS, NATIVE_CLIPBOARD_LIMITS, isNativeClipboardResult } from './native-clipboard-codecs'
import type { JsonValue } from './service-protocol'

const codec = NATIVE_CLIPBOARD_CODECS['chatImages:readClipboard']
const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
function png(size = 12): string { const bytes = Buffer.alloc(size); magic.copy(bytes); return bytes.toString('base64') }
function image(data = png()) { return { name: 'image.png', mimeType: 'image/png', data } }
const result = (data = png()) => ({ images: [image(data)], errors: [] })

describe('direct native clipboard image contract', () => {
  it('retains only empty preload arguments and exact empty native payload', () => {
    expect(NATIVE_CLIPBOARD_OPERATIONS).toEqual(['chatImages:readClipboard'])
    expect(codec.encodeArguments([])).toEqual({}); expect(codec.decodeArguments({})).toEqual([])
    for (const value of [undefined, null, {}, [null], ['file:///private'], [{ caller: 'main' }]]) expect(codec.validateArguments(value)).toBe(false)
    for (const value of [[], null, { path: '/private' }, { uri: 'file:///private' }, { caller: 'main' }, { leaseId: 'forged' }, { targets: ['image/png'] }]) expect(() => codec.decodeArguments(value as JsonValue)).toThrow('arguments')
    const hidden = Object.defineProperty({}, 'privatePath', { value: '/private', enumerable: false })
    expect(() => codec.decodeArguments(hidden)).toThrow('arguments')
    expect(codec.validateArguments(Object.assign([], { source: 'clipboard' }))).toBe(false)
  })
  it('requires a defined empty/PNG/fixed-failure result and preserves exact roundtrip values', () => {
    const values = [{ images: [], errors: [] }, result(), ...Object.values(NATIVE_CLIPBOARD_ERRORS).map(error => ({ images: [], errors: [error] }))]
    for (const value of values) {
      const wire = codec.encodeResult(value)
      expect(wire).toEqual({ defined: true, value }); expect(codec.validateWireResult(wire)).toBe(true)
      expect(codec.decodeResult(wire.defined ? wire.value : undefined)).toEqual(value)
    }
    for (const value of [undefined, null, {}, { images: [] }, { errors: [] }, { images: null, errors: [] }, { images: [], errors: undefined }]) expect(() => codec.encodeResult(value)).toThrow('result')
    for (const wire of [{ defined: false }, { defined: true }, { defined: true, value: undefined }, { defined: true, value: { images: [], errors: [] }, epoch: 'forged' }]) expect(codec.validateWireResult(wire)).toBe(false)
    expect(() => codec.decodeResult(undefined)).toThrow('result')
  })
  it('keeps errors finite, mutually exclusive with images, and never exports provider diagnostics or file targets', () => {
    expect(NATIVE_CLIPBOARD_ERRORS).toEqual({
      unavailable: 'Clipboard image reading is unavailable in this desktop host.',
      copiedFiles: 'Copied image files are not available here yet.',
      tooLarge: 'The clipboard image exceeds the supported size.',
      unsupported: 'The clipboard image format is not supported here.',
      failed: 'The clipboard image could not be read.'
    })
    for (const value of [
      { ...result(), errors: [NATIVE_CLIPBOARD_ERRORS.failed] },
      { images: [], errors: [NATIVE_CLIPBOARD_ERRORS.failed, NATIVE_CLIPBOARD_ERRORS.failed] },
      { images: [], errors: ['GTK /private/profile credential failure'] },
      { images: [], errors: ['file:///private/photo.png'] },
      { images: [], errors: [NATIVE_CLIPBOARD_ERRORS.failed + '\0'] },
      { images: [], errors: [NATIVE_CLIPBOARD_ERRORS.failed + '\ud800'] },
      { images: [], errors: [NATIVE_CLIPBOARD_ERRORS.failed], uris: ['file:///private'] },
      { ...result(), images: [image(), image()] }
    ]) expect(isNativeClipboardResult(value)).toBe(false)
  })
  it('refuses arbitrary names, MIME remapping, copied URLs/paths, loose Unicode and extra scalar fields', () => {
    for (const altered of [
      { ...image(), name: '写真.png' }, { ...image(), name: '../image.png' }, { ...image(), name: 'image.png\0' },
      { ...image(), mimeType: 'image/jpeg' }, { ...image(), mimeType: 'text/uri-list' },
      { ...image(), data: 'data:image/png;base64,' + png() }, { ...image(), data: 'file:///private/image.png' },
      { ...image(), data: png() + '\ud800' }, { ...image(), data: png() + '\0' },
      { ...image(), width: 100 }, { ...image(), path: '/private/image.png' }, { ...image(), source: 'clipboard' },
      { ...image(), uri: 'https://user:secret@example.test/?token=private' }
    ]) expect(codec.validateResult({ images: [altered], errors: [] })).toBe(false)
  })
  it('rejects permissive-decoder alternatives including nonzero padding bits and validates only proven PNG magic', () => {
    const single = png(8), double = png(10)
    const badSingle = single.slice(0, -2) + 'p=', badDouble = double.slice(0, -3) + 'B=='
    // These strings decode to the same bytes under Node's permissive decoder.
    expect(Buffer.from(badSingle, 'base64')).toEqual(Buffer.from(single, 'base64'))
    expect(Buffer.from(badDouble, 'base64')).toEqual(Buffer.from(double, 'base64'))
    for (const data of [badSingle, badDouble, single.replace('=', ''), single + '=', single.slice(0, 4) + '\n' + single.slice(4), png().replace('+', '-') + ' ', 'YWJjZA==', '/9j/AA==', 'R0lGODlh', '', 'AAAA']) expect(codec.validateResult(result(data))).toBe(false)
    expect(codec.validateResult(result(single))).toBe(true); expect(codec.validateResult(result(double))).toBe(true)
    // The ninth byte can alter the eleventh base64 character while the complete
    // eight-byte PNG magic remains valid. Do not compare an encoded prefix.
    expect(codec.validateResult(result(Buffer.concat([magic, Buffer.from([255])]).toString('base64')))).toBe(true)
    const wrong = Buffer.alloc(12); magic.copy(wrong); wrong[7] = 0
    expect(codec.validateResult(result(wrong.toString('base64')))).toBe(false)
  })
  it('accepts exactly 512KiB before the outer frame cap and refuses the next byte without full image decoding', () => {
    const exact = result(png(NATIVE_CLIPBOARD_LIMITS.imageBytes)), oneOver = result(png(NATIVE_CLIPBOARD_LIMITS.imageBytes + 1))
    expect(exact.images[0]!.data.length).toBe(NATIVE_CLIPBOARD_LIMITS.base64Chars)
    // Same encoded length, different decoded size: character bounds alone do
    // not establish the byte cap at the padding boundary.
    expect(oneOver.images[0]!.data.length).toBe(exact.images[0]!.data.length)
    vi.stubGlobal('atob', () => { throw new Error('Full decoder must not run') })
    try {
      expect(codec.validateResult(exact)).toBe(true); expect(codec.validateResult(oneOver)).toBe(false)
      const wire = codec.encodeResult(exact)
      expect(new TextEncoder().encode(JSON.stringify(wire)).byteLength).toBeLessThan(NATIVE_CLIPBOARD_LIMITS.wireBytes)
      expect(codec.validateWireResult(wire)).toBe(true)
      expect(codec.validateResult(result('A'.repeat(NATIVE_CLIPBOARD_LIMITS.base64Chars + 4)))).toBe(false)
    } finally { vi.unstubAllGlobals() }
  })
  it('rejects hidden properties/accessors without invoking them or serializing a secret', () => {
    const getter = vi.fn(() => 'private token')
    const accessor = { name: 'image.png', mimeType: 'image/png' }
    Object.defineProperty(accessor, 'data', { enumerable: true, get: getter })
    expect(codec.validateResult({ images: [accessor], errors: [] })).toBe(false); expect(getter).not.toHaveBeenCalled()
    const hidden = Object.defineProperty(image(), 'token', { enumerable: false, value: 'private token' })
    const symbol = Object.assign(image(), { [Symbol('private')]: 'private token' })
    for (const altered of [hidden, symbol]) expect(codec.validateResult({ images: [altered], errors: [] })).toBe(false)
    const array = Object.assign([image()], { privateRoot: '/private' })
    expect(codec.validateResult({ images: array, errors: [] })).toBe(false)
    expect(codec.validateResult({ images: new Array(1), errors: [] })).toBe(false)
    const extra = Object.defineProperty(result(), 'source', { enumerable: false, value: 'host' })
    expect(codec.validateResult(extra)).toBe(false)
  })
})
