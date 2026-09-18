import { ipcMain } from 'electron'
import type { CliMcpServerRef, CliMcpUpsertRequest } from '../../shared/cli-mcp-config'
import { CliMcpConfigManager } from '../cli-mcp-config'

/**
 * Global MCP servers of the installed coding-agent CLIs (Claude Code,
 * OpenCode, Codex): the unified snapshot, add/edit/remove, per-server and
 * per-tool switches, and a live probe. Every mutation returns the fresh
 * snapshot so the renderer never holds a stale fingerprint after a write.
 */
export function registerCliMcpHandlers(manager: CliMcpConfigManager = new CliMcpConfigManager()): void {
  ipcMain.handle('cliMcp:snapshot', () => manager.snapshot())
  ipcMain.handle('cliMcp:upsert', (_, request: CliMcpUpsertRequest) => manager.upsert(request))
  ipcMain.handle('cliMcp:remove', (_, ref: CliMcpServerRef) => manager.remove(ref))
  ipcMain.handle('cliMcp:setEnabled', (_, ref: CliMcpServerRef & { enabled: boolean }) => manager.setEnabled(ref))
  ipcMain.handle('cliMcp:setToolEnabled', (_, ref: CliMcpServerRef & { tool: string; enabled: boolean }) => manager.setToolEnabled(ref))
  ipcMain.handle('cliMcp:probe', (_, ref: CliMcpServerRef) => manager.probe(ref))
}
