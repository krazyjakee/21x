import type Database from 'better-sqlite3'
import { join } from 'path'
import { FULL_ACCESS_SCOPE, listToolsForScope } from '../mcp-servers/task-management-core'
import { seedTaskManagementMcpServer as seedManagedTaskMcp, type ManagedTaskMcpRuntime } from './seed-core'

export { ensureProjectCaptain, seedDefaultAgent, seedCaptainTasks } from './seed-core'
export type { ManagedTaskMcpRuntime } from './seed-core'

/** The full-access tool set actually served by the shipping Electron host. */
export function taskManagementToolRecords(): { name: string; description: string }[] {
  return listToolsForScope(FULL_ACCESS_SCOPE).map((tool) => ({ name: tool.name, description: tool.description ?? '' }))
}

/** Electron compatibility choices stay outside the portable database graph. */
export function electronTaskManagementRuntime(): ManagedTaskMcpRuntime {
  // Bundled __dirname remains out/main, including in the compatibility host.
  let entry = join(__dirname, 'mcp-servers', 'task-management-mcp.js')
  if (entry.includes('app.asar')) entry = entry.replace('app.asar', 'app.asar.unpacked')
  const useSystemNode = process.platform === 'win32' || process.platform === 'darwin'
  return {
    allowLegacySystemNode: true,
    existingServer: { policy: 'electron-name-refresh' },
    command: useSystemNode ? 'node' : process.execPath,
    args: [entry],
    environment: useSystemNode ? {} : { ELECTRON_RUN_AS_NODE: '1' },
    tools: taskManagementToolRecords()
  }
}

/** Existing callers retain automatic Electron runtime refresh behavior. */
export function seedTaskManagementMcpServer(db: Database.Database): void {
  seedManagedTaskMcp(db, electronTaskManagementRuntime())
}
