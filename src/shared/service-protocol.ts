/** Private, host-neutral stdio contract. Stdout contains only these NDJSON frames. */
export const SERVICE_PROTOCOL_VERSION = 1 as const
export const SERVICE_LIMITS = {
  frameBytes: 1024 * 1024,
  pendingRequests: 128,
  activeRequests: 128,
  queuedFrames: 128,
  queuedBytes: 4 * 1024 * 1024,
  requestTimeoutMs: 30_000
} as const
/** Long installation work has a finite deadline without widening ordinary calls. */
export function serviceOperationTimeoutMs(operation: string): number {
  return operation === 'agent-installer:install' || operation === 'engine.agent.install' ? 180_000 : SERVICE_LIMITS.requestTimeoutMs
}


export const SERVICE_ERROR_MESSAGES = {
  INVALID_FRAME: 'Invalid protocol frame.',
  FRAME_TOO_LARGE: 'Protocol frame exceeds the size limit.',
  UNSUPPORTED_VERSION: 'Unsupported protocol version.',
  STALE_EPOCH: 'The service instance has changed.',
  INVALID_REQUEST: 'Invalid request.',
  UNKNOWN_OPERATION: 'Unknown operation.',
  INVALID_ARGUMENTS: 'Invalid operation arguments.',
  INVALID_RESULT: 'Invalid operation result.',
  SKILL_VERSION_CONFLICT: 'The skill changed. Reload it before writing.',
  INTERNAL_ERROR: 'The operation failed.',
  BACKPRESSURE: 'Transport capacity has been reached.',
  TIMEOUT: 'The operation timed out.',
  CANCELLED: 'The operation was cancelled.',
  DISCONNECTED: 'The service is unavailable.'
} as const

export type ServiceErrorCode = keyof typeof SERVICE_ERROR_MESSAGES
export type ServiceRole = 'host' | 'service'
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type RequestId = `${ServiceRole}:${string}`
interface Envelope { protocolVersion: typeof SERVICE_PROTOCOL_VERSION; engineEpoch: string }
export interface ServiceRequest extends Envelope {
  kind: 'request'
  requestId: RequestId
  operation: string
  payload: JsonValue
}
export type ServiceResponse = Envelope & { kind: 'response'; requestId: RequestId } & (
  { result: JsonValue; error?: never } | { error: { code: ServiceErrorCode; message: string }; result?: never }
)
export interface ServiceEvent extends Envelope {
  kind: 'event'
  operation: string
  payload: JsonValue
  sequence?: number
}
export type ServiceFrame = ServiceRequest | ServiceResponse | ServiceEvent

export class ServiceProtocolError extends Error {
  constructor(readonly code: ServiceErrorCode) {
    super(SERVICE_ERROR_MESSAGES[code])
    this.name = 'ServiceProtocolError'
  }
}

export function serviceError(code: ServiceErrorCode): { code: ServiceErrorCode; message: string } {
  return { code, message: SERVICE_ERROR_MESSAGES[code] }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

export function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}

export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(item => isJsonValue(item, depth + 1))
  return isRecord(value) && Object.values(value).every(item => isJsonValue(item, depth + 1))
}

export function isRequestId(value: unknown): value is RequestId {
  // Ordered monotonic IDs let peers reject replay without an unbounded seen-ID set.
  return typeof value === 'string' && /^(host|service):[1-9][0-9]{0,31}$/.test(value)
}

export function isOperation(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && /^[a-zA-Z][a-zA-Z0-9_.:-]*$/.test(value)
}

export function isBootstrapOperation(operation: string): boolean {
  return operation === 'engine.initialize' || operation === 'engine.ping'
}

/** Throws fixed errors; never copies arbitrary frame content into diagnostics. */
export function validateServiceFrame(value: unknown): ServiceFrame {
  try { return validateFrame(value) }
  catch (error) {
    throw error instanceof ServiceProtocolError ? error : new ServiceProtocolError('INVALID_FRAME')
  }
}

function validateFrame(value: unknown): ServiceFrame {
  if (!isRecord(value)) throw new ServiceProtocolError('INVALID_FRAME')
  if (value.protocolVersion !== SERVICE_PROTOCOL_VERSION) throw new ServiceProtocolError('UNSUPPORTED_VERSION')
  if (typeof value.engineEpoch !== 'string' || value.engineEpoch.length > 128 ||
    (value.engineEpoch !== '' && !/^[a-zA-Z0-9_-]+$/.test(value.engineEpoch))) {
    throw new ServiceProtocolError('INVALID_FRAME')
  }
  const common = ['kind', 'protocolVersion', 'engineEpoch']
  if (value.kind === 'request') {
    if (!hasExactKeys(value, [...common, 'requestId', 'operation', 'payload']) ||
      !isRequestId(value.requestId) || !isOperation(value.operation) || !isJsonValue(value.payload)) {
      throw new ServiceProtocolError('INVALID_FRAME')
    }
  } else if (value.kind === 'response') {
    if (!isRequestId(value.requestId)) throw new ServiceProtocolError('INVALID_FRAME')
    if (Object.hasOwn(value, 'result')) {
      if (!hasExactKeys(value, [...common, 'requestId', 'result']) || !isJsonValue(value.result)) {
        throw new ServiceProtocolError('INVALID_FRAME')
      }
    } else if (!hasExactKeys(value, [...common, 'requestId', 'error']) || !isRecord(value.error) ||
      !hasExactKeys(value.error, ['code', 'message']) || typeof value.error.code !== 'string' ||
      !Object.hasOwn(SERVICE_ERROR_MESSAGES, value.error.code) || typeof value.error.message !== 'string' ||
      value.error.message.length > 256) {
      throw new ServiceProtocolError('INVALID_FRAME')
    }
  } else if (value.kind === 'event') {
    if (!hasExactKeys(value, [...common, 'operation', 'payload'], ['sequence']) ||
      !isOperation(value.operation) || !isJsonValue(value.payload) ||
      (Object.hasOwn(value, 'sequence') && (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0))) {
      throw new ServiceProtocolError('INVALID_FRAME')
    }
  } else throw new ServiceProtocolError('INVALID_FRAME')
  return value as unknown as ServiceFrame
}

export function isBootstrapResult(value: unknown): value is { protocolVersion: 1; engineEpoch: string; nodeVersion: string } {
  return isRecord(value) && hasExactKeys(value, ['protocolVersion', 'engineEpoch', 'nodeVersion']) &&
    value.protocolVersion === SERVICE_PROTOCOL_VERSION && typeof value.engineEpoch === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(value.engineEpoch) && typeof value.nodeVersion === 'string' && value.nodeVersion.length <= 128
}

export function isInitializePayload(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['protocolVersion', 'profileRoot', 'resourceRoot']) &&
    value.protocolVersion === SERVICE_PROTOCOL_VERSION &&
    typeof value.profileRoot === 'string' && value.profileRoot.length > 0 && value.profileRoot.length <= 4096 &&
    typeof value.resourceRoot === 'string' && value.resourceRoot.length > 0 && value.resourceRoot.length <= 4096
}
