import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { VoiceSpeechChunkEvent, VoiceSpeechStartEvent } from '@shared/voice-tts'

const tts = vi.hoisted(() => {
  const bridge = {
    start: null as null | ((event: VoiceSpeechStartEvent) => void),
    chunk: null as null | ((event: VoiceSpeechChunkEvent) => void),
    stop: vi.fn(async () => {}),
    onAudio: null as null | ((chunk: Uint8Array) => void),
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

vi.mock('@/lib/voice-capture', () => ({
  voiceCapture: {
    isCapturing: false,
    start: vi.fn(async (handlers: { onAudio: (chunk: Uint8Array) => void }) => { tts.onAudio = handlers.onAudio; return true }),
    stop: vi.fn(),
  },
}))

vi.mock('@/lib/voice-speech-focus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/voice-speech-focus')>()),
  speechInFocus: vi.fn(() => true),
}))

const { useVoiceStore } = await import('./voice-store')
const { voicePlayback } = await import('@/lib/voice-playback')

const pushAudio = vi.mocked(window.electronAPI.voice.pushAudio)

/** 100 ms of 16 kHz PCM, far above the barge-in floor. */
function loud(): Uint8Array {
  const chunk = new Uint8Array(3200)
  const view = new DataView(chunk.buffer)
  for (let i = 0; i < 1600; i++) view.setInt16(i * 2, 8000, true)
  return chunk
}

/** 300 ms of it, which is what the gate needs to fire. */
function cough(): void {
  for (let i = 0; i < 3; i++) tts.onAudio?.(loud())
}

let generation = 1000
async function openPassage(): Promise<VoiceSpeechStartEvent> {
  await useVoiceStore.getState().startTurn('conversation')
  generation += 1
  const event: VoiceSpeechStartEvent = {
    speechId: `speech-${generation}`, speechGeneration: generation, source: 'conversation', text: 'Let me check that.',
    taskId: 'commander:s1', sampleRate: 22050, truncated: false,
  }
  tts.start?.(event)
  return event
}

describe('voice store: a sound while a passage is open', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useVoiceStore.setState({ available: true, enabled: true, state: 'idle', turnId: null, turnEpoch: null, speaking: false, speechText: '' })
    vi.spyOn(voicePlayback, 'play').mockImplementation(() => {})
  })
  afterEach(() => {
    voicePlayback.stop()
    vi.restoreAllMocks()
  })

  it('holds the microphone while a passage is open', async () => {
    await openPassage()

    tts.onAudio?.(loud())

    expect(pushAudio).not.toHaveBeenCalled()
  })

  it('stops nothing when nothing is sounding, as during a tool run', async () => {
    vi.spyOn(voicePlayback, 'hasQueuedAudio', 'get').mockReturnValue(false)
    await openPassage()

    cough()

    expect(tts.stop).not.toHaveBeenCalled()
    expect(useVoiceStore.getState().speaking).toBe(true)
    expect(pushAudio).toHaveBeenCalled()
  })

  it('still stops audio that is sounding', async () => {
    vi.spyOn(voicePlayback, 'hasQueuedAudio', 'get').mockReturnValue(true)
    await openPassage()

    cough()

    expect(tts.stop).toHaveBeenCalledOnce()
    expect(useVoiceStore.getState().speaking).toBe(false)
  })

  it('closes the gate again when the next sentence arrives', async () => {
    vi.spyOn(voicePlayback, 'hasQueuedAudio', 'get').mockReturnValue(false)
    const passage = await openPassage()
    cough()
    pushAudio.mockClear()

    tts.chunk?.({ speechId: passage.speechId, speechGeneration: passage.speechGeneration, index: 0, pcm: new Uint8Array(4), sampleRate: 22050, text: 'Done.' })
    tts.onAudio?.(loud())

    expect(voicePlayback.play).toHaveBeenCalledOnce()
    expect(pushAudio).not.toHaveBeenCalled()
  })
})
