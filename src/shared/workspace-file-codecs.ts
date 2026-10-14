import type { DesktopCommandMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { isDatabaseId } from './database-desktop-codecs'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const WORKSPACE_FILE_OPERATIONS = ['tasks:getWorkspaceDir', 'shell:readTextFile', 'shell:openPath', 'shell:showItemInFolder'] as const
export type WorkspaceFileOperation = typeof WORKSPACE_FILE_OPERATIONS[number]
export const WORKSPACE_FILE_LIMITS = { pathBytes: 4096, contentBytes: 128 * 1024, resultBytes: 890_000, requests: 16 } as const
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
function utf8(value: unknown, max: number): value is string {
  if (typeof value !== 'string') return false
  const bytes = new TextEncoder().encode(value)
  return bytes.length <= max && new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) === value
}
/** A DTO accepts supported-platform absolute syntax. The actual Node owner
 * separately checks its own platform, canonical root and physical identity. */
export function workspaceFileAbsolutePath(value: unknown): value is string {
  return utf8(value, WORKSPACE_FILE_LIMITS.pathBytes) && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value) &&
    (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value))
}
const shape = (value: unknown, required: string[]): value is Record<string, unknown> => isRecord(value) && hasExactKeys(value, required)
const content = (value: unknown): boolean => value === null || shape(value, ['content', 'size']) && utf8(value.content, WORKSPACE_FILE_LIMITS.contentBytes) && Number.isSafeInteger(value.size) && Number(value.size) >= 0 && (Number(value.size) <= WORKSPACE_FILE_LIMITS.contentBytes || value.content === '')
export interface WorkspaceFileCodec<K extends WorkspaceFileOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
function codec<K extends WorkspaceFileOperation>(operation: K): WorkspaceFileCodec<K> {
  const key = operation === 'tasks:getWorkspaceDir' ? 'taskId' : 'filePath', optional = operation === 'shell:openPath' || operation === 'shell:showItemInFolder'
  const args = (value: unknown): value is unknown[] => Array.isArray(value) && value.length === 1 && (key === 'taskId' ? isDatabaseId(value[0]) : workspaceFileAbsolutePath(value[0]))
  const result = (value: unknown): boolean => optional ? value === undefined : (operation === 'tasks:getWorkspaceDir' ? workspaceFileAbsolutePath(value) : content(value)) && isJsonValue(value) && new TextEncoder().encode(JSON.stringify({ defined: true, value })).length < WORKSPACE_FILE_LIMITS.resultBytes
  return {
    validateArguments: args,
    encodeArguments(value) { if (!args(value)) return fail('INVALID_ARGUMENTS'); return { [key]: value[0] } as JsonValue },
    decodeArguments(value) { if (!shape(value, [key]) || !args([value[key]])) return fail('INVALID_ARGUMENTS'); return [value[key]] as DesktopCommandMap[K]['apiArguments'] },
    validateResult: result,
    encodeResult(value) { if (!result(value)) return fail('INVALID_RESULT'); return optional ? { defined: false } : { defined: true, value: value as JsonValue } },
    decodeResult(value) { if (!result(value)) return fail('INVALID_RESULT'); return value as DesktopCommandMap[K]['result'] },
    validateWireResult: value => optional ? shape(value, ['defined']) && value.defined === false : shape(value, ['defined', 'value']) && value.defined === true && result(value.value)
  }
}
export const WORKSPACE_FILE_CODECS = Object.fromEntries(WORKSPACE_FILE_OPERATIONS.map(operation => [operation, codec(operation)])) as { [K in WorkspaceFileOperation]: WorkspaceFileCodec<K> }
