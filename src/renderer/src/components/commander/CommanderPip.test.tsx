import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CommanderEvent, CommanderMessage } from '@shared/commander'
import type { VoiceModelState } from '@shared/voice'
import type { VoiceTtsSnapshot } from '@shared/voice-tts'
const mocks = vi.hoisted(() => ({ listeners: new Set<(event: CommanderEvent) => void>(), setActive: vi.fn(async () => ({})), bargeIn: vi.fn(async () => ({})), send: vi.fn(async () => ({})), undoAction: vi.fn() }))
vi.mock('@/lib/ipc-client', async original => ({ ...await original<typeof import('@/lib/ipc-client')>(),
  commanderVoiceApi: mocks,
  commanderApi: { onEvent: (listener: (event: CommanderEvent) => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener) }, undoAction: mocks.undoAction }
}))
import { useVoiceStore } from '@/stores/voice-store'
import { useCommanderStore } from '@/stores/commander-store'
import { __resetCommanderCall, useCommanderCallStore } from '@/stores/commander-call-store'
import { useCommanderCallUiStore, useCommanderPipVisible } from '@/stores/commander-call-ui-store'
import { useUIStore } from '@/stores/ui-store'
import { CommanderStage } from './CommanderStage'
import { CommanderCallHost } from './CommanderCallHost'
import { CommanderCallSurfaces } from './CommanderCallSurfaces'
import { snapPipCorner } from './CommanderPip'
import { VoiceOverlay } from '@/components/voice/VoiceOverlay'
import { __resetCommanderActivity } from '@/lib/activity/commander-activity-adapter'
import { activityNow } from '@/lib/activity/activity-clock'
import { voiceCapture } from '@/lib/voice-capture'

const initialVoice = useVoiceStore.getState()
let capturing = false
const startTurn = vi.fn(async () => { capturing = true; useVoiceStore.setState({ turnId: 'owned-mic', turnEpoch: 'lease', state: 'listening' }); return 'owned-mic' })
const cancel = vi.fn(async () => { capturing = false; useVoiceStore.setState({ turnId: null, turnEpoch: null, state: 'idle' }) })
function message(content: string): CommanderMessage {
  return { id: 'action', session_id: 's1', role: 'tool', tool_call_id: 'archive-1', tool_name: 'archive_project', content, tool_calls: null, is_error: false, project_id: null, correlation_id: null, created_at: 1 }
}
function Harness() {
  const view = useUIStore(s => s.sidebarView)
  const pip = useCommanderPipVisible()
  const subscribe = useCommanderStore(s => s.subscribe)
  useEffect(() => view === 'commander' ? subscribe() : undefined, [view, subscribe])
  return <><textarea aria-label="Typed draft" defaultValue="keep this" /><CommanderCallHost /><CommanderCallSurfaces /><VoiceOverlay />
    {view === 'commander' && !pip && <div className="commander-workspace"><CommanderStage panelOpen onPanelToggle={() => {}} compact={false} onCompactToggle={() => useCommanderCallUiStore.getState().showPip()} /></div>}
  </>
}
beforeEach(() => {
  cleanup(); __resetCommanderCall(); __resetCommanderActivity(); vi.clearAllMocks(); mocks.listeners.clear()
  capturing = false; vi.spyOn(voiceCapture, 'isCapturing', 'get').mockImplementation(() => capturing)
  useUIStore.setState({ sidebarView: 'commander', activeModal: null })
  useCommanderCallUiStore.setState({ captions: true, captionSize: 'medium', pipRequested: false, panelOpen: true, corner: 'bottom-right', notice: null })
  useCommanderStore.setState({ selectedSessionId: 's1', sessions: [], messages: { s1: [] }, streaming: {}, turnErrors: {}, recentAction: null, undoneActions: [], undoingActions: [] })
  useVoiceStore.setState({ ...initialVoice, available: true, enabled: true, permission: 'granted', runtime: { installed: true, version: '', modulePath: '', sizeBytes: 0 }, models: [{ id: 'model', installed: true } as VoiceModelState], engine: { state: 'ready', modelId: 'model', engine: 'fixture' }, state: 'idle', turnId: null, turnEpoch: null, partial: '', final: '', tts: { enabled: true, status: { state: 'ready' } } as VoiceTtsSnapshot, initializeTts: async () => {}, startTurn, cancel, stopPlaybackNow: vi.fn() })
})
afterEach(() => { cleanup(); __resetCommanderCall(); __resetCommanderActivity(); useVoiceStore.setState(initialVoice); vi.restoreAllMocks() })
async function start() { fireEvent.click(screen.getByLabelText('Turn voice mode on')); await waitFor(() => expect(useCommanderCallStore.getState().status).toBe('live')) }

