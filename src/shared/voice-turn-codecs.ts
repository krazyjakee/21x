/**
 * Wire codecs for the live half of voice in the Tauri host: microphone turns,
 * confirmations, spoken answers and Commander voice mode.
 *
 * There is no permission operation: the WebView asks for the microphone
 * itself, and the window reads an unbound `voice.getPermission` as
 * `unsupported`, meaning no separate OS gate.
 *
 * Management (models, runtime, settings) lives in voice-management-codecs.ts.
 * Audio crosses the wire as base64: 16 kHz mono PCM from the microphone, and
 * mono 16-bit PCM chunks of synthesized speech for the window to play.
 *
 * Event encoders normalise rather than reject. An event that fails to encode
 * takes the whole desktop connection down, so a long transcript is shortened
 * and unknown keys are dropped instead.
 */
import type { DesktopCommandMap, DesktopEventMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { VOICE_TRANSITIONS } from './voice'
import { COMMANDER_COMMAND_CODECS } from './commander-desktop-codecs'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const VOICE_TURN_OPERATIONS = [
  'voice:startTurn', 'voice:pushAudio', 'voice:endTurn', 'voice:cancelTurn',
  'voice:confirm', 'voice:dismiss', 'voice:expectAnswer', 'voice:answerNotExpected',
  'voice:tts:preview', 'voice:tts:speak', 'voice:tts:stop',
  'voice:commander:setActive', 'voice:commander:bargeIn', 'voice:commander:send'
] as const
export type VoiceTurnOperation = typeof VOICE_TURN_OPERATIONS[number]
export const VOICE_TURN_EVENTS = [
  'voice:state', 'voice:partial', 'voice:final', 'voice:segment', 'voice:outcome', 'voice:error', 'voice:navigate', 'voice:dictate', 'voice:hotkey',
  'voice:speech:start', 'voice:speech:chunk', 'voice:speech:end'
] as const
export type VoiceTurnEvent = typeof VOICE_TURN_EVENTS[number]
export const VOICE_TURN_LIMITS = {
  /** One push is about 100 ms of 16 kHz audio (3,200 bytes); allow slack. */
  audioBytes: 64 * 1024,
  /** One speech chunk decodes to at most 128 KiB (voice-tts worker contract). */
  speechBytes: 128 * 1024,
  textBytes: 65536,
  idBytes: 128,
  frameBytes: 256 * 1024
} as const

const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
const shape = (v: unknown, required: readonly string[], optional: readonly string[] = []): v is Record<string, unknown> => isRecord(v) && hasExactKeys(v, [...required], [...optional])
const bytes = (v: string): number => new TextEncoder().encode(v).length
const text = (v: unknown, max: number = VOICE_TURN_LIMITS.textBytes): v is string => typeof v === 'string' && !v.includes('\0') && bytes(v) <= max
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)
const natural = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const bounded = (v: unknown): boolean => isJsonValue(v) && bytes(JSON.stringify(v)) <= VOICE_TURN_LIMITS.frameBytes
const MODES = ['dictation', 'command', 'conversation']
const VIEWS = ['tasks', 'skills', 'dashboard', 'canvas', 'commander', 'overview', 'settings']
const SOURCES = ['agent_answer', 'action_result', 'read_last_answer', 'preview', 'manual', 'conversation']
const END_REASONS = ['complete', 'cancelled', 'error', 'skipped']
const OUTCOMES = ['needs_confirmation', 'executed', 'rejected', 'dictation', 'completed', 'cancelled']

/** Shortens a string to `max` UTF-8 bytes without splitting a character. */
function clip(value: unknown, max: number = VOICE_TURN_LIMITS.textBytes): string {
  let out = String(value ?? '').replace(/\0/g, '')
  if (bytes(out) <= max) return out
  const encoded = new TextEncoder().encode(out).slice(0, max)
  out = new TextDecoder('utf-8', { fatal: false }).decode(encoded)
  // A cut through a multi-byte character leaves a replacement character.
  return out.endsWith('�') ? out.slice(0, -1) : out
}

