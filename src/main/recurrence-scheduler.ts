import type { BrowserWindow } from 'electron'
import type { DatabaseManager } from './database'
import { guardedIpcSend } from './guarded-ipc-send'
import { RecurrenceSchedulerCore } from './recurrence-scheduler-core'

/** Electron host adapter; scheduling and persistence belong to the portable core. */
export class RecurrenceScheduler extends RecurrenceSchedulerCore {
  private readonly host: { window: BrowserWindow | null }

  constructor(db: DatabaseManager, timezone?: string) {
    const host = { window: null as BrowserWindow | null }
    super(db, timezone, {
      emit(channel, payload) {
        if (!host.window || host.window.isDestroyed()) return
        if (channel === 'task:created' && payload) guardedIpcSend(host.window.webContents, 'task:created', payload)
        else if (channel === 'tasks:refresh') guardedIpcSend(host.window.webContents, 'tasks:refresh')
      }
    })
    this.host = host
  }

  start(mainWindow?: BrowserWindow): void {
    this.host.window = mainWindow ?? null
    super.start()
  }
}
