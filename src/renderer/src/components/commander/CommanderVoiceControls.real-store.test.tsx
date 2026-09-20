/**
 * Commander voice against the REAL voice store, its REAL readiness selectors
 * and the REAL global overlay, all mounted together (#83).
 *
 * `CommanderVoiceControls.test.tsx` replaces the store with a plain object: it
 * is not reactive, and its `selectVoiceSetupComplete` is stricter than the
 * production one (which is true whenever any model is installed, whatever the
 * engine is doing). Both differences hid real failures, so the cases that
 * depend on them live here. Only the store's actions that would reach the
 * main process or a real microphone are replaced, and each replacement writes
 * to the real store the way the real action does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { VoiceModelState } from '@shared/voice'
import type { VoiceTtsSnapshot } from '@shared/voice-tts'

const mocks = vi.hoisted(() => ({
  commanderState: { selectedSessionId: 'session-1' as string | null, streaming: {} as Record<string, unknown> },
  setActive: vi.fn(async (sessionId: string | null) => ({ active: sessionId })),
  bargeIn: vi.fn(async () => ({ cancelled: true })),
  send: vi.fn(async () => ({ turnId: 'commander-turn-1', message: {} })),
}))

vi.mock('@/lib/ipc-client', async (original) => ({
  ...(await original<typeof import('@/lib/ipc-client')>()),
  commanderVoiceApi: { setActive: mocks.setActive, bargeIn: mocks.bargeIn, send: mocks.send },
}))

vi.mock('@/stores/commander-store', () => ({
  useCommanderStore: (selector: (state: typeof mocks.commanderState) => unknown) => selector(mocks.commanderState),
}))

import { selectVoiceReady, selectVoiceSetupComplete, useVoiceStore } from '@/stores/voice-store'
import { useUIStore } from '@/stores/ui-store'
import { clearDictationTarget, insertAndSubmit } from '@/lib/voice-dictation-target'
import { SettingsTab } from '@/types'
import { VoiceOverlay } from '@/components/voice/VoiceOverlay'
import { CommanderCallHost, commanderCallMedia } from './CommanderCallHost'
import { __resetCommanderCall, useCommanderCallStore } from '@/stores/commander-call-store'
import {
  COMMANDER_VOICE_COMPOSER_KEY,
  CommanderVoiceControls,
  MICROPHONE_BUSY_MESSAGE,
  commanderVoiceReadiness,
} from './CommanderVoiceControls'

type VoiceState = ReturnType<typeof useVoiceStore.getState>

const INSTALLED_MODEL = { id: 'parakeet', installed: true } as unknown as VoiceModelState
const TTS_READY = { enabled: true, status: { state: 'ready' } } as unknown as VoiceTtsSnapshot

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}
function deferred(): Deferred {
  let resolve = (): void => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const initial = useVoiceStore.getState()

/** A ready voice path, with every main-process action replaced by a store-writing fake. */
function reset(partial: Partial<VoiceState> = {}): void {
  useVoiceStore.setState({
    ...initial,
    available: true,
    enabled: true,
    runtime: { installed: true, version: '1.0.0', modulePath: '/tmp/voice', sizeBytes: 0 },
    engine: { state: 'ready', modelId: 'parakeet', engine: 'sherpa-onnx' },
    models: [INSTALLED_MODEL],
    state: 'idle',
    permission: 'granted',
    turnId: null,
    partial: '',
    final: '',
    level: 0,
    speaking: false,
    confirmation: null,
    result: null,
    captionOwner: null,
    tts: TTS_READY,
    initializeTts: vi.fn(async () => undefined),
    setTtsEnabled: vi.fn(async () => undefined),
    setEnabled: vi.fn(async (enabled: boolean) => useVoiceStore.setState({ enabled })),
    startTurn: vi.fn(async () => {
      if (useVoiceStore.getState().turnId) return
      useVoiceStore.setState({ turnId: 'commander-turn', mode: 'conversation', state: 'listening', partial: '' })
    }),
    cancel: vi.fn(async () => useVoiceStore.setState({ turnId: null, state: 'idle', partial: '' })),
    stopPlaybackNow: vi.fn(),
    ...partial,
  }, true)
}

