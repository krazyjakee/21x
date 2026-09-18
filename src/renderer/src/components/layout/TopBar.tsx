import { useEffect, useState } from 'react'
import { MessageSquare, Settings, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { UpdateDialog } from '@/components/update/UpdateDialog'
import { TopBarVoiceButton } from '@/components/voice/TopBarVoiceButton'
import { useUIStore } from '@/stores/ui-store'
import { updaterApi } from '@/lib/ipc-client'
import logo20x from '@/assets/logos/20x.svg'
import { ThemeToggle } from './ThemeToggle'
import { NAV_ITEMS } from './nav-items'
import { isWindows, modKey } from '@/lib/platform'

const WINDOWS_TITLEBAR_ACTION_RIGHT = 168

/** Drag region with logo + breadcrumb (left), command launcher (center), and global actions (right). */
export function TopBar({ onOpenCommandPalette }: { onOpenCommandPalette: () => void }) {
  const sidebarView = useUIStore((s) => s.sidebarView)
  const activeModal = useUIStore((s) => s.activeModal)
  const openSettings = useUIStore((s) => s.openSettings)
  const showOrchestrator = useUIStore((s) => s.showOrchestrator)
  const toggleOrchestrator = useUIStore((s) => s.toggleOrchestrator)
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  const toggleSidebarCollapsed = useUIStore((s) => s.toggleSidebarCollapsed)

  const [updateAvailableVersion, setUpdateAvailableVersion] = useState<string | null>(null)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)

  useEffect(() => {
    const cleanupStatus = updaterApi.onStatus((data) => {
      if (data.status === 'available' || data.status === 'downloading' || data.status === 'downloaded') {
        setUpdateAvailableVersion(data.version ?? null)
      } else if (data.status === 'up-to-date') {
        setUpdateAvailableVersion(null)
      }
    })
    const cleanupMenu = updaterApi.onMenuCheckForUpdates(() => {
      setUpdateDialogOpen(true)
    })
    return () => {
      cleanupStatus()
      cleanupMenu()
    }
  }, [])

  const breadcrumb = activeModal === 'settings'
    ? { label: 'Settings', icon: Settings }
    : NAV_ITEMS.find((n) => n.key === sidebarView)
  const BreadcrumbIcon = breadcrumb?.icon

  return (
    <>
      <div className="app-chrome drag-region bg-background h-11 flex-shrink-0 flex items-center justify-center px-3 pt-2 windows-titlebar-pad">
        {/* The white logo mark always sits on a brand-gradient tile, so it stays visible in both themes. */}
        <div className="no-drag absolute left-3 flex items-center gap-1.5 macos-titlebar-pad">
          <div className="relative grid h-6 w-6 place-items-center rounded-md bg-gradient-to-br from-primary to-primary/75 shadow-sm ring-1 ring-black/5">
            <img src={logo20x} className="h-3.5 w-3.5" alt="20x" />
            {updateAvailableVersion && (
              <button
                onClick={() => {
                  setUpdateDialogOpen(true)
                }}
                className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-warning ring-2 ring-[var(--chrome-solid)] cursor-pointer animate-pulse"
                title={`Update available: v${updateAvailableVersion}`}
              />
            )}
          </div>
          <span className="text-[13px] font-semibold tracking-tight text-foreground">20x</span>

          {/* Only views with a contextual sidebar get the collapse toggle */}
          {(sidebarView === 'tasks' || sidebarView === 'skills') && activeModal !== 'settings' && (
            <button
              onClick={toggleSidebarCollapsed}
              title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
              aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
              className="ml-0.5 grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
            >
              {sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </button>
          )}

          {breadcrumb && BreadcrumbIcon && (
            <div className="flex items-center gap-1.5">
              <span className="text-border/80 text-[13px]">/</span>
              <BreadcrumbIcon className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[13px] font-medium text-foreground/90">{breadcrumb.label}</span>
            </div>
          )}
        </div>

        <button
          onClick={() => {
            onOpenCommandPalette()
          }}
          title="Search or run a command"
          className="no-drag flex h-8 w-[260px] max-w-[34vw] items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 text-[12px] text-muted-foreground shadow-xs transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
        >
          <Search className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 truncate text-left">Search or run a command…</span>
          <kbd className="shrink-0 rounded border border-border bg-background/60 px-1.5 py-0.5 text-[11px]">{modKey}K</kbd>
        </button>

        {/* Offset on Windows to avoid the native window controls. */}
        <div
          className="no-drag absolute right-4 flex items-center gap-1 windows-titlebar-actions"
          style={isWindows ? { right: WINDOWS_TITLEBAR_ACTION_RIGHT } : undefined}
        >
          <ThemeToggle />
          <button
            onClick={openSettings}
            title="Settings"
            aria-label="Settings"
            className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
          >
            <Settings className="h-4 w-4" />
          </button>
          <div className="mx-1 h-4 w-px bg-border/70" />
          {/* Start talking to Mastermind from any view. Hidden until voice is on. */}
          <TopBarVoiceButton />
          {/* Quieter than the microphone beside it: typing to Mastermind is
              the fallback, speaking to it is the invitation. */}
          <Button
            variant={showOrchestrator ? 'default' : 'ghost'}
            size="sm"
            onClick={toggleOrchestrator}
            className="h-8 px-2.5"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            <span className="text-[12px]">Mastermind</span>
          </Button>
        </div>
      </div>

      <UpdateDialog open={updateDialogOpen} onClose={() => setUpdateDialogOpen(false)} />
    </>
  )
}
