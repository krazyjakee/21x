import type { DesktopCommandMap, DesktopEventMap } from './desktop-operations'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'
import type { OptionalResult } from './host-services'

export const DATABASE_DESKTOP_OPERATIONS = [
  'db:getTasks', 'db:getTask', 'db:createTask', 'db:updateTask', 'db:deleteTask',
  'project:getAll', 'project:get', 'project:getDefault', 'project:create',
  'settings:get', 'settings:set', 'settings:getAll',
  'agentSession:getTranscriptSnapshot', 'agentSession:getTranscriptDelta'
] as const
export type DatabaseDesktopOperation = typeof DATABASE_DESKTOP_OPERATIONS[number]
export const DATABASE_DESKTOP_EVENTS = ['task:created', 'task:updated', 'task:deleted', 'project:changed', 'transcript:changed'] as const
export type DatabaseDesktopEvent = typeof DATABASE_DESKTOP_EVENTS[number]

export interface DatabaseCommandCodec<K extends DatabaseDesktopOperation> {
  encodeArguments: (args: DesktopCommandMap[K]['apiArguments']) => JsonValue
  decodeArguments: (payload: JsonValue) => DesktopCommandMap[K]['apiArguments']
  validateArguments: (args: unknown) => boolean
  encodeResult: (value: unknown) => OptionalResult<JsonValue>
  decodeResult: (value: JsonValue | undefined) => DesktopCommandMap[K]['result']
  validateResult: (value: unknown) => boolean
  validateWireResult: (value: unknown) => boolean
}

const text = (value: unknown, max = 65_536): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0')
export const isDatabaseId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 128 && value.every(item => text(item, 256))
const cursor = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const nullableText = (value: unknown): boolean => value === null || text(value)
const object = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> => isRecord(value) && hasExactKeys(value, required, optional)
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }

/** This first service has no agent/scheduler/source owner; lifecycle fields reject. */
function taskInput(value: unknown, create: boolean): boolean {
  return object(value, create ? ['title'] : [], [
    ...(create ? [] : ['title']), 'description', 'type', 'priority', 'labels', ...(create ? ['project_id', 'status', 'auto_start_agent', 'auto_complete_without_review'] : [])
  ]) && Object.entries(value).every(([key, item]) => item === undefined ||
    (key === 'title' ? text(item, 512) && !!item.trim() :
      key === 'description' ? text(item) :
      key === 'type' ? ['general', 'coding', 'manual', 'review', 'approval'].includes(item as string) :
      key === 'priority' ? ['critical', 'high', 'medium', 'low'].includes(item as string) :
      key === 'labels' ? strings(item) :
      key === 'project_id' ? isDatabaseId(item) :
      key === 'status' ? item === 'not_started' : item === false)) && (!create || text(value.title, 512) && !!value.title.trim())
}
function projectInput(value: unknown): boolean {
  return object(value, ['name'], ['description']) && text(value.name, 512) && !!value.name.trim() &&
    (value.description === undefined || text(value.description))
}
export const SYNTHETIC_SETTING_KEYS = ['theme', 'sidebar_collapsed', 'synthetic_ui_value'] as const
export const isSyntheticSettingKey = (value: unknown): value is string => SYNTHETIC_SETTING_KEYS.some(key => key === value)

function copyTaskInput(value: Record<string, unknown>, create: boolean): JsonValue {
  if (!taskInput(value, create)) return fail('INVALID_ARGUMENTS')
  const result: Record<string, JsonValue> = {}
  // Only these explicitly optional fields may omit undefined. No Buffer,
  // arbitrary key, or generic undefined-to-null transformation is permitted.
  for (const key of ['title', 'description', 'type', 'priority', 'labels', ...(create ? ['project_id', 'status', 'auto_start_agent', 'auto_complete_without_review'] : [])]) {
    if (value[key] !== undefined) result[key] = value[key] as JsonValue
  }
  return result
}

