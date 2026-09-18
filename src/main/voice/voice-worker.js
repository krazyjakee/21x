/**
 * Isolated speech-to-text worker (design §5.1 "Local voice worker").
 *
 * The worker is a separate process on purpose. Model loading and decoding must
 * never run on the Electron main event loop or in the renderer, and a model
 * failure must not stop the user interface.
 *
 * Protocol
 *   control  : Node IPC channel, one JSON object per message (see below)
 *   audio    : stdin, length-prefixed frames — [uint32 LE byte length][int16 LE PCM]
 *
 * Main to worker : load | start | end | cancel | unload | ping
 * Worker to main : status | partial | segment | final | error | pong | metrics
 *
 * The runtime (`sherpa-onnx-node`) is required lazily. When it is absent the
 * worker reports `engine_missing` and exits cleanly, so a build without the
 * native runtime still starts and simply keeps voice switched off.
 *
 * Two kinds of model run behind the same protocol:
 *
 *   streaming  — an `OnlineRecognizer`. Every frame is decoded as it arrives,
 *                partials are the running hypothesis, and the recogniser's own
 *                endpoint rule ends a sentence.
 *   offline    — an `OfflineRecognizer` (Parakeet TDT). The whole utterance is
 *                decoded at once, so the worker buffers the turn, ends a
 *                sentence when the signal has been quiet for the configured
 *                pause, and decodes the buffer then. Partials come from
 *                decoding the buffer so far, at a pace the machine can afford.
 *
 * Main sees the same `partial`, `segment` and `final` messages either way, so
 * the state machine does not know which kind is loaded.
 *
 * Phase 1 is push-to-talk, so the user's hold marks the start and the end of a
 * turn. A standalone VAD is only needed for the phase 2 wake word, and it fits
 * behind this same protocol.
 */

'use strict'

const os = require('os')

const SAMPLE_RATE = 16000
/** Stop a turn that never ends, so a stuck renderer cannot grow memory. */
const MAX_TURN_MS = 60000
/** A conversation may run longer, but not for ever. */
const MAX_CONVERSATION_MS = 10 * 60 * 1000

// ── Offline endpointing ─────────────────────────────────────
// An offline model does not tell the worker where a sentence ends, so the
// signal level does. These are starting values from the renderer's PCM scale
// (samples in -1..1); `VOICE_SPEECH_RMS` overrides the threshold for tuning.

/** A frame louder than this is speech. About -37 dBFS. */
const SPEECH_RMS = Number(process.env.VOICE_SPEECH_RMS) || 0.014
/** Less speech than this in a sentence is a click, not words. */
const MIN_SPEECH_MS = 300
/** The pause that ends a sentence is never shorter than this. */
const MIN_ENDPOINT_MS = 800
/** How much new audio arrives between two partial decodes, at the least. */
const PARTIAL_EVERY_MS = 1500
/** Past this much buffered audio, partials stop: each one would cost too much. */
const PARTIAL_MAX_MS = 20000
/** A decode slower than this doubles the wait before the next partial. */
const PARTIAL_SLOW_MS = 400

let engine = null
let recognizer = null
/** `streaming` or `offline`; set by `load`. */
let modelKind = 'streaming'
let stream = null
let currentTurn = null
let turnTimer = null
let lastPartial = ''
let turnFrames = 0
let turnStartedAt = 0
let turnMode = 'dictation'
let segmentIndex = 0
let endpointSilenceMs = 1200

/** The audio of the sentence in progress, offline models only. */
let offline = null

function send(message) {
  if (process.send) process.send(message)
}

function fail(code, message) {
  send({ t: 'error', code, message })
}

// ── Engine loading ──────────────────────────────────────────

