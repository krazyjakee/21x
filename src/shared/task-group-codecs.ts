import type { DesktopCommandMap } from './desktop-operations'
import { isDatabaseId } from './database-desktop-codecs'
import { projectTaskLifecycleTask, isTaskLifecycleTask } from './task-lifecycle-codecs'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'
import type { OptionalResult } from './host-services'

export const TASK_GROUP_OPERATIONS = ['taskGroups:list', 'taskGroups:get', 'taskGroups:history', 'taskGroups:create', 'taskGroups:add', 'taskGroups:remove', 'taskGroups:dissolve', 'taskGroups:move', 'taskGroups:review'] as const
export type TaskGroupOperation = typeof TASK_GROUP_OPERATIONS[number]
export const TASK_GROUP_LIMITS = Object.freeze({ groups: 256, members: 128, currentMembers: 10, title: 200, message: 4000, bytes: 900_000, storedBytes: 128_000 })
type Check = (value: unknown) => boolean
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
const bounded = (value: unknown): value is JsonValue => isJsonValue(value) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= TASK_GROUP_LIMITS.bytes
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0')
const date: Check = value => text(value, 128) && Number.isFinite(Date.parse(value))
const ids = (value: unknown, max: number, min = 0): value is string[] => Array.isArray(value) && value.length >= min && value.length <= max && value.every(isDatabaseId) && new Set(value).size === value.length
const title: Check = value => text(value, 400) && !!value.trim() && value.trim().length <= TASK_GROUP_LIMITS.title
const statuses = ['not_started', 'triaging', 'agent_working', 'ready_for_review', 'agent_learning', 'completed']
const progress: Check = value => isRecord(value) && hasExactKeys(value, ['task_id', 'state', 'message', 'updated_at']) && isDatabaseId(value.task_id) && ['pending', 'working', 'done', 'blocked'].includes(value.state as string) && text(value.message, TASK_GROUP_LIMITS.message) && date(value.updated_at)
const groupKeys = ['id', 'title', 'project_id', 'agent_id', 'execution_task_id', 'state', 'status', 'task_ids', 'former_task_ids', 'progress', 'created_at', 'updated_at']
export const isTaskGroupRecord: Check = value => isRecord(value) && hasExactKeys(value, groupKeys) && ['id', 'project_id', 'agent_id', 'execution_task_id'].every(key => isDatabaseId(value[key])) &&
  title(value.title) && ['active', 'dissolved'].includes(value.state as string) && statuses.includes(value.status as string) && ids(value.task_ids, TASK_GROUP_LIMITS.currentMembers) && ids(value.former_task_ids, TASK_GROUP_LIMITS.members) &&
  !(value.task_ids as string[]).some(id => (value.former_task_ids as string[]).includes(id)) && Array.isArray(value.progress) && value.progress.length <= TASK_GROUP_LIMITS.members && value.progress.every(progress) &&
  new Set(value.progress.map(item => (item as { task_id: string }).task_id)).size === value.progress.length && value.progress.every(item => [...value.task_ids as string[], ...value.former_task_ids as string[]].includes((item as { task_id: string }).task_id)) && date(value.created_at) && date(value.updated_at) && bounded(value)
export function projectTaskGroup(value: unknown): JsonValue {
  if (!isRecord(value)) return fail('INVALID_RESULT')
  const projected = Object.fromEntries(groupKeys.map(key => [key, value[key]]))
  if (!isTaskGroupRecord(projected)) return fail('INVALID_RESULT')
  return projected as JsonValue
}
const groupList: Check = value => Array.isArray(value) && value.length <= TASK_GROUP_LIMITS.groups && value.every(isTaskGroupRecord) && bounded(value)
const create: Check = value => isRecord(value) && hasExactKeys(value, ['title', 'task_ids'], ['agent_id']) && title(value.title) && ids(value.task_ids, 10, 2) && (value.agent_id === undefined || isDatabaseId(value.agent_id))
const review: Check = value => isRecord(value) && hasExactKeys(value, ['group_id', 'action'], ['task_ids', 'message', 'complete_at_source']) && isDatabaseId(value.group_id) && ['approve', 'send_back'].includes(value.action as string) &&
  (value.task_ids === undefined || ids(value.task_ids, 10, 1)) && (value.message === undefined || text(value.message, TASK_GROUP_LIMITS.message)) && (value.complete_at_source === undefined || typeof value.complete_at_source === 'boolean')
