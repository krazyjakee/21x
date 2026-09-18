import { app, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { join } from 'path'
import { isMainWindowUrl } from './main-window-url'

/**
 * Sender checks for the handlers that can run code or read the disk.
 *
 * `ipcMain` accepts a message from *any* frame in *any* WebContents — a canvas
 * <webview>, an embedded iframe, an artifact preview. Only the main window's
 * top-level frame is ever meant to call terminal spawn, `shell:openPath` or
 * `shell:readTextFile`, so everything else is refused here. The navigation
 * guards in `main-window-url.ts` keep that frame on the app's own URL.
 */

/** Minimal shape of what we read off an IPC event — keeps tests free of Electron objects. */
interface SenderLike {
  sender?: { getType?: () => string } | null
  senderFrame?: { url?: string; parent?: unknown } | null
}

function rendererIndexPath(): string {
  // Mirrors the `loadFile` path in index.ts: both resolve from the main bundle.
  return join(__dirname, '../renderer/index.html')
}

function devRendererUrl(): string | null {
  // Same rule as the window's own `loadURL`: only an unpackaged build ever
  // serves the renderer from the Vite dev server.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  return devUrl && !app.isPackaged ? devUrl : null
}

/** True when the event came from the main window's top-level app frame. */
export function isTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent | SenderLike): boolean {
  const { sender, senderFrame } = event as SenderLike
  if (!senderFrame) return false
  // A <webview> guest has its own WebContents; only a real window may call these.
  if (sender?.getType && sender.getType() !== 'window') return false
  // Sub-frames (iframes, artifact previews) are never the caller.
  if (senderFrame.parent) return false
  return isMainWindowUrl(senderFrame.url ?? '', devRendererUrl(), rendererIndexPath())
}

/**
 * Throws when the caller isn't the main window's app frame. `ipcMain.handle`
 * turns the throw into a rejected promise on the renderer side.
 */
export function assertTrustedSender(
  event: IpcMainInvokeEvent | IpcMainEvent | SenderLike,
  channel: string
): void {
  if (isTrustedSender(event)) return
  const url = (event as SenderLike).senderFrame?.url ?? '(no frame)'
  console.warn(`[IPC] Rejected "${channel}" from untrusted sender: ${url}`)
  throw new Error(`IPC "${channel}" is only available to the main window`)
}
