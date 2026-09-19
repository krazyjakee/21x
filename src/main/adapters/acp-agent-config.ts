/**
 * Cursor-specific configuration for the ACP adapter: how `cursor-agent` is
 * spawned, authenticated and configured.
 */

import type { McpServerConfig, SessionConfig } from './coding-agent-adapter'

export const CURSOR_AGENT_COMMAND = 'cursor-agent'

const CURSOR_ACP_MODEL_VALUES: Record<string, string> = {
  'composer-2.5': 'composer-2.5[fast=true]',
  'grok-4.5': 'grok-4.5[effort=high,fast=true]'
}

export function cursorModelValue(model: string): string {
  return CURSOR_ACP_MODEL_VALUES[model] ?? model
}

export function applyCursorAuthEnv(env: Record<string, string | undefined>, config: Pick<SessionConfig, 'authMethod' | 'apiKeys'>): void {
  const explicitApiKey = config.apiKeys?.cursor
  const useApiKey = config.authMethod === 'api_key'
    || (config.authMethod !== 'subscription' && !!explicitApiKey)

  if (useApiKey) {
    const key = explicitApiKey || env.CURSOR_API_KEY
    if (!key) {
      throw new Error('Cursor API-key authentication requires a configured key or CURSOR_API_KEY')
    }
    env.CURSOR_API_KEY = key
    delete env.CURSOR_AUTH_TOKEN
    console.log('[AcpAdapter/cursor] Auth: API key')
    return
  }

  // CLI login is authoritative in subscription mode; ambient keys must not
  // silently switch billing/authentication away from the logged-in account.
  delete env.CURSOR_API_KEY
  delete env.CURSOR_AUTH_TOKEN
  console.log('[AcpAdapter/cursor] Auth: Cursor CLI login')
}

/**
 * Converts the internal MCP server map to the ACP-spec McpServer array
 * (https://agentclientprotocol.com/protocol/schema):
 * - stdio: { name, command, args, env: EnvVariable[] }
 * - http/sse: { type, name, url, headers: HttpHeader[] }
 * EnvVariable / HttpHeader = { name, value }.
 */
export function convertAcpMcpServers(servers?: Record<string, McpServerConfig>): unknown[] {
  if (!servers) return []
  const toPairs = (record?: Record<string, string>): Array<{ name: string; value: string }> =>
    Object.entries(record ?? {}).map(([name, value]) => ({ name, value }))

  return Object.entries(servers).map(([name, config]) => config.type === 'stdio'
    ? { name, command: config.command, args: config.args || [], env: toPairs(config.env) }
    : { type: config.type, name, url: config.url, headers: toPairs(config.headers) })
}
