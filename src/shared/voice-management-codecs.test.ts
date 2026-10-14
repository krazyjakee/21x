import { describe, expect, it } from 'vitest'
import { VOICE_TTS_ELEVENLABS_EMPTY_STATE } from './voice-tts'
import { VOICE_MANAGEMENT_CODECS, VOICE_MANAGEMENT_OPERATIONS, VOICE_MANAGEMENT_EVENT_CODECS, VOICE_MANAGEMENT_EVENTS, VOICE_MANAGEMENT_ERROR, VOICE_MANAGEMENT_UNAVAILABLE, VOICE_MANAGEMENT_HOSTED_UNAVAILABLE, VOICE_RUNTIME_MODULE_MARKER } from './voice-management-codecs'

const runtime = { installed: true, version: 'fixture-version', modulePath: '/private/profile/runtime/sherpa', sizeBytes: 1024, error: 'private path failure' }
const sttModel = { id: 'nemo-parakeet-tdt-0.6b-v3', label: 'Fixture', description: 'Description', license: 'MIT', licenseUrl: 'https://example.test/license', languages: ['en'], installed: false, active: true, installing: false, progress: 0, sizeBytes: 100, downloadable: false }
const ttsModel = { ...sttModel, id: 'kitten-nano-en-v0_2', unpackedBytes: 200, speakerCount: 8 }
const snapshot = { enabled: false, engine: { state: 'engine_missing', message: 'private runtime path' }, models: [sttModel], shortcut: '', runtime, state: 'disabled', turnId: null, partial: '', final: '' }
const speech = { enabled: false, engine: 'system', status: { state: 'unavailable', message: 'Desktop speech audio is unavailable in this host.' }, voices: [], voiceId: '', speed: 1, maxChars: 1200, speakActionResults: false, onlyVoiceTurns: true, models: [ttsModel], speaking: false, elevenlabs: structuredClone(VOICE_TTS_ELEVENLABS_EMPTY_STATE) }