// ── base64 without Node or DOM dependencies ─────────────────

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const LOOKUP = new Map([...ALPHABET].map((char, index) => [char, index]))
export function encodeVoiceBase64(data: Uint8Array): string {
  let out = ''
  for (let i = 0; i < data.length; i += 3) {
    const a = data[i], b = data[i + 1], c = data[i + 2]
    out += ALPHABET[a >> 2] + ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : ALPHABET[c & 63]
  }
  return out
}
export function decodeVoiceBase64(value: unknown, max: number): Uint8Array | null {
  if (typeof value !== 'string' || value.length % 4 !== 0 || value.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const out = new Uint8Array((value.length / 4) * 3 - padding)
  let o = 0
  for (let i = 0; i < value.length; i += 4) {
    const n = [0, 1, 2, 3].map(k => LOOKUP.get(value[i + k]) ?? 0)
    const triple = (n[0] << 18) | (n[1] << 12) | (n[2] << 6) | n[3]
    if (o < out.length) out[o++] = (triple >> 16) & 255
    if (o < out.length) out[o++] = (triple >> 8) & 255
    if (o < out.length) out[o++] = triple & 255
  }
  return out.length <= max ? out : null
}
const pcm = (v: unknown, max: number): v is Uint8Array => v instanceof Uint8Array && v.length >= 2 && v.length <= max && v.length % 2 === 0
const asBytes = (v: unknown): Uint8Array | null => v instanceof Uint8Array ? v : Array.isArray(v) && v.every(item => natural(item) && item < 256) ? Uint8Array.from(v as number[]) : null

// ── Shared payload shapes ───────────────────────────────────

const context = (v: unknown): boolean => shape(v, [], ['selectedTaskId', 'view', 'pendingApproval', 'visibleTaskIds']) &&
  (v.selectedTaskId === undefined || v.selectedTaskId === null || id(v.selectedTaskId)) &&
  (v.view === undefined || VIEWS.includes(v.view as string)) &&
  (v.pendingApproval === undefined || v.pendingApproval === null || shape(v.pendingApproval, ['taskId', 'sessionId']) && id(v.pendingApproval.taskId) && id(v.pendingApproval.sessionId)) &&
  (v.visibleTaskIds === undefined || Array.isArray(v.visibleTaskIds) && v.visibleTaskIds.length <= 500 && v.visibleTaskIds.every(id))
/** Keeps only the fields main reads, so a renderer cannot widen the context. */
function normaliseContext(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) return {}
  const out: Record<string, unknown> = {}
  if (v.selectedTaskId === null || id(v.selectedTaskId)) out.selectedTaskId = v.selectedTaskId
  if (VIEWS.includes(v.view as string)) out.view = v.view
  if (v.pendingApproval === null) out.pendingApproval = null
  else if (isRecord(v.pendingApproval) && id(v.pendingApproval.taskId) && id(v.pendingApproval.sessionId)) out.pendingApproval = { taskId: v.pendingApproval.taskId, sessionId: v.pendingApproval.sessionId }
  if (Array.isArray(v.visibleTaskIds)) out.visibleTaskIds = v.visibleTaskIds.filter(id).slice(0, 500)
  return out
}
const choice = (v: unknown): boolean => shape(v, [], ['taskId', 'agentName']) && (v.taskId === undefined || id(v.taskId)) && (v.agentName === undefined || text(v.agentName, 512))
const spoken = (v: unknown): boolean => shape(v, ['spoken']) && typeof v.spoken === 'boolean'
const success = (v: unknown): boolean => shape(v, ['success']) && typeof v.success === 'boolean'


