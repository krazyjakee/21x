import { ipcMain } from 'electron'
import type { ClaudePluginManager } from '../claude-plugin-manager'
import { required, type IpcDeps } from './deps'

/** The Claude plugin marketplace: sources, catalogs and installed plugins. */
export function registerClaudePluginHandlers({ claudePluginManager }: IpcDeps): void {
  const manager = (): ClaudePluginManager => required(claudePluginManager, 'ClaudePluginManager')

  ipcMain.handle('claudePlugin:getMarketplaceSources', () => claudePluginManager?.getMarketplaceSources() ?? [])

  ipcMain.handle('claudePlugin:addMarketplaceSource', (_, data: { name: string; source_type?: string; source_url: string; auto_update?: boolean }) => {
    return manager().addMarketplaceSource(data)
  })

  ipcMain.handle('claudePlugin:removeMarketplaceSource', (_, id: string) => manager().removeMarketplaceSource(id))

  ipcMain.handle('claudePlugin:fetchCatalog', async (_, sourceId: string) => manager().fetchMarketplaceCatalog(sourceId))

  ipcMain.handle('claudePlugin:discoverPlugins', async (_, searchQuery?: string) => manager().discoverPlugins(searchQuery))

  ipcMain.handle('claudePlugin:getInstalledPlugins', () => claudePluginManager?.getInstalledPlugins() ?? [])

  ipcMain.handle('claudePlugin:installPlugin', async (_, pluginName: string, marketplaceId: string, scope?: string) => {
    return manager().installPlugin(pluginName, marketplaceId, scope)
  })

  ipcMain.handle('claudePlugin:uninstallPlugin', async (_, pluginId: string) => manager().uninstallPlugin(pluginId))

  ipcMain.handle('claudePlugin:enablePlugin', (_, pluginId: string) => manager().enablePlugin(pluginId))

  ipcMain.handle('claudePlugin:disablePlugin', (_, pluginId: string) => manager().disablePlugin(pluginId))

  ipcMain.handle('claudePlugin:getPluginResources', (_, pluginId: string) => manager().getPluginResources(pluginId))
}
