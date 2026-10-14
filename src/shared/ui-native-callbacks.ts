import { hasExactKeys, isRecord } from './service-protocol'
import { isUiCommand, isUiLeaseId, isUiStateSnapshot, uiText } from './ui-desktop-codecs'
type NativeUiSnapshot = { available: false } | { available: true; leaseId: string }
type NativeUiAcknowledgement = { ok: true; leaseId: string } | { ok: false; detail: string }

export function isNativeUiSnapshot(value: unknown): value is NativeUiSnapshot {
  return isRecord(value) && (value.available === false ? hasExactKeys(value, ['available']) : value.available === true && hasExactKeys(value, ['available', 'leaseId']) && isUiLeaseId(value.leaseId))
}
export function isNativeUiAcknowledgement(value: unknown): value is NativeUiAcknowledgement {
  return isRecord(value) && (value.ok === true ? hasExactKeys(value, ['ok', 'leaseId']) && isUiLeaseId(value.leaseId) : value.ok === false && hasExactKeys(value, ['ok', 'detail']) && uiText(value.detail, 256))
}
export const UI_NATIVE_CALLBACK_SCHEMAS = {
  'host.ui.snapshot': {
    validatePayload: (value: unknown) => isRecord(value) && hasExactKeys(value, []), validateResult: isNativeUiSnapshot
  },
  'host.ui.command': {
    validatePayload: (value: unknown) => isRecord(value) && hasExactKeys(value, ['command', 'leaseId']) && isUiCommand(value.command) && isUiLeaseId(value.leaseId), validateResult: isNativeUiAcknowledgement
  }
} as const
export const isPrivateUiPublication = (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['state', 'leaseId']) && isUiStateSnapshot(value.state) && isUiLeaseId(value.leaseId)