interface Descriptor {
  keys: string[]
  optionalKeys?: string[]
  args(v: unknown[]): boolean
  /** Undefined results travel as `{ defined: false }`. */
  result(v: unknown): boolean
  encodeArgs?(v: unknown[]): Record<string, JsonValue>
  decodeArgs?(v: Record<string, unknown>): unknown[]
  encodeResult?(v: unknown): unknown
}
const none = (v: unknown): boolean => v === undefined
const noArgs = (v: unknown[]): boolean => v.length === 0
/** Trailing optional arguments may be absent or undefined. */
const optionalTail = (v: unknown[], required: number): unknown[] => { const out = [...v]; while (out.length > required && out[out.length - 1] === undefined) out.pop(); return out }
const descriptors: Record<VoiceTurnOperation, Descriptor> = {
  'voice:startTurn': {
    // The renderer's context may carry more than main reads; both ends keep
    // only the known fields, so the handler never sees anything wider.
    keys: ['mode', 'context'], args: v => v.length === 2 && MODES.includes(v[0] as string) && isRecord(v[1]) && context(normaliseContext(v[1])),
    encodeArgs: v => ({ mode: v[0] as string, context: normaliseContext(v[1]) as JsonValue }),
    decodeArgs: v => [v.mode, normaliseContext(v.context)],
    result: v => shape(v, ['turnId'], ['turnEpoch']) && id(v.turnId) && (v.turnEpoch === undefined || id(v.turnEpoch)) || shape(v, ['error']) && text(v.error, 4096),
    encodeResult: v => isRecord(v) && typeof v.error === 'string' ? { error: clip(v.error, 4096) } : isRecord(v) ? { turnId: v.turnId, ...(v.turnEpoch === undefined || v.turnEpoch === null ? {} : { turnEpoch: v.turnEpoch }) } : v
  },
  'voice:pushAudio': {
    keys: ['turnId', 'chunk'], args: v => v.length === 2 && id(v[0]) && pcm(v[1], VOICE_TURN_LIMITS.audioBytes),
    encodeArgs: v => ({ turnId: v[0] as string, chunk: encodeVoiceBase64(v[1] as Uint8Array) }),
    decodeArgs: v => [v.turnId, decodeVoiceBase64(v.chunk, VOICE_TURN_LIMITS.audioBytes)],
    result: none
  },
  'voice:endTurn': { keys: ['turnId'], args: v => v.length === 1 && id(v[0]), result: none },
  'voice:cancelTurn': {
    keys: [], optionalKeys: ['turnId', 'turnEpoch'],
    args: v => { const a = optionalTail(v, 0); return a.length <= 2 && (a[0] === undefined || id(a[0])) && (a[1] === undefined || id(a[1])) },
    encodeArgs: v => ({ ...(v[0] === undefined ? {} : { turnId: v[0] as string }), ...(v[1] === undefined ? {} : { turnEpoch: v[1] as string }) }),
    decodeArgs: v => optionalTail([v.turnId, v.turnEpoch], 0),
    result: none
  },
  'voice:confirm': {
    keys: ['turnId'], optionalKeys: ['choice', 'turnEpoch'],
    args: v => { const a = optionalTail(v, 1); return a.length >= 1 && a.length <= 3 && id(a[0]) && (a[1] === undefined || choice(a[1])) && (a[2] === undefined || id(a[2])) },
    encodeArgs: v => ({ turnId: v[0] as string, ...(v[1] === undefined ? {} : { choice: v[1] as JsonValue }), ...(v[2] === undefined ? {} : { turnEpoch: v[2] as string }) }),
    decodeArgs: v => optionalTail([v.turnId, v.choice, v.turnEpoch], 1),
    result: success
  },
  'voice:dismiss': {
    keys: ['turnId'], optionalKeys: ['turnEpoch'],
    args: v => { const a = optionalTail(v, 1); return a.length >= 1 && a.length <= 2 && id(a[0]) && (a[1] === undefined || id(a[1])) },
    encodeArgs: v => ({ turnId: v[0] as string, ...(v[1] === undefined ? {} : { turnEpoch: v[1] as string }) }),
    decodeArgs: v => optionalTail([v.turnId, v.turnEpoch], 1),
    result: none
  },
  'voice:expectAnswer': {
    keys: ['turnId'], optionalKeys: ['taskId'],
    args: v => { const a = optionalTail(v, 1); return a.length >= 1 && a.length <= 2 && id(a[0]) && (a[1] === undefined || id(a[1])) },
    encodeArgs: v => ({ turnId: v[0] as string, ...(v[1] === undefined ? {} : { taskId: v[1] as string }) }),
    decodeArgs: v => optionalTail([v.turnId, v.taskId], 1),
    result: none
  },
  'voice:answerNotExpected': {
    keys: [], optionalKeys: ['taskId'],
    args: v => { const a = optionalTail(v, 0); return a.length <= 1 && (a[0] === undefined || id(a[0])) },
    encodeArgs: v => (v[0] === undefined ? {} : { taskId: v[0] as string }) as Record<string, JsonValue>,
    decodeArgs: v => optionalTail([v.taskId], 0),
    result: none
  },
  'voice:tts:preview': { keys: ['voiceId'], args: v => v.length === 1 && text(v[0], 512), result: spoken },
  'voice:tts:speak': {
    keys: ['text'], optionalKeys: ['taskId'],
    args: v => { const a = optionalTail(v, 1); return a.length >= 1 && a.length <= 2 && text(a[0]) && (a[1] === undefined || id(a[1])) },
    encodeArgs: v => ({ text: v[0] as string, ...(v[1] === undefined ? {} : { taskId: v[1] as string }) }),
    decodeArgs: v => optionalTail([v.text, v.taskId], 1),
    result: spoken
  },
  'voice:tts:stop': { keys: [], args: noArgs, result: none },
  'voice:commander:setActive': {
    keys: ['sessionId'], args: v => v.length === 1 && (v[0] === null || id(v[0])),
    result: v => shape(v, ['active']) && (v.active === null || id(v.active))
  },
  'voice:commander:bargeIn': { keys: ['sessionId'], args: v => v.length === 1 && id(v[0]), result: v => shape(v, ['cancelled']) && typeof v.cancelled === 'boolean' },
  'voice:commander:send': {
    keys: ['sessionId', 'text'], args: v => v.length === 2 && id(v[0]) && text(v[1]) && (v[1] as string).trim().length > 0,
    result: v => COMMANDER_COMMAND_CODECS['commander:send'].validateResult(v)
  }
}

