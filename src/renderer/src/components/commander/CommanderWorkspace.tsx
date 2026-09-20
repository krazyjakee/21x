import { useEffect } from 'react'
import { commanderApi } from '@/lib/ipc-client'
import { clearCommanderImageCache } from '@/lib/commander-images'
import { useCommanderStore } from '@/stores/commander-store'
import { CommanderChatPane } from './CommanderChatPane'
import { CommanderSessionList } from './CommanderSessionList'
import { CommanderVoiceControls } from './CommanderVoiceControls'

/** Top-level Commander view: persisted sessions on the left, the open chat on the right. No canvas. */
export function CommanderWorkspace() {
  const sessionId = useCommanderStore((s) => s.selectedSessionId)
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
      // The view is closed: reports only queue as unread until it opens again.
      void Promise.resolve(commanderApi.setActiveSession(null)).catch(() => {})
    }
  }, [subscribe, fetchSessions])

  return (
    <div className="flex h-full min-h-0">
      <CommanderSessionList />
      <CommanderChatPane key={sessionId} />
      <CommanderVoiceControls />
    </div>
  )
}
