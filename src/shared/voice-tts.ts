/**
 * Shared text-to-speech contracts (phase 2 — spoken agent answers).
 *
 * Blueprint: research subtask "FluidVoice + local voice integration
 * feasibility" (design.md §5.2 provider contracts, §5.7 spoken answers,
 * §5.10 model management).
 *
 * Phase 1 shipped speech to text and left `VoiceCapabilities.tts` false. This
 * module adds the other half: 20x speaks an answer aloud. With the `system` and
 * `local` engines speech is produced on this computer and no text and no audio
 * leave the device. The `elevenlabs` engine is the one explicit exception: the
 * user opts into it, and then the text to be spoken is sent to ElevenLabs.
 *
 * This module is imported by the main process, the preload bridge, the
 * renderer, the worker and the mobile client, so it must stay free of Node and
 * DOM APIs.
 */

// ── Audio format ────────────────────────────────────────────

// ── Engines ─────────────────────────────────────────────────

/**
 * `system` uses the voice already installed in the operating system. It needs
 * no download and no local runtime, so spoken answers work on the day the app
 * starts.
 *
 * `local` uses a neural model through the same `sherpa-onnx-node` runtime that
 * speech to text installs. It sounds better and it needs both the runtime and a
 * downloaded model.
 *
 * `elevenlabs` is a hosted voice the user brings their own API key for. It is
 * never the default, it needs the network, and the text of every passage
 * leaves the device — so it cannot be selected until the disclosure has been
 * acknowledged (#64).
 */
export type VoiceTtsEngineId = 'system' | 'local' | 'elevenlabs'

export const VOICE_TTS_ENGINE_IDS: readonly VoiceTtsEngineId[] = ['system', 'local', 'elevenlabs']

/** The engines that work offline. Text never leaves the device with these. */
export const VOICE_TTS_OFFLINE_ENGINE_IDS: readonly VoiceTtsEngineId[] = ['system', 'local']

export function isVoiceTtsEngineId(value: unknown): value is VoiceTtsEngineId {
  return typeof value === 'string' && VOICE_TTS_ENGINE_IDS.includes(value as VoiceTtsEngineId)
}

/** One selectable speaker. */
export interface VoiceTtsVoice {
  /**
   * `local:<modelId>:<speakerId>`, `system:<name>` or
   * `elevenlabs:<voice_id>`. Stable across restarts.
   */
  id: string
  label: string
  engine: VoiceTtsEngineId
  /** Speaker index inside the model. Always 0 for a system voice. */
  speakerId: number
  /** Model the speaker belongs to. Empty for a system voice. */
  modelId: string
  /** BCP-47 tag. */
  language: string
  /** Shown next to the name so a list of eleven names is readable. */
  description: string
}

// ── Speed ───────────────────────────────────────────────────

export const VOICE_TTS_DEFAULT_SPEED = 1.0
export const VOICE_TTS_SPEED_CHOICES = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5] as const
export const VOICE_TTS_MIN_SPEED = 0.5
export const VOICE_TTS_MAX_SPEED = 2

export function clampSpeechSpeed(value: number): number {
  if (!Number.isFinite(value)) return VOICE_TTS_DEFAULT_SPEED
  return Math.min(VOICE_TTS_MAX_SPEED, Math.max(VOICE_TTS_MIN_SPEED, value))
}

// ── Status ──────────────────────────────────────────────────

export type VoiceTtsStatus =
  /** No usable engine at all: no system voice and no local model. */
  | { state: 'unavailable'; message: string }
  /** The local engine is selected but its runtime or model is missing. */
  | { state: 'model_missing'; message: string }
  | { state: 'loading' }
  | {
      state: 'ready'
      engine: VoiceTtsEngineId
      /** Empty for the system engine. */
      modelId: string
      voiceId: string
      sampleRate: number
    }
  | { state: 'error'; message: string }

