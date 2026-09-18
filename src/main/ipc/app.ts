import { ipcMain, shell, Notification, app, BrowserWindow } from 'electron'
import { existsSync, statSync, readFileSync } from 'fs'
import { setTaskApiUiState } from '../task-api-server'
import type { IpcDeps } from './deps'
import { assertTrustedSender } from '../ipc-sender'

const TEXT_PREVIEW_MAX_BYTES = 50 * 1024

/** App preferences, OS shell integration and notifications. */
export function registerAppHandlers({ db }: IpcDeps): void {
  // Opening, revealing and reading arbitrary paths is main-window-only:
  // a webview or embedded frame must never reach the user's disk.
  ipcMain.handle('shell:openPath', (event, filePath: string) => {
    assertTrustedSender(event, 'shell:openPath')
    if (existsSync(filePath)) shell.openPath(filePath)
  })

  ipcMain.handle('shell:showItemInFolder', (event, filePath: string) => {
    assertTrustedSender(event, 'shell:showItemInFolder')
    if (existsSync(filePath)) shell.showItemInFolder(filePath)
  })

  ipcMain.handle('shell:readTextFile', (event, filePath: string): { content: string; size: number } | null => {
    assertTrustedSender(event, 'shell:readTextFile')
    if (!existsSync(filePath)) return null
    const { size } = statSync(filePath)
    if (size > TEXT_PREVIEW_MAX_BYTES) return { content: '', size }
    return { content: readFileSync(filePath, 'utf-8'), size }
  })

  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    // Only http(s)/mailto: anything else (about:blank included) triggers the
    // macOS "no application set to open the URL" popup.
    if (!url || url === 'about:blank' || url === 'about:srcdoc') return
    try {
      const { protocol } = new URL(url)
      if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
        await shell.openExternal(url)
      }
    } catch {
      // Not a URL: nothing to open.
    }
  })

  ipcMain.handle('notifications:show', (_, title: string, body: string) => {
    new Notification({ title, body }).show()
  })

  ipcMain.handle('app:getVersion', () => app.getVersion())

  ipcMain.handle('app:getLoginItemSettings', () => app.getLoginItemSettings())

  ipcMain.handle('app:setLoginItemSettings', (_, openAtLogin: boolean) => {
    app.setLoginItemSettings({ openAtLogin })
    return app.getLoginItemSettings()
  })

  ipcMain.handle('app:getNotificationPermission', async () => (Notification.isSupported() ? 'granted' : 'denied'))

  ipcMain.handle('app:requestNotificationPermission', async () => (Notification.isSupported() ? 'granted' : 'denied'))

  ipcMain.handle('app:getMinimizeToTray', async () => db.getSetting('minimize_to_tray') === 'true')

  ipcMain.handle('app:setMinimizeToTray', async (_, enabled: boolean) => {
    db.setSetting('minimize_to_tray', enabled.toString())
    return enabled
  })

  // Keeps the native min/max/close overlay (Windows/Linux) in the app's theme.
  ipcMain.handle('app:setTitleBarOverlay', (event, colors: { color: string; symbolColor: string }) => {
    assertTrustedSender(event, 'app:setTitleBarOverlay')
    if (process.platform === 'darwin') return
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    win.setTitleBarOverlay({ color: colors.color, symbolColor: colors.symbolColor, height: 36 })
  })

  // The renderer publishes what it is showing, throttled, so an agent tool can
  // read it without waiting for a round trip to the window.
  ipcMain.handle('ui:publishState', (_, state: Record<string, unknown>) => {
    setTaskApiUiState(state ?? {})
  })
}
