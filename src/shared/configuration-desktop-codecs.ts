import type { DesktopCommandMap, DesktopEventMap } from './desktop-operations'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'
import type { OptionalResult } from './host-services'
import { isExternalHostUrl } from './host-services'
import { DATABASE_COMMAND_CODECS, isDatabaseId } from './database-desktop-codecs'
import { REASONING_EFFORT_VALUES } from './reasoning-effort'

export const CONFIGURATION_DESKTOP_EVENTS = ['skills:changed', 'project:changed'] as const
export type ConfigurationDesktopEvent = typeof CONFIGURATION_DESKTOP_EVENTS[number]
/** Invalidation metadata only: no skill text, paths, credentials or task details. */
export const CONFIGURATION_EVENT_CODECS = {
  'skills:changed': {
    validatePayload: (value: unknown): value is { skillId: string; kind: 'created' | 'updated' | 'removed' | 'scope' } =>
      isRecord(value) && hasExactKeys(value, ['skillId', 'kind']) && isDatabaseId(value.skillId) &&
      ['created', 'updated', 'removed', 'scope'].includes(value.kind as string),
    decodePayload(value: JsonValue): DesktopEventMap['skills:changed'] {
      if (!this.validatePayload(value)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
      return value
    }
  },
  'project:changed': {
    validatePayload: (value: unknown): value is { projectId: string; kind: 'created' | 'updated' | 'archived' | 'restored' | 'repos' | 'resources' } =>
      isRecord(value) && hasExactKeys(value, ['projectId', 'kind']) && isDatabaseId(value.projectId) &&
      ['created', 'updated', 'archived', 'restored', 'repos', 'resources'].includes(value.kind as string),
    decodePayload(value: JsonValue): DesktopEventMap['project:changed'] {
      if (!this.validatePayload(value)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
      return value
    }
  }
} as const

export const CONFIGURATION_DESKTOP_OPERATIONS = [
  'agent:getAll', 'agent:create', 'agent:update', 'agent:delete',
  'skills:getAll', 'skills:create', 'skills:update', 'skills:delete', 'skills:setProject',
  'project:update', 'project:archive', 'project:reorder',
  'projectRepo:list', 'projectRepo:add', 'projectRepo:update', 'projectRepo:remove', 'projectRepo:reorder',
  'projectResource:list', 'projectResource:add', 'projectResource:update', 'projectResource:remove', 'projectResource:reorder'
] as const
export type ConfigurationDesktopOperation = typeof CONFIGURATION_DESKTOP_OPERATIONS[number]
export const CONFIGURATION_CONTENT_OPERATIONS = CONFIGURATION_DESKTOP_OPERATIONS.filter(
  (operation): operation is Exclude<ConfigurationDesktopOperation, `agent:${string}`> => !operation.startsWith('agent:')
)
export interface ConfigurationCommandCodec<K extends ConfigurationDesktopOperation> {
  encodeArguments: (args: DesktopCommandMap[K]['apiArguments']) => JsonValue
  decodeArguments: (payload: JsonValue) => DesktopCommandMap[K]['apiArguments']
  validateArguments: (args: unknown) => boolean
  encodeResult: (value: unknown) => OptionalResult<JsonValue>
  decodeResult: (value: JsonValue | undefined) => DesktopCommandMap[K]['result']
  validateResult: (value: unknown) => boolean
  validateWireResult: (value: unknown) => boolean
}

type Check = (value: unknown) => boolean
interface Field { check: Check; optional?: boolean; encode?: (value: unknown) => JsonValue }
type Shape = Record<string, Field>
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
const text = (max = 4096): Check => value => typeof value === 'string' && value.length <= max && !value.includes('\0')
const named: Check = value => text(512)(value) && !!(value as string).trim()
const boolean: Check = value => typeof value === 'boolean'
const integer: Check = value => Number.isSafeInteger(value) && (value as number) >= 0
const positive: Check = value => integer(value) && (value as number) >= 1
const nullable = (check: Check): Check => value => value === null || check(value)
const choice = (values: readonly string[]): Check => value => typeof value === 'string' && values.includes(value)
const list = (check: Check): Check => value => Array.isArray(value) && value.length <= 128 && value.every(item => check(item))
const uniqueIds: Check = value => list(isDatabaseId)(value) && new Set(value as string[]).size === (value as string[]).length
const optional = (check: Check, encode?: Field['encode']): Field => ({ check, optional: true, encode })
function projectList(value: unknown, projector: (value: unknown) => JsonValue): JsonValue[] {
  if (!Array.isArray(value) || value.length > 128) return fail('INVALID_RESULT')
  return value.map(projector)
}

function validates(value: unknown, shape: Shape): value is Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, Object.keys(shape).filter(key => !shape[key].optional), Object.keys(shape).filter(key => shape[key].optional))) return false
  return Object.entries(shape).every(([key, field]) => field.optional && value[key] === undefined || field.check(value[key]))
}
function project(value: unknown, shape: Shape, code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): JsonValue {
  if (!isRecord(value)) return fail(code)
  const result: Record<string, JsonValue> = {}
  // Only declared optional fields omit undefined; nested values require their
  // own encoder/schema. Unknown database fields never enter a public DTO.
  for (const [key, field] of Object.entries(shape)) {
    const item = value[key]
    if (field.optional && item === undefined) continue
    result[key] = field.encode ? field.encode(item) : item as JsonValue
  }
  if (!validates(result, shape) || !isJsonValue(result)) return fail(code)
  return result
}
const input = (shape: Shape) => ({ check: (value: unknown) => validates(value, shape), encode: (value: unknown) => {
  if (!validates(value, shape)) return fail('INVALID_ARGUMENTS')
  return project(value, shape, 'INVALID_ARGUMENTS')
} })
const serverUrl: Check = value => typeof value === 'string' && /^https?:\/\//i.test(value) && isExternalHostUrl(value)

