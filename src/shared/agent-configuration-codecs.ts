import type { DesktopCommandMap, DesktopEventMap } from './desktop-operations'
import { CONFIGURATION_COMMAND_CODECS, projectPublicAgent } from './configuration-desktop-codecs'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'
import { isExternalHostUrl, type OptionalResult } from './host-services'
import { MAX_HARD_CAP } from './concurrency'

export const AGENT_CONFIGURATION_OPERATIONS = ['agent:getAll', 'agent:create', 'agent:update', 'agent:delete', 'agentConfig:getProviders', 'agentConfig:listModels'] as const
export type AgentConfigurationOperation = typeof AGENT_CONFIGURATION_OPERATIONS[number]
export const AGENT_CONFIGURATION_EVENTS = ['tasks:refresh'] as const
export const AGENT_API_KEY_SET_MARKER = '__21x_api_key_set__'
export const AGENT_CONFIGURATION_BACKENDS = ['opencode', 'claude-code', 'codex', 'cursor', 'pi'] as const
export type AgentConfigurationBackendType = typeof AGENT_CONFIGURATION_BACKENDS[number]
export const isAgentConfigurationBackendType = (value: unknown): value is AgentConfigurationBackendType => typeof value === 'string' && AGENT_CONFIGURATION_BACKENDS.includes(value as AgentConfigurationBackendType)
const text = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
const named = (value: unknown): value is string => text(value) && !!value.trim()
const boundedResult = (value: unknown): boolean => isJsonValue(value) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 900_000
export function isAgentConfigurationServerUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096 || !/^https?:\/\//i.test(value) || !isExternalHostUrl(value)) return false
  const url = new URL(value)
  return !url.search && !url.hash
}
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
type CrudOperation = Extract<AgentConfigurationOperation, `agent:${string}`>
export interface AgentConfigurationCodec<K extends AgentConfigurationOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}

/** Legacy key storage is unchanged. Only saved-key markers cross this boundary;
 * no credential writes are supported without an encrypted agent-key owner. */
export function projectMaskedAgent(value: unknown): JsonValue {
  const projected = projectPublicAgent(value)
  if (!isRecord(projected) || !isRecord(projected.config) || !isRecord(value) || !isRecord(value.config)) return fail('INVALID_RESULT')
  if (!isAgentConfigurationServerUrl(projected.server_url)) return fail('INVALID_RESULT')
  const raw = value.config.api_keys
  if (raw !== undefined) {
    if (!isRecord(raw) || Object.keys(raw).some(key => !['openai', 'anthropic', 'cursor'].includes(key))) return fail('INVALID_RESULT')
    const markers: Record<string, JsonValue> = {}
    for (const [vendor, secret] of Object.entries(raw)) {
      if (secret === undefined || secret === '') continue
      if (typeof secret !== 'string') return fail('INVALID_RESULT')
      markers[vendor] = AGENT_API_KEY_SET_MARKER
    }
    if (Object.keys(markers).length) projected.config.api_keys = markers
  }
  return projected
}
function isMaskedAgent(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.config) || !isAgentConfigurationServerUrl(value.server_url)) return false
  const { api_keys: keys, ...config } = value.config
  if (keys !== undefined && (!isRecord(keys) || Object.keys(keys).length > 3 || Object.entries(keys).some(([vendor, marker]) => !['openai', 'anthropic', 'cursor'].includes(vendor) || marker !== AGENT_API_KEY_SET_MARKER))) return false
  return CONFIGURATION_COMMAND_CODECS['agent:create'].validateResult({ ...value, config })
}
function crud<K extends CrudOperation>(operation: K): AgentConfigurationCodec<K> {
  const base = CONFIGURATION_COMMAND_CODECS[operation]
  const validateArguments = (args: unknown): boolean => {
    if (!base.validateArguments(args)) return false
    if (!Array.isArray(args)) return false
    const data = operation === 'agent:create' ? args[0] : operation === 'agent:update' ? args[1] : undefined
    if (!isRecord(data)) return true
    if (data.server_url !== undefined && !isAgentConfigurationServerUrl(data.server_url)) return false
    if (isRecord(data.config)) for (const key of ['concurrency_cap', 'max_parallel_sessions']) {
      if (data.config[key] !== undefined && Number(data.config[key]) > MAX_HARD_CAP) return false
    }
    return true
  }
  const validateResult = (value: unknown): boolean => value === undefined ? operation === 'agent:update' : boundedResult(value) &&
    (operation === 'agent:getAll' ? Array.isArray(value) && value.length <= 128 && value.every(isMaskedAgent)
      : operation === 'agent:delete' ? typeof value === 'boolean' : isMaskedAgent(value))
  return {
    validateArguments,
    encodeArguments(args) { if (!validateArguments(args)) return fail('INVALID_ARGUMENTS'); return base.encodeArguments(args as never) },
    decodeArguments(payload) { const args = base.decodeArguments(payload); if (!validateArguments(args)) return fail('INVALID_ARGUMENTS'); return args as DesktopCommandMap[K]['apiArguments'] },
    encodeResult(value) {
      if (value === undefined) { if (!validateResult(value)) return fail('INVALID_RESULT'); return { defined: false } }
      const projected = operation === 'agent:delete' ? value : operation === 'agent:getAll'
        ? Array.isArray(value) && value.length <= 128 ? value.map(projectMaskedAgent) : fail('INVALID_RESULT') : projectMaskedAgent(value)
      if (!validateResult(projected) || !isJsonValue(projected)) return fail('INVALID_RESULT')
      return { defined: true, value: projected }
    },
    decodeResult(value) { if (!validateResult(value)) return fail('INVALID_RESULT'); return value as DesktopCommandMap[K]['result'] },
    validateResult,
    validateWireResult(value) { return isRecord(value) && hasExactKeys(value, ['defined'], ['value']) &&
      (value.defined === false ? !Object.hasOwn(value, 'value') && validateResult(undefined) : value.defined === true && Object.hasOwn(value, 'value') && validateResult(value.value) && isJsonValue(value.value)) }
  }
}

