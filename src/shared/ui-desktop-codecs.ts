import type { DesktopCommandMap, DesktopEventMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { isDatabaseId } from './database-desktop-codecs'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'
import { UI_VIEW_NAMES, type UiCommand, type UiStateSnapshot } from './ui-commands'

export const UI_DESKTOP_OPERATIONS = ['ui:publishState'] as const
export const UI_DESKTOP_EVENTS = ['ui:command'] as const
export const UI_DESKTOP_LIMITS = Object.freeze({ bytes: 256 * 1024, tasks: 50, title: 4096, storedScopeBytes: 32768 })
export const UI_STATE_VIEWS = [...UI_VIEW_NAMES, 'commander', 'overview'] as const
export const UI_STATE_MODALS = ['create', 'edit', 'delete', 'settings', 'repo-selector', 'gh-setup'] as const
export const UI_SETTINGS_TABS = ['general', 'projects', 'agents', 'tools-mcp', 'secrets', 'voice', 'integrations', 'plugins', 'advanced'] as const
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
export const uiText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0') && new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value
export const isUiLeaseId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
const bounded = (value: unknown): value is JsonValue => isJsonValue(value) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= UI_DESKTOP_LIMITS.bytes
const member = (values: readonly string[], value: unknown) => typeof value === 'string' && values.includes(value)
const nullableId = (value: unknown) => value === null || isDatabaseId(value)
const identifier = (value: unknown, max: number) => uiText(value, max) && !!value && !/[\u0000-\u001f\u007f]/.test(value)
export function isUiStateSnapshot(value: unknown): value is UiStateSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, ['view','projectId','modal','selectedTaskId','selectedTaskTitle','dashboardPreviewTaskId','captainOpen','settingsTab','waitingForYou','visibleTaskIds']) || !member(UI_STATE_VIEWS, value.view) || !isDatabaseId(value.projectId) || !(value.modal === null || member(UI_STATE_MODALS, value.modal)) || !nullableId(value.selectedTaskId) || !(value.selectedTaskTitle === null || uiText(value.selectedTaskTitle, UI_DESKTOP_LIMITS.title)) || !nullableId(value.dashboardPreviewTaskId) || typeof value.captainOpen !== 'boolean' || typeof value.waitingForYou !== 'boolean' || !(value.settingsTab === null || member(UI_SETTINGS_TABS, value.settingsTab))) return false
  if (!Array.isArray(value.visibleTaskIds) || value.visibleTaskIds.length > UI_DESKTOP_LIMITS.tasks || !value.visibleTaskIds.every(isDatabaseId) || new Set(value.visibleTaskIds).size !== value.visibleTaskIds.length) return false
  return bounded(value)
}
export function isUiCommand(value: unknown): value is UiCommand {
  if (!isRecord(value) || !bounded(value)) return false
  switch (value.kind) {
    case 'navigate': return hasExactKeys(value,['kind','view'],['settingsTab']) && member(UI_VIEW_NAMES,value.view) && (value.settingsTab === undefined || member(UI_SETTINGS_TABS,value.settingsTab))
    case 'switch_project': return hasExactKeys(value,['kind','projectId']) && isDatabaseId(value.projectId)
    case 'open_task': return hasExactKeys(value,['kind','taskId','where']) && isDatabaseId(value.taskId) && member(['workspace','modal'],value.where)
    case 'open_artifact': return hasExactKeys(value,['kind','taskId','artifactId']) && isDatabaseId(value.taskId) && identifier(value.artifactId,128)
    default: return false
  }
}
const codec = {
  validateArguments(value: unknown): boolean { return Array.isArray(value) && value.length === 1 && isUiStateSnapshot(value[0]) },
  encodeArguments(args: DesktopCommandMap['ui:publishState']['apiArguments']): JsonValue { if (!Array.isArray(args) || args.length !== 1 || !isUiStateSnapshot(args[0])) return fail('INVALID_ARGUMENTS'); const payload = { state: args[0] as unknown as JsonValue }; if (!bounded(payload)) return fail('INVALID_ARGUMENTS'); return payload },
  decodeArguments(payload: JsonValue): DesktopCommandMap['ui:publishState']['apiArguments'] { if (!isRecord(payload) || !hasExactKeys(payload,['state']) || !isUiStateSnapshot(payload.state) || !bounded(payload)) return fail('INVALID_ARGUMENTS'); return [payload.state] as unknown as DesktopCommandMap['ui:publishState']['apiArguments'] },
  validateResult(value: unknown): boolean { return value === undefined },
  encodeResult(value: unknown): OptionalResult<JsonValue> { if (value !== undefined) return fail('INVALID_RESULT'); return { defined: false } },
  decodeResult(value: JsonValue | undefined): undefined { if (value !== undefined) return fail('INVALID_RESULT'); return undefined },
  validateWireResult(value: unknown): boolean { return isRecord(value) && hasExactKeys(value,['defined']) && value.defined === false }
}
export const UI_DESKTOP_CODECS = { 'ui:publishState': codec }
export const UI_DESKTOP_EVENT_CODECS = { 'ui:command': {
  validatePayload: isUiCommand,
  encodePayload(value: unknown): JsonValue { if (!isUiCommand(value)) return fail('INVALID_ARGUMENTS'); return value as unknown as JsonValue },
  decodePayload(value: JsonValue): DesktopEventMap['ui:command'] { if (!isUiCommand(value)) return fail('INVALID_RESULT'); return value as DesktopEventMap['ui:command'] }
} }