const snapshot: Check = value => {
  if (!isRecord(value) || !hasExactKeys(value, ['group', 'task', 'members']) || !isTaskGroupRecord(value.group) || !isTaskLifecycleTask(value.task) || !isRecord(value.group) || !isRecord(value.task) || !Array.isArray(value.members) || value.members.length > TASK_GROUP_LIMITS.members || !value.members.every(isTaskLifecycleTask)) return false
  const group = value.group, task = value.task, members = value.members
  const known = [...group.task_ids as string[], ...group.former_task_ids as string[]]
  return task.id === group.execution_task_id && task.project_id === group.project_id && task.agent_id === group.agent_id && task.role === 'task_group' &&
    new Set(members.map(member => (member as { id: string }).id)).size === members.length && members.every(member => isRecord(member) && known.includes(member.id as string) && member.project_id === group.project_id && member.role === 'task') && (group.task_ids as string[]).every(id => members.some(member => isRecord(member) && member.id === id)) && bounded(value)
}
const reviewResult: Check = value => isRecord(value) && hasExactKeys(value, ['group', 'completed_task_ids', 'failures']) && isTaskGroupRecord(value.group) && ids(value.completed_task_ids, 10) && Array.isArray(value.failures) && value.failures.length <= 10 && value.failures.every(failure => isRecord(failure) && hasExactKeys(failure, ['task_id', 'message']) && isDatabaseId(failure.task_id) && text(failure.message, 4000)) && bounded(value)
interface Descriptor { keys: string[]; optional?: string[]; checks: Check[]; result: Check; project(value: unknown): JsonValue }
const descriptors: Record<TaskGroupOperation, Descriptor> = {
  'taskGroups:list': { keys: ['projectId'], optional: ['includeDissolved'], checks: [isDatabaseId, value => typeof value === 'boolean'], result: groupList, project: value => (value as unknown[]).map(projectTaskGroup) },
  'taskGroups:get': { keys: ['id'], checks: [isDatabaseId], result: snapshot, project: value => {
    if (!isRecord(value) || !Array.isArray(value.members) || value.members.length > TASK_GROUP_LIMITS.members) return fail('INVALID_RESULT')
    return { group: projectTaskGroup(value.group), task: projectTaskLifecycleTask(value.task), members: value.members.map(projectTaskLifecycleTask) }
  } },
  'taskGroups:history': { keys: ['taskId'], checks: [isDatabaseId], result: groupList, project: value => (value as unknown[]).map(projectTaskGroup) },
  'taskGroups:create': { keys: ['data'], checks: [create], result: isTaskGroupRecord, project: projectTaskGroup },
  'taskGroups:add': { keys: ['id', 'taskIds'], checks: [isDatabaseId, value => ids(value, 10, 1)], result: isTaskGroupRecord, project: projectTaskGroup },
  'taskGroups:remove': { keys: ['id', 'taskId'], checks: [isDatabaseId, isDatabaseId], result: isTaskGroupRecord, project: projectTaskGroup },
  'taskGroups:dissolve': { keys: ['id'], checks: [isDatabaseId], result: isTaskGroupRecord, project: projectTaskGroup },
  'taskGroups:move': { keys: ['id', 'status'], checks: [isDatabaseId, value => ['not_started', 'agent_working', 'ready_for_review', 'completed'].includes(value as string)], result: isTaskGroupRecord, project: projectTaskGroup },
  'taskGroups:review': { keys: ['data'], checks: [review], result: reviewResult, project: value => {
    if (!isRecord(value)) return fail('INVALID_RESULT')
    if (!Array.isArray(value.failures) || value.failures.length > 10) return fail('INVALID_RESULT')
    return { group: projectTaskGroup(value.group), completed_task_ids: value.completed_task_ids as JsonValue, failures: value.failures.map(failure => {
      if (!isRecord(failure) || !isDatabaseId(failure.task_id)) return fail('INVALID_RESULT')
      return { task_id: failure.task_id, message: 'Source completion failed.' }
    }) }
  } },
}
export interface TaskGroupCodec<K extends TaskGroupOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
function codec<K extends TaskGroupOperation>(operation: K): TaskGroupCodec<K> {
  const descriptor = descriptors[operation], keys = [...descriptor.keys, ...descriptor.optional ?? []]
  const validateArguments = (value: unknown): boolean => Array.isArray(value) && value.length >= descriptor.keys.length && value.length <= keys.length && keys.every((_, index) => value[index] === undefined && index >= descriptor.keys.length || descriptor.checks[index](value[index]))
  const validateResult = descriptor.result
  return { validateArguments, validateResult,
    encodeArguments(args) {
      if (!validateArguments(args)) return fail('INVALID_ARGUMENTS')
      const payload = Object.fromEntries(keys.filter((_, index) => args[index] !== undefined).map(key => {
        const value = args[keys.indexOf(key)]
        return [key, isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) : value]
      }))
      if (!bounded(payload)) return fail('INVALID_ARGUMENTS')
      return payload
    },
    decodeArguments(payload) {
      if (!isRecord(payload) || !hasExactKeys(payload, descriptor.keys, descriptor.optional) || !bounded(payload)) return fail('INVALID_ARGUMENTS')
      const args = keys.map(key => payload[key]); if (!validateArguments(args)) return fail('INVALID_ARGUMENTS')
      return args as DesktopCommandMap[K]['apiArguments']
    },
    encodeResult(value) {
      let projected: JsonValue
      try { projected = descriptor.project(value) } catch { return fail('INVALID_RESULT') }
      if (!validateResult(projected) || !bounded(projected)) return fail('INVALID_RESULT')
      return { defined: true, value: projected }
    },
    decodeResult(value) { if (!validateResult(value)) return fail('INVALID_RESULT'); return value as unknown as DesktopCommandMap[K]['result'] },
    validateWireResult(value) { return isRecord(value) && hasExactKeys(value, ['defined', 'value']) && value.defined === true && validateResult(value.value) && bounded(value.value) },
  }
}
export const TASK_GROUP_CODECS = Object.fromEntries(TASK_GROUP_OPERATIONS.map(operation => [operation, codec(operation)])) as { [K in TaskGroupOperation]: TaskGroupCodec<K> }
