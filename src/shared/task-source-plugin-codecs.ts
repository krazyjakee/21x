import type { DesktopCommandMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { isDatabaseId } from './database-desktop-codecs'
import { isTaskSourceConfigInput, isTaskSourcePluginId, type TaskSourcePluginId } from './task-source-codecs'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const TASK_SOURCE_PLUGIN_OPERATIONS = ['plugin:list', 'plugin:getDocumentation', 'plugin:resolveOptions'] as const
export type TaskSourcePluginOperation = typeof TASK_SOURCE_PLUGIN_OPERATIONS[number]
export const TASK_SOURCE_PLUGIN_LIMITS = { frameBytes: 512_000, plugins: 7, displayName: 512, description: 8192, icon: 128, documentation: 128_000, options: 512, optionValue: 65_536, optionLabel: 4096 } as const
export const TASK_SOURCE_RESOLVER_KEYS: Record<TaskSourcePluginId, readonly string[]> = {
  linear: ['users'], hubspot: ['owners', 'pipelines'], 'github-issues': ['owners', 'repos'], 'forgejo-issues': ['logins', 'owners', 'repos'],
  notion: ['data_sources', 'status_options', 'data_source_properties'], youtrack: ['projects', 'users', 'states', 'priorities', 'types'], 'connector-bridge': ['pieces']
}
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0') && new TextEncoder().encode(value).length <= max
const bounded = (value: unknown): value is JsonValue => isJsonValue(value) && new TextEncoder().encode(JSON.stringify(value)).length <= TASK_SOURCE_PLUGIN_LIMITS.frameBytes
export const isTaskSourceResolver = (plugin: unknown, resolver: unknown): boolean => isTaskSourcePluginId(plugin) && typeof resolver === 'string' && TASK_SOURCE_RESOLVER_KEYS[plugin].includes(resolver)
export const isTaskSourcePluginMetadata = (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['id', 'displayName', 'description', 'icon']) && isTaskSourcePluginId(value.id) &&
  text(value.displayName, TASK_SOURCE_PLUGIN_LIMITS.displayName) && !!value.displayName.trim() && text(value.description, TASK_SOURCE_PLUGIN_LIMITS.description) && text(value.icon, TASK_SOURCE_PLUGIN_LIMITS.icon) && bounded(value)
export const isTaskSourceResolverOptions = (value: unknown): boolean => Array.isArray(value) && value.length <= TASK_SOURCE_PLUGIN_LIMITS.options && value.every(item => isRecord(item) && hasExactKeys(item, ['value', 'label']) && text(item.value, TASK_SOURCE_PLUGIN_LIMITS.optionValue) && text(item.label, TASK_SOURCE_PLUGIN_LIMITS.optionLabel)) && bounded(value)
interface Descriptor { required: string[]; optional?: string[]; args(value: unknown[]): boolean; result(value: unknown): boolean }
const descriptors: Record<TaskSourcePluginOperation, Descriptor> = {
  'plugin:list': { required: [], args: value => value.length === 0, result: value => Array.isArray(value) && value.length <= TASK_SOURCE_PLUGIN_LIMITS.plugins && value.every(isTaskSourcePluginMetadata) && new Set(value.map(item => item.id)).size === value.length && bounded(value) },
  'plugin:getDocumentation': { required: ['pluginId'], args: value => value.length === 1 && isTaskSourcePluginId(value[0]), result: value => value === null || text(value, TASK_SOURCE_PLUGIN_LIMITS.documentation) && bounded(value) },
  'plugin:resolveOptions': { required: ['pluginId', 'resolverKey', 'config'], optional: ['mcpServerId', 'sourceId'], args: value => value.length >= 3 && value.length <= 5 && isTaskSourceResolver(value[0], value[1]) && isTaskSourceConfigInput(value[0], value[2]) &&
    (value[3] === undefined || isDatabaseId(value[3])) && (value[4] === undefined || isDatabaseId(value[4])), result: isTaskSourceResolverOptions }
}
export interface TaskSourcePluginCodec<K extends TaskSourcePluginOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
function codec<K extends TaskSourcePluginOperation>(operation: K): TaskSourcePluginCodec<K> {
  const descriptor = descriptors[operation], keys = [...descriptor.required, ...(descriptor.optional ?? [])]
  const validateArguments = (value: unknown): value is unknown[] => Array.isArray(value) && descriptor.args(value)
  return {
    validateArguments,
    encodeArguments(args) {
      if (!validateArguments(args)) return fail('INVALID_ARGUMENTS')
      const result = Object.fromEntries(keys.flatMap((key, index) => args[index] === undefined ? [] : [[key, args[index]]]))
      if (!bounded(result)) return fail('INVALID_ARGUMENTS')
      return result
    },
    decodeArguments(value) {
      if (!isRecord(value) || !hasExactKeys(value, descriptor.required, descriptor.optional) || !bounded(value)) return fail('INVALID_ARGUMENTS')
      const args = keys.map(key => value[key])
      while (args.length > descriptor.required.length && args.at(-1) === undefined) args.pop()
      if (!validateArguments(args)) return fail('INVALID_ARGUMENTS')
      return args as DesktopCommandMap[K]['apiArguments']
    },
    encodeResult(value) { if (!descriptor.result(value) || !bounded(value)) return fail('INVALID_RESULT'); return { defined: true, value } },
    decodeResult(value) { if (!descriptor.result(value)) return fail('INVALID_RESULT'); return value as DesktopCommandMap[K]['result'] },
    validateResult: descriptor.result,
    validateWireResult(value) { return isRecord(value) && hasExactKeys(value, ['defined', 'value']) && value.defined === true && descriptor.result(value.value) && bounded(value.value) }
  }
}
export const TASK_SOURCE_PLUGIN_CODECS = Object.fromEntries(TASK_SOURCE_PLUGIN_OPERATIONS.map(operation => [operation, codec(operation)])) as { [K in TaskSourcePluginOperation]: TaskSourcePluginCodec<K> }
