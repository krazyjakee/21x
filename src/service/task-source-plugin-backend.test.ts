import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dirname } from 'node:path'
import { rmSync } from 'node:fs'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { SyncManager, SourceMutationBusyError } from '../main/sync-manager'
import { PluginRegistry } from '../main/plugins/registry'
import type { TaskSourcePlugin, PluginContext, PluginConfigSchema, ConfigFieldOption } from '../main/plugins/types'
import { OAuthManager } from '../main/oauth/oauth-manager-core'
import { LinearProvider } from '../main/oauth/providers/linear-provider'
import { AuthenticatedSecretStorage } from '../main/platform/authenticated-secret-storage'
import { configureSecretStorage, getSecretStorage, releaseSecretStorage, type SecretStorage } from '../main/platform/secret-storage'
import { TASK_SOURCE_KEY_SET_MARKER as marker } from '../shared/task-source-codecs'
import { TASK_SOURCE_PLUGIN_CODECS, type TaskSourcePluginCodec, type TaskSourcePluginOperation } from '../shared/task-source-plugin-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import type { JsonValue } from '../shared/service-protocol'
import type { DesktopCallerContext } from './transport/desktop-registry'
import { TaskSourcePluginBackend, type TaskSourcePluginBackendOptions, type TaskSourcePluginOwners } from './task-source-plugin-backend'

/** Explicit controlled provider fixture, with actual SQLite, authenticated
 * storage, registry, OAuth and SyncManager owners. No remote API parity claim. */
class LocalResolverPlugin implements TaskSourcePlugin {
  displayName = 'Controlled provider'; description = 'Fixture documentation metadata'; icon = 'Notebook'
  constructor(readonly id = 'notion') {}
  schema: PluginConfigSchema = [
    { key: 'data_source_id', label: 'Data source', type: 'dynamic-select', optionsResolver: 'data_sources' },
    { key: 'next_statuses', label: 'Statuses', type: 'dynamic-select', optionsResolver: 'status_options' },
    { key: 'filters', label: 'Filters', type: 'key-value' }
  ]
  getConfigSchema() { return this.schema }
  getSetupDocumentation() { return '# Actual fixture setup\n\nPreserved **Markdown** and [link](https://example.test/setup).' }
  resolveOptions = vi.fn(async (_resolver: string, _config: Record<string, unknown>, _context: PluginContext): Promise<ConfigFieldOption[]> => [{ value: 'remote-id', label: 'Remote name' }])
  getActions() { return [] }
  async importTasks() { return { imported: 0, updated: 0, errors: [] } }
  async exportUpdate() { throw new Error('Fixture has no export capability') }
  async executeAction() { return { success: false, error: 'Fixture has no action capability' } }
}
let db: ReturnType<typeof createPortableTestDb>, plugins: PluginRegistry, plugin: LocalResolverPlugin, sync: SyncManager, oauth: OAuthManager
let backend: TaskSourcePluginBackend, options: TaskSourcePluginBackendOptions, storage: AuthenticatedSecretStorage, priorStorage: SecretStorage
let gates: Array<() => void>
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'plugin-epoch', webviewId: 'main', origin: 'app://plugins' }
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve }); gates.push(release)
  return { promise, release }
}
beforeEach(() => {
  gates = []
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {})
  priorStorage = getSecretStorage(); releaseSecretStorage(priorStorage)
  storage = new AuthenticatedSecretStorage(Buffer.alloc(32, 61), 'plugin-form-unit-profile'); configureSecretStorage(storage)
  db = createPortableTestDb(); plugins = new PluginRegistry(); plugin = new LocalResolverPlugin(); plugins.register(plugin)
  oauth = new OAuthManager(db, { openExternal: async () => { throw new Error('No native browser in fixture') }, notify: () => { throw new Error('No native notification in fixture') } })
  sync = new SyncManager(db, plugins, oauth)
  const owners: TaskSourcePluginOwners = { database: db, plugins, sync, oauth, secretStorage: storage }
  options = { ...owners, engineEpoch: caller.engineEpoch,
    assertAvailable() { if (!db.db.open) throw new Error('Fixture profile is closed') },
    assertOwners(actual) { for (const key of Object.keys(owners) as Array<keyof TaskSourcePluginOwners>) if (actual[key] !== owners[key]) throw new Error('Wrong plugin owner') },
    isTrustedDesktop: identity => identity.webviewId === 'main' && identity.origin === caller.origin,
    canManageConfiguration: (_identity, access) => access === 'read',
    canAccessProject: () => true, canAccessSource: () => true, canAccessMcpServer: () => true, canAccessConnector: () => true,
    canUseSourcePlugin: id => !!plugins.get(id), canBorrowSourceCredentials: () => true, canResolveUnsavedConfig: () => true }
  backend = new TaskSourcePluginBackend(options)
})
afterEach(async () => {
  for (const release of gates) release()
  await backend.close(); await sync.close(); await oauth.close()
  const root = dirname(dirname(db.getWorkspaceDir('fixture')))
  db.close(); releaseSecretStorage(storage); storage.dispose(); configureSecretStorage(priorStorage)
  rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks()
})
async function call<K extends TaskSourcePluginOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = TASK_SOURCE_PLUGIN_CODECS[operation] as TaskSourcePluginCodec<K>
  const result = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
  expect(codec.validateWireResult(result)).toBe(true)
  return codec.decodeResult((result as { value?: JsonValue }).value)
}
function source(config: Record<string, unknown> = { data_source_id: 'database-one', api_token: 'fixture-private-key' }) {
  return db.createTaskSource({ name: 'Saved source', plugin_id: plugin.id, mcp_server_id: null, config })!
}
function resolve(sourceId: string, config: Record<string, unknown> = { api_token: marker }, signal?: AbortSignal) {
  return call('plugin:resolveOptions', [plugin.id, 'data_sources', config, undefined, sourceId], signal)
}
function storedConfig(id: string): string { return (db.db.prepare('SELECT config FROM task_sources WHERE id=?').get(id) as { config: string }).config }

