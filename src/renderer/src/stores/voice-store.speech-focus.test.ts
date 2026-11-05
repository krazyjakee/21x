import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { VoiceSpeechChunkEvent, VoiceSpeechStartEvent, VoiceSpeechSource } from '@shared/voice-tts'

const tts = vi.hoisted(() => {
  const bridge = {
    start: null as null | ((event: VoiceSpeechStartEvent) => void),
    chunk: null as null | ((event: VoiceSpeechChunkEvent) => void),
    stop: vi.fn(async () => {}),
  }
  window.electronAPI.voice.tts = {
    getSnapshot: vi.fn(async () => null),
    onSpeechStart: vi.fn((cb: (event: VoiceSpeechStartEvent) => void) => { bridge.start = cb; return () => {} }),
    onSpeechChunk: vi.fn((cb: (event: VoiceSpeechChunkEvent) => void) => { bridge.chunk = cb; return () => {} }),
    onSpeechEnd: vi.fn(() => () => {}),
    onStatus: vi.fn(() => () => {}),
    onModelProgress: vi.fn(() => () => {}),
    stop: bridge.stop,
  } as unknown as typeof window.electronAPI.voice.tts
  return bridge
})

vi.mock('@/lib/voice-speech-focus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/voice-speech-focus')>()),
  speechInFocus: vi.fn(() => true),
}))

const { useVoiceStore } = await import('./voice-store')
const { voicePlayback } = await import('@/lib/voice-playback')
const { speechInFocus, SPEECH_FOCUS_CHECK_MS } = await import('@/lib/voice-speech-focus')

let generation = 0
function passage(source: VoiceSpeechSource, text = 'Hello there.'): VoiceSpeechStartEvent {
  generation += 1
  return { speechId: `speech-${generation}`, speechGeneration: generation, source, text, taskId: 't1', sampleRate: 22050, truncated: false }
}

describe('voice store: automatic speech follows focus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    useVoiceStore.setState({ speaking: false, speechText: '' })
    vi.mocked(speechInFocus).mockReturnValue(true)
    vi.spyOn(voicePlayback, 'play').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reads a reply that is in focus', () => {
    tts.start?.(passage('agent_answer'))
    expect(useVoiceStore.getState().speaking).toBe(true)
    expect(tts.stop).not.toHaveBeenCalled()
  })

  it('stops a reply out of focus before any of it is heard, and drops its audio', () => {
    vi.mocked(speechInFocus).mockReturnValue(false)
    const event = passage('conversation')
    tts.start?.(event)
    tts.chunk?.({ speechId: event.speechId, speechGeneration: event.speechGeneration, index: 0, pcm: new Uint8Array(4), sampleRate: 22050, text: 'Hello' })
    expect(useVoiceStore.getState().speaking).toBe(false)
    expect(tts.stop).toHaveBeenCalledOnce()
    expect(voicePlayback.play).not.toHaveBeenCalled()
  })

  it('leaves the empty opening of a passage for its first words to silence', () => {
    vi.mocked(speechInFocus).mockReturnValue(false)
    tts.start?.(passage('agent_answer', ''))
    expect(useVoiceStore.getState().speaking).toBe(false)
    expect(tts.stop).not.toHaveBeenCalled()
  })

  it('stops mid-reply when focus is lost and does not resume when it returns', () => {
    const event = passage('conversation')
    tts.start?.(event)
    vi.mocked(speechInFocus).mockReturnValue(false)
    vi.advanceTimersByTime(SPEECH_FOCUS_CHECK_MS)
    expect(useVoiceStore.getState().speaking).toBe(false)
    expect(tts.stop).toHaveBeenCalledOnce()

    vi.mocked(speechInFocus).mockReturnValue(true)
    tts.start?.({ ...event, text: 'The next sentence.' })
    vi.advanceTimersByTime(SPEECH_FOCUS_CHECK_MS * 3)
    expect(useVoiceStore.getState().speaking).toBe(false)
  })

  it('speaks the next reply once focus is back', () => {
    vi.mocked(speechInFocus).mockReturnValue(false)
    tts.start?.(passage('conversation'))
    vi.mocked(speechInFocus).mockReturnValue(true)
    tts.start?.(passage('conversation'))
    expect(useVoiceStore.getState().speaking).toBe(true)
  })

  it('never interferes with speech the user asked for', () => {
    vi.mocked(speechInFocus).mockReturnValue(false)
    tts.start?.(passage('manual'))
    vi.advanceTimersByTime(SPEECH_FOCUS_CHECK_MS * 3)
    expect(useVoiceStore.getState().speaking).toBe(true)
    expect(tts.stop).not.toHaveBeenCalled()
  })
})
