import { hasExactKeys, isRecord } from './service-protocol'
import { isUiLeaseId } from './ui-desktop-codecs'
import { TRAY_PREFERENCE_CODECS, type TrayPreferenceOperation } from './tray-preference-codecs'

export function isPrivateTrayPreferenceCommand(value: unknown): value is { operation: TrayPreferenceOperation; payload: Record<string, never> | { enabled: boolean }; leaseId: string } {
  if (!isRecord(value) || !hasExactKeys(value, ['operation', 'payload', 'leaseId']) || !isUiLeaseId(value.leaseId) || typeof value.operation !== 'string' || !Object.hasOwn(TRAY_PREFERENCE_CODECS, value.operation)) return false
  try { const codec = TRAY_PREFERENCE_CODECS[value.operation as TrayPreferenceOperation]; return codec.validateArguments(codec.decodeArguments(value.payload as never)) } catch { return false }
}
export const isTrayPreference = (value: unknown): value is { enabled: boolean } => isRecord(value) && hasExactKeys(value, ['enabled']) && typeof value.enabled === 'boolean'
