import { ipcMain } from 'electron'
import type { CreateMcpServerData, UpdateMcpServerData } from '../database'
import { OAuthManager } from '../oauth/oauth-manager'
import { testMcpServer, type McpServerProbeInput } from '../agent-manager/mcp-server-test'
import { required, type IpcDeps } from './deps'

export function registerMcpHandlers({ db, oauthManager }: IpcDeps): void {
  ipcMain.handle('mcp:getAll', () => db.getMcpServers())
  ipcMain.handle('mcp:create', (_, data: CreateMcpServerData) => db.createMcpServer(data))
  ipcMain.handle('mcp:update', (_, id: string, data: UpdateMcpServerData) => db.updateMcpServer(id, data))
  ipcMain.handle('mcp:delete', (_, id: string) => db.deleteMcpServer(id))

  ipcMain.handle('mcp:testConnection', async (_, serverData: McpServerProbeInput & { id?: string }) => {
    const result = await testMcpServer(serverData)
    if (serverData.id && result.status === 'connected' && result.tools) {
      db.updateMcpServerTools(serverData.id, result.tools)
    }
    return result
  })

  // OAuth uses the spec-compliant discovery flow.
  const requireOAuth = (): OAuthManager => required(oauthManager, 'OAuth manager')

  ipcMain.handle('mcp:startOAuthFlow', async (_, mcpServerId: string) => requireOAuth().startMcpServerOAuthFlow(mcpServerId))

  ipcMain.handle('mcp:getOAuthStatus', async (_, mcpServerId: string) => {
    if (!oauthManager) return { connected: false }
    return oauthManager.getMcpServerOAuthStatus(mcpServerId)
  })

  ipcMain.handle('mcp:revokeOAuthToken', async (_, mcpServerId: string) => {
    await requireOAuth().revokeMcpServerToken(mcpServerId)
  })

  ipcMain.handle('mcp:probeForAuth', async (_, serverUrl: string) => OAuthManager.probeForAuth(serverUrl))

  ipcMain.handle('mcp:submitManualClientId', async (_, mcpServerId: string, clientId: string) => {
    return requireOAuth().completeManualRegistration(mcpServerId, clientId)
  })
}
