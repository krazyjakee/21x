import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { rmSync } from 'node:fs'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { getConnectorRuntime, closeConnectorRuntime, type ConnectorRuntime } from '../main/connectors/bridge/runtime-core'
import { ConnectorBridgeService } from '../main/connectors/bridge/service'
import { ConnectorBridgeCore } from '../main/plugins/connector-bridge-core'
import { PluginRegistry } from '../main/plugins/registry'
import { SyncManager } from '../main/sync-manager'
import { AuthenticatedSecretStorage } from '../main/platform/authenticated-secret-storage'
import { configureSecretStorage, getSecretStorage, releaseSecretStorage, type SecretStorage } from '../main/platform/secret-storage'
import { ConnectorBackend, type ConnectorBackendOptions } from './connector-backend'
import { ConnectorOAuthShutdownIncompleteError } from '../main/connectors/oauth'
import { ConnectorCredentialMutationBusyError } from '../main/connectors/credential-admission'
import { CONNECTOR_CODECS, CONNECTOR_WRITE_ERROR } from '../shared/connector-codecs'
import type { NativeOAuthBridge, NativeOAuthRegistration } from '../shared/oauth-native-callbacks'
import type { DesktopCallerContext } from './transport/desktop-registry'
import { OAuthFlowOwner } from './oauth-flow-owner'
import { runLoopbackOAuthFlow } from '../main/oauth/connector-oauth-flow'
import type { OAuthProvider } from '../main/oauth/oauth-provider'