/** The task composer's microphone: a live turn this control did not open. */
function taskMicrophoneIsListening(words: string): void {
  useVoiceStore.setState({ turnId: 'task-turn', mode: 'dictation', state: 'listening', partial: words })
}

function renderBoth(): ReturnType<typeof render> {
  return render(
    <>
      <CommanderCallHost />
      <CommanderVoiceControls />
      <VoiceOverlay />
    </>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.commanderState.selectedSessionId = 'session-1'
  mocks.commanderState.streaming = {}
  clearDictationTarget()
  __resetCommanderCall()
  useCommanderCallStore.setState({ microphoneMode: 'open-mic' })
  useUIStore.setState({ activeModal: null, settingsTab: SettingsTab.GENERAL })
  reset()
})

afterEach(() => {
  cleanup()
  clearDictationTarget()
  __resetCommanderCall()
})

describe('another microphone keeps its captions (#83 blocker 2)', () => {
  it('refuses Commander voice at the click, before the reply voice is prepared, and the task captions never disappear', async () => {
    const tts = deferred()
    reset({ initializeTts: vi.fn(() => tts.promise) })
    taskMicrophoneIsListening('draft the release notes')
    renderBoth()

    expect(screen.getByTestId('voice-transcript')).toHaveTextContent('draft the release notes')
    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))

    expect(await screen.findByRole('alert')).toHaveTextContent(MICROPHONE_BUSY_MESSAGE)
    // Nothing slow was started, nothing was claimed, and the other turn is untouched.
    expect(useVoiceStore.getState().initializeTts).not.toHaveBeenCalled()
    expect(mocks.setActive).not.toHaveBeenCalled()
    expect(useVoiceStore.getState().captionOwner).toBeNull()
    expect(useVoiceStore.getState().turnId).toBe('task-turn')
    expect(useVoiceStore.getState().cancel).not.toHaveBeenCalled()
    expect(screen.getByTestId('voice-transcript')).toHaveTextContent('draft the release notes')
    expect(screen.queryByTestId('commander-voice-status')).toBeNull()
    expect(screen.getByLabelText('Turn voice mode on')).toHaveAttribute('aria-pressed', 'false')
    // Settings cannot fix a busy microphone.
    expect(screen.queryByTestId('commander-voice-fix')).toBeNull()

    // The words keep flowing to the overlay afterwards.
    act(() => useVoiceStore.setState({ partial: 'draft the release notes for Friday' }))
    expect(screen.getByTestId('voice-transcript')).toHaveTextContent('draft the release notes for Friday')
    tts.resolve()
  })

  it('hands the captions back the moment another microphone opens while Commander is still starting, however long setup hangs', async () => {
    const tts = deferred()
    reset({ initializeTts: vi.fn(() => tts.promise) })
    renderBoth()

    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))
    expect(await screen.findByText('Starting voice conversation…')).toBeTruthy()
    await waitFor(() => expect(useVoiceStore.getState().initializeTts).toHaveBeenCalled())

    // Setup is pending (it may never resolve). Now the task microphone opens.
    act(() => taskMicrophoneIsListening('rename the branch'))

    expect(useVoiceStore.getState().captionOwner).toBeNull()
    expect(screen.getByTestId('voice-transcript')).toHaveTextContent('rename the branch')
    // Commander never shows another microphone's words as its own.
    expect(screen.getByTestId('commander-voice-status')).not.toHaveTextContent('rename the branch')

    act(() => useVoiceStore.setState({ partial: 'rename the branch to release' }))
    expect(screen.getByTestId('voice-transcript')).toHaveTextContent('rename the branch to release')

    // Setup finally finishes: Commander backs off instead of taking the microphone.
    await act(async () => {
      tts.resolve()
      await tts.promise
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(MICROPHONE_BUSY_MESSAGE)
    expect(useVoiceStore.getState().startTurn).not.toHaveBeenCalled()
    expect(useVoiceStore.getState().turnId).toBe('task-turn')
    expect(useVoiceStore.getState().cancel).not.toHaveBeenCalled()
    expect(useVoiceStore.getState().captionOwner).toBeNull()
    expect(screen.getByTestId('voice-transcript')).toHaveTextContent('rename the branch to release')
  })

  it('still shows its own words exactly once, including while the microphone is opening', async () => {
    const capture = deferred()
    reset({
      // The real store publishes the turn id first and resolves only after the microphone opened.
      startTurn: vi.fn(async () => {
        useVoiceStore.setState({ turnId: 'commander-turn', mode: 'conversation', state: 'listening', partial: '' })
        await capture.promise
      }),
    })
    renderBoth()
    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))
    await waitFor(() => expect(useVoiceStore.getState().turnId).toBe('commander-turn'))

    // In the gap the overlay must not flash a second "Listening" bubble.
    expect(useVoiceStore.getState().captionOwner).toBe(COMMANDER_VOICE_COMPOSER_KEY)
    expect(screen.queryByTestId('voice-transcript')).toBeNull()

    await act(async () => {
      capture.resolve()
      await capture.promise
    })
    act(() => useVoiceStore.setState({ partial: 'what is running' }))
    expect(screen.getByTestId('commander-captions')).toHaveTextContent('what is running')
    expect(screen.getByTestId('commander-voice-status')).not.toHaveTextContent('what is running')
    expect(screen.queryByTestId('voice-transcript')).toBeNull()
    expect(screen.getAllByText('what is running')).toHaveLength(1)

    // A microphone that takes over later gets the overlay back.
    act(() => taskMicrophoneIsListening('over here now'))
    expect(useVoiceStore.getState().captionOwner).toBeNull()
    expect(screen.getByTestId('voice-transcript')).toHaveTextContent('over here now')
    expect(screen.queryByTestId('commander-voice-status')).toBeNull()
  })

  it('releases the captions when it unmounts mid-setup', async () => {
    const tts = deferred()
    reset({ initializeTts: vi.fn(() => tts.promise) })
    const view = renderBoth()
    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))
    await waitFor(() => expect(useVoiceStore.getState().initializeTts).toHaveBeenCalled())
    // Preparing output does not claim captions before this call owns a mic.
    expect(useVoiceStore.getState().captionOwner).toBeNull()
    act(() => view.unmount())
    expect(useVoiceStore.getState().captionOwner).toBeNull()
    tts.resolve()
  })
})