describe('actual production plugin form controls', () => {
  it('keeps genuine metadata/docs under independent read and current per-plugin grants', async () => {
    const other = new LocalResolverPlugin('linear'); plugins.register(other)
    expect(await call('plugin:list', [])).toEqual(plugins.list())
    expect(await call('plugin:getDocumentation', ['notion'])).toBe(plugin.getSetupDocumentation())
    options.canUseSourcePlugin = id => id === 'notion'
    expect(await call('plugin:list', [])).toEqual([plugins.list()[0]])
    await expect(call('plugin:getDocumentation', ['linear'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canManageConfiguration = () => false
    await expect(call('plugin:list', [])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(plugin.resolveOptions).not.toHaveBeenCalled()
  })

  it('borrows only the exact authorized saved secret while preserving ciphertext, cursor and source config', async () => {
    const saved = source({ data_source_id: 'database-one', api_token: '\uFEFFfixture-private-雪\nsecond-line', legacy_private: 'do not export' })
    db.updateTaskSourceLastSynced(saved.id)
    const raw = storedConfig(saved.id), checkpoint = db.getTaskSource(saved.id)?.last_synced_at
    expect(raw).not.toContain('fixture-private')
    expect(await resolve(saved.id, { api_token: marker, data_source_id: 'form-selection' })).toEqual([{ value: 'remote-id', label: 'Remote name' }])
    expect(plugin.resolveOptions).toHaveBeenCalledWith('data_sources', { data_source_id: 'form-selection', api_token: '\uFEFFfixture-private-雪\nsecond-line' }, { db, oauthManager: oauth, sourceId: saved.id })
    expect(storedConfig(saved.id)).toBe(raw); expect(db.getTaskSource(saved.id)?.last_synced_at).toBe(checkpoint)
    expect(db.getTaskSource(saved.id)?.config.data_source_id).toBe('database-one')
  })

  it('refuses missing/wrong-source markers and credential loans before actual getter materialization', async () => {
    const saved = source(), read = vi.spyOn(db, 'getTaskSource')
    options.canBorrowSourceCredentials = () => false
    await expect(resolve(saved.id)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(read).not.toHaveBeenCalled()
    options.canBorrowSourceCredentials = () => true
    options.canAccessProject = () => false
    await expect(resolve(saved.id)).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(read).not.toHaveBeenCalled()
    options.canAccessProject = () => true
    await expect(resolve('missing-source')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    db.db.prepare('UPDATE task_sources SET plugin_id=? WHERE id=?').run('linear', saved.id)
    await expect(resolve(saved.id)).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(read).not.toHaveBeenCalled()
    db.db.prepare('UPDATE task_sources SET plugin_id=?,config=? WHERE id=?').run('notion', JSON.stringify({ api_token: 7 }), saved.id)
    await expect(resolve(saved.id)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    db.db.prepare('UPDATE task_sources SET config=? WHERE id=?').run(JSON.stringify({ api_token: '' }), saved.id)
    await expect(resolve(saved.id)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(plugin.resolveOptions).not.toHaveBeenCalled()
  })

  it('requires a separate unsaved-form grant and actual schema resolver declaration', async () => {
    options.canResolveUnsavedConfig = () => false
    await expect(call('plugin:resolveOptions', ['notion', 'data_sources', { api_token: 'unsaved-key' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canResolveUnsavedConfig = () => true
    await expect(call('plugin:resolveOptions', ['notion', 'data_sources', { api_token: marker }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await call('plugin:resolveOptions', ['notion', 'data_sources', { api_token: 'unsaved-key' }])).toHaveLength(1)
    expect(plugin.resolveOptions.mock.calls[0][1]).toEqual({ api_token: 'unsaved-key' })
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM task_sources').get()).toEqual({ n: 0 })
    plugin.schema = []
    await expect(call('plugin:resolveOptions', ['notion', 'data_sources', {}])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    plugin.schema = [{ key: 'filters', label: 'Filters', type: 'key-value' }]
    const property = JSON.stringify({ name: 'Status', type: 'status', options: [] })
    plugin.resolveOptions.mockResolvedValueOnce([{ value: property, label: 'Status' }])
    expect(await call('plugin:resolveOptions', ['notion', 'data_source_properties', {}])).toEqual([{ value: property, label: 'Status' }])
  })

  it('requires actual MCP existence, scope and the saved source reference', async () => {
    const saved = source(), server = db.createMcpServer({ name: 'Source MCP', type: 'local', command: 'node' })!
    const other = db.createMcpServer({ name: 'Foreign MCP', type: 'local', command: 'node' })!
    db.updateTaskSource(saved.id, { mcp_server_id: server.id })
    await expect(call('plugin:resolveOptions', ['notion', 'data_sources', {}, 'missing-mcp', saved.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('plugin:resolveOptions', ['notion', 'data_sources', {}, other.id, saved.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canAccessMcpServer = () => false
    await expect(resolve(saved.id)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canAccessMcpServer = id => id === server.id
    expect(await call('plugin:resolveOptions', ['notion', 'data_sources', {}, server.id, saved.id])).toHaveLength(1)
    expect(plugin.resolveOptions).toHaveBeenCalledOnce()
  })

  it('holds the actual source lane through raw resolution and fences mutations before another resolver starts', async () => {
    const saved = source(), hold = gate(), entered = gate()
    plugin.resolveOptions.mockImplementationOnce(async () => { entered.release(); await hold.promise; return [{ value: 'before-change', label: 'Before change' }] })
    const active = resolve(saved.id); await entered.promise
    const admitted = gate(), mutation = sync.runSourceMutation(saved.id, () => { admitted.release(); db.updateTaskSource(saved.id, { config: { data_source_id: 'database-two' } }) })
    await expect(sync.runSourceWork(saved.id, async () => [])).rejects.toBeInstanceOf(SourceMutationBusyError)
    expect(db.getTaskSource(saved.id)?.config.data_source_id).toBe('database-one')
    hold.release()
    // Completion either exports the original authorized result before the
    // mutation, or refuses it if the mutation wins the post-lane recheck.
    const result = await Promise.allSettled([active, mutation]); await admitted.promise
    if (result[0].status === 'fulfilled') expect(result[0].value).toEqual([{ value: 'before-change', label: 'Before change' }])
    else expect(result[0].reason).toMatchObject({ code: 'INVALID_REQUEST' })
    expect(db.getTaskSource(saved.id)?.config.data_source_id).toBe('database-two'); expect(plugin.resolveOptions).toHaveBeenCalledOnce()
  })

  it('retains ignored cancellation and timed-out shutdown until the real owner drains, without replay', async () => {
    const saved = source(), hold = gate(), entered = gate(), controller = new AbortController()
    plugin.resolveOptions.mockImplementationOnce(async () => { entered.release(); await hold.promise; return [{ value: 'remote-id', label: 'Remote name' }] })
    const active = resolve(saved.id, {}, controller.signal); await entered.promise; controller.abort()
    await expect(backend.close(10)).rejects.toMatchObject({ code: 'TIMEOUT' })
    await expect(sync.close(10)).rejects.toThrow('not finished')
    expect(backend.inflightCount).toBe(1); expect(db.db.open).toBe(true); expect(storage.isEncryptionAvailable()).toBe(true)
    hold.release(); await expect(active).rejects.toMatchObject({ code: 'CANCELLED' }); await backend.close(); await sync.close()
    expect(plugin.resolveOptions).toHaveBeenCalledOnce(); expect(db.getTaskSource(saved.id)?.last_synced_at).toBeNull()
  })

  it.each(['config', 'enabled', 'project', 'grant'] as const)('suppresses late options after saved %s context changes', async kind => {
    const saved = source(), hold = gate(), entered = gate()
    plugin.resolveOptions.mockImplementationOnce(async () => { entered.release(); await hold.promise; return [{ value: 'old-context', label: 'Old context' }] })
    const active = resolve(saved.id); await entered.promise
    if (kind === 'config') db.updateTaskSource(saved.id, { config: { data_source_id: 'replacement' } })
    if (kind === 'enabled') db.updateTaskSource(saved.id, { enabled: false })
    if (kind === 'project') db.db.prepare('UPDATE task_sources SET project_id=? WHERE id=?').run(db.createProject({ name: 'Replacement project' })!.id, saved.id)
    if (kind === 'grant') options.canBorrowSourceCredentials = () => false
    hold.release(); await expect(active).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(plugin.resolveOptions).toHaveBeenCalledOnce()
  })

  it('freezes caller config before async ownership and allows normal sync timestamp refresh', async () => {
    const saved = source(), hold = gate(), entered = gate()
    const config = { api_token: marker, data_source_id: 'original-form' }
    plugin.resolveOptions.mockImplementationOnce(async () => { entered.release(); await hold.promise; return [{ value: 'remote-id', label: 'Remote name' }] })
    const active = resolve(saved.id, config); config.data_source_id = 'mutated-caller'
    await entered.promise; db.updateTaskSourceLastSynced(saved.id); hold.release()
    expect(await active).toHaveLength(1); expect(plugin.resolveOptions.mock.calls[0][1].data_source_id).toBe('original-form')
  })

  it('bounds legacy stored bytes before getters and refuses private or oversized options', async () => {
    const saved = source(), huge = JSON.stringify({ legacy_private: 'x'.repeat(600_000) })
    db.db.prepare('UPDATE task_sources SET config=? WHERE id=?').run(huge, saved.id)
    const read = vi.spyOn(db, 'getTaskSource')
    await expect(resolve(saved.id, {})).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(read).not.toHaveBeenCalled(); expect(storedConfig(saved.id)).toBe(huge)
    for (const result of [[{ value: 'remote-id', label: 'Label', api_token: 'private' }], [{ value: 'x'.repeat(65537), label: 'Label' }]]) {
      plugin.resolveOptions.mockResolvedValueOnce(result)
      await expect(call('plugin:resolveOptions', ['notion', 'data_sources', {}])).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    }
  })

  it('redacts reflected known credentials in labels, rejects secret IDs and fixes raw provider errors', async () => {
    const saved = source(), key = 'fixture-private-key'
    plugin.resolveOptions.mockResolvedValueOnce([{ value: 'remote-id', label: `${key} ${Buffer.from(key).toString('base64')}` }])
    expect(await resolve(saved.id)).toEqual([{ value: 'remote-id', label: '[REDACTED] [REDACTED]' }])
    plugin.resolveOptions.mockResolvedValueOnce([{ value: `id-${key}`, label: 'Label' }])
    await expect(resolve(saved.id)).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    plugin.resolveOptions.mockRejectedValueOnce(new Error(`Private server reflected ${key}`))
    await expect(resolve(saved.id)).rejects.toMatchObject({ code: 'INTERNAL_ERROR', message: 'The operation failed.' })
    expect(plugin.resolveOptions).toHaveBeenCalledTimes(3)
  })

  it('retains real OAuth refresh persistence and redacts both prior and rotated provider tokens', async () => {
    const linear = new LocalResolverPlugin('linear')
    linear.schema = [{ key: 'assignee_ids', label: 'Users', type: 'dynamic-select', optionsResolver: 'users' }]; plugins.register(linear)
    const saved = db.createTaskSource({ name: 'OAuth source', plugin_id: 'linear', mcp_server_id: null, config: { client_id: 'fixture-client', client_secret: 'fixture-client-secret' } })!
    db.createOAuthToken({ provider: 'linear', source_id: saved.id, access_token: 'prior-access-token', refresh_token: 'prior-refresh-token', expires_in: -1, scope: null })
    const raw = storedConfig(saved.id)
    const refresh = vi.spyOn(LinearProvider.prototype, 'refreshToken').mockResolvedValue({ access_token: 'rotated-access-token', refresh_token: 'rotated-refresh-token', expires_in: 3600, token_type: 'Bearer' })
    linear.resolveOptions.mockImplementationOnce(async (_key, _config, context) => {
      const token = await context.oauthManager!.getValidToken(context.sourceId!)
      return [{ value: 'remote-user', label: `${token} prior-access-token prior-refresh-token rotated-refresh-token` }]
    })
    expect(await call('plugin:resolveOptions', ['linear', 'users', { client_secret: marker }, undefined, saved.id])).toEqual([{ value: 'remote-user', label: '[REDACTED] [REDACTED] [REDACTED] [REDACTED]' }])
    expect(refresh).toHaveBeenCalledWith('prior-refresh-token', 'fixture-client', 'fixture-client-secret')
    expect(refresh).toHaveBeenCalledOnce(); expect(db.getOAuthTokenBySource(saved.id)?.access_token).toBe('rotated-access-token'); expect(storedConfig(saved.id)).toBe(raw)
  })

  it('rejects pre-cancelled, foreign, stale and mismatched actual owners before provider work', async () => {
    const saved = source(), controller = new AbortController(); controller.abort()
    await expect(resolve(saved.id, {}, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(call('plugin:resolveOptions', ['notion', 'data_sources', {}, undefined, saved.id], undefined, { ...caller, engineEpoch: 'stale' })).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    await expect(call('plugin:list', [], undefined, { ...caller, origin: 'foreign://plugins' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(() => new TaskSourcePluginBackend({ ...options, plugins: new PluginRegistry() })).toThrow('owner')
    expect(plugin.resolveOptions).not.toHaveBeenCalled()
  })
})
