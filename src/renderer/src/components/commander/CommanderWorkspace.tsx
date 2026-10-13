import { useEffect, useRef, useState } from 'react'
import { commanderApi } from '@/lib/ipc-client'
import { clearCommanderImageCache } from '@/lib/commander-images'
import { useCommanderStore } from '@/stores/commander-store'
import { CommanderChatPane } from './CommanderChatPane'
import { CommanderSessionList } from './CommanderSessionList'
import { Inbox, Menu, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/Dialog'
import { CommanderStage } from './CommanderStage'
import { useCommanderCallStore } from '@/stores/commander-call-store'
import { useCommanderCallUiStore, useCommanderPipVisible } from '@/stores/commander-call-ui-store'

/** Stage first, with a mounted Chat/Actions panel and a focus-contained sessions drawer. */
export function CommanderWorkspace() {
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const panelOpen = useCommanderCallUiStore(s => s.panelOpen)
  const setPanelOpen = useCommanderCallUiStore(s => s.setPanelOpen)
  const pip = useCommanderPipVisible()
  const [tab, setTab] = useState<'chat' | 'actions'>('chat')
  const sessionTrigger = useRef<HTMLButtonElement>(null)
  const sessionId = useCommanderStore((s) => s.selectedSessionId)
  const session = useCommanderStore(s => s.sessions.find(item => item.id === s.selectedSessionId))
  const inbox = useCommanderStore(s => s.reportInbox)
  const call = useCommanderCallStore()
  const subscribe = useCommanderStore((s) => s.subscribe)
  const fetchSessions = useCommanderStore((s) => s.fetchSessions)

  useEffect(() => () => clearCommanderImageCache(), [sessionId])

  useEffect(() => {
    const unsubscribe = subscribe()
    void fetchSessions()
    // Events were missed while the view was closed: reload the open session
    // (which also tells main it is the active one, #62).
    const open = useCommanderStore.getState().selectedSessionId
    if (open) void useCommanderStore.getState().selectSession(open)
    return () => {
      unsubscribe()
      void Promise.resolve(commanderApi.setActiveSession(null)).catch(() => {})
    }
  }, [subscribe, fetchSessions])

  return (
    <div className="commander-workspace ui-scale h-full min-h-0 min-w-0">
      <header className="commander-workspace-header">
        <Dialog open={sessionsOpen} onOpenChange={setSessionsOpen}>
          <DialogTrigger asChild><Button ref={sessionTrigger} variant="ghost" aria-label="Open Commander sessions"><Menu className="size-icon" aria-hidden="true" />Sessions</Button></DialogTrigger>
          <DialogContent className="commander-sessions-drawer ui-scale" aria-describedby="commander-sessions-description" onCloseAutoFocus={event => { event.preventDefault(); sessionTrigger.current?.focus() }}>
            <DialogHeader><DialogTitle>Commander sessions</DialogTitle><DialogDescription id="commander-sessions-description">Open a conversation or read project reports.</DialogDescription></DialogHeader>
            <CommanderSessionList onSelected={() => setSessionsOpen(false)} />
          </DialogContent>
        </Dialog>
        <h1 className="min-w-0 flex-1 break-words text-base font-medium">{session?.is_report_inbox ? 'Project reports' : session?.title || 'Commander'}</h1>
        {!!session?.unread_count && !session.is_report_inbox && <Button size="sm" variant="secondary" onClick={() => { setTab('chat'); setPanelOpen(true) }}>{session.unread_count} new {session.unread_count === 1 ? 'report' : 'reports'}</Button>}
        {inbox && <Button size="sm" variant={sessionId === inbox.id ? 'secondary' : 'outline'} aria-label={`Project reports, ${inbox.unread_count} unread`} onClick={() => { setTab('chat'); setPanelOpen(true); void useCommanderStore.getState().selectSession(inbox.id) }}><Inbox className="size-icon-sm" aria-hidden="true" />Project reports{inbox.unread_count > 0 && <span className="font-semibold">{inbox.unread_count}</span>}</Button>}
        {call.status !== 'off' && <span className="text-xs font-medium text-muted-foreground">{call.status === 'starting' ? 'Joining…' : 'Live'}</span>}
      </header>
      <div className="commander-layout commander-stage-layout">
        {pip ? <section className="commander-stage commander-stage-pip-placeholder" aria-label="Commander stage"><p className="text-base">{call.error ? 'Call needs attention in the floating view.' : 'Call continues in the floating view.'}</p><Button onClick={() => useCommanderCallUiStore.getState().expand()}>Expand Commander call</Button></section> : <CommanderStage panelOpen={panelOpen} onPanelToggle={() => setPanelOpen(!panelOpen)} compact={false} onCompactToggle={() => useCommanderCallUiStore.getState().showPip()} />}
        <aside className="commander-side-panel" aria-label="Commander side panel" hidden={!panelOpen}>
          <div className="flex shrink-0 items-center gap-1 border-b border-border p-2">
            <div className="flex flex-1 gap-1" role="tablist" aria-label="Commander panel" onKeyDown={event => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              event.preventDefault(); const next = tab === 'chat' ? 'actions' : 'chat'; setTab(next)
              document.getElementById(next === 'chat' ? 'commander-chat-tab' : 'commander-actions-tab')?.focus()
            }}>
              <Button size="sm" id="commander-chat-tab" role="tab" tabIndex={tab === 'chat' ? 0 : -1} aria-selected={tab === 'chat'} aria-controls="commander-panel" variant={tab === 'chat' ? 'secondary' : 'ghost'} onClick={() => setTab('chat')}>Chat</Button>
              <Button size="sm" id="commander-actions-tab" role="tab" tabIndex={tab === 'actions' ? 0 : -1} aria-selected={tab === 'actions'} aria-controls="commander-panel" variant={tab === 'actions' ? 'secondary' : 'ghost'} onClick={() => setTab('actions')}>Actions</Button>
            </div>
            <Button size="icon" variant="ghost" aria-label="Close Chat panel" onClick={() => { setPanelOpen(false); window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[aria-label="Show Chat panel"]')?.focus()) }}><X className="size-icon" aria-hidden="true" /></Button>
          </div>
          <div id="commander-panel" role="tabpanel" aria-labelledby={tab === 'chat' ? 'commander-chat-tab' : 'commander-actions-tab'} className="flex min-h-0 flex-1 flex-col">
            <CommanderChatPane key={sessionId} tab={tab} embedded />
          </div>
        </aside>
      </div>
    </div>
  )
}