/** Everything the renderer needs to draw the spoken-answer settings. */
export interface VoiceTtsSnapshot {
  /** The user switch: "speak agent answers". */
  enabled: boolean
  engine: VoiceTtsEngineId
  status: VoiceTtsStatus
  voices: VoiceTtsVoice[]
  voiceId: string
  speed: number
  /** Automatic speech stops after this many characters (design §5.7). */
  maxChars: number
  /** Speak "Task created." and the other short action results. */
  speakActionResults: boolean
  /** Speak only the answer to a question that was asked by voice. */
  onlyVoiceTurns: boolean
  models: VoiceTtsModelState[]
  /** True while something is being spoken. */
  speaking: boolean
  /** The hosted engine's account state. Never carries the key (#64). */
  elevenlabs: VoiceTtsElevenLabsState
}

// ── ElevenLabs (#64) ────────────────────────────────────────

/**
 * Why a call to ElevenLabs failed, in the terms the settings page can act on.
 *
 * Each kind has its own fix — a new key, more credits, a slower pace, another
 * model, the network — so the kind travels with the message rather than being
 * guessed from it.
 */
export type VoiceTtsElevenLabsErrorKind =
  | 'auth'
  | 'permission'
  | 'quota'
  | 'rate_limit'
  | 'unsupported_model'
  | 'network'
  | 'unknown'

export interface VoiceTtsElevenLabsError {
  kind: VoiceTtsElevenLabsErrorKind
  message: string
}

/** One ElevenLabs model that the streaming endpoint can use. */
export interface VoiceTtsElevenLabsModel {
  id: string
  name: string
  description: string
  /** BCP-47-ish tags the model covers, as ElevenLabs reports them. */
  languages: string[]
}

/** The ElevenLabs part of the settings snapshot. The key itself never crosses IPC. */
export interface VoiceTtsElevenLabsState {
  /** True when a key is stored. The renderer never learns its value. */
  keySet: boolean
  /** The disclosure was acknowledged. Required before the engine can be selected. */
  disclosureAccepted: boolean
  /** The selected model id; `VOICE_TTS_ELEVENLABS_DEFAULT_MODEL` until chosen. */
  modelId: string
  /** Models compatible with the streaming endpoint. Empty until loaded. */
  models: VoiceTtsElevenLabsModel[]
  /** Voices of the account. Empty until loaded. Also in `voices` when the engine is selected. */
  voices: VoiceTtsVoice[]
  /** The last failure, or null when the last call succeeded. */
  error: VoiceTtsElevenLabsError | null
  /** Characters used and allowed this billing period, when the account says. */
  usage: { used: number; limit: number } | null
}

/**
 * The default model. Flash is the lowest-latency family, which is what a
 * spoken conversation needs; quality models can be picked in settings.
 */
export const VOICE_TTS_ELEVENLABS_DEFAULT_MODEL = 'eleven_flash_v2_5'

/**
 * What the user acknowledges before ElevenLabs can be selected. Shown in
 * settings and recorded in `VOICE_TTS_SETTING_KEYS.elevenlabsDisclosure`.
 */
export const VOICE_TTS_ELEVENLABS_DISCLOSURE = [
  'The text of every spoken reply, preview and report is sent to ElevenLabs to be turned into speech. It leaves this computer.',
  'Generation uses your ElevenLabs account and may consume paid credits.',
  'ElevenLabs’ terms of service, privacy policy and data-retention rules apply to that text.',
] as const

export const VOICE_TTS_ELEVENLABS_TERMS_URL = 'https://elevenlabs.io/terms-of-use'
export const VOICE_TTS_ELEVENLABS_PRIVACY_URL = 'https://elevenlabs.io/privacy-policy'

/** The empty state, for a build or a moment where nothing is known yet. */
export const VOICE_TTS_ELEVENLABS_EMPTY_STATE: VoiceTtsElevenLabsState = {
  keySet: false,
  disclosureAccepted: false,
  modelId: VOICE_TTS_ELEVENLABS_DEFAULT_MODEL,
  models: [],
  voices: [],
  error: null,
  usage: null,
}

