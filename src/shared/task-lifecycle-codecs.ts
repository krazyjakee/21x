import type { DesktopCommandMap, DesktopEventMap } from './desktop-operations'
import { isDatabaseId } from './database-desktop-codecs'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'
import type { OptionalResult } from './host-services'

export const TASK_LIFECYCLE_OPERATIONS = ['db:getTasks', 'db:getTask', 'db:createTask', 'db:updateTask', 'db:deleteTask', 'db:getSubtasks', 'db:reorderSubtasks', 'project:moveTask', 'tasks:getCoordinatorTaskId', 'plugin:executeAction'] as const
export type TaskLifecycleOperation = typeof TASK_LIFECYCLE_OPERATIONS[number]
export const TASK_LIFECYCLE_EVENTS = ['task:created', 'task:updated', 'task:deleted', 'task:subtasks-reordered', 'tasks:refresh'] as const
export type TaskLifecycleEvent = typeof TASK_LIFECYCLE_EVENTS[number]
export const MAX_TASK_LIFECYCLE_BYTES = 900_000
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
type Check = (value: unknown) => boolean
const text = (max: number): Check => value => typeof value === 'string' && value.length <= max && !value.includes('\0')
const named: Check = value => text(512)(value) && !!(value as string).trim()
const bool: Check = value => typeof value === 'boolean'
const integer: Check = value => Number.isSafeInteger(value) && (value as number) >= 0
const positive: Check = value => integer(value) && (value as number) > 0
const choice = (values: readonly unknown[]): Check => value => values.includes(value)
const nullable = (check: Check): Check => value => value === null || check(value)
const list = (check: Check): Check => value => Array.isArray(value) && value.length <= 128 && value.every(check)
const ids: Check = value => list(isDatabaseId)(value) && new Set(value as string[]).size === (value as string[]).length
const date: Check = value => text(128)(value) && Number.isFinite(Date.parse(value as string))
const status = choice(['not_started', 'triaging', 'agent_working', 'ready_for_review', 'agent_learning', 'completed'])
const bounded = (value: unknown): value is JsonValue => isJsonValue(value) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_TASK_LIFECYCLE_BYTES
const boundedTask = (value: unknown): boolean => bounded(value) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_TASK_LIFECYCLE_BYTES - 1024
type Shape = Record<string, Check>
const object = (value: unknown, shape: Shape, required: string[] = []): value is Record<string, unknown> => isRecord(value) &&
  hasExactKeys(value, required, Object.keys(shape).filter(key => !required.includes(key))) &&
  Object.entries(value).every(([key, item]) => item === undefined && !required.includes(key) || shape[key](item))
const attachmentShape: Shape = { id: isDatabaseId, filename: value => named(value) && !/[\\/]/.test(value as string) && !['.', '..'].includes(value as string), size: integer, mime_type: text(128), added_at: date }
const attachments = list(value => object(value, attachmentShape, Object.keys(attachmentShape)))
const outputShape: Shape = { id: named, name: text(512), type: text(128), multiple: bool, options: list(text(512)), required: bool, value: bounded }
const outputs = list(value => object(value, outputShape, ['id', 'name', 'type']))
const recurrenceObject: Shape = {
  type: choice(['daily', 'weekly', 'monthly', 'custom']), interval: value => positive(value) && (value as number) <= 366,
  time: value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value),
  weekdays: value => Array.isArray(value) && value.length <= 7 && new Set(value).size === value.length && value.every(day => integer(day) && day <= 6),
  monthDay: value => positive(value) && (value as number) <= 31, endDate: date, maxOccurrences: positive
}
const recurrence: Check = value => text(256)(value) && !!(value as string).trim() || object(value, recurrenceObject, ['type', 'interval', 'time'])
const commonInput: Shape = {
  title: named, description: text(65_536), type: choice(['general', 'coding', 'manual', 'review', 'approval']), priority: choice(['critical', 'high', 'medium', 'low']), status,
  assignee: text(512), due_date: nullable(date), labels: list(text(256)), attachments, repos: list(text(512)), output_fields: outputs,
  is_recurring: bool, recurrence_pattern: nullable(recurrence), auto_start_agent: bool, auto_complete_without_review: bool,
  complete_at_source: nullable(bool), parent_task_id: nullable(isDatabaseId), next_subtask_ids: ids
}
const createShape: Shape = { ...commonInput, recurrence_parent_id: nullable(isDatabaseId), project_id: isDatabaseId }
const updateShape: Shape = { ...commonInput, agent_id: nullable(isDatabaseId), skill_ids: nullable(ids), snoozed_until: nullable(date),
  resolution: nullable(text(65_536)), feedback_rating: nullable(value => positive(value) && (value as number) <= 5), feedback_comment: nullable(text(65_536)),
  last_occurrence_at: nullable(date), next_occurrence_at: nullable(date), heartbeat_enabled: bool,
  heartbeat_interval_minutes: nullable(value => positive(value) && (value as number) <= 525_600), heartbeat_last_check_at: nullable(date), heartbeat_next_check_at: nullable(date), sort_order: integer }
