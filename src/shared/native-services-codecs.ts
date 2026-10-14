/** Native-host routes only. These are never registered with the Node service. */
import type { DesktopCommandMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { isExternalHostUrl } from './host-services'
import { hasExactKeys, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const NATIVE_SERVICES_OPERATIONS = ['shell:openExternal', 'app:getVersion'] as const
export type NativeServicesOperation = typeof NATIVE_SERVICES_OPERATIONS[number]
export const NATIVE_SERVICES_LIMITS = { urlBytes: 8192, versionBytes: 128, concurrency: 4 } as const
export function isNativeExternalUrl(value: unknown, callback = false): value is string {
  return isExternalHostUrl(value) && new TextEncoder().encode(value).byteLength <= NATIVE_SERVICES_LIMITS.urlBytes &&
    (!callback || ['http:', 'https:'].includes(new URL(value).protocol))
}
export const isNativeAppVersion = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value) && new TextEncoder().encode(value).byteLength <= NATIVE_SERVICES_LIMITS.versionBytes
export interface NativeServicesCodec<K extends NativeServicesOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
function codec<K extends NativeServicesOperation>(operation: K): NativeServicesCodec<K> {
  const external = operation === 'shell:openExternal'
  const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
  const argsValid = (args: unknown): args is unknown[] => Array.isArray(args) && (external ? args.length === 1 && isNativeExternalUrl(args[0]) : args.length === 0)
  const resultValid = (value: unknown): boolean => external ? value === undefined : isNativeAppVersion(value)
  return {
    validateArguments: argsValid,
    encodeArguments(args): JsonValue { if (!argsValid(args)) return fail('INVALID_ARGUMENTS'); if (external) return { url: args[0] as string }; return {} },
    decodeArguments(payload) {
      if (!isRecord(payload) || !hasExactKeys(payload, external ? ['url'] : [])) return fail('INVALID_ARGUMENTS')
      const args = external ? [payload.url] : []
      if (!argsValid(args)) return fail('INVALID_ARGUMENTS')
      return args as DesktopCommandMap[K]['apiArguments']
    },
    validateResult: resultValid,
    encodeResult(value) { if (!resultValid(value)) return fail('INVALID_RESULT'); return external ? { defined: false } : { defined: true, value: value as string } },
    decodeResult(value) { if (!resultValid(value)) return fail('INVALID_RESULT'); return value as DesktopCommandMap[K]['result'] },
    validateWireResult(value) { return isRecord(value) && (external ? hasExactKeys(value, ['defined']) && value.defined === false : hasExactKeys(value, ['defined', 'value']) && value.defined === true && resultValid(value.value)) }
  }
}
export const NATIVE_SERVICES_CODECS = { 'shell:openExternal': codec('shell:openExternal'), 'app:getVersion': codec('app:getVersion') }
