import type { DesktopCommandMap, DesktopEventMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { hasExactKeys, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

/** These limits describe terminal payloads, never grant a process or directory. */
export const TERMINAL_DESKTOP_LIMITS = {
  id: 256, pathBytes: 4096, writeBytes: 64 * 1024, eventBytes: 16 * 1024,
  sourceBytes: 4 * 1024 * 1024, bufferBytes: 512 * 1024, lines: 500, dimension: 4096
} as const
export const TERMINAL_DESKTOP_OPERATIONS = [
  'terminal:create', 'terminal:write', 'terminal:resize', 'terminal:kill', 'terminal:getCwd', 'terminal:getBuffer'
] as const
export const TERMINAL_DESKTOP_EVENTS = ['terminal:data', 'terminal:exit'] as const
export type TerminalDesktopOperation = typeof TERMINAL_DESKTOP_OPERATIONS[number]
export type TerminalDesktopEvent = typeof TERMINAL_DESKTOP_EVENTS[number]
export interface TerminalCommandCodec<K extends TerminalDesktopOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
const shape = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> => isRecord(value) && hasExactKeys(value, required, optional)
export const isTerminalId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)
const positive = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maximum
/** Terminal control characters are data; do not sanitize them into different commands. */
const bytes = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum && new TextEncoder().encode(value).length <= maximum
const path = (value: unknown): value is string => bytes(value, TERMINAL_DESKTOP_LIMITS.pathBytes) && !!value && !value.includes('\0')
const size = (value: unknown): value is number => positive(value, TERMINAL_DESKTOP_LIMITS.dimension)
function buffer(value: unknown): boolean {
  if (!shape(value, ['lines']) || !Array.isArray(value.lines) || value.lines.length > TERMINAL_DESKTOP_LIMITS.lines) return false
  let total = 12 + value.lines.length
  for (const line of value.lines) {
    if (!bytes(line, TERMINAL_DESKTOP_LIMITS.bufferBytes)) return false
    total += new TextEncoder().encode(JSON.stringify(line)).length
    if (total > TERMINAL_DESKTOP_LIMITS.bufferBytes) return false
  }
  return true
}
interface Descriptor {
  args(value: unknown): boolean
  encode(args: unknown[]): JsonValue
  decode(payload: JsonValue): unknown[]
  result(value: unknown): boolean
}
const idArgs = (value: unknown): value is unknown[] => Array.isArray(value) && isTerminalId(value[0])
const pidArgs = (value: unknown): boolean => idArgs(value) && value.length >= 1 && value.length <= 2 && (value[1] === undefined || positive(value[1]))
const encodePid = (args: unknown[]): JsonValue => ({ id: args[0] as string, ...(args[1] === undefined ? {} : { expectedPid: args[1] as number }) })
const decodePid = (payload: JsonValue): unknown[] => {
  if (!shape(payload, ['id'], ['expectedPid'])) return fail('INVALID_ARGUMENTS')
  return Object.hasOwn(payload, 'expectedPid') ? [payload.id, payload.expectedPid] : [payload.id]
}
const descriptors: Record<TerminalDesktopOperation, Descriptor> = {
  'terminal:create': {
    args: value => idArgs(value) && value.length >= 3 && value.length <= 4 && size(value[1]) && size(value[2]) && (value[3] === undefined || path(value[3])),
    encode: args => ({ id: args[0] as string, cols: args[1] as number, rows: args[2] as number, ...(args[3] === undefined ? {} : { cwd: args[3] as string }) }),
    decode: payload => { if (!shape(payload, ['id', 'cols', 'rows'], ['cwd'])) return fail('INVALID_ARGUMENTS'); return Object.hasOwn(payload, 'cwd') ? [payload.id, payload.cols, payload.rows, payload.cwd] : [payload.id, payload.cols, payload.rows] },
    result: value => shape(value, ['pid']) && positive(value.pid)
  },
  'terminal:write': {
    args: value => idArgs(value) && value.length === 2 && bytes(value[1], TERMINAL_DESKTOP_LIMITS.writeBytes),
    encode: args => ({ id: args[0] as string, data: args[1] as string }),
    decode: payload => { if (!shape(payload, ['id', 'data'])) return fail('INVALID_ARGUMENTS'); return [payload.id, payload.data] },
    result: value => value === undefined
  },
  'terminal:resize': {
    args: value => idArgs(value) && value.length === 3 && size(value[1]) && size(value[2]),
    encode: args => ({ id: args[0] as string, cols: args[1] as number, rows: args[2] as number }),
    decode: payload => { if (!shape(payload, ['id', 'cols', 'rows'])) return fail('INVALID_ARGUMENTS'); return [payload.id, payload.cols, payload.rows] },
    result: value => value === undefined
  },
  'terminal:kill': { args: pidArgs, encode: encodePid, decode: decodePid, result: value => value === undefined },
  'terminal:getCwd': { args: pidArgs, encode: encodePid, decode: decodePid, result: value => shape(value, ['cwd']) && (value.cwd === null || path(value.cwd)) },
  'terminal:getBuffer': {
    args: value => idArgs(value) && value.length >= 1 && value.length <= 2 && (value[1] === undefined || positive(value[1], TERMINAL_DESKTOP_LIMITS.lines)),
    encode: args => ({ id: args[0] as string, ...(args[1] === undefined ? {} : { lines: args[1] as number }) }),
    decode: payload => { if (!shape(payload, ['id'], ['lines'])) return fail('INVALID_ARGUMENTS'); return Object.hasOwn(payload, 'lines') ? [payload.id, payload.lines] : [payload.id] },
    result: buffer
  }
}
function commandCodec<K extends TerminalDesktopOperation>(operation: K): TerminalCommandCodec<K> {
  const descriptor = descriptors[operation]
  return {
    validateArguments: descriptor.args,
    encodeArguments(args) { if (!descriptor.args(args)) return fail('INVALID_ARGUMENTS'); return descriptor.encode(args) },
    decodeArguments(payload) { const args = descriptor.decode(payload); if (!descriptor.args(args)) return fail('INVALID_ARGUMENTS'); return args as DesktopCommandMap[K]['apiArguments'] },
    validateResult: descriptor.result,
    encodeResult(value) { if (!descriptor.result(value)) return fail('INVALID_RESULT'); return value === undefined ? { defined: false } : { defined: true, value: value as JsonValue } },
    decodeResult(value) { if (!descriptor.result(value)) return fail('INVALID_RESULT'); return value as DesktopCommandMap[K]['result'] },
    validateWireResult(value) { return shape(value, ['defined'], ['value']) && typeof value.defined === 'boolean' && value.defined === Object.hasOwn(value, 'value') && (!value.defined || value.value !== undefined) && descriptor.result(value.value) }
  }
}
export const TERMINAL_COMMAND_CODECS = Object.fromEntries(TERMINAL_DESKTOP_OPERATIONS.map(operation => [operation, commandCodec(operation)])) as { [K in TerminalDesktopOperation]: TerminalCommandCodec<K> }
const data = (value: unknown): value is DesktopEventMap['terminal:data'] => shape(value, ['id', 'data']) && isTerminalId(value.id) && bytes(value.data, TERMINAL_DESKTOP_LIMITS.eventBytes)
const exit = (value: unknown): value is DesktopEventMap['terminal:exit'] => shape(value, ['id']) && isTerminalId(value.id)
export const TERMINAL_EVENT_CODECS = {
  'terminal:data': {
    validatePayload: data,
    encodePayload(value: DesktopEventMap['terminal:data']): JsonValue { if (!data(value)) return fail('INVALID_ARGUMENTS'); return value },
    decodePayload(value: JsonValue): DesktopEventMap['terminal:data'] { if (!data(value)) return fail('INVALID_ARGUMENTS'); return value }
  },
  'terminal:exit': {
    validatePayload: exit,
    encodePayload(value: DesktopEventMap['terminal:exit']): JsonValue { if (!exit(value)) return fail('INVALID_ARGUMENTS'); return value },
    decodePayload(value: JsonValue): DesktopEventMap['terminal:exit'] { if (!exit(value)) return fail('INVALID_ARGUMENTS'); return value }
  }
} as const
