import { app } from 'electron'
import { join } from 'path'
import { WORKSPACES_DIR } from './workspace-paths'
import { DatabaseManager as PortableDatabaseManager } from './database/manager'
import { electronTaskManagementRuntime } from './database/seed'

// Preserve every existing main-process type/import surface and constructor.
export * from './database/manager'

/** Shipping Electron host adapter. The service imports database/manager directly. */
export class DatabaseManager extends PortableDatabaseManager {
  constructor() {
    const profileRoot = app.getPath('userData')
    super({
      paths: { profileRoot, workspaceRoot: WORKSPACES_DIR, attachmentRoot: join(profileRoot, 'attachments') },
      managedTaskMcp: electronTaskManagementRuntime(),
      logger: console
    })
  }
}
