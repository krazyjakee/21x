import type { DesktopCommandMap } from './desktop-operations'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'
import { isDatabaseId } from './database-desktop-codecs'
import { projectPublicProject } from './configuration-desktop-codecs'
import { PROJECT_EVENT_KINDS } from './captain-wakeups'
import { isCronShape } from './scheduled-coordination'
import { DATABASE_COMMAND_CODECS } from './database-desktop-codecs'

/** Full editor input is admitted only by the production lifecycle owner. */
export const PROJECT_CONFIGURATION_OPERATIONS = ['project:create', 'project:update'] as const
export type ProjectConfigurationOperation = typeof PROJECT_CONFIGURATION_OPERATIONS[number]
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !v.includes('\0')
const optionalId = (v: unknown): boolean => v === null || isDatabaseId(v)
const safePositive = (v: unknown): boolean => v === null || Number.isSafeInteger(v) && Number(v) > 0
const keys = ['name', 'description', 'default_agent_id', 'captain_agent_id', 'git_provider', 'git_org', 'settings']
/** Bounded public metadata may round trip. Known settings never accept an
 * invalid value which their domain reader would silently reinterpret. */
export function isProjectConfigurationSettings(v: unknown): v is Record<string, JsonValue> {
  let nodes = 0
  const bounded = (item: unknown, depth: number): boolean => {
    if (++nodes > 4096 || depth > 8) return false
    if (typeof item === 'string') return text(item, 65_536)
    if (item === null || typeof item === 'boolean') return true
    if (typeof item === 'number') return Number.isFinite(item)
    if (Array.isArray(item)) return item.length <= 128 && item.every(child => bounded(child, depth + 1))
    return isRecord(item) && Object.keys(item).length <= 128 && Object.entries(item).every(([key, child]) =>
      text(key, 128) && !['__proto__', 'constructor', 'prototype', 'api_keys', 'mcp_scope_nonce'].includes(key) && !key.endsWith('_api_key') && bounded(child, depth + 1))
  }
  if (!isRecord(v) || !bounded(v, 0) || !isJsonValue(v) || new TextEncoder().encode(JSON.stringify(v)).length > 65_536) return false
  if (v.limits !== undefined && (!isRecord(v.limits) || !hasExactKeys(v.limits, [], ['max_concurrent_agents', 'daily_session_cap', 'daily_token_cap', 'paused']) ||
    !Object.entries(v.limits).every(([key, value]) => key === 'paused' ? typeof value === 'boolean' : safePositive(value)))) return false
  if (v.captain_wakeups !== undefined && (!isRecord(v.captain_wakeups) || !hasExactKeys(v.captain_wakeups, [], ['enabled', 'kinds']) ||
    v.captain_wakeups.enabled !== undefined && typeof v.captain_wakeups.enabled !== 'boolean' ||
    v.captain_wakeups.kinds !== undefined && (!Array.isArray(v.captain_wakeups.kinds) || v.captain_wakeups.kinds.length > PROJECT_EVENT_KINDS.length ||
      new Set(v.captain_wakeups.kinds).size !== v.captain_wakeups.kinds.length || !v.captain_wakeups.kinds.every(kind => PROJECT_EVENT_KINDS.includes(kind as typeof PROJECT_EVENT_KINDS[number]))))) return false
  if (v.scheduled_review !== undefined && (!isRecord(v.scheduled_review) || !hasExactKeys(v.scheduled_review, ['enabled', 'cron']) ||
    typeof v.scheduled_review.enabled !== 'boolean' || !text(v.scheduled_review.cron, 256) || !isCronShape(v.scheduled_review.cron))) return false
  // This is a draft echo only. The owner preserves the authoritative stored
  // block; actual cap/pin mutations retain their separate audited operations.
  if (v.concurrency !== undefined && (!isRecord(v.concurrency) || !hasExactKeys(v.concurrency, [], ['captain_control', 'levels', 'pinned']) ||
    v.concurrency.captain_control !== undefined && typeof v.concurrency.captain_control !== 'boolean' ||
    !['levels', 'pinned'].every(key => v.concurrency === undefined || !isRecord(v.concurrency) || v.concurrency[key] === undefined ||
      isRecord(v.concurrency[key]) && Object.entries(v.concurrency[key]).every(([id, level]) => isDatabaseId(id) && Number.isInteger(level) && Number(level) >= 1 && Number(level) <= 10)))) return false
  return true
}
export function isProjectConfigurationInput(v: unknown, create: boolean): boolean {
  return isRecord(v) && hasExactKeys(v, create ? ['name'] : [], keys.filter(key => !create || key !== 'name')) && (!create || text(v.name, 512) && !!v.name.trim()) && Object.entries(v).every(([key, value]) => value === undefined || (
    key === 'name' ? text(value, 512) && !!value.trim() :
    key === 'description' ? text(value, 65_536) :
    key === 'default_agent_id' || key === 'captain_agent_id' ? optionalId(value) :
    key === 'git_provider' ? value === null || ['github', 'gitlab', 'forgejo'].includes(value as string) :
    key === 'git_org' ? value === null || text(value, 512) : isProjectConfigurationSettings(value)))
}
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
function codec<K extends ProjectConfigurationOperation>(operation: K) {
  const create = operation === 'project:create'
  const validateArguments = (args: unknown): args is DesktopCommandMap[K]['apiArguments'] => Array.isArray(args) && args.length === (create ? 1 : 2) &&
    (create || isDatabaseId(args[0])) && isProjectConfigurationInput(args[create ? 0 : 1], create)
  const validateResult = (value: unknown): boolean => { try { projectPublicProject(value); return true } catch { return false } }
  return {
    validateArguments,
    encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue {
      if (!validateArguments(args)) return fail('INVALID_ARGUMENTS')
      const input = args[create ? 0 : 1] as Record<string, unknown>
      const data = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as JsonValue
      return create ? { data } : { id: args[0] as string, data }
    },
    decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments'] {
      if (!isRecord(payload) || !hasExactKeys(payload, create ? ['data'] : ['id', 'data'])) return fail('INVALID_ARGUMENTS')
      const args = create ? [payload.data] : [payload.id, payload.data]
      if (!validateArguments(args)) return fail('INVALID_ARGUMENTS')
      return args
    },
    encodeResult(value: unknown) { return { defined: true as const, value: projectPublicProject(value) } },
    decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result'] { return projectPublicProject(value) as unknown as DesktopCommandMap[K]['result'] },
    validateResult,
    validateWireResult(value: unknown): boolean {
      return isRecord(value) && hasExactKeys(value, ['defined', 'value']) && value.defined === true && DATABASE_COMMAND_CODECS['project:get'].validateResult(value.value) && validateResult(value.value)
    }
  }
}
export const PROJECT_CONFIGURATION_CODECS = { 'project:create': codec('project:create'), 'project:update': codec('project:update') }
