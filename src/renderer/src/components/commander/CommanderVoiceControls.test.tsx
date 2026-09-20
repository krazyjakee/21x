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
    inputDeviceId: '',
    turnId: null as string | null,
    partial: '',
    speaking: false,
    tts: { enabled: true, status: { state: 'ready' as string, message: '' } },
    result: null as { message: string } | null,
    captionOwner: null as string | null,
    setCaptionOwner: vi.fn((owner: string | null) => {
      voiceState.captionOwner = owner
    }),
    setInputDevice: vi.fn(async (deviceId: string) => {
      voiceState.inputDeviceId = deviceId
    }),
    setEnabled: vi.fn(async (enabled: boolean) => {
      voiceState.enabled = enabled
      voiceState.permission = enabled ? 'granted' : voiceState.permission
    }),
    startTurn: vi.fn(async () => {
      voiceState.turnId = 'voice-turn-1'
      voiceState.state = 'listening'
    }),
    endTurn: vi.fn(async () => {
      voiceState.turnId = null
      voiceState.state = 'transcribing'
    }),
    cancel: vi.fn(async () => {
      voiceState.turnId = null
      voiceState.state = 'idle'
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

vi.mock('@/lib/ipc-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ipc-client')>(),
  commanderApi: { onEvent: vi.fn(() => () => {}) },
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
import { useUIStore } from '@/stores/ui-store'
import { SettingsTab } from '@/types'
import { CommanderVoiceControls } from './CommanderVoiceControls'
import { CommanderCallHost } from './CommanderCallHost'
import { __resetCommanderCall, useCommanderCallStore } from '@/stores/commander-call-store'

const originalMediaDevices = navigator.mediaDevices

function renderVoice() {
  return render(<><CommanderCallHost /><CommanderVoiceControls /></>)
}

beforeEach(() => {
  mocks.voiceState.available = true
  mocks.voiceState.enabled = true
  mocks.voiceState.runtime.installed = true
  mocks.voiceState.engine.state = 'ready'
  mocks.voiceState.permission = 'granted'
  mocks.voiceState.turnId = null
  mocks.voiceState.state = 'idle'
  mocks.voiceState.partial = ''
  mocks.voiceState.speaking = false
  mocks.voiceState.tts.enabled = true
  mocks.voiceState.tts.status.state = 'ready'
  mocks.voiceState.tts.status.message = ''
  mocks.voiceState.result = null
  mocks.voiceState.captionOwner = null
  mocks.commanderState.selectedSessionId = 'session-1'
  mocks.commanderState.streaming = {}
  vi.clearAllMocks()
  clearDictationTarget()
  __resetCommanderCall()
  useCommanderCallStore.setState({ microphoneMode: 'open-mic' })
})

afterEach(() => {
  cleanup()
  clearDictationTarget()
  __resetCommanderCall()
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: originalMediaDevices })
})

