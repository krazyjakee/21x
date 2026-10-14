import type { DesktopCommandMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { isDatabaseId } from './database-desktop-codecs'
import { TaskStatus } from './constants'
import { TASK_SOURCE_CREDENTIAL_FIELDS } from './task-source-credentials'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const TASK_SOURCE_OPERATIONS = ['taskSource:getAll', 'taskSource:create', 'taskSource:update', 'taskSource:delete', 'taskSource:sync', 'taskSource:exportUpdate', 'taskSource:getUsers', 'taskSource:reassign'] as const
export type TaskSourceOperation = typeof TASK_SOURCE_OPERATIONS[number]
export const TASK_SOURCE_KEY_SET_MARKER = '__21x_api_key_set__'
export const TASK_SOURCE_PLUGIN_IDS = ['linear', 'hubspot', 'github-issues', 'forgejo-issues', 'notion', 'youtrack', 'connector-bridge'] as const
export type TaskSourcePluginId = typeof TASK_SOURCE_PLUGIN_IDS[number]
export const TASK_SOURCE_CONFIG_FIELDS: Record<TaskSourcePluginId, { public: readonly string[]; secret: readonly string[] }> = {
  linear: { public: ['_setup_link', 'redirect_uri', 'client_id', 'scope', 'assignee_id'], secret: TASK_SOURCE_CREDENTIAL_FIELDS.linear },
  hubspot: { public: ['auth_type', '_oauth_setup_link', 'client_id', 'pipeline_id', 'owner_id'], secret: TASK_SOURCE_CREDENTIAL_FIELDS.hubspot },
  'github-issues': { public: ['owner', 'repo', 'state', 'assignee', 'labels'], secret: [] },
  'forgejo-issues': { public: ['login', 'owner', 'repo', 'state', 'assignee', 'labels'], secret: [] },
  notion: { public: ['data_source_id', 'filters', 'next_statuses', 'completion_status'], secret: TASK_SOURCE_CREDENTIAL_FIELDS.notion },
  youtrack: { public: ['server_url', 'project', 'assignee', 'state', 'priority', 'issue_type', 'custom_query'], secret: TASK_SOURCE_CREDENTIAL_FIELDS.youtrack },
  'connector-bridge': { public: ['piece_name', 'connector_instance_id', 'props', 'poll_interval_minutes'], secret: [] }
}
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
const multiline = (value: unknown, max = 65_536): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0')
const named = (value: unknown): value is string => text(value, 512) && !!value.trim()
const bounded = (value: unknown): value is JsonValue => isJsonValue(value) && new TextEncoder().encode(JSON.stringify(value)).length <= 512_000
const strings = (value: unknown, max = 128): value is string[] => Array.isArray(value) && value.length <= max && value.every(item => text(item, 512))
export const isTaskSourcePluginId = (value: unknown): value is TaskSourcePluginId => (TASK_SOURCE_PLUGIN_IDS as readonly unknown[]).includes(value)
export const isTaskSourceStoredPluginId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
function hostUrl(value: unknown): boolean {
  if (!text(value) || !value) return value === ''
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password && !url.search && !url.hash } catch { return false }
}
function publicField(plugin: TaskSourcePluginId, key: string, value: unknown): boolean {
  if (key === 'server_url' || key.endsWith('setup_link')) return hostUrl(value)
  if (key === 'redirect_uri') return value === '' || ['twentyonex://oauth/callback', 'nuanu://oauth/callback'].includes(value as string)
  if (key === 'auth_type') return ['', 'oauth', 'private_app'].includes(value as string)
  if (key === 'state' && (plugin === 'github-issues' || plugin === 'forgejo-issues')) return ['', 'open', 'closed', 'all'].includes(value as string)
  if (key === 'poll_interval_minutes') return value === '' || (typeof value === 'number' || typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 525_600
  if (key === 'connector_instance_id') return value === '' || isDatabaseId(value)
  if (key === 'piece_name') return ['', '@activepieces/piece-trello', '@activepieces/piece-todoist'].includes(value as string)
  if (key === 'props') return isRecord(value) && hasExactKeys(value, [], ['board_id', 'filter_query']) && Object.values(value).every(item => text(item))
  if (key === 'filters') return Array.isArray(value) && value.length <= 64 && value.every(item => isRecord(item) && hasExactKeys(item, ['property', 'type', 'values']) && named(item.property) && named(item.type) && strings(item.values))
  if (key === 'next_statuses' || plugin === 'youtrack' && ['assignee', 'state', 'priority', 'issue_type'].includes(key)) return strings(value) || text(value)
  return text(value)
}
export function isTaskSourceConfig(plugin: unknown, value: unknown): value is Record<string, JsonValue> {
  if (!isTaskSourcePluginId(plugin) || !isRecord(value) || !bounded(value) || Object.keys(value).length > 32) return false
  const fields = TASK_SOURCE_CONFIG_FIELDS[plugin]
  return Object.entries(value).every(([key, item]) => fields.secret.includes(key) ? item === TASK_SOURCE_KEY_SET_MARKER : fields.public.includes(key) && publicField(plugin, key, item))
}
export function isTaskSourceConfigInput(plugin: unknown, value: unknown): value is Record<string, JsonValue> {
  if (!isTaskSourcePluginId(plugin) || !isRecord(value) || !bounded(value) || Object.keys(value).length > 32) return false
  const fields = TASK_SOURCE_CONFIG_FIELDS[plugin]
  return Object.entries(value).every(([key, item]) => fields.secret.includes(key)
    ? multiline(item, 16_384) && new TextEncoder().encode(item).length <= 16_384
    : fields.public.includes(key) && publicField(plugin, key, item))
}
/** Only declared public fields and presence markers leave source storage.
 * Credentials, legacy tool payloads and unknown internal config stay owned. */
export function projectTaskSourceConfig(plugin: unknown, value: unknown): Record<string, JsonValue> {
  if (!isTaskSourceStoredPluginId(plugin) || !isRecord(value)) return fail('INVALID_RESULT')
  if (!isTaskSourcePluginId(plugin)) return {}
  const fields = TASK_SOURCE_CONFIG_FIELDS[plugin], result: Record<string, JsonValue> = {}
  for (const key of fields.public) {
    if (!Object.hasOwn(value, key)) continue
    if (!publicField(plugin, key, value[key]) || !bounded(value[key])) return fail('INVALID_RESULT')
    result[key] = value[key] as JsonValue
  }
  for (const key of fields.secret) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'string') return fail('INVALID_RESULT')
    if (value[key]) result[key] = TASK_SOURCE_KEY_SET_MARKER
  }
  if (!isTaskSourceConfig(plugin, result)) return fail('INVALID_RESULT')
  return result
}
const sourceKeys = ['id', 'mcp_server_id', 'name', 'plugin_id', 'config', 'list_tool', 'list_tool_args', 'update_tool', 'update_tool_args', 'last_synced_at', 'enabled', 'project_id', 'created_at', 'updated_at']
const emptyObject = (value: unknown): boolean => isRecord(value) && Object.keys(value).length === 0
export function isTaskSourceDto(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, sourceKeys) && isDatabaseId(value.id) && (value.mcp_server_id === null || isDatabaseId(value.mcp_server_id)) && named(value.name) && isTaskSourceStoredPluginId(value.plugin_id) && (isTaskSourcePluginId(value.plugin_id) ? isTaskSourceConfig(value.plugin_id, value.config) : emptyObject(value.config)) &&
    text(value.list_tool, 256) && emptyObject(value.list_tool_args) && text(value.update_tool, 256) && emptyObject(value.update_tool_args) && (value.last_synced_at === null || text(value.last_synced_at, 128)) &&
    typeof value.enabled === 'boolean' && isDatabaseId(value.project_id) && text(value.created_at, 128) && text(value.updated_at, 128) && bounded(value)
}
export function projectTaskSource(value: unknown): JsonValue {
  if (!isRecord(value)) return fail('INVALID_RESULT')
  const result = { ...Object.fromEntries(sourceKeys.map(key => [key, value[key]])), config: projectTaskSourceConfig(value.plugin_id, value.config), list_tool_args: {}, update_tool_args: {} }
  if (!isTaskSourceDto(result)) return fail('INVALID_RESULT')
  return result as JsonValue
}
const createKeys = ['mcp_server_id', 'name', 'plugin_id']
const optionalKeys = ['project_id', 'config', 'list_tool', 'list_tool_args', 'update_tool', 'update_tool_args']
export function isTaskSourceInput(value: unknown, create: boolean): boolean {
  if (!isRecord(value) || !hasExactKeys(value, create ? createKeys : [], create ? optionalKeys : ['name', 'plugin_id', 'config', 'mcp_server_id', 'list_tool', 'list_tool_args', 'update_tool', 'update_tool_args', 'enabled'])) return false
  const items = Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
  if (!bounded(items)) return false
  return Object.entries(items).every(([key, item]) => {
    if (key === 'name') return named(item)
    if (key === 'plugin_id') return isTaskSourcePluginId(item)
    if (key === 'mcp_server_id') return create && item === null || isDatabaseId(item)
    if (key === 'project_id') return isDatabaseId(item)
    if (key === 'enabled') return typeof item === 'boolean'
    if (key === 'config') return isRecord(item) && bounded(item) && (value.plugin_id === undefined ? TASK_SOURCE_PLUGIN_IDS.some(plugin => isTaskSourceConfigInput(plugin, item)) : isTaskSourceConfigInput(value.plugin_id, item))
    if (key.endsWith('_args')) return emptyObject(item)
    return item === ''
  }) && (!create || createKeys.every(key => items[key] !== undefined))
}
export function isTaskSourceExportFields(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, [], ['title', 'description', 'status', 'priority', 'assignee', 'due_date', 'labels', 'complete_at_source']) && Object.keys(value).length > 0 && bounded(value) && Object.entries(value).every(([key, item]) => {
    if (key === 'status') return (Object.values(TaskStatus) as unknown[]).includes(item)
    if (key === 'priority') return ['low', 'medium', 'high', 'urgent'].includes(item as string)
    if (key === 'labels') return strings(item)
    if (key === 'complete_at_source') return item === null || typeof item === 'boolean'
    if (key === 'due_date') return item === null || text(item, 128)
    return multiline(item, key === 'description' ? 65_536 : 4096)
  })
}
const users = (value: unknown): boolean => Array.isArray(value) && value.length <= 512 && value.every(item => isRecord(item) && hasExactKeys(item, ['id', 'email', 'name']) && named(item.id) && text(item.email, 512) && text(item.name, 512)) && bounded(value)
const syncResult = (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['source_id', 'imported', 'updated', 'errors']) && isDatabaseId(value.source_id) &&
  [value.imported, value.updated].every(item => Number.isSafeInteger(item) && (item as number) >= 0 && (item as number) <= 1_000_000) && strings(value.errors) && bounded(value)
