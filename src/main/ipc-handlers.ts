import type { IpcDeps } from './ipc/deps'
import { registerTaskHandlers } from './ipc/tasks'
import { registerAgentHandlers } from './ipc/agents'
import { registerMcpHandlers } from './ipc/mcp'
import { registerCliMcpHandlers } from './ipc/cli-mcp'
import { registerTaskSourceHandlers } from './ipc/task-sources'
import { registerGitHandlers } from './ipc/git'
import { registerSettingsHandlers } from './ipc/settings'
import { registerAppHandlers } from './ipc/app'
import { registerClaudePluginHandlers } from './ipc/claude-plugins'
import { registerMobileHandlers } from './ipc/mobile'
import { registerTerminalHandlers } from './ipc/terminal'
import { registerBrowserBrokerHandlers } from './ipc/browser-broker'
import { registerExternalAuthHandlers } from './ipc/external-auth'
import { registerVoiceHandlers } from './ipc/voice'
import { registerChatHandlers } from './ipc/chat'

export function registerIpcHandlers(deps: IpcDeps): void {
  registerTaskHandlers(deps)
  registerAgentHandlers(deps)
  registerMcpHandlers(deps)
  registerCliMcpHandlers()
  registerTaskSourceHandlers(deps)
  registerGitHandlers(deps)
  registerSettingsHandlers(deps)
  registerAppHandlers(deps)
  registerClaudePluginHandlers(deps)
  registerMobileHandlers(deps)
  registerTerminalHandlers()
  registerBrowserBrokerHandlers()
  registerExternalAuthHandlers()
  registerVoiceHandlers(deps)
  registerChatHandlers(deps)
}
