import { describe, expect, it } from 'vitest'
import { decodeVoiceBase64, encodeVoiceBase64, VOICE_TURN_CODECS, VOICE_TURN_EVENT_CODECS, VOICE_TURN_EVENTS, VOICE_TURN_OPERATIONS } from './voice-turn-codecs'

describe('live voice codecs', () => {
  it('round-trips base64 PCM exactly and refuses malformed or oversized audio', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 3200]) {
      const data = Uint8Array.from({ length }, (_, i) => (i * 37) & 255)
      const text = encodeVoiceBase64(data)
      expect(text).toBe(Buffer.from(data).toString('base64'))
      expect(decodeVoiceBase64(text, 4096)).toEqual(data)
    }
    expect(decodeVoiceBase64('AA*A', 16)).toBeNull()
    expect(decodeVoiceBase64('AAA', 16)).toBeNull()
    expect(decodeVoiceBase64('AAAAAAAA', 3)).toBeNull()
    const codec = VOICE_TURN_CODECS['voice:pushAudio']
    expect(codec.encodeArguments(['turn_1', new Uint8Array([1, 2, 3, 4])])).toEqual({ turnId: 'turn_1', chunk: 'AQIDBA==' })
    expect(codec.decodeArguments({ turnId: 'turn_1', chunk: 'AQIDBA==' })).toEqual(['turn_1', new Uint8Array([1, 2, 3, 4])])
    // An odd byte count is not 16-bit PCM.
    expect(() => codec.decodeArguments({ turnId: 'turn_1', chunk: 'AQID' })).toThrow()
    expect(() => codec.encodeArguments(['turn_1', new Uint8Array(70 * 1024)])).toThrow()
    expect(() => codec.decodeArguments({ turnId: '../x', chunk: 'AQIDBA==' })).toThrow()
  })

  it('keeps only the context fields main reads and refuses unknown modes', () => {
    const codec = VOICE_TURN_CODECS['voice:startTurn']
    const wire = codec.encodeArguments(['command', { selectedTaskId: 'task_1', view: 'tasks', visibleTaskIds: ['a', 'b'], pendingApproval: null, cwd: '/' } as never])
    expect(wire).toEqual({ mode: 'command', context: { selectedTaskId: 'task_1', view: 'tasks', visibleTaskIds: ['a', 'b'], pendingApproval: null } })
    expect(codec.decodeArguments(wire)).toEqual(['command', { selectedTaskId: 'task_1', view: 'tasks', visibleTaskIds: ['a', 'b'], pendingApproval: null }])
    expect(() => codec.encodeArguments(['shell' as never, {}])).toThrow()
    expect(codec.encodeResult({ turnId: 't', turnEpoch: 'e' })).toEqual({ defined: true, value: { turnId: 't', turnEpoch: 'e' } })
    expect(codec.encodeResult({ error: 'Voice is switched off.' })).toEqual({ defined: true, value: { error: 'Voice is switched off.' } })
  })

  it('encodes optional trailing arguments and void results like the Electron preload', () => {
    expect(VOICE_TURN_CODECS['voice:cancelTurn'].encodeArguments([])).toEqual({})
    expect(VOICE_TURN_CODECS['voice:cancelTurn'].encodeArguments(['t', 'e'])).toEqual({ turnId: 't', turnEpoch: 'e' })
    expect(VOICE_TURN_CODECS['voice:cancelTurn'].decodeArguments({})).toEqual([])
    expect(VOICE_TURN_CODECS['voice:confirm'].encodeArguments(['t', undefined, 'e'])).toEqual({ turnId: 't', turnEpoch: 'e' })
    expect(VOICE_TURN_CODECS['voice:confirm'].decodeArguments({ turnId: 't', choice: { taskId: 'x' } })).toEqual(['t', { taskId: 'x' }])
    expect(() => VOICE_TURN_CODECS['voice:confirm'].decodeArguments({ turnId: 't', choice: { run: 'x' } })).toThrow()
    expect(VOICE_TURN_CODECS['voice:endTurn'].encodeResult(undefined)).toEqual({ defined: false })
    expect(VOICE_TURN_CODECS['voice:endTurn'].validateWireResult({ defined: false })).toBe(true)
    expect(VOICE_TURN_CODECS['voice:tts:speak'].encodeArguments(['Hello'])).toEqual({ text: 'Hello' })
    expect(VOICE_TURN_CODECS['voice:commander:setActive'].encodeArguments([null])).toEqual({ sessionId: null })
    expect(() => VOICE_TURN_CODECS['voice:commander:send'].encodeArguments(['s', '   '])).toThrow()
    expect(VOICE_TURN_OPERATIONS).toHaveLength(14)
  })

  it('normalises events instead of failing the connection, and moves speech audio as base64', () => {
    expect(VOICE_TURN_EVENTS).toHaveLength(12)
    const partial = VOICE_TURN_EVENT_CODECS['voice:partial']
    // Main sends turnEpoch null before a lease exists, and may add fields.
    expect(partial.encodePayload({ turnId: 't', text: 'hello', extra: 1 })).toEqual({ turnId: 't', turnEpoch: null, text: 'hello' })
    const long = partial.encodePayload({ turnId: 't', turnEpoch: 'e', text: 'é'.repeat(40000) }) as { text: string }
    expect(new TextEncoder().encode(long.text).length).toBeLessThanOrEqual(65536)
    const outcome = VOICE_TURN_EVENT_CODECS['voice:outcome']
    expect(outcome.encodePayload({ status: 'executed', turnId: 't', turnEpoch: 'e', intent: 'create_task', message: 'Task created.', taskId: 'x' }))
      .toEqual({ status: 'executed', turnId: 't', turnEpoch: 'e', intent: 'create_task', message: 'Task created.', taskId: 'x' })
    expect(outcome.encodePayload({ status: 'cancelled', turnId: 't', turnEpoch: null })).toEqual({ status: 'cancelled', turnId: 't' })
    expect(() => outcome.encodePayload({ status: 'delete_everything', turnId: 't' })).toThrow()
    const chunk = VOICE_TURN_EVENT_CODECS['voice:speech:chunk']
    const wire = chunk.encodePayload({ speechId: 's', speechGeneration: 2, index: 0, pcm: Buffer.from([1, 2, 3, 4]), sampleRate: 24000, text: 'Hi.' })
    expect(wire).toEqual({ speechId: 's', speechGeneration: 2, index: 0, pcm: 'AQIDBA==', sampleRate: 24000, text: 'Hi.' })
    const decoded = chunk.decodePayload(wire)
    expect(decoded.pcm).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(chunk.validatePayload(decoded)).toBe(true)
    expect(() => chunk.decodePayload({ ...(wire as object), pcm: 'not base64' })).toThrow()
    expect(VOICE_TURN_EVENT_CODECS['voice:navigate'].encodePayload({ destination: 'tasks' })).toEqual({ destination: 'tasks', taskId: null })
    expect(() => VOICE_TURN_EVENT_CODECS['voice:navigate'].encodePayload({ destination: 'file:///etc', taskId: null })).toThrow()
  })
})
