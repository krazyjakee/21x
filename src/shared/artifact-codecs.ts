import type { DesktopCommandMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { ArtifactContentKind, ArtifactType } from './artifacts'
import { isDatabaseId } from './database-desktop-codecs'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const ARTIFACT_OPERATIONS = ['artifacts:scan', 'artifacts:read', 'artifacts:copyFile'] as const
export type ArtifactOperation = typeof ARTIFACT_OPERATIONS[number]
export const ARTIFACT_LIMITS = { resultBytes: 900_000, copyFileBytes: 64 * 1024 * 1024, textBytes: 128 * 1024, imageBytes: 512 * 1024, files: 500, pathBytes: 2048, registryBytes: 1024 * 1024, taskJsonBytes: 1024 * 1024, members: 128 } as const
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
const shape = (v: unknown, keys: string[], optional: string[] = []): v is Record<string, unknown> => isRecord(v) && hasExactKeys(v, keys, optional)
const text = (v: unknown, max: number): v is string => typeof v === 'string' && new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(v)) === v && !/[\u0000-\u001f\u007f]/.test(v) && new TextEncoder().encode(v).length <= max
export const isArtifactRelativePath = (v: unknown): v is string => text(v, ARTIFACT_LIMITS.pathBytes) && !!v && !v.startsWith('/') && !/[\\:]/.test(v) && v.split('/').every(part => !!part && part !== '.' && part !== '..')
const number = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0
const bounded = (v: unknown): boolean => isJsonValue(v) && new TextEncoder().encode(JSON.stringify(v)).length <= ARTIFACT_LIMITS.resultBytes
const entry = (v: unknown): boolean => shape(v, ['path', 'title', 'type', 'updatedAt', 'size'], ['workpieceKey', 'files']) && isArtifactRelativePath(v.path) && text(v.title, 512) && !!v.title.trim() && [ArtifactType.MARKDOWN, ArtifactType.HTML, ArtifactType.IMAGE, ArtifactType.FILE].includes(v.type as ArtifactType) && number(v.updatedAt) && Number.isSafeInteger(v.size) && Number(v.size) >= 0 &&
  (v.workpieceKey === undefined || text(v.workpieceKey, ARTIFACT_LIMITS.pathBytes) && !!v.workpieceKey) && (v.files === undefined || Array.isArray(v.files) && v.files.length <= ARTIFACT_LIMITS.files && v.files.every(isArtifactRelativePath) && new Set(v.files).size === v.files.length && v.files.includes(v.path))
const mimes = ['text/markdown', 'text/html', 'text/plain', 'text/css', 'text/csv', 'text/javascript', 'text/typescript', 'application/json', 'application/xml', 'application/yaml', 'image/gif', 'image/jpeg', 'image/png', 'image/svg+xml', 'image/webp', 'application/octet-stream'] as const
function content(v: unknown): boolean {
  if (v === null) return true
  if (!shape(v, ['kind', 'content'], ['mimeType']) || typeof v.content !== 'string' || v.mimeType !== undefined && !mimes.includes(v.mimeType as typeof mimes[number])) return false
  if (v.kind === ArtifactContentKind.TEXT) return new TextEncoder().encode(v.content).length <= ARTIFACT_LIMITS.textBytes && (v.mimeType === undefined || !String(v.mimeType).startsWith('image/') && v.mimeType !== 'application/octet-stream')
  if (v.kind !== ArtifactContentKind.DATA_URL || typeof v.mimeType !== 'string' || !['image/gif', 'image/jpeg', 'image/png', 'image/svg+xml', 'image/webp', 'application/octet-stream'].includes(v.mimeType)) return false
  const prefix = `data:${v.mimeType};base64,`
  if (!v.content.startsWith(prefix)) return false
  const bytes = v.content.slice(prefix.length)
  if (bytes.length > Math.ceil(ARTIFACT_LIMITS.imageBytes / 3) * 4 || bytes.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(bytes)) return false
  return bytes.length / 4 * 3 - (bytes.endsWith('==') ? 2 : bytes.endsWith('=') ? 1 : 0) <= ARTIFACT_LIMITS.imageBytes
}
const clean = (v: Record<string, unknown>): JsonValue => Object.fromEntries(Object.entries(v).filter(([, value]) => value !== undefined)) as JsonValue
export interface ArtifactCodec<K extends ArtifactOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(v: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(v: unknown): boolean
  encodeResult(v: unknown): OptionalResult<JsonValue>
  decodeResult(v: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(v: unknown): boolean
  validateWireResult(v: unknown): boolean
}
function codec<K extends ArtifactOperation>(operation: K): ArtifactCodec<K> {
  const keys = operation === 'artifacts:scan' ? ['taskId'] : ['taskId', 'relativePath']
  const args = (v: unknown): v is unknown[] => Array.isArray(v) && v.length === keys.length && isDatabaseId(v[0]) && (operation === 'artifacts:scan' || isArtifactRelativePath(v[1]))
  const valid = (v: unknown): boolean => operation === 'artifacts:copyFile' ? shape(v, ['mode']) && ['file', 'image', 'path', 'unavailable'].includes(v.mode as string) : bounded(v) && (operation === 'artifacts:read' ? content(v) : Array.isArray(v) && v.length <= ARTIFACT_LIMITS.files && v.every(entry) && new Set(v.map(item => item.path)).size === v.length && v.reduce((count, item) => count + (item.files?.length ?? 1), 0) <= ARTIFACT_LIMITS.files)
  return {
    validateArguments: args,
    encodeArguments(v) { if (!args(v)) return fail('INVALID_ARGUMENTS'); return Object.fromEntries(keys.map((key, index) => [key, v[index]])) as JsonValue },
    decodeArguments(v) { if (!shape(v, keys)) return fail('INVALID_ARGUMENTS'); const values = keys.map(key => v[key]); if (!args(values)) return fail('INVALID_ARGUMENTS'); return values as DesktopCommandMap[K]['apiArguments'] },
    validateResult: valid,
    encodeResult(v) { const value = operation === 'artifacts:copyFile' ? v : operation === 'artifacts:scan' && Array.isArray(v) ? v.map(row => isRecord(row) ? clean(row) : row) : isRecord(v) ? clean(v) : v; if (!valid(value)) return fail('INVALID_RESULT'); return { defined: true, value: value as JsonValue } },
    decodeResult(v) { if (!valid(v)) return fail('INVALID_RESULT'); return v as DesktopCommandMap[K]['result'] },
    validateWireResult: v => shape(v, ['defined', 'value']) && v.defined === true && valid(v.value)
  }
}
export const ARTIFACT_CODECS = Object.fromEntries(ARTIFACT_OPERATIONS.map(op => [op, codec(op)])) as { [K in ArtifactOperation]: ArtifactCodec<K> }
export const ARTIFACT_COMMAND_CODECS = ARTIFACT_CODECS
