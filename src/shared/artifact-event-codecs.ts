import type { DesktopEventMap } from './desktop-operations'
import { ARTIFACT_LIMITS, isArtifactRelativePath, isArtifactText } from './artifact-codecs'
import { ArtifactType } from './artifacts'
import { isDatabaseId } from './database-desktop-codecs'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const ARTIFACT_EVENT_LIMITS = { eventBytes: 256 * 1024, idBytes: 8192, titleBytes: 512, urlBytes: 2048 } as const
const ARTIFACT_KEYS = ['id', 'taskId', 'type', 'title', 'updatedAt', 'reloadTrigger']
const OPTIONAL_ARTIFACT_KEYS = ['path', 'url', 'workpieceKey', 'files']
const TYPES: string[] = Object.values(ArtifactType)
// Printable ASCII with no user info, query or fragment, so a credential cannot
// ride along in a discovered link. production_contracts.rs applies the same rule.
const PUBLIC_URL = /^https?:\/\/(?:(?![@\\?#])[!-~])+$/

const files = (value: unknown): boolean => Array.isArray(value) && value.length <= ARTIFACT_LIMITS.files && value.every(isArtifactRelativePath) && new Set(value).size === value.length
function artifact(value: unknown, taskId: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ARTIFACT_KEYS, OPTIONAL_ARTIFACT_KEYS)) return false
  if (value.taskId !== taskId || !isArtifactText(value.id, ARTIFACT_EVENT_LIMITS.idBytes) || !value.id.startsWith(`${String(taskId)}:`)) return false
  if (!TYPES.includes(value.type as string) || !isArtifactText(value.title, ARTIFACT_EVENT_LIMITS.titleBytes) || !value.title.trim()) return false
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || value.updatedAt < 0) return false
  if (!Number.isSafeInteger(value.reloadTrigger) || (value.reloadTrigger as number) < 0) return false
  // A pull request is a link and everything else is a task file, so neither
  // shape can smuggle the other's target past the renderer's artifact identity.
  const target = value.type === ArtifactType.PR
    ? value.path === undefined && isArtifactText(value.url, ARTIFACT_EVENT_LIMITS.urlBytes) && PUBLIC_URL.test(value.url)
    : value.url === undefined && (value.path === undefined || isArtifactRelativePath(value.path))
  return target && (value.workpieceKey === undefined || isArtifactText(value.workpieceKey, ARTIFACT_LIMITS.pathBytes) && !!value.workpieceKey) &&
    (value.files === undefined || files(value.files))
}
function valid(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['taskId', 'artifact']) && isDatabaseId(value.taskId) && artifact(value.artifact, value.taskId) &&
    isJsonValue(value) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= ARTIFACT_EVENT_LIMITS.eventBytes
}

/** Advisory live notice: the task's artifact scan stays the durable source, so
 * dropInvalid lets a bad payload be skipped rather than end the connection. */
export const ARTIFACT_EVENT_CODECS = {
  'artifact:updated': {
    dropInvalid: true,
    validatePayload: valid,
    encodePayload(value: unknown): JsonValue {
      if (!isRecord(value) || !isRecord(value.artifact)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
      // Producers leave absent optional fields as undefined, which has no JSON form.
      const result = { ...value, artifact: Object.fromEntries(Object.entries(value.artifact).filter(([, field]) => field !== undefined)) }
      if (!valid(result)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
      return result as unknown as JsonValue
    },
    decodePayload(value: JsonValue): DesktopEventMap['artifact:updated'] {
      if (!valid(value)) throw new ServiceProtocolError('INVALID_RESULT')
      return value as unknown as DesktopEventMap['artifact:updated']
    }
  }
}
