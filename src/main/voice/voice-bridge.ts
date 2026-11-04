import type { BrowserWindow } from 'electron'
import { guardedIpcSend } from '../guarded-ipc-send'
import { broadcastToMobileClients } from '../mobile-api-server'

/**
 * The two ways voice events leave the main process.
 *
 * `notify` reaches the desktop renderer and the mobile clients: voice actions
 * reuse the normal task and agent events, so both clients stay in step without
 * a second state writer (design §5.11).
 *
 * `notifyRenderer` reaches the desktop window only. Spoken answers use it: the
 * audio is produced on this computer and played by this window; a phone cannot
 * play a raw sample stream from the local WebSocket, and sending it would push
 * megabytes of samples through a text channel for nothing.
 */
export function voiceEventSenders(getWindow: () => BrowserWindow | null): {
  notify: (channel: string, data: unknown) => void
  notifyRenderer: (channel: string, data: unknown) => void
} {
  const notifyRenderer = (channel: string, data: unknown): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) guardedIpcSend(win.webContents, channel, data)
  }
  return {
    notify: (channel, data) => {
      notifyRenderer(channel, data)
      broadcastToMobileClients(channel, data)
    },
    notifyRenderer
  }
}

// The answer watcher has no Electron dependency, so the Tauri service uses it too.
export { watchAgentAnswersForSpeech } from './voice-answer-watch'
