import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Settings } from 'lucide-react'
import { useUIStore } from '@/stores/ui-store'
import { NAV_ITEMS } from './nav-items'
import { modKey } from '@/lib/platform'
import { ActivityBadge, activityAccessibleName } from '@/components/activity/ActivityBadge'
import { useCommanderActivity } from '@/lib/activity/use-activity'
import { isQuietActivity } from '@/lib/activity/derive-activity'

function RailButton({ name, active, shortcut, onClick, children }: {
  name: string
  active: boolean
  shortcut?: string
  onClick: () => void
  children: ReactNode
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!anchor) return
    const dismiss = () => setAnchor(null)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [anchor])
  const rect = anchor?.getBoundingClientRect()

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={(event) => setAnchor(event.currentTarget)}
      onMouseLeave={() => setAnchor(null)}
      onFocus={(event) => setAnchor(event.currentTarget)}
      onBlur={() => setAnchor(null)}
      onKeyDown={(event) => { if (event.key === 'Escape') setAnchor(null) }}
      aria-label={name}
      aria-current={active ? 'page' : undefined}
      className={`relative grid size-hit-lg shrink-0 place-items-center rounded-lg transition-colors duration-150 cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
        active
          ? 'bg-primary/12 text-primary'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      }`}
    >
      {active && (
        <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
      )}
      {children}
      {/* Portal keeps the shared tooltip clear of the main group's scroll clipping. */}
      {rect && createPortal(
        <span
          role="tooltip"
          className="ui-scale pointer-events-none fixed z-50 flex -translate-y-1/2 items-center gap-2 whitespace-nowrap rounded-lg border border-border bg-popover px-2 py-1 text-xs font-medium text-foreground shadow-pop"
          style={{ left: rect.right + 8, top: rect.top + rect.height / 2 }}
        >
          {name}
          {shortcut && <kbd className="rounded border border-border bg-muted px-1 text-2xs text-muted-foreground">{shortcut}</kbd>}
        </span>,
        document.body
      )}
    </button>
  )
}

/** Primary navigation — slim vertical icon rail. */
export function NavRail() {
  const sidebarView = useUIStore((s) => s.sidebarView)
  const setSidebarView = useUIStore((s) => s.setSidebarView)
  const activeModal = useUIStore((s) => s.activeModal)
  const closeModal = useUIStore((s) => s.closeModal)
  const openSettings = useUIStore((s) => s.openSettings)
  // A compact, static Commander state glyph (#95). The rail never animates
  // and never mirrors another surface's motion.
  const commander = useCommanderActivity()
  const showCommanderState = !isQuietActivity(commander)

  return (
    <nav className="ui-scale app-chrome no-drag flex min-h-0 w-11 flex-shrink-0 flex-col items-center bg-background py-1.5">
      <div role="group" aria-label="Main views" className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto py-0.5">
        {NAV_ITEMS.map(({ key, label, icon: Icon }, i) => {
          const active = sidebarView === key && activeModal !== 'settings'
          const stateHere = key === 'commander' && showCommanderState
          const name = stateHere ? activityAccessibleName(label, commander) : label
          return (
            <RailButton
              key={key}
              name={name}
              active={active}
              shortcut={`${modKey}${i + 1}`}
              onClick={() => {
                if (activeModal === 'settings') closeModal()
                setSidebarView(key)
              }}
            >
              <Icon className="size-icon-lg" aria-hidden="true" />
              {stateHere && (
                <ActivityBadge
                  result={commander}
                  entityName={label}
                  entityKey="commander"
                  region="nav-rail"
                  variant="dot"
                  size="chrome"
                  allowMotion={false}
                  decorative
                  className="absolute -bottom-0.5 -right-0.5 rounded-full bg-background px-0.5"
                />
              )}
            </RailButton>
          )
        })}
      </div>
      <div role="group" aria-label="Settings" className="mt-auto flex w-full shrink-0 flex-col items-center border-t border-border/70 pt-1.5">
        <RailButton name="Settings" active={activeModal === 'settings'} onClick={openSettings}>
          <Settings className="size-icon-lg" aria-hidden="true" />
        </RailButton>
      </div>
    </nav>
  )
}
