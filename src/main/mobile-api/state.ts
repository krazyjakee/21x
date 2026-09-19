/**
 * Wiring the mobile API routes read at call time. It lives apart from the
 * server module so route modules can import it without a cycle.
 */
import type { IncomingMessage } from 'http'
import { WebSocket } from 'ws'
import type { DatabaseManager } from '../database'
import type { AgentManager } from '../agent-manager'
import type { GitHubManager } from '../github-manager'
import type { GitLabManager } from '../gitlab-manager'
import type { ForgejoManager } from '../forgejo-manager'
import type { SyncManager } from '../sync-manager'
import type { PluginRegistry } from '../plugins/registry'

export interface MobileApiDeps {
  db: DatabaseManager
  agentManager: AgentManager
  githubManager: GitHubManager
  syncManager?: SyncManager | null
  pluginRegistry?: PluginRegistry | null
  gitlabManager?: GitLabManager | null
  forgejoManager?: ForgejoManager | null
}

interface RouteRequest {
  /** The first capture group of a RegExp route path, undecoded. */
  id: string
  params: Record<string, unknown>
  url: URL
  req: IncomingMessage
}

/** Routes are matched in order, so a literal path must precede a `:id` pattern it overlaps. */
export interface MobileRoute {
  method: 'GET' | 'POST'
  path: string | RegExp
  handle: (request: RouteRequest) => unknown
}

/** The dependencies of the running server, set when it starts. */
export let deps: MobileApiDeps = null!

export function setDeps(next: MobileApiDeps): void {
  deps = next
}

export let notifyDesktop: ((channel: string, data: unknown) => void) | null = null

export function setMobileApiNotifier(fn: (channel: string, data: unknown) => void): void {
  notifyDesktop = fn
}

export const wsClients = new Set<WebSocket>()

/**
 * Called by AgentManager (via external listener) whenever it sends an event.
 * Broadcasts to all connected WebSocket clients.
 */
export function broadcastToMobileClients(channel: string, data: unknown): void {
  if (wsClients.size === 0) return

  const message = JSON.stringify({ type: channel, payload: data })
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message)
    }
  }
}

/** Tells every phone and the desktop about a change a phone made. */
export function publish(channel: string, data: unknown): void {
  broadcastToMobileClients(channel, data)
  notifyDesktop?.(channel, data)
}