// ── Model catalogue ─────────────────────────────────────────

/**
 * A speech model ships as one archive, not as loose files: every voice needs an
 * `espeak-ng-data` directory of about 355 files, and downloading those one by
 * one would be slow and impossible to keep verified. The archive carries one
 * SHA-256 and is extracted only after that value matches.
 */
export interface VoiceTtsModelManifestEntry {
  id: string
  label: string
  description: string
  languages: string[]
  license: string
  licenseUrl: string
  /** Refuse the download below this much memory. */
  minMemoryBytes: number
  archive: {
    url: string
    /** Lower-case hex SHA-256 of the downloaded archive. */
    sha256: string
    sizeBytes: number
    /** Bytes on disk after extraction. Shown before the download. */
    unpackedBytes: number
    /** Single top-level directory inside the archive. */
    rootDir: string
    format: 'tar.bz2'
  }
  /** Paths relative to the extracted directory. */
  files: {
    /** ONNX weights. */
    model: string
    /** Speaker embeddings. */
    voices: string
    tokens: string
    /** The espeak-ng phonemiser data directory. */
    dataDir: string
  }
  /** Which `sherpa-onnx` model family the worker must configure. */
  family: 'kokoro' | 'kitten'
  sampleRate: number
  /** Speakers offered to the user, in the model's own speaker order. */
  speakers: VoiceTtsSpeaker[]
  /**
   * Speaker indexes deliberately not offered, with the reason. Kept in the
   * manifest so the decision is visible in code, not only in a document.
   */
  withheldSpeakers?: { speakerId: number; name: string; reason: string }[]
}

export interface VoiceTtsSpeaker {
  /** Index the model itself uses. Never renumbered. */
  speakerId: number
  /** The model's own speaker name, kept so a bug report is unambiguous. */
  name: string
  label: string
  description: string
}

export interface VoiceTtsModelState {
  id: string
  label: string
  description: string
  license: string
  licenseUrl: string
  languages: string[]
  installed: boolean
  active: boolean
  installing: boolean
  /** 0..1 */
  progress: number
  sizeBytes: number
  unpackedBytes: number
  /** False when the manifest has no verified checksum yet. */
  downloadable: boolean
  speakerCount: number
  error?: string
}

// ── One spoken passage ──────────────────────────────────────

/**
 * Why 20x is speaking. The source decides whether the passage may be spoken at
 * all, so it is never inferred from the text.
 */
export type VoiceSpeechSource =
  /** The final answer to a question the user asked by voice. */
  | 'agent_answer'
  /** A short result such as "Task created." */
  | 'action_result'
  /** The user asked for the last answer to be read. */
  | 'read_last_answer'
  /** The speaker sample in settings. */
  | 'preview'
  /** The user pressed the speak button on one message. */
  | 'manual'
  /**
   * A reply or a report in a voice conversation the user opened on purpose —
   * Commander voice mode (#64). Opening the conversation is the request to be
   * spoken to, so it needs neither the automatic switch nor a voice turn.
   */
  | 'conversation'

export interface VoiceSpeechRequest {
  text: string
  source: VoiceSpeechSource
  /** Task the passage belongs to. Used to drop an answer the user left. */
  taskId?: string
  /**
   * The voice turn that asked for this passage (design §5.7). A passage whose
   * turn is no longer the current one is never spoken, so 20x cannot read out
   * an unrelated background answer.
   */
  voiceTurnId?: string
  /** Overrides the selected speaker. Used by the preview button only. */
  voiceId?: string
}

export interface VoiceSpeechStartEvent {
  speechId: string
  /** Monotonic main-process lease. Older passages must never replace a newer one. */
  speechGeneration: number
  source: VoiceSpeechSource
  /** The cleaned text, exactly as it will be spoken. */
  text: string
  taskId?: string
  sampleRate: number
  /** True when the passage was cut at `maxChars`. */
  truncated: boolean
}

