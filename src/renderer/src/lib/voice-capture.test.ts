import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceCapture } from './voice-capture'

class FakeWorkletNode {
  port = { onmessage: null as ((event: MessageEvent) => void) | null }
  disconnect = vi.fn()
}

class FakeAudioContext {
  state: AudioContextState = 'running'
  audioWorklet = { addModule: vi.fn(async () => undefined) }
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }))
  resume = vi.fn(async () => undefined)
  close = vi.fn(async () => undefined)
}

function stream() {
  const listeners = new Map<string, () => void>()
  const track = { stop: vi.fn(), readyState: 'live', enabled: true, muted: false,
    addEventListener: vi.fn((event: string, callback: () => void) => { listeners.set(event, callback) }),
    removeEventListener: vi.fn((event: string) => { listeners.delete(event) }) }
  return {
    track, listeners,
    value: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream
  }
}

let originalMediaDevices: MediaDevices | undefined

beforeEach(() => {
  originalMediaDevices = navigator.mediaDevices
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:voice-capture-test')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})

afterEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: originalMediaDevices })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('VoiceCapture acquisition ownership', () => {
  it('invalidates physical capture on track loss and never lets a retired track stop its replacement', async () => {
    const first = stream()
    const second = stream()
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValueOnce(first.value).mockResolvedValueOnce(second.value) } })
    const capture = new VoiceCapture()
    const changed = vi.fn()
    const off = capture.subscribeActivity(changed)
    const onError = vi.fn()
    await capture.start({ onAudio: vi.fn(), onError })
    expect(capture.isCapturing).toBe(true)
    const ended = first.listeners.get('ended')!
    first.track.readyState = 'ended'
    expect(capture.isCapturing).toBe(false)
    ended()
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('microphone disconnected'))
    expect(first.track.stop).toHaveBeenCalledOnce()
    await capture.start({ onAudio: vi.fn(), onError })
    ended()
    expect(capture.isCapturing).toBe(true)
    expect(second.track.stop).not.toHaveBeenCalled()
    expect(changed).toHaveBeenCalledTimes(3)
    capture.stop(); off()
  })

  it('does not claim capture from a muted track or suspended audio context', async () => {
    const input = stream()
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => input.value) } })
    const capture = new VoiceCapture()
    await capture.start({ onAudio: vi.fn() })
    const context = (capture as unknown as { context: FakeAudioContext }).context
    input.track.muted = true
    expect(capture.isCapturing).toBe(false)
    input.track.muted = false
    context.state = 'suspended'
    expect(capture.isCapturing).toBe(false)
    context.state = 'running'
    expect(capture.isCapturing).toBe(true)
    capture.stop()
  })

  it('stops a stream that resolves after End and reports no cancellation error', async () => {
    let resolveMedia!: (value: MediaStream) => void
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => { resolveMedia = resolve }))
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
    const capture = new VoiceCapture()
    const controller = new AbortController()
    const onError = vi.fn()
    const starting = capture.start({ onAudio: vi.fn(), onError }, undefined, controller.signal)
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1))

    controller.abort()
    const late = stream()
    resolveMedia(late.value)

    await expect(starting).resolves.toBe(false)
    expect(late.track.stop).toHaveBeenCalled()
    expect(capture.isCapturing).toBe(false)
    expect(onError).not.toHaveBeenCalled()
  })

  it('stops the exact pending stream immediately when End lands during context resume', async () => {
    let finishResume!: () => void
    const pendingResume = new Promise<undefined>((resolve) => { finishResume = () => resolve(undefined) })
    const audioContext = new FakeAudioContext()
    audioContext.state = 'suspended'
    audioContext.resume.mockImplementationOnce(() => pendingResume)
    function SuspendedAudioContext() { return audioContext }
    vi.stubGlobal('AudioContext', SuspendedAudioContext)
    const pending = stream()
    const getUserMedia = vi.fn(async () => pending.value)
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
    const capture = new VoiceCapture()
    const controller = new AbortController()
    const starting = capture.start({ onAudio: vi.fn(), onError: vi.fn() }, undefined, controller.signal)
    await vi.waitFor(() => expect(audioContext.resume).toHaveBeenCalled())

    controller.abort()

    expect(pending.track.stop).toHaveBeenCalledTimes(1)
    finishResume()
    await expect(starting).resolves.toBe(false)
    expect(capture.isCapturing).toBe(false)
  })

  it('cannot let an old acquisition stop or replace a newer capture', async () => {
    let resolveOld!: (value: MediaStream) => void
    const oldMedia = new Promise<MediaStream>((resolve) => { resolveOld = resolve })
    const replacement = stream()
    const getUserMedia = vi.fn()
      .mockImplementationOnce(() => oldMedia)
      .mockResolvedValueOnce(replacement.value)
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
    const capture = new VoiceCapture()
    const oldStart = capture.start({ onAudio: vi.fn(), onError: vi.fn() })
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1))

    capture.stop()
    await expect(capture.start({ onAudio: vi.fn(), onError: vi.fn() })).resolves.toBe(true)
    const stale = stream()
    resolveOld(stale.value)
    await expect(oldStart).resolves.toBe(false)

    expect(stale.track.stop).toHaveBeenCalled()
    expect(replacement.track.stop).not.toHaveBeenCalled()
    expect(capture.isCapturing).toBe(true)
    capture.stop()
  })
})
