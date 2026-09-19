import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { DatabaseManager } from '../database'
import type { IpcDeps } from './deps'
import { guardedIpcSend } from '../guarded-ipc-send'
import { isTrustedSender } from '../ipc-sender'
import { mergeGrantAudit, recordUserTypedProjectMessage, revokeMergeGrant, setMergeGrantChangeListener } from '../merge-grants'
import { isCoordinatorTask } from '../../shared/task-roles'
import type { MergeGrant, MergeGrantAuditEntry } from '../../shared/merge-grants'

export const MERGE_GRANTS_CHANGED_CHANNEL = 'mergeGrants:changed'

/**
 * The chat composer reports text the user typed and sent with Enter or the
 * Send button (never dictated or app-generated text such as the canvas
 * terminal notice, which share the generic send channel). When it went to a
 * project's Captain, from the main window, it is recorded as the message a
 * `grant_merge_authority` call may bind to (#137). Nothing else records:
 * wake-ups, Commander relays, `send_message` and reports never pass here.
 */
export function noteUserTypedMessage(db: Pick<DatabaseManager, 'getTask'>, event: IpcMainInvokeEvent, taskId: string | undefined, message: unknown): void {
  if (!taskId || typeof message !== 'string' || !message.trim()) return
  if (!isTrustedSender(event)) return
  const task = db.getTask(taskId)
  if (!task || !isCoordinatorTask(task) || !task.project_id) return
  recordUserTypedProjectMessage(task.project_id, task.id, message)
}

/** Merge grants for the approvals popover and the project editor: list, audit, revoke (#137). */
export function registerMergeGrantHandlers({ db }: IpcDeps): void {
  setMergeGrantChangeListener((projectId) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) guardedIpcSend(win.webContents, MERGE_GRANTS_CHANGED_CHANNEL, { projectId })
    }
  })
  ipcMain.handle('mergeGrants:noteTyped', (event, taskId: string, text: string): void => {
    noteUserTypedMessage(db, event, typeof taskId === 'string' ? taskId : undefined, text)
  })
  ipcMain.handle('mergeGrants:listActive', (_, projectId?: string): MergeGrant[] =>
    db.listMergeGrants({ projectId: typeof projectId === 'string' && projectId ? projectId : undefined, activeOnly: true }))
  ipcMain.handle('mergeGrants:audit', (_, projectId: string): MergeGrantAuditEntry[] =>
    typeof projectId === 'string' && projectId ? mergeGrantAudit(db, projectId) : [])
  ipcMain.handle('mergeGrants:revoke', (_, id: string): { ok: boolean; error?: string } =>
    typeof id === 'string' && id ? revokeMergeGrant(db, id, { by: 'user' }) : { ok: false, error: 'id is required' })
}
