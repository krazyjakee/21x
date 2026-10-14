import { describe, expect, it } from 'vitest'
import { MOBILE_CODECS, MOBILE_EVENT_CODECS, MOBILE_LIMITS, MOBILE_OPERATIONS } from './mobile-codecs'
describe('finite mobile control DTOs', () => {
  it('preserves defined partial access options while rejecting empty/unknown fields', () => {
    const codec = MOBILE_CODECS['mobile:setAccess']
    expect(codec.decodeArguments(codec.encodeArguments([{ enabled: true, lanAccess: undefined }]))).toEqual([{ enabled: true }])
    for (const options of [{}, { enabled: undefined }, { enabled: true, token: 'private' }, { sessionIdleDays: 0 }, { sessionIdleDays: MOBILE_LIMITS.idleDays + 1 }]) expect(codec.validateArguments([options])).toBe(false)
    expect(MOBILE_OPERATIONS).toHaveLength(10)
  })
  it('requires HTTP(S) custom bases without credentials/query and exact one-time code pair URLs', () => {
    const codec = MOBILE_CODECS['mobile:setCustomUrl']
    for (const url of ['file:///private', 'https://user:private@example.test', 'https://example.test?token=private', 'https://example.test#private', ' https://example.test']) expect(codec.validateArguments([url])).toBe(false)
    expect(codec.encodeArguments(['https://example.test/mobile'])).toEqual({ url: 'https://example.test/mobile' })
    const result = MOBILE_CODECS['mobile:startTunnel']
    expect(result.validateResult({ tunnelUrl: 'https://synthetic.trycloudflare.com/pair?code=one-time-code' })).toBe(true)
    for (const url of ['https://example.test/pair?token=secret', 'https://example.test/pair?code=valid&token=private', 'https://example.test/pair?code=a&code=b', 'https://example.test/other?code=valid']) expect(result.validateResult({ tunnelUrl: url })).toBe(false)
  })
  it('exports device metadata without token hashes or internal flags and rejects unexpected secret fields', () => {
    const codec = MOBILE_CODECS['mobile:getSessions'], row = { id: 'paired-device', device_name: 'Synthetic device', paired_at: 1, last_seen: 2 }
    expect(codec.encodeResult([{ ...row, revoked: 0 }])).toEqual({ defined: true, value: [row] })
    expect(() => codec.encodeResult([{ ...row, token_hash: 'private-hash' }])).toThrow()
    expect(codec.validateResult([row, row])).toBe(false)
    expect(codec.validateResult(Array.from({ length: 129 }, (_, i) => ({ ...row, id: `device-${i}` })))).toBe(false)
    expect(codec.validateResult([{ ...row, last_seen: Infinity }])).toBe(false)
    expect(codec.validateResult([{ ...row, device_name: 'x'.repeat(257) }])).toBe(false)
  })
  it('bounds actual desktop notifier payloads, exposes no session token, and enforces six-digit PIN', () => {
    const pairing = MOBILE_EVENT_CODECS['mobile:pairing-initiated'], devices = MOBILE_EVENT_CODECS['mobile:device-connected']
    const pin = { pin: '123456', pairCodeId: 'pair-fixture', expiresAt: 123 }
    expect(pairing.decodePayload(pairing.encodePayload(pin))).toEqual(pin)
    expect(pairing.validatePayload({ ...pin, pin: '1' })).toBe(false)
    expect(devices.validatePayload({ sessionId: 'device-fixture', deviceName: 'Synthetic', sessionToken: 'private' })).toBe(false)
  })
})
