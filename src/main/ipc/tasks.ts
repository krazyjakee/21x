import { guardedIpcSend } from '../guarded-ipc-send'
import { ipcMain, dialog, shell, app } from 'electron'
import { existsSync, readdirSync, unlinkSync, copyFileSync } from 'fs'
import { copyFile, stat } from 'fs/promises'
import { join, basename } from 'path'
import { randomUUID } from 'crypto'
import { updateTaskFromUser } from '../session-feedback'
import type { CreateTaskData, UpdateTaskData, FileAttachmentRecord } from '../database'
import { listTaskArtifactEntries, readTaskArtifact, resolveTaskArtifactFilePath } from '../artifacts'
import { writeArtifactFileToClipboard } from '../artifact-clipboard'
import { ArtifactClipboardMode, type ArtifactCopyFileResult } from '../../shared/artifacts'
import { afterTaskCreated, afterTaskUpdated } from '../task-updates'
import { mimeTypeForPath } from '../mime'
import { required, type IpcDeps } from './deps'

/** Attachments are stored as `<attachmentId>-<filename>` in the task's attachment dir. */
function findAttachmentFile(dir: string, attachmentId: string): string | undefined {
  if (!existsSync(dir)) return undefined
  const match = readdirSync(dir).find((f) => f.startsWith(`${attachmentId}-`))
  return match ? join(dir, match) : undefined
}

