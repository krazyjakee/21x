import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => {
  const voiceState = {
    available: true,
    enabled: true,
    runtime: { installed: true, version: '1.0.0', modulePath: '/voice', sizeBytes: 1 },
    engine: { state: 'ready', modelId: 'parakeet', engine: 'sherpa' },
    state: 'idle',
    permission: 'granted',
    turnId: null as string | null,
    partial: '',
    speaking: false,
    tts: { enabled: true, status: { state: 'ready' as string, message: '' } },
    result: null as { message: string } | null,
    setEnabled: vi.fn(async (enabled: boolean) => {
      voiceState.enabled = enabled
      voiceState.permission = enabled ? 'granted' : voiceState.permission
    }),
    startTurn: vi.fn(async (mode: string) => {
      if (mode === 'conversation') voiceState.turnId = 'voice-turn-1'
    }),
    cancel: vi.fn(async () => {
      voiceState.turnId = null
    }),
    stopPlaybackNow: vi.fn(),
    initializeTts: vi.fn(async () => undefined),
    setTtsEnabled: vi.fn(async (enabled: boolean) => {
      voiceState.tts.enabled = enabled
      voiceState.tts.status.state = 'ready'
    }),
  }
  return {
    voiceState,
    commanderState: { selectedSessionId: 'session-1', streaming: {} as Record<string, unknown> },
    setActive: vi.fn(async (sessionId: string | null) => ({ active: sessionId })),
    bargeIn: vi.fn(async () => ({ cancelled: true })),
    send: vi.fn(async () => ({ turnId: 'commander-turn-1', message: {} })),
  }
})

vi.mock('@/lib/ipc-client', () => ({
  commanderVoiceApi: {
    setActive: mocks.setActive,
    bargeIn: mocks.bargeIn,
    send: mocks.send,
  },
}))

vi.mock('@/stores/commander-store', () => ({
  useCommanderStore: (selector: (state: typeof mocks.commanderState) => unknown) => selector(mocks.commanderState),
}))

vi.mock('@/stores/voice-store', () => {
  const useVoiceStore = Object.assign(
    (selector: (state: typeof mocks.voiceState) => unknown) => selector(mocks.voiceState),
    { getState: () => mocks.voiceState },
  )
  return {
    useVoiceStore,
    selectVoiceReady: (state: typeof mocks.voiceState) =>
      state.available && state.enabled && state.runtime.installed && state.engine.state === 'ready',
    selectVoiceSetupComplete: (state: typeof mocks.voiceState) =>
      state.runtime.installed && state.engine.state === 'ready',
    selectSpeechReady: (state: typeof mocks.voiceState) => state.tts.status.state === 'ready',
  }
})

import { insertAndSubmit, clearDictationTarget } from '@/lib/voice-dictation-target'
import { CommanderVoiceControls } from './CommanderVoiceControls'

beforeEach(() => {
  mocks.voiceState.available = true
  mocks.voiceState.enabled = true
  mocks.voiceState.runtime.installed = true
  mocks.voiceState.engine.state = 'ready'
  mocks.voiceState.permission = 'granted'
  mocks.voiceState.turnId = null
  mocks.voiceState.partial = ''
  mocks.voiceState.speaking = false
  mocks.voiceState.tts.enabled = true
  mocks.voiceState.tts.status.state = 'ready'
  mocks.voiceState.tts.status.message = ''
  mocks.voiceState.result = null
  mocks.commanderState.selectedSessionId = 'session-1'
  mocks.commanderState.streaming = {}
  vi.clearAllMocks()
  clearDictationTarget()
})

afterEach(() => {
  cleanup()
  clearDictationTarget()
})

describe('Commander voice conversation', () => {
  it('starts listening immediately and sends every pause-delimited utterance', async () => {
    const view = render(<CommanderVoiceControls />)
    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))

    await waitFor(() => expect(mocks.voiceState.startTurn).toHaveBeenCalledWith('conversation'))
    expect(mocks.setActive).toHaveBeenCalledWith('session-1')
    expect(screen.queryByTestId('commander-voice-talk')).toBeNull()
    expect(await screen.findByText('Listening…')).toBeTruthy()

    act(() => {
      expect(insertAndSubmit('Hello Commander')).toBe(true)
    })
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith('session-1', 'Hello Commander'))

    act(() => view.unmount())
    expect(mocks.voiceState.cancel).toHaveBeenCalled()
    expect(mocks.setActive).toHaveBeenLastCalledWith(null)
  })

  it('shows a useful setup error instead of silently doing nothing', async () => {
    mocks.voiceState.runtime.installed = false
    mocks.voiceState.engine.state = 'model_missing'
    render(<CommanderVoiceControls />)

    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))

    expect(await screen.findByRole('alert')).toHaveTextContent('Install the local speech runtime')
    expect(mocks.voiceState.startTurn).not.toHaveBeenCalled()
    expect(mocks.setActive).not.toHaveBeenCalled()
  })

  it('enables an installed microphone path from the same click', async () => {
    mocks.voiceState.enabled = false
    mocks.voiceState.permission = 'not-determined'
    render(<CommanderVoiceControls />)

    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))

    await waitFor(() => expect(mocks.voiceState.setEnabled).toHaveBeenCalledWith(true))
    expect(mocks.voiceState.startTurn).toHaveBeenCalledWith('conversation')
  })

  it('refreshes and enables a saved reply voice from the same click', async () => {
    mocks.voiceState.tts.enabled = false
    mocks.voiceState.tts.status.state = 'loading'
    render(<CommanderVoiceControls />)

    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))

    await waitFor(() => expect(mocks.voiceState.initializeTts).toHaveBeenCalled())
    expect(mocks.voiceState.setTtsEnabled).toHaveBeenCalledWith(true)
    expect(mocks.voiceState.startTurn).toHaveBeenCalledWith('conversation')
  })

  it('shows the saved engine failure after trying to prepare it', async () => {
    mocks.voiceState.tts.enabled = false
    mocks.voiceState.tts.status.state = 'error'
    mocks.voiceState.tts.status.message = 'ElevenLabs is temporarily unavailable.'
    mocks.voiceState.setTtsEnabled.mockImplementationOnce(async () => {
      mocks.voiceState.tts.enabled = true
    })
    render(<CommanderVoiceControls />)

    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))

    expect(await screen.findByRole('alert')).toHaveTextContent('ElevenLabs is temporarily unavailable')
    expect(mocks.voiceState.startTurn).not.toHaveBeenCalled()
  })
})
