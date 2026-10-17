import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn as spawnNode, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { dirname, join } from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from '../main/agent-manager-core'
import type { AgentManagerHost } from '../main/agent-manager/host'
import { SyncManager } from '../main/sync-manager'
import { PluginRegistry } from '../main/plugins/registry'
import { OAuthManager } from '../main/oauth/oauth-manager-core'
import { McpProbeService, type McpProbeHost } from '../main/agent-manager/mcp-probe-service'
import { AuthenticatedSecretStorage } from '../main/platform/authenticated-secret-storage'
import { configureSecretStorage, getSecretStorage, releaseSecretStorage, type SecretStorage } from '../main/platform/secret-storage'
import { McpBackend, type McpBackendOptions, type McpOwners } from './mcp-backend'
import { MCP_CODECS, MCP_OPERATIONS, MCP_SECRET_SET_MARKER as marker, type McpCodec, type McpOperation } from '../shared/mcp-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import type { JsonValue } from '../shared/service-protocol'
import type { DesktopCallerContext } from './transport/desktop-registry'
class Adapter extends FakeAdapter { readonly notifyConfigChanged = vi.fn(async () => undefined) }
let db: ReturnType<typeof createPortableTestDb>, manager: AgentManager, adapter: Adapter, oauth: OAuthManager, probes: McpProbeService, backend: McpBackend, options: McpBackendOptions
let sync: SyncManager
let storage: AuthenticatedSecretStorage, prior: SecretStorage, root: string
let events: Array<{ operation: string; payload: JsonValue }>
let child: ChildProcessWithoutNullStreams
let spawn: Mock<McpProbeHost['spawn']>
let http: ReturnType<typeof vi.fn<typeof fetch>>
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'mcp-epoch', webviewId: 'main', origin: 'app://mcp' }
const remote = { name: 'Fixture remote', type: 'remote' as const, url: 'https://fixture.example.test/mcp', headers: { Authorization: 'Bearer private-fixture' } }
const local = { name: 'Fixture child', type: 'local' as const, command: 'fixture-child', environment: { SERVICE_TOKEN: 'private-fixture' } }
beforeEach(() => {
  db = createPortableTestDb(); root = dirname(dirname(db.getWorkspaceDir('fixture')))
  prior = getSecretStorage(); releaseSecretStorage(prior)
  storage = new AuthenticatedSecretStorage(Buffer.alloc(32, 61), 'mcp-profile-fixture'); configureSecretStorage(storage)
  adapter = new Adapter(); events = []
  const host: AgentManagerHost = { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' }, configuredMcp: 'enabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => adapter, isCodexAppServerAdapter: () => false }
  manager = new AgentManager(db, host)
  oauth = new OAuthManager(db, { openExternal: vi.fn(async () => undefined), notify: vi.fn() }); manager.setOAuthManager(oauth)
  child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true), pid: 456789 }) as unknown as ChildProcessWithoutNullStreams
  spawn = vi.fn<McpProbeHost['spawn']>(() => child); http = vi.fn<typeof fetch>()
  probes = new McpProbeService({ spawn, fetch: http, environment: () => ({ PATH: '/fixture/bin', HOME: root }), taskApiEnvironment: () => ({}), platform: 'linux' })
  sync = new SyncManager(db, new PluginRegistry())
  const owners: McpOwners = { database: db, manager, sync, probes, secretStorage: storage, oauth: { kind: 'unavailable', manager: oauth } }
  options = { ...owners, configuredMcp: 'enabled', engineEpoch: caller.engineEpoch,
    assertAvailable() { if (!db.db.open) throw new Error('Closed store') },
    assertMcpOwners(actual) { for (const key of Object.keys(owners) as Array<keyof McpOwners>) if (actual[key] !== owners[key]) throw new Error('Wrong owner') },
    isTrustedDesktop: value => value.webviewId === caller.webviewId && value.origin === caller.origin,
    canManageConfiguration: () => true, canAccessServer: () => true, canAccessSource: () => true, canAccessTask: () => true, canAccessAgent: () => true, canAccessProject: () => true,
    canUseEnvironmentName: name => name === 'SERVICE_TOKEN', canUseTransport: input => input.command === 'fixture-child' || input.url === remote.url,
    emit: (operation, payload) => { events.push({ operation, payload }) }, onFatalEvent: vi.fn() }
  backend = new McpBackend(options)
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  child.emit('close', 0)
  await Promise.all([oauth.close(), backend.close(), sync.close()]); await manager.stopAllSessions()
  db.close(); releaseSecretStorage(storage); storage.dispose(); configureSecretStorage(prior); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs()
})
async function call<K extends McpOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = MCP_CODECS[operation] as McpCodec<K>
  const encoded = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
  expect(codec.validateWireResult(encoded)).toBe(true)
  return codec.decodeResult((encoded as { defined: boolean; value?: JsonValue }).value)
}
async function live(agentId: string, title = 'Owned work') {
  const task = db.createTask({ title })!; db.updateTask(task.id, { agent_id: agentId })
  const result = await manager.requestSession(agentId, task.id)
  if (result.status !== 'started') throw new Error('Fixture start failed')
  return result.sessionId
}
describe('production MCP actual-owner bindings', () => {
  it('binds ten operations with authenticated masked metadata and marker roundtrip', async () => {
    expect(Object.keys(backend.operationSchemas(caller))).toEqual([...MCP_OPERATIONS])
    const created = await call('mcp:create', [{ ...remote, environment: { SERVICE_TOKEN: 'private-env' } }]) as { id: string; headers: Record<string, string> }
    expect(created.headers).toEqual({ Authorization: marker })
    const raw = db.db.prepare('SELECT headers,environment FROM mcp_servers WHERE id=?').get(created.id) as { headers: string; environment: string }
    expect(raw.headers).toContain('21x-credential:21x.aes256gcm.v1:'); expect(raw.environment).toContain('21x-credential:21x.aes256gcm.v1:')
    expect(JSON.stringify(raw)).not.toContain('private-')
    await call('mcp:update', [created.id, { name: 'Changed', headers: { Authorization: marker }, environment: { SERVICE_TOKEN: marker } }])
    expect(db.getMcpServer(created.id)?.headers.Authorization).toBe('Bearer private-fixture')
    expect(db.getMcpServer(created.id)?.environment.SERVICE_TOKEN).toBe('private-env')
    expect(JSON.stringify(await call('mcp:getAll', []))).not.toContain('private-')
    await expect(call('mcp:create', [{ name: 'Unsaved mask', headers: { Authorization: marker } }])).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(db.getMcpServers()).toHaveLength(1)
  })
  it('acknowledges Stop for configured and shared cached adapter owners before commit, then refreshes once', async () => {
    const server = db.createMcpServer(remote)!
    const first = db.createAgent({ name: 'Configured owner', config: { coding_agent: 'opencode', mcp_servers: [{ serverId: server.id, enabledTools: ['lookup'] }] } })!
    const other = db.createAgent({ name: 'Shared cache', config: { coding_agent: 'opencode' } })!
    const one = await live(first.id), two = await live(other.id)
    options.canAccessAgent = id => id !== other.id
    await expect(call('mcp:update', [server.id, { headers: { Authorization: 'replacement' } }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(manager.getSession(one)).toBeDefined(); expect(manager.getSession(two)).toBeDefined(); expect(adapter.destroySession).not.toHaveBeenCalled()
    options.canAccessAgent = () => true
    await call('mcp:update', [server.id, { headers: { Authorization: 'replacement' } }])
    expect(manager.getSession(one)).toBeUndefined(); expect(manager.getSession(two)).toBeUndefined()
    expect(adapter.destroySession).toHaveBeenCalledTimes(2); expect(adapter.notifyConfigChanged).toHaveBeenCalledOnce()
    expect(db.getAgent(first.id)?.config.mcp_servers).toEqual([{ serverId: server.id, enabledTools: ['lookup'] }])
    expect(events).toEqual([{ operation: 'tasks:refresh', payload: {} }])
  })

  it('requires the implicit Captain project grant before a shared MCP credential change can stop its owner', async () => {
    const server = db.createMcpServer(remote)!
    const agent = db.createAgent({ name: 'Implicit Captain default', config: { coding_agent: 'opencode', mcp_servers: [server.id] } })!
    const project = db.createProject({ name: 'Implicit protected project' })!
    expect(manager.getAgentConfigurationProjectIds(agent.id)).toContain(project.id)
    const active = await live(agent.id)
    options.canAccessProject = id => id !== project.id
    await expect(call('mcp:update', [server.id, { headers: { Authorization: 'replacement' } }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(manager.getSession(active)).toBeDefined(); expect(adapter.destroySession).not.toHaveBeenCalled()
    expect(db.getMcpServer(server.id)?.headers.Authorization).toBe(remote.headers.Authorization)
  })
  it('removes configured references after exact teardown and preserves managed/plugin rows', async () => {
    const server = db.createMcpServer(remote)!, agent = db.createAgent({ name: 'Owner', config: { coding_agent: 'opencode', mcp_servers: [server.id] } })!
    await live(agent.id)
    expect(await call('mcp:delete', [server.id])).toBe(true)
    expect(db.getAgent(agent.id)?.config.mcp_servers).toEqual([]); expect(db.getMcpServer(server.id)).toBeUndefined()
    for (const managed of [db.createMcpServer({ name: 'task-management' })!, db.createMcpServer({ name: 'Plugin owner', source: 'plugin' })!]) {
      await expect(call('mcp:delete', [managed.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      await expect(call('mcp:update', [managed.id, { command: 'changed' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(db.getMcpServer(managed.id)).toBeDefined()
    }
    await expect(call('mcp:create', [{ name: 'task-management' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('mcp:create', [{ name: 'browser-tools' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
  it('rejects caller/project/env/endpoint authority before child/network/Stop effects', async () => {
    const server = db.createMcpServer(remote)!, agent = db.createAgent({ name: 'Owner', config: { coding_agent: 'opencode', mcp_servers: [server.id] } })!
    const session = await live(agent.id)
    options.canAccessProject = () => false
    await expect(call('mcp:update', [server.id, { name: 'Denied' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(manager.getSession(session)).toBeDefined(); expect(adapter.destroySession).not.toHaveBeenCalled()
    for (const environment of [{ PATH: '/malicious' }, { TASK_API_TOKEN: 'private' }, { LD_PRELOAD: '/private' }, { OTHER_TOKEN: 'private' }] as Array<Record<string, string>>) await expect(call('mcp:create', [{ name: 'Denied env', environment }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('mcp:testConnection', [{ ...remote, url: 'https://foreign.example.test' }])).rejects.toMatchObject({ code: 'DISCONNECTED' })
    for (const identity of [{ ...caller, engineEpoch: 'stale' }, { ...caller, webviewId: 'foreign' }, { ...caller, origin: 'http://foreign' }]) await expect(call('mcp:create', [{ name: 'Denied' }], new AbortController().signal, identity)).rejects.toBeDefined()
    expect(spawn).not.toHaveBeenCalled(); expect(http).not.toHaveBeenCalled()
  })
  it('runs actual bounded MCP handshake and commits only matching stored tools', async () => {
    const server = db.createMcpServer(remote)!
    http.mockImplementation(async (_url, init) => {
      expect(init?.headers).toHaveProperty('Authorization', 'Bearer private-fixture')
      const request = JSON.parse(init!.body as string)
      return request.id ? Response.json({ id: request.id, result: request.id === 1 ? {} : { tools: [{ name: 'lookup', description: 'Read items' }] } }) : new Response(null, { status: 202 })
    })
    const result = await call('mcp:testConnection', [{ ...remote, id: server.id, headers: { Authorization: marker } }])
    expect(result).toEqual({ status: 'connected', toolCount: 1, tools: [{ name: 'lookup', description: 'Read items' }] })
    expect(db.getMcpServer(server.id)?.tools).toEqual(result.tools)
    expect(http).toHaveBeenCalledTimes(3); expect(JSON.stringify(events)).not.toContain('private')
  })
  it('persists discovered SSE tools only after both owned readers close and preserves other server metadata', async () => {
    const server = db.createMcpServer(remote)!, other = db.createMcpServer({ ...remote, name: 'Unrelated saved server' })!
    const cancels: string[] = []
    http.mockImplementation(async (_url, init) => {
      expect(init?.redirect).toBe('error')
      const message = JSON.parse(init!.body as string)
      if (!message.id) return new Response(null, { status: 202 })
      const result = message.id === 1 ? {} : { tools: [{ name: 'streamed_lookup', description: 'Fixture only' }] }
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ id: message.id, result }) + '\n\n')) },
        cancel() { cancels.push(message.method) }
      }), { headers: { 'Content-Type': 'text/event-stream' } })
    })
    const result = await call('mcp:testConnection', [{ ...remote, id: server.id, headers: { Authorization: marker } }])
    expect(result).toEqual({ status: 'connected', toolCount: 1, tools: [{ name: 'streamed_lookup', description: 'Fixture only' }] })
    expect(cancels).toEqual(['initialize', 'tools/list']); expect(backend.pendingProbeCount).toBe(0)
    expect(db.getMcpServer(server.id)?.tools).toEqual(result.tools); expect(db.getMcpServer(other.id)?.tools).toEqual([])
    expect(db.getMcpServer(server.id)?.headers).toEqual(remote.headers)
  })
  it.each(['transport', 'configuration', 'server', 'environment', 'linked task'] as const)('fences the next network effect after %s authority loss during initialization', async kind => {
    const server = db.createMcpServer({ ...remote, environment: { SERVICE_TOKEN: 'fixture-value' } })!
    const source = db.createTaskSource({ name: 'Bound source', plugin_id: 'fixture', mcp_server_id: server.id })!
    db.createTask({ title: 'Bound task', source_id: source.id, project_id: source.project_id })
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"id":1,"result":{}}\n\n')) },
      cancel() {
        if (kind === 'transport') options.canUseTransport = () => false
        if (kind === 'configuration') options.canManageConfiguration = () => false
        if (kind === 'server') options.canAccessServer = () => false
        if (kind === 'environment') options.canUseEnvironmentName = () => false
        if (kind === 'linked task') options.canAccessTask = () => false
      }
    })
    http.mockResolvedValueOnce(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }))
    const result = await call('mcp:testConnection', [{ ...remote, environment: { SERVICE_TOKEN: 'fixture-value' }, id: server.id }]).catch(error => ({ code: error.code }))
    expect(result).toEqual(kind === 'transport' ? { code: 'INVALID_REQUEST' } : { status: 'failed', error: 'MCP probe failed' })
    expect(http).toHaveBeenCalledOnce(); expect(db.getMcpServer(server.id)?.tools).toEqual([]); expect(events).toEqual([])
    expect(body.locked).toBe(false)
  })
  it('refuses queued auth probes after read authority is revoked before fetch', async () => {
    const flight = call('mcp:probeForAuth', [remote.url])
    options.canManageConfiguration = () => false
    await expect(flight).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(http).not.toHaveBeenCalled()
  })
  it('preserves existing tools when a remote probe receives HTML rather than MCP', async () => {
    const server = db.createMcpServer(remote)!
    db.updateMcpServerTools(server.id, [{ name: 'previous_tool', description: 'Saved metadata' }])
    http.mockResolvedValueOnce(new Response('<html>private-fixture</html>', { headers: { 'Content-Type': 'text/html' } }))
    expect(await call('mcp:testConnection', [{ ...remote, id: server.id }])).toEqual({ status: 'failed', error: 'MCP probe failed' })
    expect(db.getMcpServer(server.id)?.tools).toEqual([{ name: 'previous_tool', description: 'Saved metadata' }]); expect(events).toEqual([])
    expect(http).toHaveBeenCalledOnce()
  })
  it('owns a cancelled child through raw close with restricted environment and no stale tools', async () => {
    const server = db.createMcpServer(local)!, controller = new AbortController()
    const flight = call('mcp:testConnection', [{ ...local, id: server.id }], controller.signal)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    expect(spawn.mock.calls[0][2].env).toEqual({ PATH: '/fixture/bin', HOME: root, npm_config_yes: 'true', SERVICE_TOKEN: 'private-fixture' })
    controller.abort(); await expect(flight).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(child.kill).toHaveBeenCalledWith('SIGTERM'); expect(backend.pendingProbeCount).toBe(1)
    await expect(backend.close(10)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(db.db.open).toBe(true); expect(storage.isEncryptionAvailable()).toBe(true)
    child.emit('close', 0); await backend.close(); expect(backend.pendingProbeCount).toBe(0); expect(db.getMcpServer(server.id)?.tools).toEqual([])
  })
  it('retains a cancelled auth probe and response cleanup without browser/OAuth effects', async () => {
    let release!: (response: Response) => void
    http.mockImplementation(() => new Promise<Response>(resolve => { release = resolve }))
    const controller = new AbortController(), flight = call('mcp:probeForAuth', [remote.url], controller.signal)
    await vi.waitFor(() => expect(http).toHaveBeenCalledOnce())
    expect(http.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' })
    controller.abort(); await expect(backend.close(10)).rejects.toMatchObject({ code: 'TIMEOUT' })
    const cancel = vi.fn(); release(new Response(new ReadableStream({ cancel })))
    await expect(flight).rejects.toMatchObject({ code: 'CANCELLED' }); await backend.close(); expect(cancel).toHaveBeenCalledOnce()
  })
  it('fences saved-server edits behind cancelled raw child close', async () => {
    const server = db.createMcpServer(local)!, controller = new AbortController()
    const probing = call('mcp:testConnection', [{ ...local, id: server.id }], controller.signal)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    controller.abort(); await expect(probing).rejects.toMatchObject({ code: 'CANCELLED' })
    const updating = call('mcp:update', [server.id, { name: 'After actual close' }])
    await vi.waitFor(() => expect(backend.inflightCount).toBe(1))
    await expect(call('mcp:testConnection', [{ ...local, id: server.id }])).rejects.toMatchObject({ code: 'BACKPRESSURE' })
    expect(db.getMcpServer(server.id)?.name).toBe(local.name)
    expect(adapter.notifyConfigChanged).not.toHaveBeenCalled()
    child.emit('close', 0); await updating
    expect(db.getMcpServer(server.id)?.name).toBe('After actual close')
    // No self-join: successful saved probes complete tool refresh separately.
    expect(events).toEqual([{ operation: 'tasks:refresh', payload: {} }])
  })
  it('joins one saved server without waiting for or cancelling an unrelated unsaved probe', async () => {
    const server = db.createMcpServer(local)!, localController = new AbortController(), remoteController = new AbortController()
    let release!: (response: Response) => void
    http.mockImplementation(() => new Promise<Response>(resolve => { release = resolve }))
    const saved = call('mcp:testConnection', [{ ...local, id: server.id }], localController.signal)
    const unsaved = call('mcp:testConnection', [remote], remoteController.signal)
    await vi.waitFor(() => { expect(spawn).toHaveBeenCalledOnce(); expect(http).toHaveBeenCalledOnce() })
    localController.abort(); await expect(saved).rejects.toMatchObject({ code: 'CANCELLED' })
    const update = call('mcp:update', [server.id, { name: 'Independent update' }])
    child.emit('close', 0); await update
    expect(db.getMcpServer(server.id)?.name).toBe('Independent update')
    expect((http.mock.calls[0][1]!.signal as AbortSignal).aborted).toBe(false)
    expect(backend.pendingProbeCount).toBe(1)
    remoteController.abort(); await expect(unsaved).rejects.toMatchObject({ code: 'CANCELLED' })
    release(new Response()); await backend.close()
  })

  it('does not apply a late saved-server probe when deletion already holds its fence', async () => {
    const server = db.createMcpServer(local)!
    const probing = call('mcp:testConnection', [{ ...local, id: server.id }])
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    const deleting = call('mcp:delete', [server.id])
    await vi.waitFor(() => expect(backend.inflightCount).toBe(2))
    child.stdout.emit('data', JSON.stringify({ id: 1, result: {} }) + '\n')
    child.stdout.emit('data', JSON.stringify({ id: 2, result: { tools: [{ name: 'late', description: 'discard' }] } }) + '\n')
    const rejected = expect(probing).rejects.toMatchObject({ code: 'BACKPRESSURE' })
    expect(db.getMcpServer(server.id)).toBeDefined()
    child.emit('close', 0); await rejected; expect(await deleting).toBe(true)
    expect(db.getMcpServer(server.id)).toBeUndefined()
    expect(events).toEqual([{ operation: 'tasks:refresh', payload: {} }])
  })

  it('reads real encrypted OAuth status/revokes without browser support and rejects browser flows before effect', async () => {
    const server = db.createMcpServer(remote)!
    db.createOAuthToken({ provider: 'mcp-server', mcp_server_id: server.id, access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, scope: null })
    expect(await call('mcp:getOAuthStatus', [server.id])).toMatchObject({ connected: true })
    const start = vi.spyOn(oauth, 'startMcpServerOAuthFlow'), manual = vi.spyOn(oauth, 'completeManualRegistration')
    await expect(call('mcp:startOAuthFlow', [server.id])).rejects.toMatchObject({ code: 'DISCONNECTED' })
    await expect(call('mcp:submitManualClientId', [server.id, 'public-client'])).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(start).not.toHaveBeenCalled(); expect(manual).not.toHaveBeenCalled()
    await call('mcp:revokeOAuthToken', [server.id]); expect(await call('mcp:getOAuthStatus', [server.id])).toEqual({ connected: false })
    options.configuredMcp = 'disabled'
    await expect(call('mcp:testConnection', [remote])).rejects.toMatchObject({ code: 'DISCONNECTED' })
    await expect(call('mcp:probeForAuth', [remote.url])).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(http).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled()
  })
  it('retains acknowledged teardown after cancellation and does not write or replay', async () => {
    const server = db.createMcpServer(remote)!, agent = db.createAgent({ name: 'Owner', config: { coding_agent: 'opencode', mcp_servers: [server.id] } })!
    await live(agent.id)
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), raw = new Promise<void>(resolve => { release = resolve })
    adapter.destroySession.mockImplementationOnce(async () => { entered(); await raw })
    const controller = new AbortController(), flight = call('mcp:update', [server.id, { name: 'Unaccepted rename' }], controller.signal)
    await started; controller.abort()
    await expect(backend.close(10)).rejects.toMatchObject({ code: 'TIMEOUT' }); expect(db.db.open).toBe(true)
    release(); await expect(flight).rejects.toMatchObject({ code: 'CANCELLED' }); await backend.close()
    expect(db.getMcpServer(server.id)?.name).toBe(remote.name); expect(events).toEqual([])
  })
  it('refuses linked-source deletion and drains owned sync before changes, with source/task scope preflight', async () => {
    const server = db.createMcpServer(remote)!
    const source = db.createTaskSource({ name: 'Linked source', plugin_id: 'fixture', mcp_server_id: server.id })!
    const task = db.createTask({ title: 'Linked task', source_id: source.id, project_id: source.project_id })!
    await expect(call('mcp:delete', [server.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(db.getTaskSource(source.id)).toBeDefined(); expect(db.getTask(task.id)?.source_id).toBe(source.id)
    options.canAccessTask = () => false
    await expect(call('mcp:update', [server.id, { name: 'Denied' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('mcp:testConnection', [{ ...remote, id: server.id }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(http).not.toHaveBeenCalled(); options.canAccessTask = () => true
    let release!: () => void, entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), raw = new Promise<void>(resolve => { release = resolve })
    const syncing = sync.runSourceWork(source.id, async () => { entered(); await raw })
    await started
    const update = call('mcp:update', [server.id, { name: 'After source drain' }])
    await vi.waitFor(() => expect(backend.inflightCount).toBe(1))
    expect(db.getMcpServer(server.id)?.name).toBe(remote.name)
    release(); await syncing; await update
    expect(db.getMcpServer(server.id)?.name).toBe('After source drain')
  })
  it('holds linked source sync admission until a cancelled probe actually closes', async () => {
    const server = db.createMcpServer(local)!, source = db.createTaskSource({ name: 'Probe-linked source', plugin_id: 'fixture', mcp_server_id: server.id })!
    const controller = new AbortController(), flight = call('mcp:testConnection', [{ ...local, id: server.id }], controller.signal)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    controller.abort(); await expect(flight).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(sync.runSourceWork(source.id, async () => undefined)).rejects.toMatchObject({ code: 'SOURCE_MUTATION_BUSY' })
    const updater = call('mcp:update', [server.id, { name: 'After source/raw release' }])
    child.emit('close', 0); await updater
    await expect(sync.runSourceWork(source.id, async () => 'released')).resolves.toBe('released')
    expect(db.getMcpServer(server.id)?.name).toBe('After source/raw release')
  })

  it('rejects new linked source/task references after asynchronous drain without unauthorized writes', async () => {
    const server = db.createMcpServer(remote)!, source = db.createTaskSource({ name: 'Original source', plugin_id: 'fixture', mcp_server_id: server.id })!
    let release!: () => void, entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), raw = new Promise<void>(resolve => { release = resolve })
    const syncing = sync.runSourceWork(source.id, async () => { entered(); await raw }); await started
    const update = call('mcp:update', [server.id, { name: 'Must not commit' }])
    await vi.waitFor(() => expect(backend.inflightCount).toBe(1))
    const late = db.createTaskSource({ name: 'Late source', plugin_id: 'fixture', mcp_server_id: server.id })!
    options.canAccessSource = id => id !== late.id
    const rejected = expect(update).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    release(); await syncing; await rejected
    expect(db.getMcpServer(server.id)?.name).toBe(remote.name); expect(db.getTaskSource(late.id)).toBeDefined(); expect(events).toEqual([])
  })
  it.skipIf(!!process.versions.electron)('probes an actual isolated Node stdio child and acknowledges close through the production backend', async () => {
    // Electron process.execPath is not standalone Node; this exact proof runs
    // in the portable suite, rather than silently falling back to PATH or npm.
    await backend.close()
    vi.stubEnv('TASK_API_TOKEN', 'private-parent-task-token')
    vi.stubEnv('OPENAI_API_KEY', 'private-parent-provider-key')
    vi.stubEnv('ANTHROPIC_API_KEY', 'private-parent-provider-key')
    const fixture = join(root, 'mcp-probe-fixture.cjs')
    writeFileSync(fixture, `if(process.env.TASK_API_TOKEN||process.env.OPENAI_API_KEY||process.env.ANTHROPIC_API_KEY||process.env.SERVICE_TOKEN!=='private-stdio-fixture')process.exit(9);let input='';process.stdin.on('data',chunk=>{input+=chunk;let i;while((i=input.indexOf('\\n'))>=0){const line=input.slice(0,i);input=input.slice(i+1);const request=JSON.parse(line);if(request.id)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:request.method==='tools/list'?{tools:[{name:'fixture_lookup',description:'Isolated fixture tool'}]}:{protocolVersion:'2024-11-05'}})+'\\n')}});`)
    let pid = 0, actualClose = false, count = 0
    probes = new McpProbeService({ spawn: (command, args, opts) => {
      count++; const child = spawnNode(command, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] }); pid = child.pid!; child.once('close', () => { actualClose = true }); return child
    }, fetch, environment: () => ({ HOME: root, TMPDIR: root }), taskApiEnvironment: () => ({}), platform: process.platform })
    options.probes = probes
    options.assertMcpOwners = actual => { if (actual.database !== db || actual.manager !== manager || actual.sync !== sync || actual.probes !== probes || actual.secretStorage !== storage || actual.oauth.manager !== oauth) throw new Error('Wrong owner') }
    options.canUseTransport = input => input.command === process.execPath && input.args?.length === 1 && input.args[0] === fixture
    backend = new McpBackend(options)
    const config = { name: 'Isolated stdio proof', type: 'local' as const, command: process.execPath, args: [fixture], environment: { SERVICE_TOKEN: 'private-stdio-fixture' } }
    const server = await call('mcp:create', [config]) as { id: string; environment: Record<string, string> }
    expect(server.environment).toEqual({ SERVICE_TOKEN: marker })
    expect((db.db.prepare('SELECT environment FROM mcp_servers WHERE id=?').get(server.id) as { environment: string }).environment).not.toContain('private-stdio-fixture')
    await expect(call('mcp:testConnection', [{ ...config, id: 'unknown-id' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canAccessServer = () => false
    await expect(call('mcp:testConnection', [{ ...config, id: server.id }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(count).toBe(0); options.canAccessServer = () => true
    const result = await call('mcp:testConnection', [{ ...config, id: server.id, environment: { SERVICE_TOKEN: marker } }])
    expect(result).toEqual({ status: 'connected', toolCount: 1, tools: [{ name: 'fixture_lookup', description: 'Isolated fixture tool' }] })
    expect(db.getMcpServer(server.id)?.tools).toEqual(result.tools)
    expect(actualClose).toBe(true); expect(pid).toBeGreaterThan(0); expect(() => process.kill(pid, 0)).toThrow()
    expect(backend.pendingProbeCount).toBe(0); expect(count).toBe(1); expect(events).toHaveLength(2)
    expect(JSON.stringify(events)).not.toContain('private-stdio-fixture')
  }, 10_000)

  it('preflights oversized persisted JSON, latches accepted notification failures and never retries', async () => {
    const server = db.createMcpServer(remote)!
    db.db.prepare('UPDATE mcp_servers SET tools=? WHERE id=?').run('x'.repeat(256 * 1024 + 1), server.id)
    await expect(call('mcp:getAll', [])).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' })
    expect((db.db.prepare('SELECT length(tools) AS size FROM mcp_servers WHERE id=?').get(server.id) as { size: number }).size).toBe(256 * 1024 + 1)
    db.db.prepare('UPDATE mcp_servers SET tools=? WHERE id=?').run('[]', server.id)
    options.emit = () => { throw new Error('Private sink diagnostic') }
    await expect(call('mcp:update', [server.id, { name: 'Accepted once' }])).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(db.getMcpServer(server.id)?.name).toBe('Accepted once'); expect(options.onFatalEvent).toHaveBeenCalledOnce()
    await expect(call('mcp:update', [server.id, { name: 'No replay' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(db.getMcpServer(server.id)?.name).toBe('Accepted once')
  })
})
