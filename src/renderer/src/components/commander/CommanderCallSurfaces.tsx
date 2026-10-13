import { useEffect } from 'react'
import { useCommanderStore } from '@/stores/commander-store'
import { useCommanderCallStore } from '@/stores/commander-call-store'
import { useCommanderCallUiStore } from '@/stores/commander-call-ui-store'
import { CallAnnouncer } from './CallAnnouncer'
import { CommanderActionToast } from './CommanderActionToast'
import { CommanderPip } from './CommanderPip'

/** Mounted once beside the media host, independently of workspace navigation. */
export function CommanderCallSurfaces() {
  const subscribe = useCommanderStore(s => s.subscribe)
  const status = useCommanderCallStore(s => s.status)
  const error = useCommanderCallStore(s => s.error)
  useEffect(() => subscribe(), [subscribe])
  useEffect(() => { if (status === 'off' && !error) useCommanderCallUiStore.setState({ pipRequested: false }) }, [status, error])
  return <><CallAnnouncer /><CommanderPip /><CommanderActionToast /></>
}
