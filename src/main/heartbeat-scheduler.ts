import { Notification, type BrowserWindow } from 'electron'
import type { DatabaseManager } from './database'
import type { AgentManager } from './agent-manager'
import { guardedIpcSend } from './guarded-ipc-send'
import { HeartbeatSchedulerCore } from './heartbeat-scheduler-core'

/** Native notification and guarded renderer ports for the portable monitor. */
export class HeartbeatScheduler extends HeartbeatSchedulerCore {
  constructor(db: DatabaseManager, agents: AgentManager) { super(db, agents) }

  start(window?: BrowserWindow): void {
    this.setEventHost({
      emit(channel, data) {
        if (!window || window.isDestroyed()) return
        switch (channel) {
          case 'task:updated': guardedIpcSend(window.webContents, 'task:updated', data); break
          case 'tasks:refresh': guardedIpcSend(window.webContents, 'tasks:refresh', data); break
          case 'heartbeat:alert': guardedIpcSend(window.webContents, 'heartbeat:alert', data); break
          case 'heartbeat:disabled': guardedIpcSend(window.webContents, 'heartbeat:disabled', data); break
        }
      },
      notify(title, body) { new Notification({ title, body }).show() }
    })
    super.start()
  }
}
