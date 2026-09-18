/**
 * ClaudePluginManager — manages Claude Code format plugins for 20x: marketplace
 * sources, catalog discovery, and install/uninstall/enable/disable of plugins.
 * Downloading lives in ./claude-plugins/sources; turning plugin files into
 * 20x skills/MCP servers/agents lives in ./claude-plugins/resources.
 */

import { join } from 'path'
import { tmpdir } from 'os'
import { existsSync, rmSync } from 'fs'

import type {
  DatabaseManager,
  MarketplaceSourceRecord,
  InstalledPluginRecord,
  ClaudePluginSource,
  CreateMarketplaceSourceData
} from './database'
import {
  fetchCatalogFromSource,
  downloadPluginFiles,
  readPluginManifest,
  type MarketplaceCatalog
} from './claude-plugins/sources'
import {
  applyPluginResources,
  removePluginResources,
  pluginSkills,
  pluginMcpServers,
  pluginAgents,
  type PluginResources
} from './claude-plugins/resources'

export interface DiscoverablePlugin {
  name: string
  description: string
  version: string
  author: string
  category: string
  tags: string[]
  homepage: string
  repository: string
  license: string
  marketplace_id: string
  marketplace_name: string
  source: ClaudePluginSource | string
  installed: boolean
  installed_plugin_id?: string
  enabled?: boolean
}

/** Default marketplaces, seeded on startup when missing */
const DEFAULT_MARKETPLACES: CreateMarketplaceSourceData[] = [
  { name: 'anthropic-official', source_type: 'github', source_url: 'anthropics/claude-plugins-official' },
  { name: 'claude-code-plugins', source_type: 'github', source_url: 'anthropics/claude-code' },
  { name: 'financial-services', source_type: 'github', source_url: 'anthropics/financial-services' }
]

export class ClaudePluginManager {
  /** Marketplace catalogs keyed by marketplace source ID; install requires a loaded catalog */
  private catalogCache = new Map<string, MarketplaceCatalog>()

  private pluginsDir: string

  constructor(
    private db: DatabaseManager,
    pluginsDir?: string
  ) {
    if (pluginsDir) {
      this.pluginsDir = pluginsDir
    } else {
      this.pluginsDir = join(tmpdir(), '20x-plugins')
      try {
        // Lazy require: electron's app is only available inside the main process
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const electron = require('electron') as typeof import('electron')
        this.pluginsDir = join(electron.app.getPath('userData'), 'plugins')
      } catch {
        // Outside Electron (tests) keep the tmpdir fallback
      }
    }

    this.ensureDefaultMarketplaces()
  }

  private ensureDefaultMarketplaces(): void {
    const existingNames = new Set(this.db.getMarketplaceSources().map((s) => s.name))
    for (const marketplace of DEFAULT_MARKETPLACES) {
      if (existingNames.has(marketplace.name)) continue
      try {
        this.db.createMarketplaceSource(marketplace)
      } catch (err) {
        console.warn(`[ClaudePluginManager] Failed to seed default marketplace "${marketplace.name}":`, err)
      }
    }
  }

  // ── Marketplace sources ────────────────────────────────────

  getMarketplaceSources(): MarketplaceSourceRecord[] {
    return this.db.getMarketplaceSources()
  }

  addMarketplaceSource(data: CreateMarketplaceSourceData): MarketplaceSourceRecord {
    if (this.db.getMarketplaceSourceByName(data.name)) {
      throw new Error(`Marketplace "${data.name}" already exists`)
    }
    return this.db.createMarketplaceSource(data)
  }

  removeMarketplaceSource(id: string): boolean {
    this.catalogCache.delete(id)
    return this.db.deleteMarketplaceSource(id)
  }

  /** Fetches a catalog, falling back to the last cached copy on failure. */
  async fetchMarketplaceCatalog(sourceId: string): Promise<MarketplaceCatalog | null> {
    const source = this.db.getMarketplaceSource(sourceId)
    if (!source) return null

    try {
      const catalog = await fetchCatalogFromSource(source)
      if (catalog) this.catalogCache.set(sourceId, catalog)
      return catalog
    } catch (err) {
      console.error(`[ClaudePluginManager] Failed to fetch catalog for ${source.name}:`, err)
      return this.catalogCache.get(sourceId) ?? null
    }
  }

