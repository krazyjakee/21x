/**
 * ClaudePluginManager — manages Claude Code format plugins for 20x: marketplace
 * sources, catalog discovery, and install/uninstall/enable/disable of plugins.
 * Downloading lives in ./claude-plugins/sources; turning plugin files into
 * 20x skills/MCP servers/agents lives in ./claude-plugins/resources.
 */

import { isAbsolute, join } from 'path'
import { existsSync, lstatSync, rmSync } from 'fs'
import { inspectPluginTree } from './claude-plugins/containment'

import type {
  DatabaseManager,
  MarketplaceSourceRecord,
  InstalledPluginRecord,
  ClaudePluginSource,
  CreateMarketplaceSourceData,
  ClaudePluginManifest
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
  type PluginResources,
  planPluginResources, type PluginResourcePlan
} from './claude-plugins/resources'

export interface PluginOperations {
  fetchCatalog(source: MarketplaceSourceRecord, signal: AbortSignal, beforeRequest?: (address: string) => void): Promise<MarketplaceCatalog | null>
  download(pluginsDir: string, pluginName: string, source: ClaudePluginSource,
    marketplaceSource: MarketplaceSourceRecord | undefined, pluginRoot: string | undefined, signal: AbortSignal, beforePublish?: (containedStagingDir: string) => void, beforeRequest?: (address: string) => void): Promise<string>
}

