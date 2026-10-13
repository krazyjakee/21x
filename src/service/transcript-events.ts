import type { DatabaseManager } from '../main/database/manager'
import { encodeDatabaseTranscriptPart, isDatabaseId } from '../shared/database-desktop-codecs'
import { hasExactKeys, isRecord, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { isTranscriptCursor, TRANSCRIPT_PAGE_LIMITS } from '../shared/transcript-page'

/** Owner-only ingress. Wire values come from durable rows, never event contents. */
export function encodeDurableTranscriptEvent(database: DatabaseManager, source: unknown): JsonValue {
  if (!isRecord(source) || !hasExactKeys(source, ['taskId', 'parts', 'maxRev'], ['reloadRequired']) ||
    !isDatabaseId(source.taskId) || !Array.isArray(source.parts) || source.parts.length > 4096 || !isTranscriptCursor(source.maxRev) ||
    source.reloadRequired !== undefined && (source.reloadRequired !== true || source.parts.length !== 0)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
  const current = database.getTranscriptMaxRev(source.taskId)
  if (source.maxRev > current) throw new ServiceProtocolError('INVALID_RESULT')
  let reload = source.reloadRequired === true || source.parts.length > TRANSCRIPT_PAGE_LIMITS.parts
  const parts: JsonValue[] = []
  const seen = new Set<string>()
  let bytes = 1024
  for (const reference of source.parts) {
    if (!isRecord(reference) || reference.taskId !== source.taskId || typeof reference.partId !== 'string' || !reference.partId ||
      reference.partId.length > 512 || reference.partId.includes('\0') || !isTranscriptCursor(reference.rev) || reference.rev === 0 ||
      reference.rev > source.maxRev || seen.has(reference.partId)) throw new ServiceProtocolError('INVALID_RESULT')
    seen.add(reference.partId)
    const saved = database.getTranscriptEventPart(source.taskId, reference.partId)
    if (!saved || saved.rev !== reference.rev) throw new ServiceProtocolError('INVALID_RESULT')
    if (!saved.part) { reload = true; continue }
    if (reload) continue
    const part = encodeDatabaseTranscriptPart(saved.part)
    bytes += new TextEncoder().encode(JSON.stringify(part)).byteLength + 1
    if (bytes > TRANSCRIPT_PAGE_LIMITS.bytes) { reload = true; continue }
    parts.push(part)
  }
  return reload ? { taskId: source.taskId, parts: [], maxRev: current, reloadRequired: true } :
    { taskId: source.taskId, parts, maxRev: source.maxRev }
}
