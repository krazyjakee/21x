import { ipcMain } from 'electron'
import { panelBrowserBroker } from '../panel-browser-broker'

// Canvas browser panels register themselves here so agents can drive them
// through browser_* MCP tools. Only registered panels are addressable; the
// main app window is never registered and there is no global debug port.
export function registerBrowserBrokerHandlers(): void {
  ipcMain.handle('browser:registerBrokerPanel', (_event, payload: { panelId: string; webContentsId: number; taskIds: string[] }) => {
    if (!payload || typeof payload.panelId !== 'string' || typeof payload.webContentsId !== 'number') {
      return { success: false }
    }
    const taskIds = Array.isArray(payload.taskIds) ? payload.taskIds.filter((t): t is string => typeof t === 'string') : []
    if (!panelBrowserBroker.setPanelTasks(payload.panelId, taskIds)) {
      panelBrowserBroker.registerPanel(payload.panelId, payload.webContentsId, taskIds)
    }
    return { success: true }
  })

  ipcMain.handle('browser:unregisterBrokerPanel', (_event, panelId: string) => {
    if (typeof panelId !== 'string') return { success: false }
    panelBrowserBroker.unregisterPanel(panelId)
    return { success: true }
  })

  ipcMain.handle('browser:startRecording', (_event, panelId: string, title?: string) => {
    if (typeof panelId !== 'string' || !panelId.trim()) return { error: 'panelId is required' }
    if (title !== undefined && (typeof title !== 'string' || title.length > 200)) {
      return { error: 'title must be a string of at most 200 characters' }
    }
    return panelBrowserBroker.startRecording(panelId, title)
  })

  ipcMain.handle('browser:stopRecording', (_event, panelId: string) => {
    if (typeof panelId !== 'string' || !panelId.trim()) return { error: 'panelId is required' }
    return panelBrowserBroker.stopRecording(panelId)
  })

  ipcMain.handle('browser:recordingStatus', (_event, panelId: string) => {
    if (typeof panelId !== 'string' || !panelId.trim()) return { recording: null }
    return panelBrowserBroker.recordingStatus(panelId)
  })
}
