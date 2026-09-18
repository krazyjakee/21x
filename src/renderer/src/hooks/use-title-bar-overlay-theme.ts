import { useEffect } from 'react'
import { useThemeStore } from '@/stores/theme-store'
import { platform } from '@/lib/platform'

/**
 * Repaints the native min/max/close overlay (Windows/Linux) to match the
 * current theme. The overlay is drawn by the OS frame, not the page, so it
 * can't read CSS — without this it keeps the colour it was created with and
 * shows as an off-colour block in the top bar's corner.
 */
export function useTitleBarOverlayTheme(): void {
  const resolved = useThemeStore((s) => s.resolved)

  useEffect(() => {
    if (platform === 'darwin') return
    const styles = getComputedStyle(document.documentElement)
    const color = styles.getPropertyValue('--background').trim()
    const symbolColor = styles.getPropertyValue('--muted-foreground').trim()
    if (!color || !symbolColor) return
    void window.electronAPI?.app?.setTitleBarOverlay?.({ color, symbolColor })
  }, [resolved])
}
