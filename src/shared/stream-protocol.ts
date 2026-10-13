import { hasExactKeys, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

/** Additive private-pipe contract. This does not register a desktop operation. */
export const STREAM_VERSION = 1 as const
export const STREAM_LIMITS = { chunkBytes: 32 * 1024, active: 16, openedPerEpoch: 4096, idleMs: 30_000 } as const
export const STREAM_OPERATIONS = ['engine.stream.chunk', 'engine.stream.end', 'engine.stream.cancel'] as const
export type StreamOperation = typeof STREAM_OPERATIONS[number]
export interface StreamDescriptor { version: 1; streamId: string; ownerId: string }
export interface WireBytes { version: 1; encoding: 'base64'; byteLength: number; data: string }
export interface StreamChunk extends StreamDescriptor { sequence: number; bytes: WireBytes }
export interface StreamEnd extends StreamDescriptor { sequence: number }
export interface StreamAck extends StreamDescriptor { sequence: number; closed: boolean }

const id = (value: unknown): value is string => typeof value === 'string' && /^(host|service):[1-9][0-9]{0,15}$/.test(value)
const owner = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const sequence = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
function fields(value: Record<string, unknown>): boolean { return value.version === STREAM_VERSION && id(value.streamId) && owner(value.ownerId) }
export function isStreamDescriptor(value: unknown): value is StreamDescriptor {
  return isRecord(value) && hasExactKeys(value, ['version', 'streamId', 'ownerId']) && fields(value)
}
export function isWireBytes(value: unknown): value is WireBytes {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'encoding', 'byteLength', 'data']) || value.version !== 1 || value.encoding !== 'base64'
    || !Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 1 || (value.byteLength as number) > STREAM_LIMITS.chunkBytes
    || typeof value.data !== 'string' || value.data.length !== 4 * Math.ceil((value.byteLength as number) / 3)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) return false
  try { const raw = atob(value.data); return raw.length === value.byteLength && btoa(raw) === value.data } catch { return false }
}
export function encodeWireBytes(value: Uint8Array): WireBytes {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > STREAM_LIMITS.chunkBytes) throw new ServiceProtocolError('INVALID_ARGUMENTS')
  let raw = ''
  for (const byte of value) raw += String.fromCharCode(byte)
  return { version: 1, encoding: 'base64', byteLength: value.byteLength, data: btoa(raw) }
}
export function decodeWireBytes(value: unknown): Uint8Array {
  if (!isWireBytes(value)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
  return Uint8Array.from(atob(value.data), byte => byte.charCodeAt(0))
}
export function isStreamChunk(value: unknown): value is StreamChunk {
  return isRecord(value) && hasExactKeys(value, ['version', 'streamId', 'ownerId', 'sequence', 'bytes']) && fields(value) && sequence(value.sequence) && isWireBytes(value.bytes)
}
export function isStreamEnd(value: unknown): value is StreamEnd {
  return isRecord(value) && hasExactKeys(value, ['version', 'streamId', 'ownerId', 'sequence']) && fields(value) && sequence(value.sequence)
}
export function isStreamAck(value: unknown): value is StreamAck {
  return isRecord(value) && hasExactKeys(value, ['version', 'streamId', 'ownerId', 'sequence', 'closed']) && fields(value) && sequence(value.sequence) && typeof value.closed === 'boolean'
}
export function streamJson(value: StreamDescriptor | StreamChunk | StreamEnd | StreamAck): JsonValue { return value as unknown as JsonValue }
