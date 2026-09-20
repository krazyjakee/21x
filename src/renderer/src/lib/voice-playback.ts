/**
 * Playback of spoken answers (design §5.7).
 *
 * The renderer plays audio and nothing else. It never produces speech, never
 * decides what may be spoken, and keeps no recording.
 *
 * Sentences arrive one at a time while the rest are still being produced, so
 * each one is scheduled to start exactly where the previous one ends. That is
 * what makes an answer sound continuous even though the model is barely faster
 * than speech.
 *
 * There is one playback object for the whole window, so two answers can never
 * talk over each other. The AudioContext is created once and reused: Chromium
 * allows only a few per document, and `close()` frees the slot asynchronously.
 */

export interface VoicePlaybackHandlers {
  /** 0..1 loudness, for the audio state indicator. */
  onLevel?: (level: number) => void
  /** Called when every queued sentence has finished playing. */
  onDrained?: () => void
}

/** A gap this small is inaudible and protects against a late first chunk. */
const SCHEDULING_LEAD_SECONDS = 0.06

export class VoicePlayback {
  private context: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private sources = new Set<AudioBufferSourceNode>()
  private speechId: string | null = null
  private speechGeneration: number | null = null
  /** Highest main-process lease observed, retained after playback stops. */
  private latestSpeechGeneration = 0
  private nextStartTime = 0
  private pending = 0
  private levelTimer: number | null = null
  private handlers: VoicePlaybackHandlers = {}
  private activityRevision = 0
  private readonly activityListeners = new Set<() => void>()
  private levelData: Uint8Array<ArrayBuffer> | null = null

  /** A low-frequency lifecycle signal for truthful activity indicators. It is
   * emitted only when a passage opens/closes or queued audio starts/drains —
   * never for analyser frames. */
  subscribeActivity = (listener: () => void): (() => void) => {
    this.activityListeners.add(listener)
    return () => this.activityListeners.delete(listener)
  }

  get activitySnapshot(): number {
    return this.activityRevision
  }

  private notifyActivity(): void {
    this.activityRevision += 1
    for (const listener of this.activityListeners) listener()
  }

  get isPlaying(): boolean {
    return this.speechId !== null
  }

  get currentSpeechId(): string | null {
    return this.speechId
  }

  get currentSpeechGeneration(): number | null {
    return this.speechGeneration
  }

  /**
   * True while sentences are queued or sounding.
   *
   * A passage can open and produce nothing — the worker may fail before its
   * first sentence. Without this the caller could wait for an end that never
   * comes.
   */
  get hasQueuedAudio(): boolean {
    return this.pending > 0
  }

  /**
   * Opens a new passage. Any passage still playing is dropped.
   *
   * Opening the passage that is already open does nothing. Main announces the
   * start on every push, not once per passage, and each of those announcements
   * used to drop what was queued — so every new sentence cut off the sentence
   * before it whenever the voice produced faster than it played.
   */
  start(
    speechId: string,
    handlers: VoicePlaybackHandlers = {},
    speechGeneration?: number
  ): boolean {
    if (speechGeneration !== undefined) {
      if (speechGeneration < this.latestSpeechGeneration) return false
      if (speechGeneration === this.latestSpeechGeneration) {
        if (this.speechGeneration !== speechGeneration || this.speechId !== speechId) return false
      }
    }
    if (
      this.speechId === speechId &&
      (speechGeneration === undefined || this.speechGeneration === speechGeneration)
    ) return true
    this.stop()
    if (speechGeneration !== undefined) this.latestSpeechGeneration = speechGeneration
    this.handlers = handlers
    this.speechId = speechId
    this.speechGeneration = speechGeneration ?? null
    this.pending = 0
    this.nextStartTime = 0
    this.notifyActivity()
    return true
  }

