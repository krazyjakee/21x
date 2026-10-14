import { expect, it } from 'vitest'
import { isNativeUiAcknowledgement, isNativeUiSnapshot, isPrivateUiPublication, UI_NATIVE_CALLBACK_SCHEMAS } from './ui-native-callbacks'
it('keeps native document authority exact and separate from accepted UI intent', () => {
  expect(isNativeUiSnapshot({ available: false })).toBe(true)
  expect(isNativeUiSnapshot({ available: true, leaseId: 'document:1' })).toBe(true)
  for (const value of [{ available: true }, { available: false, leaseId: 'document:1' }, { available: true, leaseId: '../foreign' }, { available: true, leaseId: 'document:1', caller: 'main' }]) expect(isNativeUiSnapshot(value)).toBe(false)
  expect(isNativeUiAcknowledgement({ ok: true, leaseId: 'document:1' })).toBe(true)
  expect(isNativeUiAcknowledgement({ ok: false, detail: 'Window unavailable' })).toBe(true)
  for (const value of [{ ok: true }, { ok: true, leaseId: 'document:1', applied: true }, { ok: false, detail: 'x'.repeat(257) }, { ok: false, detail: '\ud800' }]) expect(isNativeUiAcknowledgement(value)).toBe(false)
  const payload = { command: { kind: 'navigate', view: 'tasks' }, leaseId: 'document:1' }
  expect(UI_NATIVE_CALLBACK_SCHEMAS['host.ui.command'].validatePayload(payload)).toBe(true)
  expect(UI_NATIVE_CALLBACK_SCHEMAS['host.ui.command'].validatePayload({ ...payload, authority: '*' })).toBe(false)
  expect(UI_NATIVE_CALLBACK_SCHEMAS['host.ui.snapshot'].validatePayload({ leaseId: 'document:1' })).toBe(false)
  expect(isPrivateUiPublication({ state: {}, leaseId: 'document:1' })).toBe(false)
})
