/**
 * The ElevenLabs speech engine (#64).
 *
 * A hosted voice the user brings their own key for. It sits behind the same
 * contract as the worker that runs the system and downloaded voices: a passage
 * is opened with `speak`, sentences are added with `append`, closed with
 * `finish`, dropped with `cancel`, and audio comes back as `chunk` events that
 * the speech service forwards to the renderer's playback queue unchanged.
 *
 * Three rules hold everywhere in this file:
 *
 * - The key is read from the encrypted settings row at the moment it is needed
 *   and goes into one request header. It is never kept on an object that
 *   crosses IPC, never put in a message payload, and never logged.
 * - Every failure is mapped to a kind the settings page can act on — a new
 *   key, more credits, a slower pace, another model, or the network — and the
 *   written reply is never held up by any of them.
 * - Closing the passage closes the connection, and a message that arrives on
 *   a closed passage is dropped, so a cancelled reply cannot be heard later.
 *
 * Everything that touches the network is behind `ElevenLabsTransport`, so the
 * tests drive it with a fake socket and a fake fetch and no request leaves the
 * machine.
 */

import { EventEmitter } from 'events'
import WebSocket from 'ws'
import {
  VOICE_TTS_ELEVENLABS_DEFAULT_MODEL,
  type VoiceTtsElevenLabsError,
  type VoiceTtsElevenLabsErrorKind,
  type VoiceTtsElevenLabsModel,
  type VoiceTtsElevenLabsState,
  type VoiceTtsVoice,
} from '../../shared/voice-tts'
import type { VoiceTtsChunk } from './voice-tts-worker-client'

export const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io'
export const ELEVENLABS_WS_BASE = 'wss://api.elevenlabs.io'

/**
 * Raw 16-bit PCM at 24 kHz. It is the same shape the local voices produce, so
 * the renderer's playback queue needs nothing new, and it is available on
 * every ElevenLabs tier (44.1 kHz PCM is not).
 */
export const ELEVENLABS_OUTPUT_FORMAT = 'pcm_24000'
export const ELEVENLABS_SAMPLE_RATE = 24000

/**
 * Models that can produce speech but that the text-to-speech WebSocket
 * (`stream-input`) does not accept. The v3 family is HTTP only at the time of
 * writing, so it is not offered: choosing it would fail on the first sentence.
 */
export const ELEVENLABS_WEBSOCKET_INCOMPATIBLE_MODELS: readonly string[] = ['eleven_v3']

/** ElevenLabs' `voice_settings.speed` range. Anything outside is clamped. */
export const ELEVENLABS_MIN_SPEED = 0.7
export const ELEVENLABS_MAX_SPEED = 1.2

/** The longest the socket is left quiet between sentences. The API maximum. */
export const ELEVENLABS_INACTIVITY_TIMEOUT_S = 180
/** A single space keeps an open passage alive between slow sentences. */
export const ELEVENLABS_KEEPALIVE_MS = 15_000
/** How long a request to the REST API may take. */
export const ELEVENLABS_REQUEST_TIMEOUT_MS = 15_000
/** How long a socket may take to open before the passage fails as a network error. */
export const ELEVENLABS_CONNECT_TIMEOUT_MS = 15_000
/** After a failed listing, the next automatic attempt waits this long. */
export const ELEVENLABS_RETRY_AFTER_MS = 30_000

const VOICES_PAGE_SIZE = 100
/** A bound on the pagination loop, so a broken `next_page_token` cannot spin. */
const VOICES_MAX_PAGES = 50

// ── Errors ────────────────────────────────────────────────────

export class ElevenLabsError extends Error {
  constructor(
    readonly kind: VoiceTtsElevenLabsErrorKind,
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'ElevenLabsError'
  }

  toState(): VoiceTtsElevenLabsError {
    return { kind: this.kind, message: this.message }
  }
}