function loadEngine() {
  if (engine) return engine
  const moduleName = process.env.VOICE_ENGINE_MODULE || 'sherpa-onnx-node'
  if (process.env.VOICE_ENGINE === 'mock') {
    engine = createMockEngine()
    return engine
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  engine = require(moduleName)
  return engine
}

/**
 * A deterministic engine used by the automated tests and by `pnpm dev` on a
 * machine without the native runtime. It never invents words: it returns only
 * `VOICE_MOCK_TEXT`, so a test can drive the protocol without a model.
 */
function createMockEngine() {
  return { __mock: true, text: process.env.VOICE_MOCK_TEXT || '' }
}

function offlineThreads() {
  // A 0.6B encoder is slow on two threads. Leave one core to the rest of the
  // application.
  const cores = os.cpus().length || 2
  return Math.max(2, Math.min(4, cores - 1))
}

/**
 * Says what went wrong in words the user can act on. The runtime's own
 * message is kept at the end, so a diagnostic report still has it.
 */
function describeLoadFailure(err, kind) {
  const raw = String((err && err.message) || err)
  if (kind === 'offline' && /not a constructor|is not a function|OfflineRecognizer/i.test(raw)) {
    return (
      'The installed speech runtime is too old to run Parakeet v3. ' +
      'In Voice settings, remove the runtime and install it again. (' + raw + ')'
    )
  }
  if (/Errors in config|config/i.test(raw)) {
    return (
      'The speech model could not be loaded: the files do not match what the runtime expects. ' +
      'Delete the model and download it again. (' + raw + ')'
    )
  }
  if (/ENOENT|no such file/i.test(raw)) {
    return 'A model file is missing. Delete the model and download it again. (' + raw + ')'
  }
  if (/bad_alloc|out of memory|ENOMEM|allocat/i.test(raw)) {
    return 'There is not enough memory to load the speech model. Close other applications and try again. (' + raw + ')'
  }
  return raw
}

// ── Commands ────────────────────────────────────────────────

const handlers = {
  load(message) {
    modelKind = (message.model && message.model.kind) || 'streaming'
    endpointSilenceMs = Math.max(MIN_ENDPOINT_MS, (message.endpointSilence || 1.2) * 1000)
    try {
      const sherpa = loadEngine()
      if (sherpa.__mock) {
        recognizer = { mock: true, text: sherpa.text }
        send({ t: 'status', state: 'ready', modelId: message.modelId || 'mock', engine: 'mock', kind: modelKind })
        return
      }
      const started = Date.now()
      // The model paths and the thread count belong inside `modelConfig`. A
      // flat object is rejected by the runtime with "Errors in config!".
      if (modelKind === 'offline') {
        recognizer = new sherpa.OfflineRecognizer({
          featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
          modelConfig: {
            transducer: {
              encoder: message.model.encoder,
              decoder: message.model.decoder,
              joiner: message.model.joiner,
            },
            tokens: message.model.tokens,
            numThreads: message.numThreads || offlineThreads(),
            provider: 'cpu',
            // Parakeet TDT is a NeMo transducer export.
            modelType: 'nemo_transducer',
          },
          decodingMethod: 'greedy_search',
        })
      } else {
        recognizer = new sherpa.OnlineRecognizer({
          featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
          modelConfig: {
            transducer: {
              encoder: message.model.encoder,
              decoder: message.model.decoder,
              joiner: message.model.joiner,
            },
            tokens: message.model.tokens,
            numThreads: message.numThreads || 2,
            provider: 'cpu',
          },
          decodingMethod: 'greedy_search',
          enableEndpoint: 1,
          // rule2 is the one that ends a sentence after the speaker pauses.
          rule1MinTrailingSilence: 2.4,
          rule2MinTrailingSilence: message.endpointSilence || 1.2,
          rule3MinUtteranceLength: 20,
        })
      }
      send({
        t: 'status',
        state: 'ready',
        modelId: message.modelId,
        engine: 'sherpa-onnx',
        kind: modelKind,
        loadMs: Date.now() - started,
      })
    } catch (err) {
      recognizer = null
      const missing = err && (err.code === 'MODULE_NOT_FOUND' || /cannot find module/i.test(String(err.message)))
      send({
        t: 'status',
        state: missing ? 'engine_missing' : 'error',
        message: missing
          ? 'The local speech runtime is not installed in this build.'
          : describeLoadFailure(err, modelKind),
      })
    }
  },

  start(message) {
    if (!recognizer) return fail('not_ready', 'No speech model is loaded.')
    currentTurn = message.turnId
    turnMode = message.mode || 'dictation'
    lastPartial = ''
    turnFrames = 0
    segmentIndex = 0
    turnStartedAt = Date.now()
    if (modelKind === 'offline') {
      offline = newSentence()
    } else if (!recognizer.mock) {
      stream = recognizer.createStream()
    }
    armTurnTimer()
  },

  end(message) {
    if (!currentTurn || message.turnId !== currentTurn) return
    clearTimeout(turnTimer)
    const turnId = currentTurn
    currentTurn = null
    let text = ''
    if (modelKind === 'offline') {
      // Whatever is left in the buffer is the last sentence.
      text = offline && (offline.speechMs > 0 || recognizer.mock) ? decodeOffline(offline) : ''
      offline = null
    } else if (recognizer.mock) {
      text = recognizer.text
    } else if (stream) {
      // Flush the tail so the last word is decoded.
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: new Float32Array(SAMPLE_RATE * 0.4) })
      while (recognizer.isReady(stream)) recognizer.decode(stream)
      text = (recognizer.getResult(stream).text || '').trim()
      stream = null
    }
    // The frame count and the elapsed time are the only per-turn measurements
    // that leave the worker. No audio is kept and none is written to disk.
    send({ t: 'final', turnId, text, frames: turnFrames, elapsedMs: Date.now() - turnStartedAt })
  },

  cancel(message) {
    if (message.turnId && message.turnId !== currentTurn) return
    clearTimeout(turnTimer)
    currentTurn = null
    stream = null
    offline = null
    lastPartial = ''
  },

  unload() {
    clearTimeout(turnTimer)
    currentTurn = null
    stream = null
    offline = null
    recognizer = null
    send({ t: 'status', state: 'unloaded' })
  },

  ping() {
    send({ t: 'pong', rss: process.memoryUsage().rss })
  },
}