const taskStringFields = ['id', 'title', 'description', 'type', 'priority', 'status', 'assignee', 'source', 'project_id', 'created_at', 'updated_at']
const taskNullableStrings = ['due_date', 'agent_id', 'external_id', 'source_id', 'session_id', 'snoozed_until', 'resolution', 'feedback_comment', 'recurrence_parent_id', 'last_occurrence_at', 'next_occurrence_at', 'heartbeat_last_check_at', 'heartbeat_next_check_at', 'parent_task_id']
const taskBooleans = ['is_recurring', 'heartbeat_enabled', 'auto_start_agent', 'auto_complete_without_review']
const taskOtherFields = ['labels', 'attachments', 'repos', 'output_fields', 'skill_ids', 'feedback_rating', 'recurrence_pattern', 'heartbeat_interval_minutes', 'complete_at_source', 'next_subtask_ids', 'sort_order']
const taskKeys = [...taskStringFields, ...taskNullableStrings, ...taskBooleans, ...taskOtherFields]
export function isDatabaseTask(value: unknown): boolean {
  return object(value, taskKeys, ['last_activity_at']) && taskStringFields.every(key => text(value[key])) &&
    isDatabaseId(value.id) && isDatabaseId(value.project_id) &&
    ['general', 'coding', 'manual', 'review', 'approval'].includes(value.type as string) &&
    ['critical', 'high', 'medium', 'low'].includes(value.priority as string) &&
    ['not_started', 'triaging', 'agent_working', 'ready_for_review', 'agent_learning', 'completed'].includes(value.status as string) &&
    taskNullableStrings.every(key => nullableText(value[key])) && taskBooleans.every(key => typeof value[key] === 'boolean') &&
    strings(value.labels) && strings(value.repos) && strings(value.next_subtask_ids) && (value.skill_ids === null || strings(value.skill_ids)) &&
    Array.isArray(value.attachments) && value.attachments.length <= 128 && value.attachments.every(item =>
      object(item, ['id', 'filename', 'size', 'mime_type', 'added_at']) && isDatabaseId(item.id) && text(item.filename, 256) && cursor(item.size) && text(item.mime_type, 128) && text(item.added_at, 128)) &&
    Array.isArray(value.output_fields) && value.output_fields.length <= 128 && value.output_fields.every(item => isJsonValue(item)) &&
    (value.feedback_rating === null || Number.isFinite(value.feedback_rating)) &&
    (value.recurrence_pattern === null || text(value.recurrence_pattern) || isRecord(value.recurrence_pattern) && isJsonValue(value.recurrence_pattern)) &&
    (value.heartbeat_interval_minutes === null || cursor(value.heartbeat_interval_minutes)) &&
    (value.complete_at_source === null || typeof value.complete_at_source === 'boolean') && cursor(value.sort_order) &&
    (value.last_activity_at === undefined || nullableText(value.last_activity_at)) && isJsonValue(value)
}
function encodeTask(value: unknown): JsonValue {
  if (!isRecord(value)) return fail('INVALID_RESULT')
  const result: Record<string, JsonValue> = {}
  for (const key of taskKeys) result[key] = value[key] as JsonValue
  if (value.last_activity_at !== undefined) result.last_activity_at = value.last_activity_at as JsonValue
  // Database rows also carry private MCP scope nonces and legacy checklist JSON;
  // neither belongs to the renderer Task DTO. Never spread a database row.
  if (!isDatabaseTask(result)) return fail('INVALID_RESULT')
  return result
}
const projectKeys = ['id', 'name', 'description', 'default_agent_id', 'captain_agent_id', 'git_provider', 'git_org', 'settings', 'sort_order', 'archived', 'created_at', 'updated_at']
export function isDatabaseProject(value: unknown): boolean {
  return object(value, projectKeys) && isDatabaseId(value.id) && ['name', 'description', 'created_at', 'updated_at'].every(key => text(value[key])) &&
    ['default_agent_id', 'captain_agent_id', 'git_provider', 'git_org'].every(key => nullableText(value[key])) &&
    isRecord(value.settings) && isJsonValue(value.settings) && cursor(value.sort_order) && typeof value.archived === 'boolean'
}
function encodeProject(value: unknown): JsonValue {
  if (!isRecord(value)) return fail('INVALID_RESULT')
  const result = Object.fromEntries(projectKeys.map(key => [key, value[key]]))
  if (!isDatabaseProject(result)) return fail('INVALID_RESULT')
  return result as JsonValue
}
export function isDatabaseTranscriptPart(value: unknown): boolean {
  return object(value, ['taskId', 'partId', 'seq', 'role', 'content', 'createdAt', 'updatedAt', 'rev'], ['partType', 'tool', 'payload']) &&
    isDatabaseId(value.taskId) && text(value.partId, 512) && !!value.partId && cursor(value.seq) && cursor(value.rev) && text(value.role, 128) && text(value.content) &&
    cursor(value.createdAt) && cursor(value.updatedAt) && (value.partType === undefined || text(value.partType, 128)) &&
    (value.tool === undefined || isJsonValue(value.tool)) && (value.payload === undefined || isJsonValue(value.payload))
}
export function encodeDatabaseTranscriptPart(value: unknown): JsonValue {
  if (!isDatabaseTranscriptPart(value) || !isRecord(value)) return fail('INVALID_RESULT')
  const result: Record<string, JsonValue> = {}
  for (const key of ['taskId', 'partId', 'seq', 'role', 'content', 'createdAt', 'updatedAt', 'rev']) result[key] = value[key] as JsonValue
  for (const key of ['partType', 'tool', 'payload']) if (value[key] !== undefined) result[key] = value[key] as JsonValue
  return result
}
const parts = (value: unknown): boolean => Array.isArray(value) && value.length <= 128 && value.every(isDatabaseTranscriptPart)
const delta = (value: unknown): boolean => object(value, ['parts', 'maxRev']) && parts(value.parts) && cursor(value.maxRev) && (value.parts as Record<string, unknown>[]).every(part => (part.rev as number) <= (value.maxRev as number))
const settings = (value: unknown): boolean => isRecord(value) && Object.entries(value).every(([key, item]) => isSyntheticSettingKey(key) && text(item, 4096))
type Descriptor = { validateArgs: (value: unknown) => boolean; encodeArgs: (args: unknown[]) => JsonValue; decodeArgs: (payload: JsonValue) => unknown[]; validateResult: (value: unknown) => boolean; encodeResult?: (value: unknown) => JsonValue }
const noArgs = { validateArgs: (value: unknown) => Array.isArray(value) && value.length === 0, encodeArgs: () => ({}), decodeArgs: (value: JsonValue) => { if (!object(value, [])) return fail('INVALID_ARGUMENTS'); return [] } }
const idArgs = (key: string) => ({
  validateArgs: (value: unknown) => Array.isArray(value) && value.length === 1 && isDatabaseId(value[0]),
  encodeArgs: (args: unknown[]) => ({ [key]: args[0] as string }),
  decodeArgs: (value: JsonValue) => { if (!object(value, [key]) || !isDatabaseId(value[key])) return fail('INVALID_ARGUMENTS'); return [value[key]] }
})
const oneData = (check: (value: unknown) => boolean, copy: (value: Record<string, unknown>) => JsonValue) => ({
  validateArgs: (value: unknown) => Array.isArray(value) && value.length === 1 && check(value[0]),
  encodeArgs: (args: unknown[]) => ({ data: copy(args[0] as Record<string, unknown>) }),
  decodeArgs: (value: JsonValue) => { if (!object(value, ['data']) || !check(value.data)) return fail('INVALID_ARGUMENTS'); return [value.data] }
})
const descriptors: Record<DatabaseDesktopOperation, Descriptor> = {
  'db:getTasks': {
    validateArgs: value => Array.isArray(value) && value.length <= 1 && (value[0] === undefined || isDatabaseId(value[0])),
    encodeArgs: args => { const payload: Record<string, JsonValue> = {}; if (args[0] !== undefined) payload.projectId = args[0] as string; return payload },
    decodeArgs: value => { if (!object(value, [], ['projectId']) || value.projectId !== undefined && !isDatabaseId(value.projectId)) return fail('INVALID_ARGUMENTS'); return value.projectId === undefined ? [] : [value.projectId] },
    validateResult: value => Array.isArray(value) && value.length <= 128 && value.every(isDatabaseTask),
    encodeResult: value => (value as unknown[]).map(encodeTask)
  },
  'db:getTask': { ...idArgs('id'), validateResult: value => value === undefined || isDatabaseTask(value), encodeResult: encodeTask },
  'db:createTask': { ...oneData(value => taskInput(value, true), value => copyTaskInput(value, true)), validateResult: isDatabaseTask, encodeResult: encodeTask },
  'db:updateTask': {
    validateArgs: value => Array.isArray(value) && value.length === 2 && isDatabaseId(value[0]) && taskInput(value[1], false),
    encodeArgs: args => ({ id: args[0] as string, data: copyTaskInput(args[1] as Record<string, unknown>, false) }),
    decodeArgs: value => { if (!object(value, ['id', 'data']) || !isDatabaseId(value.id) || !taskInput(value.data, false)) return fail('INVALID_ARGUMENTS'); return [value.id, value.data] },
    validateResult: value => value === undefined || isDatabaseTask(value), encodeResult: encodeTask
  },
  'db:deleteTask': { ...idArgs('id'), validateResult: value => typeof value === 'boolean' },
  'project:getAll': {
    validateArgs: value => Array.isArray(value) && value.length <= 1 && (value[0] === undefined || object(value[0], [], ['includeArchived']) && (value[0].includeArchived === undefined || typeof value[0].includeArchived === 'boolean')),
    encodeArgs: args => { const payload: Record<string, JsonValue> = {}; const value = (args[0] as { includeArchived?: boolean } | undefined)?.includeArchived; if (value !== undefined) payload.includeArchived = value; return payload },
    decodeArgs: value => { if (!object(value, [], ['includeArchived']) || value.includeArchived !== undefined && typeof value.includeArchived !== 'boolean') return fail('INVALID_ARGUMENTS'); return value.includeArchived === undefined ? [] : [{ includeArchived: value.includeArchived }] },
    validateResult: value => Array.isArray(value) && value.length <= 128 && value.every(isDatabaseProject), encodeResult: value => (value as unknown[]).map(encodeProject)
  },
  'project:get': { ...idArgs('id'), validateResult: value => value === undefined || isDatabaseProject(value), encodeResult: encodeProject },
  'project:getDefault': { ...noArgs, validateResult: value => value === undefined || isDatabaseProject(value), encodeResult: encodeProject },
  'project:create': {
    ...oneData(projectInput, value => ({ name: value.name as string, ...(value.description === undefined ? {} : { description: value.description as string }) })),
    validateResult: value => value === undefined || isDatabaseProject(value), encodeResult: encodeProject
  },
  'settings:get': {
    ...idArgs('key'), validateArgs: value => Array.isArray(value) && value.length === 1 && isSyntheticSettingKey(value[0]),
    validateResult: value => value === null || text(value, 4096)
  },
  'settings:set': {
    validateArgs: value => Array.isArray(value) && value.length === 2 && isSyntheticSettingKey(value[0]) && text(value[1], 4096),
    encodeArgs: args => ({ key: args[0] as string, value: args[1] as string }),
    decodeArgs: value => { if (!object(value, ['key', 'value']) || !isSyntheticSettingKey(value.key) || !text(value.value, 4096)) return fail('INVALID_ARGUMENTS'); return [value.key, value.value] },
    validateResult: value => value === undefined
  },
  'settings:getAll': { ...noArgs, validateResult: settings },
  'agentSession:getTranscriptSnapshot': {
    validateArgs: value => Array.isArray(value) && value.length >= 1 && value.length <= 2 && isDatabaseId(value[0]) && (value[1] === undefined || cursor(value[1])),
    encodeArgs: args => ({ taskId: args[0] as string, ...(args[1] === undefined ? {} : { sinceSeq: args[1] as number }) }),
    decodeArgs: value => { if (!object(value, ['taskId'], ['sinceSeq']) || !isDatabaseId(value.taskId) || value.sinceSeq !== undefined && !cursor(value.sinceSeq)) return fail('INVALID_ARGUMENTS'); return value.sinceSeq === undefined ? [value.taskId] : [value.taskId, value.sinceSeq] },
    validateResult: parts, encodeResult: value => (value as unknown[]).map(encodeDatabaseTranscriptPart)
  },
  'agentSession:getTranscriptDelta': {
    validateArgs: value => Array.isArray(value) && value.length === 2 && isDatabaseId(value[0]) && cursor(value[1]),
    encodeArgs: args => ({ taskId: args[0] as string, sinceRev: args[1] as number }),
    decodeArgs: value => { if (!object(value, ['taskId', 'sinceRev']) || !isDatabaseId(value.taskId) || !cursor(value.sinceRev)) return fail('INVALID_ARGUMENTS'); return [value.taskId, value.sinceRev] },
    validateResult: delta, encodeResult: value => ({ parts: ((value as { parts: unknown[] }).parts).map(encodeDatabaseTranscriptPart), maxRev: (value as { maxRev: number }).maxRev })
  }
}

