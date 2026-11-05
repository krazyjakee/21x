import { installDesktopHost } from './lib/desktop-api'
import { createNativeDesktopHost } from './lib/native-desktop-host'
import { renderStartupFailure } from './lib/startup-failure'
import { NativeBootstrapUnavailableError, type TauriDesktopApi } from './lib/tauri-desktop-transport'

/** A service that is still starting gets a moment before the window gives up. */
const RECONNECT_DELAYS_MS = [0, 500, 1500, 3000]

async function bootstrap(): Promise<void> {
  const native = (window as unknown as { __TAURI__?: TauriDesktopApi }).__TAURI__
  if (!native) throw new Error('Native desktop host unavailable')
  const host = createNativeDesktopHost(native)
  const release = installDesktopHost(host)
  window.addEventListener('pagehide', release, { once: true })
  // Trusted native epoch and validated listener precede every production import.
  for (let attempt = 0; ; attempt++) {
    await new Promise<void>(resolve => setTimeout(resolve, RECONNECT_DELAYS_MS[attempt]))
    try { await host.reconnect(); break } catch (error) {
      // A reported startup failure will not change by waiting.
      if (error instanceof NativeBootstrapUnavailableError || attempt === RECONNECT_DELAYS_MS.length - 1) throw error
    }
  }
  await import('./main')
  const { rehydrateProductionDesktop } = await import('./lib/desktop-rehydration')
  host.setRehydrator(rehydrateProductionDesktop)
  // The application stays mounted with a reconnect control when recovery fails.
  try { await host.rehydrate() } catch { /* State owners and connection chrome expose unavailable recovery. */ }
}
void bootstrap().catch((error: unknown) => {
  const root = document.getElementById('root')
  if (!root) return
  const startup = error instanceof NativeBootstrapUnavailableError ? error : undefined
  renderStartupFailure(root, startup?.explanation, startup?.reopenRequired ? null : () => window.location.reload(), startup?.stopUsingOldFolder)
})
