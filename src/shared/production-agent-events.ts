import type { DesktopEventMap } from './desktop-operations'
import { isDatabaseId } from './database-desktop-codecs'
import { AGENT_EVENT_CODECS, AGENT_RECOVERY_ERROR } from './agent-desktop-codecs'
import { PRODUCTION_AGENT_CODECS, projectProductionAgentQueue } from './production-agent-codecs'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const PRODUCTION_INCOMPATIBLE_SESSION_ERROR = 'The backend session is no longer available. Start a new session to continue with a recap.'
const incompatible = (value: unknown): value is JsonValue => isRecord(value) && hasExactKeys(value, ['taskId', 'agentId', 'error']) &&
  isDatabaseId(value.taskId) && isDatabaseId(value.agentId) && value.error === PRODUCTION_INCOMPATIBLE_SESSION_ERROR &&
  isJsonValue(value) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 2048

function queue(value: unknown): JsonValue {
  if (!isRecord(value) || !hasExactKeys(value, ['queue'], ['failed'])) throw new ServiceProtocolError('INVALID_ARGUMENTS')
  const rows = projectProductionAgentQueue(value.queue)
  if (value.failed !== undefined && (!isRecord(value.failed) || !hasExactKeys(value.failed, ['taskId', 'error']) || typeof value.failed.taskId !== 'string' || typeof value.failed.error !== 'string'))
    throw new ServiceProtocolError('INVALID_ARGUMENTS')
  return { queue: rows, ...(isRecord(value.failed) ? { failed: { taskId: value.failed.taskId as string, error: AGENT_RECOVERY_ERROR } } : {}) }
}
function validQueue(value: unknown): boolean {
  try {
    if (!isRecord(value) || !isJsonValue(value) || !hasExactKeys(value, ['queue'], ['failed'])) return false
    if (!PRODUCTION_AGENT_CODECS['agent:getStartQueue'].validateResult(value.queue)) return false
    return value.failed === undefined || isRecord(value.failed) && hasExactKeys(value.failed, ['taskId', 'error']) &&
      typeof value.failed.taskId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.failed.taskId) && value.failed.error === AGENT_RECOVERY_ERROR
  } catch { return false }
}

/** The diagnostic queue is limited to one conversation; production has its
 * own finite, redacted queue contract. Native session observations stay exact. */
export const PRODUCTION_AGENT_EVENT_CODECS = {
  ...AGENT_EVENT_CODECS,
  'agent:incompatible-session': {
    validatePayload: incompatible,
    encodePayload(value: unknown): JsonValue {
      if (!isRecord(value) || !hasExactKeys(value, ['taskId', 'agentId', 'error']) || !isDatabaseId(value.taskId) || !isDatabaseId(value.agentId) || typeof value.error !== 'string') throw new ServiceProtocolError('INVALID_ARGUMENTS')
      const result = { taskId: value.taskId, agentId: value.agentId, error: PRODUCTION_INCOMPATIBLE_SESSION_ERROR }
      if (!incompatible(result)) throw new ServiceProtocolError('INVALID_RESULT')
      return result
    },
    decodePayload(value: JsonValue): DesktopEventMap['agent:incompatible-session'] {
      if (!incompatible(value)) throw new ServiceProtocolError('INVALID_RESULT')
      return value as unknown as DesktopEventMap['agent:incompatible-session']
    }
  },
  'agent:startQueueChanged': {
    validatePayload: validQueue,
    encodePayload(value: unknown): JsonValue { const result = queue(value); if (!validQueue(result)) throw new ServiceProtocolError('INVALID_RESULT'); return result },
    decodePayload(value: JsonValue): DesktopEventMap['agent:startQueueChanged'] {
      if (!validQueue(value)) throw new ServiceProtocolError('INVALID_RESULT')
      return value as unknown as DesktopEventMap['agent:startQueueChanged']
    }
  },
  'agent:recoveryStateChanged': {
    ...AGENT_EVENT_CODECS['agent:recoveryStateChanged'],
    encodePayload(value: unknown): JsonValue {
      if (!isRecord(value) || !hasExactKeys(value, ['taskId', 'cause', 'action', 'result', 'error']) || value.error !== null && typeof value.error !== 'string')
        throw new ServiceProtocolError('INVALID_ARGUMENTS')
      return AGENT_EVENT_CODECS['agent:recoveryStateChanged'].encodePayload({ ...value, error: value.error === null ? null : AGENT_RECOVERY_ERROR })
    }
  }
}
