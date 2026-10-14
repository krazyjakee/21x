import { describe, expect, it } from 'vitest'
import { MCP_CODECS, MCP_OPERATIONS, MCP_SECRET_SET_MARKER as marker } from './mcp-codecs'
const raw = { id: 'server:fixture', name: 'Fixture', type: 'remote', command: '', args: [], url: 'https://mcp.example.test', headers: { Authorization: 'Bearer private' }, environment: { SERVICE_TOKEN: 'private-env' }, tools: [{ name: 'lookup', description: 'Read items' }], oauth_metadata: { client_id: 'public-client', client_secret: 'private-client', registration_method: 'manual' }, source: 'user', created_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z' }
describe('finite MCP desktop codecs', () => {
  it('declares ten exact operations and preserves legacy optional/void semantics', () => {
    expect(MCP_OPERATIONS).toHaveLength(10)
    expect(Object.keys(MCP_CODECS)).toEqual([...MCP_OPERATIONS])
    expect(MCP_CODECS['mcp:getAll'].encodeArguments([])).toEqual({})
    expect(() => MCP_CODECS['mcp:create'].decodeResult(undefined)).toThrow()
    expect(MCP_CODECS['mcp:update'].encodeResult(undefined)).toEqual({ defined: false })
    expect(MCP_CODECS['mcp:revokeOAuthToken'].encodeResult(undefined)).toEqual({ defined: false })
    expect(MCP_CODECS['mcp:delete'].decodeResult(false)).toBe(false)
    expect(() => MCP_CODECS['mcp:revokeOAuthToken'].decodeResult(null)).toThrow()
    expect(MCP_CODECS['mcp:revokeOAuthToken'].validateWireResult({ defined: false, value: null })).toBe(false)
  })
  it('projects public auth/env metadata without exporting plaintext or ciphertext', () => {
    const wire = MCP_CODECS['mcp:create'].encodeResult(raw)
    expect(wire).toEqual({ defined: true, value: { ...raw, headers: { Authorization: marker }, environment: { SERVICE_TOKEN: marker }, oauth_metadata: { client_id: 'public-client', client_secret: marker, registration_method: 'manual' } } })
    expect(JSON.stringify(wire)).not.toContain('private')
    expect(MCP_CODECS['mcp:create'].validateResult(raw)).toBe(false)
    expect(MCP_CODECS['mcp:create'].validateWireResult(wire)).toBe(true)
    expect(() => MCP_CODECS['mcp:create'].decodeResult(raw)).toThrow()
    const multiline = { ...raw, tools: [{ name: 'lookup', description: 'Read items\nReturn a bounded page.' }] }
    expect(MCP_CODECS['mcp:create'].encodeResult(multiline)).toMatchObject({ value: { tools: multiline.tools } })
    expect(() => MCP_CODECS['mcp:create'].encodeResult({ ...raw, tools: [{ name: 'lookup', description: 'Bad\0metadata' }] })).toThrow()
  })
  it('accepts only reviewed configuration/probe fields, bounds and exact URL forms', () => {
    for (const data of [{ name: 'x', source: 'plugin' }, { name: 'x', oauth_metadata: { client_secret: 'secret' } }, { name: 'x', enabled: true }, { name: 'x', environment: { 'BAD-NAME': 'private' } }, { name: 'x', headers: { Authorization: 'a\r\nb' } }, { name: 'x', args: Array(129).fill('a') }, { name: 'x', url: 'https://u:p@example.test' }, { name: 'x', url: 'file:///private' }, { name: 'x', url: 'https://example.test?token=private' }]) expect(() => MCP_CODECS['mcp:create'].encodeArguments([data])).toThrow()
    const data = { id: 'fixture', name: 'Remote', type: 'remote', url: 'https://mcp.example.test', headers: { Authorization: marker } }
    expect(MCP_CODECS['mcp:testConnection'].decodeArguments({ data })).toEqual([data])
    expect(() => MCP_CODECS['mcp:testConnection'].decodeArguments({ data, caller: 'main' })).toThrow()
    expect(() => MCP_CODECS['mcp:update'].encodeArguments(['fixture', { name: 'x'.repeat(257) }])).toThrow()
  })
  it('rejects raw server diagnostics and token-shaped result extras', () => {
    expect(() => MCP_CODECS['mcp:testConnection'].encodeResult({ status: 'failed', error: 'private-url-or-secret' })).toThrow()
    expect(() => MCP_CODECS['mcp:testConnection'].encodeResult({ status: 'failed', error: 'MCP probe failed', errorDetail: 'private' })).toThrow()
    expect(() => MCP_CODECS['mcp:getOAuthStatus'].encodeResult({ connected: true, accessToken: 'private' })).toThrow()
    expect(() => MCP_CODECS['mcp:startOAuthFlow'].encodeResult({ authUrl: 'https://private' })).toThrow()
    expect(() => MCP_CODECS['mcp:testConnection'].encodeResult({ status: 'connected', tools: Array(257).fill({ name: 'x', description: '' }) })).toThrow()
    expect(() => MCP_CODECS['mcp:getAll'].encodeResult(Array(129).fill(raw))).toThrow()
  })
})
