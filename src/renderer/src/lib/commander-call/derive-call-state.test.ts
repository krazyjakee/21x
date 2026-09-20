import { describe, expect, it } from 'vitest'
import { CALL_EVENT_MS, CALL_INTERRUPTED_MS, type CallEvent } from '@shared/commander-call'
import {
  callUnavailability,
  deriveCallState,
  type CallStateInput
} from './derive-call-state'

const NOW = 10_000

function input(overrides: Partial<CallStateInput> = {}): CallStateInput {
  return {
    call: { status: 'live', error: null, dismissedTurnErrorId: null, interruptedAt: null, lastEvent: null },
    unavailable: null,
    mic: { open: true, voiceState: 'listening', partial: '' },
    speech: 'none',
    speechOutput: true,
    turn: null,
    now: NOW,
    ...overrides
  }
}

describe('deriveCallState state table', () => {
  it.each([
    ['off', input({ call: { status: 'off', error: null, dismissedTurnErrorId: null, interruptedAt: null, lastEvent: null }, mic: { open: false, voiceState: 'idle', partial: '' } })],
    ['unavailable', input({
      call: { status: 'off', error: null, dismissedTurnErrorId: null, interruptedAt: null, lastEvent: null },
      unavailable: { reason: 'mic_blocked', message: 'Allow the microphone.' },
      mic: { open: false, voiceState: 'disabled', partial: '' }
    })],
    ['ready', input({ call: { status: 'starting', error: null, dismissedTurnErrorId: null, interruptedAt: null, lastEvent: null }, mic: { open: false, voiceState: 'idle', partial: '' } })],
    ['ready', input({ mic: { open: false, voiceState: 'idle', partial: '' } })],
    ['listening', input()],
    ['transcribing', input({ mic: { open: true, voiceState: 'transcribing', partial: '' } })],
    ['thinking', input({ turn: { turnId: 'turn-1', phase: 'thinking' } })],
    ['working', input({ turn: { turnId: 'turn-1', phase: 'tool', toolName: 'update_project' } })],
    ['thinking', input({ turn: { turnId: 'turn-1', phase: 'working' }, speechOutput: false })],
    ['speaking', input({ speech: 'speaking' })],
    ['interrupted', input({ call: { status: 'live', error: null, dismissedTurnErrorId: null, interruptedAt: NOW - 1, lastEvent: null } })],
    ['error', input({ turn: { turnId: 'turn-1', phase: 'error', error: 'Provider quota exceeded' } })],
    ['error', input({ call: { status: 'off', error: 'No microphone', dismissedTurnErrorId: null, interruptedAt: null, lastEvent: null }, mic: { open: false, voiceState: 'idle', partial: '' } })]
  ] as const)('derives %s', (state, value) => {
    expect(deriveCallState(value).state).toBe(state)
  })

  it('moves from local transcription through thinking/tool/text/speech to ready without stale work', () => {
    expect(deriveCallState(input({ mic: { open: true, voiceState: 'transcribing', partial: '' } })).state).toBe('transcribing')
    expect(deriveCallState(input({ turn: { turnId: 'turn-1', phase: 'thinking' } })).state).toBe('thinking')
    expect(deriveCallState(input({ turn: { turnId: 'turn-1', phase: 'tool', toolName: 'create_project' } })).state).toBe('working')
    expect(deriveCallState(input({ turn: { turnId: 'turn-1', phase: 'working' } })).label).toBe('Replying')
    expect(deriveCallState(input({ speech: 'speaking', turn: { turnId: 'turn-1', phase: 'working' } })).state).toBe('speaking')
    expect(deriveCallState(input({ mic: { open: false, voiceState: 'idle', partial: '' }, turn: { turnId: 'turn-1', phase: 'idle' } })).state).toBe('ready')
  })

  it('marks written replies as text-only and does not leave a stale speaking state', () => {
    const written = deriveCallState(input({ turn: { turnId: 'turn-1', phase: 'working' }, speechOutput: false }))
    expect(written).toMatchObject({ state: 'thinking', label: 'Replying in text', textOnly: true })
    expect(deriveCallState(input({ mic: { open: false, voiceState: 'idle', partial: '' }, speechOutput: false })).state).toBe('ready')
  })

  it('shows interruption briefly, then returns to listening', () => {
    const interruptedAt = NOW - 100
    const stopped = deriveCallState(input({ call: { status: 'live', error: null, dismissedTurnErrorId: null, interruptedAt, lastEvent: null } }))
    expect(stopped).toMatchObject({ state: 'interrupted', expiresAt: interruptedAt + CALL_INTERRUPTED_MS })
    expect(deriveCallState(input({ call: { status: 'live', error: null, dismissedTurnErrorId: null, interruptedAt, lastEvent: null }, now: interruptedAt + CALL_INTERRUPTED_MS })).state).toBe('listening')
  })

  it('gives errors Retry, Type instead and End', () => {
    const result = deriveCallState(input({ call: { status: 'off', error: 'Device lost', dismissedTurnErrorId: null, interruptedAt: null, lastEvent: null } }))
    expect(result.controls).toMatchObject({ retry: true, typeInstead: true, end: true })
  })

  it('keeps the current turn error visible until recovery, but not after End or for a new turn', () => {
    const failed = { turnId: 'turn-1', phase: 'error' as const, error: 'Provider quota exceeded' }
    expect(deriveCallState(input({ turn: failed }))).toMatchObject({
      state: 'error',
      detail: 'Provider quota exceeded',
      controls: { retry: true, typeInstead: true, end: true }
    })
    expect(deriveCallState(input({
      call: { status: 'live', error: null, dismissedTurnErrorId: 'turn-1', interruptedAt: null, lastEvent: null },
      turn: failed
    })).state).toBe('listening')
    expect(deriveCallState(input({
      call: { status: 'live', error: null, dismissedTurnErrorId: 'turn-1', interruptedAt: null, lastEvent: null },
      turn: { turnId: 'turn-2', phase: 'error', error: 'New failure' }
    })).detail).toBe('New failure')
    expect(deriveCallState(input({
      call: { status: 'off', error: null, dismissedTurnErrorId: null, interruptedAt: null, lastEvent: null },
      mic: { open: false, voiceState: 'idle', partial: '' },
      turn: failed
    })).state).toBe('off')
  })
})

