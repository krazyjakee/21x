import { getDesktopHost } from '@/lib/desktop-api'
import type { NativeDesktopHost } from '@/lib/native-desktop-host'
import { useEffect } from 'react'
import { useThemeStore } from '@/stores/theme-store'
import { platform } from '@/lib/platform'

/** Repaint the captured native window after theme or ready-connection changes. */
export function useTitleBarOverlayTheme(): void {
  const resolved = useThemeStore((s) => s.resolved)

  useEffect(() => {
    const host = getDesktopHost()
    if (platform === 'darwin' || !host.supports('app.setTitleBarOverlay')) return
    const native = host.kind === 'tauri' ? host as NativeDesktopHost : undefined
    let active = true, lastAttempt: string | undefined
    const paint = () => {
      if (!active || getDesktopHost() !== host) return
      if (native && (native.connection.status !== 'ready' || native.hydrationPending)) {
        lastAttempt = undefined
        return
      }
      const styles = getComputedStyle(document.documentElement)
      const color = styles.getPropertyValue('--background').trim()
      const symbolColor = styles.getPropertyValue('--muted-foreground').trim()
      if (!color || !symbolColor) return
      // The native contract grants two finite RGB values, never arbitrary CSS.
      if (native && ![color, symbolColor].every(value => /^#[0-9a-fA-F]{6}$/.test(value))) return
      const attempt = JSON.stringify([host.connectionGeneration, color, symbolColor])
      if (attempt === lastAttempt) return
      lastAttempt = attempt
      try {
        // A refusal keeps the existing chrome. A new theme/ready connection is
        // a fresh decoration intent; failures never trigger a retry loop.
        void Promise.resolve(host.api.app.setTitleBarOverlay({ color, symbolColor })).catch(() => {})
      } catch { /* The Electron compatibility bridge can also refuse synchronously. */ }
    }
    const off = native?.subscribeConnection(paint)
    const release = () => {
      if (!active) return
      active = false
      off?.()
      window.removeEventListener('pagehide', release)
    }
    window.addEventListener('pagehide', release, { once: true })
    paint()
    return release
  }, [resolved])
}