function commandCodec<K extends DatabaseDesktopOperation>(operation: K): DatabaseCommandCodec<K> {
  const descriptor = descriptors[operation]
  const validateWireResult = (value: unknown): boolean => object(value, ['defined'], ['value']) &&
    (value.defined === false ? !Object.hasOwn(value, 'value') && descriptor.validateResult(undefined) : value.defined === true && Object.hasOwn(value, 'value') && descriptor.validateResult(value.value) && isJsonValue(value.value))
  return {
    encodeArguments(args) { if (!descriptor.validateArgs(args)) return fail('INVALID_ARGUMENTS'); return descriptor.encodeArgs(args) },
    decodeArguments(payload) { if (!isJsonValue(payload)) return fail('INVALID_ARGUMENTS'); const args = descriptor.decodeArgs(payload); if (!descriptor.validateArgs(args)) return fail('INVALID_ARGUMENTS'); return args as DesktopCommandMap[K]['apiArguments'] },
    validateArguments: descriptor.validateArgs,
    encodeResult(value) {
      if (value === undefined) { if (!descriptor.validateResult(undefined)) return fail('INVALID_RESULT'); return { defined: false } }
      const result = descriptor.encodeResult ? descriptor.encodeResult(value) : value
      if (!descriptor.validateResult(result) || !isJsonValue(result)) return fail('INVALID_RESULT')
      return { defined: true, value: result }
    },
    decodeResult(value) { if (!descriptor.validateResult(value) || value !== undefined && !isJsonValue(value)) return fail('INVALID_RESULT'); return value as DesktopCommandMap[K]['result'] },
    validateResult: descriptor.validateResult,
    validateWireResult
  }
}
export const DATABASE_COMMAND_CODECS = Object.fromEntries(DATABASE_DESKTOP_OPERATIONS.map(operation => [operation, commandCodec(operation)])) as { [K in DatabaseDesktopOperation]: DatabaseCommandCodec<K> }

