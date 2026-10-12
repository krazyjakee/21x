import type { DesktopCommandMap, DesktopEventMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { CONFIGURATION_COMMAND_CODECS } from './configuration-desktop-codecs'
import { DATABASE_EVENT_CODECS, isDatabaseId } from './database-desktop-codecs'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const AGENT_DESKTOP_OPERATIONS = ['agent:getAll', 'agentSession:start', 'agentSession:resume', 'agentSession:approve', 'agentSession:stop'] as const
export type AgentDesktopOperation = typeof AGENT_DESKTOP_OPERATIONS[number]
export const AGENT_DESKTOP_EVENTS = ['agent:status', 'task:updated', 'transcript:changed', 'agent:startQueueChanged', 'project:statusChanged', 'concurrency:changed', 'agent:recoveryStateChanged'] as const
export type AgentDesktopEvent = typeof AGENT_DESKTOP_EVENTS[number]
export const AGENT_RECOVERY_ERROR = 'The agent operation failed.'

const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0')
export const isAgentRequestId = (value: unknown): value is string => text(value, 512) && !!value.trim()
const positive = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 1
const object = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> => isRecord(value) && hasExactKeys(value, required, optional)
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
const queueReasons = ['agent_limit', 'global_limit', 'global_pause', 'project_paused', 'project_daily_cap', 'project_limit', 'concurrency_level', 'file_overlap', 'recovery', 'dependency', 'agent_unavailable']
const startResult = (value: unknown): boolean => object(value, ['sessionId']) && isDatabaseId(value.sessionId) ||
  object(value, ['sessionId', 'queued', 'queuePosition', 'queueReason']) && value.sessionId === '' && value.queued === true && positive(value.queuePosition) && queueReasons.includes(value.queueReason as string)
const resumeResult = (value: unknown): boolean => object(value, ['sessionId']) && isDatabaseId(value.sessionId) ||
  object(value, ['sessionId', 'ended']) && value.sessionId === '' && value.ended === true
const successResult = (value: unknown): boolean => object(value, ['success']) && typeof value.success === 'boolean'

interface Codec<K extends AgentDesktopOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
interface Schema {
  validateArguments(args: unknown): args is unknown[]
  encode(args: unknown[]): JsonValue
  decode(payload: JsonValue): unknown[]
  validateResult(value: unknown): boolean
}
const schemas: Record<Exclude<AgentDesktopOperation, 'agent:getAll'>, Schema> = {
  'agentSession:start': {
    validateArguments: (args): args is unknown[] => Array.isArray(args) && args.length >= 2 && args.length <= 4 && isDatabaseId(args[0]) && isDatabaseId(args[1]) &&
      args[2] === undefined && (args[3] === undefined || typeof args[3] === 'boolean'),
    encode: args => ({ agentId: args[0] as string, taskId: args[1] as string, ...(args[3] === undefined ? {} : { skipInitialPrompt: args[3] as boolean }) }),
    decode: value => {
      if (!object(value, ['agentId', 'taskId'], ['skipInitialPrompt']) || !isDatabaseId(value.agentId) || !isDatabaseId(value.taskId) ||
        value.skipInitialPrompt !== undefined && typeof value.skipInitialPrompt !== 'boolean') return fail('INVALID_ARGUMENTS')
      return value.skipInitialPrompt === undefined ? [value.agentId, value.taskId] : [value.agentId, value.taskId, undefined, value.skipInitialPrompt]
    },
    validateResult: startResult
  },
  'agentSession:resume': {
    validateArguments: (args): args is unknown[] => Array.isArray(args) && args.length === 3 && args.every(isDatabaseId),
    encode: args => ({ agentId: args[0] as string, taskId: args[1] as string, sessionId: args[2] as string }),
    decode: value => { if (!object(value, ['agentId', 'taskId', 'sessionId']) || ![value.agentId, value.taskId, value.sessionId].every(isDatabaseId)) return fail('INVALID_ARGUMENTS'); return [value.agentId, value.taskId, value.sessionId] },
    validateResult: resumeResult
  },
  'agentSession:approve': {
    // The shipping API makes requestId optional; the native/service contract
    // requires its fifth positional slot. Only declared optionals omit undefined.
    validateArguments: (args): args is unknown[] => Array.isArray(args) && args.length === 5 && isDatabaseId(args[0]) && typeof args[1] === 'boolean' &&
      (args[2] === undefined || text(args[2], 65_536)) && (args[3] === undefined || ['permission', 'question'].includes(args[3] as string)) && isAgentRequestId(args[4]),
    encode: args => ({ sessionId: args[0] as string, approved: args[1] as boolean, requestId: args[4] as string,
      ...(args[2] === undefined ? {} : { message: args[2] as string }), ...(args[3] === undefined ? {} : { responseType: args[3] as string }) }),
    decode: value => { if (!object(value, ['sessionId', 'approved', 'requestId'], ['message', 'responseType']) || !isDatabaseId(value.sessionId) || typeof value.approved !== 'boolean' || !isAgentRequestId(value.requestId) ||
      value.message !== undefined && !text(value.message, 65_536) || value.responseType !== undefined && !['permission', 'question'].includes(value.responseType as string)) return fail('INVALID_ARGUMENTS');
      return [value.sessionId, value.approved, value.message, value.responseType, value.requestId] },
    validateResult: successResult
  },
  'agentSession:stop': {
    validateArguments: (args): args is unknown[] => Array.isArray(args) && args.length === 1 && isDatabaseId(args[0]),
    encode: args => ({ sessionId: args[0] as string }),
    decode: value => { if (!object(value, ['sessionId']) || !isDatabaseId(value.sessionId)) return fail('INVALID_ARGUMENTS'); return [value.sessionId] },
    validateResult: successResult
  }
}
function codec<K extends Exclude<AgentDesktopOperation, 'agent:getAll'>>(operation: K): Codec<K> {
  const schema = schemas[operation]
  return {
    validateArguments: schema.validateArguments,
    encodeArguments(args) { if (!schema.validateArguments(args)) return fail('INVALID_ARGUMENTS'); return schema.encode(args) },
    decodeArguments(payload) { if (!isJsonValue(payload)) return fail('INVALID_ARGUMENTS'); const args = schema.decode(payload); if (!schema.validateArguments(args)) return fail('INVALID_ARGUMENTS'); return args as DesktopCommandMap[K]['apiArguments'] },
    encodeResult(value) { if (!schema.validateResult(value) || !isJsonValue(value)) return fail('INVALID_RESULT'); return { defined: true, value } },
    decodeResult(value) { if (!schema.validateResult(value) || !isJsonValue(value)) return fail('INVALID_RESULT'); return value as unknown as DesktopCommandMap[K]['result'] },
    validateResult: schema.validateResult,
    validateWireResult: value => object(value, ['defined', 'value']) && value.defined === true && schema.validateResult(value.value) && isJsonValue(value.value)
  }
}
export const AGENT_COMMAND_CODECS: { [K in AgentDesktopOperation]: Codec<K> } = {
  'agent:getAll': CONFIGURATION_COMMAND_CODECS['agent:getAll'],
  'agentSession:start': codec('agentSession:start'), 'agentSession:resume': codec('agentSession:resume'),
  'agentSession:approve': codec('agentSession:approve'), 'agentSession:stop': codec('agentSession:stop')
}

const statusPayload = (value: unknown): boolean => object(value, ['sessionId', 'agentId', 'taskId', 'status'], ['epoch', 'seq', 'heartbeat']) &&
  [value.sessionId, value.agentId, value.taskId].every(isDatabaseId) && ['idle', 'working', 'waiting_approval', 'error'].includes(value.status as string) &&
  (Object.hasOwn(value, 'epoch') === Object.hasOwn(value, 'seq')) &&
  (!Object.hasOwn(value, 'epoch') || typeof value.epoch === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.epoch) && positive(value.seq)) &&
  (!Object.hasOwn(value, 'heartbeat') || value.heartbeat === true && Object.hasOwn(value, 'epoch'))
