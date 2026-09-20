import { useEffect, type RefObject } from 'react'
import { voicePlayback } from '@/lib/voice-playback'
import {
  deriveVoiceActivity,
  readVoiceActivitySnapshot,
  useVoicePlaybackOwnership,
  type VoiceTarget
} from './voice-activity-adapter'
import { useReducedMotion } from './use-activity'

/** Four stable levels become four opacity steps under reduced motion. */
export function speakingRingLevel(level: number, reducedMotion: boolean): number {
  const safe = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0))
  if (!reducedMotion) return safe
  if (safe < 0.08) return 0
  if (safe < 0.3) return 1 / 3
  if (safe < 0.6) return 2 / 3
  return 1
}

/**
 * Writes playback loudness straight to the visible ring. Ownership and queue
 * state are re-verified on every frame, but no React/global store is updated.
 */
export function useSpeakingRing(
  elementRef: RefObject<HTMLElement | null>,
  target: VoiceTarget | null
): void {
  const reducedMotion = useReducedMotion()
  const ownsPlayback = useVoicePlaybackOwnership(target)
  const targetKind = target?.kind
  const targetId = target?.id

  useEffect(() => {
    const element = elementRef.current
    if (!element) return
    element.style.setProperty('--speaking-level', '0')
    element.dataset.speakingMotion = reducedMotion ? 'stepped' : 'continuous'
    if (!targetKind || !ownsPlayback) return
    const effectTarget: VoiceTarget = { kind: targetKind, ...(targetId ? { id: targetId } : {}) }

    const writeLevel = (rawLevel: number): void => {
      const speaking = deriveVoiceActivity(readVoiceActivitySnapshot(), effectTarget).state === 'speaking'
      const level = speaking ? speakingRingLevel(rawLevel, reducedMotion) : 0
      element.style.setProperty('--speaking-level', String(level))
    }
    const unsubscribe = voicePlayback.subscribeLevel(writeLevel)
    return () => {
      unsubscribe()
      element.style.setProperty('--speaking-level', '0')
    }
  }, [elementRef, ownsPlayback, reducedMotion, targetKind, targetId])
}