process.on('message', (message) => {
  const handler = handlers[message && message.t]
  if (!handler) return
  try {
    handler(message)
  } catch (err) {
    fail('handler_failed', String((err && err.message) || err))
  }
})

// ── Audio input ─────────────────────────────────────────────

let buffered = Buffer.alloc(0)

process.stdin.on('data', (chunk) => {
  buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
  for (;;) {
    if (buffered.length < 4) return
    const length = buffered.readUInt32LE(0)
    if (buffered.length < 4 + length) return
    const frame = buffered.subarray(4, 4 + length)
    buffered = buffered.subarray(4 + length)
    onAudioFrame(frame)
  }
})

function onAudioFrame(frame) {
  if (!currentTurn) return
  turnFrames += 1
  if (!recognizer) return
  if (modelKind === 'offline') return onOfflineFrame(frame)
  if (!stream || recognizer.mock) return
  const samples = toFloat32(frame)
  try {
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
    while (recognizer.isReady(stream)) recognizer.decode(stream)

    const text = (recognizer.getResult(stream).text || '').trim()
    if (text && text !== lastPartial) {
      lastPartial = text
      send({ t: 'partial', turnId: currentTurn, text })
    }

    // End of turn: the speaker stopped long enough for the endpoint rule.
    // In a conversation the microphone stays open and the next sentence
    // starts a new segment on the same stream.
    if (recognizer.isEndpoint(stream)) {
      recognizer.reset(stream)
      lastPartial = ''
      sentenceEnded(text)
    }
  } catch (err) {
    fail('decode_failed', String((err && err.message) || err))
  }
}

/**
 * A sentence has ended. In a conversation it is reported and the microphone
 * stays open; a single-shot turn is complete.
 */
