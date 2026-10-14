import type { JsonValue } from './service-protocol'
import { describe, expect, it } from 'vitest'
import { CLAUDE_PLUGIN_CODECS, CLAUDE_PLUGIN_OPERATIONS, CLAUDE_PLUGIN_LOCAL_SOURCE } from './claude-plugin-codecs'
const source = { id: 'marketplace-1', name: 'Human readable market', source_type: 'local', source_url: '/private/profile/marketplace', metadata: { headers: { Authorization: 'private-token' } }, auto_update: false, created_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z' }
const plugin = { id: 'plugin-1', name: 'fixture-plugin', marketplace_id: source.id, manifest: { name: 'fixture-plugin', description: 'Public description', author: { name: 'Public author', email: 'private-email' }, mcpServers: { server: { env: { TOKEN: 'private-token' } } }, hooks: { command: '/private/bin/tool' } }, source: { path: './fixture-plugin', headers: { Authorization: 'private-token' } }, scope: 'user', enabled: true, version: '1.0.0', installed_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z' }
describe('finite Claude plugin desktop codecs', () => {
  it('declares eleven existing operations and preserves optional/void result semantics', () => {
    expect(CLAUDE_PLUGIN_OPERATIONS).toHaveLength(11)
    expect(Object.keys(CLAUDE_PLUGIN_CODECS)).toEqual([...CLAUDE_PLUGIN_OPERATIONS])
    expect(CLAUDE_PLUGIN_CODECS['claudePlugin:discoverPlugins'].encodeArguments([undefined])).toEqual({})
    expect(CLAUDE_PLUGIN_CODECS['claudePlugin:enablePlugin'].encodeResult(undefined)).toEqual({ defined: false })
    expect(CLAUDE_PLUGIN_CODECS['claudePlugin:fetchCatalog'].decodeResult(null)).toBeNull()
    expect(() => CLAUDE_PLUGIN_CODECS['claudePlugin:installPlugin'].decodeResult(undefined)).toThrow()
  })
  it('withholds source secrets/local paths and arbitrary installed manifest fields', () => {
    const marketplace = CLAUDE_PLUGIN_CODECS['claudePlugin:addMarketplaceSource'].encodeResult(source)
    expect(marketplace).toEqual({ defined: true, value: { ...source, source_url: CLAUDE_PLUGIN_LOCAL_SOURCE, metadata: {} } })
    const wire = CLAUDE_PLUGIN_CODECS['claudePlugin:installPlugin'].encodeResult(plugin)
    expect(JSON.stringify(wire)).not.toContain('private')
    expect(wire).toMatchObject({ value: { source: { path: './fixture-plugin' }, manifest: { name: plugin.name, description: 'Public description', author: { name: 'Public author' } } } })
    expect(CLAUDE_PLUGIN_CODECS['claudePlugin:installPlugin'].validateResult(plugin)).toBe(false)
    expect(CLAUDE_PLUGIN_CODECS['claudePlugin:installPlugin'].validateWireResult(wire)).toBe(true)
    if (!wire.defined) throw new Error('Missing fixture row')
    // Native JSON object order is not authority or schema information.
    const reordered = Object.fromEntries(Object.entries(wire.value as object).reverse())
    expect(CLAUDE_PLUGIN_CODECS['claudePlugin:installPlugin'].validateResult(reordered)).toBe(true)
  })
  it('accepts legacy named command objects and string/object authors while withholding executable/prompt data', () => {
    const resources = { skills: [{ id: 'skill', name: 'fixture:skill', description: 'Public skill' }], mcpServers: [{ id: 'mcp', name: 'fixture:mcp', command: '/private/runtime/node', args: ['--token', 'private-token'] }], agents: [{ id: 'agent', name: 'fixture:agent', description: 'private-agent-prompt' }], commands: [{ name: 'build', prompt: 'private-command-prompt' }, 'commands/test.md'] }
    const wire = CLAUDE_PLUGIN_CODECS['claudePlugin:getPluginResources'].encodeResult(resources)
    expect(wire).toEqual({ defined: true, value: { ...resources, mcpServers: [{ id: 'mcp', name: 'fixture:mcp', command: '', args: [] }], agents: [{ id: 'agent', name: 'fixture:agent', description: '' }], commands: ['build', 'commands/test.md'] } })
    expect(JSON.stringify(wire)).not.toContain('private')
    const catalog = { name: 'Fixture', owner: 'Catalog author', metadata: { pluginRoot: 'plugins', headers: { Token: 'private' } }, plugins: [{ name: 'fixture', source: './fixture', author: 'Plugin author', env: { TOKEN: 'private' } }] }
    expect(CLAUDE_PLUGIN_CODECS['claudePlugin:fetchCatalog'].encodeResult(catalog)).toEqual({ defined: true, value: { name: 'Fixture', owner: { name: 'Catalog author' }, metadata: {}, plugins: [{ name: 'fixture', source: './fixture', author: { name: 'Plugin author' } }] } })
  })
  it('rejects traversal, arbitrary authority/config fields, unsupported scope and malformed sources', () => {
    for (const data of [{ name: 'x', source_url: 'owner/repo', metadata: { env: 'private' } }, { name: 'x', source_type: 'url', source_url: 'https://user:secret@example.test/catalog.json' }, { name: 'x', source_type: 'url', source_url: 'https://example.test/catalog.json?key=secret' }, { name: 'x', source_type: 'github', source_url: '../escape' }]) expect(() => CLAUDE_PLUGIN_CODECS['claudePlugin:addMarketplaceSource'].decodeArguments(JSON.parse(JSON.stringify({ data })) as JsonValue)).toThrow()
    expect(() => CLAUDE_PLUGIN_CODECS['claudePlugin:installPlugin'].encodeArguments(['../escape', 'marketplace'])).toThrow()
    expect(() => CLAUDE_PLUGIN_CODECS['claudePlugin:installPlugin'].encodeArguments(['fixture', 'marketplace', 'project'])).toThrow()
    expect(() => CLAUDE_PLUGIN_CODECS['claudePlugin:getPluginResources'].decodeArguments({ pluginId: 'fixture', engineEpoch: 'caller-grant' })).toThrow()
    expect(() => CLAUDE_PLUGIN_CODECS['claudePlugin:installPlugin'].encodeResult({ ...plugin, source: { path: '/private/tree' } })).toThrow()
    expect(() => CLAUDE_PLUGIN_CODECS['claudePlugin:installPlugin'].encodeResult({ ...plugin, source: { source: 'npm', package: 'unreviewed' } })).toThrow()
  })
  it('bounds arrays/public results and rejects unsupported resource command paths', () => {
    expect(() => CLAUDE_PLUGIN_CODECS['claudePlugin:getMarketplaceSources'].encodeResult(Array(129).fill(source))).toThrow()
    expect(() => CLAUDE_PLUGIN_CODECS['claudePlugin:fetchCatalog'].encodeResult({ name: 'x', owner: { name: 'x' }, plugins: Array(513).fill({ name: 'fixture', source: './fixture' }) })).toThrow()
    expect(() => CLAUDE_PLUGIN_CODECS['claudePlugin:getPluginResources'].encodeResult({ skills: [], mcpServers: [], agents: [], commands: ['../private'] })).toThrow()
  })
})
