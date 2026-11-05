import { useEffect, useLayoutEffect, useState, type CSSProperties } from 'react'
import { parseCommanderAction } from '@shared/commander-action'
import { activityNow, scheduleActivityDeadline, useActivityClock } from '@/lib/activity/activity-clock'
import { useCommanderStore } from '@/stores/commander-store'
import { useCommanderCallStore } from '@/stores/commander-call-store'
import { useCommanderCallUiStore, useCommanderPipVisible } from '@/stores/commander-call-ui-store'
import { ActionCard } from './ActionCard'

/** The floating call's inset from the window edge, and the gap above it. */
const PIP_INSET = 16
const PIP_GAP = 8

/** One toast for both call surfaces; announcements belong to CallAnnouncer. */
export function CommanderActionToast() {
  const notice = useCommanderStore(s => s.recentAction)
  const sessionId = useCommanderCallStore(s => s.sessionId)
  const selected = useCommanderStore(s => s.selectedSessionId)
  const corner = useCommanderCallUiStore(s => s.corner)
  const pip = useCommanderPipVisible()
  const [tileHeight, setTileHeight] = useState<number | null>(null)
  useActivityClock(s => s.tick)
  useEffect(() => notice ? scheduleActivityDeadline(notice.observedAt + 8_000) : undefined, [notice])
  const live = notice && notice.result.session_id === (sessionId ?? selected) && activityNow() - notice.observedAt < 8_000
  // The tile grows with captions and zoom, so a fixed offset can push the toast off a short window.
  useLayoutEffect(() => {
    const tile = live && pip ? document.querySelector<HTMLElement>('[data-testid="commander-pip"]') : null
    if (!tile) { setTileHeight(null); return undefined }
    const measure = () => setTileHeight(tile.getBoundingClientRect().height)
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(tile)
    return () => observer.disconnect()
  }, [live, pip, corner])
  const action = live && parseCommanderAction(notice.call.name, notice.result.content, notice.result.is_error)
  if (!live || !action) return null
  const offset = tileHeight === null ? undefined : { '--commander-toast-offset': `${PIP_INSET + tileHeight + PIP_GAP}px` } as CSSProperties
  return <aside className={`commander-action-toast commander-action-toast-${corner} ui-scale`} style={offset} aria-label="Latest Commander action" data-testid="commander-action-toast"><ActionCard call={notice.call} result={notice.result} requestedBy={notice.requestedBy} compact /></aside>
}
