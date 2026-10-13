import type { DesktopCommandMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { isDatabaseId } from './database-desktop-codecs'
import { AGENT_COMMAND_CODECS, AGENT_QUEUE_FIELDS, AGENT_RECOVERY_ERROR, isAgentRequestId } from './agent-desktop-codecs'
import { hasExactKeys, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const PRODUCTION_AGENT_OPERATIONS = [
  'agentSession:start', 'agentSession:startTask', 'agentSession:resume', 'agentSession:send', 'agentSession:sendByTaskId',
  'agentSession:abort', 'agentSession:stop', 'agentSession:stopByTaskId', 'agentSession:switchAgent', 'agentSession:approve',
  'agent:getStartQueue', 'agent:getStartRecoveryState', 'agentSession:getRawTranscript',
  'captainRuntime:get', 'captainRuntime:switch', 'captainRuntime:retry', 'captainRuntime:rollback'
] as const
export type ProductionAgentOperation = typeof PRODUCTION_AGENT_OPERATIONS[number]
export const PRODUCTION_AGENT_LIMITS = { bytes: 262_144, values: 16_384, queue: 512, attachments: 16, message: 65_536, transcriptMessages: 100, transcriptParts: 512 } as const
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0')
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const nullableId = (value: unknown): boolean => value === null || isDatabaseId(value)
const optional = (check: (value: unknown) => boolean) => (value: unknown): boolean => value === undefined || check(value)
const object = (value: unknown, required: readonly string[], allowed: readonly string[] = []): value is Record<string, unknown> => isRecord(value) && hasExactKeys(value, [...required], [...allowed])
const attachment = (value: unknown): boolean => object(value, ['id', 'filename', 'size', 'mime_type']) && isDatabaseId(value.id) && text(value.filename, 256) && !!value.filename && integer(value.size) && text(value.mime_type, 128)
const attachments = (value: unknown): boolean => Array.isArray(value) && value.length <= PRODUCTION_AGENT_LIMITS.attachments && value.every(attachment) && new Set(value.map(item => item.id)).size === value.length
const reasons = ['agent_limit', 'global_limit', 'global_pause', 'project_paused', 'project_daily_cap', 'project_limit', 'concurrency_level', 'file_overlap', 'recovery', 'dependency', 'agent_unavailable']
const queueStates = ['queued', 'retrying', 'claimed', 'starting', 'started', 'recovered', 'failed', 'cancelled']
const nullableText = (value: unknown): boolean => value === null || text(value, 128)
const queueEntry = (value: unknown): boolean => object(value, AGENT_QUEUE_FIELDS) &&
  [value.id, value.taskId, value.projectId, value.agentId].every(isDatabaseId) && reasons.includes(value.reason as string) &&
  text(value.queuedAt, 128) && integer(value.position) && (['started', 'recovered', 'failed', 'cancelled'].includes(value.state as string) || value.position > 0) && nullableText(value.priority) && queueStates.includes(value.state as string) &&
  integer(value.retryCount) && integer(value.generation) && [value.nextRetryAt, value.dependencyReason, value.recoveryCause, value.recoveryAction, value.recoveryResult].every(nullableText) &&
  (value.lastError === null || value.lastError === AGENT_RECOVERY_ERROR)
const queue = (value: unknown): boolean => Array.isArray(value) && value.length <= PRODUCTION_AGENT_LIMITS.queue && value.every(queueEntry)
export function projectProductionAgentQueue(value: unknown): JsonValue {
  if (!Array.isArray(value) || value.length > PRODUCTION_AGENT_LIMITS.queue) return fail('INVALID_RESULT')
  return value.map(row => {
    if (!object(row, AGENT_QUEUE_FIELDS) || row.lastError !== null && !text(row.lastError, 65_536)) return fail('INVALID_RESULT')
    const projected = { ...row, lastError: row.lastError === null ? null : AGENT_RECOVERY_ERROR }
    if (!queueEntry(projected)) return fail('INVALID_RESULT')
    return projected as { [key: string]: JsonValue }
  })
}
const runtimeFields = ['ownerId', 'projectId', 'generation', 'agentId', 'candidateAgentId', 'lastGoodAgentId', 'sessionId', 'phase', 'deadlineAt', 'lastProbeAt', 'probeOk', 'attemptCount', 'errorCode', 'errorDetail', 'createdAt', 'updatedAt']
const phases = ['starting_server', 'starting_session', 'verifying', 'healthy', 'unhealthy', 'failed', 'timed_out', 'retrying', 'recovering', 'rolled_back']
const runtime = (value: unknown): boolean => object(value, runtimeFields) && [value.ownerId, value.projectId, value.agentId].every(isDatabaseId) &&
  [value.candidateAgentId, value.lastGoodAgentId, value.sessionId].every(nullableId) && integer(value.generation) && integer(value.attemptCount) && phases.includes(value.phase as string) &&
  [value.deadlineAt, value.lastProbeAt].every(item => item === null || integer(item)) && (value.probeOk === null || typeof value.probeOk === 'boolean') &&
  nullableText(value.errorCode) && (value.errorDetail === null || value.errorDetail === AGENT_RECOVERY_ERROR) && integer(value.createdAt) && integer(value.updatedAt)
function projectRuntime(value: unknown): JsonValue {
  if (!object(value, runtimeFields) || value.errorDetail !== null && !text(value.errorDetail, 65_536)) return fail('INVALID_RESULT')
  const projected = { ...value, errorDetail: value.errorDetail === null ? null : AGENT_RECOVERY_ERROR }
  if (!runtime(projected)) return fail('INVALID_RESULT')
  return projected as { [key: string]: JsonValue }
}
const success = (value: unknown): boolean => object(value, ['success']) && typeof value.success === 'boolean'
const send = (value: unknown): boolean => object(value, ['success'], ['newSessionId']) && typeof value.success === 'boolean' && optional(isDatabaseId)(value.newSessionId)
const sendByTask = (value: unknown): boolean => object(value, ['success', 'sessionId'], ['newSessionId']) && typeof value.success === 'boolean' && nullableId(value.sessionId) && optional(isDatabaseId)(value.newSessionId)
const stopped = (value: unknown): boolean => object(value, ['success', 'sessionId']) && typeof value.success === 'boolean' && nullableId(value.sessionId)
const startTask = (value: unknown): boolean => object(value, ['action'], ['sessionId', 'startedTaskId', 'agentId', 'queuePosition', 'queueReason']) &&
  ['task_started', 'subtask_started', 'triage_started', 'already_running', 'queued', 'no_action'].includes(value.action as string) &&
  ['sessionId', 'startedTaskId', 'agentId'].every(key => optional(isDatabaseId)(value[key])) &&
  (value.action === 'queued' ? integer(value.queuePosition) && value.queuePosition > 0 && reasons.includes(value.queueReason as string) && value.sessionId === undefined
    : value.queuePosition === undefined && value.queueReason === undefined) &&
  (!['task_started', 'subtask_started', 'triage_started'].includes(value.action as string) || isDatabaseId(value.sessionId) && isDatabaseId(value.startedTaskId) && isDatabaseId(value.agentId))
function transcriptPart(value: unknown): boolean {
  if (!object(value, ['type'], ['content', 'tool']) || !text(value.type, 128) || !optional(item => text(item, 65_536))(value.content)) return false
  const tool = value.tool
  return tool === undefined || object(tool, ['name'], ['status', 'input', 'output', 'error']) && text(tool.name, 256) &&
    ['status', 'input', 'output', 'error'].every(key => optional(item => text(item, 65_536))(tool[key]))
}
const transcript = (value: unknown): boolean => Array.isArray(value) && value.length <= PRODUCTION_AGENT_LIMITS.transcriptMessages && value.every(message =>
  object(message, ['role', 'parts']) && ['user', 'assistant', 'system'].includes(message.role as string) && Array.isArray(message.parts) &&
  message.parts.length <= PRODUCTION_AGENT_LIMITS.transcriptParts && message.parts.every(transcriptPart))

/** Bound traversal before JSON.stringify. Cycles, hidden values and oversized
 * arrays fail instead of truncating a durable intent or a diagnostic reply. */
export function isBoundedProductionAgentJson(value: unknown): value is JsonValue {
  let values = 0, bytes = 0
  const ancestors = new Set<object>()
  const visit = (item: unknown, depth: number): boolean => {
    if (++values > PRODUCTION_AGENT_LIMITS.values || depth > 32) return false
    if (item === null || typeof item === 'boolean') { bytes += 5; return bytes <= PRODUCTION_AGENT_LIMITS.bytes }
    if (typeof item === 'number') { bytes += 32; return Number.isFinite(item) && bytes <= PRODUCTION_AGENT_LIMITS.bytes }
    if (typeof item === 'string') { if (item.length > PRODUCTION_AGENT_LIMITS.bytes) return false; bytes += new TextEncoder().encode(item).length + 2; return bytes <= PRODUCTION_AGENT_LIMITS.bytes }
    if (!item || typeof item !== 'object' || ancestors.has(item)) return false
    if (!Array.isArray(item) && !isRecord(item)) return false
    const keys = Object.keys(item)
    if (keys.length > PRODUCTION_AGENT_LIMITS.values || Array.isArray(item) && keys.length !== item.length) return false
    ancestors.add(item); bytes += keys.length * 3 + 2
    const valid = keys.every(key => { bytes += new TextEncoder().encode(key).length + 2; return bytes <= PRODUCTION_AGENT_LIMITS.bytes && visit((item as Record<string, unknown>)[key], depth + 1) })
    ancestors.delete(item)
    return valid && bytes <= PRODUCTION_AGENT_LIMITS.bytes
  }
  try { return visit(value, 0) && new TextEncoder().encode(JSON.stringify(value)).length <= PRODUCTION_AGENT_LIMITS.bytes }
  catch { return false }
}

interface Schema { fields: string[]; checks: Array<(value: unknown) => boolean>; required: number; result(value: unknown): boolean; project?(value: unknown): unknown }
const one = (field: string, result: Schema['result']): Schema => ({ fields: [field], checks: [isDatabaseId], required: 1, result })
const resultStart = AGENT_COMMAND_CODECS['agentSession:start'].validateResult
const resultResume = AGENT_COMMAND_CODECS['agentSession:resume'].validateResult
const messageCheck = (value: unknown): boolean => text(value, PRODUCTION_AGENT_LIMITS.message) && !!value.trim()
const schemas: Record<ProductionAgentOperation, Schema> = {
  'agentSession:start': { fields: ['agentId', 'taskId', 'workspaceDir', 'skipInitialPrompt'], checks: [isDatabaseId, isDatabaseId, value => value === undefined, optional(value => typeof value === 'boolean')], required: 2, result: resultStart },
  'agentSession:startTask': one('taskId', startTask),
  'agentSession:resume': { fields: ['agentId', 'taskId', 'sessionId'], checks: [isDatabaseId, isDatabaseId, isDatabaseId], required: 3, result: resultResume },
  'agentSession:abort': one('sessionId', success), 'agentSession:stop': one('sessionId', success), 'agentSession:stopByTaskId': one('taskId', stopped),
  'agentSession:switchAgent': { fields: ['taskId', 'newAgentId'], checks: [isDatabaseId, isDatabaseId], required: 2, result: resultStart },
  'agentSession:send': { fields: ['sessionId', 'message', 'taskId', 'agentId', 'attachments', 'deliveryId'], checks: [value => value === '' || isDatabaseId(value), messageCheck, optional(isDatabaseId), optional(isDatabaseId), optional(attachments), optional(isAgentRequestId)], required: 2, result: send },
  'agentSession:sendByTaskId': { fields: ['taskId', 'message', 'attachments', 'deliveryId'], checks: [isDatabaseId, messageCheck, optional(attachments), optional(isAgentRequestId)], required: 2, result: sendByTask },
  'agentSession:approve': { fields: ['sessionId', 'approved', 'message', 'responseType', 'requestId'], checks: [isDatabaseId, value => typeof value === 'boolean', optional(item => text(item, 65_536)), optional(value => value === 'permission' || value === 'question'), isAgentRequestId], required: 5, result: success },
  'agent:getStartQueue': { fields: [], checks: [], required: 0, result: queue, project: projectProductionAgentQueue },
  'agent:getStartRecoveryState': { ...one('taskId', value => value === null || queueEntry(value)), project: value => value === null ? null : (projectProductionAgentQueue([value]) as JsonValue[])[0] },
  'agentSession:getRawTranscript': { ...one('taskId', transcript), project: value => stripUndefined(value) },
  'captainRuntime:get': { ...one('projectId', value => value === null || runtime(value)), project: value => value === null ? null : projectRuntime(value) },
  'captainRuntime:switch': { fields: ['projectId', 'agentId'], checks: [isDatabaseId, isDatabaseId], required: 2, result: runtime, project: projectRuntime },
  'captainRuntime:retry': { ...one('projectId', runtime), project: projectRuntime }, 'captainRuntime:rollback': { ...one('projectId', runtime), project: projectRuntime }
}
function stripUndefined(value: unknown, depth = 0): unknown {
  if (depth > 16) return fail('INVALID_RESULT')
  if (Array.isArray(value)) {
    if (value.length > PRODUCTION_AGENT_LIMITS.transcriptParts) return fail('INVALID_RESULT')
    return value.map(item => stripUndefined(item, depth + 1))
  }
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, stripUndefined(item, depth + 1)]))
  return value
}
export interface ProductionAgentCodec<K extends ProductionAgentOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
function codec<K extends ProductionAgentOperation>(operation: K): ProductionAgentCodec<K> {
  const schema = schemas[operation]
  const argsValid = (args: unknown): args is unknown[] => Array.isArray(args) && args.length >= schema.required && args.length <= schema.fields.length && schema.checks.every((check, index) => check(args[index]))
  const resultValid = (value: unknown): boolean => schema.result(value) && isBoundedProductionAgentJson(value)
  return {
    validateArguments: argsValid,
    encodeArguments(args) {
      if (!argsValid(args)) return fail('INVALID_ARGUMENTS')
      const payload = Object.fromEntries(schema.fields.flatMap((key, index) => args[index] === undefined ? [] : [[key, args[index]]]))
      if (!isBoundedProductionAgentJson(payload)) return fail('INVALID_ARGUMENTS')
      return payload
    },
    decodeArguments(payload) {
      // The approval's intermediate optional slots are omitted on wire, while
      // its request identity remains mandatory. Workspace paths are never accepted.
      const required = schema.fields.filter((_, index) => index < schema.required && !schema.checks[index](undefined))
      if (!object(payload, required, schema.fields.filter(field => field !== 'workspaceDir')) || Object.hasOwn(payload, 'workspaceDir') || !isBoundedProductionAgentJson(payload)) return fail('INVALID_ARGUMENTS')
      const args = schema.fields.map(field => payload[field])
      if (!argsValid(args)) return fail('INVALID_ARGUMENTS')
      return args as DesktopCommandMap[K]['apiArguments']
    },
    encodeResult(value) { const projected = schema.project ? schema.project(value) : value; if (!resultValid(projected)) return fail('INVALID_RESULT'); return { defined: true, value: projected as JsonValue } },
    decodeResult(value) { if (!resultValid(value)) return fail('INVALID_RESULT'); return value as unknown as DesktopCommandMap[K]['result'] },
    validateResult: resultValid,
    validateWireResult: value => object(value, ['defined', 'value']) && value.defined === true && resultValid(value.value)
  }
}
export const PRODUCTION_AGENT_CODECS = Object.fromEntries(PRODUCTION_AGENT_OPERATIONS.map(operation => [operation, codec(operation)])) as { [K in ProductionAgentOperation]: ProductionAgentCodec<K> }
