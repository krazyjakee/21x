export const ICON_PROPS = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export function ChevronLeftIcon({ className }: { className?: string }) {
  return <svg className={className} {...ICON_PROPS}><path d="m15 18-6-6 6-6" /></svg>
}

export function ChevronRightIcon({ className }: { className?: string }) {
  return <svg className={className} {...ICON_PROPS}><path d="m9 18 6-6-6-6" /></svg>
}
