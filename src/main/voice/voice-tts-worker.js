/**
 * Isolated speech-synthesis worker (design §5.1 and §5.2).
 *
 * It is a separate process for the same reason the recognition worker is: model
 * loading and inference must never run on the Electron main event loop or in
 * the renderer, and a model failure must not stop the user interface.
 *
 * Protocol
 *   control : Node IPC channel, one JSON object per message
 *   audio   : the same IPC channel, base64 signed 16-bit little-endian PCM,
 *             bounded fragments of at most 128 KiB
 *
 * Main to worker : load | speak | append | finish | cancel | unload | ping
 * Worker to main : status | chunk | done | error | pong
 *
 * A passage can be left open. An agent answer arrives a few words at a time,
 * and waiting for the last word before saying the first one would put the whole
 * answer behind the agent. So `speak` may open a passage with nothing in it,
 * `append` adds sentences as they are finished, and `finish` closes it.
 *
 * Two engines sit behind one protocol:
 *
 *   `system` runs the voice already installed in the operating system. It needs
 *   no download and no local runtime, so spoken answers work on a machine that
 *   never installs anything.
 *
 *   `local` runs a neural model through `sherpa-onnx-node`, the same runtime
 *   speech recognition installs. It is required lazily, so a build without it
 *   still starts and simply reports `engine_missing`.
 *
 * Speech is produced one sentence at a time and each sentence is sent as soon
 * as it exists. Playback therefore starts after the first sentence instead of
 * after the whole answer, and the caller shortens the opening one so that the
 * first sound arrives sooner still.
 *
 * `sherpa-onnx-node` does expose a streaming callback, `generateAsync({
 * onProgress })`. It is not used: measured, it does not stream below a sentence
 * — one callback per sentence group — and it ends the process with an
 * out-of-memory abort after one or two calls. See `docs/voice-tts.md`.
 *
 * A sentence is capped by the caller at about 240 characters, which keeps the
 * blocking call to roughly one second and keeps cancellation responsive.
 */

'use strict'

const { execFile } = require('child_process')
const { constants, closeSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } = require('fs')
const { join } = require('path')
const { tmpdir } = require('os')

/** Words per minute the two command-line voices use by default. */
const DEFAULT_WORDS_PER_MINUTE = 175
/** A single sentence must never hold the worker for longer than this. */
const SENTENCE_TIMEOUT_MS = 30_000

let engineKind = null
let tts = null
let loaded = null
let currentSpeech = null
// Each receipt joins both execFile's buffered callback and native close.
// Signalling a child never releases its handle or its private temporary files.
const systemChildren = new Set()
const MAX_PCM_CHUNK_BYTES = 128 * 1024
let closing = false

/**
 * Sends one control message.
 *
 * `onFlushed` matters for audio. The local model call blocks the process for
 * about a second, and a queued pipe write is not flushed while it blocks, so
 * without waiting for the flush the first sentence would only reach the parent
 * after the last one had been produced — playback would start at the end.
 */
function send(message, onFlushed) {
  if (!process.send || !process.connected) {
    if (onFlushed) onFlushed()
    return
  }
  try { process.send(message, undefined, undefined, onFlushed) } catch { if (onFlushed) onFlushed() }
}

function fail(code, message, speechId, requestEpoch) {
  send({ t: 'error', code, message, speechId, requestEpoch })
}

// ── Loading ─────────────────────────────────────────────────

