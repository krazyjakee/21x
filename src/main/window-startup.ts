import type { BrowserWindow } from 'electron'

/** Show the captured window and start its services once, even without first paint. */
export function attachWindowStartup(
  window: BrowserWindow,
  onShown: (window: BrowserWindow) => void,
  fallbackMs = 1_000
): void {
  let shown = false
  let fallback: ReturnType<typeof setTimeout> | undefined
  const clearFallback = (): void => {
    if (fallback !== undefined) clearTimeout(fallback)
    fallback = undefined
  }
  const showOnce = (): void => {
    if (shown || window.isDestroyed()) return
    shown = true
    clearFallback()
    window.show()
    onShown(window)
  }
  window.once('ready-to-show', showOnce)
  window.webContents.once('did-finish-load', () => {
    if (!shown && !window.isDestroyed()) fallback = setTimeout(showOnce, fallbackMs)
  })
  window.once('closed', clearFallback)
}