describe('call events and availability', () => {
  const action: CallEvent = {
    kind: 'action', at: NOW - 1, sessionId: 's1', turnId: 't1', toolCallId: 'c1', toolName: 'update_project'
  }
  const report: CallEvent = {
    kind: 'report', at: NOW - 1, sessionId: 's1', messageId: 'm1', projectId: 'p1'
  }

  it.each([action, report])('presents a fresh $kind event without replacing the state', (event) => {
    const result = deriveCallState(input({ call: { status: 'live', error: null, dismissedTurnErrorId: null, interruptedAt: null, lastEvent: event } }))
    expect(result.state).toBe('listening')
    expect(result.event).toEqual(event)
    expect(result.expiresAt).toBe(event.at + CALL_EVENT_MS)
  })

  it('expires event presentation', () => {
    const result = deriveCallState(input({
      call: { status: 'live', error: null, dismissedTurnErrorId: null, interruptedAt: null, lastEvent: action },
      now: action.at + CALL_EVENT_MS
    }))
    expect(result.event).toBeNull()
  })

  it('keeps unavailable distinct and orders actionable reasons', () => {
    expect(callUnavailability({ bridge: false, sessionId: null, permission: 'denied', runtimeInstalled: false, setupComplete: false })?.reason).toBe('no_voice')
    expect(callUnavailability({ bridge: true, sessionId: 's1', permission: 'denied', runtimeInstalled: true, setupComplete: true })?.reason).toBe('mic_blocked')
    expect(callUnavailability({ bridge: true, sessionId: 's1', permission: 'granted', runtimeInstalled: false, setupComplete: false })?.reason).toBe('runtime_missing')
    expect(callUnavailability({ bridge: true, sessionId: 's1', permission: 'granted', runtimeInstalled: true, setupComplete: false })?.reason).toBe('not_set_up')
    expect(callUnavailability({ bridge: true, sessionId: null, permission: 'granted', runtimeInstalled: true, setupComplete: true })?.reason).toBe('no_session')
  })
})
