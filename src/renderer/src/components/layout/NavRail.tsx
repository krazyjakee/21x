import { useUIStore } from '@/stores/ui-store'
import { NAV_ITEMS } from './nav-items'
import { modKey } from '@/lib/platform'

/** Primary navigation — slim vertical icon rail. */
export function NavRail() {
  const sidebarView = useUIStore((s) => s.sidebarView)
  const setSidebarView = useUIStore((s) => s.setSidebarView)
  const activeModal = useUIStore((s) => s.activeModal)
  const closeModal = useUIStore((s) => s.closeModal)

  return (
    <nav className="app-chrome no-drag flex w-11 flex-shrink-0 flex-col items-center gap-1 bg-background py-1.5">
      {NAV_ITEMS.map(({ key, label, icon: Icon }, i) => {
        const active = sidebarView === key && activeModal !== 'settings'
        return (
          <button
            key={key}
            onClick={() => {
              if (activeModal === 'settings') closeModal()
              setSidebarView(key)
            }}
            aria-label={label}
            className={`group relative grid h-9 w-9 place-items-center rounded-lg transition-all duration-150 cursor-pointer ${
              active
                ? 'bg-primary/12 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            {active && (
              <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
            )}
            <Icon className="h-5 w-5" aria-hidden="true" />
            <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 flex -translate-y-1/2 translate-x-[-4px] items-center gap-2 whitespace-nowrap rounded-lg border border-border bg-popover px-2 py-1 text-[12px] font-medium text-foreground opacity-0 shadow-pop transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100">
              {label}
              <kbd className="rounded border border-border bg-muted px-1 text-[10px] text-muted-foreground">{modKey}{i + 1}</kbd>
            </span>
          </button>
        )
      })}
    </nav>
  )
}
