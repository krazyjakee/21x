import { installDesktopHost } from './lib/desktop-api'
import { createNativeDesktopHost } from './lib/native-desktop-host'
import type { TauriDesktopApi } from './lib/tauri-desktop-transport'

async function bootstrap(): Promise<void> {
  const native = (window as unknown as { __TAURI__?: TauriDesktopApi }).__TAURI__
  if (!native) throw new Error('Native desktop host unavailable')
  const host = createNativeDesktopHost(native)
  const release = installDesktopHost(host)
  window.addEventListener('pagehide', release, { once: true })
  // Trusted native epoch and validated listener precede every production import.
  await host.reconnect()
  await import('./main')
  const { rehydrateProductionDesktop } = await import('./lib/desktop-rehydration')
  host.setRehydrator(rehydrateProductionDesktop)
  // The application stays mounted with a reconnect control when recovery fails.
  try { await host.rehydrate() } catch { /* State owners and connection chrome expose unavailable recovery. */ }
}
void bootstrap().catch(() => {
  const root = document.getElementById('root')
  if (root) { root.setAttribute('role', 'alert'); root.textContent = 'The native desktop connection is unavailable. Reload to reconnect.' }
})
