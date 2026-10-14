import { describe, expect, it } from 'vitest'
import { CLI_MCP_CODECS, CLI_MCP_OPERATIONS, projectCliMcpResult } from './cli-mcp-codecs'
import { CLI_IDS, CLI_CAPABILITIES, CLI_LABELS, MASKED_SECRET } from './cli-mcp-config'

const snapshot = () => ({ clis: CLI_IDS.map(cli => ({ cli, label: CLI_LABELS[cli], files: [{ path: '/approved/config', exists: true, role: 'servers' }], fingerprint: 'a'.repeat(64), capabilities: CLI_CAPABILITIES[cli], notes: [] })), servers: [{ cli: 'codex', name: 'docs', definition: { transport: 'http', url: 'https://docs.example/mcp', headers: { Authorization: MASKED_SECRET } }, enabled: true, disabledTools: [], maskedKeys: { env: [], headers: ['Authorization'] }, issues: [] }], loadedAt: '2026-10-14T00:00:00Z' })
describe('finite CLI MCP wire contracts', () => {
  it('retains six exact positional operations with no public host paths or authority', () => {
    const cases = { 'cliMcp:snapshot': [], 'cliMcp:upsert': [{ targets: ['codex'], name: 'docs', definition: { transport: 'http', url: 'https://docs.example/mcp' } }], 'cliMcp:remove': [{ cli: 'codex', name: 'docs' }], 'cliMcp:setEnabled': [{ cli: 'opencode', name: 'my server', enabled: false }], 'cliMcp:setToolEnabled': [{ cli: 'claude-code', name: 'docs', tool: 'search', enabled: false }], 'cliMcp:probe': [{ cli: 'codex', name: 'docs', expectedFingerprint: 'a'.repeat(64) }] }
    expect(CLI_MCP_OPERATIONS).toHaveLength(6)
    for (const operation of CLI_MCP_OPERATIONS) {
      const codec = CLI_MCP_CODECS[operation], args = cases[operation]
      expect(codec.decodeArguments(codec.encodeArguments(args as never))).toEqual(args)
      expect(() => codec.decodeArguments({ ref: args[0] as never, path: '/foreign', authority: 'all' })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }))
    }
  })
  it('rejects unknown CLIs, excess targets, malformed URLs/prototypes/Unicode and oversized values', () => {
    const codec = CLI_MCP_CODECS['cliMcp:upsert'], request = { targets: ['codex'], name: 'docs', definition: { transport: 'stdio', command: 'node', env: { TOKEN: MASKED_SECRET } } }
    expect(codec.validateArguments([request])).toBe(true)
    for (const value of [{ ...request, targets: ['pi'] }, { ...request, targets: ['codex', 'codex'] }, { ...request, name: '__proto__' }, { ...request, name: ' __proto__ ' }, { ...request, name: 'constructor\uFEFF' }, { ...request, definition: { transport: 'http', url: 'https://user:password@example/mcp' } }, { ...request, definition: { transport: 'stdio', command: 'node', args: ['\ud800'] } }, { ...request, definition: { transport: 'stdio', command: 'node', env: { TOKEN: 'x'.repeat(16385) } } }]) expect(codec.validateArguments([value])).toBe(false)
    expect(CLI_MCP_CODECS['cliMcp:probe'].validateArguments([{ cli: 'codex', name: 'docs', expectedFingerprint: 'missing' }])).toBe(false)
  })
  it('roundtrips snapshots/mutations/probe tools and refuses unknown private result fields', () => {
    const value = snapshot(), codec = CLI_MCP_CODECS['cliMcp:snapshot']
    const wire = codec.encodeResult(value)
    expect(codec.decodeResult(wire.defined ? wire.value : undefined)).toEqual(value)
    const mutation = { results: [{ cli: 'codex', ok: false, warnings: [], conflict: { cli: 'codex', paths: ['/approved/config'], expectedFingerprint: 'a'.repeat(64), currentFingerprint: 'b'.repeat(64) } }], snapshot: value }
    expect(CLI_MCP_CODECS['cliMcp:remove'].validateResult(mutation)).toBe(true)
    const probe = { status: 'connected', checkedAt: value.loadedAt, toolCount: 1, tools: [{ name: 'search', description: 'Search the configured docs.\nReturns matching pages.' }] }
    expect(CLI_MCP_CODECS['cliMcp:probe'].validateResult(probe)).toBe(true)
    expect(codec.validateResult({ ...value, nonce: 'private' })).toBe(false)
    expect(codec.validateWireResult({ defined: false })).toBe(false)
    expect(CLI_MCP_CODECS['cliMcp:probe'].validateResult({ ...probe, tools: Array.from({ length: 129 }, () => probe.tools[0]) })).toBe(false)
  })
  it('projects fixed parse/provider diagnostics without dropping genuine tool descriptions', () => {
    const source = { ...snapshot(), clis: snapshot().clis.map(cli => ({ ...cli, error: 'private key/source JSON text' })) }
    const publicValue = projectCliMcpResult('cliMcp:snapshot', source)
    expect(JSON.stringify(publicValue)).not.toContain('private key')
    const probe = projectCliMcpResult('cliMcp:probe', { status: 'failed', checkedAt: source.loadedAt, error: 'secret provider error', errorDetail: 'private request', tools: [{ name: 'search', description: 'Genuine discovered description' }] })
    expect(probe).toMatchObject({ error: 'The MCP connection could not be checked.', tools: [{ name: 'search', description: 'Genuine discovered description' }] })
    expect(JSON.stringify(probe)).not.toContain('private request')
  })
})
