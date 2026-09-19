import { create } from 'zustand'
import { voicePlayback } from '@/lib/voice-playback'
import { voiceCapture } from '@/lib/voice-capture'
import { useVoiceStore } from '@/stores/voice-store'
import type { VoiceObservation } from './derive-activity'

/**
 * Voice activity adapter (#95).
 *
 * The only place indicators read voice state. It translates the existing
 * voice store, playback and capture objects into a speaking / listening claim
 * for one entity, and fails closed:
 *
 * - The store's `speaking` flag is set when synthesis *starts*, before any
 *   audio, and says nothing about who is speaking. It is never enough.
 * - `voicePlayback.isPlaying` only means a passage is open. Speaking needs the
 *   open passage to be the one attributed to this entity *and* audio queued
 *   or sounding for it.
 * - Capture has no owner today (the hands-free Commander voice work will
 *   supply one), so listening is `unknown` for every entity unless an owner is
 *   passed in and matches.
 *
 * It owns no audio and no microphone, and adds no audio loop.
 */

export interface VoiceTarget {
  kind: 'task' | 'captain' | 'commander'
  /** Task id for task/Captain targets. */
  id?: string
}

export interface VoicePassageAttribution {
  speechId: string
  source?: string
  taskId?: string
}

export interface VoiceActivitySnapshot {
  /** The passage main last announced, as attributed by its speechStart event. */
  passage: VoicePassageAttribution | null
  /** The passage the playback object has open. */
  playbackSpeechId: string | null
  /** Sentences queued or sounding for that passage. */
  hasQueuedAudio: boolean
  /** The store's global flag (synthesis started). Never sufficient on its own. */
  storeSpeaking: boolean
  capture: {
    open: boolean
    voiceState: string
    turnId: string | null
    /** Who the open microphone belongs to, when a caller can prove it. */
    owner?: VoiceTarget | null
  }
}

function ownsPassage(passage: VoicePassageAttribution, target: VoiceTarget): boolean | null {
  // A passage without a task is unattributed: nobody can prove it is theirs.
  if (!passage.taskId) return null
  if (target.kind === 'commander') return false
  return passage.taskId === target.id
}

function sameTarget(a: VoiceTarget, b: VoiceTarget): boolean {
  return a.kind === b.kind && (a.id ?? null) === (b.id ?? null)
}

/** Pure: the voice claim for one entity. */
export function deriveVoiceActivity(snapshot: VoiceActivitySnapshot, target: VoiceTarget): VoiceObservation {
  const micOpen = snapshot.capture.open && snapshot.capture.voiceState === 'listening' && Boolean(snapshot.capture.turnId)

  // Listening: open capture that provably belongs to this entity.
  let listening: VoiceObservation['state'] = 'none'
  if (micOpen) {
    const owner = snapshot.capture.owner
    listening = owner ? (sameTarget(owner, target) ? 'listening' : 'none') : 'unknown'
  }

  // Speaking: attributed passage, the same passage open in playback, audio queued/sounding.
  const passage = snapshot.passage
  const playbackLive = Boolean(passage && snapshot.playbackSpeechId === passage.speechId && snapshot.hasQueuedAudio)
  if (passage && playbackLive) {
    const owned = ownsPassage(passage, target)
    if (owned === true) return { state: 'speaking', ...(micOpen ? { micOpen: true } : {}) }
    if (owned === null) return { state: 'unknown' }
  } else if (snapshot.storeSpeaking || (snapshot.playbackSpeechId && !snapshot.hasQueuedAudio)) {
    // Synthesis pending or a silent open passage: not proof of speech. If it
    // could be this entity's, say so honestly rather than "none".
    const owned = passage ? ownsPassage(passage, target) : null
    if (owned !== false) return listening === 'listening' ? { state: 'listening' } : { state: 'unknown' }
  }

  if (listening === 'listening') return { state: 'listening' }
  if (listening === 'unknown') return { state: 'unknown' }
  return { state: 'none' }
}

// ── Live reader ─────────────────────────────────────────────

interface VoiceAttributionState {
  passage: VoicePassageAttribution | null
  /** Bumped by speech start/end so indicators re-read the playback object. */
  version: number
}

export const useVoiceAttributionStore = create<VoiceAttributionState>(() => ({ passage: null, version: 0 }))

let attributionOff: (() => void) | null = null

/** Starts recording which entity each spoken passage belongs to. Idempotent; safe without a bridge. */
export function ensureVoiceAttribution(): void {
  if (attributionOff) return
  try {
    const tts = typeof window !== 'undefined' ? window.electronAPI?.voice?.tts : undefined
    if (typeof tts?.onSpeechStart !== 'function' || typeof tts?.onSpeechEnd !== 'function') return
    const offStart = tts.onSpeechStart((event) => {
      if (!event?.speechId) return
      useVoiceAttributionStore.setState((s) => ({
        passage: { speechId: event.speechId, source: event.source, ...(event.taskId ? { taskId: event.taskId } : {}) },
        version: s.version + 1
      }))
    })
    const offEnd = tts.onSpeechEnd(() => {
      // The passage may still be draining; the playback object decides. Only re-read.
      useVoiceAttributionStore.setState((s) => ({ version: s.version + 1 }))
    })
    attributionOff = () => {
      offStart()
      offEnd()
    }
  } catch {
    attributionOff = null
  }
}

/** Reads the current snapshot from the voice store, playback and capture. */
export function readVoiceActivitySnapshot(owner?: VoiceTarget | null): VoiceActivitySnapshot {
  const voice = useVoiceStore.getState()
  return {
    passage: useVoiceAttributionStore.getState().passage,
    playbackSpeechId: voicePlayback.currentSpeechId,
    hasQueuedAudio: voicePlayback.hasQueuedAudio,
    storeSpeaking: voice.speaking,
    capture: {
      open: voiceCapture.isCapturing,
      voiceState: voice.state,
      turnId: voice.turnId,
      ...(owner !== undefined ? { owner } : {})
    }
  }
}

/**
 * React hook: the voice claim for `target`. Re-reads when the voice store's
 * speaking/listening facts or the passage attribution change.
 */
export function useVoiceActivity(target: VoiceTarget | null): VoiceObservation | null {
  // Narrow scalar selectors only: re-render on these facts, never per level frame.
  useVoiceStore((s) => s.speaking)
  useVoiceStore((s) => s.state)
  useVoiceStore((s) => s.turnId)
  useVoiceAttributionStore((s) => s.version)
  if (!target) return null
  return deriveVoiceActivity(readVoiceActivitySnapshot(), target)
}

/** Test-only reset. */
export function __resetVoiceAttribution(): void {
  attributionOff?.()
  attributionOff = null
  useVoiceAttributionStore.setState({ passage: null, version: 0 })
}