export interface VoiceSpeechChunkEvent {
  speechId: string
  /** Matches the generation announced by `VoiceSpeechStartEvent`. */
  speechGeneration: number
  /** 0-based order. The renderer plays chunks back to back. */
  index: number
  /** Mono signed 16-bit little-endian PCM. */
  pcm: Uint8Array
  sampleRate: number
  /** The sentence this chunk carries, for the caption. */
  text: string
}

export type VoiceSpeechEndReason = 'complete' | 'cancelled' | 'error' | 'skipped'

export interface VoiceSpeechEndEvent {
  speechId: string
  /** Matches the generation announced by `VoiceSpeechStartEvent`. */
  speechGeneration: number
  reason: VoiceSpeechEndReason
  message?: string
}

// ── Settings keys ───────────────────────────────────────────

export const VOICE_TTS_SETTING_KEYS = {
  /** Speak agent answers at all. Off until the user asks for it. */
  enabled: 'voice_tts_enabled',
  engine: 'voice_tts_engine',
  modelId: 'voice_tts_model_id',
  voiceId: 'voice_tts_voice_id',
  speed: 'voice_tts_speed',
  maxChars: 'voice_tts_max_chars',
  speakActionResults: 'voice_tts_speak_results',
  onlyVoiceTurns: 'voice_tts_only_voice_turns',
  /**
   * The ElevenLabs key (#64). The `_api_key` suffix is what puts it on the
   * encrypted settings path: stored with the OS keychain when available, read
   * back as plaintext in main only, and shown to the renderer as a marker.
   */
  elevenlabsApiKey: 'elevenlabs_api_key',
  /** `elevenlabs:<voice_id>`, remembered across engine changes. */
  elevenlabsVoiceId: 'voice_tts_elevenlabs_voice_id',
  elevenlabsModelId: 'voice_tts_elevenlabs_model_id',
  /** 'true' once the user has acknowledged the disclosure. */
  elevenlabsDisclosure: 'voice_tts_elevenlabs_disclosure',
} as const

/**
 * Automatic speech stops here and the user can ask for the rest (design §5.7).
 * About two minutes of speech.
 */
export const VOICE_TTS_DEFAULT_MAX_CHARS = 1200
export const VOICE_TTS_MAX_CHARS_CHOICES = [400, 800, 1200, 2400] as const
/** Nothing above this is ever spoken automatically, whatever the setting says. */
export const VOICE_TTS_HARD_MAX_CHARS = 6000

// ── IPC channel names ───────────────────────────────────────

export const VOICE_TTS_EVENTS = {
  /** `VoiceSpeechStartEvent` */
  speechStart: 'voice:speech:start',
  /** `VoiceSpeechChunkEvent` */
  speechChunk: 'voice:speech:chunk',
  /** `VoiceSpeechEndEvent` */
  speechEnd: 'voice:speech:end',
  /** `VoiceTtsSnapshot` */
  ttsStatus: 'voice:tts:status',
  /**
   * `{ model: VoiceTtsModelState }` while a voice downloads.
   *
   * A voice is 26 MB or 103 MB, so the whole snapshot is not rebuilt for every
   * chunk: one model state goes to the renderer and is merged into the list.
   */
  ttsModelProgress: 'voice:tts:modelProgress',
} as const

// ── Spoken-text preparation (design §5.7) ───────────────────

export interface SpokenTextResult {
  text: string
  truncated: boolean
  /** How many fenced code blocks were replaced by a short notice. */
  codeBlocks: number
}