export function registerTaskHandlers(deps: IpcDeps): void {
  const { db, heartbeatScheduler } = deps

  ipcMain.handle('db:getTasks', () => db.getTasks())

  ipcMain.handle('db:getTask', (_, id: string) => db.getTask(id))

  ipcMain.handle('db:createTask', async (event, data: CreateTaskData) => {
    const task = db.createTask(data)
    if (!task) return task
    afterTaskCreated(task)
    // The renderer's auto-start hook triggers triage for UI-created tasks.
    guardedIpcSend(event.sender, 'task:created', { task })
    return task
  })

  ipcMain.handle('db:updateTask', (_, id: string, data: UpdateTaskData) => {
    const previous = db.getTask(id)
    const updated = updateTaskFromUser(db, id, data)
    if (previous && updated) afterTaskUpdated(db, deps.agentManager, previous, data, updated)
    return updated
  })

  ipcMain.handle('db:deleteTask', (event, id: string) => {
    const success = db.deleteTask(id)
    if (success) {
      guardedIpcSend(event.sender, 'task:deleted', { taskId: id })
    }
    return success
  })

  ipcMain.handle('db:getSubtasks', (_, parentId: string) => db.getSubtasks(parentId))

  ipcMain.handle('db:reorderSubtasks', (_, parentId: string, orderedIds: string[]) => {
    db.reorderSubtasks(parentId, orderedIds)
    return true
  })

  ipcMain.handle('tasks:getWorkspaceDir', (_, taskId: string): string => db.getWorkspaceDir(taskId))

  // The Mastermind's row id. Never in db:getTasks (coordinator rows are hidden),
  // so the renderer asks for it by role instead of carrying a fixed string.
  ipcMain.handle('tasks:getCoordinatorTaskId', (): string | null => db.getCoordinatorTask()?.id ?? null)

  ipcMain.handle('attachments:pick', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('attachments:save', async (_, taskId: string, filePath: string): Promise<FileAttachmentRecord> => {
    const id = randomUUID()
    const filename = basename(filePath)
    const { size } = await stat(filePath)
    await copyFile(filePath, join(db.getAttachmentsDir(taskId), `${id}-${filename}`))
    return { id, filename, size, mime_type: mimeTypeForPath(filename), added_at: new Date().toISOString() }
  })

  ipcMain.handle('attachments:remove', (_, taskId: string, attachmentId: string) => {
    const filePath = findAttachmentFile(db.getAttachmentsDir(taskId), attachmentId)
    if (filePath) unlinkSync(filePath)
  })

  ipcMain.handle('attachments:open', (_, taskId: string, attachmentId: string) => {
    const filePath = findAttachmentFile(db.getAttachmentsDir(taskId), attachmentId)
    if (filePath) shell.openPath(filePath)
    else console.log('[IPC] No attachment file found for', { taskId, attachmentId })
  })

  ipcMain.handle('attachments:download', (_, taskId: string, attachmentId: string) => {
    const dir = db.getAttachmentsDir(taskId)
    if (!existsSync(dir)) {
      console.error('[IPC] Attachments directory does not exist')
      return
    }
    const sourcePath = findAttachmentFile(dir, attachmentId)
    if (!sourcePath) {
      console.error('[IPC] No matching file found for attachment ID:', attachmentId)
      throw new Error('Attachment file not found')
    }
    // Strip the "<36-char UUID>-" prefix to recover the original filename.
    const destPath = join(app.getPath('downloads'), basename(sourcePath).substring(37))
    try {
      copyFileSync(sourcePath, destPath)
      shell.showItemInFolder(destPath)
    } catch (error) {
      console.error('[IPC] Failed to copy file:', error)
      throw error
    }
  })

  ipcMain.handle('artifacts:scan', async (_, taskId: string) => {
    return listTaskArtifactEntries(db.getWorkspaceDir(taskId), taskId)
  })

  ipcMain.handle('artifacts:read', async (_, taskId: string, relativePath: string) => {
    return readTaskArtifact(db.getWorkspaceDir(taskId), relativePath)
  })

  ipcMain.handle('artifacts:copyFile', async (_, taskId: string, relativePath: string): Promise<ArtifactCopyFileResult> => {
    const filePath = await resolveTaskArtifactFilePath(db.getWorkspaceDir(taskId), relativePath)
    if (!filePath) return { mode: ArtifactClipboardMode.UNAVAILABLE }
    return writeArtifactFileToClipboard(filePath)
  })

  const requireHeartbeat = (): NonNullable<IpcDeps['heartbeatScheduler']> => required(heartbeatScheduler, 'HeartbeatScheduler')

  ipcMain.handle('heartbeat:enable', (_, taskId: string, intervalMinutes?: number) => {
    requireHeartbeat().enableHeartbeat(taskId, intervalMinutes)
    return db.getTask(taskId)
  })

  ipcMain.handle('heartbeat:disable', (_, taskId: string) => {
    requireHeartbeat().disableHeartbeat(taskId)
    return db.getTask(taskId)
  })

  ipcMain.handle('heartbeat:runNow', async (_, taskId: string) => requireHeartbeat().runNow(taskId))

  ipcMain.handle('heartbeat:getLogs', (_, taskId: string, limit?: number) => db.getHeartbeatLogs(taskId, limit))

  ipcMain.handle('heartbeat:getStatus', (_, taskId: string) => {
    const scheduler = requireHeartbeat()
    const task = db.getTask(taskId)
    if (!task) return null
    return {
      enabled: task.heartbeat_enabled,
      intervalMinutes: task.heartbeat_interval_minutes,
      lastCheckAt: task.heartbeat_last_check_at,
      nextCheckAt: task.heartbeat_next_check_at,
      hasHeartbeatFile: scheduler.hasHeartbeatFile(taskId)
    }
  })

  ipcMain.handle('heartbeat:updateInterval', (_, taskId: string, intervalMinutes: number) => {
    requireHeartbeat().enableHeartbeat(taskId, intervalMinutes)
    return db.getTask(taskId)
  })

  ipcMain.handle('heartbeat:readFile', (_, taskId: string) => requireHeartbeat().readHeartbeatFile(taskId))

  ipcMain.handle('heartbeat:writeFile', (_, taskId: string, content: string) => {
    requireHeartbeat().writeHeartbeatFile(taskId, content)
    return true
  })
}