function loadLocal(message) {
  const moduleName = process.env.VOICE_ENGINE_MODULE || 'sherpa-onnx-node'
  if (process.env.VOICE_TTS_ENGINE === 'mock') {
    tts = { mock: true, sampleRate: message.model.sampleRate || 24000, numSpeakers: 8 }
    return { engine: 'mock', sampleRate: tts.sampleRate }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sherpa = require(moduleName)
  const family = message.model.family === 'kokoro' ? 'kokoro' : 'kitten'
  // Both families take the same four paths. Only the key differs, so one
  // branch here covers every catalogue entry.
  const modelConfig = {
    [family]: {
      model: message.model.model,
      voices: message.model.voices,
      tokens: message.model.tokens,
      dataDir: message.model.dataDir,
      lengthScale: 1.0,
    },
    // One thread, measured, not assumed. On an Apple Silicon machine with the
    // same sentence, the real-time factor was:
    //
    //   kitten-nano   1 thread 0.37   2 threads 0.88   4 threads 1.11
    //   kokoro        1 thread 1.56   2 threads 3.29   4 threads 7.47
    //
    // Above 1.0 the voice cannot keep up with its own playback, so the reading
    // drags and the CPU stays busy. More threads make it worse: these graphs
    // are small, so the extra threads add synchronisation instead of work, and
    // the spillover lands on efficiency cores. Do not raise this without
    // measuring again.
    numThreads: message.numThreads || 1,
    // Not 'coreml'. It aborts the process on these models —
    // "Unable to get shape for output" from the ONNX CoreML builder, SIGABRT.
    provider: 'cpu',
    debug: 0,
  }
  tts = new sherpa.OfflineTts({
    model: modelConfig,
    // One sentence per call. The caller already split the passage, and a larger
    // value only delays the first sound.
    maxNumSentences: 1,
  })
  return { engine: `sherpa-onnx/${family}`, sampleRate: tts.sampleRate, numSpeakers: tts.numSpeakers }
}

const handlers = {
  load(message) {
    engineKind = message.engine === 'local' ? 'local' : 'system'
    try {
      if (engineKind === 'system') {
        const command = systemCommand()
        if (!command) {
          send({
            t: 'status',
            state: 'engine_missing',
            message: 'This system has no voice that 21x can use.',
          })
          return
        }
        loaded = { systemVoice: message.systemVoice || '' }
        send({ t: 'status', state: 'ready', engine: `system/${command.kind}`, modelId: '', sampleRate: 0 })
        return
      }

      const started = Date.now()
      const info = loadLocal(message)
      loaded = { modelId: message.modelId }
      send({
        t: 'status',
        state: 'ready',
        engine: info.engine,
        modelId: message.modelId,
        sampleRate: info.sampleRate,
        numSpeakers: info.numSpeakers,
        loadMs: Date.now() - started,
      })
    } catch (err) {
      tts = null
      loaded = null
      const missing =
        err && (err.code === 'MODULE_NOT_FOUND' || /cannot find module/i.test(String(err.message)))
      send({
        t: 'status',
        state: missing ? 'engine_missing' : 'error',
        message: missing
          ? 'The local speech runtime is not installed.'
          : String((err && err.message) || err),
      })
    }
  },

  speak(message) {
    if (!loaded) return fail('not_ready', 'No voice is loaded.', message.speechId, message.requestEpoch)
    if (currentSpeech) handlers.cancel({ speechId: currentSpeech.speechId })
    const sentences = Array.isArray(message.sentences) ? message.sentences.filter(Boolean) : []
    // A streaming passage opens with nothing in it and is filled as the answer
    // is written, so only a closed passage with no words is already finished.
    if (sentences.length === 0 && !message.open) {
      send({ t: 'done', speechId: message.speechId, requestEpoch: message.requestEpoch, chunks: 0, elapsedMs: 0 })
      return
    }
    currentSpeech = {
      speechId: message.speechId,
      requestEpoch: message.requestEpoch,
      sentences,
      index: 0,
      chunks: 0,
      speakerId: Number(message.speakerId) || 0,
      speed: Number(message.speed) || 1,
      systemVoice: message.systemVoice || (loaded && loaded.systemVoice) || '',
      startedAt: Date.now(),
      // An open passage waits for more instead of finishing when it runs dry.
      open: Boolean(message.open),
      running: false,
    }
    step()
  },

  /** More sentences for the passage that is already being read. */
  append(message) {
    const speech = currentSpeech
    if (!speech || speech.speechId !== message.speechId || message.requestEpoch !== speech.requestEpoch) return
    const sentences = Array.isArray(message.sentences) ? message.sentences.filter(Boolean) : []
    if (sentences.length === 0) return
    speech.sentences.push(...sentences)
    // The loop stops when it runs out of sentences, so it has to be restarted.
    if (!speech.running) step()
  },

  /** No more sentences are coming. The passage ends when it runs dry. */
  finish(message) {
    const speech = currentSpeech
    if (!speech || speech.speechId !== message.speechId || message.requestEpoch !== speech.requestEpoch) return
    speech.open = false
    if (!speech.running) step()
  },

  cancel(message) {
    const id = message && message.speechId
    if (!currentSpeech) return
    if (id && id !== currentSpeech.speechId || message.requestEpoch !== undefined && message.requestEpoch !== currentSpeech.requestEpoch) return
    const speech = currentSpeech
    currentSpeech = null
    // The terminal receipt follows actual descendant close, not kill intent.
    void retireSystemChildren().then(() => {
      send({ t: 'done', speechId: speech.speechId, requestEpoch: speech.requestEpoch, chunks: 0, elapsedMs: 0, cancelled: true })
    })
  },

  unload() {
    handlers.cancel({})
    tts = null
    loaded = null
    send({ t: 'status', state: 'unloaded' })
  },

  ping() {
    send({ t: 'pong', rss: process.memoryUsage().rss })
  },
}

process.on('message', (message) => {
  if (closing) return
  const handler = handlers[message && message.t]
  if (!handler) return
  try {
    handler(message)
  } catch (err) {
    fail('handler_failed', String((err && err.message) || err), message && message.speechId, message && message.requestEpoch)
  }
})

// ── The sentence loop ───────────────────────────────────────

/**
 * Produces one sentence, sends it, and hands the process back to the event loop
 * before the next one.
 *
 * The yield is what makes cancellation work: the local model call blocks, so a
 * `cancel` message can only be read between sentences.
 */
function step() {
  const speech = currentSpeech
  if (!speech) return
  if (speech.index >= speech.sentences.length) {
    speech.running = false
    // An open passage is not finished, it is merely waiting for the next
    // sentence to be written.
    if (speech.open) return
    currentSpeech = null
    send({
      t: 'done',
      speechId: speech.speechId,
      requestEpoch: speech.requestEpoch,
      chunks: speech.chunks,
      elapsedMs: Date.now() - speech.startedAt,
    })
    return
  }

  speech.running = true
  const sentence = speech.sentences[speech.index]
  speech.index += 1

  synthesize(speech, sentence)
    .then((audio) => {
      // Object identity fences replacements even if a caller reuses speechId.
      if (currentSpeech !== speech || closing) return
      if (!audio || !audio.pcm.length) { setImmediate(() => { if (currentSpeech === speech) step() }); return }
      if (audio.pcm.length % 2 || !Number.isInteger(audio.sampleRate) || audio.sampleRate < 8000 || audio.sampleRate > 48000) throw new Error('Invalid speech PCM format.')
      let offset = 0
      const fragment = () => {
        if (currentSpeech !== speech || closing) return
        const end = Math.min(offset + MAX_PCM_CHUNK_BYTES, audio.pcm.length)
        const text = offset === 0 ? sentence : ''
        const pcm = audio.pcm.subarray(offset, end).toString('base64')
        offset = end
        send({ t: 'chunk', speechId: speech.speechId, requestEpoch: speech.requestEpoch,
          index: speech.chunks++, sampleRate: audio.sampleRate, text, pcm },
        () => setImmediate(() => { if (currentSpeech === speech) { if (offset < audio.pcm.length) fragment(); else step() } }))
      }
      fragment()
    })
    .catch((err) => {
      if (currentSpeech !== speech || closing) return
      currentSpeech = null
      fail('synthesis_failed', String((err && err.message) || err), speech.speechId, speech.requestEpoch)
    })
}

function synthesize(speech, sentence) {
  if (engineKind === 'local') return Promise.resolve(synthesizeLocal(speech, sentence))
  return synthesizeSystem(speech, sentence)
}

function synthesizeLocal(speech, sentence) {
  if (tts && tts.mock) {
    // A silent quarter second per sentence. The tests drive the protocol with
    // it; it never invents audio that sounds like speech.
    const samples = Math.round(tts.sampleRate * 0.25)
    return { pcm: Buffer.alloc(samples * 2), sampleRate: tts.sampleRate }
  }
  const audio = tts.generate({
    text: sentence,
    sid: speech.speakerId,
    speed: speech.speed,
    // The runtime hands back its samples in memory it owns itself unless this
    // is off. Electron refuses to wrap that memory — "External buffers are not
    // allowed" — and the whole turn fails, while the same call from plain Node
    // succeeds. The worker runs inside Electron, so it must ask for a copy.
    enableExternalBuffer: false,
  })
  return { pcm: floatToPcm16(audio.samples), sampleRate: audio.sampleRate }
}

function floatToPcm16(samples) {
  const out = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    out.writeInt16LE(Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), i * 2)
  }
  return out
}

