import type { BrowserWindow } from 'electron'
import type { DatabaseManager } from './database'
import { AgentManager as PortableAgentManager } from './agent-manager-core'
import { electronAgentManagerHost } from './agent-manager/electron-host'

// Preserve the production import surface, constructor and window attachment.
export * from './agent-manager-core'
export class AgentManager extends PortableAgentManager {
  constructor(db: DatabaseManager) {
    super(db, electronAgentManagerHost())
  }

  override setMainWindow(window: BrowserWindow): void {
    super.setMainWindow(window)
  }
}
