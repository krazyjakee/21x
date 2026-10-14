import type { DesktopCommandMap, DesktopEventMap } from './desktop-operations'
import { isDatabaseId } from './database-desktop-codecs'
import { isTaskLifecycleTask, projectTaskLifecycleTask } from './task-lifecycle-codecs'
import type { OptionalResult } from './host-services'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const HEARTBEAT_OPERATIONS = ['heartbeat:enable', 'heartbeat:disable', 'heartbeat:runNow', 'heartbeat:getLogs', 'heartbeat:getStatus', 'heartbeat:updateInterval', 'heartbeat:readFile', 'heartbeat:writeFile'] as const
export type HeartbeatOperation = typeof HEARTBEAT_OPERATIONS[number]
export const HEARTBEAT_LIMITS = Object.freeze({ textBytes: 128 * 1024, logs: 128, summary: 4000, intervalMinutes: 525600, bytes: 900000, storedBytes: 128000 })
export const HEARTBEAT_EVENTS = ['heartbeat:alert', 'heartbeat:disabled'] as const
type Check = (value: unknown) => boolean
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0') && new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value
const date: Check = value => text(value, 128) && Number.isFinite(Date.parse(value))
const nullable = (check: Check): Check => value => value === null || check(value)
const interval: Check = value => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= HEARTBEAT_LIMITS.intervalMinutes
const fileText: Check = value => text(value, HEARTBEAT_LIMITS.textBytes) && new TextEncoder().encode(value).byteLength <= HEARTBEAT_LIMITS.textBytes
const bounded = (value: unknown): value is JsonValue => isJsonValue(value) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= HEARTBEAT_LIMITS.bytes
const logKeys = ['id', 'task_id', 'status', 'summary', 'session_id', 'created_at']
const log: Check = value => isRecord(value) && hasExactKeys(value, logKeys) && isDatabaseId(value.id) && isDatabaseId(value.task_id) && ['ok', 'info', 'attention_needed', 'error'].includes(value.status as string) && nullable(value => text(value, HEARTBEAT_LIMITS.summary))(value.summary) && nullable(value => text(value, 512))(value.session_id) && date(value.created_at)
const logs: Check = value => Array.isArray(value) && value.length <= HEARTBEAT_LIMITS.logs && value.every(log) && bounded(value)
const status: Check = value => value === null || isRecord(value) && hasExactKeys(value, ['enabled', 'intervalMinutes', 'lastCheckAt', 'nextCheckAt', 'hasHeartbeatFile']) && typeof value.enabled === 'boolean' && nullable(interval)(value.intervalMinutes) && nullable(date)(value.lastCheckAt) && nullable(date)(value.nextCheckAt) && typeof value.hasHeartbeatFile === 'boolean'
interface Descriptor { keys: string[]; optional?: string[]; checks: Check[]; result: Check; project?: (value: unknown) => JsonValue }
const task: Check = value => value === undefined || isTaskLifecycleTask(value)
const descriptors: Record<HeartbeatOperation, Descriptor> = {
  'heartbeat:enable': { keys: ['taskId'], optional: ['intervalMinutes'], checks: [isDatabaseId, interval], result: task, project: projectTaskLifecycleTask },
  'heartbeat:disable': { keys: ['taskId'], checks: [isDatabaseId], result: task, project: projectTaskLifecycleTask },
  'heartbeat:runNow': { keys: ['taskId'], checks: [isDatabaseId], result: value => ['sent', 'no_file', 'no_agent', 'in_progress', 'error'].includes(value as string) },
  'heartbeat:getLogs': { keys: ['taskId'], optional: ['limit'], checks: [isDatabaseId, value => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= HEARTBEAT_LIMITS.logs], result: logs, project: value => {
    if (!Array.isArray(value) || value.length > HEARTBEAT_LIMITS.logs) return fail('INVALID_RESULT')
    return value.map(item => {
      if (!isRecord(item) || !log(item)) return fail('INVALID_RESULT')
      return Object.fromEntries(logKeys.map(key => [key, key === 'summary' && item.status === 'error' && item.summary !== null ? 'Heartbeat check failed.' : item[key]])) as JsonValue
    })
  } },
  'heartbeat:getStatus': { keys: ['taskId'], checks: [isDatabaseId], result: status },
  'heartbeat:updateInterval': { keys: ['taskId', 'intervalMinutes'], checks: [isDatabaseId, interval], result: task, project: projectTaskLifecycleTask },
  'heartbeat:readFile': { keys: ['taskId'], checks: [isDatabaseId], result: nullable(fileText) },
  'heartbeat:writeFile': { keys: ['taskId', 'content'], checks: [isDatabaseId, fileText], result: value => typeof value === 'boolean' },
}
export interface HeartbeatCodec<K extends HeartbeatOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
function codec<K extends HeartbeatOperation>(operation: K): HeartbeatCodec<K> {
  const descriptor = descriptors[operation], keys = [...descriptor.keys, ...descriptor.optional ?? []]
  const validateArguments = (value: unknown): boolean => Array.isArray(value) && value.length >= descriptor.keys.length && value.length <= keys.length && keys.every((_, index) => value[index] === undefined && index >= descriptor.keys.length || descriptor.checks[index](value[index]))
  const validateResult = descriptor.result
  return { validateArguments, validateResult,
    encodeArguments(args) { if (!validateArguments(args)) return fail('INVALID_ARGUMENTS'); const payload = Object.fromEntries(keys.filter((_, index) => args[index] !== undefined).map(key => [key, args[keys.indexOf(key)]])); if (!bounded(payload)) return fail('INVALID_ARGUMENTS'); return payload },
    decodeArguments(payload) { if (!isRecord(payload) || !hasExactKeys(payload, descriptor.keys, descriptor.optional) || !bounded(payload)) return fail('INVALID_ARGUMENTS'); const args = keys.map(key => payload[key]); if (!validateArguments(args)) return fail('INVALID_ARGUMENTS'); return args as DesktopCommandMap[K]['apiArguments'] },
    encodeResult(value) {
      if (value === undefined) { if (!validateResult(value)) return fail('INVALID_RESULT'); return { defined: false } }
      let projected: unknown
      try { projected = descriptor.project ? descriptor.project(value) : value } catch { return fail('INVALID_RESULT') }
      if (!validateResult(projected) || !bounded(projected)) return fail('INVALID_RESULT')
      return { defined: true, value: projected }
    },
    decodeResult(value) { if (!validateResult(value)) return fail('INVALID_RESULT'); return value as DesktopCommandMap[K]['result'] },
    validateWireResult(value) { return isRecord(value) && hasExactKeys(value, ['defined'], ['value']) && (value.defined === false ? !Object.hasOwn(value, 'value') && validateResult(undefined) : value.defined === true && Object.hasOwn(value, 'value') && validateResult(value.value) && bounded(value.value)) },
  }
}
export const HEARTBEAT_CODECS = Object.fromEntries(HEARTBEAT_OPERATIONS.map(operation => [operation, codec(operation)])) as { [K in HeartbeatOperation]: HeartbeatCodec<K> }
export const HEARTBEAT_EVENT_CODECS = Object.fromEntries(HEARTBEAT_EVENTS.map(event => {
  const validatePayload = (value: unknown): value is JsonValue => isRecord(value) && isDatabaseId(value.taskId) && bounded(value) && (event === 'heartbeat:alert'
    ? hasExactKeys(value, ['taskId', 'title', 'summary']) && text(value.title, 4096) && text(value.summary, 500)
    : hasExactKeys(value, ['taskId', 'reason']) && text(value.reason, 128))
  return [event, { validatePayload, encodePayload(value: unknown): JsonValue { if (!validatePayload(value)) return fail('INVALID_ARGUMENTS'); return value }, decodePayload(value: JsonValue): DesktopEventMap[typeof event] { if (!validatePayload(value)) return fail('INVALID_RESULT'); return value as unknown as DesktopEventMap[typeof event] } }]
})) as unknown as { [K in typeof HEARTBEAT_EVENTS[number]]: { validatePayload(value: unknown): boolean; encodePayload(value: unknown): JsonValue; decodePayload(value: JsonValue): DesktopEventMap[K] } }
