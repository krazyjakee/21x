/** Electron-era adapter over the portable task API core. */
import type { DatabaseManager } from './database'
import { Notification } from 'electron'
import type { TaskMcpScope } from './mcp-servers/task-management-core'
import * as core from './task-api-server-core'
export * from './task-api-server-core'
const legacyHost = {
  notifyUser(title: string, body: string): void {
    if (Notification.isSupported()) new Notification({ title, body }).show()
  }
}

export function startTaskApiServer(db: DatabaseManager): Promise<number> {
  return core.startTaskApiServer(db, legacyHost)
}
export function handleRoute(db: DatabaseManager, route: string, params: Record<string, unknown>, trustedScope?: TaskMcpScope): Promise<unknown> {
  return core.handleRoute(db, route, params, trustedScope, legacyHost)
}
