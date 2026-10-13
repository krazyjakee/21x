import type { BrowserWindow } from 'electron'
import { guardedIpcSend } from './guarded-ipc-send'
import type { DatabaseManager } from './database'
import type { WorktreeManager } from './worktree-manager'
import { WORKSPACES_DIR, listWorkspaceDirs } from './workspace-paths'
import { WorkspaceCleanupSchedulerCore } from './workspace-cleanup-scheduler-core'
export type { CleanupResult } from './workspace-cleanup-scheduler-core'

/** Desktop paths and guarded events; scheduling and raw work belong to the core. */
export class WorkspaceCleanupScheduler extends WorkspaceCleanupSchedulerCore {
  private mainWindow: BrowserWindow | null = null

  constructor(db: DatabaseManager, worktrees: WorktreeManager) {
    super(db, worktrees, {
      workspacesRoot: WORKSPACES_DIR,
      listWorkspaceDirs,
      emit: (channel, data) => {
        const window = this.mainWindow
        if (!window || window.isDestroyed()) return
        switch (channel) {
          case 'workspace:cleanup-progress': guardedIpcSend(window.webContents, 'workspace:cleanup-progress', data); break
          case 'workspace:cleanup-complete': guardedIpcSend(window.webContents, 'workspace:cleanup-complete', data); break
        }
      }
    })
  }

  start(window?: BrowserWindow): void {
    if (window) this.mainWindow = window
    super.start()
  }
}
