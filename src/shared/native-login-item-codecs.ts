/** Native-host routes only: launch at login. Never registered with the Node service. */
import type { DesktopCommandMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { hasExactKeys, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const NATIVE_LOGIN_ITEM_OPERATIONS = ['app:getLoginItemSettings', 'app:setLoginItemSettings'] as const
export type NativeLoginItemOperation = typeof NATIVE_LOGIN_ITEM_OPERATIONS[number]
export interface NativeLoginItemCodec<K extends NativeLoginItemOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}

const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
const settings = (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['openAtLogin', 'openAsHidden']) &&
  typeof value.openAtLogin === 'boolean' && typeof value.openAsHidden === 'boolean'

function codec<K extends NativeLoginItemOperation>(operation: K): NativeLoginItemCodec<K> {
  const set = operation === 'app:setLoginItemSettings'
  const argsValid = (args: unknown): args is unknown[] => Array.isArray(args) && (set ? args.length === 1 && typeof args[0] === 'boolean' : args.length === 0)
  return {
    validateArguments: argsValid,
    encodeArguments(args): JsonValue { if (!argsValid(args)) return fail('INVALID_ARGUMENTS'); return set ? { openAtLogin: args[0] as boolean } : {} },
    decodeArguments(payload) {
      if (!isRecord(payload) || !hasExactKeys(payload, set ? ['openAtLogin'] : [])) return fail('INVALID_ARGUMENTS')
      const args = set ? [payload.openAtLogin] : []
      if (!argsValid(args)) return fail('INVALID_ARGUMENTS')
      return args as DesktopCommandMap[K]['apiArguments']
    },
    validateResult: settings,
    encodeResult(value) { if (!settings(value)) return fail('INVALID_RESULT'); return { defined: true, value: value as JsonValue } },
    decodeResult(value) { if (!settings(value)) return fail('INVALID_RESULT'); return value as DesktopCommandMap[K]['result'] },
    validateWireResult: value => isRecord(value) && hasExactKeys(value, ['defined', 'value']) && value.defined === true && settings(value.value)
  }
}

export const NATIVE_LOGIN_ITEM_CODECS = {
  'app:getLoginItemSettings': codec('app:getLoginItemSettings'),
  'app:setLoginItemSettings': codec('app:setLoginItemSettings')
} as const