const CODE_FENCE = /^[ \t]*(?:```|~~~)/
const TABLE_NOTICE = 'A table is in the message.'

/** Names a code block instead of reading it out. */
function codeNotice(lines: number): string {
  return lines === 1 ? 'One line of code is in the message.' : `A code block of ${lines} lines is in the message.`
}

/**
 * Turns one assistant answer into something worth hearing.
 *
 * The rules come straight from design §5.7: never speak a code block, a file
 * path, a raw URL, a table, hidden reasoning or Markdown punctuation, and stop
 * at a character limit instead of reading for ten minutes.
 *
 * It is deliberately a pure function over the text. It does not decide *whether*
 * a passage may be spoken — `VoiceSpeechSource` decides that.
 */
export function toSpokenText(markdown: string, maxChars = VOICE_TTS_DEFAULT_MAX_CHARS): SpokenTextResult {
  const limit = Math.min(Math.max(1, Math.floor(maxChars)), VOICE_TTS_HARD_MAX_CHARS)
  const lines = String(markdown ?? '').split(/\r?\n/)
  const out: string[] = []
  let codeBlocks = 0
  let insideFence = false
  let fenceLines = 0

  for (const line of lines) {
    if (CODE_FENCE.test(line)) {
      if (insideFence) {
        // Say how big it was and move on. Reading code aloud helps nobody.
        out.push(codeNotice(fenceLines))
        insideFence = false
        fenceLines = 0
      } else {
        insideFence = true
        fenceLines = 0
        codeBlocks += 1
      }
      continue
    }
    if (insideFence) {
      fenceLines += 1
      continue
    }
    // A table reads as a wall of pipes. Name it instead.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (out[out.length - 1] !== TABLE_NOTICE) out.push(TABLE_NOTICE)
      continue
    }
    out.push(cleanLine(line))
  }
  // An answer that ends inside a fence still has to say something about it.
  if (insideFence) {
    out.push(codeNotice(fenceLines))
  }

  let text = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()

  let truncated = false
  if (text.length > limit) {
    text = cutAtSentence(text, limit)
    truncated = true
  }
  return { text, truncated, codeBlocks }
}

/** Strips the Markdown a listener cannot hear. */
function cleanLine(line: string): string {
  return (
    line
      // Inline code: keep the words, drop the backticks.
      .replace(/`([^`]+)`/g, '$1')
      // Images carry no spoken content at all.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      // Links: say the label, never the address.
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // A bare address is unlistenable.
      .replace(/\bhttps?:\/\/\S+/gi, 'a link')
      // A path is worse: nobody can follow "src slash main slash voice slash".
      // Two shapes are named — an absolute or home path, and a repository path
      // with at least two separators, which is what an agent answer contains.
      .replace(/(^|\s)(?:[A-Za-z]:\\|~[\\/]|\/)(?:[\w.@+-]+[\\/])*[\w.@+-]+/g, '$1a file path')
      .replace(/(^|\s)(?:[\w.@+-]+[\\/]){2,}[\w.@+-]+/g, '$1a file path')
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d+[.)]\s+/, '')
      .replace(/^\s*[-*_]{3,}\s*$/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .trimEnd()
  )
}

/** Cuts at the last sentence end before the limit, so speech never stops mid-word. */
function cutAtSentence(text: string, limit: number): string {
  const head = text.slice(0, limit)
  const lastStop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.\n'), head.lastIndexOf('! '), head.lastIndexOf('? '))
  if (lastStop > limit * 0.5) return head.slice(0, lastStop + 1).trim()
  const lastSpace = head.lastIndexOf(' ')
  return (lastSpace > 0 ? head.slice(0, lastSpace) : head).trim()
}

// ── Sentence splitting ──────────────────────────────────────

/**
 * The longest passage handed to the model at once.
 *
 * Speech is generated sentence by sentence so playback can start after the
 * first one instead of after the whole answer. The neural model runs at roughly
 * real time, so a long sentence is also a long wait.
 */
export const VOICE_TTS_MAX_SENTENCE_CHARS = 240

/**
 * Splits a passage into speakable sentences.
 *
 * A sentence longer than `maxChars` is split again at a comma or a space, so no
 * single call to the model can block playback for many seconds.
 */