function sentenceEnded(text) {
  if (turnMode === 'conversation') {
    // The conversation carries on: report the sentence and keep listening.
    // A `segment` is what makes the renderer send, so it must never be
    // emitted for a single-shot turn.
    if (text) {
      segmentIndex += 1
      send({ t: 'segment', turnId: currentTurn, text, index: segmentIndex })
    }
    armTurnTimer()
  } else if (text) {
    // A single-shot turn is complete once the speaker stops. The words go
    // into the text field and the user decides when to send them.
    const turnId = currentTurn
    currentTurn = null
    clearTimeout(turnTimer)
    send({ t: 'final', turnId, text, frames: turnFrames, elapsedMs: Date.now() - turnStartedAt })
  }
}

function toFloat32(frame) {
  const samples = new Float32Array(frame.length / 2)
  for (let i = 0; i < samples.length; i++) {
    samples[i] = frame.readInt16LE(i * 2) / 32768
  }
  return samples
}

// ── Offline models ──────────────────────────────────────────

function newSentence() {
  return {
    chunks: [],
    totalSamples: 0,
    speechMs: 0,
    silenceMs: 0,
    /** Audio (ms) buffered when the last partial was decoded. */
    partialAtMs: 0,
    /** The next partial waits for at least this much new audio. */
    partialEveryMs: PARTIAL_EVERY_MS,
  }
}

function rms(samples) {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

function bufferedMs(sentence) {
  return (sentence.totalSamples / SAMPLE_RATE) * 1000
}

function onOfflineFrame(frame) {
  if (!offline) return
  const samples = toFloat32(frame)
  const frameMs = (samples.length / SAMPLE_RATE) * 1000
  const loud = rms(samples) >= SPEECH_RMS

  // Silence before the first word is not kept: a long wait before speaking
  // would only slow the decode down.
  if (!loud && offline.speechMs === 0) return

  offline.chunks.push(samples)
  offline.totalSamples += samples.length
  if (loud) {
    offline.speechMs += frameMs
    offline.silenceMs = 0
  } else {
    offline.silenceMs += frameMs
  }

  try {
    if (offline.speechMs >= MIN_SPEECH_MS && offline.silenceMs >= endpointSilenceMs) {
      // The speaker stopped: this sentence is done.
      const sentence = offline
      offline = newSentence()
      lastPartial = ''
      sentenceEnded(decodeOffline(sentence))
      return
    }

    if (
      loud &&
      offline.speechMs >= MIN_SPEECH_MS &&
      bufferedMs(offline) <= PARTIAL_MAX_MS &&
      bufferedMs(offline) - offline.partialAtMs >= offline.partialEveryMs
    ) {
      const started = Date.now()
      const text = decodeOffline(offline)
      const took = Date.now() - started
      offline.partialAtMs = bufferedMs(offline)
      // A slow machine gets fewer partials rather than a stalled worker.
      offline.partialEveryMs = took > PARTIAL_SLOW_MS ? offline.partialEveryMs * 2 : PARTIAL_EVERY_MS
      if (text && text !== lastPartial) {
        lastPartial = text
        send({ t: 'partial', turnId: currentTurn, text })
      }
    }
  } catch (err) {
    fail('decode_failed', String((err && err.message) || err))
  }
}

/** Decodes everything buffered for one sentence and returns the text. */
function decodeOffline(sentence) {
  if (recognizer.mock) return recognizer.text
  const samples = new Float32Array(sentence.totalSamples)
  let offset = 0
  for (const chunk of sentence.chunks) {
    samples.set(chunk, offset)
    offset += chunk.length
  }
  const s = recognizer.createStream()
  s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
  recognizer.decode(s)
  return (recognizer.getResult(s).text || '').trim()
}

/** A turn that never ends must not grow memory for ever. */
function armTurnTimer() {
  clearTimeout(turnTimer)
  const limit = turnMode === 'conversation' ? MAX_CONVERSATION_MS : MAX_TURN_MS
  turnTimer = setTimeout(() => {
    if (currentTurn) handlers.end({ turnId: currentTurn })
  }, limit)
}

process.on('uncaughtException', (err) => {
  fail('worker_crashed', String((err && err.message) || err))
  process.exit(1)
})