export const isTaskLifecycleCreate: Check = value => object(value, createShape, ['title']) && bounded(projectInput(value))
export const isTaskLifecycleUpdate: Check = value => object(value, updateShape) && bounded(projectInput(value))
function withoutUndefined(value: Record<string, unknown>): JsonValue {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as JsonValue
}
function projectInput(value: Record<string, unknown>): JsonValue {
  const result = withoutUndefined(value) as Record<string, JsonValue>
  if (Array.isArray(value.output_fields)) result.output_fields = value.output_fields.map(field => withoutUndefined(field as Record<string, unknown>))
  if (isRecord(value.recurrence_pattern)) result.recurrence_pattern = withoutUndefined(value.recurrence_pattern)
  return result
}
const taskShape: Shape = {
  ...updateShape, id: isDatabaseId, project_id: isDatabaseId, source: text(512), external_id: nullable(text(512)), source_id: nullable(isDatabaseId), session_id: nullable(text(512)),
  recurrence_parent_id: nullable(isDatabaseId), role: choice(['task', 'captain', 'task_group']), created_at: date, updated_at: date,
  last_activity_at: nullable(date), group_id: nullable(isDatabaseId)
}
const taskRequired = Object.keys(taskShape).filter(key => !['last_activity_at', 'group_id'].includes(key))
export const isTaskLifecycleTask: Check = value => object(value, taskShape, taskRequired) && boundedTask(value)
/** Pick declared public fields; private MCP nonces/checklist/storage columns do not cross. */
export function projectTaskLifecycleTask(value: unknown): JsonValue {
  if (!isRecord(value)) return fail('INVALID_RESULT')
  const result = Object.fromEntries(Object.keys(taskShape).filter(key => value[key] !== undefined).map(key => [key, value[key]]))
  if (!isTaskLifecycleTask(result)) return fail('INVALID_RESULT')
  return result as JsonValue
}
const taskList: Check = value => list(isTaskLifecycleTask)(value) && bounded(value)
const partialTask: Check = value => object(value, taskShape) && boundedTask(value)
const actionResultShape: Shape = { success: bool, error: text(4096), taskUpdate: value => object(value, { ...taskShape, ...updateShape }) && bounded(value) }
const actionResult: Check = value => object(value, actionResultShape, ['success']) && bounded(value)
interface Descriptor {
  keys: string[]; optional?: string[]; checks: Check[]; result: Check; project?: (value: unknown) => JsonValue
}
const descriptors: Record<TaskLifecycleOperation, Descriptor> = {
  'db:getTasks': { keys: [], optional: ['projectId'], checks: [isDatabaseId], result: taskList, project: value => (value as unknown[]).map(projectTaskLifecycleTask) },
  'db:getTask': { keys: ['id'], checks: [isDatabaseId], result: value => value === undefined || isTaskLifecycleTask(value), project: projectTaskLifecycleTask },
  'db:createTask': { keys: ['data'], checks: [isTaskLifecycleCreate], result: isTaskLifecycleTask, project: projectTaskLifecycleTask },
  'db:updateTask': { keys: ['id', 'data'], checks: [isDatabaseId, isTaskLifecycleUpdate], result: value => value === undefined || isTaskLifecycleTask(value), project: projectTaskLifecycleTask },
  'db:deleteTask': { keys: ['id'], checks: [isDatabaseId], result: bool },
  'db:getSubtasks': { keys: ['parentId'], checks: [isDatabaseId], result: taskList, project: value => (value as unknown[]).map(projectTaskLifecycleTask) },
  'db:reorderSubtasks': { keys: ['parentId', 'orderedIds'], checks: [isDatabaseId, ids], result: bool },
  'project:moveTask': { keys: ['taskId', 'projectId'], checks: [isDatabaseId, isDatabaseId], result: value => value === null || taskList(value), project: value => value === null ? null : (value as unknown[]).map(projectTaskLifecycleTask) },
  'tasks:getCoordinatorTaskId': { keys: [], optional: ['projectId'], checks: [isDatabaseId], result: nullable(isDatabaseId) },
  'plugin:executeAction': { keys: ['actionId', 'taskId', 'sourceId'], optional: ['input'], checks: [named, isDatabaseId, isDatabaseId, text(65_536)], result: actionResult,
    project: value => {
      if (!isRecord(value) || typeof value.success !== 'boolean') return fail('INVALID_RESULT')
      const result: Record<string, JsonValue> = { success: value.success }
      if (value.error !== undefined) result.error = value.error as JsonValue
      if (value.taskUpdate !== undefined) {
        if (!isRecord(value.taskUpdate)) return fail('INVALID_RESULT')
        const updates = value.taskUpdate
        result.taskUpdate = Object.fromEntries(Object.keys(taskShape).filter(key => updates[key] !== undefined).map(key => [key, updates[key]])) as JsonValue
      }
      return result
    } }
}
export interface TaskLifecycleCodec<K extends TaskLifecycleOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
function codec<K extends TaskLifecycleOperation>(operation: K): TaskLifecycleCodec<K> {
  const descriptor = descriptors[operation], keys = [...descriptor.keys, ...(descriptor.optional ?? [])]
  const validateArguments = (value: unknown): boolean => Array.isArray(value) && value.length >= descriptor.keys.length && value.length <= keys.length &&
    keys.every((_, index) => value[index] === undefined && index >= descriptor.keys.length || descriptor.checks[index](value[index]))
  const validateResult = descriptor.result
  return {
    validateArguments,
    encodeArguments(args) {
      if (!validateArguments(args)) return fail('INVALID_ARGUMENTS')
      const result = Object.fromEntries(keys.filter((_, index) => args[index] !== undefined).map(key => {
        const value = args[keys.indexOf(key)]
        return [key, key === 'data' && isRecord(value) ? projectInput(value) : value]
      }))
      if (!bounded(result)) return fail('INVALID_ARGUMENTS')
      return result
    },
    decodeArguments(value) {
      if (!isRecord(value) || !hasExactKeys(value, descriptor.keys, descriptor.optional) || !bounded(value)) return fail('INVALID_ARGUMENTS')
      const args = keys.map(key => value[key])
      if (!validateArguments(args)) return fail('INVALID_ARGUMENTS')
      return args as DesktopCommandMap[K]['apiArguments']
    },
    encodeResult(value) {
      if (value === undefined) { if (!validateResult(value)) return fail('INVALID_RESULT'); return { defined: false } }
      const projected = descriptor.project ? descriptor.project(value) : value
      if (!validateResult(projected) || !bounded(projected)) return fail('INVALID_RESULT')
      return { defined: true, value: projected }
    },
    decodeResult(value) { if (!validateResult(value)) return fail('INVALID_RESULT'); return value as DesktopCommandMap[K]['result'] },
    validateResult,
    validateWireResult(value) { return isRecord(value) && hasExactKeys(value, ['defined'], ['value']) &&
      (value.defined === false ? !Object.hasOwn(value, 'value') && validateResult(undefined) : value.defined === true && Object.hasOwn(value, 'value') && validateResult(value.value) && bounded(value.value)) }
  }
}
export const TASK_LIFECYCLE_CODECS = Object.fromEntries(TASK_LIFECYCLE_OPERATIONS.map(operation => [operation, codec(operation)])) as { [K in TaskLifecycleOperation]: TaskLifecycleCodec<K> }
const eventCheck: Record<TaskLifecycleEvent, Check> = {
  'task:created': value => isRecord(value) && hasExactKeys(value, ['task']) && isTaskLifecycleTask(value.task),
  'task:updated': value => isRecord(value) && hasExactKeys(value, ['taskId', 'updates']) && isDatabaseId(value.taskId) && partialTask(value.updates) &&
    (!isRecord(value.updates) || value.updates.id === undefined || value.updates.id === value.taskId),
  'task:deleted': value => isRecord(value) && hasExactKeys(value, ['taskId']) && isDatabaseId(value.taskId),
  'task:subtasks-reordered': value => isRecord(value) && hasExactKeys(value, ['parentId', 'orderedIds']) && isDatabaseId(value.parentId) && ids(value.orderedIds),
  'tasks:refresh': value => isRecord(value) && hasExactKeys(value, [])
}
const taskLifecycleEventCodecs = Object.fromEntries(TASK_LIFECYCLE_EVENTS.map(operation => [operation, {
  validatePayload: (value: unknown) => eventCheck[operation](value) && bounded(value),
  encodePayload(value: unknown): JsonValue { if (!eventCheck[operation](value) || !bounded(value)) return fail('INVALID_ARGUMENTS'); return value },
  decodePayload(value: JsonValue): unknown { if (!eventCheck[operation](value) || !bounded(value)) return fail('INVALID_RESULT'); return value }
}])) as { [K in TaskLifecycleEvent]: { validatePayload(value: unknown): boolean; encodePayload(value: DesktopEventMap[K]): JsonValue; decodePayload(value: JsonValue): DesktopEventMap[K] } }
/** Advisory tick from the already owned OverdueNotifier. It carries no task,
 * project, observation or mutation authority. Public callback remains void. */
export const OVERDUE_EVENT_CODEC = {
  validatePayload(value: unknown): value is undefined { return value === undefined },
  encodePayload(value: unknown): JsonValue { if (value !== undefined) return fail('INVALID_ARGUMENTS'); return {} },
  decodePayload(value: JsonValue): DesktopEventMap['overdue:check'] {
    if (!isRecord(value) || !hasExactKeys(value, [])) return fail('INVALID_RESULT')
    return undefined
  }
}
export const TASK_LIFECYCLE_EVENT_CODECS = { ...taskLifecycleEventCodecs, 'overdue:check': OVERDUE_EVENT_CODEC }