function projectModels(value: unknown): JsonValue[] {
  if (!Array.isArray(value) || value.length > 4096) return fail('INVALID_RESULT')
  return value.map(model => {
    if (!isRecord(model) || !named(model.id) || !named(model.name)) return fail('INVALID_RESULT')
    return { id: model.id, name: model.name }
  })
}
const modelList = (value: unknown): boolean => Array.isArray(value) && value.length <= 4096 && value.every(model => isRecord(model) && hasExactKeys(model, ['id', 'name']) && named(model.id) && named(model.name))
function projectProviders(value: unknown): JsonValue {
  if (value === null) return null
  if (!isRecord(value) || !Array.isArray(value.providers) || value.providers.length > 128 || !isRecord(value.default)) return fail('INVALID_RESULT')
  let count = 0
  const providers = value.providers.map(provider => {
    if (!isRecord(provider) || !named(provider.id) || !named(provider.name)) return fail('INVALID_RESULT')
    let models: unknown[]
    if (Array.isArray(provider.models)) models = provider.models
    else if (isRecord(provider.models)) models = Object.entries(provider.models).map(([id, model]) => ({ id, name: id, ...(isRecord(model) ? { id: model.id ?? id, name: model.name ?? model.id ?? id } : {}) }))
    else return fail('INVALID_RESULT')
    count += models.length
    if (count > 4096) return fail('INVALID_RESULT')
    const normalized = models.map(model => isRecord(model) ? { ...model, name: model.name ?? model.id } : model)
    return { id: provider.id, name: provider.name, models: projectModels(normalized) }
  })
  const defaults = Object.fromEntries(Object.entries(value.default).filter(([id]) => providers.some(provider => provider.id === id)).map(([id, model]) => {
    if (!named(model)) return fail('INVALID_RESULT')
    return [id, model]
  }))
  return { providers, default: defaults }
}
function providersResult(value: unknown): boolean {
  if (value === null) return true
  if (!isRecord(value) || !hasExactKeys(value, ['providers', 'default']) || !Array.isArray(value.providers) || value.providers.length > 128 || !isRecord(value.default)) return false
  const providers = value.providers
  return providers.every(provider => isRecord(provider) && hasExactKeys(provider, ['id', 'name', 'models']) && named(provider.id) && named(provider.name) && modelList(provider.models)) &&
    providers.reduce((count, provider) => count + (provider as { models: unknown[] }).models.length, 0) <= 4096 &&
    Object.keys(value.default).length <= 128 && Object.entries(value.default).every(([id, model]) =>
      providers.some(provider => isRecord(provider) && provider.id === id) && named(model))
}
function modelCodec<K extends Extract<AgentConfigurationOperation, `agentConfig:${string}`>>(operation: K): AgentConfigurationCodec<K> {
  const providers = operation === 'agentConfig:getProviders'
  const validateArguments = (args: unknown): boolean => Array.isArray(args) && (providers
    ? args.length <= 2 && (args[0] === undefined || isAgentConfigurationServerUrl(args[0])) && (args[1] === undefined || isAgentConfigurationBackendType(args[1]))
    : args.length === 1 && isAgentConfigurationBackendType(args[0]))
  const validateResult = (value: unknown): boolean => boundedResult(value) && (providers ? providersResult(value) : value === null || modelList(value))
  return {
    validateArguments,
    encodeArguments(args) { if (!validateArguments(args)) return fail('INVALID_ARGUMENTS'); return providers
      ? { ...(args[0] === undefined ? {} : { serverUrl: args[0] as string }), ...(args[1] === undefined ? {} : { backendType: args[1] as string }) }
      : { backendType: args[0] as string } },
    decodeArguments(value) {
      if (!isRecord(value) || !hasExactKeys(value, providers ? [] : ['backendType'], providers ? ['serverUrl', 'backendType'] : [])) return fail('INVALID_ARGUMENTS')
      const args = providers ? [value.serverUrl, value.backendType] : [value.backendType]
      if (!validateArguments(args)) return fail('INVALID_ARGUMENTS')
      return args as DesktopCommandMap[K]['apiArguments']
    },
    encodeResult(value) {
      const projected = providers ? projectProviders(value) : value === null ? null : projectModels(value)
      if (!validateResult(projected) || !isJsonValue(projected)) return fail('INVALID_RESULT')
      return { defined: true, value: projected }
    },
    decodeResult(value) { if (!validateResult(value)) return fail('INVALID_RESULT'); return value as DesktopCommandMap[K]['result'] },
    validateResult,
    validateWireResult(value) { return isRecord(value) && hasExactKeys(value, ['defined', 'value']) && value.defined === true && validateResult(value.value) && isJsonValue(value.value) }
  }
}
export const AGENT_CONFIGURATION_CODECS = {
  'agent:getAll': crud('agent:getAll'), 'agent:create': crud('agent:create'), 'agent:update': crud('agent:update'), 'agent:delete': crud('agent:delete'),
  'agentConfig:getProviders': modelCodec('agentConfig:getProviders'), 'agentConfig:listModels': modelCodec('agentConfig:listModels')
}
export const AGENT_CONFIGURATION_EVENT_CODECS = {
  'tasks:refresh': {
    validatePayload: (value: unknown): boolean => isRecord(value) && hasExactKeys(value, []),
    decodePayload(value: JsonValue): DesktopEventMap['tasks:refresh'] { if (!this.validatePayload(value)) return fail('INVALID_RESULT'); return undefined }
  }
}
