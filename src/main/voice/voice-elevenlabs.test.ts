import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import {
  ElevenLabsApi,
  ElevenLabsEngine,
  ElevenLabsTtsClient,
  ELEVENLABS_SAMPLE_RATE,
  mapElevenLabsFailure,
  streamableModels,
  type ElevenLabsSocket,
  type ElevenLabsTransport,
} from './voice-elevenlabs'
import { VoiceSpeechService } from './voice-speech-service'
import type { VoiceTtsWorkerClient } from './voice-tts-worker-client'
import type { VoiceTtsModelManager } from './voice-tts-model-manager'
import { VOICE_TTS_EVENTS, VOICE_TTS_SETTING_KEYS } from '../../shared/voice-tts'

/**
 * The ElevenLabs engine (#64), driven entirely by a fake socket and a fake
 * fetch: no request leaves the machine.
 */

const KEY = 'sk_test_SECRET_do_not_leak_123'

class FakeSocket extends EventEmitter {
  sent: Array<Record<string, unknown>> = []
  closed = false
  constructor(readonly url: string, readonly headers: Record<string, string>) {
    super()
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(): void {
    this.closed = true
  }
  /** Server -> client. */
  receive(message: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(message)))
  }
}

interface Route {
  status?: number
  body: unknown
}

function makeTransport(routes: Record<string, Route | Route[]> = {}) {
  const sockets: FakeSocket[] = []
  const requests: Array<{ url: string; headers: Record<string, string> }> = []
  const counters = new Map<string, number>()
  const transport: ElevenLabsTransport = {
    fetch: async (url, init) => {
      requests.push({ url, headers: init.headers })
      const path = new URL(url).pathname
      const entry = routes[path]
      if (!entry) throw new TypeError('fetch failed')
      const n = counters.get(path) ?? 0
      counters.set(path, n + 1)
      const route = Array.isArray(entry) ? entry[Math.min(n, entry.length - 1)] : entry
      const status = route.status ?? 200
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => route.body,
        text: async () => JSON.stringify(route.body),
      }
    },
    createSocket: (url, headers) => {
      const socket = new FakeSocket(url, headers)
      sockets.push(socket)
      return socket as unknown as ElevenLabsSocket
    },
  }
  return { transport, sockets, requests }
}

const pcm = (bytes: number[]): string => Buffer.from(bytes).toString('base64')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('listing voices and models', () => {
  it('follows every page of /v2/voices', async () => {
    const { transport, requests } = makeTransport({
      '/v2/voices': [
        { body: { voices: [{ voice_id: 'v1', name: 'Rachel', labels: { gender: 'female', accent: 'american' } }], has_more: true, next_page_token: 'p2' } },
        { body: { voices: [{ voice_id: 'v2', name: 'Adam' }], has_more: false, next_page_token: null } },
      ],
    })
    const voices = await new ElevenLabsApi(() => KEY, transport).listVoices()
    expect(voices.map((v) => v.id)).toEqual(['elevenlabs:v1', 'elevenlabs:v2'])
    expect(voices[0]).toMatchObject({ engine: 'elevenlabs', label: 'Rachel', description: 'female, american' })
    expect(requests[1].url).toContain('next_page_token=p2')
    // The key is a header, never part of a URL.
    for (const r of requests) {
      expect(r.headers['xi-api-key']).toBe(KEY)
      expect(r.url).not.toContain(KEY)
    }
  })

  it('offers only models the streaming endpoint accepts', () => {
    const models = streamableModels([
      { model_id: 'eleven_flash_v2_5', name: 'Flash v2.5', can_do_text_to_speech: true, languages: [{ language_id: 'en' }] },
      { model_id: 'eleven_v3', name: 'v3', can_do_text_to_speech: true },
      { model_id: 'eleven_english_sts_v2', name: 'STS', can_do_text_to_speech: false },
    ])
    expect(models.map((m) => m.id)).toEqual(['eleven_flash_v2_5'])
    expect(models[0].languages).toEqual(['en'])
  })
})