const MESSAGES: Record<VoiceTtsElevenLabsErrorKind, string> = {
  auth: 'ElevenLabs did not accept the API key. Check the key in Settings → Voice.',
  quota: 'The ElevenLabs account has no characters left this period. Add credits or wait for the period to reset.',
  rate_limit: 'ElevenLabs is rate-limiting this account. Wait a moment and try again.',
  unsupported_model: 'ElevenLabs rejected the selected model for streaming. Choose another model in Settings → Voice.',
  network: 'ElevenLabs could not be reached. Check the network connection.',
  unknown: 'ElevenLabs returned an error.',
}

/** Words in an ElevenLabs error body that name a kind. */
function kindFromText(text: string): VoiceTtsElevenLabsErrorKind | null {
  const t = text.toLowerCase()
  if (/quota|credit|character limit|characters? remaining|insufficient|payment required|exceeded/.test(t)) return 'quota'
  if (/api key|api_key|unauthori[sz]ed|authenticat|invalid_api|xi-api-key|permission/.test(t)) return 'auth'
  if (/too many|rate limit|concurren/.test(t)) return 'rate_limit'
  if (/model/.test(t)) return 'unsupported_model'
  return null
}

/** Reads the message out of an ElevenLabs error body, whatever its shape. */
function detailOf(body: unknown): string {
  if (!body) return ''
  if (typeof body === 'string') return body
  const record = body as { detail?: unknown; message?: unknown; error?: unknown }
  const detail = record.detail
  if (typeof detail === 'string') return detail
  if (detail && typeof detail === 'object') {
    const inner = detail as { message?: unknown; status?: unknown }
    return [inner.status, inner.message].filter((v) => typeof v === 'string').join(': ')
  }
  if (typeof record.message === 'string') return record.message
  if (typeof record.error === 'string') return record.error
  return ''
}

/** One HTTP or socket status plus whatever body came with it, as a kinded error. */
export function mapElevenLabsFailure(status: number | undefined, body?: unknown): ElevenLabsError {
  const detail = detailOf(body)
  const named = kindFromText(detail)
  let kind: VoiceTtsElevenLabsErrorKind
  if (status === 401 || status === 403) kind = 'auth'
  else if (status === 402) kind = 'quota'
  else if (status === 429) kind = 'rate_limit'
  else if (named) kind = named
  else if (status === 400 || status === 404 || status === 422) kind = 'unsupported_model'
  else if (status !== undefined && status >= 500) kind = 'network'
  else kind = 'unknown'
  const message = detail && kind === 'unknown' ? `ElevenLabs returned an error: ${detail}` : MESSAGES[kind]
  return new ElevenLabsError(kind, message, status)
}

/** Anything thrown on the way to or from ElevenLabs, as a kinded error. */
export function toElevenLabsError(err: unknown): ElevenLabsError {
  if (err instanceof ElevenLabsError) return err
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return new ElevenLabsError('network', 'ElevenLabs did not answer in time. Check the network connection.')
  }
  return new ElevenLabsError('network', MESSAGES.network)
}

// ── Transport ─────────────────────────────────────────────────

/** The part of a WebSocket this engine uses. `ws` satisfies it; a test fake does too. */
export interface ElevenLabsSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'open', listener: () => void): this
  on(event: 'message', listener: (data: unknown) => void): this
  on(event: 'error', listener: (err: Error) => void): this
  on(event: 'close', listener: (code: number, reason: unknown) => void): this
  on(event: 'unexpected-response', listener: (request: unknown, response: { statusCode?: number }) => void): this
}

export interface ElevenLabsTransport {
  fetch: (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
    ok: boolean
    status: number
    json: () => Promise<unknown>
    text: () => Promise<string>
  }>
  /** Opens a socket with the key in a header, never in the URL or a message. */
  createSocket: (url: string, headers: Record<string, string>) => ElevenLabsSocket
}