const reassignResult = (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['success'], ['error']) && typeof value.success === 'boolean' && (value.error === undefined || text(value.error)) && bounded(value)
interface Descriptor { required: string[]; optional?: string[]; checks(args: unknown[]): boolean; result(value: unknown): boolean; project?(value: unknown): JsonValue }
const descriptors: Record<TaskSourceOperation, Descriptor> = {
  'taskSource:getAll': { required: [], optional: ['projectId'], checks: args => args.length <= 1 && (args[0] === undefined || args[0] === '' || isDatabaseId(args[0])), result: value => Array.isArray(value) && value.length <= 256 && value.every(isTaskSourceDto) && bounded(value), project: value => Array.isArray(value) ? value.map(projectTaskSource) : fail('INVALID_RESULT') },
  'taskSource:create': { required: ['data'], checks: args => args.length === 1 && isTaskSourceInput(args[0], true), result: isTaskSourceDto, project: projectTaskSource },
  'taskSource:update': { required: ['id', 'data'], checks: args => args.length === 2 && isDatabaseId(args[0]) && isTaskSourceInput(args[1], false), result: value => value === undefined || isTaskSourceDto(value), project: projectTaskSource },
  'taskSource:delete': { required: ['id'], checks: args => args.length === 1 && isDatabaseId(args[0]), result: value => typeof value === 'boolean' },
  'taskSource:sync': { required: ['sourceId'], checks: args => args.length === 1 && isDatabaseId(args[0]), result: syncResult },
  'taskSource:exportUpdate': { required: ['taskId', 'fields'], checks: args => args.length === 2 && isDatabaseId(args[0]) && isTaskSourceExportFields(args[1]), result: value => value === undefined },
  'taskSource:getUsers': { required: ['sourceId'], checks: args => args.length === 1 && isDatabaseId(args[0]), result: users },
  'taskSource:reassign': { required: ['taskId', 'userIds', 'assigneeDisplay'], checks: args => args.length === 3 && isDatabaseId(args[0]) && strings(args[1], 100) && args[1].every(named) && new Set(args[1]).size === args[1].length && text(args[2], 4096), result: reassignResult }
}
export interface TaskSourceCodec<K extends TaskSourceOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
function codec<K extends TaskSourceOperation>(operation: K): TaskSourceCodec<K> {
  const descriptor = descriptors[operation], keys = [...descriptor.required, ...(descriptor.optional ?? [])]
  const validateArguments = (value: unknown): value is unknown[] => Array.isArray(value) && descriptor.checks(value)
  return {
    validateArguments,
    encodeArguments(args) {
      if (!validateArguments(args)) return fail('INVALID_ARGUMENTS')
      const result = Object.fromEntries(keys.flatMap((key, index) => {
        const item = args[index]
        return item === undefined ? [] : [[key, key === 'data' && isRecord(item) ? Object.fromEntries(Object.entries(item).filter(([, field]) => field !== undefined)) : item]]
      }))
      if (!bounded(result)) return fail('INVALID_ARGUMENTS')
      return result
    },
    decodeArguments(value) {
      if (!isRecord(value) || !hasExactKeys(value, descriptor.required, descriptor.optional) || !bounded(value)) return fail('INVALID_ARGUMENTS')
      const args = keys.filter(key => Object.hasOwn(value, key)).map(key => value[key])
      if (!validateArguments(args)) return fail('INVALID_ARGUMENTS')
      return args as DesktopCommandMap[K]['apiArguments']
    },
    encodeResult(value) {
      if (value === undefined) { if (!descriptor.result(value)) return fail('INVALID_RESULT'); return { defined: false } }
      const result = descriptor.project ? descriptor.project(value) : value
      if (!descriptor.result(result) || !bounded(result)) return fail('INVALID_RESULT')
      return { defined: true, value: result }
    },
    decodeResult(value) { if (!descriptor.result(value)) return fail('INVALID_RESULT'); return value as DesktopCommandMap[K]['result'] },
    validateResult: descriptor.result,
    validateWireResult(value) { return isRecord(value) && hasExactKeys(value, ['defined'], ['value']) && (value.defined === false ? !Object.hasOwn(value, 'value') && descriptor.result(undefined) : value.defined === true && Object.hasOwn(value, 'value') && descriptor.result(value.value) && bounded(value.value)) }
  }
}
export const TASK_SOURCE_CODECS = Object.fromEntries(TASK_SOURCE_OPERATIONS.map(operation => [operation, codec(operation)])) as { [K in TaskSourceOperation]: TaskSourceCodec<K> }