describe('one floating Commander call', () => {
  it('survives navigation with one capture/caption and expands without losing the draft', async () => {
    render(<Harness />); await start()
    const field = screen.getByLabelText('Typed draft'); field.focus()
    act(() => { useVoiceStore.setState({ partial: 'one caption' }); useUIStore.getState().setSidebarView('tasks') })
    expect(screen.queryByTestId('commander-stage')).toBeNull()
    expect(screen.getByTestId('commander-pip')).toBeTruthy()
    expect(screen.getAllByText('one caption')).toHaveLength(1)
    expect(screen.queryByTestId('voice-overlay')).toBeNull()
    expect(field).toHaveFocus(); expect(startTurn).toHaveBeenCalledOnce()
    act(() => { for (const listener of mocks.listeners) listener({ type: 'messages_appended', sessionId: 's1', messages: [{ ...message('Arrived while browsing tasks.'), id: 'background-report', role: 'report' }] }) })
    expect(useCommanderStore.getState().messages.s1).toHaveLength(1)
    expect(useCommanderStore.getState().messages.s1[0].content).toBe('Arrived while browsing tasks.')
    fireEvent.click(screen.getByLabelText('Expand Commander call'))
    await waitFor(() => expect(screen.getByTestId('commander-stage')).toBeTruthy())
    expect(screen.queryByTestId('commander-pip')).toBeNull()
    expect(field).toHaveValue('keep this'); expect(startTurn).toHaveBeenCalledOnce(); expect(cancel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Turn voice mode off'))
    expect(useCommanderCallStore.getState().status).toBe('off')
    expect(cancel).toHaveBeenCalledOnce(); expect(mocks.setActive).toHaveBeenCalledWith(null)
  })
  it('moves by keyboard, preserves toolbar navigation and restores full-view control focus', async () => {
    render(<Harness />); await start()
    const trigger = screen.getByLabelText('Picture in picture'); trigger.focus(); fireEvent.click(trigger)
    await waitFor(() => expect(screen.getByTestId('commander-pip-expand')).toHaveFocus())
    const handle = screen.getByLabelText('Move Commander call')
    fireEvent.keyDown(handle, { key: 'ArrowUp' }); fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(screen.getByTestId('commander-pip')).toHaveClass('commander-pip-top-left')
    const toolbar = screen.getByRole('toolbar', { name: 'Floating Commander call controls' })
    within(toolbar).getByLabelText('Mute microphone').focus()
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(within(toolbar).getByLabelText('Turn voice mode off')).toHaveFocus()
    fireEvent.click(screen.getByTestId('commander-pip-expand'))
    await waitFor(() => expect(screen.getByLabelText('Picture in picture')).toHaveFocus())
    expect(snapPipCorner(20, 10, 900, 600)).toBe('top-left')
    expect(snapPipCorner(850, 590, 900, 600)).toBe('bottom-right')
  })
  it('keeps a navigation-time capture failure visible with recovery and End instead of losing the call surface', async () => {
    render(<Harness />); await start()
    act(() => useUIStore.getState().setSidebarView('tasks'))
    act(() => useCommanderCallStore.getState().mediaLost('The microphone disconnected.'))
    expect(screen.getByTestId('commander-pip')).toHaveTextContent('The microphone disconnected.')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.getByTestId('commander-assertive-announcer')).toHaveTextContent('The microphone disconnected.')
    fireEvent.click(screen.getByLabelText('Turn voice mode off'))
    expect(screen.queryByTestId('commander-pip')).toBeNull()
    expect(useCommanderCallStore.getState().error).toBeNull()
  })
  it('shares caption sizes and toggle state, with complete text available by keyboard', async () => {
    render(<Harness />); await start()
    act(() => useVoiceStore.setState({ partial: 'The complete current sentence remains readable even when it is longer than two lines.' }))
    fireEvent.click(screen.getByLabelText('Microphone mode and input device'))
    fireEvent.change(screen.getByLabelText('Caption size'), { target: { value: 'large' } })
    fireEvent.click(screen.getByText('Close microphone options')); fireEvent.click(screen.getByLabelText('Picture in picture'))
    expect(screen.getByTestId('commander-voice-status')).toHaveClass('commander-captions-large')
    fireEvent.click(screen.getByLabelText('Read full captions'))
    const dialog = screen.getByRole('dialog', { name: 'Captions' })
    expect(dialog).toHaveTextContent('longer than two lines')
    fireEvent.change(within(dialog).getByLabelText('Caption size'), { target: { value: 'small' } })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(useCommanderCallUiStore.getState().captionSize).toBe('small')
    fireEvent.click(screen.getByLabelText('Hide captions')); expect(screen.queryByTestId('commander-voice-status')).toBeNull()
    fireEvent.click(screen.getByLabelText('Show captions')); expect(screen.getByTestId('commander-voice-status')).toHaveClass('commander-captions-small')
  })
  it('routes call shortcuts outside editors and preserves native undo and existing navigation chords', async () => {
    render(<Harness />); await start()
    const field = screen.getByLabelText('Typed draft')
    const notice = { call: { id: 'archive-1', name: 'archive_project', input: { project: 'Web' } }, result: message(JSON.stringify({ status: 'ok', target: { kind: 'project', id: 'web', name: 'Web' }, changes: [{ field: 'archived', before: false, after: true }], undoId: 'exact-undo' })), observedAt: activityNow() }
    act(() => useCommanderStore.setState({ recentAction: notice }))
    mocks.undoAction.mockResolvedValue({ alreadyUndone: false, message: { ...message('Restored Web.'), id: 'undo-note', role: 'assistant', tool_name: 'undo_action', tool_call_id: 'exact-undo' } })
    expect(fireEvent.keyDown(field, { key: 'z', ctrlKey: true })).toBe(true)
    expect(fireEvent.keyDown(field, { key: 'd', ctrlKey: true })).toBe(true)
    expect(mocks.undoAction).not.toHaveBeenCalled(); expect(useCommanderCallStore.getState().muted).toBe(false)
    expect(fireEvent.keyDown(window, { key: '5', ctrlKey: true })).toBe(true)
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(mocks.undoAction).toHaveBeenCalledWith('s1', 'exact-undo'))
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true }); expect(useCommanderCallStore.getState().muted).toBe(true)
    fireEvent.keyDown(window, { key: 'c', ctrlKey: true, shiftKey: true }); expect(useCommanderCallUiStore.getState().captions).toBe(false)
    fireEvent.keyDown(window, { key: '\\', ctrlKey: true }); expect(useCommanderCallUiStore.getState().panelOpen).toBe(false)
    fireEvent.keyDown(window, { key: 'm', ctrlKey: true, shiftKey: true }); expect(screen.getByTestId('commander-pip')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'e', ctrlKey: true, shiftKey: true }); expect(screen.queryByTestId('commander-pip')).toBeNull()
    expect(useCommanderStore.getState().messages.s1).toHaveLength(1)
  })
})