export function defaultElevenLabsTransport(): ElevenLabsTransport {
  return {
    fetch: (url, init) => fetch(url, init),
    createSocket: (url, headers) => new WebSocket(url, { headers }) as unknown as ElevenLabsSocket,
  }
}

// ── The REST calls ────────────────────────────────────────────

export interface ElevenLabsVoiceRecord {
  voice_id: string
  name: string
  category?: string
  labels?: Record<string, string | undefined>
  verified_languages?: Array<{ language?: string }>
}

interface ElevenLabsModelRecord {
  model_id: string
  name?: string
  description?: string
  can_do_text_to_speech?: boolean
  languages?: Array<{ language_id?: string; name?: string }>
}

/** Turns one account voice into the shape the voice picker draws. */
export function toElevenLabsVoice(record: ElevenLabsVoiceRecord): VoiceTtsVoice {
  const labels = record.labels ?? {}
  const description = [labels.gender, labels.accent, labels.age, labels.use_case ?? labels.description, record.category]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .join(', ')
  return {
    id: `elevenlabs:${record.voice_id}`,
    label: record.name || record.voice_id,
    engine: 'elevenlabs',
    speakerId: 0,
    modelId: '',
    language: labels.language || record.verified_languages?.[0]?.language || 'en',
    description,
  }
}

/** The ElevenLabs voice id inside a `elevenlabs:<id>` voice id. */
export function elevenLabsVoiceIdOf(voiceId: string): string {
  return voiceId.startsWith('elevenlabs:') ? voiceId.slice('elevenlabs:'.length) : voiceId
}

/** Only models the streaming endpoint accepts are offered. */
export function streamableModels(records: ElevenLabsModelRecord[]): VoiceTtsElevenLabsModel[] {
  return records
    .filter((m) => m.can_do_text_to_speech === true && !ELEVENLABS_WEBSOCKET_INCOMPATIBLE_MODELS.includes(m.model_id))
    .map((m) => ({
      id: m.model_id,
      name: m.name || m.model_id,
      description: m.description ?? '',
      languages: (m.languages ?? []).map((l) => l.language_id).filter((l): l is string => Boolean(l)),
    }))
}

export class ElevenLabsApi {
  constructor(
    private readonly getKey: () => string,
    private readonly transport: ElevenLabsTransport = defaultElevenLabsTransport()
  ) {}

