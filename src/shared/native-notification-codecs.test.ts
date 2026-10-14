import type { JsonValue } from './service-protocol'
import { describe, expect, it, vi } from 'vitest'
import { NATIVE_NOTIFICATION_CODECS, NATIVE_NOTIFICATION_OPERATIONS, isNativeNotificationPayload } from './native-notification-codecs'
describe('fixed native notification contracts', () => {
  it('retains three exact native methods and legacy void/permission results', () => {
    expect(Object.keys(NATIVE_NOTIFICATION_CODECS)).toEqual([...NATIVE_NOTIFICATION_OPERATIONS])
    const show = NATIVE_NOTIFICATION_CODECS['notifications:show']
    expect(show.encodeArguments(['Review ready', 'Review task\nNow'])).toEqual({ title: 'Review ready', body: 'Review task\nNow' })
    expect(show.decodeArguments({ title: 'Review ready', body: '' })).toEqual(['Review ready', ''])
    expect(show.encodeResult(undefined)).toEqual({ defined: false }); expect(show.validateWireResult({ defined: false })).toBe(true)
    for (const op of ['app:getNotificationPermission', 'app:requestNotificationPermission'] as const) {
      const codec = NATIVE_NOTIFICATION_CODECS[op]; expect(codec.encodeArguments([])).toEqual({}); expect(codec.decodeArguments({})).toEqual([])
      for (const permission of ['granted', 'denied']) expect(codec.encodeResult(permission)).toEqual({ defined: true, value: permission })
      for (const result of ['unsupported', null, undefined, { status: 'granted' }, 'private failure']) expect(codec.validateResult(result)).toBe(false)
    }
  })
  it('bounds canonical UTF-8 before any native dispatch and rejects private notification authority', () => {
    expect(isNativeNotificationPayload({ title: 'é'.repeat(80), body: '😀'.repeat(512) })).toBe(true)
    for (const payload of ([{ title: '', body: '' }, { title: 'é'.repeat(81), body: '' }, { title: 'Review', body: '😀'.repeat(513) }, { title: '\ud800', body: '' }, { title: 'Review\n', body: '' }, { title: 'Review', body: '\u0000' }, { title: 'Review', body: '\u001b[31m' }, { title: 'Review', body: '', action: 'open-private-path' }, { title: 'Review', body: '', icon: '/private' }, { title: 'Review', body: '', leaseId: 'forged' }] as JsonValue[])) {
      expect(isNativeNotificationPayload(payload)).toBe(false)
      expect(() => NATIVE_NOTIFICATION_CODECS['notifications:show'].decodeArguments(payload)).toThrow()
    }
    expect(isNativeNotificationPayload({ title: 'Review', body: '\tLine1\r\nLine2' })).toBe(true)
    expect(() => NATIVE_NOTIFICATION_CODECS['app:getNotificationPermission'].decodeArguments({ permission: 'granted' })).toThrow()
    expect(() => NATIVE_NOTIFICATION_CODECS['notifications:show'].encodeArguments(['Review', '', 'extra'] as never)).toThrow()
  })
  it('requires unambiguous envelopes without native diagnostics or fabricated visibility', () => {
    const show = NATIVE_NOTIFICATION_CODECS['notifications:show'], permission = NATIVE_NOTIFICATION_CODECS['app:getNotificationPermission']
    for (const value of [{ defined: true, value: true }, { defined: false, shown: true }, { defined: false, value: null }]) expect(show.validateWireResult(value)).toBe(false)
    for (const value of [{ defined: true, value: 'granted', server: ':1.0' }, { defined: false }, { defined: true, value: { status: 'denied' } }]) expect(permission.validateWireResult(value)).toBe(false)
  })
})

it('rejects oversized string inputs before UTF-8 allocation', () => {
  const raw = 'x'.repeat(1_000_000), encode = vi.spyOn(TextEncoder.prototype, 'encode')
  try { expect(isNativeNotificationPayload({ title: 'Review', body: raw })).toBe(false); expect(encode).not.toHaveBeenCalledWith(raw) } finally { encode.mockRestore() }
})
