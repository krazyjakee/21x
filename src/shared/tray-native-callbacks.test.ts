import { expect, it } from 'vitest'
import { isPrivateTrayPreferenceCommand, isTrayPreference } from './tray-native-callbacks'
it('requires a finite preference command and exact native document receipt without content-driven actions', () => {
  const get = { operation: 'app:getMinimizeToTray', payload: {}, leaseId: 'ui_' + 'a'.repeat(32) }
  const set = { ...get, operation: 'app:setMinimizeToTray', payload: { enabled: true } }
  expect(isPrivateTrayPreferenceCommand(get)).toBe(true)
  expect(isPrivateTrayPreferenceCommand(set)).toBe(true)
  for (const value of [{ ...get, action: 'quit' }, { ...get, operation: 'app:quit' }, { ...get, leaseId: '\n' }, { ...get, payload: { enabled: true } }, { ...set, payload: { enabled: 'true' } }, { ...set, payload: { enabled: true, path: '/private' } }]) expect(isPrivateTrayPreferenceCommand(value)).toBe(false)
  expect(isTrayPreference({ enabled: false })).toBe(true)
  for (const value of [true, {}, { enabled: 'true' }, { enabled: true, action: 'hide' }]) expect(isTrayPreference(value)).toBe(false)
})
