import type { ActivityState } from '@shared/activity'
import {
  CALL_ACTIVITY,
  CALL_EVENT_MS,
  CALL_INTERRUPTED_MS,
  type CallEvent,
  type CallState,
  type CallUnavailableReason
} from '@shared/commander-call'
import type { MicrophonePermission, VoiceState } from '@shared/voice'
import { activityStateTone, activityStateWord, type ActivityTone, type VoiceObservation } from '@/lib/activity/derive-activity'

/**
 * What a Commander call shows (#84, epic #82 "State machine").
 *
 * Pure: the call store, the voice store and the Commander turn observation go
 * in, one presentation comes out. Main is the source of truth for every input;
 * nothing here is remembered between calls, so a finished turn or a stopped
 * reply can never leave a stale state behind.
 *
 *   off → ready (Start) → listening (mic) → transcribing (local only)
 *       → thinking/working (tool ⇄ text) → speaking → ready
 *   Barge-in (voice, Stop, Esc) → interrupted → ready/listening
 *   End from anywhere → off.  Any state → error (Retry / Type instead).
 *   Unavailable is a distinct state.
 */

/** The call's own lifetime, from the call store. */
export interface CallLifetime {
  status: 'off' | 'starting' | 'live'
  /** A call-level failure (the call could not start, or its microphone was lost). */
  error: string | null
  /** The live failed turn the user already chose to recover from. */
  dismissedTurnErrorId: string | null
  /** Monotonic time of the last interruption. */
  interruptedAt: number | null
  lastEvent: CallEvent | null
}

/** Why a call cannot start, or null. */
export interface CallUnavailability {
  reason: CallUnavailableReason
  message: string
}

/** The Commander turn of the call's session (commander activity adapter). */
export interface CallTurn {
  turnId: string
  phase: 'thinking' | 'working' | 'tool' | 'idle' | 'error'
  error?: string
  /** The newest unresolved tool. */
  toolName?: string
}

export interface CallStateInput {
  call: CallLifetime
  unavailable: CallUnavailability | null
  /** The microphone turn this call opened; `open` is false when it has none. */
  mic: { open: boolean; voiceState: VoiceState; partial: string }
  /** Verified Commander speech for the call's session (voice activity adapter). */
  speech: VoiceObservation['state']
  /** A reply voice is ready. False means replies are text only. */
  speechOutput: boolean
  turn: CallTurn | null
  /** Monotonic now. */
  now: number
}

export interface CallControls {
  /** Start talking (a call can be opened). */
  start: boolean
  /** Stop: something is thinking, working or speaking that can be interrupted. */
  stop: boolean
  /** End the call. */
  end: boolean
  retry: boolean
  typeInstead: boolean
  /** The one fix action for an unavailable call. */
  fix: CallUnavailableReason | null
}

export interface CallPresentation {
  state: CallState
  /** The activity state this is drawn as (src/shared/activity.ts). */
  activity: ActivityState
  /** The visible state word. Every state has one. */
  label: string
  detail?: string
  tone: ActivityTone
  /** Replies are written, not spoken (no reply voice). */
  textOnly: boolean
  controls: CallControls
  /** An action or report still inside its display window. */
  event: CallEvent | null
  /** Monotonic time at which this presentation stops being true, or null. */
  expiresAt: number | null
}

const UNAVAILABLE_LABELS: Record<CallUnavailableReason, string> = {
  mic_blocked: 'Mic blocked',
  runtime_missing: 'Voice not installed',
  not_set_up: 'Voice not set up',
  no_session: 'No conversation open',
  no_voice: 'Voice unavailable'
}

/** The short visible label for an unavailable reason. */
export function unavailableLabel(reason: CallUnavailableReason): string {
  return UNAVAILABLE_LABELS[reason]
}

/** The voice facts that decide whether a call can start. */
export interface CallAvailabilityInput {
  bridge: boolean
  sessionId: string | null
  permission: MicrophonePermission
  runtimeInstalled: boolean
  setupComplete: boolean
  /** The speech engine's own explanation, when it has one. */
  engineMessage?: string
}