describe('Commander voice conversation', () => {
  it('defaults to PTT and offers a working open-mic choice', async () => {
    useCommanderCallStore.setState({ microphoneMode: 'push-to-talk' })
    renderVoice()
    fireEvent.click(await screen.findByLabelText('Microphone options'))
    expect(screen.getByTestId('commander-mic-mode-label')).toHaveTextContent('Selected: Push to talk')

    fireEvent.click(screen.getByLabelText('Open mic'))
    fireEvent.click(screen.getByLabelText('Turn voice mode on'))

    await waitFor(() => expect(mocks.voiceState.startTurn).toHaveBeenCalledWith('conversation'))
    expect(screen.getByTestId('commander-mic-mode-label')).toHaveTextContent('Selected: Open mic')
  })

  it('keeps a PTT call ready until a deliberate press and uses dictation', async () => {
    useCommanderCallStore.setState({ microphoneMode: 'push-to-talk' })
    renderVoice()
    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))

    expect(await screen.findByText('Hold Space to talk')).toBeTruthy()
    expect(mocks.voiceState.startTurn).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Start push-to-talk'))
    await waitFor(() => expect(mocks.voiceState.startTurn).toHaveBeenCalledWith('dictation'))
  })

  it('lists local input devices and saves the selected microphone', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: vi.fn(async () => [
          { kind: 'audioinput', deviceId: 'usb-mic', label: 'USB microphone', groupId: '', toJSON: () => ({}) }
        ]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }
    })
    renderVoice()
    fireEvent.click(await screen.findByLabelText('Microphone options'))
    const device = await screen.findByLabelText('Input device')

    fireEvent.change(device, { target: { value: 'usb-mic' } })

    await waitFor(() => expect(mocks.voiceState.setInputDevice).toHaveBeenCalledWith('usb-mic'))
  })

  it('starts listening immediately and sends every pause-delimited utterance', async () => {
    const view = renderVoice()
    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))

    await waitFor(() => expect(mocks.voiceState.startTurn).toHaveBeenCalledWith('conversation'))
    expect(mocks.setActive).toHaveBeenCalledWith('session-1')
    expect(screen.queryByTestId('commander-voice-talk')).toBeNull()
    expect(await screen.findByText('Listening')).toBeTruthy()

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
    renderVoice()

    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))

    expect(await screen.findByRole('alert')).toHaveTextContent('Install the local speech runtime')
    expect(mocks.voiceState.startTurn).not.toHaveBeenCalled()
    expect(mocks.setActive).not.toHaveBeenCalled()
  })

  it('enables an installed microphone path from the same click', async () => {
    mocks.voiceState.enabled = false
    mocks.voiceState.permission = 'not-determined'
    renderVoice()

    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))

    await waitFor(() => expect(mocks.voiceState.setEnabled).toHaveBeenCalledWith(true))
    expect(mocks.voiceState.startTurn).toHaveBeenCalledWith('conversation')
  })

  it('refreshes and enables a saved reply voice from the same click', async () => {
    mocks.voiceState.tts.enabled = false
    mocks.voiceState.tts.status.state = 'loading'
    renderVoice()

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
    renderVoice()

    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))

    expect(await screen.findByRole('alert')).toHaveTextContent('ElevenLabs is temporarily unavailable')
    expect(mocks.voiceState.startTurn).not.toHaveBeenCalled()
  })

  it('owns the half-heard words while its conversation runs, so they show once', async () => {
    renderVoice()
    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))
    await waitFor(() => expect(mocks.voiceState.startTurn).toHaveBeenCalled())
    expect(mocks.voiceState.captionOwner).toBe('commander-voice')

    fireEvent.click(screen.getByLabelText('Mute microphone'))
    await waitFor(() => expect(mocks.voiceState.captionOwner).toBeNull())
  })

  it('does not show words from another microphone as its own', async () => {
    mocks.voiceState.turnId = 'someone-else'
    mocks.voiceState.partial = 'dictating a task'
    renderVoice()
    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))

    expect(await screen.findByRole('alert')).toHaveTextContent('Another microphone is already listening')
    expect(screen.queryByText('dictating a task')).toBeNull()
    expect(mocks.voiceState.captionOwner).toBeNull()
  })
})

describe('Commander voice not ready', () => {
  it('names the reason in visible text before any click', async () => {
    mocks.voiceState.runtime.installed = false
    renderVoice()

    const label = await screen.findByTestId('commander-voice-setup')
    expect(label).toHaveTextContent('Voice not installed')
    expect(screen.getByLabelText('Turn voice mode on').getAttribute('aria-describedby')).toBe(label.id)
  })

  it('says the microphone is blocked', async () => {
    mocks.voiceState.permission = 'denied'
    renderVoice()
    expect(await screen.findByTestId('commander-voice-setup')).toHaveTextContent('Mic blocked')
  })

  it('shows nothing extra when voice is ready', async () => {
    renderVoice()
    await screen.findByLabelText('Turn voice mode on')
    expect(screen.queryByTestId('commander-voice-setup')).toBeNull()
  })

  it('offers a fix that opens Settings → Voice', async () => {
    mocks.voiceState.runtime.installed = false
    useUIStore.setState({ activeModal: null, settingsTab: SettingsTab.GENERAL })
    renderVoice()

    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Install the local speech runtime')
    fireEvent.click(screen.getByTestId('commander-voice-fix'))

    expect(useUIStore.getState().activeModal).toBe('settings')
    expect(useUIStore.getState().settingsTab).toBe(SettingsTab.VOICE)
    // The visible recovery banner remains as truthful stage state until setup changes.
    expect(screen.getByRole('alert')).toHaveTextContent('Install the local speech runtime')
  })
})
