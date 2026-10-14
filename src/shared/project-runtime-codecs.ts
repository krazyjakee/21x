import type { DesktopCommandMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { isDatabaseId } from './database-desktop-codecs'
import { workspaceFileAbsolutePath } from './workspace-file-codecs'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const PROJECT_RUNTIME_OPERATIONS = ['project:getStatus', 'project:getAllStatuses', 'project:getStatusHistory', 'project:getCaptainMemory', 'projectLimits:getState', 'projectLimits:isAllPaused', 'projectLimits:pauseAll', 'concurrency:getState', 'concurrency:setCaptainControl', 'concurrency:pin'] as const
export type ProjectRuntimeOperation = typeof PROJECT_RUNTIME_OPERATIONS[number]
export const PROJECT_RUNTIME_LIMITS = { projects: 128, tasks: 4096, agents: 128, queue: 256, configBytes: 65536, history: 20, resultBytes: 890000, requests: 16, memoryBytes: 128 * 1024, memoryChars: 12000 } as const
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
const shape = (v: unknown, keys: string[], optional: string[] = []): v is Record<string, unknown> => isRecord(v) && hasExactKeys(v, keys, optional)
const text = (v: unknown, bytes: number): v is string => typeof v === 'string' && new TextEncoder().encode(v).length <= bytes && new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(v)) === v
const label = (v: unknown, bytes = 512): v is string => text(v, bytes) && !/[\u0000-\u001f\u007f]/.test(v)
const number = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const nullableNumber = (v: unknown): boolean => v === null || number(v)
const date = (v: unknown): boolean => v === null || label(v, 64)
const list = (v: unknown, count: number, validate: (item: unknown) => boolean): v is unknown[] => Array.isArray(v) && v.length <= count && v.every(validate)
const reason = (v: unknown): boolean => v === null || ['project_limit', 'project_daily_cap', 'project_paused', 'global_pause'].includes(v as string)
function limits(v: unknown): boolean {
  return shape(v, ['projectId', 'paused', 'allProjectsPaused', 'maxConcurrentAgents', 'runningAgents', 'dailySessionCap', 'sessionsStartedToday', 'dailyTokenCap', 'tokensToday', 'queued', 'blockedBy']) && isDatabaseId(v.projectId) && typeof v.paused === 'boolean' && typeof v.allProjectsPaused === 'boolean' && nullableNumber(v.maxConcurrentAgents) && number(v.runningAgents) && nullableNumber(v.dailySessionCap) && number(v.sessionsStartedToday) && nullableNumber(v.dailyTokenCap) && number(v.tokensToday) && reason(v.blockedBy) && list(v.queued, PROJECT_RUNTIME_LIMITS.queue, q => shape(q, ['taskId', 'agentId', 'reason', 'queuedAt', 'position']) && isDatabaseId(q.taskId) && isDatabaseId(q.agentId) && label(q.reason, 2048) && label(q.queuedAt, 64) && number(q.position))
}
function status(v: unknown): boolean {
  return shape(v, ['project_id', 'counts', 'summary', 'top_blockers', 'updated_at'], ['limits']) && isDatabaseId(v.project_id) && shape(v.counts, ['running', 'queued', 'awaiting_review', 'awaiting_approval', 'blocked']) && Object.values(v.counts).every(number) && text(v.summary, 8000) && list(v.top_blockers, 16, x => text(x, 1600)) && date(v.updated_at) && (v.limits === undefined || limits(v.limits))
}
function overview(v: unknown): boolean {
  return shape(v, ['project_id', 'name', 'brief', 'is_default', 'sort_order', 'status', 'pending_approvals', 'running_agents', 'paused', 'all_projects_paused', 'blocked_by', 'last_activity_at', 'needs_attention']) && isDatabaseId(v.project_id) && label(v.name, 1024) && text(v.brief, 16384) && typeof v.is_default === 'boolean' && number(v.sort_order) && status(v.status) && (v.status as Record<string, unknown>).project_id === v.project_id && number(v.pending_approvals) && number(v.running_agents) && typeof v.paused === 'boolean' && typeof v.all_projects_paused === 'boolean' && reason(v.blocked_by) && date(v.last_activity_at) && typeof v.needs_attention === 'boolean'
}
function history(v: unknown): boolean {
  return shape(v, ['entries', 'has_more', 'next_cursor']) && typeof v.has_more === 'boolean' && (v.next_cursor === null || label(v.next_cursor, 300)) && list(v.entries, PROJECT_RUNTIME_LIMITS.history, e => shape(e, ['id', 'project_id', 'summary', 'completed', 'blockers', 'decisions', 'next_steps', 'source', 'correlation_id', 'created_at']) && isDatabaseId(e.id) && isDatabaseId(e.project_id) && text(e.summary, 8000) && ['completed', 'blockers', 'decisions', 'next_steps'].every(key => list(e[key], 16, x => text(x, 1600))) && ['captain', 'system_recovery', 'compaction'].includes(e.source as string) && (e.correlation_id === null || label(e.correlation_id, 512)) && label(e.created_at, 64))
}
function concurrency(v: unknown): boolean {
  return shape(v, ['projectId', 'captainControl', 'agents', 'pressure', 'recentChanges']) && isDatabaseId(v.projectId) && typeof v.captainControl === 'boolean' && list(v.agents, PROJECT_RUNTIME_LIMITS.agents, a => shape(a, ['agentId', 'agentName', 'cap', 'level', 'source', 'runningInProject', 'runningTotal', 'queuedInProject', 'recommendation']) && isDatabaseId(a.agentId) && label(a.agentName, 1024) && number(a.cap) && Number(a.cap) >= 1 && Number(a.cap) <= 10 && number(a.level) && Number(a.level) >= 1 && Number(a.level) <= Number(a.cap) && ['captain', 'pinned', 'cap'].includes(a.source as string) && number(a.runningInProject) && number(a.runningTotal) && number(a.queuedInProject) && shape(a.recommendation, ['level', 'why']) && number(a.recommendation.level) && label(a.recommendation.why, 2048)) && (v.pressure === null || shape(v.pressure, ['underPressure', 'reasons', 'freeMemRatio', 'loadPerCpu']) && typeof v.pressure.underPressure === 'boolean' && list(v.pressure.reasons, 16, x => label(x, 2048)) && typeof v.pressure.freeMemRatio === 'number' && Number.isFinite(v.pressure.freeMemRatio) && v.pressure.freeMemRatio >= 0 && typeof v.pressure.loadPerCpu === 'number' && Number.isFinite(v.pressure.loadPerCpu) && v.pressure.loadPerCpu >= 0) && list(v.recentChanges, 20, a => shape(a, ['id', 'project_id', 'agent_id', 'kind', 'previous_level', 'level', 'cap', 'actor', 'reason', 'created_at']) && isDatabaseId(a.id) && isDatabaseId(a.project_id) && (a.agent_id === '' || isDatabaseId(a.agent_id)) && ['level', 'pin', 'unpin', 'control_on', 'control_off'].includes(a.kind as string) && nullableNumber(a.previous_level) && nullableNumber(a.level) && number(a.cap) && ['captain', 'user', 'system'].includes(a.actor as string) && text(a.reason, 4096) && label(a.created_at, 64))
}
const query = (v: unknown, allowUndefined = false): boolean => v === undefined && allowUndefined || shape(v, [], ['limit', 'cursor']) && (v.limit === undefined ? allowUndefined || !Object.hasOwn(v, 'limit') : typeof v.limit === 'number' && Number.isFinite(v.limit)) && (v.cursor === undefined ? allowUndefined || !Object.hasOwn(v, 'cursor') : v.cursor === null || label(v.cursor, 300))
const keys: Record<ProjectRuntimeOperation, string[]> = { 'project:getStatus': ['projectId'], 'project:getAllStatuses': [], 'project:getStatusHistory': ['projectId', 'query'], 'project:getCaptainMemory': ['projectId'], 'projectLimits:getState': ['projectId'], 'projectLimits:isAllPaused': [], 'projectLimits:pauseAll': ['paused'], 'concurrency:getState': ['projectId'], 'concurrency:setCaptainControl': ['projectId', 'enabled'], 'concurrency:pin': ['projectId', 'agentId', 'level'] }
function argumentsValid(op: ProjectRuntimeOperation, v: unknown): v is unknown[] {
  if (!Array.isArray(v)) return false
  if (op === 'project:getAllStatuses' || op === 'projectLimits:isAllPaused') return v.length === 0
  if (op === 'projectLimits:pauseAll') return v.length === 1 && typeof v[0] === 'boolean'
  if (!isDatabaseId(v[0])) return false
  if (op === 'project:getStatusHistory') return (v.length === 1 || v.length === 2) && query(v[1], true)
  if (op === 'concurrency:setCaptainControl') return v.length === 2 && typeof v[1] === 'boolean'
  if (op === 'concurrency:pin') return v.length === 3 && isDatabaseId(v[1]) && (v[2] === null || number(v[2]) && Number(v[2]) >= 1 && Number(v[2]) <= 10)
  return v.length === 1
}
function resultValid(op: ProjectRuntimeOperation, v: unknown): boolean {
  if (!isJsonValue(v) || new TextEncoder().encode(JSON.stringify({ defined: true, value: v })).length >= PROJECT_RUNTIME_LIMITS.resultBytes) return false
  switch (op) {
    case 'project:getStatus': return status(v)
    case 'project:getAllStatuses': return list(v, PROJECT_RUNTIME_LIMITS.projects, overview)
    case 'project:getStatusHistory': return history(v)
    case 'project:getCaptainMemory': return v === null || shape(v, ['path', 'content', 'truncated']) && workspaceFileAbsolutePath(v.path) && text(v.content, PROJECT_RUNTIME_LIMITS.memoryChars * 4) && String(v.content).length <= PROJECT_RUNTIME_LIMITS.memoryChars && typeof v.truncated === 'boolean'
    case 'projectLimits:getState': return limits(v)
    case 'projectLimits:isAllPaused': case 'projectLimits:pauseAll': return typeof v === 'boolean'
    case 'concurrency:getState': return concurrency(v)
    default: return shape(v, ['success']) && v.success === true || shape(v, ['error']) && label(v.error, 2048)
  }
}
export interface ProjectRuntimeCodec<K extends ProjectRuntimeOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
function codec<K extends ProjectRuntimeOperation>(operation: K): ProjectRuntimeCodec<K> {
  return {
    validateArguments: value => argumentsValid(operation, value),
    encodeArguments(value) { if (!argumentsValid(operation, value)) return fail('INVALID_ARGUMENTS'); const v = Object.fromEntries(keys[operation].flatMap((key, index) => value[index] === undefined ? [] : [[key, key === 'query' ? Object.fromEntries(Object.entries(value[index] as object).filter(([, item]) => item !== undefined)) : value[index]]])); return v as JsonValue },
    decodeArguments(v) { const optional = operation === 'project:getStatusHistory' ? ['query'] : []; if (!shape(v, keys[operation].filter(key => !optional.includes(key)), optional) || operation === 'project:getStatusHistory' && Object.hasOwn(v, 'query') && !query(v.query)) return fail('INVALID_ARGUMENTS'); const args = keys[operation].map(key => v[key]); if (!argumentsValid(operation, args)) return fail('INVALID_ARGUMENTS'); return args as DesktopCommandMap[K]['apiArguments'] },
    validateResult: value => resultValid(operation, value),
    encodeResult(value) { if (!resultValid(operation, value)) return fail('INVALID_RESULT'); return { defined: true, value: value as JsonValue } },
    decodeResult(value) { if (!resultValid(operation, value)) return fail('INVALID_RESULT'); return value as DesktopCommandMap[K]['result'] },
    validateWireResult: v => shape(v, ['defined', 'value']) && v.defined === true && resultValid(operation, v.value)
  }
}
export const PROJECT_RUNTIME_CODECS = Object.fromEntries(PROJECT_RUNTIME_OPERATIONS.map(op => [op, codec(op)])) as { [K in ProjectRuntimeOperation]: ProjectRuntimeCodec<K> }
