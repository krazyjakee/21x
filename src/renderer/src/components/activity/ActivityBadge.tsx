import {
  Check,
  CircleAlert,
  CircleSlash,
  Clock,
  Hand,
  MessageCircleQuestion,
  MessageSquareMore,
  Mic,
  Minus,
  Play,
  Volume2,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import {
  activityPresentation,
  type ActivityIconKey,
  type ActivityResult
} from '@/lib/activity/derive-activity'
import { useMotionOwner } from '@/lib/activity/motion-owner'
import { useReducedMotion } from '@/lib/activity/use-activity'
import { ProgressShimmer } from './ProgressShimmer'
import { FinishedTick } from './FinishedTick'

export const ACTIVITY_ICONS: Record<ActivityIconKey, LucideIcon> = {
  running: Play,
  thinking: MessageSquareMore,
  tool: Wrench,
  approval: Hand,
  question: MessageCircleQuestion,
  queued: Clock,
  speaking: Volume2,
  listening: Mic,
  finished: Check,
  failed: CircleAlert,
  idle: Minus,
  unknown: CircleSlash
}

const TOOLTIP_PLACEMENT = {
  below: 'left-1/2 top-full mt-1 -translate-x-1/2',
  above: 'right-0 bottom-full mb-1',
  right: 'left-full top-1/2 ml-2 -translate-y-1/2'
} as const

/** "Captain — Needs approval · detail": the one accessible name of an indicator. */
export function activityAccessibleName(entityName: string, result: ActivityResult): string {
  return `${entityName} — ${result.label}${result.detail ? ` · ${result.detail}` : ''}`
}

export interface ActivityBadgeProps {
  result: ActivityResult
  /** Who this is about: "Captain", a task title, "Commander". */
  entityName: string
  /** Stable key of the entity, for motion ownership across mirrors. */
  entityKey: string
  /** Motion region (one moving indicator per region). */
  region: string
  /**
   * `badge`: icon + word (20–24 px high).
   * `dot`: compact 6/8 px dot + static icon; the word is available on focus.
   */
  variant?: 'badge' | 'dot'
  /** Dot size: 6 px in chrome, 8 px in content. */
  size?: 'chrome' | 'content'
  /** False forces a static indicator (mirrors, dense lists). */
  allowMotion?: boolean
  /**
   * When the badge sits inside a control that already carries the state in
   * its own accessible name, render it hidden from assistive technology.
   */
  decorative?: boolean
  /** Where the focus/hover label opens for the dot variant. */
  tooltipPlacement?: 'below' | 'above' | 'right'
  className?: string
}

/**
 * ActivityBadge / ActivityDot (#95). Never a live region: announcements go
 * through the one ActivityAnnouncer. Decorative parts are aria-hidden and the
 * whole indicator has a single accessible name.
 */
export function ActivityBadge({
  result,
  entityName,
  entityKey,
  region,
  variant = 'badge',
  size = 'content',
  allowMotion = true,
  decorative = false,
  tooltipPlacement = 'below',
  className = ''
}: ActivityBadgeProps) {
  const reducedMotion = useReducedMotion()
  const wantsMotion = allowMotion && !reducedMotion && (result.state === 'running' || result.state === 'thinking' || result.state === 'tool')
  const motionOwner = useMotionOwner(region, entityKey, wantsMotion)
  const p = activityPresentation(result, { reducedMotion, motionOwner })
  const Icon = ACTIVITY_ICONS[p.icon]
  const name = activityAccessibleName(entityName, result)
  const toneClass = `activity-tone-${p.tone}`
  const a11y = decorative
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': name } as const)

  if (variant === 'dot') {
    const dotSize = size === 'chrome' ? 'h-1.5 w-1.5' : 'h-2 w-2'
    return (
      <span
        {...a11y}
        data-activity-state={result.state}
        data-activity-motion={p.motion}
        tabIndex={decorative ? undefined : 0}
        className={`group/activity relative inline-flex items-center gap-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring ${toneClass} ${className}`}
      >
        {p.hollow ? (
          <span aria-hidden="true" className={`${dotSize} rounded-full border border-[var(--activity-color)]`} />
        ) : (
          <span
            aria-hidden="true"
            className={`${dotSize} rounded-full bg-[var(--activity-color)] ${p.motion === 'breathe' ? 'activity-breathe' : ''}`}
          />
        )}
        <Icon aria-hidden="true" className="h-3 w-3 text-[var(--activity-color)]" strokeWidth={2.25} />
        {!decorative && (
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute z-50 hidden whitespace-nowrap ${TOOLTIP_PLACEMENT[tooltipPlacement]} rounded-md border border-border bg-popover px-2 py-1 text-[11px] font-medium text-foreground shadow-pop group-hover/activity:block group-focus-visible/activity:block`}
          >
            {name}
          </span>
        )}
      </span>
    )
  }

  return (
    <span
      {...a11y}
      data-activity-state={result.state}
      data-activity-motion={p.motion}
      title={name}
      className={`relative inline-flex h-5 max-w-full items-center gap-1 overflow-hidden rounded-full border px-1.5 text-[11px] font-medium leading-none text-foreground ${toneClass} ${
        p.hollow ? 'border-dashed border-[var(--activity-color)]/60 bg-transparent' : 'border-[var(--activity-color)]/35 bg-[color-mix(in_oklab,var(--activity-color)_12%,transparent)]'
      } ${className}`}
    >
      {result.state === 'finished' ? (
        <FinishedTick tone={p.tone} accent={p.accent} />
      ) : (
        <Icon
          aria-hidden="true"
          className={`h-3 w-3 shrink-0 text-[var(--activity-color)] ${p.motion === 'breathe' ? 'activity-breathe' : ''}`}
          strokeWidth={2.25}
        />
      )}
      <span aria-hidden="true" className="truncate">
        {result.label}
      </span>
      {result.state === 'tool' && <ProgressShimmer moving={p.motion === 'shimmer'} />}
    </span>
  )
}
