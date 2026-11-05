import { ipcMain } from 'electron'
import type { ClaudePluginManager } from '../claude-plugin-manager'
import { refusalOf, type AgentDeletionImpact } from '../../shared/agent-deletion'
import { required, type IpcDeps } from './deps'

/** The Claude plugin marketplace: sources, catalogs and installed plugins. */
export function registerClaudePluginHandlers({ claudePluginManager, agentManager }: IpcDeps): void {
  const manager = (): ClaudePluginManager => required(claudePluginManager, 'ClaudePluginManager')
  /** Plugins bring their own agents, so these change the shared agent list. */
  const agentsChanged = <T,>(result: T): T => { agentManager?.notifyAgentsChanged?.(); return result }

  ipcMain.handle('claudePlugin:getMarketplaceSources', () => claudePluginManager?.getMarketplaceSources() ?? [])

  ipcMain.handle('claudePlugin:addMarketplaceSource', (_, data: { name: string; source_type?: string; source_url: string; auto_update?: boolean }) => {
    return manager().addMarketplaceSource(data)
  })

  ipcMain.handle('claudePlugin:removeMarketplaceSource', (_, id: string) => manager().removeMarketplaceSource(id))

  ipcMain.handle('claudePlugin:fetchCatalog', async (_, sourceId: string) => manager().fetchMarketplaceCatalog(sourceId))

  ipcMain.handle('claudePlugin:discoverPlugins', async (_, searchQuery?: string) => manager().discoverPlugins(searchQuery))

  ipcMain.handle('claudePlugin:getInstalledPlugins', () => claudePluginManager?.getInstalledPlugins() ?? [])

  ipcMain.handle('claudePlugin:installPlugin', async (_, pluginName: string, marketplaceId: string, scope?: string) => {
    return agentsChanged(await manager().installPlugin(pluginName, marketplaceId, scope))
  })

  // Plugin agents leave through the same owner as any other agent: their work
  // stops first, and a refused uninstall leaves them all in place.
  ipcMain.handle('claudePlugin:uninstallPlugin', async (_, pluginId: string) => {
    const plugins = manager()
    const uninstall = async (): Promise<AgentDeletionImpact[] | false> => {
      plugins.assertUninstallable(pluginId)
      const agentIds = plugins.getPluginResources(pluginId).agents.map((agent) => agent.id)
      return agentManager.runAgentsDeletion(agentIds, (live) => plugins.uninstallPlugin(pluginId, live))
    }
    return agentsChanged(await uninstall().catch(refusalOf))
  })

  ipcMain.handle('claudePlugin:enablePlugin', async (_, pluginId: string) => agentsChanged(await manager().enablePlugin(pluginId)))

  ipcMain.handle('claudePlugin:disablePlugin', async (_, pluginId: string) => agentsChanged(await manager().disablePlugin(pluginId)))

  ipcMain.handle('claudePlugin:getPluginResources', (_, pluginId: string) => manager().getPluginResources(pluginId))
}
