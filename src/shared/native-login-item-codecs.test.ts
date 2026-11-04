import { describe, expect, it } from 'vitest'
import { NATIVE_LOGIN_ITEM_CODECS } from './native-login-item-codecs'

describe('launch-at-login codecs', () => {
  it('carries only a boolean and returns the resulting state', () => {
    const set = NATIVE_LOGIN_ITEM_CODECS['app:setLoginItemSettings'], get = NATIVE_LOGIN_ITEM_CODECS['app:getLoginItemSettings']
    expect(set.encodeArguments([true])).toEqual({ openAtLogin: true })
    expect(set.decodeArguments({ openAtLogin: false })).toEqual([false])
    expect(get.encodeArguments([])).toEqual({})
    expect(() => set.decodeArguments({ openAtLogin: 'yes' })).toThrow()
    expect(() => set.decodeArguments({ openAtLogin: true, path: '/tmp/x' })).toThrow()
    const state = { openAtLogin: true, openAsHidden: false }
    expect(get.validateWireResult({ defined: true, value: state })).toBe(true)
    expect(get.decodeResult(state)).toEqual(state)
    expect(get.validateWireResult({ defined: true, value: { openAtLogin: true } })).toBe(false)
    expect(get.validateWireResult({ defined: false })).toBe(false)
  })
})
