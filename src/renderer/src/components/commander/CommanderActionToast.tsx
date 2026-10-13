import { useEffect } from 'react'
import { parseCommanderAction } from '@shared/commander-action'
import { activityNow, scheduleActivityDeadline, useActivityClock } from '@/lib/activity/activity-clock'
import { useCommanderStore } from '@/stores/commander-store'
import { useCommanderCallStore } from '@/stores/commander-call-store'
import { useCommanderCallUiStore } from '@/stores/commander-call-ui-store'
import { ActionCard } from './ActionCard'

/** One toast for both call surfaces; announcements belong to CallAnnouncer. */
export function CommanderActionToast() {
  const notice = useCommanderStore(s => s.recentAction)
  const sessionId = useCommanderCallStore(s => s.sessionId)
  const selected = useCommanderStore(s => s.selectedSessionId)
  const corner = useCommanderCallUiStore(s => s.corner)
  useActivityClock(s => s.tick)
  useEffect(() => notice ? scheduleActivityDeadline(notice.observedAt + 8_000) : undefined, [notice])
  const live = notice && notice.result.session_id === (sessionId ?? selected) && activityNow() - notice.observedAt < 8_000
  const action = live && parseCommanderAction(notice.call.name, notice.result.content, notice.result.is_error)
  if (!live || !action) return null
  return <aside className={`commander-action-toast commander-action-toast-${corner} ui-scale`} aria-label="Latest Commander action" data-testid="commander-action-toast"><ActionCard call={notice.call} result={notice.result} requestedBy={notice.requestedBy} compact /></aside>
}