const mcpEntryShape: Shape = { serverId: { check: isDatabaseId }, enabledTools: optional(list(text(256))) }
const mcpEntry: Check = value => isDatabaseId(value) || validates(value, mcpEntryShape)
const agentConfigShape: Shape = {
  coding_agent: optional(choice(['opencode', 'claude-code', 'codex', 'cursor', 'pi'])), model: optional(text(256)),
  reasoning_effort: optional(choice(REASONING_EFFORT_VALUES)), auth_method: optional(choice(['subscription', 'api_key'])),
  permission_mode: optional(choice(['ask', 'allow'])), sandbox_mode: optional(choice(['read-only', 'workspace-write', 'danger-full-access'])),
  system_prompt: optional(text(65_536)),
  mcp_servers: optional(list(mcpEntry), value => {
    if (!list(mcpEntry)(value)) return fail('INVALID_RESULT')
    return projectList(value, item => typeof item === 'string' ? item : project(item, mcpEntryShape, 'INVALID_RESULT'))
  }),
  skill_ids: optional(uniqueIds), secret_ids: optional(uniqueIds), fallback_agent_ids: optional(uniqueIds),
  max_parallel_sessions: optional(positive), concurrency_cap: optional(positive)
}
/** No plaintext api_keys field is part of this portable configuration boundary. */
export const isPublicAgentConfig: Check = value => validates(value, agentConfigShape) && isJsonValue(value)
export const projectPublicAgentConfig = (value: unknown): JsonValue => project(value, agentConfigShape, 'INVALID_RESULT')
const configInput = input(agentConfigShape)
const agentCreateShape: Shape = { name: { check: named }, server_url: optional(serverUrl), config: optional(configInput.check, configInput.encode), is_default: optional(boolean) }
const agentUpdateShape: Shape = Object.fromEntries(Object.entries(agentCreateShape).map(([key, field]) => [key, { ...field, optional: true }]))
const agentShape: Shape = { id: { check: isDatabaseId }, name: { check: named }, server_url: { check: serverUrl }, config: { check: isPublicAgentConfig, encode: projectPublicAgentConfig }, is_default: { check: boolean }, created_at: { check: text(128) }, updated_at: { check: text(128) } }
export const projectPublicAgent = (value: unknown): JsonValue => project(value, agentShape, 'INVALID_RESULT')
const agentResult: Check = value => validates(value, agentShape) && isJsonValue(value)

