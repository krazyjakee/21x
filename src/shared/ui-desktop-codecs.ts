import type { DesktopCommandMap, DesktopEventMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { isDatabaseId } from './database-desktop-codecs'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'
import { UI_MAX_PUBLISHED_PANELS, UI_VIEW_NAMES, UI_CANVAS_MIN_ZOOM, UI_CANVAS_MAX_ZOOM, type UiCommand, type UiStateSnapshot } from './ui-commands'

export const UI_DESKTOP_OPERATIONS = ['ui:publishState'] as const
export const UI_DESKTOP_EVENTS = ['ui:command'] as const
export const UI_DESKTOP_LIMITS = Object.freeze({ bytes: 256 * 1024, tasks: 50, panels: UI_MAX_PUBLISHED_PANELS, title: 4096, coordinate: 10000000, dimension: 1000000, storedScopeBytes: 32768 })
export const UI_STATE_VIEWS = [...UI_VIEW_NAMES, 'commander', 'overview'] as const
export const UI_STATE_MODALS = ['create', 'edit', 'delete', 'settings', 'repo-selector', 'gh-setup'] as const
export const UI_SETTINGS_TABS = ['general', 'projects', 'agents', 'tools-mcp', 'secrets', 'voice', 'integrations', 'plugins', 'advanced'] as const
/** Historical browser panel metadata is passive; no browser command exists. */
export const UI_PANEL_TYPES = ['task', 'transcript', 'terminal', 'placeholder', 'webpage', 'browser'] as const
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
export const uiText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0') && new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value
export const isUiLeaseId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
const bounded = (value: unknown): value is JsonValue => isJsonValue(value) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= UI_DESKTOP_LIMITS.bytes
const member = (values: readonly string[], value: unknown) => typeof value === 'string' && values.includes(value)
const nullableId = (value: unknown) => value === null || isDatabaseId(value)
const coordinate = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= UI_DESKTOP_LIMITS.coordinate
const dimension = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= UI_DESKTOP_LIMITS.dimension
const zoom = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= UI_CANVAS_MIN_ZOOM && value <= UI_CANVAS_MAX_ZOOM
const identifier = (value: unknown, max: number) => uiText(value, max) && !!value && !/[\u0000-\u001f\u007f]/.test(value)
export function isUiStateSnapshot(value: unknown): value is UiStateSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, ['view','projectId','modal','selectedTaskId','selectedTaskTitle','dashboardPreviewTaskId','captainOpen','settingsTab','waitingForYou','visibleTaskIds','canvas']) || !member(UI_STATE_VIEWS, value.view) || !isDatabaseId(value.projectId) || !(value.modal === null || member(UI_STATE_MODALS, value.modal)) || !nullableId(value.selectedTaskId) || !(value.selectedTaskTitle === null || uiText(value.selectedTaskTitle, UI_DESKTOP_LIMITS.title)) || !nullableId(value.dashboardPreviewTaskId) || typeof value.captainOpen !== 'boolean' || typeof value.waitingForYou !== 'boolean' || !(value.settingsTab === null || member(UI_SETTINGS_TABS, value.settingsTab))) return false
  if (!Array.isArray(value.visibleTaskIds) || value.visibleTaskIds.length > UI_DESKTOP_LIMITS.tasks || !value.visibleTaskIds.every(isDatabaseId) || new Set(value.visibleTaskIds).size !== value.visibleTaskIds.length) return false
  const canvas = value.canvas
  if (!isRecord(canvas) || !hasExactKeys(canvas, ['viewport','panels']) || !isRecord(canvas.viewport) || !hasExactKeys(canvas.viewport, ['x','y','zoom']) || !coordinate(canvas.viewport.x) || !coordinate(canvas.viewport.y) || !zoom(canvas.viewport.zoom) || !Array.isArray(canvas.panels) || canvas.panels.length > UI_DESKTOP_LIMITS.panels) return false
  if (!canvas.panels.every(panel => isRecord(panel) && hasExactKeys(panel, ['panelId','type','taskId','title','x','y','width','height']) && identifier(panel.panelId,256) && member(UI_PANEL_TYPES,panel.type) && nullableId(panel.taskId) && uiText(panel.title, UI_DESKTOP_LIMITS.title) && coordinate(panel.x) && coordinate(panel.y) && dimension(panel.width) && dimension(panel.height))) return false
  return new Set(canvas.panels.map(panel => panel.panelId)).size === canvas.panels.length && bounded(value)
}
export function isUiCommand(value: unknown): value is UiCommand {
  if (!isRecord(value) || !bounded(value)) return false
  switch (value.kind) {
    case 'navigate': return hasExactKeys(value,['kind','view'],['settingsTab']) && member(UI_VIEW_NAMES,value.view) && (value.settingsTab === undefined || member(UI_SETTINGS_TABS,value.settingsTab))
    case 'switch_project': return hasExactKeys(value,['kind','projectId']) && isDatabaseId(value.projectId)
    case 'open_task': return hasExactKeys(value,['kind','taskId','where']) && isDatabaseId(value.taskId) && member(['workspace','canvas','modal'],value.where)
    case 'move_task_panel': return hasExactKeys(value,['kind','taskId','x','y']) && isDatabaseId(value.taskId) && coordinate(value.x) && coordinate(value.y)
    case 'close_task_panel': return hasExactKeys(value,['kind','taskId']) && isDatabaseId(value.taskId)
    case 'set_canvas_view': return hasExactKeys(value,['kind','mode'],['zoom']) && (value.mode === 'zoom' ? zoom(value.zoom) : member(['fit_all','reset'],value.mode) && value.zoom === undefined)
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
