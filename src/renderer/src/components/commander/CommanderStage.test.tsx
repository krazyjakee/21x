import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { VoiceModelState } from '@shared/voice'
import type { VoiceTtsSnapshot } from '@shared/voice-tts'
const mocks = vi.hoisted(() => ({ setActive: vi.fn(async () => ({})), bargeIn: vi.fn(async () => ({})), send: vi.fn(async () => ({})) }))
vi.mock('@/lib/ipc-client', async original => ({ ...await original<typeof import('@/lib/ipc-client')>(), commanderVoiceApi: mocks }))
import { useVoiceStore } from '@/stores/voice-store'
import { useCommanderStore } from '@/stores/commander-store'
import { __resetCommanderCall, useCommanderCallStore } from '@/stores/commander-call-store'
import { CommanderStage } from './CommanderStage'
import { CommanderCallHost } from './CommanderCallHost'
import { insertAndSubmit, clearDictationTarget } from '@/lib/voice-dictation-target'
import { __resetCommanderActivity } from '@/lib/activity/commander-activity-adapter'
const initial = useVoiceStore.getState()
const endTurn = vi.fn(async () => { useVoiceStore.setState({ state: 'transcribing' }) })
const startTurn = vi.fn(async () => { useVoiceStore.setState({ turnId: 'mic', turnEpoch: 'epoch', state: 'listening' }); return 'mic' })
beforeEach(() => {
  __resetCommanderCall(); __resetCommanderActivity(); vi.clearAllMocks()
  useCommanderStore.setState({ sessions: [], selectedSessionId: 's1', messages: { s1: [] }, streaming: {}, turnErrors: {}, recentAction: null })
  useVoiceStore.setState({ ...initial, available: true, enabled: true, permission: 'granted', runtime: { installed: true, version: '', modulePath: '', sizeBytes: 0 },
    models: [{ id: 'model', installed: true } as VoiceModelState], engine: { state: 'ready', modelId: 'model', engine: 'fixture' }, state: 'idle', turnId: null, turnEpoch: null, partial: '', final: '',
    tts: { enabled: true, status: { state: 'ready' } } as VoiceTtsSnapshot, initializeTts: async () => {}, startTurn, endTurn,
    cancel: async () => { useVoiceStore.setState({ turnId: null, turnEpoch: null, state: 'idle' }) }, stopPlaybackNow: vi.fn() })
})
afterEach(() => { cleanup(); __resetCommanderCall(); clearDictationTarget(); __resetCommanderActivity(); useVoiceStore.setState(initial); vi.restoreAllMocks() })
function stage() { return render(<><textarea aria-label="Typed draft" defaultValue="keep this" /><CommanderCallHost /><CommanderStage panelOpen onPanelToggle={() => {}} compact={false} onCompactToggle={() => {}} /></>) }
describe('Commander stage controls', () => {
  it('shows idle presence, starts one owned microphone and keeps partial captions in one non-live owner', async () => {
    stage(); expect(screen.getByText('Start talking')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Turn voice mode on'))
    await waitFor(() => expect(useCommanderCallStore.getState().status).toBe('live'))
    act(() => useVoiceStore.setState({ partial: 'Half heard words', level: .3 }))
    expect(screen.getByTestId('commander-voice-status')).toHaveTextContent('Half heard words')
    expect(screen.getByTestId('commander-voice-status')).not.toHaveAttribute('aria-live')
    expect(screen.getAllByText('Half heard words')).toHaveLength(1)
    expect(screen.getByLabelText('You, microphone listening')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Turn voice mode off'))
    expect(useCommanderCallStore.getState().status).toBe('off')
  })
  it('names the surviving call session when an inbox or another Chat is selected', async () => {
    stage()
    fireEvent.click(screen.getByLabelText('Turn voice mode on'))
    await waitFor(() => expect(useCommanderCallStore.getState().status).toBe('live'))
    act(() => useCommanderStore.setState({ selectedSessionId: 'inbox', sessions: [
      { id: 's1', title: 'Launch planning', created_at: 1, updated_at: 1, archived: false, last_read_at: 1, unread_count: 0 },
      { id: 'inbox', title: 'Project reports', created_at: 1, updated_at: 1, archived: false, last_read_at: 1, unread_count: 0, is_report_inbox: true }
    ] }))
    expect(screen.getByText('Call continues in').parentElement).toHaveTextContent('Launch planning')
    expect(useCommanderCallStore.getState().sessionId).toBe('s1')
    expect(startTurn).toHaveBeenCalledOnce()
  })

  it('retains unavailable reasons and typing, with a relevant fix rather than capture', () => {
    useVoiceStore.setState({ permission: 'denied' })
    stage(); fireEvent.click(screen.getByLabelText('Turn voice mode on'))
    expect(screen.getByRole('alert')).toHaveTextContent('Microphone access is blocked')
    expect(screen.getByRole('button', { name: 'Open voice settings' })).toBeTruthy()
    const field = screen.getByLabelText('Typed draft'); fireEvent.change(field, { target: { value: 'typing remains usable' } })
    expect(field).toHaveValue('typing remains usable'); expect(startTurn).not.toHaveBeenCalled()
  })
  it('does not record spaces typed in fields, ends a held PTT on focus change, and never submits twice', async () => {
    stage(); await act(async () => { await useCommanderCallStore.getState().setMicMode('push-to-talk'); await useCommanderCallStore.getState().start('s1') })
    const field = screen.getByLabelText('Typed draft')
    fireEvent.keyDown(field, { key: ' ', code: 'Space' }); expect(startTurn).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: ' ', code: 'Space' })
    await waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    act(() => { expect(insertAndSubmit('A complete sentence.')).toBe(true) })
    expect(mocks.send).not.toHaveBeenCalled()
    field.focus(); await waitFor(() => expect(endTurn).toHaveBeenCalledOnce())
    fireEvent.keyUp(field, { key: ' ', code: 'Space' }); expect(endTurn).toHaveBeenCalledOnce()
    act(() => useCommanderCallStore.getState().microphoneFinished('Final tail.'))
    expect(mocks.send).toHaveBeenCalledWith('s1', 'A complete sentence. Final tail.')
    expect(field).toHaveValue('keep this')
  })
})
