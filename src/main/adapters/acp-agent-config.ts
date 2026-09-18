/**
 * Per-agent configuration for the ACP adapter: how each ACP agent is spawned,
 * authenticated and configured.
 */

import type { McpServerConfig, SessionConfig } from './coding-agent-adapter'

export type AcpAgentType = 'codex' | 'cursor'

export interface AcpAgentConfig {
  command: string
  args: string[]
  env?: Record<string, string>
}

const CURSOR_ACP_MODEL_VALUES: Record<string, string> = {
  'composer-2.5': 'composer-2.5[fast=true]',
  'grok-4.5': 'grok-4.5[effort=high,fast=true]'
}

export function getAcpAgentConfig(agentType: AcpAgentType): AcpAgentConfig {
  switch (agentType) {
    case 'codex': {
      // @agentclientprotocol/codex-acp ships a Node entrypoint that spawns the
      // bundled @openai/codex; it is not a native binary, so run it via Node.
      const entry = require.resolve('@agentclientprotocol/codex-acp/dist/index.js')
      console.log(`[AcpAdapter/codex] Resolved codex-acp entry: ${entry}`)
      return { command: process.execPath, args: [entry], env: {} }
    }
    case 'cursor':
      return { command: 'cursor-agent', args: ['acp'], env: {} }
    default:
      throw new Error(`Unsupported ACP agent type: ${agentType}`)
  }
}

export function acpModelValue(agentType: AcpAgentType, model: string): string {
  return agentType === 'cursor' ? CURSOR_ACP_MODEL_VALUES[model] ?? model : model
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

type AuthMethod = { id: string; [key: string]: unknown }

/**
 * Picks the ACP `authenticate` method. With an API key, Codex's browser-based
 * "chatgpt" method is excluded so codex-acp uses the key instead of opening an
 * OAuth popup; on the subscription path a non-key method (e.g. an existing
 * Codex CLI login) is preferred.
 */
export function pickAcpAuthMethod(agentType: AcpAgentType, authMethods: AuthMethod[], useApiKey: boolean): AuthMethod | null {
  const usableMethods = agentType === 'codex' && useApiKey
    ? authMethods.filter((m) => m.id !== 'chatgpt')
    : authMethods
  const isKeyMethod = (m: AuthMethod): boolean => m.id === 'openai-api-key' || m.id === 'codex-api-key'
  const apiKeyMethod = usableMethods.find(isKeyMethod)
  return useApiKey
    ? (apiKeyMethod || usableMethods[0] || null)
    : (usableMethods.find((m) => !isKeyMethod(m)) || apiKeyMethod || null)
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