const skillInputFields: Shape = {
  name: { check: named }, description: { check: text(65_536) }, content: { check: text(131_072) },
  confidence: optional(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1),
  uses: optional(integer), last_used: optional(nullable(text(128))), tags: optional(list(text(256))),
  preferred_model: optional(nullable(text(256))), project_id: optional(nullable(isDatabaseId))
}
const skillUpdateShape: Shape = Object.fromEntries(Object.entries(skillInputFields).filter(([key]) => key !== 'project_id').map(([key, field]) => [key, { ...field, optional: true }]))
skillUpdateShape.expected_version = optional(positive)
const skillShape: Shape = {
  ...skillInputFields,
  id: { check: isDatabaseId }, version: { check: positive }, created_at: { check: text(128) }, updated_at: { check: text(128) },
  confidence: { check: skillInputFields.confidence.check }, uses: { check: integer }, last_used: { check: nullable(text(128)) },
  tags: { check: list(text(256)) }, preferred_model: { check: nullable(text(256)) }, project_id: { check: nullable(isDatabaseId) }
}
export const projectPublicSkill = (value: unknown): JsonValue => project(value, skillShape, 'INVALID_RESULT')
const skillResult: Check = value => validates(value, skillShape) && isJsonValue(value)

// Settings and Captain/default agent changes require real AgentManager owners.
const projectUpdateShape: Shape = { name: optional(named), description: optional(text(65_536)), git_provider: optional(nullable(choice(['github', 'gitlab', 'forgejo']))), git_org: optional(nullable(text(512))) }
const repoCreateShape: Shape = { name: { check: named }, provider: optional(choice(['github', 'gitlab', 'forgejo'])), org: optional(text(512)), default_branch: optional(nullable(text(512))) }
const repoUpdateShape: Shape = Object.fromEntries(Object.entries(repoCreateShape).map(([key, field]) => [key, { ...field, optional: true }]))
const repoShape: Shape = { id: { check: isDatabaseId }, project_id: { check: isDatabaseId }, name: { check: named }, provider: { check: choice(['github', 'gitlab', 'forgejo']) }, org: { check: text(512) }, default_branch: { check: nullable(text(512)) }, sort_order: { check: integer }, created_at: { check: text(128) } }
export const projectPublicProjectRepo = (value: unknown): JsonValue => project(value, repoShape, 'INVALID_RESULT')
const repoResult: Check = value => validates(value, repoShape) && isJsonValue(value)
// These URLs/notes are context metadata, not authorization to open a URL/file.
const resourceCreateShape: Shape = { label: { check: named }, url: optional(nullable(text(4096))), notes: optional(text(65_536)) }
const resourceUpdateShape: Shape = Object.fromEntries(Object.entries(resourceCreateShape).map(([key, field]) => [key, { ...field, optional: true }]))
const resourceShape: Shape = { id: { check: isDatabaseId }, project_id: { check: isDatabaseId }, label: { check: named }, url: { check: nullable(text(4096)) }, notes: { check: text(65_536) }, sort_order: { check: integer }, created_at: { check: text(128) } }
export const projectPublicProjectResource = (value: unknown): JsonValue => project(value, resourceShape, 'INVALID_RESULT')
const resourceResult: Check = value => validates(value, resourceShape) && isJsonValue(value)

function containsPrivateFields(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPrivateFields)
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, child]) => key === 'api_keys' || key === 'mcp_scope_nonce' || key.endsWith('_api_key') || containsPrivateFields(child))
}
const projectResult: Check = value => DATABASE_COMMAND_CODECS['project:get'].validateResult(value) && !containsPrivateFields(value)
export function projectPublicProject(value: unknown): JsonValue {
  const result = DATABASE_COMMAND_CODECS['project:get'].encodeResult(value)
  if (!result.defined || !projectResult(result.value)) return fail('INVALID_RESULT')
  return result.value
}

