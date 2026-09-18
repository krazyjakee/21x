import type { ReactNode } from 'react'
import { ChevronLeftIcon } from './icons'

export function BackButton({ onBack, className, iconClassName, ariaLabel }: {
  onBack: () => void
  className?: string
  iconClassName?: string
  ariaLabel?: string
}) {
  return (
    <button
      type="button"
      onClick={onBack}
      aria-label={ariaLabel}
      className={className ?? 'p-2 active:opacity-60 hover:bg-accent rounded-md transition-colors'}
    >
      <ChevronLeftIcon className={iconClassName ?? 'w-5 h-5 text-foreground'} />
    </button>
  )
}

export function PageHeader({ onBack, title, rightAction }: { onBack: () => void; title: string; rightAction?: ReactNode }) {
  return (
    <div className="shrink-0 flex items-center gap-2 px-2 py-3 border-b border-border">
      <BackButton onBack={onBack} />
      <h1 className="text-sm font-semibold truncate flex-1">{title}</h1>
      {rightAction}
    </div>
  )
}
