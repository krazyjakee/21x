import type { DatabaseManager } from '../database'
import { HttpError } from '../http-utils'
import { deps, type MobileRoute } from './state'

// Source configs hold third-party API tokens. The mobile app never reads them,
// so they do not leave the desktop.
function withoutSourceConfig<T extends { config?: unknown }>(source: T | undefined) {
  if (!source) return source
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { config: _config, ...rest } = source
  return rest
}

function getPlugin(id: string) {
  if (!deps.pluginRegistry) throw new HttpError(503, 'Plugin registry not available')
  const plugin = deps.pluginRegistry.get(id)
  if (!plugin) throw new HttpError(404, 'Plugin not found')
  return plugin
}

function requireSyncManager() {
  if (!deps.syncManager) throw new HttpError(503, 'Sync manager not available')
  return deps.syncManager
}

export const sourceRoutes: MobileRoute[] = [
  { method: 'GET', path: '/api/task-sources', handle: () => deps.db.getTaskSources().map(withoutSourceConfig) },
  { method: 'GET', path: '/api/plugins', handle: () => deps.pluginRegistry?.list() ?? [] },
  { method: 'GET', path: /^\/api\/plugins\/([^/]+)\/schema$/, handle: ({ id }) => getPlugin(id).getConfigSchema() },
  {
    method: 'GET',
    path: /^\/api\/plugins\/([^/]+)\/documentation$/,
    handle: ({ id }) => ({ documentation: getPlugin(id).getSetupDocumentation?.() ?? null })
  },
  {
    // Resolves the dynamic options of a plugin config field.
    method: 'POST',
    path: /^\/api\/plugins\/([^/]+)\/resolve-options$/,
    handle: ({ id, params }) => {
      const plugin = getPlugin(id)
      const { resolverKey, config } = params as { resolverKey?: string; config?: Record<string, unknown> }
      if (!resolverKey) throw new HttpError(400, 'resolverKey is required')
      return plugin.resolveOptions(resolverKey, config || {}, { db: deps.db })
    }
  },
  {
    method: 'POST',
    path: '/api/task-sources',
    handle: ({ params }) => {
      const { name, plugin_id, config, mcp_server_id } = params as {
        name?: string; plugin_id?: string; config?: Record<string, unknown>; mcp_server_id?: string | null
      }
      if (!name || !plugin_id) throw new HttpError(400, 'name and plugin_id are required')
      return withoutSourceConfig(deps.db.createTaskSource({ name, plugin_id, config: config || {}, mcp_server_id: mcp_server_id || null }))
    }
  },
  {
    method: 'POST',
    path: '/api/task-sources/sync-all',
    handle: async () => {
      const syncManager = requireSyncManager()
      const sources = deps.db.getTaskSources().filter((s) => s.enabled)
      const results = await Promise.allSettled(sources.map((s) => syncManager.importTasks(s.id)))
      return results.map((r) => r.status === 'fulfilled' ? r.value : { error: String(r.reason) })
    }
  },
  {
    method: 'POST',
    path: /^\/api\/task-sources\/([^/]+)\/sync$/,
    handle: ({ id }) => requireSyncManager().importTasks(id)
  },
  {
    method: 'POST',
    path: /^\/api\/task-sources\/([^/]+)$/,
    handle: ({ id, params }) => {
      if (!deps.db.getTaskSource(id)) throw new HttpError(404, 'Task source not found')
      return withoutSourceConfig(deps.db.updateTaskSource(id, params as Parameters<DatabaseManager['updateTaskSource']>[1]))
    }
  }
]
