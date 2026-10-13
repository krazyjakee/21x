import type { DesktopCommandMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { isExternalHostUrl } from './host-services'
import { isDatabaseId } from './database-desktop-codecs'
import { CHAT_PROVIDER_IDS, CHAT_REASONING_EFFORTS, CHAT_SETTING_KEYS } from './chat'
import { VOICE_SETTING_KEYS } from './voice'
import { VOICE_TTS_SETTING_KEYS } from './voice-tts'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const PRODUCTION_SETTINGS_OPERATIONS = ['settings:get', 'settings:set', 'settings:getAll', 'secrets:getAll', 'secrets:create', 'secrets:update', 'secrets:delete', 'env:get'] as const
export type ProductionSettingsOperation = typeof PRODUCTION_SETTINGS_OPERATIONS[number]
export const PRODUCTION_API_KEY_SET_MARKER = '__21x_api_key_set__'
export const PRODUCTION_PROVIDER_KEY_SETTINGS = ['anthropic_api_key', 'openai_api_key', 'google_api_key', 'cursor_api_key'] as const
export const PRODUCTION_ENV_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CURSOR_API_KEY'] as const
export type ProductionEnvKey = typeof PRODUCTION_ENV_KEYS[number]
export const PRODUCTION_SETTINGS_KEYS = [
  'theme', 'sidebar_collapsed', 'github_org', 'git_provider', 'forgejo_login', 'repo_providers', 'current_user_email', 'current_project_id', 'default_agent_id', 'setup_completed_version',
  'max_concurrent_agent_sessions', 'all_projects_paused', 'captain_prewarm', 'commander_briefing',
  'heartbeat_enabled_global', 'heartbeat_default_interval', 'heartbeat_active_hours_start', 'heartbeat_active_hours_end', 'heartbeat_global_instructions',
  'workspace_autocleanup_enabled', 'workspace_autocleanup_days', 'workspace_nodemodules_gc_enabled', 'workspace_nodemodules_gc_days',
  'sessions.ledger', 'sessions.captain_managed', 'sessions.commander_managed', 'sessions.task_managed', 'sessions.rollover', 'sessions.rollover_thresholds',
  'canvas_state', 'drawing_state', 'canvas_state_migrated_to_projects', 'drawing_state_migrated_to_projects', 'OPENCODE_BINARY_PATH', 'minimize_to_tray',
  ...PRODUCTION_PROVIDER_KEY_SETTINGS, ...Object.values(CHAT_SETTING_KEYS), ...Object.values(VOICE_SETTING_KEYS), ...Object.values(VOICE_TTS_SETTING_KEYS)
] as const
const readOnly = new Set(['current_user_email', 'forgejo_login', 'repo_providers', 'OPENCODE_BINARY_PATH'])
const voicePreferenceKeys = new Set<string>([VOICE_SETTING_KEYS.advancedStt, VOICE_SETTING_KEYS.advancedTts])
const nativeKeys = new Set<string>([...Object.values(VOICE_SETTING_KEYS), ...Object.values(VOICE_TTS_SETTING_KEYS), 'minimize_to_tray'].filter(key => !voicePreferenceKeys.has(key)))
export const requiresNativeSettingsOwner = (key: string): boolean => nativeKeys.has(key)
export function settingProjectId(key: string): string | null {
  const match = /^(?:canvas_state|drawing_state):([a-zA-Z0-9_-]{1,128})$/.exec(key)
  return match?.[1] ?? null
}
export function isProductionSettingKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && ((PRODUCTION_SETTINGS_KEYS as readonly string[]).includes(value) || settingProjectId(value) !== null)
}
export const isProductionProviderKey = (key: string): boolean => (PRODUCTION_PROVIDER_KEY_SETTINGS as readonly string[]).includes(key)
export const isProductionCredentialKey = (key: string): boolean => isProductionProviderKey(key) || key === VOICE_TTS_SETTING_KEYS.elevenlabsApiKey
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
const text = (value: unknown, max = 65_536): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0')
const bounded = (value: unknown): value is JsonValue => isJsonValue(value) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 900_000
const named = (value: unknown): value is string => text(value, 512) && !!value.trim()
const boolString = (value: string): boolean => ['', 'true', 'false'].includes(value)
const numeric = (value: string, min: number, max: number, fractional = false): boolean => value === '' || /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) &&
  Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max && (fractional || Number.isSafeInteger(Number(value)))
