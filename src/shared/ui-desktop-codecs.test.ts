import { describe, expect, it } from 'vitest'
import { UI_DESKTOP_CODECS, UI_DESKTOP_EVENT_CODECS, isUiStateSnapshot, isUiCommand, isUiLeaseId } from './ui-desktop-codecs'
import type { UiCommand, UiStateSnapshot } from './ui-commands'
function state(): UiStateSnapshot {
  return { view: 'dashboard', projectId: 'project_fixture', modal: null, selectedTaskId: 'task_fixture', selectedTaskTitle: 'Human change 🌱', dashboardPreviewTaskId: null, captainOpen: false, settingsTab: null, waitingForYou: false, visibleTaskIds: ['task_fixture'] }
}
describe('exact browser-pure desktop UI codecs', () => {
  it('retains the actual publication tuple and void reply without public lease/authority fields', () => {
    const codec = UI_DESKTOP_CODECS['ui:publishState'], snapshot = state()
    expect(codec.encodeArguments([{ ...snapshot }])).toEqual({ state: snapshot })
    expect(codec.decodeArguments({ state: snapshot } as never)).toEqual([snapshot])
    expect(codec.encodeResult(undefined)).toEqual({ defined: false }); expect(codec.decodeResult(undefined)).toBeUndefined()
    for (const result of [{ defined: true, value: null }, { defined: false, value: null }, { defined: false, leaseId: 'forged' }]) expect(codec.validateWireResult(result)).toBe(false)
    for (const payload of [{ state: snapshot, uiLeaseId: 'forged' }, { state: { ...snapshot, available: true } }, { state: { ...snapshot, updatedAt: 1 } }, { state: snapshot, authority: '*' }]) expect(() => codec.decodeArguments(payload as never)).toThrow()
  })
  it('bounds IDs, Unicode and field shapes before acceptance', () => {
    for (const bad of [
      { ...state(), view: 'unknown' }, { ...state(), modal: 'browser' }, { ...state(), settingsTab: 'unknown' },
      { ...state(), selectedTaskTitle: '\ud800' }, { ...state(), selectedTaskTitle: 'bad\0title' },
      { ...state(), projectId: '../project' }, { ...state(), visibleTaskIds: ['task_fixture','task_fixture'] },
      { ...state(), visibleTaskIds: Array.from({ length: 51 }, (_, i) => `task_${i}`) },
      { ...state(), view: 'canvas' }, { ...state(), canvas: { viewport: { x: 0, y: 0, zoom: 1 }, panels: [] } }
    ]) expect(isUiStateSnapshot(bad)).toBe(false)
    const maximum = state(); maximum.selectedTaskTitle = '🌱'.repeat(2048)
    expect(isUiStateSnapshot(maximum)).toBe(true)
    expect(isUiLeaseId('lease:document-1')).toBe(true)
    for (const lease of ['', 'lease with space', '🌱', 'x'.repeat(129), 'bad\0lease']) expect(isUiLeaseId(lease)).toBe(false)
  })
  it('encodes exactly four intent kinds and preserves accepted command shapes', () => {
    const commands: UiCommand[] = [
      { kind: 'navigate', view: 'settings', settingsTab: 'voice' }, { kind: 'switch_project', projectId: 'project_fixture' },
      { kind: 'open_task', taskId: 'task_fixture', where: 'workspace' },
      { kind: 'open_artifact', taskId: 'task_fixture', artifactId: 'artifact_fixture' }
    ]
    const codec = UI_DESKTOP_EVENT_CODECS['ui:command']
    for (const command of commands) expect(codec.decodePayload(codec.encodePayload(command))).toEqual(command)
    for (const command of [{ kind: 'open_browser', url: 'https://example.test' }, { kind: 'open_task', taskId: 'task_fixture', where: 'auto' }, { kind: 'navigate', view: 'settings', settingsTab: 'foreign' }, { kind: 'navigate', view: 'canvas' }, { kind: 'open_task', taskId: 'task_fixture', where: 'canvas' }, { kind: 'move_task_panel', taskId: 'task_fixture', x: 0, y: 0 }, { kind: 'close_task_panel', taskId: 'task_fixture' }, { kind: 'set_canvas_view', mode: 'reset' }, { kind: 'switch_project', projectId: 'project_fixture', leaseId: 'forged' }, { kind: 'open_artifact', taskId: 'task_fixture', artifactId: 'bad\0artifact' }]) expect(isUiCommand(command)).toBe(false)
  })
})
