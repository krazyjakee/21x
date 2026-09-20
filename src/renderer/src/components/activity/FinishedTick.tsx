import { Check } from 'lucide-react'
import type { ActivityTone } from '@/lib/activity/derive-activity'

/**
 * FinishedTick (#95): a 14 px check in the review (pink) or success tone.
 *
 * `accent` is `fade` for an observed completion (150 ms fade-in; the accent
 * settles after 3 s with a 250 ms fade), `static` under reduced motion or for
 * a non-owning mirror, and `none` for historical/hydrated completions. The
 * ordinary state label always stays beside it.
 */
export function FinishedTick({ tone, accent }: { tone: ActivityTone; accent: 'fade' | 'static' | 'none' }) {
  const toneClass = tone === 'success' ? 'activity-tone-success' : 'activity-tone-review'
  return (
    <span
      aria-hidden="true"
      data-accent={accent}
      className={`activity-accent inline-grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full ${toneClass} ${
        accent === 'none' ? 'bg-transparent' : 'bg-[color-mix(in_oklab,var(--activity-color)_22%,transparent)]'
      }`}
    >
      <Check
        className={`h-3.5 w-3.5 text-[var(--activity-color)] ${accent === 'fade' ? 'activity-tick-fade-in' : ''}`}
        strokeWidth={2.5}
      />
    </span>
  )
}