describe('app-level call ownership', () => {
  it('keeps the call and composer alive while the Commander controls unmount and remount', async () => {
    const view = renderBoth()
    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))
    expect(await screen.findByText('Listening')).toBeTruthy()
    const turnId = useCommanderCallStore.getState().turnId

    view.rerender(<><CommanderCallHost /><VoiceOverlay /></>)
    expect(useCommanderCallStore.getState()).toMatchObject({ status: 'live', sessionId: 'session-1', turnId })
    expect(useVoiceStore.getState().cancel).not.toHaveBeenCalled()

    act(() => insertAndSubmit('still connected'))
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith('session-1', 'still connected'))

    view.rerender(<><CommanderCallHost /><CommanderVoiceControls /><VoiceOverlay /></>)
    expect(await screen.findByLabelText('Mute microphone')).toBeTruthy()
    expect(useVoiceStore.getState().startTurn).toHaveBeenCalledTimes(1)
  })

  it('exposes real levels and captions without inventing word timings', () => {
    useVoiceStore.setState({ level: 0.4, partial: 'half heard', final: 'heard', speaking: true, speechText: 'answer' })
    expect(commanderCallMedia.capabilities).toEqual({
      partialCaptions: true,
      wordTimings: false,
      speechBargeIn: true,
      streamingTts: true
    })
    expect(commanderCallMedia.inputLevel()).toBe(0.4)
    expect(commanderCallMedia.userCaption).toEqual({ partial: 'half heard', final: 'heard' })
    expect(commanderCallMedia.assistantCaption).toEqual({ text: 'answer', speaking: true })
    expect(commanderCallMedia.assistantCaption).not.toHaveProperty('wordIndex')
  })
})

