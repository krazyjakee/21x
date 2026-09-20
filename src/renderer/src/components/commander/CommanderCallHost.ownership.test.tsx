import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CommanderEvent } from '@shared/commander'
const mocks = vi.hoisted(() => ({
  selected: 'session-1',
  setActive: vi.fn(async (_id: string | null) => ({})),
  send: vi.fn(async (_id: string, _text: string): Promise<unknown> => ({})),
  bargeIn: vi.fn(async (_id: string) => ({})),
  events: new Set<(event: CommanderEvent) => void>()
}))
vi.mock('@/lib/ipc-client', async (original) => ({
  ...(await original<typeof import('@/lib/ipc-client')>()),
  commanderApi: { onEvent: (cb: (e: CommanderEvent) => void) => { mocks.events.add(cb); return () => mocks.events.delete(cb) } },
  commanderVoiceApi: { setActive: mocks.setActive, send: mocks.send, bargeIn: mocks.bargeIn }
}))
vi.mock('@/stores/commander-store', () => ({
  useCommanderStore: (selector: (s: { selectedSessionId: string }) => unknown) => selector({ selectedSessionId: mocks.selected })
}))
import { CommanderCallHost, commanderCallMedia } from './CommanderCallHost'
import { CommanderVoiceControls } from './CommanderVoiceControls'
import { VoiceOverlay } from '@/components/voice/VoiceOverlay'
import { __resetCommanderCall, useCommanderCallStore } from '@/stores/commander-call-store'
import { useVoiceStore } from '@/stores/voice-store'
import { clearDictationTarget, insertAndSubmit, getActiveComposer } from '@/lib/voice-dictation-target'
import { deriveCallState } from '@/lib/commander-call/derive-call-state'
import { __resetCommanderActivity, recordCommanderEvent } from '@/lib/activity/commander-activity-adapter'
import { __resetVoiceAttribution, useVoiceAttributionStore } from '@/lib/activity/voice-activity-adapter'
import { voiceCapture } from '@/lib/voice-capture'
import { voicePlayback } from '@/lib/voice-playback'
import { onCallMediaEvent } from '@/stores/commander-call-store'

const onVoiceFinal = vi.mocked(window.electronAPI.voice.onFinal).mock.calls[0][0]
const initial = useVoiceStore.getState()
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => {
  vi.clearAllMocks()
  __resetCommanderCall()
  __resetCommanderActivity()
  __resetVoiceAttribution()
  clearDictationTarget()
  mocks.selected = 'session-1'
  mocks.events.clear()
  useVoiceStore.setState({
    ...initial, available: true, enabled: true, permission: 'granted',
    runtime: { installed: true, version: '1', modulePath: '/tmp/voice', sizeBytes: 0 },
    engine: { state: 'ready', modelId: 'm', engine: 'sherpa-onnx' },
    tts: { enabled: true, status: { state: 'ready' } } as never,
    turnId: null, state: 'idle', partial: '', final: '', speaking: false, speechText: '',
    initializeTts: vi.fn(async () => {}),
    setTtsEnabled: vi.fn(async () => {}),
    startTurn: vi.fn(async () => {
      if (!useVoiceStore.getState().turnId) useVoiceStore.setState({ turnId: 'mic-1', state: 'listening' })
      return useVoiceStore.getState().turnId
    }),
    cancel: vi.fn(async () => { useVoiceStore.setState({ turnId: null, state: 'idle', partial: '' }) }),
    stopPlaybackNow: vi.fn()
  }, true)
})
afterEach(() => { cleanup(); __resetCommanderCall(); __resetCommanderActivity(); __resetVoiceAttribution(); clearDictationTarget(); vi.restoreAllMocks(); voicePlayback.stop(); vi.unstubAllGlobals() })
function view() { return render(<><CommanderCallHost /><CommanderVoiceControls /><VoiceOverlay /></>) }
async function start() { await act(async () => { await useCommanderCallStore.getState().start('session-1') }) }
function emit(event: CommanderEvent) { act(() => { recordCommanderEvent(event); for (const cb of mocks.events) cb(event) }) }

