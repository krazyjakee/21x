import { describe, expect, it } from 'vitest'
import {
  MCP_CLIENT_INFO,
  MCP_INITIALIZE_ID,
  MCP_PROTOCOL_VERSION,
  MCP_TOOLS_LIST_ID,
  mcpErrorMessage,
  mcpInitializeRequest,
  mcpInitializedNotification,
  mcpToolsListRequest,
  summarizeMcpTools
} from './mcp-client-messages'

describe('mcp-client-messages', () => {
  it('builds the initialize request with the shared protocol version and client identity', () => {
    expect(mcpInitializeRequest()).toEqual({
      jsonrpc: '2.0',
      id: MCP_INITIALIZE_ID,
      method: 'initialize',
      params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: MCP_CLIENT_INFO }
    })
    expect(mcpInitializeRequest(7).id).toBe(7)
  })

  it('identifies as 21x', () => {
    expect(MCP_CLIENT_INFO.name).toBe('21x')
  })

  it('builds the initialized notification without an id', () => {
    expect(mcpInitializedNotification()).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized' })
  })

  it('builds the tools/list request', () => {
    expect(mcpToolsListRequest()).toEqual({ jsonrpc: '2.0', id: MCP_TOOLS_LIST_ID, method: 'tools/list' })
  })

  it('reduces a tools/list result to name/description rows', () => {
    const result = {
      tools: [
        { name: 'list_tasks', description: 'List tasks', inputSchema: { type: 'object' } },
        { name: 'no_description' },
        { description: 'no name' },
        null
      ]
    }
    expect(summarizeMcpTools(result)).toEqual([
      { name: 'list_tasks', description: 'List tasks' },
      { name: 'no_description', description: '' },
      { name: '', description: 'no name' },
      { name: '', description: '' }
    ])
  })

  it('returns no tools for a missing or malformed result', () => {
    expect(summarizeMcpTools(undefined)).toEqual([])
    expect(summarizeMcpTools({})).toEqual([])
    expect(summarizeMcpTools({ tools: 'nope' })).toEqual([])
  })

  it('prefers the error message and falls back to the serialized error', () => {
    expect(mcpErrorMessage({ code: -32601, message: 'Method not found' }, 'fallback')).toBe('Method not found')
    expect(mcpErrorMessage({ code: -32000 }, 'fallback')).toBe('{"code":-32000}')
    expect(mcpErrorMessage(undefined, 'fallback')).toBe('fallback')
  })
})
