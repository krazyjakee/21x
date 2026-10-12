import type { TranscriptPartRecord } from './transcript/types'
import { hasExactKeys, isJsonValue, isRecord } from './service-protocol'

/** Read-only display pages. This version is independent of the pipe envelope. */
export const TRANSCRIPT_PAGE_VERSION = 1 as const
export const TRANSCRIPT_PAGE_LIMITS = { parts: 64, bytes: 256 * 1024, fieldChars: 8192 } as const
export const TRANSCRIPT_PREVIEW_NOTICE = '\n\n[Large record: a preview is displayed. The full record remains saved.]'
export interface TranscriptPageRequest {
  version: 1
  mode: 'snapshot' | 'delta'
  after: number
  watermark?: number
  limit?: number
}
export interface TranscriptPage {
  version: 1
  taskId: string
  mode: 'snapshot' | 'delta'
  after: number
  parts: TranscriptPartRecord[]
  cursor: number
  watermark: number
  hasMore: boolean
}
export const isTranscriptCursor = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
export function isTranscriptPageRequest(value: unknown): value is TranscriptPageRequest {
  return isRecord(value) && hasExactKeys(value, ['version', 'mode', 'after'], ['watermark', 'limit']) &&
    value.version === TRANSCRIPT_PAGE_VERSION && ['snapshot', 'delta'].includes(value.mode as string) && isTranscriptCursor(value.after) &&
    (!Object.hasOwn(value, 'watermark') || isTranscriptCursor(value.watermark)) &&
    (!Object.hasOwn(value, 'limit') || Number.isSafeInteger(value.limit) && (value.limit as number) >= 1 && (value.limit as number) <= TRANSCRIPT_PAGE_LIMITS.parts) &&
    (value.mode !== 'delta' || value.watermark === undefined || value.after <= (value.watermark as number))
}
export function isTranscriptPage(value: unknown, validatePart: (part: unknown) => boolean): value is TranscriptPage {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'taskId', 'mode', 'after', 'parts', 'cursor', 'watermark', 'hasMore']) ||
    value.version !== TRANSCRIPT_PAGE_VERSION || typeof value.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.taskId) ||
    !['snapshot', 'delta'].includes(value.mode as string) || !isTranscriptCursor(value.after) || !isTranscriptCursor(value.cursor) || !isTranscriptCursor(value.watermark) ||
    typeof value.hasMore !== 'boolean' || !Array.isArray(value.parts) || value.parts.length > TRANSCRIPT_PAGE_LIMITS.parts || !isJsonValue(value)) return false
  const key = value.mode === 'snapshot' ? 'seq' : 'rev'
  let previous = value.after
  const ids = new Set<string>()
  for (const part of value.parts) {
    if (!validatePart(part) || !isRecord(part) || part.taskId !== value.taskId || !isTranscriptCursor(part[key]) ||
      part[key] <= previous || !isTranscriptCursor(part.rev) || part.rev > value.watermark || typeof part.partId !== 'string' || ids.has(part.partId)) return false
    previous = part[key]
    ids.add(part.partId)
  }
  if (value.hasMore && !value.parts.length || value.cursor !== (value.mode === 'delta' && !value.hasMore ? value.watermark : previous) ||
    value.cursor < value.after || value.mode === 'delta' && value.cursor > value.watermark) return false
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= TRANSCRIPT_PAGE_LIMITS.bytes
}