interface Descriptor {
  validateArgs: Check
  encodeArgs: (args: unknown[]) => JsonValue
  decodeArgs: (payload: JsonValue) => unknown[]
  validateResult: Check
  encodeResult?: (value: unknown) => JsonValue
}
const noArgs = { validateArgs: (value: unknown) => Array.isArray(value) && value.length === 0, encodeArgs: () => ({}), decodeArgs: (value: JsonValue) => { if (!isRecord(value) || !hasExactKeys(value, [])) return fail('INVALID_ARGUMENTS'); return [] } }
function positional(keys: string[], checks: Check[], serializers: Array<((value: unknown) => JsonValue) | undefined> = []) {
  return {
    validateArgs: (value: unknown) => Array.isArray(value) && value.length === keys.length && checks.every((check, index) => check(value[index])),
    encodeArgs: (args: unknown[]) => Object.fromEntries(keys.map((key, index) => [key, serializers[index] ? serializers[index]!(args[index]) : args[index]])) as JsonValue,
    decodeArgs: (value: JsonValue) => { if (!isRecord(value) || !hasExactKeys(value, keys) || !checks.every((check, index) => check(value[keys[index]]))) return fail('INVALID_ARGUMENTS'); return keys.map(key => value[key]) }
  }
}
const idArgs = positional(['id'], [isDatabaseId])
const projectIdArgs = positional(['projectId'], [isDatabaseId])
const orderArgs = positional(['orderedIds'], [uniqueIds])
const childOrderArgs = positional(['projectId', 'orderedIds'], [isDatabaseId, uniqueIds])
const createArgs = (shape: Shape) => { const schema = input(shape); return positional(['data'], [schema.check], [schema.encode]) }
const updateArgs = (shape: Shape) => { const schema = input(shape); return positional(['id', 'data'], [isDatabaseId, schema.check], [undefined, schema.encode]) }
const addArgs = (shape: Shape) => { const schema = input(shape); return positional(['projectId', 'data'], [isDatabaseId, schema.check], [undefined, schema.encode]) }
const optionalResult = (check: Check): Check => value => value === undefined || check(value)
const voidResult: Check = value => value === undefined
const descriptors: Record<ConfigurationDesktopOperation, Descriptor> = {
  'agent:getAll': { ...noArgs, validateResult: list(agentResult), encodeResult: value => projectList(value, projectPublicAgent) },
  'agent:create': { ...createArgs(agentCreateShape), validateResult: agentResult, encodeResult: projectPublicAgent },
  'agent:update': { ...updateArgs(agentUpdateShape), validateResult: optionalResult(agentResult), encodeResult: projectPublicAgent },
  'agent:delete': { ...idArgs, validateResult: boolean },
  'skills:getAll': { ...noArgs, validateResult: list(skillResult), encodeResult: value => projectList(value, projectPublicSkill) },
  'skills:create': { ...createArgs(skillInputFields), validateResult: skillResult, encodeResult: projectPublicSkill },
  'skills:update': { ...updateArgs(skillUpdateShape), validateResult: optionalResult(skillResult), encodeResult: projectPublicSkill },
  'skills:delete': { ...idArgs, validateResult: boolean },
  'skills:setProject': { ...positional(['id', 'projectId'], [isDatabaseId, nullable(isDatabaseId)]), validateResult: optionalResult(skillResult), encodeResult: projectPublicSkill },
  'project:update': { ...updateArgs(projectUpdateShape), validateResult: projectResult, encodeResult: projectPublicProject },
  'project:archive': {
    validateArgs: value => Array.isArray(value) && value.length >= 1 && value.length <= 2 && isDatabaseId(value[0]) && (value[1] === undefined || boolean(value[1])),
    encodeArgs: args => { const value: Record<string, JsonValue> = { id: args[0] as string }; if (args[1] !== undefined) value.archived = args[1] as boolean; return value },
    decodeArgs: value => { if (!isRecord(value) || !hasExactKeys(value, ['id'], ['archived']) || !isDatabaseId(value.id) || value.archived !== undefined && !boolean(value.archived)) return fail('INVALID_ARGUMENTS'); return value.archived === undefined ? [value.id] : [value.id, value.archived] },
    validateResult: projectResult, encodeResult: projectPublicProject
  },
  'project:reorder': { ...orderArgs, validateResult: voidResult },
  'projectRepo:list': { ...projectIdArgs, validateResult: list(repoResult), encodeResult: value => projectList(value, projectPublicProjectRepo) },
  'projectRepo:add': { ...addArgs(repoCreateShape), validateResult: optionalResult(repoResult), encodeResult: projectPublicProjectRepo },
  'projectRepo:update': { ...updateArgs(repoUpdateShape), validateResult: optionalResult(repoResult), encodeResult: projectPublicProjectRepo },
  'projectRepo:remove': { ...idArgs, validateResult: boolean },
  'projectRepo:reorder': { ...childOrderArgs, validateResult: voidResult },
  'projectResource:list': { ...projectIdArgs, validateResult: list(resourceResult), encodeResult: value => projectList(value, projectPublicProjectResource) },
  'projectResource:add': { ...addArgs(resourceCreateShape), validateResult: optionalResult(resourceResult), encodeResult: projectPublicProjectResource },
  'projectResource:update': { ...updateArgs(resourceUpdateShape), validateResult: optionalResult(resourceResult), encodeResult: projectPublicProjectResource },
  'projectResource:remove': { ...idArgs, validateResult: boolean },
  'projectResource:reorder': { ...childOrderArgs, validateResult: voidResult }
}
function codec<K extends ConfigurationDesktopOperation>(operation: K): ConfigurationCommandCodec<K> {
  const schema = descriptors[operation]
  const validateWireResult = (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['defined'], ['value']) &&
    (value.defined === false ? !Object.hasOwn(value, 'value') && schema.validateResult(undefined) : value.defined === true && Object.hasOwn(value, 'value') && schema.validateResult(value.value) && isJsonValue(value.value))
  return {
    validateArguments: schema.validateArgs,
    encodeArguments(args) { if (!schema.validateArgs(args)) return fail('INVALID_ARGUMENTS'); return schema.encodeArgs(args) },
    decodeArguments(value) { if (!isJsonValue(value)) return fail('INVALID_ARGUMENTS'); const args = schema.decodeArgs(value); if (!schema.validateArgs(args)) return fail('INVALID_ARGUMENTS'); return args as DesktopCommandMap[K]['apiArguments'] },
    encodeResult(value) {
      if (value === undefined) { if (!schema.validateResult(value)) return fail('INVALID_RESULT'); return { defined: false } }
      const projected = schema.encodeResult ? schema.encodeResult(value) : value
      if (!schema.validateResult(projected) || !isJsonValue(projected)) return fail('INVALID_RESULT')
      return { defined: true, value: projected }
    },
    decodeResult(value) { if (!schema.validateResult(value) || value !== undefined && !isJsonValue(value)) return fail('INVALID_RESULT'); return value as DesktopCommandMap[K]['result'] },
    validateResult: schema.validateResult, validateWireResult
  }
}
export const CONFIGURATION_COMMAND_CODECS = Object.fromEntries(CONFIGURATION_DESKTOP_OPERATIONS.map(operation => [operation, codec(operation)])) as { [K in ConfigurationDesktopOperation]: ConfigurationCommandCodec<K> }

/** Codec availability never authorizes binding effects or overrides native allowlists. */
export const CONFIGURATION_OWNER_REQUIREMENTS = {
  'agent:update': 'actual AgentManager.drainStartQueue callback required after successful writes',
  'agent:delete': 'actual session/start-queue reference reconciliation required before a live profile binding',
  'skills:update': 'optimistic version conflict must reject without overwrite; stable conflict mapping required',
  'skills:setProject': 'explicit trusted user scope mutation; validate both current and destination project authority',
  'project:update': 'settings/default-agent/Captain fields remain rejected; real queue/Captain callbacks required for those fields',
  'project:archive': 'default-project protection and project authority belong to database/domain owner',
  'projectRepo:reorder': 'every supplied child ID must belong to the named authorized project before effects',
  'projectResource:reorder': 'every supplied child ID must belong to the named authorized project before effects'
} as const
