import type { DesktopCommandMap, DesktopEventMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const MOBILE_OPERATIONS = ['mobile:getInfo', 'mobile:setAccess', 'mobile:startTunnel', 'mobile:stopTunnel', 'mobile:setCustomUrl', 'mobile:clearCustomUrl', 'mobile:getPendingPin', 'mobile:getSessions', 'mobile:revokeSession', 'mobile:revokeAllSessions'] as const
export type MobileOperation = typeof MOBILE_OPERATIONS[number]
export const MOBILE_EVENTS = ['mobile:pairing-initiated', 'mobile:device-connected'] as const
export const MOBILE_LIMITS = { sessions: 128, pairingCodes: 128, idleDays: 365, address: 2048, result: 64 * 1024 } as const
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
const shape = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => isRecord(v) && hasExactKeys(v, required, optional)
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && !/[\u0000-\u001f\u007f]/.test(v) && new TextEncoder().encode(v).length <= max
export const mobileId = (v: unknown): v is string => text(v, 128) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v)
const time = (v: unknown): boolean => Number.isSafeInteger(v) && Number(v) >= 0
const days = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MOBILE_LIMITS.idleDays
const port = (v: unknown): boolean => Number.isSafeInteger(v) && Number(v) >= 1 && Number(v) <= 65535
export function mobileAddress(v: unknown, paired = false): v is string {
  if (!text(v, MOBILE_LIMITS.address) || v !== v.trim()) return false
  try { const address = new URL(v); return ['http:', 'https:'].includes(address.protocol) && !address.username && !address.password && !address.hash &&
    (paired ? address.pathname.endsWith('/pair') && [...address.searchParams.keys()].length === 1 && mobileId(address.searchParams.get('code')) : !address.search) } catch { return false }
}
const nullableAddress = (v: unknown, paired = false): boolean => v === null || mobileAddress(v, paired)
const pin = (v: unknown): boolean => shape(v, ['pin', 'pairCodeId', 'expiresAt']) && typeof v.pin === 'string' && /^\d{6}$/.test(v.pin) && mobileId(v.pairCodeId) && time(v.expiresAt)
const session = (v: unknown): boolean => shape(v, ['id', 'device_name', 'paired_at', 'last_seen']) && mobileId(v.id) && text(v.device_name) && time(v.paired_at) && time(v.last_seen)
const access = (v: unknown): boolean => shape(v, [], ['enabled', 'lanAccess', 'sessionIdleDays']) && Object.values(v).some(field => field !== undefined) &&
  (v.enabled === undefined || typeof v.enabled === 'boolean') && (v.lanAccess === undefined || typeof v.lanAccess === 'boolean') && (v.sessionIdleDays === undefined || days(v.sessionIdleDays))