// ── The system voice ────────────────────────────────────────

/** Which command-line voice this operating system offers, if any. */
function systemCommand() {
  if (process.platform === 'darwin') return { kind: 'say' }
  if (process.platform === 'win32') return { kind: 'sapi' }
  if (process.platform === 'linux') return { kind: 'espeak-ng' }
  return null
}

/**
 * Speaks one sentence with the operating-system voice.
 *
 * The text is written to a file and the file is named on the command line. It
 * is never interpolated into a shell string, so an answer that contains quotes,
 * newlines or shell characters cannot change the command that runs.
 */
async function synthesizeSystem(speech, sentence) {
  // A replacement cannot outrun retirement of the previous owned command.
  await Promise.all([...systemChildren].map(receipt => receipt.closed))
  if (closing || currentSpeech !== speech) return null
  const command = systemCommand()
  if (!command) return Promise.reject(new Error('This system has no voice that 21x can use.'))

  const dir = mkdtempSync(join(tmpdir(), '20x-speech-'))
  const textPath = join(dir, 'text.txt')
  const wavPath = join(dir, 'speech.wav')
  writeFileSync(textPath, sentence, 'utf8')

  const wordsPerMinute = Math.round(DEFAULT_WORDS_PER_MINUTE * speech.speed)
  let file
  let args
  if (command.kind === 'say') {
    args = ['-r', String(wordsPerMinute), '--data-format=LEI16@24000', '--file-format=WAVE', '-o', wavPath, '-f', textPath]
    if (speech.systemVoice) args.unshift('-v', speech.systemVoice)
    file = 'say'
  } else if (command.kind === 'espeak-ng') {
    args = ['-s', String(wordsPerMinute), '-w', wavPath, '-f', textPath]
    if (speech.systemVoice) args.unshift('-v', speech.systemVoice)
    file = 'espeak-ng'
  } else {
    file = 'powershell.exe'
    args = ['-NoProfile', '-NonInteractive', '-Command', windowsScript(textPath, wavPath, speech)]
  }

  let callbackDone, nativeDone, failure
  const callback = new Promise(resolve => { callbackDone = resolve })
  const nativeClose = new Promise(resolve => { nativeDone = resolve })
  const receipt = { child: null, closed: null, timer: null, exited: false, terminating: false }
  receipt.child = execFile(file, args, { timeout: SENTENCE_TIMEOUT_MS, windowsHide: true }, err => {
    failure = err
    callbackDone()
  })
  receipt.child.once('close', () => { receipt.exited = true; clearTimeout(receipt.timer); nativeDone() })
  receipt.child.once('exit', () => { receipt.exited = true; clearTimeout(receipt.timer) })
  receipt.closed = Promise.all([callback, nativeClose]).then(() => {})
  systemChildren.add(receipt)
  // execFile's timeout only sends TERM; retain and escalate the exact handle.
  receipt.timer = setTimeout(() => terminateSystemChild(receipt), SENTENCE_TIMEOUT_MS)
  try {
    await receipt.closed
    if (failure) throw new Error(describeSystemFailure(command.kind, failure))
    return readWavAsPcm16(wavPath)
  } finally {
    clearTimeout(receipt.timer)
    systemChildren.delete(receipt)
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The Windows script reads the text from the file, so no part of an answer ever
 * reaches the command line.
 */
function windowsScript(textPath, wavPath, speech) {
  const rate = Math.max(-10, Math.min(10, Math.round((speech.speed - 1) * 10)))
  const voice = speech.systemVoice ? `$s.SelectVoice('${escapeForPowerShell(speech.systemVoice)}');` : ''
  return [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    `$s.Rate = ${rate};`,
    voice,
    `$s.SetOutputToWaveFile('${escapeForPowerShell(wavPath)}');`,
    `$s.Speak([System.IO.File]::ReadAllText('${escapeForPowerShell(textPath)}'));`,
    '$s.Dispose();',
  ].join(' ')
}

/** Only paths and voice names reach this, never an assistant answer. */
function escapeForPowerShell(value) {
  return String(value).replace(/'/g, "''")
}

function describeSystemFailure(kind, err) {
  if (err.code === 'ENOENT') {
    if (kind === 'espeak-ng') return 'espeak-ng is not installed, so 21x cannot use a system voice.'
    return 'The system voice command was not found.'
  }
  if (err.killed) return 'The system voice took too long and was stopped.'
  return String(err.message || err)
}

function terminateSystemChild(receipt) {
  if (receipt.exited || receipt.terminating) return
  receipt.terminating = true
  clearTimeout(receipt.timer)
  try { receipt.child.kill('SIGTERM') } catch { /* retain receipt until close */ }
  receipt.timer = setTimeout(() => {
    if (!receipt.exited) { try { receipt.child.kill('SIGKILL') } catch { /* retain receipt */ } }
  }, 200)
}
function retireSystemChildren() {
  const receipts = [...systemChildren]
  for (const receipt of receipts) terminateSystemChild(receipt)
  return Promise.all(receipts.map(receipt => receipt.closed)).then(() => {})
}
function shutdown(code = 0) {
  if (closing) return
  closing = true
  currentSpeech = null
  void retireSystemChildren().then(() => process.exit(code))
}
process.on('SIGTERM', () => shutdown())
process.on('disconnect', () => shutdown())

// ── WAV ─────────────────────────────────────────────────────

/**
 * Reads a RIFF/WAVE file and returns mono signed 16-bit PCM.
 *
 * The chunks are walked rather than assumed: macOS `say` writes a padding
 * chunk between `fmt ` and `data`, so a fixed 44-byte header would read noise.
 */
function readWavAsPcm16(path) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  let data
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('The system voice sound file is too large or invalid.')
    data = readFileSync(fd)
    if (data.length > 8 * 1024 * 1024) throw new Error('The system voice sound file is too large.')
  } finally { closeSync(fd) }
  if (data.length < 12 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('The system voice did not produce a readable sound file.')
  }
  let offset = 12
  let channels = 0
  let sampleRate = 0
  let bits = 0
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4)
    const size = data.readUInt32LE(offset + 4)
    const body = offset + 8
    if (body + size > data.length) throw new Error('The system voice produced truncated audio.')
    if (id === 'fmt ' && size >= 16) {
      if (data.readUInt16LE(body) !== 1) throw new Error('The system voice did not produce PCM audio.')
      channels = data.readUInt16LE(body + 2)
      sampleRate = data.readUInt32LE(body + 4)
      bits = data.readUInt16LE(body + 14)
    } else if (id === 'data') {
      const end = Math.min(data.length, body + size)
      return { pcm: toMonoPcm16(data.subarray(body, end), channels, bits), sampleRate }
    }
    offset = body + size + (size % 2)
  }
  throw new Error('The system voice produced a sound file with no audio in it.')
}

function toMonoPcm16(body, channels, bits) {
  if (bits !== 16) throw new Error(`The system voice produced ${bits}-bit audio, which 21x cannot read.`)
  if (!channels || channels > 8 || body.length % (2 * channels)) throw new Error('The system voice produced incomplete PCM frames.')
  if (channels === 1) return Buffer.from(body)
  const frames = Math.floor(body.length / (2 * channels))
  const out = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) sum += body.readInt16LE((i * channels + c) * 2)
    out.writeInt16LE(Math.round(sum / channels), i * 2)
  }
  return out
}

process.on('uncaughtException', (err) => {
  fail('worker_crashed', String((err && err.message) || err))
  shutdown(1)
})
