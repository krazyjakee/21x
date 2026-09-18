/**
 * The MCP client handshake, written by hand once.
 *
 * Two callers speak to MCP servers without the SDK client and share these
 * messages so the protocol version and client identity cannot drift:
 *   - agent-manager/mcp-server-test.ts probes a server over stdio or HTTP. The
 *     SDK's stdio transport hard-codes `shell: false`, but `npx`/`uvx`/`bunx`
 *     and Windows `.cmd` wrappers need a shell, so the probe spawns itself.
 *   - oauth/mcp-discovery.ts sends an unauthenticated initialize and needs the
 *     raw 401 response headers, which the SDK transport does not surface.
 */

import { CLIENT_NAME } from './app-identity'

export const MCP_PROTOCOL_VERSION = '2024-11-05'
export const MCP_CLIENT_INFO = { name: CLIENT_NAME, version: '1.0.0' } as const

export const MCP_INITIALIZE_ID = 1
export const MCP_TOOLS_LIST_ID = 2

export interface McpToolSummary {
  name: string
  description: string
}

/** A JSON-RPC response as far as the probe cares: an id, and a result or an error. */
export interface McpRpcResponse {
  id?: number | string
  error?: { message?: string; [key: string]: unknown }
  result?: unknown
}

export function mcpInitializeRequest(id: number = MCP_INITIALIZE_ID): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: MCP_CLIENT_INFO }
  }
}

export function mcpInitializedNotification(): Record<string, unknown> {
  return { jsonrpc: '2.0', method: 'notifications/initialized' }
}

export function mcpToolsListRequest(id: number = MCP_TOOLS_LIST_ID): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'tools/list' }
}

/** Reduces a tools/list result to the {name, description} rows stored on mcp_servers. */
export function summarizeMcpTools(result: unknown): McpToolSummary[] {
  const tools = (result as { tools?: unknown } | null | undefined)?.tools
  if (!Array.isArray(tools)) return []
  return tools.map((tool) => {
    const t = (tool ?? {}) as { name?: unknown; description?: unknown }
    return {
      name: typeof t.name === 'string' ? t.name : '',
      description: typeof t.description === 'string' ? t.description : ''
    }
  })
}

/** The user-facing message for a JSON-RPC error object. */
export function mcpErrorMessage(error: McpRpcResponse['error'], fallback: string): string {
  if (!error) return fallback
  return typeof error.message === 'string' && error.message ? error.message : JSON.stringify(error)
}
