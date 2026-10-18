import { hasExactKeys, isRecord } from './service-protocol'
import { isUiLeaseId } from './ui-desktop-codecs'

/** Private Source/native contract only. No public command or viewer capability
 * is registered by these declarations. Native fixes title/MIME/label/origin/CSP. */
export const ARTIFACT_VIEWER_LIMITS = { htmlBytes: 128 * 1024, active: 16, epochIds: 4096, ttlMs: 600_000 } as const
export const isArtifactViewerId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
export function isArtifactViewerHtml(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const bytes = new TextEncoder().encode(value)
  return bytes.length <= ARTIFACT_VIEWER_LIMITS.htmlBytes && new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) === value
}
export interface ArtifactViewerRegistration { viewerId: string; uiLeaseId: string; html: string }
export interface ArtifactViewerNativeBridge {
  register(input: ArtifactViewerRegistration): Promise<{ viewerId: string; registered: true }>
  open(input: { viewerId: string }): Promise<{ viewerId: string; opened: true }>
  retire(input: { viewerId: string }): Promise<{ viewerId: string; retired: true }>
}
export interface ArtifactViewerClosed { viewerId: string; reason: 'closed' | 'parent-retired' | 'expired' | 'failed' }
export function isArtifactViewerRegistration(value: unknown): value is ArtifactViewerRegistration {
  return isRecord(value) && hasExactKeys(value, ['viewerId', 'uiLeaseId', 'html']) && isArtifactViewerId(value.viewerId) && isUiLeaseId(value.uiLeaseId) && isArtifactViewerHtml(value.html)
}
const identity = (value: unknown) => isRecord(value) && hasExactKeys(value, ['viewerId']) && isArtifactViewerId(value.viewerId)
const receipt = (field: 'registered' | 'opened' | 'retired') => (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['viewerId', field]) && isArtifactViewerId(value.viewerId) && value[field] === true
export function isArtifactViewerClosed(value: unknown): value is ArtifactViewerClosed {
  return isRecord(value) && hasExactKeys(value, ['viewerId', 'reason']) && isArtifactViewerId(value.viewerId) && typeof value.reason === 'string' && ['closed', 'parent-retired', 'expired', 'failed'].includes(value.reason)
}
export const ARTIFACT_VIEWER_NATIVE_SCHEMAS = {
  'host.artifactViewer.register': { validatePayload: isArtifactViewerRegistration, validateResult: receipt('registered') },
  'host.artifactViewer.open': { validatePayload: identity, validateResult: receipt('opened') },
  'host.artifactViewer.retire': { validatePayload: identity, validateResult: receipt('retired') }
} as const
export const ARTIFACT_VIEWER_CLOSED_SCHEMA = { validatePayload: isArtifactViewerClosed,
  validateResult: (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['accepted']) && typeof value.accepted === 'boolean' } as const