const eventValidators: Record<DatabaseDesktopEvent, (value: unknown) => boolean> = {
  'task:created': value => object(value, ['task']) && isDatabaseTask(value.task),
  'task:updated': value => object(value, ['taskId', 'updates']) && isDatabaseId(value.taskId) && isDatabaseTask(value.updates) && (value.updates as Record<string, unknown>).id === value.taskId,
  'task:deleted': value => object(value, ['taskId']) && isDatabaseId(value.taskId),
  'project:changed': value => object(value, ['projectId', 'kind']) && isDatabaseId(value.projectId) && ['created', 'updated', 'archived', 'restored', 'repos', 'resources'].includes(value.kind as string),
  'transcript:changed': value => object(value, ['taskId', 'parts', 'maxRev'], ['reloadRequired']) && isDatabaseId(value.taskId) && parts(value.parts) && cursor(value.maxRev) &&
    (value.parts as Record<string, unknown>[]).every(part => part.taskId === value.taskId && (part.rev as number) <= (value.maxRev as number)) &&
    (value.reloadRequired === undefined || value.reloadRequired === true && (value.parts as unknown[]).length === 0)
}
export interface DatabaseEventCodec<K extends DatabaseDesktopEvent> {
  validatePayload: (value: unknown) => boolean
  decodePayload: (value: JsonValue) => DesktopEventMap[K]
  encodePayload: (value: DesktopEventMap[K]) => JsonValue
}
function eventCodec<K extends DatabaseDesktopEvent>(operation: K): DatabaseEventCodec<K> {
  return {
    validatePayload: eventValidators[operation],
    decodePayload(value) {
      if (!eventValidators[operation](value) || !isJsonValue(value)) return fail('INVALID_RESULT')
      // Each exact event schema above validates the public DTO before this cast.
      return value as unknown as DesktopEventMap[K]
    },
    encodePayload(value) { if (!eventValidators[operation](value) || !isJsonValue(value)) return fail('INVALID_ARGUMENTS'); return value }
  }
}
export const DATABASE_EVENT_CODECS = Object.fromEntries(DATABASE_DESKTOP_EVENTS.map(operation => [operation, eventCodec(operation)])) as { [K in DatabaseDesktopEvent]: DatabaseEventCodec<K> }