/** Pure: why a call cannot start, or null when it can. Checked in the order the user must fix them. */
export function callUnavailability(input: CallAvailabilityInput): CallUnavailability | null {
  if (!input.bridge) return { reason: 'no_voice', message: 'Voice is not available in this build.' }
  if (input.permission === 'denied') {
    return { reason: 'mic_blocked', message: 'Microphone access is blocked. Allow it in the system privacy settings, then try again.' }
  }
  if (!input.runtimeInstalled) {
    return { reason: 'runtime_missing', message: 'Install the local speech runtime in Settings → Voice so Commander can hear you.' }
  }
  if (!input.setupComplete) {
    return { reason: 'not_set_up', message: input.engineMessage || 'Turn on voice input and choose a speech model in Settings → Voice.' }
  }
  if (!input.sessionId) return { reason: 'no_session', message: 'Open or start a Commander conversation first.' }
  return null
}

const NO_CONTROLS: CallControls = { start: false, stop: false, end: false, retry: false, typeInstead: false, fix: null }

function present(
  state: CallState,
  input: CallStateInput,
  extra: { label?: string; detail?: string; controls?: Partial<CallControls>; expiresAt?: number | null } = {}
): CallPresentation {
  const activity = CALL_ACTIVITY[state]
  const event = liveEvent(input.call.lastEvent, input.now)
  // A failed start has already torn media down, but it remains an explicit
  // call error until Retry, Type instead, or End clears it.
  const inCall = input.call.status !== 'off' || input.call.error !== null
  return {
    state,
    activity,
    label: extra.label ?? activityStateWord(activity),
    ...(extra.detail ? { detail: extra.detail } : {}),
    tone: activityStateTone(activity),
    textOnly: input.call.status !== 'off' && !input.speechOutput,
    controls: { ...NO_CONTROLS, end: inCall, ...extra.controls },
    event,
    expiresAt: earliest(extra.expiresAt ?? null, event ? event.at + CALL_EVENT_MS : null)
  }
}

function liveEvent(event: CallEvent | null, now: number): CallEvent | null {
  if (!event) return null
  const age = now - event.at
  return age >= 0 && age < CALL_EVENT_MS ? event : null
}

function earliest(a: number | null, b: number | null): number | null {
  if (a == null) return b
  if (b == null) return a
  return Math.min(a, b)
}

export function deriveCallState(input: CallStateInput): CallPresentation {
  const { call, mic, turn, now } = input

  // Any state → error. End clears it, so it can only be seen until then.
  if (call.error) {
    return present('error', input, {
      label: 'Voice error',
      detail: call.error,
      controls: { retry: true, typeInstead: true }
    })
  }

  if (call.status === 'off') {
    if (input.unavailable) {
      return present('unavailable', input, {
        label: unavailableLabel(input.unavailable.reason),
        detail: input.unavailable.message,
        controls: { typeInstead: true, fix: input.unavailable.reason }
      })
    }
    return present('off', input, { label: 'Not in voice', controls: { start: true } })
  }

  if (call.status === 'starting') return present('ready', input, { label: 'Joining…' })

  if (turn?.phase === 'error' && turn.error && turn.turnId !== call.dismissedTurnErrorId) {
    return present('error', input, {
      label: 'Reply error',
      detail: turn.error,
      controls: { retry: true, typeInstead: true }
    })
  }

  const turnActive = turn !== null && (turn.phase === 'thinking' || turn.phase === 'working' || turn.phase === 'tool')
  const canStop = turnActive || input.speech === 'speaking'

  if (call.interruptedAt !== null) {
    const until = call.interruptedAt + CALL_INTERRUPTED_MS
    if (now >= call.interruptedAt && now < until) return present('interrupted', input, { label: 'Stopped', expiresAt: until })
  }

  if (input.speech === 'speaking') return present('speaking', input, { controls: { stop: true } })

  const micOpen = mic.open
  if (micOpen && mic.voiceState === 'transcribing') {
    return present('transcribing', input, { label: 'Writing your words…', controls: { stop: canStop } })
  }
  // The user talking outranks a reply still being prepared: barge-in is about to cancel it.
  if (micOpen && mic.voiceState === 'listening' && mic.partial.trim()) {
    return present('listening', input, { controls: { stop: canStop } })
  }

  if (turnActive) {
    if (turn.phase === 'tool') {
      return present('working', input, {
        ...(turn.toolName ? { label: `Using ${turn.toolName}` } : {}),
        controls: { stop: true }
      })
    }
    if (turn.phase === 'working') {
      // Text is being written. Spoken, it is heard in a moment; text only, it is the reply.
      return present('thinking', input, {
        label: input.speechOutput ? 'Replying' : 'Replying in text',
        controls: { stop: true }
      })
    }
    return present('thinking', input, { controls: { stop: true } })
  }

  if (micOpen && mic.voiceState === 'listening') return present('listening', input)
  return present('ready', input, { label: 'Ready' })
}
