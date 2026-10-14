import type { JsonValue } from './service-protocol'
import { describe, expect, it } from 'vitest'
import { NATIVE_SERVICES_CODECS, NATIVE_SERVICES_OPERATIONS, isNativeExternalUrl } from './native-services-codecs'

describe('exact native external URL and app version codecs', () => {
  it('retains only the two native routes with undefined shell result and actual bounded version', () => {
    expect(NATIVE_SERVICES_OPERATIONS).toEqual(['shell:openExternal', 'app:getVersion'])
    expect(NATIVE_SERVICES_CODECS['shell:openExternal'].encodeArguments(['https://example.test/docs'])).toEqual({ url: 'https://example.test/docs' })
    expect(NATIVE_SERVICES_CODECS['shell:openExternal'].encodeResult(undefined)).toEqual({ defined: false })
    expect(NATIVE_SERVICES_CODECS['shell:openExternal'].validateWireResult({ defined: false })).toBe(true)
    expect(NATIVE_SERVICES_CODECS['shell:openExternal'].validateWireResult({ defined: false, value: null })).toBe(false)
    expect(NATIVE_SERVICES_CODECS['shell:openExternal'].validateWireResult({ defined: true, value: { opened: true } })).toBe(false)
    expect(NATIVE_SERVICES_CODECS['app:getVersion'].encodeArguments([])).toEqual({})
    expect(NATIVE_SERVICES_CODECS['app:getVersion'].encodeResult('1.2.3-preview.1+fixture')).toEqual({ defined: true, value: '1.2.3-preview.1+fixture' })
    expect(NATIVE_SERVICES_CODECS['app:getVersion'].decodeResult('0.1.0')).toBe('0.1.0')
    for (const result of [undefined, '/private/version', '1.2.3\0', '1.2', 'x'.repeat(129)]) expect(() => NATIVE_SERVICES_CODECS['app:getVersion'].encodeResult(result)).toThrow()
  })
  it('admits reviewed UI protocols and a narrower HTTP(S)-only service callback', () => {
    for (const url of ['https://example.test/oauth?state=fixture#done', 'http://127.0.0.1:3000', 'mailto:fixture@example.test?subject=Fixture']) expect(isNativeExternalUrl(url)).toBe(true)
    expect(isNativeExternalUrl('mailto:fixture@example.test', true)).toBe(false)
    expect(isNativeExternalUrl('https://example.test/oauth', true)).toBe(true)
    for (const url of ['file:///private', 'javascript:alert(1)', 'tel:1234', 'https:/example.test', 'https://user:pass@example.test', 'https://@example.test', 'https://example.test/ bad', 'https://example.test/bad\0path', 'https://example.test\\path']) expect(isNativeExternalUrl(url), url).toBe(false)
  })
  it('refuses arbitrary programs, path/profile/caller grants and byte overflows before native effects', () => {
    const codec = NATIVE_SERVICES_CODECS['shell:openExternal'], base = 'https://example.test/'
    expect(isNativeExternalUrl(base + 'x'.repeat(8192 - base.length))).toBe(true)
    expect(isNativeExternalUrl(base + 'x'.repeat(8193 - base.length))).toBe(false)
    expect(isNativeExternalUrl(base + 'é'.repeat(4096))).toBe(false)
    const extraFields: Array<Record<string, JsonValue>> = [{ with: 'arbitrary-program' }, { path: '/private' }, { profileRoot: '/private' }, { caller: { capabilities: ['*'] } }, { engineEpoch: 'foreign' }]
    for (const extra of extraFields) expect(() => codec.decodeArguments({ url: base, ...extra })).toThrow()
    expect(() => NATIVE_SERVICES_CODECS['app:getVersion'].decodeArguments({ profileRoot: '/private' })).toThrow()
  })
})
