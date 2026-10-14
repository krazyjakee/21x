import type { DesktopCommandMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { hasExactKeys, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const TRAY_PREFERENCE_OPERATIONS = ['app:getMinimizeToTray', 'app:setMinimizeToTray'] as const
export type TrayPreferenceOperation = typeof TRAY_PREFERENCE_OPERATIONS[number]
export const TRAY_PREFERENCE_SETTING = 'minimize_to_tray' as const
export const TRAY_PREFERENCE_LIMITS = Object.freeze({ requests: 16 })
export interface TrayPreferenceCodec<K extends TrayPreferenceOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
function codec<K extends TrayPreferenceOperation>(operation: K): TrayPreferenceCodec<K> {
  const setter = operation === 'app:setMinimizeToTray'
  const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
  const validArgs = (args: unknown): args is unknown[] => Array.isArray(args) && (setter ? args.length === 1 && typeof args[0] === 'boolean' : args.length === 0)
  return {
    validateArguments: validArgs,
    encodeArguments(args): JsonValue { if (!validArgs(args)) return fail('INVALID_ARGUMENTS'); return setter ? { enabled: args[0] as boolean } : {} },
    decodeArguments(value) { if (!isRecord(value) || !hasExactKeys(value, setter ? ['enabled'] : []) || setter && typeof value.enabled !== 'boolean') return fail('INVALID_ARGUMENTS'); return (setter ? [value.enabled] : []) as DesktopCommandMap[K]['apiArguments'] },
    validateResult: value => typeof value === 'boolean',
    encodeResult(value) { if (typeof value !== 'boolean') return fail('INVALID_RESULT'); return { defined: true, value } },
    decodeResult(value) { if (typeof value !== 'boolean') return fail('INVALID_RESULT'); return value as DesktopCommandMap[K]['result'] },
    validateWireResult: value => isRecord(value) && hasExactKeys(value, ['defined', 'value']) && value.defined === true && typeof value.value === 'boolean'
  }
}
export const TRAY_PREFERENCE_CODECS = {
  'app:getMinimizeToTray': codec('app:getMinimizeToTray'),
  'app:setMinimizeToTray': codec('app:setMinimizeToTray')
}