describe('Independent PR 164 adversarial review', () => {
  it('Escape stops the reply and keeps the owned microphone/call live', async () => {
    view(); await start()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useCommanderCallStore.getState()).toMatchObject({ status: 'live', turnId: 'mic-1', error: null })
    expect(useVoiceStore.getState().cancel).not.toHaveBeenCalled()
  })
  it('End during TTS preparation prevents later microphone acquisition', async () => {
    const tts = deferred<void>()
    useVoiceStore.setState({ initializeTts: vi.fn(() => tts.promise) })
    view()
    let pending!: Promise<void>
    await act(async () => { pending = useCommanderCallStore.getState().start('session-1') })
    act(() => useCommanderCallStore.getState().end())
    await act(async () => { tts.resolve(); await pending })
    expect(useVoiceStore.getState().startTurn).not.toHaveBeenCalled()
  })
  it('End closes a published microphone turn while capture opening remains pending (real voice-store action)', async () => {
    const capture = deferred<boolean>()
    vi.spyOn(voiceCapture, 'start').mockImplementation(() => capture.promise)
    vi.spyOn(voiceCapture, 'stop').mockImplementation(() => {})
    useVoiceStore.setState({ startTurn: initial.startTurn, cancel: initial.cancel })
    view()
    let pending!: Promise<void>
    await act(async () => { pending = useCommanderCallStore.getState().start('session-1') })
    expect(useVoiceStore.getState().turnId).toBe('turn-1')
    act(() => useCommanderCallStore.getState().end())
    const afterEnd = useVoiceStore.getState().turnId
    await act(async () => { capture.resolve(true); await pending })
    expect(afterEnd).toBeNull()
  })
  it('old send rejection cannot poison a restarted call to the same session', async () => {
    const sent = deferred<unknown>()
    mocks.send.mockImplementationOnce(() => sent.promise)
    view(); await start()
    act(() => useCommanderCallStore.getState().sendTranscript('old request'))
    act(() => useCommanderCallStore.getState().end())
    await start()
    await act(async () => { sent.reject(new Error('old call failure')); await sent.promise.catch(() => {}) })
    expect(useCommanderCallStore.getState().error).toBeNull()
  })
  it('CallMedia does not reveal foreign microphone captions or levels while off', () => {
    useVoiceStore.setState({ turnId: 'foreign', partial: 'private task words', final: 'previous session', level: 0.8, speaking: true, speechText: 'foreign answer' })
    expect.soft(commanderCallMedia.userCaption).toEqual({ partial: '', final: '' })
    expect.soft(commanderCallMedia.assistantCaption).toEqual({ text: '', speaking: false })
    expect.soft(commanderCallMedia.inputLevel()).toBe(0)
  })
  it('Commander error events become call errors with recovery controls', async () => {
    view(); await start()
    emit({ type: 'turn_started', sessionId: 'session-1', turnId: 't1' } as CommanderEvent)
    emit({ type: 'turn_event', sessionId: 'session-1', turnId: 't1', event: { type: 'error', message: 'Provider quota exceeded' } } as CommanderEvent)
    expect(screen.getByTestId('commander-voice-controls')).toHaveAttribute('data-call-state', 'error')
    expect(screen.getByRole('alert')).toHaveTextContent('Provider quota exceeded')
  })
  it('pure state derives a failed Commander turn as error', () => {
    const state = deriveCallState({
      call: { status: 'live', error: null, dismissedTurnErrorId: null, interruptedAt: null, lastEvent: null }, unavailable: null,
      mic: { open: true, voiceState: 'listening', partial: '' }, speech: 'none', speechOutput: true,
      turn: { turnId: 't1', phase: 'error', error: 'Provider quota exceeded' }, now: 1000
    })
    expect(state.state).toBe('error')
  })
  it('navigation and remount preserve one capture and one transcript send', async () => {
    const v = view(); await start()
    v.rerender(<><CommanderCallHost /><VoiceOverlay /></>)
    act(() => insertAndSubmit('after navigation'))
    await act(async () => {})
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith('session-1', 'after navigation')
    v.rerender(<><CommanderCallHost /><CommanderVoiceControls /><VoiceOverlay /></>)
    expect(useVoiceStore.getState().startTurn).toHaveBeenCalledTimes(1)
    expect(useCommanderCallStore.getState().status).toBe('live')
  })
  it('action/report events ignore foreign sessions and failed/read tools', async () => {
    view(); await start()
    const tool = (name: string, isError = false) => {
      emit({ type: 'turn_event', sessionId: 'session-1', turnId: 't1', event: { type: 'tool_call_start', id: name, name, input: {} } })
      emit({ type: 'turn_event', sessionId: 'session-1', turnId: 't1', event: { type: 'tool_call_result', id: name, name, content: '{}', isError } })
    }
    tool('list_projects'); tool('archive_project', true)
    expect(useCommanderCallStore.getState().lastEvent).toBeNull()
    tool('update_project')
    expect(useCommanderCallStore.getState().lastEvent).toMatchObject({ kind: 'action', toolName: 'update_project' })
    emit({ type: 'messages_appended', sessionId: 'other', messages: [{ id: 'foreign', role: 'report', project_id: 'p' }] } as CommanderEvent)
    expect(useCommanderCallStore.getState().lastEvent).toMatchObject({ kind: 'action' })
    emit({ type: 'messages_appended', sessionId: 'session-1', messages: [{ id: 'report1', role: 'report', project_id: 'p' }] } as CommanderEvent)
    expect(useCommanderCallStore.getState().lastEvent).toMatchObject({ kind: 'report', messageId: 'report1' })
  })
  it('first queued audio updates Speaking and speech_start without waiting for another speech event', async () => {
    class AudioGraph {
      state = 'running'
      currentTime = 0
      destination = {}
      createAnalyser() { return { fftSize: 256, frequencyBinCount: 128, connect() {}, disconnect() {}, getByteTimeDomainData(data: Uint8Array) { data.fill(140) } } }
      createBuffer(_channels: number, length: number, sampleRate: number) { return { duration: length / sampleRate, getChannelData: () => new Float32Array(length) } }
      createBufferSource() { return { buffer: null, onended: null, connect() {}, start() {}, stop() {} } }
      resume() { return Promise.resolve() }
      close() { return Promise.resolve() }
    }
    vi.stubGlobal('AudioContext', AudioGraph)
    view(); await start()
    const speechStart = vi.fn()
    onCallMediaEvent('speech_start', speechStart)
    act(() => {
      voicePlayback.start('speech-1')
      useVoiceStore.setState({ speaking: true, speechText: 'spoken reply' })
      useVoiceAttributionStore.setState({ passage: { speechId: 'speech-1', taskId: 'commander:session-1' }, version: 1 })
    })
    expect(screen.getByTestId('commander-voice-controls')).not.toHaveAttribute('data-call-state', 'speaking')
    // Drive production playback, substituting only the native Web Audio graph.
    await act(async () => { voicePlayback.play('speech-1', new Uint8Array([0, 64, 0, 64]), 16000) })
    expect(voicePlayback.hasQueuedAudio).toBe(true)
    expect(voicePlayback.outputLevel).toBeGreaterThan(0)
    expect(screen.getByTestId('commander-voice-controls')).toHaveAttribute('data-call-state', 'speaking')
    expect(speechStart).toHaveBeenCalledOnce()
  })
  it('Stop button preserves a live call and interrupts main once', async () => {
    view(); await start()
    emit({ type: 'turn_started', sessionId: 'session-1', turnId: 't1' } as CommanderEvent)
    fireEvent.click(screen.getByLabelText('Stop the reply'))
    expect(useCommanderCallStore.getState().status).toBe('live')
    expect(mocks.bargeIn).toHaveBeenCalledExactlyOnceWith('session-1')
    expect(useVoiceStore.getState().cancel).not.toHaveBeenCalled()
  })
  it('host unmount closes a live call once; remount stays off', async () => {
    const v = view(); await start()
    v.unmount()
    expect(useCommanderCallStore.getState().status).toBe('off')
    expect(useVoiceStore.getState().cancel).toHaveBeenCalledOnce()
    view()
    expect(useCommanderCallStore.getState().status).toBe('off')
    expect(useVoiceStore.getState().startTurn).toHaveBeenCalledOnce()
  })
  it('switching selected chats preserves the call session until explicitly moved', async () => {
    const v = view(); await start()
    mocks.selected = 'session-2'
    v.rerender(<><CommanderCallHost /><CommanderVoiceControls /><VoiceOverlay /></>)
    act(() => insertAndSubmit('still talking to session one'))
    await act(async () => {})
    expect(mocks.send).toHaveBeenCalledWith('session-1', 'still talking to session one')
    await act(async () => { await useCommanderCallStore.getState().start('session-2') })
    expect(useCommanderCallStore.getState()).toMatchObject({ status: 'live', sessionId: 'session-2', lastEvent: null, error: null })
    expect(useVoiceStore.getState().startTurn).toHaveBeenCalledTimes(2)
  })

  it('derived presentation is deterministic and total over 1008 frozen state combinations', () => {
    let checked = 0
    for (const status of ['off', 'starting', 'live'] as const)
    for (const voiceState of ['disabled', 'idle', 'listening', 'transcribing', 'thinking', 'speaking', 'error'] as const)
    for (const speech of ['none', 'listening', 'speaking', 'unknown'] as const)
    for (const phase of ['thinking', 'working', 'tool', 'idle', 'error', null] as const)
    for (const error of [null, 'media error']) {
      const input = Object.freeze({
        call: Object.freeze({ status, error, interruptedAt: null, lastEvent: null }),
        unavailable: null,
        mic: Object.freeze({ open: status === 'live', voiceState, partial: '' }),
        speech, speechOutput: true, turn: phase ? Object.freeze({ phase }) : null, now: 10000
      })
      // Some values exercise runtime boundary robustness beyond VoiceState's static union.
      const first = deriveCallState(input as Parameters<typeof deriveCallState>[0])
      expect(first).toEqual(deriveCallState(input as Parameters<typeof deriveCallState>[0]))
      expect(['off', 'unavailable', 'ready', 'listening', 'transcribing', 'thinking', 'working', 'speaking', 'interrupted', 'error']).toContain(first.state)
      expect(first.label.length).toBeGreaterThan(0)
      checked++
    }
    expect(checked).toBe(1008)
  })

})

