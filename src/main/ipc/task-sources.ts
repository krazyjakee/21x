import { guardedIpcSend } from '../guarded-ipc-send'
import { ipcMain } from 'electron'
import type { CreateTaskSourceData, UpdateTaskSourceData } from '../database'
import type { OAuthManager } from '../oauth/oauth-manager'
import { required, type IpcDeps } from './deps'

/** Task sources, the plugins behind them, and the OAuth flows they use. */
export function registerTaskSourceHandlers({ db, syncManager, pluginRegistry, oauthManager }: IpcDeps): void {
  ipcMain.handle('taskSource:getAll', (_, projectId?: string) => db.getTaskSources(projectId || undefined))
  ipcMain.handle('taskSource:create', (_, data: CreateTaskSourceData) => db.createTaskSource(data))
  ipcMain.handle('taskSource:update', (_, id: string, data: UpdateTaskSourceData) => db.updateTaskSource(id, data))
  ipcMain.handle('taskSource:delete', (_, id: string) => db.deleteTaskSource(id))
  ipcMain.handle('taskSource:sync', async (_, sourceId: string) => syncManager.importTasks(sourceId))

  ipcMain.handle('taskSource:exportUpdate', async (event, taskId: string, fields: Record<string, unknown>) => {
    await syncManager.exportTaskUpdate(taskId, fields)
    const updated = db.getTask(taskId)
    if (updated) guardedIpcSend(event.sender, 'task:updated', { taskId, updates: updated })
  })

  ipcMain.handle('taskSource:getUsers', (_, sourceId: string) => syncManager.getSourceUsers(sourceId))

  ipcMain.handle('taskSource:reassign', (_, taskId: string, userIds: string[], assigneeDisplay: string) => {
    return syncManager.reassignTask(taskId, userIds, assigneeDisplay)
  })

  ipcMain.handle('plugin:list', () => pluginRegistry.list())

  ipcMain.handle('plugin:getDocumentation', (_, pluginId: string) => pluginRegistry.getDocumentation(pluginId))

  // `_mcpServerId` is still sent by the renderer; no plugin needs an MCP server any more.
  ipcMain.handle('plugin:resolveOptions', async (_, pluginId: string, resolverKey: string, config: Record<string, unknown>, _mcpServerId?: string, sourceId?: string) => {
    const plugin = pluginRegistry.get(pluginId)
    if (!plugin) return []
    return plugin.resolveOptions(resolverKey, config, { db, oauthManager, sourceId })
  })

  ipcMain.handle('plugin:executeAction', async (_, actionId: string, taskId: string, sourceId: string, input?: string) => {
    const task = db.getTask(taskId)
    if (!task) return { success: false, error: 'Task not found' }
    return syncManager.executeAction(actionId, task, input, sourceId)
  })

  const requireOAuth = (): OAuthManager => required(oauthManager, 'OAuth manager')

  ipcMain.handle('oauth:startFlow', async (_, provider: string, config: Record<string, unknown>) => {
    return requireOAuth().generateAuthUrl(provider, config)
  })

  ipcMain.handle('oauth:exchangeCode', async (_, provider: string, code: string, state: string, sourceId: string) => {
    await requireOAuth().exchangeCode(provider, code, state, sourceId)
  })

  ipcMain.handle('oauth:startLocalhostFlow', async (_, provider: string, config: Record<string, unknown>, sourceId: string) => {
    await requireOAuth().startLocalhostOAuthFlow(provider, config, sourceId)
  })

  ipcMain.handle('oauth:getValidToken', async (_, sourceId: string) => {
    if (!oauthManager) return null
    return oauthManager.getValidToken(sourceId)
  })

  ipcMain.handle('oauth:revokeToken', async (_, sourceId: string) => {
    await requireOAuth().revokeToken(sourceId)
  })
}