  async discoverPlugins(searchQuery?: string): Promise<DiscoverablePlugin[]> {
    const installedPlugins = this.db.getInstalledPlugins()
    const results: DiscoverablePlugin[] = []

    for (const source of this.db.getMarketplaceSources()) {
      const catalog = this.catalogCache.get(source.id) ?? (await this.fetchMarketplaceCatalog(source.id))
      if (!catalog) continue

      for (const entry of catalog.plugins) {
        const installed = installedPlugins.find(
          (ip) => ip.name === entry.name && ip.marketplace_id === source.id
        )
        results.push({
          name: entry.name,
          description: entry.description || '',
          version: entry.version || '1.0.0',
          author: entry.author?.name || catalog.owner.name || '',
          category: entry.category || 'general',
          tags: entry.tags || entry.keywords || [],
          homepage: entry.homepage || '',
          repository: entry.repository || '',
          license: entry.license || '',
          marketplace_id: source.id,
          marketplace_name: source.name,
          source: entry.source,
          installed: !!installed,
          installed_plugin_id: installed?.id,
          enabled: installed?.enabled
        })
      }
    }

    if (!searchQuery) return results
    const q = searchQuery.toLowerCase()
    return results.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q)) ||
        p.category.toLowerCase().includes(q) ||
        p.author.toLowerCase().includes(q)
    )
  }

  // ── Install / uninstall ────────────────────────────────────

  async installPlugin(
    pluginName: string,
    marketplaceId: string,
    scope: string = 'user'
  ): Promise<InstalledPluginRecord> {
    if (this.db.getInstalledPluginByName(pluginName, marketplaceId)) {
      throw new Error(`Plugin "${pluginName}" is already installed`)
    }

    const catalog = this.catalogCache.get(marketplaceId)
    if (!catalog) {
      throw new Error('Marketplace catalog not loaded. Refresh the marketplace first.')
    }

    const entry = catalog.plugins.find((p) => p.name === pluginName)
    if (!entry) {
      throw new Error(`Plugin "${pluginName}" not found in marketplace`)
    }

    const source: ClaudePluginSource =
      typeof entry.source === 'string' ? { path: entry.source } : entry.source

    const pluginDir = await downloadPluginFiles(
      this.pluginsDir,
      pluginName,
      source,
      this.db.getMarketplaceSource(marketplaceId) ?? undefined,
      catalog.metadata?.pluginRoot
    )

    const installed = this.db.createInstalledPlugin({
      name: entry.name,
      marketplace_id: marketplaceId,
      manifest: readPluginManifest(pluginDir, entry),
      source,
      scope,
      version: entry.version || '1.0.0'
    })

    applyPluginResources(this.db, installed, pluginDir)
    return installed
  }

  async uninstallPlugin(pluginId: string): Promise<boolean> {
    const plugin = this.db.getInstalledPlugin(pluginId)
    if (!plugin) return false

    removePluginResources(this.db, plugin.name)

    const pluginDir = join(this.pluginsDir, plugin.name)
    if (existsSync(pluginDir)) {
      try {
        rmSync(pluginDir, { recursive: true, force: true })
      } catch (err) {
        console.warn(`[ClaudePluginManager] Failed to clean up plugin files for "${plugin.name}":`, err)
      }
    }

    return this.db.deleteInstalledPlugin(pluginId)
  }

  enablePlugin(pluginId: string): InstalledPluginRecord | undefined {
    return this.db.updateInstalledPlugin(pluginId, { enabled: true })
  }

  disablePlugin(pluginId: string): InstalledPluginRecord | undefined {
    return this.db.updateInstalledPlugin(pluginId, { enabled: false })
  }

  getInstalledPlugins(): InstalledPluginRecord[] {
    return this.db.getInstalledPlugins()
  }

  /**
   * Returns the skills, MCP servers and agents materialised for a plugin, plus
   * manifest-declared commands (already materialised as skills; listed for display).
   */
  getPluginResources(pluginId: string): PluginResources {
    const plugin = this.db.getInstalledPlugin(pluginId)
    if (!plugin) return { skills: [], mcpServers: [], agents: [], commands: [] }

    const { commands } = plugin.manifest
    return {
      skills: pluginSkills(this.db, plugin.name).map((s) => ({ id: s.id, name: s.name, description: s.description })),
      mcpServers: pluginMcpServers(this.db, plugin.name).map((s) => ({ id: s.id, name: s.name, command: s.command, args: s.args })),
      agents: pluginAgents(this.db, plugin.name).map((a) => ({
        id: a.id,
        name: a.name,
        description: a.config?.system_prompt?.slice(0, 100) || ''
      })),
      commands: commands ? (Array.isArray(commands) ? commands : [commands]) : []
    }
  }
}
