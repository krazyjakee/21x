import { describe, expect, it } from 'vitest'
import { TRAY_PREFERENCE_CODECS as codecs, TRAY_PREFERENCE_OPERATIONS } from './tray-preference-codecs'

describe('exact retained tray preference DTOs', () => {
  it('preserves empty getter, strict boolean setter and defined boolean results', () => {
    expect(TRAY_PREFERENCE_OPERATIONS).toEqual(['app:getMinimizeToTray', 'app:setMinimizeToTray'])
    expect(codecs['app:getMinimizeToTray'].encodeArguments([])).toEqual({})
    expect(codecs['app:getMinimizeToTray'].decodeArguments({})).toEqual([])
    for (const enabled of [false, true]) {
      expect(codecs['app:setMinimizeToTray'].encodeArguments([enabled])).toEqual({ enabled })
      expect(codecs['app:setMinimizeToTray'].decodeArguments({ enabled })).toEqual([enabled])
      for (const operation of TRAY_PREFERENCE_OPERATIONS) {
        expect(codecs[operation].encodeResult(enabled)).toEqual({ defined: true, value: enabled })
        expect(codecs[operation].decodeResult(enabled)).toBe(enabled)
      }
    }
  })
  it('refuses truthy strings, null/missing/extra arguments and all caller-selected authority', () => {
    for (const enabled of [undefined, null, 0, 1, '', 'false', 'true', [], {}]) {
      expect(codecs['app:setMinimizeToTray'].validateArguments([enabled])).toBe(false)
      expect(() => codecs['app:setMinimizeToTray'].decodeArguments({ enabled } as never)).toThrow()
    }
    for (const value of [[], [true], null, undefined]) expect(codecs['app:getMinimizeToTray'].validateArguments(value)).toBe(Array.isArray(value) && value.length === 0)
    for (const field of ['setting', 'key', 'value', 'path', 'trayAvailable', 'uiLeaseId', 'caller', 'action']) {
      expect(() => codecs['app:setMinimizeToTray'].decodeArguments({ enabled: true, [field]: 'forged' })).toThrow()
      expect(() => codecs['app:getMinimizeToTray'].decodeArguments({ [field]: 'forged' })).toThrow()
    }
    expect(codecs['app:setMinimizeToTray'].validateArguments([true, false])).toBe(false)
  })
  it('rejects undefined/null/string results and malformed legacy result envelopes', () => {
    for (const operation of TRAY_PREFERENCE_OPERATIONS) {
      const codec = codecs[operation]
      for (const result of [undefined, null, 'true', 1, { enabled: true }]) { expect(codec.validateResult(result)).toBe(false); expect(() => codec.encodeResult(result)).toThrow(); expect(() => codec.decodeResult(result as never)).toThrow() }
      for (const wire of [{ defined: false }, { defined: true }, { defined: true, value: null }, { defined: true, value: 'true' }, { defined: true, value: false, action: 'quit' }]) expect(codec.validateWireResult(wire)).toBe(false)
      expect(codec.validateWireResult({ defined: true, value: false })).toBe(true)
    }
  })
})