const TODOIST = '@activepieces/piece-todoist', realFetch = globalThis.fetch
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'native-connector-epoch', webviewId: 'main', origin: 'app://synthetic-connectors' }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let db: ReturnType<typeof createPortableTestDb>, runtime: ConnectorRuntime, bridge: ConnectorBridgeCore, sync: SyncManager, backend: ConnectorBackend
let options: ConnectorBackendOptions, flows: OAuthFlowOwner, registration: NativeOAuthRegistration | undefined
let storage: AuthenticatedSecretStorage, prior: SecretStorage, root: string, id: string
let native: { register: ReturnType<typeof vi.fn<NativeOAuthBridge['register']>>; open: ReturnType<typeof vi.fn<NativeOAuthBridge['open']>>; retire: ReturnType<typeof vi.fn<NativeOAuthBridge['retire']>> }
let tokenFetch: ReturnType<typeof vi.fn<typeof fetch>>, unownedBrowser: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>, parentClose: ReturnType<typeof vi.spyOn>
let afterRegistration: Promise<void> | undefined, afterOpening: Promise<void> | undefined, afterRetirement: Promise<void> | undefined, refuseRetire: boolean
let finishers: Array<() => void>
beforeEach(() => {
  db = createPortableTestDb(); root = dirname(dirname(db.getWorkspaceDir('fixture')))
  prior = getSecretStorage(); releaseSecretStorage(prior)
  storage = new AuthenticatedSecretStorage(Buffer.alloc(32, 43), 'native-connector-synthetic'); configureSecretStorage(storage)
  finishers = []; registration = undefined; afterRegistration = undefined; afterOpening = undefined; afterRetirement = undefined; refuseRetire = false
  native = {
    register: vi.fn<NativeOAuthBridge['register']>(async input => { registration = input; await afterRegistration; return { flowId: input.flowId, registered: true } }),
    open: vi.fn<NativeOAuthBridge['open']>(async input => {
      if (!registration || input.flowId !== registration.flowId) throw new Error('Synthetic native owner mismatch')
      const auth = new URL(registration.authorizationUrl), callback = new URL(registration.redirectUri)
      expect(registration.kind).toBe('loopback')
      expect(registration.stateSha256).toBe(createHash('sha256').update(auth.searchParams.get('state')!).digest('hex'))
      expect(registration.redirectUri).toMatch(/^http:\/\/localhost:30(?:0[0-9]|10)\/callback$/)
      // Custom-scheme delivery cannot redeem a loopback registration.
      expect(flows.deliver({ flowId: input.flowId, kind: 'custom-scheme', redirectUri: 'twentyonex://oauth/callback', state: auth.searchParams.get('state'), outcome: { status: 'code', code: 'synthetic-foreign-code' } })).toEqual({ accepted: false })
      callback.searchParams.set('state', auth.searchParams.get('state')!); callback.searchParams.set('code', 'synthetic-loopback-code')
      const reply = await realFetch(callback, { redirect: 'error' }); await reply.body?.cancel()
      await afterOpening
      return { flowId: input.flowId, opened: true }
    }),
    retire: vi.fn<NativeOAuthBridge['retire']>(async input => { await afterRetirement; if (refuseRetire) throw new Error('Synthetic native retirement refusal'); return { flowId: input.flowId, retired: true } })
  }
  flows = new OAuthFlowOwner(native, () => {})
  parentClose = vi.spyOn(flows, 'close')
  unownedBrowser = vi.fn<(url: string) => Promise<void>>(async () => { throw new Error('Unowned browser must not open') })
  const host = { openExternal: unownedBrowser, nativeFlows: flows, createTransport: () => { throw new Error('No worker needed for OAuth controls') } }
  runtime = getConnectorRuntime(db, host)
  const service = new ConnectorBridgeService(() => getConnectorRuntime(db, host))
  bridge = new ConnectorBridgeCore({ runtime: () => getConnectorRuntime(db, host) })
  const plugins = new PluginRegistry(); plugins.register(bridge); sync = new SyncManager(db, plugins)
  const owners = { database: db, sync, service, runtime, engine: bridge.engineFor(db), credentialStore: runtime.credentialStore, secretStorage: storage }
  options = { ...owners, engineEpoch: caller.engineEpoch, oauthBrowser: 'available',
    assertAvailable() { if (!db.db.open) throw new Error('Closed synthetic owner') },
    assertConnectorOwners(actual) { for (const key of Object.keys(owners) as Array<keyof typeof owners>) if (actual[key] !== owners[key]) throw new Error('Foreign owner'); bridge.assertSourceLifecycle(sync) },
    isTrustedDesktop: value => value.origin === caller.origin && value.webviewId === caller.webviewId,
    canManageConfiguration: () => true, canCreateInstance: () => true, canUsePiece: () => true, canAccessInstance: () => true,
    canAccessSource: () => true, canAccessTask: () => true, canAccessProject: () => true }
  backend = new ConnectorBackend(options)
  id = service.ensureInstance(TODOIST).instanceId
  tokenFetch = vi.fn<typeof fetch>(async url => {
    expect(String(url)).toBe('https://todoist.com/oauth/access_token')
    return Response.json({ access_token: 'synthetic-private-access', refresh_token: 'synthetic-private-refresh', expires_in: 3600 })
  })
  vi.stubGlobal('fetch', tokenFetch)
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  refuseRetire = false; for (const finish of finishers) finish()
  await Promise.all([backend.close(), sync.close(), bridge.close(), closeConnectorRuntime(db), flows.close()])
  db.close(); releaseSecretStorage(storage); storage.dispose(); configureSecretStorage(prior)
  rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function connect(storage: 'persistent' | 'session' = 'session', signal = new AbortController().signal) {
  const codec = CONNECTOR_CODECS['connectors:oauthConnect']
  const result = await backend.registry.invoke('connectors:oauthConnect', codec.encodeArguments([id, { clientId: 'synthetic-client', clientSecret: 'synthetic-private-client' }, storage]), caller, signal)
  expect(codec.validateWireResult(result)).toBe(true)
  return codec.decodeResult((result as { value: import('../shared/service-protocol').JsonValue }).value)
}
function source() { return db.createTaskSource({ name: 'Synthetic native connector source', plugin_id: 'connector-bridge', mcp_server_id: null, config: { piece_name: TODOIST, connector_instance_id: id, props: { filter_query: 'synthetic' } } })! }

describe('connector consumption of sealed native loopback authority', () => {
  it('keeps PKCE verifier, provider configuration and token redemption inside the source-owned flow', async () => {
    let privateVerifier: string | undefined
    const provider: OAuthProvider = { id: 'synthetic-pkce', requiresLocalhost: true,
      generateAuthUrl: (_config, state, challenge, redirectUri) => {
        const url = new URL('https://synthetic.invalid/authorize')
        for (const [key, value] of Object.entries({ state, code_challenge: challenge, redirect_uri: redirectUri! })) url.searchParams.set(key, value)
        return url.href
      }, exchangeCode: async (code, verifier, config, redirectUri) => {
        privateVerifier = verifier
        expect(code).toBe('synthetic-loopback-code'); expect(config.client_secret).toBe('synthetic-private-registration')
        expect(redirectUri).toBe(registration!.redirectUri)
        expect(createHash('sha256').update(verifier).digest('base64url')).toBe(new URL(registration!.authorizationUrl).searchParams.get('code_challenge'))
        return { access_token: 'synthetic-private-result', expires_in: 3600 }
      }, refreshToken: async () => { throw new Error('No refresh expected') } }
    expect((await runLoopbackOAuthFlow({ provider, config: { client_id: 'synthetic-client', client_secret: 'synthetic-private-registration' }, nativeFlows: flows, openExternal: unownedBrowser })).token.access_token).toBe('synthetic-private-result')
    expect(JSON.stringify(registration)).not.toContain(privateVerifier!)
    expect(JSON.stringify(registration)).not.toContain('synthetic-private-registration')
    expect(native.retire).toHaveBeenCalledOnce(); expect(parentClose).not.toHaveBeenCalled()
  })
  it.each(['session', 'persistent'] as const)('joins native registration/open/retire and writes only the captured %s credential intent', async selected => {
    expect(await connect(selected)).toEqual({ ok: true, storage: selected })
    expect(native.register).toHaveBeenCalledOnce(); expect(native.open).toHaveBeenCalledOnce(); expect(native.retire).toHaveBeenCalledOnce()
    expect(native.retire).toHaveBeenCalledWith({ flowId: registration!.flowId })
    expect(unownedBrowser).not.toHaveBeenCalled(); expect(parentClose).not.toHaveBeenCalled()
    expect(tokenFetch).toHaveBeenCalledOnce()
    expect(runtime.credentialStore.get(id)).toMatchObject({ type: 'oauth2', accessToken: 'synthetic-private-access', clientId: 'synthetic-client' })
    const ciphertext = runtime.store.getAuthBlob(id)?.auth
    if (selected === 'persistent') { expect(ciphertext).toBeTruthy(); expect(ciphertext!.toString()).not.toContain('synthetic-private') }
    else expect(ciphertext).toBeNull()
  })

  it('fences withdrawn source authority after registration and before browser launch', async () => {
    source()
    const gate = deferred<void>(); afterRegistration = gate.promise; finishers.push(() => gate.resolve())
    const result = connect()
    await vi.waitFor(() => expect(native.register).toHaveBeenCalledOnce())
    options.canAccessSource = () => false; gate.resolve()
    expect(await result).toEqual({ ok: false, error: CONNECTOR_WRITE_ERROR })
    expect(native.open).not.toHaveBeenCalled(); expect(native.retire).toHaveBeenCalledOnce()
    expect(tokenFetch).not.toHaveBeenCalled(); expect(runtime.credentialStore.get(id)).toBeNull()
    expect(parentClose).not.toHaveBeenCalled()
  })

  it('refuses token redemption when an already-delivered loopback result loses source scope during raw opening', async () => {
    source()
    const gate = deferred<void>(); afterOpening = gate.promise; finishers.push(() => gate.resolve())
    const result = connect()
    await vi.waitFor(() => expect(native.open).toHaveBeenCalledOnce())
    options.canAccessSource = () => false; gate.resolve()
    expect(await result).toEqual({ ok: false, error: CONNECTOR_WRITE_ERROR })
    expect(tokenFetch).not.toHaveBeenCalled(); expect(native.retire).toHaveBeenCalledOnce()
    expect(runtime.credentialStore.get(id)).toBeNull()
  })

  it('retains a cancelled raw opener and its listener until native opening/retirement acknowledge', async () => {
    const gate = deferred<void>(); afterOpening = gate.promise; finishers.push(() => gate.resolve())
    const controller = new AbortController(), result = connect('session', controller.signal)
    const denied = expect(result).rejects.toMatchObject({ code: 'CANCELLED' })
    await vi.waitFor(() => expect(native.open).toHaveBeenCalledOnce())
    controller.abort()
    await expect(backend.close(20)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(backend.inflightCount).toBe(1); expect(db.db.open).toBe(true); expect(storage.isEncryptionAvailable()).toBe(true)
    gate.resolve(); await denied; await backend.close()
    expect(native.retire).toHaveBeenCalledOnce(); expect(tokenFetch).not.toHaveBeenCalled()
    expect(runtime.credentialStore.get(id)).toBeNull()
  })

  it.each(['register', 'retire'] as const)('retains cancelled raw %s work until its native receipt joins', async phase => {
    const gate = deferred<void>(); finishers.push(() => gate.resolve())
    if (phase === 'register') afterRegistration = gate.promise
    else afterRetirement = gate.promise
    const controller = new AbortController(), result = connect('persistent', controller.signal)
    const denied = expect(result).rejects.toMatchObject({ code: 'CANCELLED' })
    await vi.waitFor(() => expect(native[phase]).toHaveBeenCalledOnce())
    controller.abort()
    await expect(backend.close(20)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(backend.inflightCount).toBe(1)
    expect(db.db.open).toBe(true); expect(storage.isEncryptionAvailable()).toBe(true)
    expect(runtime.credentialStore.get(id)).toBeNull()
    gate.resolve(); await denied; await backend.close()
    expect(native.retire).toHaveBeenCalledOnce()
    expect(parentClose).not.toHaveBeenCalled()
    if (phase === 'register') { expect(native.open).not.toHaveBeenCalled(); expect(tokenFetch).not.toHaveBeenCalled() }
    else expect(tokenFetch).toHaveBeenCalledOnce()
    expect(runtime.credentialStore.get(id)).toBeNull()
  })

  it('checks changed source references after exchange and before any credential write', async () => {
    const linked = source(), gate = deferred<Response>()
    finishers.push(() => gate.resolve(Response.json({ access_token: 'synthetic-private-late' })))
    tokenFetch.mockImplementation(() => gate.promise)
    const result = connect('persistent')
    await vi.waitFor(() => expect(tokenFetch).toHaveBeenCalledOnce())
    db.updateTaskSource(linked.id, { config: { ...linked.config, props: { filter_query: 'changed' } } })
    gate.resolve(Response.json({ access_token: 'synthetic-private-late' }))
    expect(await result).toEqual({ ok: false, error: CONNECTOR_WRITE_ERROR })
    expect(runtime.credentialStore.get(id)).toBeNull(); expect(native.retire).toHaveBeenCalledOnce()
  })

  it('retains failed retirement and credential admission for retry without repeating authorization or exchange', async () => {
    refuseRetire = true
    expect(await connect()).toEqual({ ok: false, error: CONNECTOR_WRITE_ERROR })
    await expect(runtime.runCredentialMutation(id, async () => {})).rejects.toBeInstanceOf(ConnectorCredentialMutationBusyError)
    await expect(runtime.credentials.close(30)).rejects.toBeInstanceOf(ConnectorOAuthShutdownIncompleteError)
    expect(db.db.open).toBe(true); expect(runtime.credentialStore.get(id)).toBeNull()
    refuseRetire = false; await closeConnectorRuntime(db)
    expect(native.register).toHaveBeenCalledOnce(); expect(native.open).toHaveBeenCalledOnce(); expect(tokenFetch).toHaveBeenCalledOnce()
    expect(native.retire.mock.calls.length).toBeGreaterThan(1)
    expect(new Set(native.retire.mock.calls.map(([request]) => request.flowId))).toEqual(new Set([registration!.flowId]))
    expect(parentClose).not.toHaveBeenCalled()
  })

  it('retains admission when scope changes during raw registration and the SDK cannot retire its unpublished lease', async () => {
    source()
    const gate = deferred<void>(); afterRegistration = gate.promise; finishers.push(() => gate.resolve())
    const result = connect('persistent')
    await vi.waitFor(() => expect(native.register).toHaveBeenCalledOnce())
    options.canAccessSource = () => false; refuseRetire = true; gate.resolve()
    expect(await result).toEqual({ ok: false, error: CONNECTOR_WRITE_ERROR })
    await expect(runtime.runCredentialMutation(id, async () => {})).rejects.toBeInstanceOf(ConnectorCredentialMutationBusyError)
    await expect(runtime.credentials.close(30)).rejects.toBeInstanceOf(ConnectorOAuthShutdownIncompleteError)
    expect(native.open).not.toHaveBeenCalled(); expect(tokenFetch).not.toHaveBeenCalled()
    expect(db.db.open).toBe(true); expect(storage.isEncryptionAvailable()).toBe(true)
    expect(runtime.credentialStore.get(id)).toBeNull()
    refuseRetire = false; await closeConnectorRuntime(db)
    expect(native.register).toHaveBeenCalledOnce()
    expect(new Set(native.retire.mock.calls.map(([request]) => request.flowId))).toEqual(new Set([registration!.flowId]))
    expect(parentClose).not.toHaveBeenCalled()
  })

  it('preserves encrypted refresh and invalid-grant revocation after a native-owned connection', async () => {
    tokenFetch.mockResolvedValueOnce(Response.json({ access_token: 'synthetic-private-access', refresh_token: 'synthetic-private-refresh', expires_in: 1 }))
    expect(await connect('persistent')).toMatchObject({ ok: true })
    tokenFetch.mockResolvedValueOnce(Response.json({ access_token: 'synthetic-private-renewed', expires_in: 3600 }))
    expect(await runtime.credentials.get(id)).toMatchObject({ type: 'oauth2', accessToken: 'synthetic-private-renewed' })
    const credentials = runtime.credentialStore.get(id)!
    if (credentials.type !== 'oauth2') throw new Error('Wrong fixture credential kind')
    runtime.credentialStore.set(id, { ...credentials, expiresAt: 0 }, 'persistent')
    tokenFetch.mockResolvedValueOnce(Response.json({ error: 'invalid_grant' }, { status: 400 }))
    await expect(runtime.credentials.get(id)).rejects.toMatchObject({ reason: 'revoked' })
    expect(runtime.credentials.status(id).state).toBe('revoked')
    expect(runtime.store.getAuthBlob(id)!.auth!.toString()).not.toContain('synthetic-private')
    expect(native.register).toHaveBeenCalledOnce(); expect(native.retire).toHaveBeenCalledOnce()
    expect(parentClose).not.toHaveBeenCalled()
  })
})
