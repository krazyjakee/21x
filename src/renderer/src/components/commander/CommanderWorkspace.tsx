import { useEffect, useRef, useState } from 'react'
import { History, ListChecks, Menu, MessageSquare, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { commanderApi } from '@/lib/ipc-client'
import { useCommanderCallStore } from '@/stores/commander-call-store'
import { useCommanderStore } from '@/stores/commander-store'
import { CommanderChatPane } from './CommanderChatPane'
import { CommanderSessionDrawer } from './CommanderSessionDrawer'
import { UNTITLED_SESSION } from './CommanderSessionList'
import { CommanderVoiceControls } from './CommanderVoiceControls'

function formatDuration(startedAt: number | null, now: number): string {
  if (!startedAt) return '00:00'
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000))
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function CallClock({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!startedAt) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  return <span className="tabular-nums">Live {formatDuration(startedAt, now)}</span>
}

/** Stage-first Commander view with a sessions drawer and Chat/Actions side panel. */
export function CommanderWorkspace() {
  const subscribe = useCommanderStore((s) => s.subscribe)
  const fetchSessions = useCommanderStore((s) => s.fetchSessions)
  const session = useCommanderStore((s) => s.sessions.find((item) => item.id === s.selectedSessionId))
  const unread = useCommanderStore((s) => s.sessions.reduce((total, item) => total + item.unread_count, 0))
  const callStatus = useCommanderCallStore((s) => s.status)
  const callSessionId = useCommanderCallStore((s) => s.sessionId)
  const startedAt = useCommanderCallStore((s) => s.startedAt)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(true)
  const [captionsEnabled, setCaptionsEnabled] = useState(true)
  const [panelTab, setPanelTab] = useState<'chat' | 'actions'>('chat')
  const sessionsButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const unsubscribe = subscribe()
    void fetchSessions()
    // Events were missed while the view was closed: reload the open session
    // (which also tells main it is the active one, #62).
    const open = useCommanderStore.getState().selectedSessionId
    if (open) void useCommanderStore.getState().selectSession(open)
    return () => {
      unsubscribe()
      // The view is closed: reports only queue as unread until it opens again.
      void Promise.resolve(commanderApi.setActiveSession(null)).catch(() => {})
    }
  }, [subscribe, fetchSessions])

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-muted/10">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-card/80 px-3 backdrop-blur">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            ref={sessionsButton}
            size="sm"
            variant="ghost"
            aria-haspopup="dialog"
            aria-expanded={sessionsOpen}
            onClick={() => setSessionsOpen(true)}
          >
            <Menu className="size-4" aria-hidden="true" />
            Sessions
            {unread > 0 && (
              <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground" aria-label={`${unread} unread sessions`}>
                {unread}
              </span>
            )}
          </Button>
          <span className="text-border" aria-hidden="true">/</span>
          <h1 className="truncate text-sm font-medium">{session?.title || UNTITLED_SESSION}</h1>
        </div>
        {callStatus !== 'off' && callSessionId === session?.id && (
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <span className="size-2 rounded-full bg-destructive" aria-hidden="true" />
            <CallClock startedAt={startedAt} />
          </div>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1" aria-label="Commander stage">
          <CommanderVoiceControls
            captionsEnabled={captionsEnabled}
            onCaptionsEnabledChange={setCaptionsEnabled}
            panelOpen={panelOpen}
            onPanelOpenChange={setPanelOpen}
          />
        </main>

        <aside
          className={`${panelOpen ? 'flex' : 'hidden'} w-[min(25rem,42vw)] min-w-72 shrink-0 flex-col border-l border-border bg-card`}
          aria-label="Commander side panel"
          aria-hidden={!panelOpen}
        >
            <div className="flex h-12 shrink-0 items-center border-b border-border px-2">
              <div role="tablist" aria-label="Commander panel" className="flex flex-1 items-center gap-1">
                <button
                  type="button"
                  role="tab"
                  aria-selected={panelTab === 'chat'}
                  aria-controls="commander-chat-panel"
                  className={`flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium ${panelTab === 'chat' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  onClick={() => setPanelTab('chat')}
                >
                  <MessageSquare className="size-3.5" aria-hidden="true" />
                  Chat
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={panelTab === 'actions'}
                  aria-controls="commander-actions-panel"
                  className={`flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium ${panelTab === 'actions' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  onClick={() => setPanelTab('actions')}
                >
                  <ListChecks className="size-3.5" aria-hidden="true" />
                  Actions
                </button>
              </div>
              <Button size="icon" variant="ghost" aria-label="Close side panel" onClick={() => setPanelOpen(false)}>
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>

            {panelTab === 'chat' ? (
              <div id="commander-chat-panel" role="tabpanel" className="flex min-h-0 flex-1">
                <CommanderChatPane />
              </div>
            ) : (
              <div id="commander-actions-panel" role="tabpanel" className="flex flex-1 items-center justify-center p-6 text-center">
                <div className="max-w-56 text-muted-foreground">
                  <History className="mx-auto mb-3 size-6" aria-hidden="true" />
                  <p className="text-sm font-medium text-foreground">No recent actions</p>
                  <p className="mt-1 text-xs leading-relaxed">Changes the Commander makes will appear here.</p>
                </div>
              </div>
            )}
        </aside>
      </div>

      <CommanderSessionDrawer
        open={sessionsOpen}
        onClose={() => setSessionsOpen(false)}
        returnFocus={sessionsButton}
      />
    </div>
  )
}
