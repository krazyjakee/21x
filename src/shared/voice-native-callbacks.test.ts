import { describe, expect, it } from 'vitest'
import {
  NATIVE_VOICE_HOST_SCHEMAS,
  NATIVE_VOICE_DELIVERY_SCHEMAS,
  isNativeVoiceEvent,
  isNativeVoiceRegistration,
  isNativeVoiceAudio,
  voicePcmByteLength,
  isVoiceAccelerator
} from './voice-native-callbacks'
const voiceLeaseId = '00000000-0000-4000-8000-000000000001'
const owner = { turnId: 'turn_1', turnEpoch: 'turn_epoch_1' }
describe('finite private local voice contract', () => {
  it('accepts only current-document lease purposes with bounded expiry', () => {
    const value = { voiceLeaseId, uiLeaseId: 'document_fixture_1', purpose: 'permission', ttlMs: 120000 }
    expect(isNativeVoiceRegistration(value)).toBe(true)
    for (const extra of [
      { ttlMs: 120001 },
      { ttlMs: 0 },
      { purpose: 'camera' },
      { deviceId: 'foreign' },
      { voiceLeaseId: '00000000-0000-5000-8000-000000000001' },
      { uiLeaseId: '' }
    ])
      expect(isNativeVoiceRegistration({ ...value, ...extra })).toBe(false)
    expect(isNativeVoiceRegistration({ ...value, purpose: 'capture', ttlMs: 600000 })).toBe(true)
    expect(isNativeVoiceRegistration({ ...value, purpose: 'capture', ttlMs: 600001 })).toBe(false)
  })
  it('requires canonical even PCM16 and exact private turn sequence envelope', () => {
    expect(voicePcmByteLength('AAA=')).toBe(2)
    expect(voicePcmByteLength(Buffer.alloc(6400).toString('base64'))).toBe(6400)
    for (const value of [
      '',
      'AA==',
      'AAB=',
      'AA A=',
      'data:audio/pcm;base64,AAA=',
      Buffer.alloc(6402).toString('base64')
    ])
      expect(voicePcmByteLength(value)).toBeNull()
    const audio = { voiceLeaseId, ...owner, seq: 1, pcmBase64: 'AAA=' }
    expect(isNativeVoiceAudio(audio)).toBe(true)
    for (const extra of [
      { seq: 0 },
      { seq: Number.MAX_SAFE_INTEGER + 1 },
      { sampleRate: 44100 },
      { epoch: 'foreign' },
      { pcmBase64: 'AA==' }
    ])
      expect(isNativeVoiceAudio({ ...audio, ...extra })).toBe(false)
  })
  it('discriminates bounded events and never admits generic operation/payload authority', () => {
    const chunk = {
      type: 'speech-chunk',
      speechId: 'speech_1',
      speechGeneration: 1,
      index: 0,
      pcmBase64: Buffer.alloc(128 * 1024).toString('base64'),
      sampleRate: 24000,
      text: 'Synthetic silence.'
    }
    expect(isNativeVoiceEvent(chunk)).toBe(true)
    for (const extra of [
      { pcmBase64: Buffer.alloc(128 * 1024 + 2).toString('base64') },
      { index: -1 },
      { sampleRate: 7999 },
      { sampleRate: 48001 },
      { sampleRate: 24000.5 },
      { speechGeneration: 0 },
      { device: 'global' }
    ])
      expect(isNativeVoiceEvent({ ...chunk, ...extra })).toBe(false)
    expect(isNativeVoiceEvent({ type: 'partial', ...owner, text: 'Synthetic words' })).toBe(true)
    expect(isNativeVoiceEvent({ type: 'partial', ...owner, text: '\ud800' })).toBe(false)
    expect(isNativeVoiceEvent({ operation: 'voice:speech:chunk', payload: chunk })).toBe(false)
    expect(isNativeVoiceEvent({ type: 'state', ...owner, state: 'completed' })).toBe(false)
  })
  it('keeps visual confirmation proposals closed and binds outcome to the same turn pair', () => {
    const event = {
      type: 'outcome',
      ...owner,
      outcome: {
        status: 'needs_confirmation',
        ...owner,
        reason: 'destructive',
        proposal: {
          intent: { type: 'approve_checkpoint', taskRef: { kind: 'current' } },
          confidence: 1,
          transcript: 'approve',
          source: 'deterministic',
          summary: 'Approve checkpoint'
        }
      }
    }
    expect(isNativeVoiceEvent(event)).toBe(true)
    expect(isNativeVoiceEvent({ ...event, outcome: { ...event.outcome, turnEpoch: 'old_epoch' } })).toBe(false)
    expect(
      isNativeVoiceEvent({
        ...event,
        outcome: {
          ...event.outcome,
          proposal: {
            ...event.outcome.proposal,
            intent: { type: 'approve_checkpoint', taskRef: { kind: 'current', requestId: '*' } }
          }
        }
      })
    ).toBe(false)
    expect(isNativeVoiceEvent({ ...event, outcome: { ...event.outcome, extraAuthority: '*' } })).toBe(false)
  })
  it('admits finite accelerators and private receipts without granting availability', () => {
    expect(isVoiceAccelerator('CommandOrControl+Shift+Space')).toBe(true)
    for (const key of ['', 'Control+Ctrl+A', 'Shift+Shift+A', 'A', 'Control+$(command)', 'Alt+F25'])
      expect(isVoiceAccelerator(key)).toBe(false)
    expect(
      NATIVE_VOICE_HOST_SCHEMAS['host.voice.permission'].validateResult({ voiceLeaseId, status: 'unavailable' })
    ).toBe(true)
    expect(
      NATIVE_VOICE_HOST_SCHEMAS['host.voice.permission'].validateResult({
        voiceLeaseId,
        status: 'granted',
        device: 'global'
      })
    ).toBe(false)
    expect(NATIVE_VOICE_DELIVERY_SCHEMAS['engine.voice.revoked'].validatePayload({ voiceLeaseId, force: true })).toBe(
      false
    )
  })
})