  private async get<T>(path: string): Promise<T> {
    const key = this.getKey()
    if (!key) throw new ElevenLabsError('auth', 'No ElevenLabs API key is saved.')
    let response: Awaited<ReturnType<ElevenLabsTransport['fetch']>>
    try {
      response = await this.transport.fetch(`${ELEVENLABS_API_BASE}${path}`, {
        headers: { 'xi-api-key': key, accept: 'application/json' },
        signal: AbortSignal.timeout(ELEVENLABS_REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      throw toElevenLabsError(err)
    }
    if (!response.ok) {
      let body: unknown = ''
      try {
        body = await response.json()
      } catch {
        try {
          body = await response.text()
        } catch {
          body = ''
        }
      }
      throw mapElevenLabsFailure(response.status, body)
    }
    return (await response.json()) as T
  }

  /** Proves the key and reads the character allowance. */
  async subscription(): Promise<{ used: number; limit: number }> {
    const body = await this.get<{ character_count?: number; character_limit?: number }>('/v1/user/subscription')
    return { used: Number(body.character_count ?? 0), limit: Number(body.character_limit ?? 0) }
  }

  /** Every voice on the account, across every page of `GET /v2/voices`. */
  async listVoices(): Promise<VoiceTtsVoice[]> {
    const voices: VoiceTtsVoice[] = []
    let token: string | undefined
    for (let page = 0; page < VOICES_MAX_PAGES; page++) {
      const query = new URLSearchParams({ page_size: String(VOICES_PAGE_SIZE) })
      if (token) query.set('next_page_token', token)
      const body = await this.get<{ voices?: ElevenLabsVoiceRecord[]; has_more?: boolean; next_page_token?: string | null }>(
        `/v2/voices?${query.toString()}`
      )
      for (const record of body.voices ?? []) {
        if (record?.voice_id) voices.push(toElevenLabsVoice(record))
      }
      if (!body.has_more || !body.next_page_token) break
      token = body.next_page_token
    }
    return voices
  }

  /** The models the streaming endpoint can use. */
  async listModels(): Promise<VoiceTtsElevenLabsModel[]> {
    const body = await this.get<ElevenLabsModelRecord[] | { models?: ElevenLabsModelRecord[] }>('/v1/models')
    const records = Array.isArray(body) ? body : (body.models ?? [])
    return streamableModels(records)
  }
}

// ── The streaming client ──────────────────────────────────────

export interface ElevenLabsSpeakRequest {
  speechId: string
  sentences: string[]
  /** The ElevenLabs voice id, without the `elevenlabs:` prefix. */
  voiceId: string
  modelId: string
  speed: number
  /** Leaves the passage open so sentences can be added while it is read. */
  open?: boolean
}

interface ActivePassage {
  speechId: string
  request: ElevenLabsSpeakRequest
  socket: ElevenLabsSocket | null
  /** True once the server accepted the connection and the settings were sent. */
  ready: boolean
  /** Sentences waiting for the socket to open. */
  pending: string[]
  /** Sentences already sent, in order, for the caption on each chunk. */
  sent: string[]
  captionIndex: number
  /** `finish` was called: the end-of-stream marker goes out after the queue. */
  finishRequested: boolean
  /** The end-of-stream marker has been sent. */
  eosSent: boolean
  /** True once done, cancelled or failed. Late socket events are dropped. */
  settled: boolean
  chunks: number
  keepalive: NodeJS.Timeout | null
  connectTimer: NodeJS.Timeout | null
}

/**
 * Speaks passages over the text-to-speech WebSocket.
 *
 * One passage at a time. A new `speak` cancels the previous passage, as the
 * worker does, because two voices at once is worse than losing the first one.
 */
export class ElevenLabsTtsClient extends EventEmitter {
  private active: ActivePassage | null = null

  constructor(
    private readonly getKey: () => string,
    private readonly transport: ElevenLabsTransport = defaultElevenLabsTransport()
  ) {
    super()
  }

  get speaking(): boolean {
    return this.active !== null
  }

  speak(request: ElevenLabsSpeakRequest): void {
    this.cancel()
    const key = this.getKey()
    if (!key) {
      this.emit('error', 'No ElevenLabs API key is saved.', request.speechId, 'auth' satisfies VoiceTtsElevenLabsErrorKind)
      return
    }
    if (!request.voiceId) {
      this.emit('error', 'No ElevenLabs voice is selected.', request.speechId, 'unknown' satisfies VoiceTtsElevenLabsErrorKind)
      return
    }

    const passage: ActivePassage = {
      speechId: request.speechId,
      request,
      socket: null,
      ready: false,
      pending: [...request.sentences],
      sent: [],
      captionIndex: 0,
      finishRequested: !request.open,
      eosSent: false,
      settled: false,
      chunks: 0,
      keepalive: null,
      connectTimer: null,
    }
    this.active = passage

    const query = new URLSearchParams({
      model_id: request.modelId || VOICE_TTS_ELEVENLABS_DEFAULT_MODEL,
      output_format: ELEVENLABS_OUTPUT_FORMAT,
      inactivity_timeout: String(ELEVENLABS_INACTIVITY_TIMEOUT_S),
      // Whole sentences are sent, so the server's own buffering only adds
      // latency. Without this a short reply sat in the buffer until the end.
      auto_mode: 'true',
    })
    const url = `${ELEVENLABS_WS_BASE}/v1/text-to-speech/${encodeURIComponent(request.voiceId)}/stream-input?${query.toString()}`

    let socket: ElevenLabsSocket
    try {
      // The key travels in a header only. It is not in the URL, so it cannot
      // reach a log line, and not in a message, so it cannot reach a transcript.
      socket = this.transport.createSocket(url, { 'xi-api-key': key })
    } catch {
      this.fail(passage, new ElevenLabsError('network', MESSAGES.network))
      return
    }
    passage.socket = socket
    passage.connectTimer = setTimeout(() => {
      if (this.active === passage && !passage.ready) {
        this.fail(passage, new ElevenLabsError('network', 'ElevenLabs did not answer in time. Check the network connection.'))
      }
    }, ELEVENLABS_CONNECT_TIMEOUT_MS)
    passage.connectTimer.unref?.()

    socket.on('open', () => {
      if (this.active !== passage || passage.settled) return
      this.clearConnectTimer(passage)
      passage.ready = true
      this.sendJson(passage, {
        text: ' ',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: clampElevenLabsSpeed(request.speed) },
      })
      this.flush(passage)
    })
    socket.on('unexpected-response', (_request, response) => {
      if (this.active !== passage || passage.settled) return
      this.fail(passage, mapElevenLabsFailure(response?.statusCode))
    })
    socket.on('message', (data) => {
      if (this.active !== passage || passage.settled) return
      this.onMessage(passage, data)
    })
    socket.on('error', (err) => {
      if (this.active !== passage || passage.settled) return
      const status = statusFromSocketError(err)
      this.fail(passage, status ? mapElevenLabsFailure(status) : new ElevenLabsError('network', MESSAGES.network))
    })
    socket.on('close', (code, reason) => {
      if (this.active !== passage || passage.settled) return
      // A clean close after the end-of-stream marker is the end of the passage
      // even when the server did not send `isFinal` first.
      if (passage.eosSent && (code === 1000 || code === 1005)) {
        this.done(passage, false)
        return
      }
      const text = typeof reason === 'string' ? reason : reason ? String(reason) : ''
      const named = kindFromText(text)
      if (named) {
        this.fail(passage, new ElevenLabsError(named, MESSAGES[named]))
        return
      }
      this.fail(passage, new ElevenLabsError('network', 'The ElevenLabs connection dropped before the reply was finished.'))
    })
  }

  /** Adds sentences to an open passage. */
  append(speechId: string, sentences: string[]): void {
    const passage = this.active
    if (!passage || passage.speechId !== speechId || passage.settled || passage.eosSent) return
    const fresh = sentences.map((s) => s.trim()).filter(Boolean)
    if (fresh.length === 0) return
    passage.pending.push(...fresh)
    if (passage.ready) this.flush(passage)
  }

  /** No more sentences are coming. What is buffered is generated and the passage ends. */
  finish(speechId: string): void {
    const passage = this.active
    if (!passage || passage.speechId !== speechId || passage.settled) return
    passage.finishRequested = true
    if (passage.ready) this.flush(passage)
  }

  /** Drops the passage and closes the connection. Late audio is discarded. */
  cancel(speechId?: string): void {
    const passage = this.active
    if (!passage) return
    if (speechId && passage.speechId !== speechId) return
    this.done(passage, true)
  }

  /** Shutdown. Nothing is spoken and nothing is reported. */
  stop(): void {
    const passage = this.active
    if (!passage) return
    this.active = null
    passage.settled = true
    this.teardown(passage)
  }

  // ── Internals ─────────────────────────────────────────────

  private flush(passage: ActivePassage): void {
    while (passage.pending.length > 0) {
      const sentence = passage.pending.shift() as string
      // The text must end with a space: it is how the server knows the piece
      // is complete.
      this.sendJson(passage, { text: `${sentence} ` })
      passage.sent.push(sentence)
    }
    if (passage.finishRequested && !passage.eosSent) {
      passage.eosSent = true
      this.stopKeepalive(passage)
      // The end-of-stream marker. The server flushes whatever it still holds,
      // sends `isFinal`, and closes.
      this.sendJson(passage, { text: '' })
      return
    }
    this.armKeepalive(passage)
  }

  private sendJson(passage: ActivePassage, payload: Record<string, unknown>): void {
    try {
      passage.socket?.send(JSON.stringify(payload))
    } catch {
      this.fail(passage, new ElevenLabsError('network', 'The ElevenLabs connection dropped before the reply was finished.'))
    }
  }

  private onMessage(passage: ActivePassage, data: unknown): void {
    let message: {
      audio?: string | null
      isFinal?: boolean | null
      alignment?: { chars?: string[] } | null
      normalizedAlignment?: { chars?: string[] } | null
      error?: string
      message?: string
      code?: number
    }
    try {
      message = JSON.parse(typeof data === 'string' ? data : String(data))
    } catch {
      return
    }
    if (message.error || (message.code && message.code >= 1000 && !message.audio)) {
      const detail = [message.error, message.message].filter(Boolean).join(': ')
      const kind = kindFromText(detail) ?? 'unknown'
      this.fail(passage, new ElevenLabsError(kind, kind === 'unknown' && detail ? `ElevenLabs returned an error: ${detail}` : MESSAGES[kind]))
      return
    }
    if (typeof message.audio === 'string' && message.audio.length > 0) {
      const pcm = Buffer.from(message.audio, 'base64')
      if (pcm.length > 0) {
        const aligned = message.alignment?.chars ?? message.normalizedAlignment?.chars
        const text = aligned && aligned.length > 0 ? aligned.join('').trim() : passage.sent[passage.captionIndex] ?? ''
        if (!aligned) passage.captionIndex = Math.min(passage.captionIndex + 1, passage.sent.length)
        this.emit('chunk', {
          speechId: passage.speechId,
          index: passage.chunks,
          pcm,
          sampleRate: ELEVENLABS_SAMPLE_RATE,
          text,
        } satisfies VoiceTtsChunk)
        passage.chunks += 1
      }
    }
    if (message.isFinal) this.done(passage, false)
  }

  private done(passage: ActivePassage, cancelled: boolean): void {
    if (passage.settled) return
    passage.settled = true
    if (this.active === passage) this.active = null
    this.teardown(passage)
    this.emit('done', passage.speechId, cancelled, passage.chunks)
  }

  private fail(passage: ActivePassage, error: ElevenLabsError): void {
    if (passage.settled) return
    passage.settled = true
    if (this.active === passage) this.active = null
    this.teardown(passage)
    // The kind only: the message never carries the key, and the log never
    // carries the text of the passage.
    console.warn(`[voice] ElevenLabs speech failed (${error.kind})`)
    this.emit('error', error.message, passage.speechId, error.kind)
  }

  private teardown(passage: ActivePassage): void {
    this.clearConnectTimer(passage)
    this.stopKeepalive(passage)
    const socket = passage.socket
    passage.socket = null
    if (!socket) return
    try {
      socket.close(1000, 'done')
    } catch {
      /* already closed */
    }
  }

  private armKeepalive(passage: ActivePassage): void {
    this.stopKeepalive(passage)
    if (passage.eosSent) return
    passage.keepalive = setTimeout(() => {
      if (this.active !== passage || passage.settled || passage.eosSent) return
      // A lone space is the documented keep-alive. It produces no audio.
      this.sendJson(passage, { text: ' ' })
      this.armKeepalive(passage)
    }, ELEVENLABS_KEEPALIVE_MS)
    passage.keepalive.unref?.()
  }

  private stopKeepalive(passage: ActivePassage): void {
    if (passage.keepalive) clearTimeout(passage.keepalive)
    passage.keepalive = null
  }

  private clearConnectTimer(passage: ActivePassage): void {
    if (passage.connectTimer) clearTimeout(passage.connectTimer)
    passage.connectTimer = null
  }
}

/** `ws` reports a refused handshake as "Unexpected server response: 401". */
function statusFromSocketError(err: Error): number | undefined {
  const match = /response:?\s*(\d{3})/i.exec(err?.message ?? '')
  return match ? Number(match[1]) : undefined
}

export function clampElevenLabsSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1
  return Math.min(ELEVENLABS_MAX_SPEED, Math.max(ELEVENLABS_MIN_SPEED, speed))
}

// ── The engine: account state plus the streaming client ──────

export interface ElevenLabsEngineOptions {
  /** Reads the plaintext key from the encrypted settings row. Main only. */
  getKey: () => string
  transport?: ElevenLabsTransport
  now?: () => number
}

/**
 * What the speech service holds for ElevenLabs: the account's voices and
 * models, the last error, and the client that speaks.
 */
export class ElevenLabsEngine {
  readonly api: ElevenLabsApi
  readonly tts: ElevenLabsTtsClient
  voices: VoiceTtsVoice[] = []
  models: VoiceTtsElevenLabsModel[] = []
  usage: { used: number; limit: number } | null = null
  error: VoiceTtsElevenLabsError | null = null
  /** True once voices and models were listed with the current key. */
  loaded = false
  private lastAttemptAt = 0
  private readonly now: () => number