export interface VoiceTurnCodec<K extends VoiceTurnOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(v: unknown): boolean
  encodeResult(v: unknown): OptionalResult<JsonValue>
  decodeResult(v: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(v: unknown): boolean
  validateWireResult(v: unknown): boolean
}
function codec<K extends VoiceTurnOperation>(operation: K): VoiceTurnCodec<K> {
  const d = descriptors[operation]
  const valid = (v: unknown): boolean => d.result(v) && (v === undefined || bounded(v))
  const voidResult = d.result === none
  return {
    validateArguments: v => Array.isArray(v) && d.args(v),
    encodeArguments(args) {
      const list = args as unknown[]
      if (!d.args(list)) return fail('INVALID_ARGUMENTS')
      return (d.encodeArgs ? d.encodeArgs(list) : Object.fromEntries(d.keys.map((key, index) => [key, list[index] as JsonValue]))) as JsonValue
    },
    decodeArguments(payload) {
      if (!shape(payload, d.keys, d.optionalKeys ?? [])) return fail('INVALID_ARGUMENTS')
      const args = d.decodeArgs ? d.decodeArgs(payload) : d.keys.map(key => payload[key])
      if (!d.args(args)) return fail('INVALID_ARGUMENTS')
      return args as DesktopCommandMap[K]['apiArguments']
    },
    validateResult: valid,
    encodeResult(v) {
      if (voidResult) return { defined: false }
      const projected = d.encodeResult ? d.encodeResult(v) : v
      if (!valid(projected)) return fail('INVALID_RESULT')
      return { defined: true, value: projected as JsonValue }
    },
    decodeResult(v) {
      if (voidResult) return undefined as DesktopCommandMap[K]['result']
      if (!valid(v)) return fail('INVALID_RESULT')
      return v as DesktopCommandMap[K]['result']
    },
    validateWireResult: v => voidResult ? shape(v, ['defined']) && v.defined === false : shape(v, ['defined', 'value']) && v.defined === true && valid(v.value)
  }
}
export const VOICE_TURN_CODECS = Object.fromEntries(VOICE_TURN_OPERATIONS.map(op => [op, codec(op)])) as { [K in VoiceTurnOperation]: VoiceTurnCodec<K> }