describe('error mapping', () => {
  it('names auth, quota, rate-limit, model and network failures', () => {
    expect(mapElevenLabsFailure(401).kind).toBe('auth')
    expect(mapElevenLabsFailure(402).kind).toBe('quota')
    expect(mapElevenLabsFailure(400, { detail: { status: 'quota_exceeded', message: 'You have 0 credits remaining' } }).kind).toBe('quota')
    expect(mapElevenLabsFailure(429).kind).toBe('rate_limit')
    expect(mapElevenLabsFailure(400, { detail: { status: 'model_not_found', message: 'Model does not support this' } }).kind).toBe('unsupported_model')
    expect(mapElevenLabsFailure(503).kind).toBe('network')
  })

  it('reports a refused key on the settings state without the key', async () => {
    const { transport } = makeTransport({
      '/v1/user/subscription': { status: 401, body: { detail: { status: 'invalid_api_key', message: 'Invalid API key' } } },
      '/v2/voices': { body: { voices: [] } },
      '/v1/models': { body: [] },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const engine = new ElevenLabsEngine({ getKey: () => KEY, transport })
    await engine.refresh()
    const state = engine.state({ disclosureAccepted: true, modelId: 'eleven_flash_v2_5' })
    expect(state.error?.kind).toBe('auth')
    expect(state.keySet).toBe(true)
    expect(JSON.stringify(state)).not.toContain(KEY)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY)
  })

  it('maps an unreachable host to a network error', async () => {
    const { transport } = makeTransport({})
    const engine = new ElevenLabsEngine({ getKey: () => KEY, transport })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await engine.refresh()
    expect(engine.error?.kind).toBe('network')
  })
})

describe('streaming speech over the WebSocket', () => {
  function open() {
    const { transport, sockets } = makeTransport()
    const client = new ElevenLabsTtsClient(() => KEY, transport)
    const chunks: Array<{ speechId: string; index: number; sampleRate: number; pcm: Buffer }> = []
    const done: Array<{ speechId: string; cancelled: boolean }> = []
    const errors: Array<{ message: string; speechId?: string; kind?: string }> = []
    client.on('chunk', (c) => chunks.push(c))
    client.on('done', (speechId, cancelled) => done.push({ speechId, cancelled }))
    client.on('error', (message, speechId, kind) => errors.push({ message, speechId, kind }))
    return { client, sockets, chunks, done, errors }
  }

  it('sends settings, then sentences, and feeds audio chunks as they arrive', () => {
    const { client, sockets, chunks, done } = open()
    client.speak({ speechId: 's1', sentences: [], open: true, voiceId: 'v1', modelId: 'eleven_flash_v2_5', speed: 1 })
    const socket = sockets[0]
    expect(socket.url).toContain('/v1/text-to-speech/v1/stream-input')
    expect(socket.url).toContain('model_id=eleven_flash_v2_5')
    expect(socket.url).toContain('output_format=pcm_24000')
    expect(socket.url).not.toContain(KEY)
    expect(socket.headers['xi-api-key']).toBe(KEY)

    // Sentences written before the socket opens wait for it.
    client.append('s1', ['Hello there.'])
    expect(socket.sent).toEqual([])
    socket.emit('open')
    expect(socket.sent[0]).toMatchObject({ text: ' ', voice_settings: { speed: 1 } })
    expect(socket.sent[1]).toEqual({ text: 'Hello there. ' })

    client.append('s1', ['How can I help?'])
    expect(socket.sent[2]).toEqual({ text: 'How can I help? ' })

    socket.receive({ audio: pcm([1, 0, 2, 0]), isFinal: null })
    socket.receive({ audio: pcm([3, 0, 4, 0]), isFinal: null })
    expect(chunks.map((c) => c.index)).toEqual([0, 1])
    expect(chunks[0]).toMatchObject({ speechId: 's1', sampleRate: ELEVENLABS_SAMPLE_RATE })
    expect([...chunks[1].pcm]).toEqual([3, 0, 4, 0])
    expect(done).toEqual([])

    // No message carries the key.
    expect(JSON.stringify(socket.sent)).not.toContain(KEY)
  })

  it('flushes at the end of the turn so a short reply is not left buffered', () => {
    const { client, sockets, done } = open()
    client.speak({ speechId: 's1', sentences: ['Yes.'], open: true, voiceId: 'v1', modelId: 'eleven_flash_v2_5', speed: 1 })
    const socket = sockets[0]
    socket.emit('open')
    expect(socket.sent.some((m) => m.text === '')).toBe(false)
    client.finish('s1')
    expect(socket.sent[socket.sent.length - 1]).toEqual({ text: '' })
    socket.receive({ audio: pcm([1, 0]) })
    socket.receive({ isFinal: true })
    expect(done).toEqual([{ speechId: 's1', cancelled: false }])
    expect(socket.closed).toBe(true)
  })

  it('a closed passage is flushed as soon as the socket opens', () => {
    const { client, sockets } = open()
    client.speak({ speechId: 'p', sentences: ['A sample.'], voiceId: 'v1', modelId: 'eleven_flash_v2_5', speed: 1 })
    sockets[0].emit('open')
    expect(sockets[0].sent.map((m) => m.text)).toEqual([' ', 'A sample. ', ''])
  })

  it('cancel closes the connection and discards late audio', () => {
    const { client, sockets, chunks, done } = open()
    client.speak({ speechId: 's1', sentences: ['One.'], open: true, voiceId: 'v1', modelId: 'm', speed: 1 })
    const socket = sockets[0]
    socket.emit('open')
    client.cancel('s1')
    expect(socket.closed).toBe(true)
    expect(done).toEqual([{ speechId: 's1', cancelled: true }])
    socket.receive({ audio: pcm([9, 9]) })
    expect(chunks).toEqual([])
  })

  it('a new passage replaces the old one and closes its connection', () => {
    const { client, sockets, chunks } = open()
    client.speak({ speechId: 'a', sentences: [], open: true, voiceId: 'v1', modelId: 'm', speed: 1 })
    client.speak({ speechId: 'b', sentences: [], open: true, voiceId: 'v1', modelId: 'm', speed: 1 })
    expect(sockets[0].closed).toBe(true)
    sockets[0].receive({ audio: pcm([1, 0]) })
    expect(chunks).toEqual([])
  })

  it('names a refused handshake, a quota message and a dropped connection', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const auth = open()
    auth.client.speak({ speechId: 's', sentences: ['Hi.'], voiceId: 'v1', modelId: 'm', speed: 1 })
    auth.sockets[0].emit('unexpected-response', {}, { statusCode: 401 })
    expect(auth.errors[0]).toMatchObject({ speechId: 's', kind: 'auth' })

    const quota = open()
    quota.client.speak({ speechId: 's', sentences: ['Hi.'], voiceId: 'v1', modelId: 'm', speed: 1 })
    quota.sockets[0].emit('open')
    quota.sockets[0].receive({ error: 'quota_exceeded', message: 'This request exceeds your quota' })
    expect(quota.errors[0].kind).toBe('quota')

    const dropped = open()
    dropped.client.speak({ speechId: 's', sentences: [], open: true, voiceId: 'v1', modelId: 'm', speed: 1 })
    dropped.sockets[0].emit('open')
    dropped.sockets[0].emit('close', 1006, '')
    expect(dropped.errors[0].kind).toBe('network')

    for (const e of [...auth.errors, ...quota.errors, ...dropped.errors]) expect(e.message).not.toContain(KEY)
  })

  it('refuses to open a socket without a key', () => {
    const { transport, sockets } = makeTransport()
    const client = new ElevenLabsTtsClient(() => '', transport)
    const errors: string[] = []
    client.on('error', (_m, _id, kind) => errors.push(kind))
    client.speak({ speechId: 's', sentences: ['Hi.'], voiceId: 'v1', modelId: 'm', speed: 1 })
    expect(sockets).toEqual([])
    expect(errors).toEqual(['auth'])
  })
})

