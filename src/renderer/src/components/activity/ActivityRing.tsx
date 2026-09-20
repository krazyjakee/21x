import type { ReactNode, Ref } from 'react'
import { activityPresentation, type ActivityResult } from '@/lib/activity/derive-activity'
import { useMotionOwner } from '@/lib/activity/motion-owner'
import { useReducedMotion } from '@/lib/activity/use-activity'

/**
 * BreathingRing (#95): a 2 px ring around a compact (24/32 px) or presence
 * (48–64 px) identity. Only thinking breathes (1 → 1.03, 2.4 s). Speaking is
 * a static ring here: #89 supplies the real output-level motion, so nothing
 * here imitates a waveform. The ring is hidden from assistive technology;
 * the adjacent state word carries the meaning.
 */
export function ActivityRing({
  result,
  entityKey,
  region,
  size = 32,
  allowMotion = true,
  levelDriven = false,
  elementRef,
  children
}: {
  result: ActivityResult
  entityKey: string
  region: string
  size?: 24 | 32 | 48 | 56 | 64
  allowMotion?: boolean
  levelDriven?: boolean
  elementRef?: Ref<HTMLSpanElement>
  children: ReactNode
}) {
  const reducedMotion = useReducedMotion()
  const wantsMotion = allowMotion && !reducedMotion && result.state === 'thinking'
  const motionOwner = useMotionOwner(region, entityKey, wantsMotion)
  const p = activityPresentation(result, { reducedMotion, motionOwner })
  const ringed = result.state !== 'idle' && result.state !== 'unknown' && result.state !== 'queued'
  return (
    <span
      ref={elementRef}
      className={`relative inline-grid shrink-0 place-items-center rounded-full activity-tone-${p.tone} ${levelDriven ? 'activity-speaking-level' : ''}`}
      style={{ width: size, height: size }}
      data-activity-state={result.state}
      data-activity-motion={p.motion}
    >
      {children}
      {ringed && (
        <span
          aria-hidden="true"
          data-activity-ring="true"
          className={`pointer-events-none absolute inset-0 rounded-full border-2 border-[var(--activity-color)] ${p.motion === 'ring' ? 'activity-ring-breathe' : ''}`}
        />
      )}
      {result.state === 'unknown' && (
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-full border-2 border-dashed border-[var(--activity-color)]/60" />
      )}
    </span>
  )
}
