import { app, type BrowserWindow } from 'electron'
import { join } from 'path'
import { guardedIpcSend } from './guarded-ipc-send'
import { WORKSPACES_DIR } from './workspace-paths'
import { WorktreeManager as WorktreeManagerCore } from './worktree-manager-core'
export type { WorktreeRepo, TaskChangesResult, TaskFileInventoryResult, TaskFileContent } from './worktree-manager-core'

/** Electron entry retains its existing paths and window delivery behavior. */
export class WorktreeManager extends WorktreeManagerCore {
  constructor() {
    let window: BrowserWindow | null = null
    super({
      reposRoot: join(app.getPath('userData'), 'repos'),
      workspaceRoot: WORKSPACES_DIR,
      bindWindow: value => { window = value as BrowserWindow },
      emitProgress: data => {
        if (window && !window.isDestroyed()) guardedIpcSend(window.webContents, 'worktree:progress', data)
      }
    })
  }
}
