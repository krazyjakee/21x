import { useState, useSyncExternalStore } from 'react'
import { getDesktopHost } from '@/lib/desktop-api'
import type { NativeDesktopHost } from '@/lib/native-desktop-host'

export function DesktopHostStatus() {
  const host = getDesktopHost()
  if (host.kind !== 'tauri') return null
  return <NativeHostStatus host={host as NativeDesktopHost} />
}
function NativeHostStatus({ host }: { host: NativeDesktopHost }) {
  const state = useSyncExternalStore(host.subscribeConnection, () => `${host.connection.status}:${host.hydrationPending}:${host.recoveryFailed}:${host.unavailableCapability ?? ''}:${host.bootstrapFailure ?? ''}`)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const ready = state.startsWith('ready:false:')
  return <aside className="shrink-0 border-b border-border bg-card px-4 py-2 text-sm" aria-label="Desktop connection">
    <span>{host.bootstrapFailure ?? (ready ? 'Connected. Some desktop features are unavailable in this preview.' : host.recoveryFailed ? 'Saved state could not be restored. Changes are paused.' : state.startsWith('ready:') ? 'Restoring saved tasks and conversations. Changes are paused.' : 'Desktop connection unavailable. Changes are paused.')}</span>
    {!ready && !host.bootstrapFailure && <button className="ml-3 underline disabled:opacity-50" disabled={busy} onClick={async () => {
      setBusy(true); setError('')
      try { await host.reconnect() } catch { setError(host.bootstrapFailure ? '' : 'Could not restore the desktop connection. Try again.') } finally { setBusy(false) }
    }}>Reconnect</button>}
    {error && <p role="alert" className="mt-1 text-destructive">{error}</p>}
    {host.unavailableCapability && <p role="alert" className="mt-1 text-destructive">This action is unavailable in this preview.</p>}
  </aside>
}