export interface PluginCatalogControls {
  signal?: AbortSignal
  beforeCatalog?(source: MarketplaceSourceRecord): void
  beforeRequest?(address: string, source: MarketplaceSourceRecord): void
}
export interface PluginInstallControls {
  signal?: AbortSignal
  beforeDownload?(entry: MarketplaceCatalog['plugins'][number], marketplace: MarketplaceSourceRecord, pluginRoot?: string): void
  beforePublish?(plan: PluginResourcePlan, manifest: ClaudePluginManifest): void
  beforeRequest?(address: string): void
  beforeMaterialize?(plan: PluginResourcePlan, manifest: ClaudePluginManifest): void
}

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

  private closing = false
  private readonly controller = new AbortController()
  private readonly work = new Set<Promise<unknown>>()
  private readonly installing = new Set<string>()

  constructor(
    private readonly db: DatabaseManager,
    private readonly pluginsDir: string,
    private readonly operations: PluginOperations = { fetchCatalog: fetchCatalogFromSource, download: downloadPluginFiles }
  ) {
    if (!isAbsolute(pluginsDir)) throw new Error('Plugin profile directory must be absolute')
    this.ensureDefaultMarketplaces()
  }

  shutdown(): void {
    this.closing = true
    this.controller.abort()
    this.catalogCache.clear()
  }

  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid plugin shutdown deadline')
    this.shutdown()
    const drain = Promise.allSettled([...this.work])
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('PLUGIN_SHUTDOWN_INCOMPLETE')), timeoutMs) })
    try { await Promise.race([drain, expired]) }
    finally { if (timer) clearTimeout(timer) }
  }

  private assertOpen(): void { if (this.closing) throw new Error('PLUGIN_MANAGER_CLOSED') }

  assertSource(db: DatabaseManager): void { if (this.db !== db) throw new Error('Plugin database owner does not match') }

  getCatalogEntry(pluginName: string, marketplaceId: string): { entry: MarketplaceCatalog['plugins'][number]; marketplace: MarketplaceSourceRecord; pluginRoot?: string } | null {
    this.assertOpen()
    const catalog = this.catalogCache.get(marketplaceId), marketplace = this.db.getMarketplaceSource(marketplaceId)
    const entry = catalog?.plugins.find(plugin => plugin.name === pluginName)
    if (!catalog || !marketplace || !entry) return null
    return structuredClone({ entry, marketplace, ...(catalog.metadata?.pluginRoot === undefined ? {} : { pluginRoot: catalog.metadata.pluginRoot }) })
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const raw = Promise.resolve().then(() => { this.assertOpen(); return operation() })
    this.work.add(raw)
    void raw.then(() => this.work.delete(raw), () => this.work.delete(raw))
    return raw
  }

  private pluginPath(name: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) throw new Error('Invalid plugin directory name')
    return join(this.pluginsDir, name)
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
    this.assertOpen()
    return this.db.getMarketplaceSources()
  }

  addMarketplaceSource(data: CreateMarketplaceSourceData): MarketplaceSourceRecord {
    this.assertOpen()
    if (this.db.getMarketplaceSourceByName(data.name)) {
      throw new Error(`Marketplace "${data.name}" already exists`)
    }
    return this.db.createMarketplaceSource(data)
  }

  removeMarketplaceSource(id: string): boolean {
    this.assertOpen()
    this.catalogCache.delete(id)
    return this.db.deleteMarketplaceSource(id)
  }

  /** Fetches a catalog, falling back to the last cached copy on failure. */
  async fetchMarketplaceCatalog(sourceId: string, controls?: PluginCatalogControls): Promise<MarketplaceCatalog | null> {
    return this.track(() => this.fetchCatalog(sourceId, controls))
  }

  private async fetchCatalog(sourceId: string, controls?: PluginCatalogControls): Promise<MarketplaceCatalog | null> {
    const source = this.db.getMarketplaceSource(sourceId)
    if (!source) return null
    const signal = controls?.signal ? AbortSignal.any([this.controller.signal, controls.signal]) : this.controller.signal
    const snapshot = JSON.stringify(source)
    const check = (): void => {
      this.assertOpen(); signal.throwIfAborted()
      if (JSON.stringify(this.db.getMarketplaceSource(sourceId)) !== snapshot) throw new Error('Plugin marketplace context changed')
      controls?.beforeCatalog?.(source)
    }
    check()

    try {
      const catalog = await this.operations.fetchCatalog(source, signal, address => { check(); controls?.beforeRequest?.(address, structuredClone(source)); check() })
      check()
      if (catalog) this.catalogCache.set(sourceId, catalog)
      return catalog
    } catch {
      check()
      console.error('[ClaudePluginManager] Failed to fetch marketplace catalog')
      return this.catalogCache.get(sourceId) ?? null
    }
  }

  async discoverPlugins(searchQuery?: string, controls?: PluginCatalogControls & { sourceIds?: string[] }): Promise<DiscoverablePlugin[]> {
    return this.track(() => this.discover(searchQuery, controls))
  }

  private async discover(searchQuery?: string, controls?: PluginCatalogControls & { sourceIds?: string[] }): Promise<DiscoverablePlugin[]> {
    const installedPlugins = this.db.getInstalledPlugins()
    const results: DiscoverablePlugin[] = []

    for (const source of this.db.getMarketplaceSources()) {
      if (controls?.sourceIds && !controls.sourceIds.includes(source.id)) continue
      controls?.signal?.throwIfAborted(); controls?.beforeCatalog?.(source)
      const catalog = this.catalogCache.get(source.id) ?? (await this.fetchMarketplaceCatalog(source.id, controls))
      this.assertOpen()
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
    scope: string = 'user',
    controls?: PluginInstallControls
  ): Promise<InstalledPluginRecord> {
    return this.track(async () => {
      this.pluginPath(pluginName)
      if (this.installing.has(pluginName)) throw new Error('Plugin installation already in progress')
      this.installing.add(pluginName)
      try { return await this.install(pluginName, marketplaceId, scope, controls) }
      finally { this.installing.delete(pluginName) }
    })
  }

  private async install(pluginName: string, marketplaceId: string, scope: string, controls?: PluginInstallControls): Promise<InstalledPluginRecord> {
    if (this.db.getInstalledPlugins().some(plugin => plugin.name === pluginName)) {
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
    const marketplace = this.db.getMarketplaceSource(marketplaceId)
    if (!marketplace) throw new Error('Plugin marketplace was not found')
    const signal = controls?.signal ? AbortSignal.any([this.controller.signal, controls.signal]) : this.controller.signal
    const snapshot = JSON.stringify({ entry, marketplace, pluginRoot: catalog.metadata?.pluginRoot })
    const check = (): void => {
      this.assertOpen(); signal.throwIfAborted()
      const current = this.getCatalogEntry(pluginName, marketplaceId)
      if (!current || JSON.stringify(current) !== snapshot) throw new Error('Plugin installation context changed')
      controls?.beforeDownload?.(structuredClone(entry), structuredClone(marketplace), catalog.metadata?.pluginRoot)
    }
    check()

    const source: ClaudePluginSource =
      typeof entry.source === 'string' ? { path: entry.source } : entry.source

    const finalDir = this.pluginPath(pluginName)
    let publishedIdentity: { dev: number; ino: number } | undefined
    let committed = false
    try {
      const pluginDir = await this.operations.download(
        this.pluginsDir, pluginName, source, marketplace, catalog.metadata?.pluginRoot, signal,
        dir => {
          check()
          if (publishedIdentity) throw new Error('Plugin publication was already authorized')
          const manifest = readPluginManifest(dir, entry)
          const plan = planPluginResources(pluginName, manifest, dir)
          controls?.beforePublish?.(plan, manifest)
          check()
          const identity = lstatSync(dir)
          if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error('Plugin publication directory changed')
          publishedIdentity = { dev: identity.dev, ino: identity.ino }
        }, address => { check(); controls?.beforeRequest?.(address); check() }
      )
      check()
      if (pluginDir !== finalDir) throw new Error('Plugin download returned an unexpected directory')
      // Native bindings require the actual downloader's pre-publication receipt.
      // Legacy injected operations without controls keep their existing contract.
      if (controls && !publishedIdentity) throw new Error('Plugin publication ownership was not confirmed')
      if (publishedIdentity) {
        const identity = lstatSync(pluginDir)
        if (identity.dev !== publishedIdentity.dev || identity.ino !== publishedIdentity.ino || !identity.isDirectory() || identity.isSymbolicLink()) throw new Error('Plugin publication directory changed')
      }
      const manifest = readPluginManifest(pluginDir, entry)
      const plan = planPluginResources(pluginName, manifest, pluginDir)
      controls?.beforeMaterialize?.(plan, manifest)
      check()
      const installed = this.db.db.transaction(() => {
        const row = this.db.createInstalledPlugin({ name: entry.name, marketplace_id: marketplaceId,
          manifest, source, scope, version: entry.version || '1.0.0' })
        applyPluginResources(this.db, row, pluginDir, currentPlan => {
          check()
          if (JSON.stringify(currentPlan) !== JSON.stringify(plan)) throw new Error('Plugin resource plan changed before materialization')
        })
        return row
      })()
      committed = true
      return installed
    } catch (error) {
      // Reconcile only the precise tree published by this accepted download.
      // A swapped, linked or otherwise unowned destination is preserved.
      if (!committed && publishedIdentity && !this.db.getInstalledPlugins().some(plugin => plugin.name === pluginName)) {
        try {
          const identity = lstatSync(finalDir)
          if (identity.dev === publishedIdentity.dev && identity.ino === publishedIdentity.ino && identity.isDirectory() && !identity.isSymbolicLink()) {
            inspectPluginTree(finalDir)
            rmSync(finalDir, { recursive: true })
          }
        } catch { /* An ambiguous tree remains available for manual recovery. */ }
      }
      throw error
    }
  }

  async uninstallPlugin(pluginId: string): Promise<boolean> {
    this.assertOpen()
    const plugin = this.db.getInstalledPlugin(pluginId)
    if (!plugin) return false

    const pluginDir = this.pluginPath(plugin.name)
    this.assertUnambiguousResources(plugin.name)
    // Existing linked/ambiguous trees are never treated as owned uninstall data.
    let directoryPresent = true
    try { lstatSync(pluginDir) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      directoryPresent = false
    }
    if (directoryPresent) inspectPluginTree(pluginDir)
    const removed = this.db.db.transaction(() => {
      removePluginResources(this.db, plugin.name)
      return this.db.deleteInstalledPlugin(pluginId)
    })()
    if (existsSync(pluginDir)) {
      try {
        rmSync(pluginDir, { recursive: true, force: true })
      } catch {
        console.warn('[ClaudePluginManager] Plugin cleanup requires manual recovery')
      }
    }

    return removed
  }

  private assertUnambiguousResources(name: string): void {
    if (this.db.getInstalledPlugins().filter(plugin => plugin.name === name || plugin.name.startsWith(name + ':') || name.startsWith(plugin.name + ':')).length > 1) {
      throw new Error('Historical plugin directory/resource collision requires manual reconciliation; all data was preserved')
    }
  }

  enablePlugin(pluginId: string): InstalledPluginRecord | undefined {
    this.assertOpen()
    return this.db.updateInstalledPlugin(pluginId, { enabled: true })
  }

  disablePlugin(pluginId: string): InstalledPluginRecord | undefined {
    this.assertOpen()
    return this.db.updateInstalledPlugin(pluginId, { enabled: false })
  }

  getInstalledPlugins(): InstalledPluginRecord[] {
    this.assertOpen()
    return this.db.getInstalledPlugins()
  }

  /**
   * Returns the skills, MCP servers and agents materialised for a plugin, plus
   * manifest-declared commands (already materialised as skills; listed for display).
   */
  getPluginResources(pluginId: string): PluginResources {
    this.assertOpen()
    const plugin = this.db.getInstalledPlugin(pluginId)
    if (!plugin) return { skills: [], mcpServers: [], agents: [], commands: [] }

    this.assertUnambiguousResources(plugin.name)
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