describe('broken voice and missing devices have a way out (#83 blocker 3)', () => {
  it('names an installed-but-crashed engine, which the production setup selector calls complete', async () => {
    reset({ engine: { state: 'error', message: 'Speech worker crashed.' } })
    // The premise: production readiness disagrees with production setup-completeness here.
    expect(selectVoiceSetupComplete(useVoiceStore.getState())).toBe(true)
    expect(selectVoiceReady(useVoiceStore.getState())).toBe(false)

    renderBoth()
    const label = await screen.findByTestId('commander-voice-setup')
    expect(label).toHaveTextContent('Voice engine error')
    expect(label.getAttribute('title')).toContain('Speech worker crashed.')
    expect(screen.getByLabelText('Turn voice mode on').getAttribute('aria-describedby')).toBe(label.id)

    fireEvent.click(label)
    expect(useUIStore.getState().activeModal).toBe('settings')
    expect(useUIStore.getState().settingsTab).toBe(SettingsTab.VOICE)
  })

  it('retries a crashed engine from the button, and offers Settings → Voice when it stays broken', async () => {
    reset({
      engine: { state: 'error', message: 'Speech worker crashed.' },
      // Main reloads the engine on enable; here it fails again.
      setEnabled: vi.fn(async () => useVoiceStore.setState({ enabled: true, engine: { state: 'error', message: 'Speech worker crashed again.' } })),
    })
    renderBoth()
    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))

    expect(await screen.findByRole('alert')).toHaveTextContent('Speech worker crashed again.')
    expect(useVoiceStore.getState().setEnabled).toHaveBeenCalledWith(true)
    expect(useVoiceStore.getState().startTurn).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('commander-voice-fix'))
    expect(useUIStore.getState().activeModal).toBe('settings')
    expect(useUIStore.getState().settingsTab).toBe(SettingsTab.VOICE)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('starts normally when the retry brings the engine back', async () => {
    reset({
      engine: { state: 'error', message: 'Speech worker crashed.' },
      setEnabled: vi.fn(async () => useVoiceStore.setState({ enabled: true, engine: { state: 'ready', modelId: 'parakeet', engine: 'sherpa-onnx' } })),
    })
    renderBoth()
    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))
    expect(await screen.findByText('Listening')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByTestId('commander-voice-setup')).toBeNull()
  })

  it.each([
    ['No microphone was found.', /Connect a microphone/],
    ['Microphone access was refused.', /Allow microphone access/],
    ['The microphone is in use by another application.', /Close the other application/],
  ])('offers the fix when the microphone does not open: %s', async (message, advice) => {
    reset({
      // What the real startTurn leaves behind when capture fails: an error result and no turn.
      startTurn: vi.fn(async () => useVoiceStore.setState({ turnId: null, result: { kind: 'error', message, at: Date.now() } })),
    })
    renderBoth()
    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(message)
    expect(alert).toHaveTextContent(advice)
    expect(screen.getByLabelText('Turn voice mode on')).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(screen.getByTestId('commander-voice-fix'))
    expect(useUIStore.getState().settingsTab).toBe(SettingsTab.VOICE)
    expect(useUIStore.getState().activeModal).toBe('settings')
  })

  it('offers the fix when the engine dies during a conversation', async () => {
    renderBoth()
    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))
    expect(await screen.findByText('Listening')).toBeTruthy()

    act(() => useVoiceStore.setState({
      turnId: null,
      state: 'idle',
      engine: { state: 'error', message: 'Speech worker crashed.' },
      result: { kind: 'error', message: 'Speech worker crashed.', at: Date.now() },
    }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Speech worker crashed.')
    expect(screen.getByTestId('commander-voice-fix')).toBeTruthy()
    expect(screen.getByTestId('commander-voice-setup')).toHaveTextContent('Voice engine error')
  })

  it('keeps one-click enablement for an installed engine that is merely switched off', async () => {
    reset({
      enabled: false,
      state: 'disabled',
      permission: 'not-determined',
      // Not loaded while voice is off; the installed model is what makes setup complete.
      engine: { state: 'model_missing', message: 'No speech model is installed yet.' },
      setEnabled: vi.fn(async () => useVoiceStore.setState({
        enabled: true,
        permission: 'granted',
        engine: { state: 'ready', modelId: 'parakeet', engine: 'sherpa-onnx' },
      })),
    })
    renderBoth()
    const button = await screen.findByLabelText('Turn voice mode on')
    expect(screen.queryByTestId('commander-voice-setup')).toBeNull()

    fireEvent.click(button)
    expect(await screen.findByText('Listening')).toBeTruthy()
    expect(useVoiceStore.getState().setEnabled).toHaveBeenCalledWith(true)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not offer Settings for a failure Settings cannot fix', async () => {
    mocks.send.mockRejectedValueOnce(new Error('No chat model is configured.'))
    const { insertAndSubmit } = await import('@/lib/voice-dictation-target')
    renderBoth()
    fireEvent.click(await screen.findByLabelText('Turn voice mode on'))
    expect(await screen.findByText('Listening')).toBeTruthy()
    act(() => {
      insertAndSubmit('hello')
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('No chat model is configured.')
    expect(screen.queryByTestId('commander-voice-fix')).toBeNull()
  })
})

