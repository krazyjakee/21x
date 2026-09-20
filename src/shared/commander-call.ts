/**
 * Commander call vocabulary (GitHub #84, epic #82; docs/commander.md "Call").
 *
 * A Commander "call" is the voice conversation the user opens on one Commander
 * session. Main stays the source of truth for turns, speech and the
 * microphone; the renderer keeps the call's lifetime in one app-level store
 * and derives what to show with a pure `deriveCallState()`.
 *
 * Where a call state means the same thing as an activity state
 * (src/shared/activity.ts, docs/activity-indicators.md) the call reuses the
 * activity word and tone, so the two never disagree.
 */

import type { ActivityState } from './activity'

/** The states a call can be in. `off` and `unavailable` mean no call is open. */
export type CallState =
  | 'off'
  | 'unavailable'
  | 'ready'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'working'
  | 'speaking'
  | 'interrupted'
  | 'error'

export const CALL_STATES: readonly CallState[] = [
  'off',
  'unavailable',
  'ready',
  'listening',
  'transcribing',
  'thinking',
  'working',
  'speaking',
  'interrupted',
  'error'
]

/** How the Commander microphone opens. Push-to-talk is the safer default. */
export type CommanderMicrophoneMode = 'push-to-talk' | 'open-mic'

export const DEFAULT_COMMANDER_MICROPHONE_MODE: CommanderMicrophoneMode = 'push-to-talk'

/**
 * The activity state each call state is drawn as. Only the states that exist
 * in both vocabularies map 1:1; the rest use the nearest activity meaning:
 * transcribing is work in progress, working is a tool, an interruption is an
 * idle "Stopped", and a call that cannot start is unknown ("unavailable").
 */
export const CALL_ACTIVITY: Readonly<Record<CallState, ActivityState>> = {
  off: 'idle',
  unavailable: 'unknown',
  ready: 'idle',
  listening: 'listening',
  transcribing: 'running',
  thinking: 'thinking',
  working: 'tool',
  speaking: 'speaking',
  interrupted: 'idle',
  error: 'failed'
}

/** How long "Stopped" stays on screen after an interruption. */
export const CALL_INTERRUPTED_MS = 1_000

/** How long an action/report event stays the call's latest event. */
export const CALL_EVENT_MS = 8_000

/** Why a call cannot start. Each has one fix action (epic #82, "Offline, unavailable and error states"). */
export type CallUnavailableReason =
  /** The microphone is blocked by the operating system. */
  | 'mic_blocked'
  /** The optional local speech runtime is not installed. */
  | 'runtime_missing'
  /** Speech to text is installed but no model is set up. */
  | 'not_set_up'
  /** No Commander session is open to talk to. */
  | 'no_session'
  /** This build has no voice bridge. */
  | 'no_voice'

/** Something that happened during a call that is shown briefly, not a state. */
export type CallEvent =
  | {
      kind: 'action'
      /** Monotonic time the event was observed. */
      at: number
      sessionId: string
      turnId: string
      toolCallId: string
      toolName: string
    }
  | {
      kind: 'report'
      at: number
      sessionId: string
      messageId: string
      projectId: string | null
    }

// ── Provider-neutral media (epic #82, "Provider-neutral media") ──

/** What the current speech engines can do. Nothing is claimed that they do not do. */
export interface CallMediaCapabilities {
  /** Half-heard words arrive while the user speaks. */
  partialCaptions: boolean
  /** The engine reports when each word is spoken. Never fabricated. */
  wordTimings: boolean
  /** Talking over a reply stops it. */
  speechBargeIn: boolean
  /** A reply is spoken sentence by sentence as it is written. */
  streamingTts: boolean
}

export type CallMediaEvent = 'speech_start' | 'speech_end' | 'barge_in' | 'interrupted'

export interface CallUserCaption {
  partial: string
  final: string
}

export interface CallAssistantCaption {
  /** The passage being spoken, exactly as it is spoken. */
  text: string
  speaking: boolean
  /** Only when the engine reports word timings. */
  wordIndex?: number
}

/**
 * One interface over local and (later) cloud speech. Levels are read on
 * demand, so a speaking ring can poll them per animation frame without a
 * store update per frame.
 */
export interface CallMedia {
  readonly capabilities: CallMediaCapabilities
  /** Microphone loudness, 0..1. */
  inputLevel(): number
  /** Reply loudness, 0..1. 0 when nothing is sounding. */
  outputLevel(): number
  readonly userCaption: CallUserCaption
  readonly assistantCaption: CallAssistantCaption
  on(event: CallMediaEvent, listener: () => void): () => void
}

// ── Speech attribution ──────────────────────────────────────

const COMMANDER_VOICE_PREFIX = 'commander:'

/** The passage key main uses for a Commander session's speech, in place of a task id. */
export function commanderVoiceKey(sessionId: string): string {
  return `${COMMANDER_VOICE_PREFIX}${sessionId}`
}

/** The Commander session a passage key belongs to, or null for a task passage. */
export function commanderSessionOfVoiceKey(key: string | null | undefined): string | null {
  if (!key || !key.startsWith(COMMANDER_VOICE_PREFIX)) return null
  return key.slice(COMMANDER_VOICE_PREFIX.length) || null
}
