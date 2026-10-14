import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { ClaudePluginManager } from '../main/claude-plugin-manager'
import { AgentManager } from '../main/agent-manager-core'
import type { AgentManagerHost } from '../main/agent-manager/host'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { SyncManager } from '../main/sync-manager'
import { PluginRegistry } from '../main/plugins/registry'
import { AuthenticatedSecretStorage } from '../main/platform/authenticated-secret-storage'
import { configureSecretStorage, getSecretStorage, releaseSecretStorage, type SecretStorage } from '../main/platform/secret-storage'
import { ClaudePluginBackend, type ClaudePluginBackendOptions } from './claude-plugin-backend'
import { CLAUDE_PLUGIN_CODECS, CLAUDE_PLUGIN_OPERATIONS, CLAUDE_PLUGIN_LOCAL_SOURCE, type ClaudePluginCodec, type ClaudePluginOperation } from '../shared/claude-plugin-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import type { DesktopCallerContext } from './transport/desktop-registry'
import type { JsonValue } from '../shared/service-protocol'
class Adapter extends FakeAdapter { readonly notifyConfigChanged = vi.fn(async () => undefined) }
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'plugin-epoch', webviewId: 'main', origin: 'app://plugins' }
let db: ReturnType<typeof createPortableTestDb>, manager: ClaudePluginManager, agents: AgentManager, adapter: Adapter, sync: SyncManager, backend: ClaudePluginBackend, options: ClaudePluginBackendOptions
let root: string, marketplaceRoot: string, pluginsRoot: string, marketplaceId: string, storage: AuthenticatedSecretStorage, prior: SecretStorage
let releases: Array<() => void>
let events: Array<{ operation: string; payload: JsonValue }>
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
beforeEach(() => {
  db = createPortableTestDb(); root = mkdtempSync(join(tmpdir(), '21x-plugin-binding-')); marketplaceRoot = join(root, 'marketplace'); pluginsRoot = join(root, 'installed')
  mkdirSync(join(marketplaceRoot, 'fixture-plugin', 'skills'), { recursive: true }); mkdirSync(join(marketplaceRoot, 'fixture-plugin', 'agents')); mkdirSync(join(marketplaceRoot, 'fixture-plugin', 'commands'))
  writeFileSync(join(marketplaceRoot, 'marketplace.json'), JSON.stringify({ name: 'Fixture marketplace', owner: { name: 'Public author', email: 'private-author-email' }, metadata: { pluginRoot: '.', headers: { Authorization: 'private' } }, plugins: [{ name: 'fixture-plugin', source: './fixture-plugin', description: 'Public fixture', version: '1.0.0' }] }))
  writeFileSync(join(marketplaceRoot, 'fixture-plugin', 'plugin.json'), JSON.stringify({ name: 'fixture-plugin', description: 'Public fixture', author: { name: 'Public author', email: 'private-author-email' }, commands: ['commands/build.md'] }))
  writeFileSync(join(marketplaceRoot, 'fixture-plugin', 'skills', 'lookup.md'), '# Lookup\n\nPublic lookup skill.\n')
  writeFileSync(join(marketplaceRoot, 'fixture-plugin', 'commands', 'build.md'), '# Build\n\nPublic build skill.\n')
  writeFileSync(join(marketplaceRoot, 'fixture-plugin', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Public reviewer\n---\nprivate-agent-prompt\n')
  writeFileSync(join(marketplaceRoot, 'fixture-plugin', '.mcp.json'), JSON.stringify({ mcpServers: { lookup: { command: '/private/runtime/node', args: ['--token', 'private-arg-token'], env: { SERVICE_TOKEN: 'private-env-token' } } } }))
  prior = getSecretStorage(); releaseSecretStorage(prior); storage = new AuthenticatedSecretStorage(Buffer.alloc(32, 97), 'plugin-fixture-profile'); configureSecretStorage(storage)
  manager = new ClaudePluginManager(db, pluginsRoot); marketplaceId = manager.addMarketplaceSource({ name: 'Fixture marketplace', source_type: 'local', source_url: marketplaceRoot }).id
  adapter = new Adapter(); releases = []; events = []
  const host: AgentManagerHost = { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' }, configuredMcp: 'enabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => adapter, isCodexAppServerAdapter: () => false }
  agents = new AgentManager(db, host); sync = new SyncManager(db, new PluginRegistry())
  options = { database: db, manager, agents, sync, engineEpoch: caller.engineEpoch,
    assertAvailable() { if (!db.db.open) throw new Error('Closed owner') },
    assertPluginOwners(actual) { if (actual.database !== db || actual.manager !== manager || actual.agents !== agents || actual.sync !== sync) throw new Error('Wrong owner') },
    isTrustedDesktop: value => value.webviewId === caller.webviewId && value.origin === caller.origin,
    canManageConfiguration: () => true, canAccessMarketplace: () => true, canCreateMarketplace: () => true,
    canAccessPluginName: () => true, canAccessPlugin: () => true,
    canUsePluginAddress: () => true,
    canUseMarketplaceSource: source => source.source_type === 'local' && source.source_url === marketplaceRoot,
    canUsePluginSource: (_source, marketplace) => marketplace.source_type === 'local' && marketplace.source_url === marketplaceRoot,
    canAccessSkill: () => true, canAccessMcpServer: () => true, canAccessAgent: () => true, canAccessSource: () => true, canAccessTask: () => true, canAccessProject: () => true, canManageGlobalSkills: () => true,
    canCreateGlobalSkill: () => true, canCreateAgent: () => true, canCreateMcpServer: () => true,
    emit: (operation, payload) => { events.push({ operation, payload }) }, onFatalEvent: vi.fn() }
  backend = new ClaudePluginBackend(options)
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  for (const release of releases) release()
  await Promise.all([backend.close(), manager.close(), sync.close()]); await agents.stopAllSessions()
  const workspace = dirname(dirname(db.getWorkspaceDir('fixture-cleanup')))
  db.close(); releaseSecretStorage(storage); storage.dispose(); configureSecretStorage(prior); rmSync(root, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function call<K extends ClaudePluginOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = CLAUDE_PLUGIN_CODECS[operation] as ClaudePluginCodec<K>
  const result = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
  expect(codec.validateWireResult(result)).toBe(true)
  return codec.decodeResult((result as { defined: boolean; value?: JsonValue }).value)
}
async function install() { await call('claudePlugin:fetchCatalog', [marketplaceId]); return call('claudePlugin:installPlugin', ['fixture-plugin', marketplaceId]) }
describe('actual-owner production Claude plugin controls', () => {
  it('binds eleven operations and installs a real contained local tree with safe public projections', async () => {
    expect(Object.keys(backend.operationSchemas(caller))).toEqual([...CLAUDE_PLUGIN_OPERATIONS])
    const sources = await call('claudePlugin:getMarketplaceSources', [])
    expect(sources.find(source => source.id === marketplaceId)?.source_url).toBe(CLAUDE_PLUGIN_LOCAL_SOURCE)
    const installed = await install()
    expect(installed.name).toBe('fixture-plugin'); expect(existsSync(join(pluginsRoot, 'fixture-plugin', 'skills', 'lookup.md'))).toBe(true)
    const resources = await call('claudePlugin:getPluginResources', [installed.id])
    expect(resources.skills).toHaveLength(2); expect(resources.mcpServers).toHaveLength(1); expect(resources.agents).toHaveLength(1)
    expect(resources.mcpServers[0]).toMatchObject({ command: '', args: [] }); expect(resources.agents[0].description).toBe('')
    expect(JSON.stringify([installed, resources])).not.toContain('private')
    expect(db.getMcpServer(resources.mcpServers[0].id)?.environment.SERVICE_TOKEN).toBe('private-env-token')
    expect((db.db.prepare('SELECT environment FROM mcp_servers WHERE id=?').get(resources.mcpServers[0].id) as { environment: string }).environment).not.toContain('private-env-token')
    expect((await call('claudePlugin:discoverPlugins', ['fixture'])).map(plugin => plugin.name)).toEqual(['fixture-plugin'])
  })
  it('preflights source/name/transport/planned-resource grants before download or publication', async () => {
    await call('claudePlugin:fetchCatalog', [marketplaceId])
    options.canAccessPluginName = () => false
    await expect(call('claudePlugin:installPlugin', ['fixture-plugin', marketplaceId])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canAccessPluginName = () => true; options.canCreateMcpServer = () => false
    await expect(call('claudePlugin:installPlugin', ['fixture-plugin', marketplaceId])).rejects.toBeDefined()
    expect(db.getInstalledPlugins()).toEqual([]); expect(db.getSkills()).toEqual([]); expect(db.getAgents()).toEqual([]); expect(db.getMcpServers()).toEqual([])
    expect(existsSync(join(pluginsRoot, 'fixture-plugin'))).toBe(false)
    options.canUseMarketplaceSource = () => false
    await expect(call('claudePlugin:fetchCatalog', [marketplaceId])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
  it('preserves linked source/task data and refuses marketplace cascades while installed', async () => {
    const installed = await install(), resources = await call('claudePlugin:getPluginResources', [installed.id])
    const source = db.createTaskSource({ name: 'Linked source', plugin_id: 'fixture', mcp_server_id: resources.mcpServers[0].id })!
    const task = db.createTask({ title: 'Linked task', source_id: source.id, project_id: source.project_id })!
    await expect(call('claudePlugin:removeMarketplaceSource', [marketplaceId])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('claudePlugin:uninstallPlugin', [installed.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(db.getInstalledPlugin(installed.id)).toBeDefined(); expect(db.getTaskSource(source.id)).toBeDefined(); expect(db.getTask(task.id)?.source_id).toBe(source.id)
    expect(existsSync(join(pluginsRoot, 'fixture-plugin'))).toBe(true)
  })
  it('uses the actual lifecycle guard for enable/disable and refuses denied affected owner scope before Stop', async () => {
    const installed = await install(), resources = await call('claudePlugin:getPluginResources', [installed.id])
    const agent = resources.agents[0], task = db.createTask({ title: 'Owned plugin session' })!; db.updateTask(task.id, { agent_id: agent.id })
    const outcome = await agents.requestSession(agent.id, task.id)
    if (outcome.status !== 'started') throw new Error('Fixture did not start')
    options.canAccessProject = () => false
    await expect(call('claudePlugin:disablePlugin', [installed.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(agents.getSession(outcome.sessionId)).toBeDefined(); expect(adapter.destroySession).not.toHaveBeenCalled()
    options.canAccessProject = () => true
    expect((await call('claudePlugin:disablePlugin', [installed.id]))?.enabled).toBe(false)
    expect(agents.getSession(outcome.sessionId)).toBeUndefined(); expect(adapter.notifyConfigChanged).toHaveBeenCalled()
    expect((await call('claudePlugin:enablePlugin', [installed.id]))?.enabled).toBe(true)
  })
  it('preserves historical same-name namespaces without claiming shared resources or files', async () => {
    const installed = await install()
    const other = db.createMarketplaceSource({ name: 'Other fixture', source_type: 'local', source_url: marketplaceRoot })
    db.createInstalledPlugin({ name: installed.name, marketplace_id: other.id })
    await expect(call('claudePlugin:uninstallPlugin', [installed.id])).rejects.toBeDefined()
    expect(db.getInstalledPlugins()).toHaveLength(2); expect(existsSync(join(pluginsRoot, installed.name))).toBe(true)
  })
  it('keeps symlinked source data untouched and rejects escaping or replaced tree paths', async () => {
    const foreign = join(root, 'foreign.md'); writeFileSync(foreign, 'private foreign data')
    symlinkSync(foreign, join(marketplaceRoot, 'fixture-plugin', 'skills', 'foreign.md'))
    await call('claudePlugin:fetchCatalog', [marketplaceId])
    await expect(call('claudePlugin:installPlugin', ['fixture-plugin', marketplaceId])).rejects.toBeDefined()
    expect(existsSync(foreign)).toBe(true); expect(db.getInstalledPlugins()).toEqual([])
    expect(existsSync(join(pluginsRoot, 'fixture-plugin'))).toBe(false)
  })
  it('retains a cancelled raw catalog/reader flight until drain without replay or late publication', async () => {
    const pending = deferred<Response>(); releases.push(() => pending.resolve(Response.json({ name: 'late', owner: { name: 'late' }, plugins: [] })))
    const network = vi.fn<typeof fetch>(() => pending.promise); vi.stubGlobal('fetch', network)
    const remote = manager.addMarketplaceSource({ name: 'Remote fixture', source_type: 'url', source_url: 'https://fixture.invalid/catalog.json' })
    options.canUseMarketplaceSource = source => source.id === remote.id
    const controller = new AbortController(), flight = call('claudePlugin:fetchCatalog', [remote.id], controller.signal)
    await vi.waitFor(() => expect(network).toHaveBeenCalledOnce()); controller.abort()
    await expect(backend.close(20)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(db.db.open).toBe(true); expect(backend.inflightCount).toBe(1)
    const denied = expect(flight).rejects.toMatchObject({ code: 'CANCELLED' })
    pending.resolve(Response.json({ name: 'late', owner: { name: 'late' }, plugins: [] })); await denied; await backend.close()
    expect(db.getInstalledPlugins()).toEqual([]); expect(network).toHaveBeenCalledOnce()
  })
  it('rejects per-request endpoint authority before following a catalog redirect', async () => {
    const remote = manager.addMarketplaceSource({ name: 'Redirect fixture', source_type: 'url', source_url: 'https://fixture.invalid/catalog.json' })
    options.canUseMarketplaceSource = source => source.id === remote.id
    options.canUsePluginAddress = address => address === remote.source_url
    const cancel = vi.fn()
    const network = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel }), { status: 302, headers: { Location: 'https://foreign.invalid/private.json' } }))
    vi.stubGlobal('fetch', network)
    // The actual manager may return its existing null catalog after a refused
    // request; no foreign endpoint is fetched or granted by that fallback.
    expect(await call('claudePlugin:fetchCatalog', [remote.id])).toBeNull()
    expect(network).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce()
  })
  it('retains a cancelled real download body until cleanup and prevents publication/DB writes', async () => {
    const remote = manager.addMarketplaceSource({ name: 'Download fixture', source_type: 'url', source_url: 'https://fixture.invalid/catalog.json' })
    options.canUseMarketplaceSource = source => source.id === remote.id
    options.canUsePluginSource = (_source, marketplace) => marketplace.id === remote.id
    let complete!: () => void
    const body = new ReadableStream<Uint8Array>({ start(controller) { complete = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ name: 'fixture-plugin' }))); controller.close() } } })
    releases.push(() => { try { complete() } catch { /* already closed fixture reader */ } })
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ name: 'remote', owner: { name: 'Fixture' }, plugins: [{ name: 'fixture-plugin', source: { url: 'https://fixture.invalid/plugin.json' } }] })).mockResolvedValueOnce(new Response(body, { headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', network)
    await call('claudePlugin:fetchCatalog', [remote.id])
    const controller = new AbortController(), flight = call('claudePlugin:installPlugin', ['fixture-plugin', remote.id], controller.signal)
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(2)); controller.abort()
    await expect(backend.close(20)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(db.db.open).toBe(true); expect(backend.inflightCount).toBe(1)
    const denied = expect(flight).rejects.toMatchObject({ code: 'CANCELLED' })
    complete(); await denied; await backend.close()
    expect(db.getInstalledPlugins()).toEqual([]); expect(db.getSkills()).toEqual([])
    expect(existsSync(join(pluginsRoot, 'fixture-plugin'))).toBe(false)
    expect(network).toHaveBeenCalledTimes(2)
  })
  it('refuses an existing user resource namespace and preserves unowned rows/files', async () => {
    const alien = db.createAgent({ name: 'fixture-plugin:user-created', config: { system_prompt: 'private unrelated prompt' } })!
    await call('claudePlugin:fetchCatalog', [marketplaceId])
    await expect(call('claudePlugin:installPlugin', ['fixture-plugin', marketplaceId])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(db.getAgent(alien.id)).toBeDefined(); expect(existsSync(join(pluginsRoot, 'fixture-plugin'))).toBe(false)
  })

  it('rejects stale caller identities and oversized stored JSON while preserving data', async () => {
    for (const identity of [{ ...caller, engineEpoch: 'stale' }, { ...caller, webviewId: 'foreign' }]) await expect(call('claudePlugin:addMarketplaceSource', [{ name: 'Denied', source_url: 'owner/repo' }], new AbortController().signal, identity)).rejects.toBeDefined()
    db.db.prepare('UPDATE marketplace_sources SET metadata=? WHERE id=?').run('x'.repeat(128 * 1024 + 1), marketplaceId)
    await expect(call('claudePlugin:getMarketplaceSources', [])).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' })
    expect((db.db.prepare('SELECT length(metadata) AS size FROM marketplace_sources WHERE id=?').get(marketplaceId) as { size: number }).size).toBe(128 * 1024 + 1)
  })
})