const success = (v: unknown): boolean => shape(v, ['success']) && typeof v.success === 'boolean'
const bounded = (v: unknown): boolean => isJsonValue(v) && new TextEncoder().encode(JSON.stringify(v)).length <= MOBILE_LIMITS.result
interface Descriptor { keys: string[]; args(args: unknown[]): boolean; result(v: unknown): boolean; project?(v: unknown): unknown }
const empty = (args: unknown[]): boolean => args.length === 0
const descriptors: Record<MobileOperation, Descriptor> = {
  'mobile:getInfo': { keys: [], args: empty, result: v => shape(v, ['enabled', 'lanAccess', 'sessionIdleDays', 'url', 'port', 'lanUrl', 'tunnelUrl', 'tunnelActive', 'remoteMode', 'customUrl']) && typeof v.enabled === 'boolean' && typeof v.lanAccess === 'boolean' && days(v.sessionIdleDays) && mobileAddress(v.url, true) && port(v.port) && nullableAddress(v.lanUrl, true) && nullableAddress(v.tunnelUrl, true) && typeof v.tunnelActive === 'boolean' && ['quick', 'custom'].includes(v.remoteMode as string) && nullableAddress(v.customUrl) },
  'mobile:setAccess': { keys: ['options'], args: args => args.length === 1 && access(args[0]), result: v => shape(v, ['enabled', 'lanAccess', 'sessionIdleDays', 'listening']) && typeof v.enabled === 'boolean' && typeof v.lanAccess === 'boolean' && days(v.sessionIdleDays) && typeof v.listening === 'boolean' },
  'mobile:startTunnel': { keys: [], args: empty, result: v => shape(v, ['tunnelUrl']) && mobileAddress(v.tunnelUrl, true) },
  'mobile:stopTunnel': { keys: [], args: empty, result: success },
  'mobile:setCustomUrl': { keys: ['url'], args: args => args.length === 1 && mobileAddress(args[0]), result: v => shape(v, ['url']) && mobileAddress(v.url, true) },
  'mobile:clearCustomUrl': { keys: [], args: empty, result: success },
  'mobile:getPendingPin': { keys: [], args: empty, result: v => v === null || pin(v) },
  'mobile:getSessions': { keys: [], args: empty, project: v => {
    if (!Array.isArray(v) || v.length > MOBILE_LIMITS.sessions) return fail('INVALID_RESULT')
    return v.map(row => { if (!shape(row, ['id', 'device_name', 'paired_at', 'last_seen'], ['revoked'])) return fail('INVALID_RESULT'); return { id: row.id, device_name: row.device_name, paired_at: row.paired_at, last_seen: row.last_seen } })
  }, result: v => Array.isArray(v) && v.length <= MOBILE_LIMITS.sessions && v.every(session) && new Set(v.map(row => row.id)).size === v.length },
  'mobile:revokeSession': { keys: ['sessionId'], args: args => args.length === 1 && mobileId(args[0]), result: success },
  'mobile:revokeAllSessions': { keys: [], args: empty, result: success }
}
export interface MobileCodec<K extends MobileOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
function codec<K extends MobileOperation>(operation: K): MobileCodec<K> {
  const descriptor = descriptors[operation], valid = (v: unknown): boolean => descriptor.result(v) && bounded(v)
  return {
    validateArguments: v => Array.isArray(v) && descriptor.args(v),
    encodeArguments(args) { if (!descriptor.args(args)) return fail('INVALID_ARGUMENTS'); return Object.fromEntries(descriptor.keys.map((key, i) => [key, key === 'options' && isRecord(args[i]) ? Object.fromEntries(Object.entries(args[i]).filter(([, v]) => v !== undefined)) : args[i]])) as JsonValue },
    decodeArguments(payload) { if (!shape(payload, descriptor.keys)) return fail('INVALID_ARGUMENTS'); const args = descriptor.keys.map(key => payload[key]); if (!descriptor.args(args)) return fail('INVALID_ARGUMENTS'); return args as DesktopCommandMap[K]['apiArguments'] },
    validateResult: valid,
    encodeResult(value) { const v = descriptor.project ? descriptor.project(value) : value; if (!valid(v)) return fail('INVALID_RESULT'); return { defined: true, value: v as JsonValue } },
    decodeResult(v) { if (!valid(v)) return fail('INVALID_RESULT'); return v as DesktopCommandMap[K]['result'] },
    validateWireResult: v => shape(v, ['defined', 'value']) && v.defined === true && valid(v.value)
  }
}
export const MOBILE_CODECS = Object.fromEntries(MOBILE_OPERATIONS.map(op => [op, codec(op)])) as { [K in MobileOperation]: MobileCodec<K> }
export const MOBILE_COMMAND_CODECS = MOBILE_CODECS
type MobileEvent = typeof MOBILE_EVENTS[number]
export const MOBILE_EVENT_CODECS = Object.fromEntries(MOBILE_EVENTS.map(event => {
  const valid = (v: unknown): boolean => bounded(v) && (event === 'mobile:pairing-initiated' ? pin(v) : shape(v, ['sessionId', 'deviceName']) && mobileId(v.sessionId) && text(v.deviceName))
  return [event, { validatePayload: valid, encodePayload(v: unknown): JsonValue { if (!valid(v)) return fail('INVALID_RESULT'); return v as JsonValue }, decodePayload(v: JsonValue): DesktopEventMap[MobileEvent] { if (!valid(v)) return fail('INVALID_RESULT'); return v as unknown as DesktopEventMap[MobileEvent] } }]
})) as { [K in MobileEvent]: { validatePayload(v: unknown): boolean; encodePayload(v: DesktopEventMap[K]): JsonValue; decodePayload(v: JsonValue): DesktopEventMap[K] } }