describe('Independent repair-boundary regressions', () => {
  it.each([
    { label: 'same session, new turn id', nextSession: 'session-1', oldTurn: 'old-mic', newTurn: 'new-mic' },
    { label: 'different session, new turn id', nextSession: 'session-2', oldTurn: 'old-mic', newTurn: 'new-mic' },
    { label: 'same session, reused turn id', nextSession: 'session-1', oldTurn: 'shared-mic', newTurn: 'shared-mic' },
    { label: 'different session, reused turn id', nextSession: 'session-2', oldTurn: 'shared-mic', newTurn: 'shared-mic' }
  ])('late cancelled capture cannot remove the replacement composer ($label)', async ({ nextSession, oldTurn, newTurn }) => {
    const oldCapture = deferred<boolean>()
    vi.spyOn(voiceCapture, 'start')
      .mockImplementationOnce(() => oldCapture.promise)
      .mockResolvedValueOnce(true)
    vi.spyOn(voiceCapture, 'stop').mockImplementation(() => {})
    const startTurnApi = vi.mocked(window.electronAPI.voice.startTurn)
    startTurnApi.mockResolvedValueOnce({ turnId: oldTurn }).mockResolvedValueOnce({ turnId: newTurn })
    useVoiceStore.setState({ startTurn: initial.startTurn, cancel: initial.cancel })
    view()
    let oldStart!: Promise<void>
    await act(async () => { oldStart = useCommanderCallStore.getState().start('session-1') })
    expect(useVoiceStore.getState().turnId).toBe(oldTurn)
    act(() => useCommanderCallStore.getState().end())
    await act(async () => { await useCommanderCallStore.getState().start(nextSession) })
    expect(useCommanderCallStore.getState()).toMatchObject({status: 'live', sessionId: nextSession, turnId: newTurn})
    expect(getActiveComposer()).toBe('commander-voice')
    await act(async () => { oldCapture.resolve(false); await oldStart })
    expect.soft(getActiveComposer()).toBe('commander-voice')
    expect.soft(useVoiceStore.getState().captionOwner).toBe('commander-voice')
    let delivered = false
    act(() => { delivered = insertAndSubmit('replacement words') })
    await act(async () => {})
    expect.soft(delivered).toBe(true)
    expect(mocks.send).toHaveBeenCalledWith(nextSession, 'replacement words')
  })

  it('old send success cannot reset the replacement same-session interruption', async () => {
    const sent = deferred<unknown>()
    mocks.send.mockImplementationOnce(() => sent.promise)
    view(); await start()
    act(() => useCommanderCallStore.getState().sendTranscript('old request'))
    act(() => useCommanderCallStore.getState().end())
    await start()
    act(() => useCommanderCallStore.getState().interrupt())
    await act(async () => { sent.resolve({}); await sent.promise })
    expect(useCommanderCallStore.getState().replyInterrupted).toBe(true)
  })

  it('ordinary End is not a media-loss error with Host, Controls and Overlay', async () => {
    view(); await start()
    fireEvent.click(screen.getByLabelText('Turn voice mode off'))
    expect(useCommanderCallStore.getState()).toMatchObject({status: 'off', error: null, turnId: null})
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('generic Escape still cancels a non-Commander microphone', () => {
    useVoiceStore.setState({ turnId: 'foreign', state: 'listening' })
    render(<VoiceOverlay />)
    fireEvent.keyDown(window, {key: 'Escape'})
    expect(useVoiceStore.getState().cancel).toHaveBeenCalledOnce()
  })
})

describe('Independent media caption attribution', () => {
  it.each([
    { priorFinal: 'own previous sentence', foreignTurn: 'old-foreign-turn' },
    { priorFinal: '', foreignTurn: 'other-live-turn' }
  ])('late final from $foreignTurn cannot replace the live owned caption', async ({ priorFinal, foreignTurn }) => {
    view(); await start()
    act(() => useVoiceStore.setState({ final: priorFinal, partial: 'own current sentence' }))
    act(() => onVoiceFinal({turnId: foreignTurn, text: 'private foreign words'}))
    expect(useCommanderCallStore.getState()).toMatchObject({status: 'live', turnId: 'mic-1'})
    expect(useVoiceStore.getState().turnId).toBe('mic-1')
    expect.soft(commanderCallMedia.userCaption.final).toBe(priorFinal)
    expect(commanderCallMedia.userCaption.partial).toBe('own current sentence')
  })
})

describe('Independent host epoch routing', () => {
  it.each(['session-1', 'session-2'])('late activation from an unmounted host cannot clear replacement %s', async (nextSession) => {
    const activation = deferred<Record<string, never>>()
    mocks.setActive.mockImplementationOnce(() => activation.promise)
    const oldView = view()
    let oldStart!: Promise<void>
    await act(async () => { oldStart = useCommanderCallStore.getState().start('session-1') })
    oldView.unmount()
    mocks.selected = nextSession
    view()
    await act(async () => { await useCommanderCallStore.getState().start(nextSession) })
    expect(useCommanderCallStore.getState()).toMatchObject({status: 'live', sessionId: nextSession})
    expect(mocks.setActive).toHaveBeenLastCalledWith(nextSession)
    await act(async () => { activation.resolve({}); await oldStart })
    expect(mocks.setActive).toHaveBeenLastCalledWith(nextSession)
  })

  it.each(['session-1', 'session-2'])('late cleanup from an unmounted host cannot clear replacement %s', async (nextSession) => {
    const oldView = view()
    await start()
    const cleanupRouting = deferred<Record<string, never>>()
    mocks.setActive.mockImplementationOnce(() => cleanupRouting.promise)
    oldView.unmount()
    mocks.selected = nextSession
    view()
    await act(async () => { await useCommanderCallStore.getState().start(nextSession) })
    expect(mocks.setActive).toHaveBeenLastCalledWith(nextSession)
    await act(async () => { cleanupRouting.resolve({}); await cleanupRouting.promise; await Promise.resolve() })
    expect(useCommanderCallStore.getState()).toMatchObject({status: 'live', sessionId: nextSession})
    expect(mocks.setActive).toHaveBeenLastCalledWith(nextSession)
  })
})
