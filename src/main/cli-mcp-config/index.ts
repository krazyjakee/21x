/** Electron compatibility wrapper. The portable owner imports core.ts only. */
import { CliMcpConfigManager as Core, type CliMcpConfigManagerOptions } from './core'
export { createDefaultStores } from './core'
export type { CliMcpConfigManagerOptions, CliMcpRequestControls, CliMcpStore } from './core'
export class CliMcpConfigManager extends Core {
  constructor(options:CliMcpConfigManagerOptions={}) {
    super(options.files ? options : { ...options, probe: options.probe ?? (async input => (await import('../agent-manager/mcp-server-test')).testMcpServer(input)) })
  }
}