export function splitIntoSentences(text: string, maxChars = VOICE_TTS_MAX_SENTENCE_CHARS): string[] {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return []
  const rough = trimmed
    // Keep the punctuation with the sentence it ends. The NUL marker cannot
    // appear in an assistant answer, so it never splits real text.
    .replace(/([.!?…])\s+(?=[^\s])/g, '$1\u0000')
    .split(/\u0000|\n{2,}/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  const out: string[] = []
  for (const sentence of rough) {
    if (sentence.length <= maxChars) {
      out.push(sentence)
      continue
    }
    out.push(...breakLongSentence(sentence, maxChars))
  }
  return out
}

/**
 * How long the first thing said may be.
 *
 * A sentence is produced whole before any of it can be heard, so the first one
 * sets the wait before the answer starts. A long opening sentence is therefore
 * broken at a clause.
 *
 * Measured on the natural voice, through the real worker, for one answer:
 *
 *   opening  119 chars -> first sound 5.4 s
 *   opening   84 chars -> first sound 4.1 s
 *   opening   55 chars -> first sound 2.9 s
 *   opening   33 chars -> first sound 1.8 s
 *
 * Shorter is not simply better. The natural voice produces speech at about the
 * speed of speech, so an opening much shorter than what follows is heard out
 * before the next piece is ready, and the answer stalls in the middle — which
 * is worse than a longer wait at the start. Sixty is the point where the
 * opening still covers the piece behind it.
 */
export const VOICE_TTS_LEAD_IN_CHARS = 60

/** Where a sentence may be broken without sounding cut in half. */
const CLAUSE_BREAKS = [', ', '; ', ': ', ' — ', ' – ']

/**
 * Shortens the opening of a passage so speech starts sooner.
 *
 * Only the first sentence is touched, and only when it is long: every later
 * sentence is produced while the previous one is still being heard, so its
 * length costs nothing.
 */
export function withShortLeadIn(
  sentences: string[],
  leadInChars = VOICE_TTS_LEAD_IN_CHARS
): string[] {
  const first = sentences[0]
  if (!first || first.length <= leadInChars) return sentences

  let cut = -1
  for (const marker of CLAUSE_BREAKS) {
    const at = first.lastIndexOf(marker, leadInChars)
    if (at > cut) cut = at + marker.length - 1
  }
  // No clause to break at: a word boundary still beats waiting for the lot.
  if (cut < leadInChars / 3) cut = first.lastIndexOf(' ', leadInChars)
  if (cut < leadInChars / 3) return sentences

  const head = first.slice(0, cut + 1).trim()
  const tail = first.slice(cut + 1).trim()
  if (!head || !tail) return sentences
  return [head, tail, ...sentences.slice(1)]
}

/**
 * Splits a passage that is still being written.
 *
 * An answer arrives a few words at a time, and speech must start before the
 * last word does. Only sentences that are certainly finished are returned; the
 * tail is held back, because "The test failed" and "The test failed to start"
 * are read very differently and the difference is one word that has not
 * arrived yet.
 *
 * Pass `final` when nothing more is coming, and the tail is released too.
 */
export function splitStreamingSentences(
  text: string,
  final = false,
  maxChars = VOICE_TTS_MAX_SENTENCE_CHARS
): { sentences: string[]; remainder: string } {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return { sentences: [], remainder: '' }

  const sentences = splitIntoSentences(trimmed, maxChars)
  if (final || sentences.length === 0) return { sentences, remainder: '' }

  // The writer stopped on a full stop, so even the last one is finished.
  if (/[.!?…:]["')\]]?$/.test(trimmed)) return { sentences, remainder: '' }

  const remainder = sentences[sentences.length - 1]
  return { sentences: sentences.slice(0, -1), remainder }
}

function breakLongSentence(sentence: string, maxChars: number): string[] {
  const parts: string[] = []
  let rest = sentence
  while (rest.length > maxChars) {
    const head = rest.slice(0, maxChars)
    let cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '))
    if (cut < maxChars * 0.4) cut = head.lastIndexOf(' ')
    if (cut <= 0) cut = maxChars
    parts.push(rest.slice(0, cut + 1).trim())
    rest = rest.slice(cut + 1).trim()
  }
  if (rest) parts.push(rest)
  return parts.filter(Boolean)
}