  /**
   * Queues one sentence.
   *
   * A chunk from an older passage is dropped, so a cancelled answer cannot be
   * heard after the user has moved on.
   */
  play(
    speechId: string,
    pcm: Uint8Array,
    sampleRate: number,
    speechGeneration?: number
  ): void {
    if (speechId !== this.speechId) return
    if (speechGeneration !== undefined && speechGeneration !== this.speechGeneration) return
    if (!pcm || pcm.length < 2 || sampleRate <= 0) return

    const context = this.ensureContext()
    if (!context) return
    if (context.state === 'suspended') void context.resume()

    const buffer = toAudioBuffer(context, pcm, sampleRate)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(this.analyser ?? context.destination)

    const startAt = Math.max(context.currentTime + SCHEDULING_LEAD_SECONDS, this.nextStartTime)
    this.nextStartTime = startAt + buffer.duration
    const queueWasEmpty = this.pending === 0
    this.pending += 1
    if (queueWasEmpty) this.notifyActivity()
    source.onended = () => {
      this.sources.delete(source)
      this.pending -= 1
      if (this.pending <= 0 && this.speechId === speechId) {
        this.notifyActivity()
        this.handlers.onDrained?.()
      }
    }
    this.sources.add(source)
    source.start(startAt)
    this.startLevelReporting()
  }

  /** Stops at once and forgets everything queued. This is barge-in. */
  stop(speechGeneration?: number): boolean {
    if (speechGeneration !== undefined && speechGeneration !== this.speechGeneration) return false
    const changed = this.speechId !== null || this.pending > 0
    for (const source of this.sources) {
      try {
        source.onended = null
        source.stop()
      } catch {
        /* the sentence had already finished */
      }
    }
    this.sources.clear()
    this.speechId = null
    this.speechGeneration = null
    this.pending = 0
    this.nextStartTime = 0
    this.stopLevelReporting()
    this.handlers.onLevel?.(0)
    if (changed) this.notifyActivity()
    return true
  }

  /** Releases the audio graph. Used when spoken answers are switched off. */
  async release(): Promise<void> {
    this.stop()
    const context = this.context
    this.analyser?.disconnect()
    this.analyser = null
    this.context = null
    await context?.close().catch(() => undefined)
  }

  /** Restores the singleton lease counter between isolated tests. */
  __resetForTests(): void {
    this.stop()
    this.latestSpeechGeneration = 0
  }

  // ── Internals ─────────────────────────────────────────────

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context
    if (typeof AudioContext === 'undefined') return null
    // No sample rate is requested: the samples are resampled by the buffer, and
    // forcing a rate here would fight the output device.
    const context = new AudioContext()
    const analyser = context.createAnalyser()
    analyser.fftSize = 256
    analyser.connect(context.destination)
    this.context = context
    this.analyser = analyser
    return context
  }

  /**
   * The loudness of what is sounding now, 0..1, read on demand (#84). 0 when
   * nothing is queued. No timer and no store write: a speaking ring polls it
   * per animation frame, only while it is visible.
   */
  get outputLevel(): number {
    const analyser = this.analyser
    if (!analyser || !this.speechId || this.pending <= 0) return 0
    if (!this.levelData || this.levelData.length !== analyser.frequencyBinCount) {
      this.levelData = new Uint8Array(analyser.frequencyBinCount)
    }
    return readLevel(analyser, this.levelData)
  }

  private startLevelReporting(): void {
    if (this.levelTimer !== null || !this.handlers.onLevel || !this.analyser) return
    const data = new Uint8Array(this.analyser.frequencyBinCount)
    const tick = (): void => {
      const analyser = this.analyser
      if (!analyser || !this.speechId) return
      this.handlers.onLevel?.(readLevel(analyser, data))
      this.levelTimer = window.setTimeout(tick, 60)
    }
    tick()
  }

  private stopLevelReporting(): void {
    if (this.levelTimer !== null) window.clearTimeout(this.levelTimer)
    this.levelTimer = null
  }
}

/** RMS loudness of the analyser's current window, scaled to 0..1. */
function readLevel(analyser: AnalyserNode, data: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(data)
  let sum = 0
  for (let i = 0; i < data.length; i++) {
    const centred = (data[i] - 128) / 128
    sum += centred * centred
  }
  return Math.min(1, Math.sqrt(sum / data.length) * 2)
}

/** Signed 16-bit little-endian PCM to one mono audio buffer. */
export function toAudioBuffer(context: BaseAudioContext, pcm: Uint8Array, sampleRate: number): AudioBuffer {
  const samples = Math.floor(pcm.length / 2)
  const buffer = context.createBuffer(1, samples, sampleRate)
  const channel = buffer.getChannelData(0)
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  for (let i = 0; i < samples; i++) {
    channel[i] = view.getInt16(i * 2, true) / 32768
  }
  return buffer
}

/** The single speaker for this window. */
export const voicePlayback = new VoicePlayback()