  constructor(private readonly options: ElevenLabsEngineOptions) {
    const transport = options.transport ?? defaultElevenLabsTransport()
    this.api = new ElevenLabsApi(options.getKey, transport)
    this.tts = new ElevenLabsTtsClient(options.getKey, transport)
    this.now = options.now ?? Date.now
  }

  hasKey(): boolean {
    return Boolean(this.options.getKey())
  }

  /** Forgets what was listed. Called when the key changes. */
  reset(): void {
    this.voices = []
    this.models = []
    this.usage = null
    this.error = null
    this.loaded = false
    this.lastAttemptAt = 0
  }

  /** Validates the key and lists voices and models. Never throws. */
  async refresh(): Promise<void> {
    this.lastAttemptAt = this.now()
    if (!this.hasKey()) {
      this.reset()
      return
    }
    try {
      const [usage, voices, models] = await Promise.all([this.api.subscription(), this.api.listVoices(), this.api.listModels()])
      this.usage = usage
      this.voices = voices
      this.models = models
      this.error = null
      this.loaded = true
    } catch (err) {
      const error = toElevenLabsError(err)
      this.error = error.toState()
      this.loaded = false
      console.warn(`[voice] ElevenLabs listing failed (${error.kind})`)
    }
  }

  /**
   * Lists once, and after a failure waits before trying again by itself, so a
   * bad key does not send a request on every attempt to speak.
   */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    if (this.error && this.now() - this.lastAttemptAt < ELEVENLABS_RETRY_AFTER_MS) return
    await this.refresh()
  }

  /** Records a failure from the streaming client so settings can show it. */
  noteError(kind: VoiceTtsElevenLabsErrorKind, message: string): void {
    this.error = { kind, message }
  }

  /** True when the model is one the streaming endpoint accepts, as far as is known. */
  supportsModel(modelId: string): boolean {
    if (ELEVENLABS_WEBSOCKET_INCOMPATIBLE_MODELS.includes(modelId)) return false
    if (this.models.length === 0) return true
    return this.models.some((m) => m.id === modelId)
  }

  state(input: { disclosureAccepted: boolean; modelId: string }): VoiceTtsElevenLabsState {
    return {
      keySet: this.hasKey(),
      disclosureAccepted: input.disclosureAccepted,
      modelId: input.modelId,
      models: this.models,
      voices: this.voices,
      error: this.error,
      usage: this.usage,
    }
  }

  shutdown(): void {
    this.tts.stop()
  }
}