describe('commanderVoiceReadiness', () => {
  const ready = { available: true, permission: 'granted', runtimeInstalled: true, setupComplete: true, engine: { state: 'ready' } }

  it('has nothing to say when voice is ready, switched off, or loading', () => {
    expect(commanderVoiceReadiness(ready)).toBeNull()
    expect(commanderVoiceReadiness({ ...ready, engine: { state: 'model_missing', message: 'stale' } })).toBeNull()
    expect(commanderVoiceReadiness({ ...ready, engine: { state: 'loading' } })).toBeNull()
  })

  it('orders the reasons by what the user must fix first, and only the engine error is retryable', () => {
    const broken = { available: false, permission: 'denied', runtimeInstalled: false, setupComplete: false, engine: { state: 'error', message: 'boom' } }
    expect(commanderVoiceReadiness(broken)).toMatchObject({ label: 'Voice unavailable', blocking: true })
    expect(commanderVoiceReadiness({ ...broken, available: true })).toMatchObject({ label: 'Mic blocked', blocking: true })
    expect(commanderVoiceReadiness({ ...broken, available: true, permission: 'granted' })).toMatchObject({ label: 'Voice not installed', blocking: true })
    expect(commanderVoiceReadiness({ ...broken, available: true, permission: 'granted', runtimeInstalled: true })).toMatchObject({ label: 'Voice engine error', blocking: false })
    expect(commanderVoiceReadiness({ ...ready, setupComplete: false, engine: { state: 'model_missing', message: 'No speech model is installed yet.' } }))
      .toEqual({ label: 'Voice not set up', problem: 'No speech model is installed yet.', blocking: true })
  })

  it('always gives an engine error a reason and an instruction, even without a message', () => {
    const silent = commanderVoiceReadiness({ ...ready, engine: { state: 'error', message: '  ' } })
    expect(silent?.problem).toMatch(/^The speech engine failed to start\. Click the voice button to try again/)
    expect(commanderVoiceReadiness({ ...ready, engine: { state: 'error', message: 'Worker exited' } })?.problem).toMatch(/^Worker exited\. Click/)
  })
})
