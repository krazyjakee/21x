/** Electron-era adapter; the portable core excludes the retired browser host by default. */
import type { DatabaseManager } from './database'
import type { TaskMcpScope } from './mcp-servers/task-management-core'
import { handleBrowserRoute } from './task-api/browser-routes'
import * as core from './task-api-server-core'
export * from './task-api-server-core'
const legacyHost = { legacyBrowserRoute: handleBrowserRoute }

export function startTaskApiServer(db: DatabaseManager): Promise<number> {
  return core.startTaskApiServer(db, legacyHost)
}
export function handleRoute(db: DatabaseManager, route: string, params: Record<string, unknown>, trustedScope?: TaskMcpScope): Promise<unknown> {
  return core.handleRoute(db, route, params, trustedScope, legacyHost)
}