// ── Events ──────────────────────────────────────────────────

const owner = (v: Record<string, unknown>): boolean => (v.turnId === undefined || v.turnId === null || id(v.turnId)) && (v.turnEpoch === undefined || v.turnEpoch === null || id(v.turnEpoch))
const pick = (v: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!isRecord(v)) return {}
  return Object.fromEntries(keys.filter(key => v[key] !== undefined).map(key => [key, v[key]]))
}
const turnText = (v: unknown, segment = false): boolean => shape(v, ['turnId', 'turnEpoch', 'text', ...(segment ? ['index'] : [])]) && id(v.turnId) && (v.turnEpoch === null || id(v.turnEpoch)) && text(v.text) && (!segment || natural(v.index))
function outcome(v: unknown): boolean {
  if (!isRecord(v) || !OUTCOMES.includes(v.status as string) || !id(v.turnId) || (v.turnEpoch !== undefined && !id(v.turnEpoch)) || !bounded(v)) return false
  const base = ['status', 'turnId'], epoch = ['turnEpoch']
  switch (v.status) {
    case 'cancelled': return shape(v, base, epoch)
    case 'completed': return shape(v, [...base, 'segments'], epoch) && natural(v.segments)
    case 'dictation': return shape(v, [...base, 'text'], epoch) && text(v.text)
    case 'executed': return shape(v, [...base, 'intent', 'message'], [...epoch, 'taskId']) && text(v.intent, 64) && text(v.message) && (v.taskId === undefined || id(v.taskId))
    case 'rejected': return shape(v, [...base, 'reason', 'message'], epoch) && text(v.reason, 64) && text(v.message)
    default: return shape(v, [...base, 'proposal', 'reason'], [...epoch, 'candidates']) && isRecord(v.proposal) && text(v.reason, 64) &&
      (v.candidates === undefined || Array.isArray(v.candidates) && v.candidates.length <= 16 && v.candidates.every(c => shape(c, ['id', 'label', 'kind']) && id(c.id) && text(c.label, 4096) && ['task', 'agent'].includes(c.kind as string)))
  }
}
function normaliseOutcome(v: unknown): unknown {
  if (!isRecord(v)) return v
  const keys = ['status', 'turnId', 'turnEpoch', 'text', 'segments', 'intent', 'message', 'taskId', 'reason', 'proposal', 'candidates']
  const out = pick(v, keys)
  for (const key of ['text', 'message']) if (out[key] !== undefined) out[key] = clip(out[key])
  if (out.turnEpoch === null) delete out.turnEpoch
  return out
}

