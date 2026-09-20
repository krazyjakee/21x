import { ipcMain, clipboard as electronClipboard, type IpcMainInvokeEvent } from 'electron'
import { readClipboardImages } from '../chat/clipboard-images'
import { saveImagesAsTaskAttachments } from '../chat/task-image-attachments'
import { guardedIpcSend } from '../guarded-ipc-send'
import { assertTrustedSender } from '../ipc-sender'
import type { IpcDeps } from './deps'

/** The DOM `Clipboard` interface shadows Electron's in the main-process type graph. */
const clipboard = electronClipboard as unknown as Electron.Clipboard

/**
 * Chat image attachments (#144):
 * - `chatImages:readClipboard`: the main-process fallback for a paste whose
 *   event carried no image (copied files, unmapped image types).
 * - `chatImages:saveToTask`: pasted images on a task or Captain chat, stored
 *   as task attachments and announced like any other task update.
 */
export function registerChatImageHandlers(deps: IpcDeps): void {
  ipcMain.handle('chatImages:readClipboard', async (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event, 'chatImages:readClipboard')
    return readClipboardImages({ read: () => clipboard.read() })
  })

  ipcMain.handle('chatImages:saveToTask', async (event: IpcMainInvokeEvent, payload: { taskId?: unknown; images?: unknown }) => {
    assertTrustedSender(event, 'chatImages:saveToTask')
    const taskId = typeof payload?.taskId === 'string' ? payload.taskId : ''
    const result = await saveImagesAsTaskAttachments(deps.db, taskId, payload?.images)
    if (result.saved.length > 0) {
      guardedIpcSend(event.sender, 'task:updated', { taskId, updates: { attachments: result.attachments } })
    }
    return result.saved
  })
}
