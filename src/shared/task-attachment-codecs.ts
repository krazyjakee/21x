import type { DesktopCommandMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { isDatabaseId } from './database-desktop-codecs'
import { base64ByteLength, isChatImageMimeType, validateChatImageInputs } from './chat-images'
import { hasExactKeys, isRecord, isJsonValue, ServiceProtocolError, type JsonValue } from './service-protocol'

export const TASK_ATTACHMENT_OPERATIONS = ['chatImages:saveToTask', 'attachments:remove', 'attachments:open', 'attachments:download'] as const
export type TaskAttachmentOperation = typeof TASK_ATTACHMENT_OPERATIONS[number]
export const TASK_ATTACHMENT_LIMITS = Object.freeze({ imageBytes: 512 * 1024, totalBytes: 512 * 1024, images: 5, records: 128, metadataBytes: 128 * 1024, wireBytes: 890000, filenameBytes: 216, requests: 16, openBytes: 64 * 1024 * 1024 })
function fail(code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT' | 'FRAME_TOO_LARGE'): never { throw new ServiceProtocolError(code) }
const text = (value: unknown, bytes: number): value is string => typeof value === 'string' && new TextEncoder().encode(value).length <= bytes && new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value
export const taskAttachmentId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
export const taskAttachmentFilename = (value: unknown): value is string => text(value, TASK_ATTACHMENT_LIMITS.filenameBytes) && !!value && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\\/<>:"|?*]/.test(value) && value !== '.' && value !== '..' && !/[. ]$/.test(value) && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value)
export function taskAttachmentRecord(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['id','filename','size','mime_type','added_at']) && taskAttachmentId(value.id) && taskAttachmentFilename(value.filename) && Number.isSafeInteger(value.size) && Number(value.size) >= 0 && text(value.mime_type, 128) && /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(value.mime_type) && text(value.added_at, 64) && /^\d{4}-\d{2}-\d{2}T/.test(value.added_at) && Number.isFinite(Date.parse(value.added_at))
}
export function taskAttachmentRecords(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > TASK_ATTACHMENT_LIMITS.records || !value.every(taskAttachmentRecord)) return false
  return new Set(value.map(v => v.id)).size === value.length && new Set(value.map(v => `${v.id}-${v.filename}`)).size === value.length && new TextEncoder().encode(JSON.stringify(value)).length <= TASK_ATTACHMENT_LIMITS.metadataBytes
}
function images(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > TASK_ATTACHMENT_LIMITS.images) return false
  let total = 0
  for (const image of value) {
    if (!isRecord(image) || !hasExactKeys(image, ['name','mimeType','data']) || !text(image.name, 1024) || !isChatImageMimeType(image.mimeType) || typeof image.data !== 'string' || image.data.length > Math.ceil(TASK_ATTACHMENT_LIMITS.imageBytes / 3) * 4) return false
    const size = base64ByteLength(image.data); total += size
    if (size > TASK_ATTACHMENT_LIMITS.imageBytes || total > TASK_ATTACHMENT_LIMITS.totalBytes) return false
  }
  try { validateChatImageInputs(value); return true } catch { return false }
}
function args(op: TaskAttachmentOperation, value: unknown): value is unknown[] { return Array.isArray(value) && value.length === 2 && isDatabaseId(value[0]) && (op === 'chatImages:saveToTask' ? images(value[1]) : taskAttachmentId(value[1])) }
function result(op: TaskAttachmentOperation, value: unknown): boolean { return op === 'chatImages:saveToTask' ? taskAttachmentRecords(value) : value === undefined }
function bounded(value: unknown): void { if (!isJsonValue(value)) fail('INVALID_ARGUMENTS'); if (new TextEncoder().encode(JSON.stringify(value)).length >= TASK_ATTACHMENT_LIMITS.wireBytes) fail('FRAME_TOO_LARGE') }
export interface TaskAttachmentCodec<K extends TaskAttachmentOperation> {
  encodeArguments(value: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(value: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(value: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
function codec<K extends TaskAttachmentOperation>(op: K): TaskAttachmentCodec<K> {
  const keys = op === 'chatImages:saveToTask' ? ['taskId','images'] : ['taskId','attachmentId']
  return { validateArguments: value => args(op, value), encodeArguments(value) { if (!args(op, value)) fail('INVALID_ARGUMENTS'); const wire = Object.fromEntries(keys.map((key, i) => [key, value[i]])); bounded(wire); return wire as JsonValue }, decodeArguments(value) { if (!isRecord(value) || !hasExactKeys(value, keys)) fail('INVALID_ARGUMENTS'); const decoded = keys.map(key => value[key]); if (!args(op, decoded)) fail('INVALID_ARGUMENTS'); bounded(value); return decoded as DesktopCommandMap[K]['apiArguments'] }, validateResult: value => result(op, value), encodeResult(value) { if (!result(op, value)) fail('INVALID_RESULT'); return op === 'chatImages:saveToTask' ? { defined: true, value: value as JsonValue } : { defined: false } }, decodeResult(value) { if (!result(op, value)) fail('INVALID_RESULT'); return value as DesktopCommandMap[K]['result'] }, validateWireResult: value => isRecord(value) && (op === 'chatImages:saveToTask' ? hasExactKeys(value, ['defined','value']) && value.defined === true && result(op, value.value) : hasExactKeys(value, ['defined']) && value.defined === false) }
}
export const TASK_ATTACHMENT_CODECS = Object.fromEntries(TASK_ATTACHMENT_OPERATIONS.map(op => [op, codec(op)])) as { [K in TaskAttachmentOperation]: TaskAttachmentCodec<K> }