interface EventDescriptor { valid(v: unknown): boolean; normalise(v: unknown): unknown; toWire?(v: Record<string, unknown>): Record<string, unknown>; fromWire?(v: Record<string, unknown>): unknown }
const turnTextEvent = (segment = false): EventDescriptor => ({
  valid: v => turnText(v, segment),
  normalise: v => { const out = pick(v, ['turnId', 'turnEpoch', 'text', ...(segment ? ['index'] : [])]); out.turnEpoch ??= null; out.text = clip(out.text); return out }
})
const eventDescriptors: Record<VoiceTurnEvent, EventDescriptor> = {
  'voice:state': {
    valid: v => shape(v, ['state'], ['turnId', 'turnEpoch', 'detail']) && Object.hasOwn(VOICE_TRANSITIONS, v.state as string) && owner(v) && (v.detail === undefined || text(v.detail, 4096)),
    normalise: v => { const out = pick(v, ['state', 'turnId', 'turnEpoch', 'detail']); if (out.detail !== undefined) out.detail = clip(out.detail, 4096); return out }
  },
  'voice:partial': turnTextEvent(), 'voice:final': turnTextEvent(), 'voice:segment': turnTextEvent(true),
  'voice:outcome': { valid: outcome, normalise: normaliseOutcome },
  'voice:error': {
    valid: v => shape(v, ['message'], ['code', 'turnId', 'turnEpoch']) && text(v.message, 4096) && (v.code === undefined || text(v.code, 128)) && owner(v),
    normalise: v => { const out = pick(v, ['message', 'code', 'turnId', 'turnEpoch']); out.message = clip(out.message, 4096); if (out.code !== undefined) out.code = clip(out.code, 128); return out }
  },
  'voice:navigate': {
    valid: v => shape(v, ['destination', 'taskId']) && VIEWS.includes(v.destination as string) && (v.taskId === null || id(v.taskId)),
    normalise: v => { const out = pick(v, ['destination', 'taskId']); out.taskId ??= null; return out }
  },
  'voice:dictate': {
    valid: v => shape(v, ['turnId', 'text']) && id(v.turnId) && text(v.text),
    normalise: v => { const out = pick(v, ['turnId', 'text']); out.text = clip(out.text); return out }
  },
  'voice:hotkey': { valid: v => shape(v, ['action']) && text(v.action, 64), normalise: v => pick(v, ['action']) },
  'voice:speech:start': {
    valid: v => shape(v, ['speechId', 'speechGeneration', 'source', 'text', 'sampleRate', 'truncated'], ['taskId']) && id(v.speechId) && natural(v.speechGeneration) && SOURCES.includes(v.source as string) && text(v.text) && natural(v.sampleRate) && v.sampleRate > 0 && v.sampleRate <= 192000 && typeof v.truncated === 'boolean' && (v.taskId === undefined || id(v.taskId)),
    normalise: v => { const out = pick(v, ['speechId', 'speechGeneration', 'source', 'text', 'sampleRate', 'truncated', 'taskId']); out.text = clip(out.text); return out }
  },
  'voice:speech:chunk': {
    valid: v => shape(v, ['speechId', 'speechGeneration', 'index', 'pcm', 'sampleRate', 'text']) && id(v.speechId) && natural(v.speechGeneration) && natural(v.index) && pcm(v.pcm, VOICE_TURN_LIMITS.speechBytes) && natural(v.sampleRate) && v.sampleRate > 0 && v.sampleRate <= 192000 && text(v.text),
    normalise: v => { const out = pick(v, ['speechId', 'speechGeneration', 'index', 'pcm', 'sampleRate', 'text']); out.text = clip(out.text ?? ''); const data = asBytes(out.pcm); if (data) out.pcm = data; return out },
    toWire: v => ({ ...v, pcm: encodeVoiceBase64(v.pcm as Uint8Array) }),
    fromWire: v => ({ ...v, pcm: decodeVoiceBase64(v.pcm, VOICE_TURN_LIMITS.speechBytes) })
  },
  'voice:speech:end': {
    valid: v => shape(v, ['speechId', 'speechGeneration', 'reason'], ['message']) && id(v.speechId) && natural(v.speechGeneration) && END_REASONS.includes(v.reason as string) && (v.message === undefined || text(v.message, 4096)),
    normalise: v => { const out = pick(v, ['speechId', 'speechGeneration', 'reason', 'message']); if (out.message !== undefined) out.message = clip(out.message, 4096); return out }
  }
}
function eventCodec<K extends VoiceTurnEvent>(event: K) {
  const d = eventDescriptors[event]
  return {
    /** Checks the decoded payload, as listeners receive it. */
    validatePayload: (v: unknown): boolean => d.valid(v),
    encodePayload(v: unknown): JsonValue {
      const normal = d.normalise(v)
      if (!d.valid(normal)) return fail('INVALID_RESULT')
      const wire = d.toWire ? d.toWire(normal as Record<string, unknown>) : normal
      if (!bounded(wire)) return fail('INVALID_RESULT')
      return wire as JsonValue
    },
    decodePayload(v: JsonValue): DesktopEventMap[K] {
      if (!isRecord(v) || !bounded(v)) return fail('INVALID_RESULT')
      const decoded = d.fromWire ? d.fromWire(v) : v
      if (!d.valid(decoded)) return fail('INVALID_RESULT')
      return decoded as DesktopEventMap[K]
    }
  }
}
export const VOICE_TURN_EVENT_CODECS = Object.fromEntries(VOICE_TURN_EVENTS.map(name => [name, eventCodec(name)])) as { [K in VoiceTurnEvent]: ReturnType<typeof eventCodec<K>> }
