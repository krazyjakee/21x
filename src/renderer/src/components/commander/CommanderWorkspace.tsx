import { useEffect } from 'react'
import { commanderApi } from '@/lib/ipc-client'
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
    // Tell main the open session again (#62): reports that arrived while the
    // view was closed are handed to its agent now.
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
      <CommanderChatPane />
    </div>
  )
}
