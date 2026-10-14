/** Management only: no capture, actions, audio, host paths or hosted speech. */
import type { DesktopCommandMap, DesktopEventMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { VOICE_TRANSITIONS } from './voice'
import { VOICE_TTS_ELEVENLABS_EMPTY_STATE } from './voice-tts'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const VOICE_MANAGEMENT_OPERATIONS = ['voice:getSnapshot', 'voice:setEnabled', 'voice:getRuntime', 'voice:installRuntime', 'voice:removeRuntime', 'voice:installModel', 'voice:removeModel', 'voice:removeAllModels', 'voice:selectModel', 'voice:setEndpointSilence',
  'voice:tts:getSnapshot', 'voice:tts:setEnabled', 'voice:tts:setEngine', 'voice:tts:setVoice', 'voice:tts:setSpeed', 'voice:tts:setMaxChars', 'voice:tts:setSpeakActionResults', 'voice:tts:setOnlyVoiceTurns', 'voice:tts:installModel', 'voice:tts:selectModel', 'voice:tts:removeModel'] as const
export type VoiceManagementOperation = typeof VOICE_MANAGEMENT_OPERATIONS[number]
export const VOICE_MANAGEMENT_EVENTS = ['voice:status', 'voice:runtimeProgress', 'voice:tts:status', 'voice:tts:modelProgress'] as const
export const VOICE_MANAGEMENT_STT_IDS = ['nemo-parakeet-tdt-0.6b-v3', 'sherpa-streaming-zipformer-en', 'nemo-fast-conformer-en-480ms', 'nemotron-streaming-en-560ms'] as const
export const VOICE_MANAGEMENT_TTS_IDS = ['kitten-nano-en-v0_2', 'kokoro-en-v0_19'] as const
export const VOICE_MANAGEMENT_LIMITS = { frameBytes: 256 * 1024, requests: 16, models: 16, voices: 256, textBytes: 4096, transcriptBytes: 65536, endpointSeconds: 10, maxChars: 6000 } as const
export const VOICE_RUNTIME_MODULE_MARKER = '__21x_local_voice_runtime__'
export const VOICE_MANAGEMENT_ERROR = 'Voice management failed. Check the local runtime and model.'
export const VOICE_MANAGEMENT_UNAVAILABLE = 'Voice capture and audio playback are unavailable in this desktop host.'
export const VOICE_MANAGEMENT_HOSTED_UNAVAILABLE = 'Hosted speech is unavailable in this desktop host.'
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
const shape = (v: unknown, required: readonly string[], optional: readonly string[] = []): v is Record<string, unknown> => isRecord(v) && hasExactKeys(v, [...required], [...optional])
const text = (v: unknown, max: number = VOICE_MANAGEMENT_LIMITS.textBytes, multiline = false): v is string => typeof v === 'string' && !(multiline ? /\0/ : /[\u0000-\u001f\u007f]/).test(v) && new TextEncoder().encode(v).length <= max
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const between = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const bounded = (v: unknown): v is JsonValue => isJsonValue(v) && new TextEncoder().encode(JSON.stringify(v)).length <= VOICE_MANAGEMENT_LIMITS.frameBytes
const sttId = (v: unknown): boolean => (VOICE_MANAGEMENT_STT_IDS as readonly unknown[]).includes(v)
const ttsId = (v: unknown): boolean => (VOICE_MANAGEMENT_TTS_IDS as readonly unknown[]).includes(v)
const voiceId = (v: unknown): boolean => v === '' || text(v, 512) && (v.startsWith('system:') && v.length > 7 || /^local:(kitten-nano-en-v0_2|kokoro-en-v0_19):(?:0|[1-9]\d{0,2})$/.test(v))
const success = (v: unknown): boolean => shape(v, ['success']) && typeof v.success === 'boolean'
const runtimeKeys = ['installed', 'version', 'modulePath', 'sizeBytes']
export function isVoiceManagementRuntime(v: unknown): boolean {
  return shape(v, runtimeKeys, ['installing', 'progress', 'error']) && typeof v.installed === 'boolean' && (v.version === null || text(v.version, 128)) && (v.modulePath === null || v.modulePath === VOICE_RUNTIME_MODULE_MARKER) && integer(v.sizeBytes) && (v.installing === undefined || typeof v.installing === 'boolean') && (v.progress === undefined || between(v.progress, 0, 1)) && (v.error === undefined || v.error === VOICE_MANAGEMENT_ERROR)
}
function projectRuntime(v: unknown): unknown {
  if (!shape(v, runtimeKeys, ['installing', 'progress', 'error']) || !(v.modulePath === null || text(v.modulePath, 4096))) return fail('INVALID_RESULT')
  if (v.error !== undefined && typeof v.error !== 'string') return fail('INVALID_RESULT')
  const clean = Object.fromEntries(Object.entries(v).filter(([, item]) => item !== undefined))
  return { ...clean, modulePath: v.modulePath ? VOICE_RUNTIME_MODULE_MARKER : null, ...(v.error === undefined ? {} : { error: VOICE_MANAGEMENT_ERROR }) }
}
const modelKeys = ['id', 'label', 'description', 'license', 'licenseUrl', 'languages', 'installed', 'active', 'installing', 'progress', 'sizeBytes', 'downloadable']
function model(v: unknown, tts = false): boolean {
  return shape(v, tts ? [...modelKeys, 'unpackedBytes', 'speakerCount'] : modelKeys, tts ? ['error'] : ['error', 'kind', 'phase', 'legacy']) && (tts ? ttsId(v.id) : sttId(v.id)) && ['label', 'description', 'license', 'licenseUrl'].every(key => text(v[key], key === 'description' ? 4096 : 1024)) && Array.isArray(v.languages) && v.languages.length <= 64 && v.languages.every(item => text(item, 64)) && ['installed', 'active', 'installing', 'downloadable'].every(key => typeof v[key] === 'boolean') && between(v.progress, 0, 1) && integer(v.sizeBytes) &&
    (tts ? integer(v.unpackedBytes) && integer(v.speakerCount) && v.speakerCount <= 512 : (v.kind === undefined || ['streaming', 'offline'].includes(v.kind as string)) && (v.phase === undefined || ['downloading', 'verifying'].includes(v.phase as string)) && (v.legacy === undefined || typeof v.legacy === 'boolean')) && (v.error === undefined || v.error === VOICE_MANAGEMENT_ERROR)
}
function projectModel(v: unknown, tts = false): unknown {
  if (!isRecord(v)) return fail('INVALID_RESULT')
  if (v.error !== undefined && typeof v.error !== 'string') return fail('INVALID_RESULT')
  const clean = Object.fromEntries(Object.entries(v).filter(([, item]) => item !== undefined))
  if (clean.error !== undefined) clean.error = VOICE_MANAGEMENT_ERROR
  if (!model(clean, tts)) return fail('INVALID_RESULT')
  return clean
}
const models = (v: unknown, tts = false): boolean => Array.isArray(v) && v.length <= VOICE_MANAGEMENT_LIMITS.models && v.every(item => model(item, tts)) && new Set(v.map(item => item.id)).size === v.length
function projectModels(v: unknown, tts = false): unknown {
  if (!Array.isArray(v) || v.length > VOICE_MANAGEMENT_LIMITS.models) return fail('INVALID_RESULT')
  return v.map(item => projectModel(item, tts))
}
function engine(v: unknown, tts = false): boolean {
  if (!isRecord(v)) return false
  if (v.state === 'loading') return shape(v, ['state'])
  if (v.state === 'ready') return tts ? shape(v, ['state', 'engine', 'modelId', 'voiceId', 'sampleRate']) && ['system', 'local'].includes(v.engine as string) && (v.modelId === '' || ttsId(v.modelId)) && voiceId(v.voiceId) && integer(v.sampleRate) && v.sampleRate > 0 && v.sampleRate <= 192000
    : shape(v, ['state', 'modelId', 'engine']) && sttId(v.modelId) && text(v.engine, 128)
  return shape(v, ['state', 'message']) && (tts ? ['unavailable', 'model_missing', 'error'] : ['engine_missing', 'model_missing', 'error']).includes(v.state as string) && [VOICE_MANAGEMENT_ERROR, VOICE_MANAGEMENT_UNAVAILABLE].includes(v.message as string)
}
function projectEngine(v: unknown): unknown {
  if (!isRecord(v)) return fail('INVALID_RESULT')
  const unavailable = v.state !== 'error' || ['Native microphone recognition is unavailable on this host.', 'Desktop speech audio is unavailable in this host.', VOICE_MANAGEMENT_HOSTED_UNAVAILABLE].includes(v.message as string)
  return v.message === undefined ? v : { ...v, message: unavailable ? VOICE_MANAGEMENT_UNAVAILABLE : VOICE_MANAGEMENT_ERROR }
}
const statusKeys = ['enabled', 'engine', 'models', 'shortcut', 'runtime']
function status(v: unknown, snapshot = false): boolean {
  return shape(v, snapshot ? [...statusKeys, 'state', 'turnId', 'partial', 'final'] : statusKeys) && typeof v.enabled === 'boolean' && engine(v.engine) && models(v.models) && text(v.shortcut, 256) && isVoiceManagementRuntime(v.runtime) && (!snapshot || typeof v.state === 'string' && Object.hasOwn(VOICE_TRANSITIONS, v.state) && (v.turnId === null || text(v.turnId, 128)) && text(v.partial, 65536, true) && text(v.final, 65536, true))
}
function projectStatus(v: unknown, snapshot = false): unknown {
  if (!shape(v, snapshot ? [...statusKeys, 'state', 'turnId', 'partial', 'final'] : statusKeys)) return fail('INVALID_RESULT')
  return { ...v, engine: projectEngine(v.engine), models: projectModels(v.models), runtime: projectRuntime(v.runtime) }
}
function ttsVoice(v: unknown): boolean {
  return shape(v, ['id', 'label', 'engine', 'speakerId', 'modelId', 'language', 'description']) && voiceId(v.id) && v.id !== '' && ['system', 'local'].includes(v.engine as string) && integer(v.speakerId) && v.speakerId <= 512 && (v.modelId === '' || ttsId(v.modelId)) && ['label', 'language', 'description'].every(key => text(v[key], key === 'description' ? 4096 : 512))
}
function offlineHosted(v: unknown): boolean {
  return shape(v, ['keySet', 'disclosureAccepted', 'modelId', 'models', 'voices', 'error', 'usage']) && v.keySet === false && v.disclosureAccepted === false && v.modelId === VOICE_TTS_ELEVENLABS_EMPTY_STATE.modelId && Array.isArray(v.models) && !v.models.length && Array.isArray(v.voices) && !v.voices.length && (v.error === null || shape(v.error, ['kind', 'message']) && v.error.kind === 'unknown' && v.error.message === VOICE_MANAGEMENT_HOSTED_UNAVAILABLE) && v.usage === null
}
export function isVoiceManagementTtsSnapshot(v: unknown): boolean {
  return shape(v, ['enabled', 'engine', 'status', 'voices', 'voiceId', 'speed', 'maxChars', 'speakActionResults', 'onlyVoiceTurns', 'models', 'speaking', 'elevenlabs']) && typeof v.enabled === 'boolean' && ['system', 'local'].includes(v.engine as string) && engine(v.status, true) && Array.isArray(v.voices) && v.voices.length <= 256 && v.voices.every(ttsVoice) && new Set(v.voices.map(item => item.id)).size === v.voices.length && voiceId(v.voiceId) && between(v.speed, 0.5, 2) && integer(v.maxChars) && v.maxChars >= 1 && v.maxChars <= 6000 && typeof v.speakActionResults === 'boolean' && typeof v.onlyVoiceTurns === 'boolean' && models(v.models, true) && typeof v.speaking === 'boolean' && offlineHosted(v.elevenlabs)
}
function projectTts(v: unknown): unknown {
  if (!isRecord(v) || !['system', 'local'].includes(v.engine as string)) return fail('INVALID_RESULT')
  // The actual portable owner refuses hosted engines. Do not query/project
  // hosted account data or manufacture a working offline engine here.
  const hosted = structuredClone(VOICE_TTS_ELEVENLABS_EMPTY_STATE)
  if (isRecord(v.elevenlabs) && v.elevenlabs.error != null) hosted.error = { kind: 'unknown', message: VOICE_MANAGEMENT_HOSTED_UNAVAILABLE }
  return { ...v, status: projectEngine(v.status), models: projectModels(v.models, true), elevenlabs: hosted }
}
interface Descriptor { keys: string[]; args(v: unknown[]): boolean; result(v: unknown): boolean; project?(v: unknown): unknown }
const noArgs = (v: unknown[]): boolean => !v.length
const bool = (v: unknown[]): boolean => v.length === 1 && typeof v[0] === 'boolean'
const sttModelArgs = (v: unknown[]): boolean => v.length === 1 && sttId(v[0])
const ttsModelArgs = (v: unknown[]): boolean => v.length === 1 && ttsId(v[0])
const ttsDescriptor = (keys: string[], args: Descriptor['args']): Descriptor => ({ keys, args, result: isVoiceManagementTtsSnapshot, project: projectTts })
const descriptors: Record<VoiceManagementOperation, Descriptor> = {
  'voice:getSnapshot': { keys: [], args: noArgs, result: v => status(v, true), project: v => projectStatus(v, true) },
  'voice:setEnabled': { keys: ['enabled'], args: bool, result: v => status(v, true), project: v => projectStatus(v, true) },
  'voice:getRuntime': { keys: [], args: noArgs, result: isVoiceManagementRuntime, project: projectRuntime },
  'voice:installRuntime': { keys: [], args: noArgs, result: isVoiceManagementRuntime, project: projectRuntime },
  'voice:removeRuntime': { keys: [], args: noArgs, result: isVoiceManagementRuntime, project: projectRuntime },
  'voice:installModel': { keys: ['id'], args: sttModelArgs, result: v => model(v), project: v => projectModel(v) },
  'voice:removeModel': { keys: ['id'], args: sttModelArgs, result: v => models(v), project: v => projectModels(v) },
  'voice:selectModel': { keys: ['id'], args: sttModelArgs, result: v => models(v), project: v => projectModels(v) },
  'voice:removeAllModels': { keys: [], args: noArgs, result: success },
  'voice:setEndpointSilence': { keys: ['seconds'], args: v => v.length === 1 && between(v[0], 0.1, 10), result: success },
  'voice:tts:getSnapshot': ttsDescriptor([], noArgs), 'voice:tts:setEnabled': ttsDescriptor(['enabled'], bool),
  'voice:tts:setEngine': ttsDescriptor(['engine'], v => v.length === 1 && ['system', 'local'].includes(v[0] as string)),
  'voice:tts:setVoice': ttsDescriptor(['voiceId'], v => v.length === 1 && voiceId(v[0])),
  'voice:tts:setSpeed': ttsDescriptor(['speed'], v => v.length === 1 && between(v[0], 0.5, 2)),
  'voice:tts:setMaxChars': ttsDescriptor(['maxChars'], v => v.length === 1 && integer(v[0]) && v[0] >= 1 && v[0] <= 6000),
  'voice:tts:setSpeakActionResults': ttsDescriptor(['on'], bool), 'voice:tts:setOnlyVoiceTurns': ttsDescriptor(['on'], bool),
  'voice:tts:installModel': ttsDescriptor(['id'], ttsModelArgs), 'voice:tts:selectModel': ttsDescriptor(['id'], ttsModelArgs), 'voice:tts:removeModel': ttsDescriptor(['id'], ttsModelArgs)
}
export interface VoiceManagementCodec<K extends VoiceManagementOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(v: unknown): boolean
  encodeResult(v: unknown): OptionalResult<JsonValue>
  decodeResult(v: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(v: unknown): boolean
  validateWireResult(v: unknown): boolean
}
function codec<K extends VoiceManagementOperation>(operation: K): VoiceManagementCodec<K> {
  const descriptor = descriptors[operation], valid = (v: unknown): boolean => bounded(v) && descriptor.result(v)
  return {
    validateArguments: v => Array.isArray(v) && descriptor.args(v),
    encodeArguments(args) { if (!descriptor.args(args)) return fail('INVALID_ARGUMENTS'); return Object.fromEntries(descriptor.keys.map((key, index) => [key, args[index]])) as JsonValue },
    decodeArguments(v) { if (!shape(v, descriptor.keys)) return fail('INVALID_ARGUMENTS'); const args = descriptor.keys.map(key => v[key]); if (!descriptor.args(args)) return fail('INVALID_ARGUMENTS'); return args as DesktopCommandMap[K]['apiArguments'] },
    validateResult: valid,
    encodeResult(v) { const projected = descriptor.project ? descriptor.project(v) : v; if (!valid(projected)) return fail('INVALID_RESULT'); return { defined: true, value: projected as JsonValue } },
    decodeResult(v) { if (!valid(v)) return fail('INVALID_RESULT'); return v as DesktopCommandMap[K]['result'] },
    validateWireResult: v => shape(v, ['defined', 'value']) && v.defined === true && valid(v.value)
  }
}
export const VOICE_MANAGEMENT_CODECS = Object.fromEntries(VOICE_MANAGEMENT_OPERATIONS.map(op => [op, codec(op)])) as { [K in VoiceManagementOperation]: VoiceManagementCodec<K> }
type ManagementEvent = typeof VOICE_MANAGEMENT_EVENTS[number]
function event(event: ManagementEvent) {
  const valid = (v: unknown): boolean => bounded(v) && (event === 'voice:status' ? status(v) : event === 'voice:tts:status' ? isVoiceManagementTtsSnapshot(v) : event === 'voice:tts:modelProgress' ? shape(v, ['model']) && model(v.model, true) : shape(v, ['stage', 'output', 'percent']) && ['starting', 'installing', 'complete', 'error'].includes(v.stage as string) && v.output === (v.stage === 'error' ? VOICE_MANAGEMENT_ERROR : VOICE_MANAGEMENT_UNAVAILABLE) && between(v.percent, 0, 100))
  const project = (v: unknown): unknown => {
    if (event === 'voice:status') return projectStatus(v)
    if (event === 'voice:tts:status') return projectTts(v)
    if (event === 'voice:tts:modelProgress') { if (!shape(v, ['model'])) return fail('INVALID_RESULT'); return { model: projectModel(v.model, true) } }
    if (!shape(v, ['stage', 'output', 'percent'])) return fail('INVALID_RESULT')
    return { ...v, output: v.stage === 'error' ? VOICE_MANAGEMENT_ERROR : VOICE_MANAGEMENT_UNAVAILABLE }
  }
  return { validatePayload: valid, encodePayload(v: unknown): JsonValue { const out = project(v); if (!valid(out)) return fail('INVALID_RESULT'); return out as JsonValue }, decodePayload(v: JsonValue): DesktopEventMap[ManagementEvent] { if (!valid(v)) return fail('INVALID_RESULT'); return v as unknown as DesktopEventMap[ManagementEvent] } }
}
export const VOICE_MANAGEMENT_EVENT_CODECS = Object.fromEntries(VOICE_MANAGEMENT_EVENTS.map(name => [name, event(name)])) as { [K in ManagementEvent]: { validatePayload(v: unknown): boolean; encodePayload(v: unknown): JsonValue; decodePayload(v: JsonValue): DesktopEventMap[K] } }