describe('the engine behind the speech service contract', () => {
  class IdleWorker extends EventEmitter {
    load(): void {}
    speak(): void {}
    append(): void {}
    finish(): void {}
    cancel(): void {}
    unload(): void {}
    stop(): void {}
    setRuntimeModulePath(): void {}
  }

  function makeService(settings: Record<string, string>) {
    const store = new Map(Object.entries(settings))
    const events: Array<{ channel: string; data: unknown }> = []
    const { transport, sockets } = makeTransport({
      '/v1/user/subscription': { body: { character_count: 10, character_limit: 1000 } },
      '/v2/voices': { body: { voices: [{ voice_id: 'v1', name: 'Rachel' }], has_more: false } },
      '/v1/models': { body: [{ model_id: 'eleven_flash_v2_5', name: 'Flash', can_do_text_to_speech: true }] },
    })
    const service = new VoiceSpeechService({
      db: { getSetting: (k) => store.get(k), setSetting: (k, v) => void store.set(k, v) },
      notifyRenderer: (channel, data) => events.push({ channel, data }),
      modelRootDir: '/nowhere',
      worker: new IdleWorker() as unknown as VoiceTtsWorkerClient,
      models: { list: async () => [], resolve: async () => null } as unknown as VoiceTtsModelManager,
      listVoices: async () => [],
      elevenlabs: new ElevenLabsEngine({ getKey: () => store.get(VOICE_TTS_SETTING_KEYS.elevenlabsApiKey) ?? '', transport }),
    })
    return { service, store, events, sockets }
  }

  it('cannot be selected before the disclosure is accepted', async () => {
    const { service } = makeService({})
    await expect(service.setEngine('elevenlabs')).rejects.toThrow(/disclosure/i)
    await service.acceptElevenLabsDisclosure()
    await expect(service.setEngine('elevenlabs')).resolves.toMatchObject({ engine: 'elevenlabs' })
  })

  it('keeps system as the default and sends nothing until chosen', async () => {
    const { service, sockets } = makeService({ [VOICE_TTS_SETTING_KEYS.elevenlabsApiKey]: KEY })
    expect(service.engine()).toBe('system')
    await service.speak({ text: 'Hello.', source: 'manual' })
    expect(sockets).toEqual([])
  })

  it('validates the key, lists voices, previews through the socket, and never returns the key', async () => {
    const { service, events, sockets } = makeService({ [VOICE_TTS_SETTING_KEYS.elevenlabsDisclosure]: 'true' })
    const saved = await service.setElevenLabsKey(KEY)
    expect(saved.elevenlabs).toMatchObject({ keySet: true, error: null, usage: { used: 10, limit: 1000 } })
    expect(saved.elevenlabs.models.map((m) => m.id)).toEqual(['eleven_flash_v2_5'])

    const snapshot = await service.setEngine('elevenlabs')
    expect(snapshot.voices.map((v) => v.id)).toEqual(['elevenlabs:v1'])
    expect(snapshot.voiceId).toBe('elevenlabs:v1')
    expect(snapshot.status.state).toBe('ready')

    expect(await service.speak({ text: 'This is how I sound.', source: 'preview', voiceId: 'elevenlabs:v1' })).toBe(true)
    const socket = sockets[0]
    socket.emit('open')
    socket.receive({ audio: pcm([1, 0, 2, 0]) })
    socket.receive({ isFinal: true })

    const chunk = events.find((e) => e.channel === VOICE_TTS_EVENTS.speechChunk)?.data as { sampleRate: number; pcm: Uint8Array }
    expect(chunk.sampleRate).toBe(ELEVENLABS_SAMPLE_RATE)
    expect([...chunk.pcm]).toEqual([1, 0, 2, 0])
    expect(events.some((e) => e.channel === VOICE_TTS_EVENTS.speechEnd && (e.data as { reason: string }).reason === 'complete')).toBe(true)

    // Nothing sent to the renderer carries the key.
    expect(JSON.stringify(events)).not.toContain(KEY)
    expect(JSON.stringify(await service.snapshot())).not.toContain(KEY)
  })

  it('changing engines closes the open connection', async () => {
    const { service, sockets } = makeService({
      [VOICE_TTS_SETTING_KEYS.elevenlabsDisclosure]: 'true',
      [VOICE_TTS_SETTING_KEYS.elevenlabsApiKey]: KEY,
      [VOICE_TTS_SETTING_KEYS.engine]: 'elevenlabs',
    })
    await service.prepare()
    await service.speak({ text: 'A long reply.', source: 'manual' })
    expect(sockets[0].closed).toBe(false)
    await service.setEngine('system')
    expect(sockets[0].closed).toBe(true)
  })

  it('refuses a model the streaming endpoint cannot use', async () => {
    const { service } = makeService({ [VOICE_TTS_SETTING_KEYS.elevenlabsDisclosure]: 'true', [VOICE_TTS_SETTING_KEYS.elevenlabsApiKey]: KEY })
    await service.refreshElevenLabs()
    await expect(service.setElevenLabsModel('eleven_v3')).rejects.toThrow(/streaming/)
  })
})
