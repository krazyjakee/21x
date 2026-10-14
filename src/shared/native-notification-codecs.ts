/** Exact native notification routes; no caller-selected app, action, icon or URL. */
import type { DesktopCommandMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { hasExactKeys, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'
export const NATIVE_NOTIFICATION_OPERATIONS = ['notifications:show', 'app:getNotificationPermission', 'app:requestNotificationPermission'] as const
export type NativeNotificationOperation = typeof NATIVE_NOTIFICATION_OPERATIONS[number]
export const NATIVE_NOTIFICATION_LIMITS = { titleBytes: 160, bodyBytes: 2048 } as const
export const isNativeNotificationText = (value: unknown, maximum: number, multiline = false, empty = false): value is string => typeof value === 'string' && (empty || value.length > 0) && value.length <= maximum && new TextEncoder().encode(value).byteLength <= maximum && new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)
export const isNativeNotificationPayload = (value: unknown): value is { title: string; body: string } => isRecord(value) && hasExactKeys(value, ['title', 'body']) && isNativeNotificationText(value.title, NATIVE_NOTIFICATION_LIMITS.titleBytes) && isNativeNotificationText(value.body, NATIVE_NOTIFICATION_LIMITS.bodyBytes, true, true)
export interface NativeNotificationCodec<K extends NativeNotificationOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
function codec<K extends NativeNotificationOperation>(operation: K): NativeNotificationCodec<K> {
  const show = operation === 'notifications:show'
  const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
  const argsValid = (args: unknown): args is unknown[] => Array.isArray(args) && (show ? args.length === 2 && isNativeNotificationPayload({ title: args[0], body: args[1] }) : args.length === 0)
  const resultValid = (value: unknown): boolean => show ? value === undefined : value === 'granted' || value === 'denied'
  return {
    validateArguments: argsValid,
    encodeArguments(args): JsonValue { if (!argsValid(args)) return fail('INVALID_ARGUMENTS'); return show ? { title: args[0] as string, body: args[1] as string } : {} },
    decodeArguments(payload) { if (!isRecord(payload) || !(show ? isNativeNotificationPayload(payload) : hasExactKeys(payload, []))) return fail('INVALID_ARGUMENTS'); return (show ? [payload.title, payload.body] : []) as DesktopCommandMap[K]['apiArguments'] },
    validateResult: resultValid,
    encodeResult(value) { if (!resultValid(value)) return fail('INVALID_RESULT'); return show ? { defined: false } : { defined: true, value: value as string } },
    decodeResult(value) { if (!resultValid(value)) return fail('INVALID_RESULT'); return value as DesktopCommandMap[K]['result'] },
    validateWireResult(value) { return isRecord(value) && (show ? hasExactKeys(value, ['defined']) && value.defined === false : hasExactKeys(value, ['defined', 'value']) && value.defined === true && resultValid(value.value)) }
  }
}
export const NATIVE_NOTIFICATION_CODECS = { 'notifications:show': codec('notifications:show'), 'app:getNotificationPermission': codec('app:getNotificationPermission'), 'app:requestNotificationPermission': codec('app:requestNotificationPermission') }
