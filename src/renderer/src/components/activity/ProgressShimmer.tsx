/**
 * ProgressShimmer (#95): a 2 px indeterminate line beside "Using [tool]".
 * Not a progressbar: no role, no aria-valuenow, no percentage. Static when
 * `moving` is false or under reduced motion (CSS).
 */
export function ProgressShimmer({ moving, className = '' }: { moving: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-moving={moving ? 'true' : 'false'}
      className={`activity-shimmer inline-block h-0.5 w-8 shrink-0 rounded-full ${className}`}
    />
  )
}
