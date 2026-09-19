import { createId } from '@paralleldrive/cuid2'
import type { DatabaseManager } from '../database'
import { deserializeInstalledPlugin, deserializeMarketplaceSource } from './serializers'
import type {
  CreateInstalledPluginData, InstalledPluginRecord, InstalledPluginRow, UpdateInstalledPluginData,
  CreateMarketplaceSourceData, MarketplaceSourceRecord, MarketplaceSourceRow
} from './types'

export function getMarketplaceSources(m: DatabaseManager): MarketplaceSourceRecord[] {
  const rows = m.prepare('SELECT * FROM marketplace_sources ORDER BY created_at DESC').all() as MarketplaceSourceRow[]
  return rows.map(deserializeMarketplaceSource)
}

export function getMarketplaceSource(m: DatabaseManager, id: string): MarketplaceSourceRecord | undefined {
  const row = m.prepare('SELECT * FROM marketplace_sources WHERE id = ?').get(id) as MarketplaceSourceRow | undefined
  return row ? deserializeMarketplaceSource(row) : undefined
}

export function getMarketplaceSourceByName(m: DatabaseManager, name: string): MarketplaceSourceRecord | undefined {
  const row = m.prepare('SELECT * FROM marketplace_sources WHERE name = ?').get(name) as MarketplaceSourceRow | undefined
  return row ? deserializeMarketplaceSource(row) : undefined
}

export function createMarketplaceSource(m: DatabaseManager, data: CreateMarketplaceSourceData): MarketplaceSourceRecord {
  const id = createId()
  const now = new Date().toISOString()
  m.prepare(
    'INSERT INTO marketplace_sources (id, name, source_type, source_url, metadata, auto_update, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, data.name, data.source_type || 'github', data.source_url, JSON.stringify(data.metadata || {}), data.auto_update ? 1 : 0, now, now)
  return getMarketplaceSource(m, id)!
}

export function deleteMarketplaceSource(m: DatabaseManager, id: string): boolean {
  const result = m.prepare('DELETE FROM marketplace_sources WHERE id = ?').run(id)
  return result.changes > 0
}

export function getInstalledPlugins(m: DatabaseManager): InstalledPluginRecord[] {
  const rows = m.prepare('SELECT * FROM installed_plugins ORDER BY installed_at DESC').all() as InstalledPluginRow[]
  return rows.map(deserializeInstalledPlugin)
}

export function getInstalledPlugin(m: DatabaseManager, id: string): InstalledPluginRecord | undefined {
  const row = m.prepare('SELECT * FROM installed_plugins WHERE id = ?').get(id) as InstalledPluginRow | undefined
  return row ? deserializeInstalledPlugin(row) : undefined
}

export function getInstalledPluginByName(m: DatabaseManager, name: string, marketplaceId: string): InstalledPluginRecord | undefined {
  const row = m.prepare('SELECT * FROM installed_plugins WHERE name = ? AND marketplace_id = ?').get(name, marketplaceId) as InstalledPluginRow | undefined
  return row ? deserializeInstalledPlugin(row) : undefined
}

export function createInstalledPlugin(m: DatabaseManager, data: CreateInstalledPluginData): InstalledPluginRecord {
  const id = createId()
  const now = new Date().toISOString()
  m.prepare(
    'INSERT INTO installed_plugins (id, name, marketplace_id, manifest, source, scope, enabled, version, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id, data.name, data.marketplace_id, JSON.stringify(data.manifest || {}),
    JSON.stringify(data.source || {}), data.scope || 'user', 1, data.version || '1.0.0', now, now
  )
  return getInstalledPlugin(m, id)!
}

export function updateInstalledPlugin(m: DatabaseManager, id: string, data: UpdateInstalledPluginData): InstalledPluginRecord | undefined {
  const existing = getInstalledPlugin(m, id)
  if (!existing) return undefined
  const now = new Date().toISOString()
  const sets: string[] = ['updated_at = ?']
  const values: unknown[] = [now]
  if (data.enabled !== undefined) { sets.push('enabled = ?'); values.push(data.enabled ? 1 : 0) }
  if (data.manifest !== undefined) { sets.push('manifest = ?'); values.push(JSON.stringify(data.manifest)) }
  if (data.version !== undefined) { sets.push('version = ?'); values.push(data.version) }
  if (data.scope !== undefined) { sets.push('scope = ?'); values.push(data.scope) }
  values.push(id)
  m.db.prepare(`UPDATE installed_plugins SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  return getInstalledPlugin(m, id)
}

export function deleteInstalledPlugin(m: DatabaseManager, id: string): boolean {
  const result = m.prepare('DELETE FROM installed_plugins WHERE id = ?').run(id)
  return result.changes > 0
}
