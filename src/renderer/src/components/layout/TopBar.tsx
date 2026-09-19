import { useEffect, useState } from 'react'
import { MessageSquare, Settings, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { UpdateDialog } from '@/components/update/UpdateDialog'
import { TopBarVoiceButton } from '@/components/voice/TopBarVoiceButton'
import { useUIStore } from '@/stores/ui-store'
import { updaterApi } from '@/lib/ipc-client'
import logo20x from '@/assets/logos/20x.svg'
import { ThemeToggle } from './ThemeToggle'
import { ProjectSwitcher } from './ProjectSwitcher'
import { NAV_ITEMS } from './nav-items'
import { modKey } from '@/lib/platform'
import { useTitleBarOverlayTheme } from '@/hooks/use-title-bar-overlay-theme'
import { ActivityBadge, activityAccessibleName } from '@/components/activity/ActivityBadge'
import { useCaptainActivity } from '@/lib/activity/use-activity'
import { isQuietActivity } from '@/lib/activity/derive-activity'
import { useCaptainTaskId } from '@/stores/coordinator-store'

/** Drag region with logo + breadcrumb (left), command launcher (center), and global actions (right). */
export function TopBar({ onOpenCommandPalette }: { onOpenCommandPalette: () => void }) {
  const sidebarView = useUIStore((s) => s.sidebarView)
  const activeModal = useUIStore((s) => s.activeModal)
  const openSettings = useUIStore((s) => s.openSettings)
  const showOrchestrator = useUIStore((s) => s.showOrchestrator)
  const toggleOrchestrator = useUIStore((s) => s.toggleOrchestrator)
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  const toggleSidebarCollapsed = useUIStore((s) => s.toggleSidebarCollapsed)

  // The project Captain's live state on its entry button (#95). A static
  // mirror: the Captain's own conversation surface owns any motion.
  const captainTaskId = useCaptainTaskId()
  const captainActivity = useCaptainActivity(captainTaskId)
  const showCaptainState = !isQuietActivity(captainActivity)

  const [updateAvailableVersion, setUpdateAvailableVersion] = useState<string | null>(null)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)

  useTitleBarOverlayTheme()

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
      <div className="ui-scale app-chrome drag-region bg-background h-9 flex-shrink-0 flex items-center justify-center px-3 windows-titlebar-pad">
        {/* The white logo mark always sits on a brand-gradient tile, so it stays visible in both themes. */}
        <div className="no-drag absolute left-3 flex items-center gap-1.5 macos-titlebar-pad">
          <div className="relative grid h-6 w-6 place-items-center rounded-md bg-gradient-to-br from-primary to-primary/75 shadow-sm ring-1 ring-black/5">
            <img src={logo20x} className="size-icon-sm" alt="21x" />
            {updateAvailableVersion && (
              <button
                onClick={() => {
                  setUpdateDialogOpen(true)
                }}
                className="absolute -top-2 -right-2 grid h-5 w-5 place-items-center rounded-full cursor-pointer"
                title={`Update available: v${updateAvailableVersion}`}
                aria-label={`Update available: v${updateAvailableVersion}`}
              >
                <span className="h-2.5 w-2.5 rounded-full bg-warning ring-2 ring-[var(--chrome-solid)] animate-pulse" />
              </button>
            )}
          </div>
          <span className="text-sm font-semibold tracking-tight text-foreground">21x</span>

          {/* Only views with a contextual sidebar get the collapse toggle */}
          {(sidebarView === 'tasks' || sidebarView === 'skills') && activeModal !== 'settings' && (
            <button
              onClick={toggleSidebarCollapsed}
              title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
              aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
              className="ml-0.5 grid size-hit place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
            >
              {sidebarCollapsed ? <PanelLeftOpen className="size-icon" /> : <PanelLeftClose className="size-icon" />}
            </button>
          )}

          {/* The current project. Commander is cross-project, so it has no switcher. */}
          {(sidebarView !== 'commander' || activeModal === 'settings') && (
            <div className="flex items-center gap-1">
              <span className="text-border/80 text-sm">/</span>
              <ProjectSwitcher />
            </div>
          )}

          {breadcrumb && BreadcrumbIcon && (
            <div className="flex items-center gap-1.5">
              <span className="text-border/80 text-sm">/</span>
              <BreadcrumbIcon className="size-icon-sm text-muted-foreground" />
              <span className="text-sm font-medium text-foreground/90">{breadcrumb.label}</span>
            </div>
          )}
        </div>

        <button
          onClick={() => {
            onOpenCommandPalette()
          }}
          title="Search or run a command"
          className="no-drag flex h-8 w-[260px] max-w-[34vw] items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 text-sm text-muted-foreground shadow-xs transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
        >
          <Search className="size-icon-sm shrink-0" />
          <span className="flex-1 truncate text-left">Search or run a command…</span>
          <kbd className="shrink-0 rounded border border-border bg-background/60 px-1.5 py-0.5 text-2xs">{modKey}K</kbd>
        </button>

        {/* Offset past the native window controls on Windows/Linux. */}
        <div className="no-drag absolute flex items-center gap-1 windows-titlebar-actions">
          <ThemeToggle />
          <button
            onClick={openSettings}
            title="Settings"
            aria-label="Settings"
            className="grid size-hit place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
          >
            <Settings className="size-icon" />
          </button>
          <div className="mx-1 h-5 w-px bg-border/70" />
          {/* Start talking to Captain from any view. Hidden until voice is on. */}
          <TopBarVoiceButton />
          {/* Quieter than the microphone beside it: typing to Captain is
              the fallback, speaking to it is the invitation. */}
          <Button
            variant={showOrchestrator ? 'default' : 'ghost'}
            size="sm"
            onClick={toggleOrchestrator}
            className="h-8 px-2.5"
            aria-label={showCaptainState ? activityAccessibleName('Captain', captainActivity) : undefined}
            title={showCaptainState ? activityAccessibleName('Captain', captainActivity) : undefined}
          >
            <MessageSquare className="size-icon-sm" />
            <span className="text-sm">Captain</span>
            {showCaptainState && (
              <ActivityBadge
                result={captainActivity}
                entityName="Captain"
                entityKey={`task:${captainTaskId}`}
                region="top-bar"
                variant="dot"
                size="chrome"
                allowMotion={false}
                decorative
              />
            )}
          </Button>
        </div>
      </div>

      <UpdateDialog open={updateDialogOpen} onClose={() => setUpdateDialogOpen(false)} />
    </>
  )
}