const projectInvalidation = (value: unknown): boolean => object(value, ['projectId']) && isDatabaseId(value.projectId)
const token = (value: unknown): boolean => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,127}$/.test(value)
const recoveryPayload = (value: unknown): boolean => object(value, ['taskId', 'cause', 'action', 'result', 'error']) && isDatabaseId(value.taskId) &&
  [value.cause, value.action, value.result].every(token) && (value.error === null || value.error === AGENT_RECOVERY_ERROR)
export const AGENT_QUEUE_FIELDS = ['id', 'taskId', 'projectId', 'agentId', 'reason', 'queuedAt', 'position', 'priority', 'state', 'retryCount', 'nextRetryAt', 'generation', 'dependencyReason', 'recoveryCause', 'recoveryAction', 'recoveryResult', 'lastError'] as const
const nullableToken = (value: unknown): boolean => value === null || token(value)
const nonnegative = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0
const queueEntry = (value: unknown): boolean => object(value, [...AGENT_QUEUE_FIELDS]) &&
  [value.id, value.taskId, value.projectId, value.agentId].every(isDatabaseId) && queueReasons.includes(value.reason as string) &&
  text(value.queuedAt, 128) && positive(value.position) && (value.priority === null || text(value.priority, 128)) &&
  ['queued', 'retrying', 'claimed', 'starting', 'started', 'recovered', 'failed', 'cancelled'].includes(value.state as string) &&
  nonnegative(value.retryCount) && nonnegative(value.generation) && (value.nextRetryAt === null || text(value.nextRetryAt, 128)) &&
  [value.dependencyReason, value.recoveryCause, value.recoveryAction, value.recoveryResult].every(nullableToken) &&
  (value.lastError === null || value.lastError === AGENT_RECOVERY_ERROR)
const queuePayload = (value: unknown): boolean => object(value, ['queue'], ['failed']) && Array.isArray(value.queue) && value.queue.length <= 1 && value.queue.every(queueEntry) &&
  (!Object.hasOwn(value, 'failed') || object(value.failed, ['taskId', 'error']) && isDatabaseId(value.failed.taskId) && value.failed.error === AGENT_RECOVERY_ERROR)
function event<K extends AgentDesktopEvent>(check: (value: unknown) => boolean) {
  return {
    validatePayload: check,
    decodePayload(value: JsonValue): DesktopEventMap[K] { if (!check(value) || !isJsonValue(value)) return fail('INVALID_RESULT'); return value as unknown as DesktopEventMap[K] },
    encodePayload(value: unknown): JsonValue { if (!check(value) || !isJsonValue(value)) return fail('INVALID_ARGUMENTS'); return value }
  }
}
export const AGENT_EVENT_CODECS = {
  'agent:status': event<'agent:status'>(statusPayload),
  'task:updated': DATABASE_EVENT_CODECS['task:updated'], 'transcript:changed': DATABASE_EVENT_CODECS['transcript:changed'],
  // The actual start claim appears before adapter creation; never fake an empty
  // queue or omit this critical transition. The one conversation caps it at one.
  'agent:startQueueChanged': event<'agent:startQueueChanged'>(queuePayload),
  'project:statusChanged': event<'project:statusChanged'>(projectInvalidation), 'concurrency:changed': event<'concurrency:changed'>(projectInvalidation),
  'agent:recoveryStateChanged': event<'agent:recoveryStateChanged'>(recoveryPayload)
}
