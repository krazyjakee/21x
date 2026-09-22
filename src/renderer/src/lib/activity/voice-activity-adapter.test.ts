import { describe, expect, it } from 'vitest'
import { deriveVoiceActivity, type VoiceActivitySnapshot } from './voice-activity-adapter'

const captain = { kind: 'captain' as const, id: 'cap' }

function snap(over: Partial<VoiceActivitySnapshot> = {}, capture: Partial<VoiceActivitySnapshot['capture']> = {}): VoiceActivitySnapshot {
  return {
    passage: null,
    playbackSpeechId: null,
    hasQueuedAudio: false,
    storeSpeaking: false,
    ...over,
    capture: { open: false, voiceState: 'idle', turnId: null, ...capture }
  }
}

describe('deriveVoiceActivity', () => {
  it('nothing happening is none', () => {
    expect(deriveVoiceActivity(snap(), captain).state).toBe('none')
  })

  it('speaking needs the attributed passage open in playback with audio queued or sounding', () => {
    const passage = { speechId: 'p1', taskId: 'cap', source: 'agent_answer' }
    expect(deriveVoiceActivity(snap({ passage, playbackSpeechId: 'p1', hasQueuedAudio: true, storeSpeaking: true }), captain).state).toBe('speaking')
  })

  it('the global speaking flag at synthesis start is not speech', () => {
    const passage = { speechId: 'p1', taskId: 'cap' }
    expect(deriveVoiceActivity(snap({ passage, storeSpeaking: true }), captain).state).toBe('unknown')
    expect(deriveVoiceActivity(snap({ storeSpeaking: true }), captain).state).toBe('unknown')
  })

  it('an open passage without audio is not speech', () => {
    const passage = { speechId: 'p1', taskId: 'cap' }
    expect(deriveVoiceActivity(snap({ passage, playbackSpeechId: 'p1', hasQueuedAudio: false }), captain).state).toBe('unknown')
  })

  it('another entity speaking is none for this one', () => {
    const passage = { speechId: 'p1', taskId: 'other' }
    expect(deriveVoiceActivity(snap({ passage, playbackSpeechId: 'p1', hasQueuedAudio: true, storeSpeaking: true }), captain).state).toBe('none')
  })

  it('a commander:<session> passage is the Commander speaking, and nobody else', () => {
    const passage = { speechId: 'p1', taskId: 'commander:s1', source: 'conversation' }
    const s = snap({ passage, playbackSpeechId: 'p1', hasQueuedAudio: true, storeSpeaking: true })
    expect(deriveVoiceActivity(s, { kind: 'commander' }).state).toBe('speaking')
    expect(deriveVoiceActivity(s, { kind: 'commander', id: 's1' }).state).toBe('speaking')
    expect(deriveVoiceActivity(s, { kind: 'commander', id: 's2' }).state).toBe('none')
    expect(deriveVoiceActivity(s, captain).state).toBe('none')
    expect(deriveVoiceActivity(s, { kind: 'task', id: 'commander:s1' }).state).toBe('none')
  })

  it('a Commander passage still being synthesised is not yet speech', () => {
    const passage = { speechId: 'p1', taskId: 'commander:s1' }
    expect(deriveVoiceActivity(snap({ passage, storeSpeaking: true }), { kind: 'commander', id: 's1' }).state).toBe('unknown')
  })

  it('an unattributed passage is unknown for everyone, including the Commander', () => {
    const passage = { speechId: 'p1', source: 'read_last_answer' }
    const s = snap({ passage, playbackSpeechId: 'p1', hasQueuedAudio: true, storeSpeaking: true })
    expect(deriveVoiceActivity(s, captain).state).toBe('unknown')
    expect(deriveVoiceActivity(s, { kind: 'commander' }).state).toBe('unknown')
  })

  it('a stale passage id (playback moved on) is not this passage', () => {
    const passage = { speechId: 'p1', taskId: 'cap' }
    expect(deriveVoiceActivity(snap({ passage, playbackSpeechId: 'p2', hasQueuedAudio: true }), captain).state).not.toBe('speaking')
  })

  it('an open microphone without an owner is unknown, never listening', () => {
    expect(deriveVoiceActivity(snap({}, { open: true, voiceState: 'listening', turnId: 't' }), captain).state).toBe('unknown')
  })

  it('an owned open microphone is listening; hands-free "ready" is not', () => {
    expect(deriveVoiceActivity(snap({}, { open: true, voiceState: 'listening', turnId: 't', owner: captain }), captain).state).toBe('listening')
    expect(deriveVoiceActivity(snap({}, { open: false, voiceState: 'idle', turnId: null, owner: captain }), captain).state).toBe('none')
  })

  it('speech wins over listening; the open mic is a detail', () => {
    const passage = { speechId: 'p1', taskId: 'cap' }
    const r = deriveVoiceActivity(
      snap({ passage, playbackSpeechId: 'p1', hasQueuedAudio: true }, { open: true, voiceState: 'listening', turnId: 't', owner: captain }),
      captain
    )
    expect(r).toEqual({ state: 'speaking', micOpen: true })
  })
})
