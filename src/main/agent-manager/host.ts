import type { DatabaseManager } from '../database/manager'
import type { CodingAgentAdapter, McpServerConfig } from '../adapters/coding-agent-adapter'
import type { McpServerOptions } from './session-config-core'

/** The GUI attachment is optional; durable events never depend on one. */
export interface AgentWindow {
  isDestroyed(): boolean
  isFocused(): boolean
  show(): void
  focus(): void
  webContents: { send(channel: string, ...args: unknown[]): void }
}

export type AgentNotifications = { kind: 'unsupported' } | {
  kind: 'native'
  isSupported(): boolean
  show(options: { title: string; body: string; onClick(): void }): void
}

export type AgentSecrets = { kind: 'unsupported' } | {
  kind: 'broker'
  getPort(): number | null
  register(token: string, agentId: string, secretIds: string[]): void
  unregister(token: string): void
  writeShellWrapper(): string
}

export interface SessionConfigHost {
  secrets: AgentSecrets
  configuredMcp: 'enabled' | 'disabled'
  managedTaskMcp: { kind: 'disabled' } | {
    kind: 'server'
    waitUntilReady(): Promise<number | null>
    buildConfig(options?: McpServerOptions): McpServerConfig | null
  }
}

/** Required host policy; importing the lifecycle never chooses a native host. */
export interface AgentManagerHost extends SessionConfigHost {
  renderer: { kind: 'unsupported' } | {
    kind: 'native'
    send(target: AgentWindow['webContents'], channel: string, ...args: unknown[]): boolean
  }
  notifications: AgentNotifications
  energy: { kind: 'unsupported' } | {
    kind: 'native'
    start(): number
    stop(id: number): void
  }
  createAdapter(backendType: string, db: DatabaseManager): CodingAgentAdapter | null
  isCodexAppServerAdapter(adapter: CodingAgentAdapter): boolean
}