describe('finite portable voice management codec', () => {
  it('matches actual catalogue identities and binds only21managementcommands/four nonaudio events', () => {
    expect(VOICE_MANAGEMENT_OPERATIONS).toHaveLength(21); expect(VOICE_MANAGEMENT_EVENTS).toHaveLength(4)
    expect(Object.hasOwn(VOICE_MANAGEMENT_CODECS, 'voice:startTurn')).toBe(false)
    expect(Object.hasOwn(VOICE_MANAGEMENT_CODECS, 'voice:getPermission')).toBe(false)
    expect(Object.hasOwn(VOICE_MANAGEMENT_CODECS, 'voice:tts:speak')).toBe(false)
    expect(Object.hasOwn(VOICE_MANAGEMENT_EVENT_CODECS, 'voice:speech:chunk')).toBe(false)
  })
  it('preserves preload keys and units without coercion or path/hosted authority', () => {
    expect(VOICE_MANAGEMENT_CODECS['voice:setEnabled'].encodeArguments([false])).toEqual({ enabled: false })
    expect(VOICE_MANAGEMENT_CODECS['voice:setEndpointSilence'].encodeArguments([1.2])).toEqual({ seconds: 1.2 })
    expect(VOICE_MANAGEMENT_CODECS['voice:tts:setSpeakActionResults'].encodeArguments([true])).toEqual({ on: true })
    expect(VOICE_MANAGEMENT_CODECS['voice:tts:setMaxChars'].encodeArguments([6000])).toEqual({ maxChars: 6000 })
    for (const seconds of [0, 0.09, 10.01, NaN, Infinity]) expect(() => VOICE_MANAGEMENT_CODECS['voice:setEndpointSilence'].encodeArguments([seconds])).toThrow()
    expect(() => VOICE_MANAGEMENT_CODECS['voice:tts:setEngine'].encodeArguments(['elevenlabs'])).toThrow()
    for (const id of ['../private', 'unknown-model', 'kitten-nano-en-v0_2\0']) expect(() => VOICE_MANAGEMENT_CODECS['voice:tts:installModel'].encodeArguments([id])).toThrow()
    expect(() => VOICE_MANAGEMENT_CODECS['voice:tts:setVoice'].encodeArguments(['elevenlabs:private'])).toThrow()
    expect(() => VOICE_MANAGEMENT_CODECS['voice:getRuntime'].decodeArguments({ profileRoot: '/private' })).toThrow()
    expect(() => VOICE_MANAGEMENT_CODECS['voice:setEnabled'].decodeArguments({ enabled: true, caller: { capabilities: ['*'] } })).toThrow()
  })
  it('projects actual runtime paths/errors and never accepts private-path wire results', () => {
    const result = VOICE_MANAGEMENT_CODECS['voice:getSnapshot'].encodeResult(snapshot)
    expect(result).toMatchObject({ defined: true, value: { engine: { message: VOICE_MANAGEMENT_UNAVAILABLE }, runtime: { installed: true, modulePath: VOICE_RUNTIME_MODULE_MARKER, error: VOICE_MANAGEMENT_ERROR } } })
    expect(JSON.stringify(result)).not.toContain('/private')
    expect(VOICE_MANAGEMENT_CODECS['voice:getSnapshot'].validateWireResult(result)).toBe(true)
    expect(VOICE_MANAGEMENT_CODECS['voice:getSnapshot'].validateWireResult({ defined: true, value: snapshot })).toBe(false)
    expect(VOICE_MANAGEMENT_CODECS['voice:getRuntime'].encodeResult({ ...runtime, error: undefined })).toEqual({ defined: true, value: { installed: true, version: 'fixture-version', modulePath: VOICE_RUNTIME_MODULE_MARKER, sizeBytes: 1024 } })
    expect(() => VOICE_MANAGEMENT_CODECS['voice:getRuntime'].encodeResult({ ...runtime, secret: 'private' })).toThrow()
  })
  it('keeps unavailable hosted/audio state truthful without leaking account or model paths', () => {
    const raw = { ...speech, elevenlabs: { ...speech.elevenlabs, keySet: true, disclosureAccepted: true, voices: ['private'], models: ['private'], error: { kind: 'auth', message: 'private credential' }, usage: { used: 100, limit: 1000 } } }
    const result = VOICE_MANAGEMENT_CODECS['voice:tts:getSnapshot'].encodeResult(raw)
    expect(result).toMatchObject({ defined: true, value: { engine: 'system', status: { state: 'unavailable', message: VOICE_MANAGEMENT_UNAVAILABLE }, elevenlabs: { keySet: false, disclosureAccepted: false, models: [], voices: [], usage: null, error: { kind: 'unknown', message: VOICE_MANAGEMENT_HOSTED_UNAVAILABLE } } } })
    expect(JSON.stringify(result)).not.toContain('private')
    expect(VOICE_MANAGEMENT_CODECS['voice:tts:getSnapshot'].validateWireResult(result)).toBe(true)
    expect(() => VOICE_MANAGEMENT_CODECS['voice:tts:getSnapshot'].encodeResult({ ...speech, engine: 'elevenlabs' })).toThrow()
    expect(() => VOICE_MANAGEMENT_CODECS['voice:tts:getSnapshot'].encodeResult({ ...speech, models: [{ ...ttsModel, path: '/private' }] })).toThrow()
  })
  it('validates/project management status/progress only with strict finite byte limits', () => {
    const status = { enabled: snapshot.enabled, engine: snapshot.engine, models: snapshot.models, shortcut: snapshot.shortcut, runtime }
    const projected = VOICE_MANAGEMENT_EVENT_CODECS['voice:status'].encodePayload(status)
    expect(VOICE_MANAGEMENT_EVENT_CODECS['voice:status'].validatePayload(projected)).toBe(true)
    expect(JSON.stringify(projected)).not.toContain('/private')
    expect(VOICE_MANAGEMENT_EVENT_CODECS['voice:runtimeProgress'].encodePayload({ stage: 'error', output: 'private process output', percent: 100 })).toEqual({ stage: 'error', output: VOICE_MANAGEMENT_ERROR, percent: 100 })
    expect(VOICE_MANAGEMENT_EVENT_CODECS['voice:tts:modelProgress'].encodePayload({ model: { ...ttsModel, error: 'private path' } })).toMatchObject({ model: { error: VOICE_MANAGEMENT_ERROR } })
    expect(VOICE_MANAGEMENT_EVENT_CODECS['voice:tts:status'].validatePayload(VOICE_MANAGEMENT_EVENT_CODECS['voice:tts:status'].encodePayload(speech))).toBe(true)
    expect(() => VOICE_MANAGEMENT_CODECS['voice:getSnapshot'].encodeResult({ ...snapshot, partial: 'x'.repeat(65537) })).toThrow()
    expect(() => VOICE_MANAGEMENT_EVENT_CODECS['voice:runtimeProgress'].encodePayload({ stage: 'error', output: '', percent: 101 })).toThrow()
  })
})
