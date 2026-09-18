import { useEffect } from 'react'
import { useCommanderStore } from '@/stores/commander-store'
import { CommanderChatPane } from './CommanderChatPane'
import { CommanderSessionList } from './CommanderSessionList'

/** Top-level Commander view: persisted sessions on the left, the open chat on the right. No canvas. */
export function CommanderWorkspace() {
  const subscribe = useCommanderStore((s) => s.subscribe)
  const fetchSessions = useCommanderStore((s) => s.fetchSessions)

  useEffect(() => {
    const unsubscribe = subscribe()
    void fetchSessions()
    // Events were missed while the view was closed: reload the open session.
    const open = useCommanderStore.getState().selectedSessionId
    if (open) void useCommanderStore.getState().selectSession(open)
    return unsubscribe
  }, [subscribe, fetchSessions])

  return (
    <div className="flex h-full min-h-0">
      <CommanderSessionList />
      <CommanderChatPane />
    </div>
  )
}