const timeString = (value: string): boolean => value === '' || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
function jsonSetting(value: string, check: (data: unknown) => boolean): boolean {
  if (value === '') return true
  try { return check(JSON.parse(value)) } catch { return false }
}
const booleanKeys = new Set(['sidebar_collapsed', 'captain_prewarm', 'heartbeat_enabled_global', 'workspace_autocleanup_enabled', 'workspace_nodemodules_gc_enabled', ...voicePreferenceKeys])
export function isProductionSettingWrite(key: unknown, value: unknown): boolean {
  if (!isProductionSettingKey(key) || readOnly.has(key) || !text(value, settingProjectId(key) || key === 'canvas_state' || key === 'drawing_state' ? 800_000 : isProductionCredentialKey(key) ? 262_144 : 65_536) || !bounded(value)) return false
  if (isProductionCredentialKey(key)) return true
  if (booleanKeys.has(key) || key.startsWith('voice_') && !['voice_global_shortcut', 'voice_input_device_id', 'voice_model_id', 'voice_custom_model_dir', 'voice_endpoint_silence', 'voice_tts_engine', 'voice_tts_model_id', 'voice_tts_voice_id', 'voice_tts_speed', 'voice_tts_max_chars', 'voice_tts_elevenlabs_voice_id', 'voice_tts_elevenlabs_model_id'].includes(key)) return boolString(value)
  if (key === 'theme') return ['', 'light', 'dark', 'system'].includes(value)
  if (key === 'git_provider') return ['', 'github', 'gitlab', 'forgejo'].includes(value)
  if (key === 'github_org') return value === '' || /^[a-zA-Z0-9_.-]{1,128}$/.test(value)
  if (key === 'current_project_id' || key === 'default_agent_id' || key === CHAT_SETTING_KEYS.agentId) return value === '' || isDatabaseId(value)
  if (key === 'all_projects_paused') return ['0', '1'].includes(value)
  if (key === 'max_concurrent_agent_sessions') return numeric(value, 0, 1000)
  if (key === 'heartbeat_default_interval') return numeric(value, 1, 525_600)
  if (key === 'heartbeat_active_hours_start' || key === 'heartbeat_active_hours_end') return timeString(value)
  if (key === 'workspace_autocleanup_days' || key === 'workspace_nodemodules_gc_days') return numeric(value, 1, 3650)
  if (key === CHAT_SETTING_KEYS.provider) return value === '' || (CHAT_PROVIDER_IDS as readonly string[]).includes(value)
  if (key === CHAT_SETTING_KEYS.reasoningEffort) return value === '' || (CHAT_REASONING_EFFORTS as readonly string[]).includes(value)
  if (key === CHAT_SETTING_KEYS.baseUrl) {
    if (value === '') return true
    if (!text(value, 4096) || !/^https?:\/\//i.test(value) || !isExternalHostUrl(value)) return false
    const url = new URL(value)
    return !url.search && !url.hash
  }
  if (key === CHAT_SETTING_KEYS.model || key === 'setup_completed_version') return text(value, 512) && !/[\u0000-\u001f\u007f]/.test(value)
  if (key === 'sessions.ledger') return ['', 'true', 'false', 'observe', 'off', 'on', '1', '0'].includes(value)
  if (key.endsWith('_managed')) return ['', 'true', 'false', 'off', 'on', '1', '0'].includes(value)
  if (key === 'sessions.rollover') return ['', 'off', 'observe', 'on'].includes(value)
  if (key === 'sessions.rollover_thresholds') return jsonSetting(value, data => isRecord(data) && hasExactKeys(data, [], ['contextRatio', 'compactions', 'wakeups', 'turns', 'maxAgeDays']) &&
    Object.entries(data).every(([field, item]) => typeof item === 'number' && Number.isFinite(item) && item > 0 && (field === 'contextRatio' ? item <= 1 : field === 'maxAgeDays' ? item <= 3650 : Number.isSafeInteger(item) && item <= 1_000_000)))
  if (key === 'commander_briefing') return jsonSetting(value, data => isRecord(data) && hasExactKeys(data, ['enabled', 'cron', 'speak']) && typeof data.enabled === 'boolean' && typeof data.speak === 'boolean' && text(data.cron, 256) && !!data.cron.trim())
  if (key.endsWith('_migrated_to_projects')) return ['', '1'].includes(value)
  if (settingProjectId(key) || key === 'canvas_state' || key === 'drawing_state') return jsonSetting(value, data => isRecord(data) && bounded(data))
  return true
}
export function projectProductionSetting(key: string, value: unknown): string {
  if (!isProductionSettingKey(key) || !text(value, 800_000) || !bounded(value)) return fail('INVALID_RESULT')
  return isProductionCredentialKey(key) && value ? PRODUCTION_API_KEY_SET_MARKER : value
}
export const isSecretEnvironmentName = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(value)
const secretFields = ['name', 'description', 'env_var_name', 'value'] as const
function secretInput(value: unknown, create: boolean): boolean {
  return isRecord(value) && hasExactKeys(value, create ? [...secretFields] : [], create ? [] : [...secretFields]) &&
    Object.entries(value).every(([key, item]) => (item === undefined && !create) || (key === 'name' ? named(item) : key === 'env_var_name' ? isSecretEnvironmentName(item) : text(item, key === 'value' ? 262_144 : 65_536))) &&
    bounded(Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)))
}
const secretMetadataKeys = ['id', 'name', 'description', 'env_var_name', 'created_at', 'updated_at']
export function isProductionSecretMetadata(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, secretMetadataKeys) && isDatabaseId(value.id) && named(value.name) && text(value.description) && isSecretEnvironmentName(value.env_var_name) && text(value.created_at, 128) && text(value.updated_at, 128) && bounded(value)
}
export function projectProductionSecret(value: unknown): JsonValue {
  if (!isRecord(value)) return fail('INVALID_RESULT')
  const result = Object.fromEntries(secretMetadataKeys.map(key => [key, value[key]]))
  if (!isProductionSecretMetadata(result)) return fail('INVALID_RESULT')
  return result as JsonValue
}
interface Descriptor { keys: string[]; checks: Array<(value: unknown) => boolean>; result(value: unknown): boolean; project?(value: unknown): JsonValue }
const settingsResult = (value: unknown): boolean => isRecord(value) && Object.keys(value).length <= 512 && Object.entries(value).every(([key, item]) => isProductionSettingKey(key) && text(item, 800_000) && (!isProductionCredentialKey(key) || item === '' || item === PRODUCTION_API_KEY_SET_MARKER)) && bounded(value)
const secretList = (value: unknown): boolean => Array.isArray(value) && value.length <= 128 && value.every(isProductionSecretMetadata) && bounded(value)
const descriptors: Record<ProductionSettingsOperation, Descriptor> = {
  'settings:get': { keys: ['key'], checks: [isProductionSettingKey], result: value => value === null || text(value, 800_000) && bounded(value) },
  'settings:set': { keys: ['key', 'value'], checks: [isProductionSettingKey, value => typeof value === 'string'], result: value => value === undefined },
  'settings:getAll': { keys: [], checks: [], result: settingsResult, project: value => {
    if (!isRecord(value)) return fail('INVALID_RESULT')
    return Object.fromEntries(Object.entries(value).filter(([key]) => isProductionSettingKey(key)).map(([key, item]) => [key, projectProductionSetting(key, item)]))
  } },
  'env:get': { keys: ['key'], checks: [value => (PRODUCTION_ENV_KEYS as readonly unknown[]).includes(value)], result: value => value === null || value === '' || value === PRODUCTION_API_KEY_SET_MARKER },
  'secrets:getAll': { keys: [], checks: [], result: secretList, project: value => Array.isArray(value) ? value.map(projectProductionSecret) : fail('INVALID_RESULT') },
  'secrets:create': { keys: ['data'], checks: [value => secretInput(value, true)], result: isProductionSecretMetadata, project: projectProductionSecret },
  'secrets:update': { keys: ['id', 'data'], checks: [isDatabaseId, value => secretInput(value, false)], result: value => value === undefined || isProductionSecretMetadata(value), project: projectProductionSecret },
  'secrets:delete': { keys: ['id'], checks: [isDatabaseId], result: value => typeof value === 'boolean' }
}
export interface ProductionSettingsCodec<K extends ProductionSettingsOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
function codec<K extends ProductionSettingsOperation>(operation: K): ProductionSettingsCodec<K> {
  const descriptor = descriptors[operation]
  const validateArguments = (value: unknown): boolean => Array.isArray(value) && value.length === descriptor.keys.length && descriptor.checks.every((check, index) => check(value[index])) &&
    (operation !== 'settings:set' || isProductionSettingWrite(value[0], value[1]))
  return {
    validateArguments,
    encodeArguments(args) {
      if (!validateArguments(args)) return fail('INVALID_ARGUMENTS')
      const result = Object.fromEntries(descriptor.keys.map((key, index) => {
        const item = args[index]
        return [key, key === 'data' && isRecord(item) ? Object.fromEntries(Object.entries(item).filter(([, field]) => field !== undefined)) : item]
      }))
      if (!bounded(result)) return fail('INVALID_ARGUMENTS')
      return result
    },
    decodeArguments(value) {
      if (!isRecord(value) || !hasExactKeys(value, descriptor.keys) || !bounded(value)) return fail('INVALID_ARGUMENTS')
      const args = descriptor.keys.map(key => value[key])
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
    validateWireResult(value) { return isRecord(value) && hasExactKeys(value, ['defined'], ['value']) &&
      (value.defined === false ? !Object.hasOwn(value, 'value') && descriptor.result(undefined) : value.defined === true && Object.hasOwn(value, 'value') && descriptor.result(value.value) && bounded(value.value)) }
  }
}
export const PRODUCTION_SETTINGS_CODECS = Object.fromEntries(PRODUCTION_SETTINGS_OPERATIONS.map(operation => [operation, codec(operation)])) as { [K in ProductionSettingsOperation]: ProductionSettingsCodec<K> }
