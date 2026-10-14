import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dirname } from 'node:path'
import { rmSync } from 'node:fs'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { getConnectorRuntime, closeConnectorRuntime, type ConnectorRuntime, type ConnectorRuntimeHost } from '../main/connectors/bridge/runtime-core'
import { ConnectorBridgeService } from '../main/connectors/bridge/service'
import { ConnectorBridgeCore } from '../main/plugins/connector-bridge-core'
import { PluginRegistry } from '../main/plugins/registry'
import { SyncManager } from '../main/sync-manager'
import { AuthenticatedSecretStorage } from '../main/platform/authenticated-secret-storage'
import { configureSecretStorage, getSecretStorage, releaseSecretStorage, type SecretStorage } from '../main/platform/secret-storage'
import { ConnectorBackend, type ConnectorBackendOptions, type ConnectorOwners } from './connector-backend'
import { CONNECTOR_CODECS, CONNECTOR_OPERATIONS, CONNECTOR_SYNC_ERROR, CONNECTOR_WRITE_ERROR, type ConnectorCodec, type ConnectorOperation } from '../shared/connector-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import type { DesktopCallerContext } from './transport/desktop-registry'
import type { JsonValue } from '../shared/service-protocol'
const TRELLO = '@activepieces/piece-trello', TODOIST = '@activepieces/piece-todoist'
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'connector-epoch', webviewId: 'main', origin: 'app://connectors' }
let db: ReturnType<typeof createPortableTestDb>, runtime: ConnectorRuntime, service: ConnectorBridgeService, bridge: ConnectorBridgeCore, sync: SyncManager, backend: ConnectorBackend, options: ConnectorBackendOptions
let storage: AuthenticatedSecretStorage, prior: SecretStorage, root: string, host: ConnectorRuntimeHost
let browser: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>
let releases: Array<() => void>
const realFetch = globalThis.fetch
beforeEach(() => {
  db = createPortableTestDb(); root = dirname(dirname(db.getWorkspaceDir('fixture')))
  prior = getSecretStorage(); releaseSecretStorage(prior)
  storage = new AuthenticatedSecretStorage(Buffer.alloc(32, 83), 'connector-profile-fixture'); configureSecretStorage(storage)
  releases = []
  browser = vi.fn(async () => { throw new Error('Browser capability is not exercised implicitly') })
  host = { openExternal: url => browser(url), createTransport: () => { throw new Error('Form controls must not start a worker') } }
  runtime = getConnectorRuntime(db, host)
  service = new ConnectorBridgeService(() => getConnectorRuntime(db, host))
  bridge = new ConnectorBridgeCore({ runtime: () => getConnectorRuntime(db, host) })
  const plugins = new PluginRegistry(); plugins.register(bridge); sync = new SyncManager(db, plugins)
  const owners: ConnectorOwners = { database: db, sync, service, runtime, engine: bridge.engineFor(db), credentialStore: runtime.credentialStore, secretStorage: storage }
  options = { ...owners, engineEpoch: caller.engineEpoch, oauthBrowser: 'unavailable',
    assertAvailable() { if (!db.db.open || getConnectorRuntime(db, host) !== runtime) throw new Error('Closed owner') },
    assertConnectorOwners(actual) { for (const key of Object.keys(owners) as Array<keyof ConnectorOwners>) if (actual[key] !== owners[key]) throw new Error('Wrong owner'); bridge.assertSourceLifecycle(sync) },
    isTrustedDesktop: value => value.webviewId === caller.webviewId && value.origin === caller.origin,
    canManageConfiguration: () => true, canCreateInstance: () => true, canUsePiece: () => true, canAccessInstance: () => true, canAccessSource: () => true, canAccessTask: () => true, canAccessProject: () => true }
  backend = new ConnectorBackend(options)
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  for (const release of releases) release()
  await Promise.all([backend.close(), sync.close(), bridge.close(), closeConnectorRuntime(db)])
  db.close(); releaseSecretStorage(storage); storage.dispose(); configureSecretStorage(prior); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function call<K extends ConnectorOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = CONNECTOR_CODECS[operation] as ConnectorCodec<K>
  const encoded = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
  expect(codec.validateWireResult(encoded)).toBe(true)
  return codec.decodeResult((encoded as { defined: boolean; value?: JsonValue }).value)
}
async function instance(piece = TRELLO) { return (await call('connectors:ensureInstance', [piece])).instanceId }
function source(id: string, piece = TRELLO) { return db.createTaskSource({ name: 'Linked connector source', plugin_id: 'connector-bridge', mcp_server_id: null, config: { piece_name: piece, connector_instance_id: id, props: { board_id: 'synthetic-board' } } })! }
async function installCallbackBrowser(): Promise<void> {
  browser.mockImplementation(async authUrl => {
    const auth = new URL(authUrl)
    expect(auth.origin).toBe('https://todoist.com')
    expect(auth.searchParams.get('scope')).toBe('data:read_write')
    const redirect = new URL(auth.searchParams.get('redirect_uri')!)
    expect(['localhost', '127.0.0.1']).toContain(redirect.hostname)
    redirect.searchParams.set('code', 'synthetic-code'); redirect.searchParams.set('state', auth.searchParams.get('state')!)
    const reply = await realFetch(redirect, { redirect: 'error' }); await reply.body?.cancel()
  })
}
describe('production connector actual-owner controls', () => {
  it('binds seven exact controls and refuses missing/wrong/foreign existing IDs without replacements', async () => {
    expect(Object.keys(backend.operationSchemas(caller))).toEqual([...CONNECTOR_OPERATIONS])
    const pieces = await call('connectors:bridgePieces', [])
    expect(pieces.map(piece => piece.pieceName)).toEqual([TRELLO, TODOIST])
    expect(pieces[1].authLabels).toEqual({ clientId: 'Client ID', clientSecret: 'Client secret' })
    expect(JSON.stringify(pieces)).not.toContain('tokenUrl')
    const id = await instance()
    await expect(call('connectors:ensureInstance', [TRELLO, 'missing-id'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('connectors:ensureInstance', [TODOIST, id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canAccessInstance = () => false
    await expect(call('connectors:ensureInstance', [TRELLO, id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(runtime.store.listInstances()).toHaveLength(1); expect(runtime.client.starts).toBe(0); expect(browser).not.toHaveBeenCalled()
  })
  it('stores actual encrypted persistent credentials, session-only credentials and exact clear with no exports', async () => {
    const id = await instance()
    expect(await call('connectors:setCredentials', [id, { username: 'synthetic-key', password: 'private-token' }])).toEqual({ ok: true, storage: 'persistent' })
    const ciphertext = runtime.store.getAuthBlob(id)!.auth!
    expect(ciphertext.toString()).not.toContain('private-token')
    expect(runtime.credentialStore.get(id)).toEqual({ type: 'basic', username: 'synthetic-key', password: 'private-token' })
    expect(await call('connectors:credentialStatus', [id])).toEqual({ storage: 'persistent', persistentAvailable: true })
    await call('connectors:setCredentials', [id, { username: 'synthetic-key', password: 'private-session-token' }, 'session'])
    expect(runtime.store.getAuthBlob(id)?.auth).toBeNull()
    expect(runtime.credentialStore.get(id)).toMatchObject({ password: 'private-session-token' })
    expect(JSON.stringify(await call('connectors:credentialStatus', [id]))).not.toContain('private')
    await call('connectors:clearCredentials', [id]); expect(runtime.credentialStore.get(id)).toBeNull()
  })
  it('keeps unavailable persistent storage honest and never falls back without explicit session intent', async () => {
    const id = await instance(); vi.spyOn(storage, 'isEncryptionAvailable').mockReturnValue(false)
    expect(await call('connectors:credentialStatus', [id])).toEqual({ storage: null, persistentAvailable: false })
    expect(await call('connectors:setCredentials', [id, { username: 'synthetic', password: 'private' }])).toMatchObject({ ok: false, error: CONNECTOR_WRITE_ERROR, sessionOnlyAvailable: true })
    expect(runtime.credentialStore.getStorage(id)).toBeNull()
    expect(await call('connectors:setCredentials', [id, { username: 'synthetic', password: 'private' }, 'session'])).toEqual({ ok: true, storage: 'session' })
  })
  it('preflights instance and every source/task/project grant before modifying credentials', async () => {
    const id = await instance(), linked = source(id), task = db.createTask({ title: 'Linked task', source_id: linked.id, project_id: linked.project_id })!
    runtime.credentialStore.set(id, { type: 'basic', username: 'synthetic', password: 'original-private' }, 'session')
    for (const denied of ['canAccessSource', 'canAccessTask', 'canAccessProject'] as const) {
      options[denied] = () => false
      await expect(call('connectors:clearCredentials', [id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      await expect(call('connectors:credentialStatus', [id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(runtime.credentialStore.get(id)).toMatchObject({ password: 'original-private' })
      options[denied] = () => true
    }
    expect(db.getTask(task.id)?.source_id).toBe(linked.id)
    for (const identity of [{ ...caller, engineEpoch: 'stale' }, { ...caller, origin: 'https://foreign' }]) await expect(call('connectors:clearCredentials', [id], new AbortController().signal, identity)).rejects.toBeDefined()
  })
  it('drains actual accepted sync and snapshots credential input before asynchronous joins', async () => {
    const id = await instance(), linked = source(id), pending = deferred<void>(), entered = deferred<void>()
    releases.push(() => pending.resolve())
    const syncWork = sync.runSourceWork(linked.id, async () => { entered.resolve(); await pending.promise }); await entered.promise
    const input = { username: 'original-key', password: 'original-private' }
    const setting = call('connectors:setCredentials', [id, input, 'session'])
    await vi.waitFor(() => expect(backend.inflightCount).toBe(1))
    input.password = 'mutated-after-admission'
    expect(runtime.credentialStore.get(id)).toBeNull()
    pending.resolve(); await syncWork; await setting
    expect(runtime.credentialStore.get(id)).toEqual({ type: 'basic', username: 'original-key', password: 'original-private' })
  })
  it('rejects late source config/task bindings after drain without storing new credentials', async () => {
    const id = await instance(), linked = source(id), pending = deferred<void>(), entered = deferred<void>()
    releases.push(() => pending.resolve())
    const syncWork = sync.runSourceWork(linked.id, async () => { entered.resolve(); await pending.promise }); await entered.promise
    const setting = call('connectors:setCredentials', [id, { username: 'key', password: 'must-not-save' }, 'session'])
    await vi.waitFor(() => expect(backend.inflightCount).toBe(1))
    db.updateTaskSource(linked.id, { config: { ...linked.config, props: { board_id: 'different-board' } } })
    const denied = expect(setting).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    pending.resolve(); await syncWork; await denied
    expect(runtime.credentialStore.get(id)).toBeNull()
  })
  it('refuses direct runtime work after public cancellation until the exact raw credential read settles', async () => {
    const id = await instance(), pending = deferred<null>()
    releases.push(() => pending.resolve(null))
    const reading = vi.spyOn(runtime.credentials, 'get').mockReturnValue(pending.promise)
    const controller = new AbortController()
    const direct = runtime.client.runAction({ instanceId: id, pieceName: TRELLO, pieceVersion: '0.6.0', actionName: 'get_board', signal: controller.signal })
    await vi.waitFor(() => expect(reading).toHaveBeenCalledOnce())
    const cancelled = expect(direct).rejects.toBeDefined(); controller.abort(); await cancelled
    await expect(call('connectors:setCredentials', [id, { username: 'key', password: 'private' }, 'session'])).rejects.toMatchObject({ code: 'BACKPRESSURE' })
    expect(runtime.credentialStore.get(id)).toBeNull(); expect(runtime.client.starts).toBe(0)
    pending.resolve(null)
    await vi.waitFor(async () => { expect(await call('connectors:setCredentials', [id, { username: 'key', password: 'private' }, 'session'])).toEqual({ ok: true, storage: 'session' }) })
  })
  it('rejects browser OAuth before navigation and projects real sync status without diagnostic secrets', async () => {
    const id = await instance(TODOIST), connect = vi.spyOn(service, 'oauthConnect')
    await expect(call('connectors:oauthConnect', [id, { clientId: 'synthetic', clientSecret: 'private' }, 'session'])).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(browser).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled()
    runtime.store.updateSyncState(id, { cursor: { secret: 'private-cursor' }, lastError: 'private-provider-error', lastSyncedAt: 100, attemptCount: 2, nextRetryAt: 200 })
    runtime.store.addDeadLetter(id, { payload: { secret: 'private-payload' }, error: 'private-provider-error' })
    expect(await call('connectors:syncStatus', [id])).toEqual({ lastError: CONNECTOR_SYNC_ERROR, lastSyncedAt: 100, attemptCount: 2, nextRetryAt: 200, deadLetterCount: 1 })
  })
  it('uses actual OAuth owner and controlled loopback callback/token endpoint to save then clear session tokens', async () => {
    const id = await instance(TODOIST); options.oauthBrowser = 'available'; await installCallbackBrowser()
    const network = vi.fn<typeof fetch>(async url => { expect(String(url)).toBe('https://todoist.com/oauth/access_token'); return Response.json({ access_token: 'private-access', token_type: 'Bearer' }) })
    vi.stubGlobal('fetch', network)
    expect(await call('connectors:oauthConnect', [id, { clientId: 'synthetic-client', clientSecret: 'private-client-secret' }, 'session'])).toEqual({ ok: true, storage: 'session' })
    expect(await call('connectors:credentialStatus', [id])).toEqual({ storage: 'session', persistentAvailable: true, oauth: { state: 'connected', expiresAt: null } })
    expect(runtime.credentialStore.get(id)).toMatchObject({ type: 'oauth2', accessToken: 'private-access' })
    await call('connectors:clearCredentials', [id]); expect(runtime.credentialStore.get(id)).toBeNull()
    expect(network).toHaveBeenCalledOnce(); expect(runtime.client.starts).toBe(0)
  })
  it('retains raw OAuth after caller cancellation and refuses the late credential write', async () => {
    const id = await instance(TODOIST); options.oauthBrowser = 'available'; await installCallbackBrowser()
    const pending = deferred<Response>(); releases.push(() => pending.resolve(Response.json({ access_token: 'private-late' })))
    const network = vi.fn<typeof fetch>(() => pending.promise); vi.stubGlobal('fetch', network)
    const controller = new AbortController(), connecting = call('connectors:oauthConnect', [id, { clientId: 'synthetic-client', clientSecret: 'private-client' }, 'session'], controller.signal)
    await vi.waitFor(() => expect(network).toHaveBeenCalledOnce()); controller.abort()
    await expect(backend.close(20)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(db.db.open).toBe(true); expect(storage.isEncryptionAvailable()).toBe(true); expect(backend.inflightCount).toBe(1)
    const denied = expect(connecting).rejects.toMatchObject({ code: 'CANCELLED' })
    pending.resolve(Response.json({ access_token: 'private-late' })); await denied; await backend.close()
    expect(runtime.credentialStore.get(id)).toBeNull()
  })
  it('rechecks reference/grant changes immediately before an accepted OAuth token would persist', async () => {
    const id = await instance(TODOIST), linked = source(id, TODOIST); options.oauthBrowser = 'available'; await installCallbackBrowser()
    const pending = deferred<Response>(); releases.push(() => pending.resolve(Response.json({ access_token: 'private-late' })))
    const network = vi.fn<typeof fetch>(() => pending.promise); vi.stubGlobal('fetch', network)
    const connecting = call('connectors:oauthConnect', [id, { clientId: 'synthetic-client', clientSecret: 'private-client' }, 'session'])
    await vi.waitFor(() => expect(network).toHaveBeenCalledOnce())
    db.updateTaskSource(linked.id, { config: { ...linked.config, props: { filter_query: 'different-scope' } } })
    pending.resolve(Response.json({ access_token: 'private-late' }))
    expect(await connecting).toEqual({ ok: false, error: CONNECTOR_WRITE_ERROR })
    expect(runtime.credentialStore.get(id)).toBeNull()
  })
  it('bounds persisted preparse data and refuses replaced credential owners without overwriting data', async () => {
    const id = await instance()
    db.db.prepare('UPDATE connector_instances SET config=? WHERE id=?').run('x'.repeat(128 * 1024 + 1), id)
    await expect(call('connectors:credentialStatus', [id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect((db.db.prepare('SELECT length(config) AS size FROM connector_instances WHERE id=?').get(id) as { size: number }).size).toBe(128 * 1024 + 1)
    db.db.prepare('UPDATE connector_instances SET config=? WHERE id=?').run('{}', id)
    const alien = new AuthenticatedSecretStorage(Buffer.alloc(32, 9), 'alien-profile')
    expect(() => new ConnectorBackend({ ...options, secretStorage: alien })).toThrow('owner'); alien.dispose()
    const controller = new AbortController(); controller.abort()
    await expect(call('connectors:clearCredentials', [id], controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
  })
})
