import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from '../main/agent-manager-core'
import type { AgentManagerHost } from '../main/agent-manager/host'
import { AgentConfigurationBackend, type AgentConfigurationBackendOptions } from './agent-configuration-backend'
import { AGENT_API_KEY_SET_MARKER, AGENT_CONFIGURATION_CODECS, type AgentConfigurationCodec, type AgentConfigurationOperation } from '../shared/agent-configuration-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import type { DesktopCallerContext } from './transport/desktop-registry'
import type { JsonValue, ServiceProtocolError } from '../shared/service-protocol'
import { CodingAgentType } from '../renderer/src/types'
import { AuthenticatedSecretStorage } from '../main/platform/authenticated-secret-storage'
import { configureSecretStorage, getSecretStorage, releaseSecretStorage, type SecretStorage } from '../main/platform/secret-storage'
import { SecretBroker } from '../main/secret-broker-core'
import { writeSecretShellWrapper } from '../main/secret-shell'

class ConfigurationAdapter extends FakeAdapter {
  readonly notifyConfigChanged = vi.fn(async () => undefined)
  readonly getProviders = vi.fn(async () => ({ providers: [{ id: 'provider', name: 'Provider', models: [{ id: 'model', name: 'Model' }] }], default: { provider: 'model' } }))
  readonly listModels = vi.fn(async () => [{ id: 'model', name: 'Model' }])
}
let db: ReturnType<typeof createPortableTestDb>
let manager: AgentManager
let backend: AgentConfigurationBackend
let adapter: ConfigurationAdapter
let options: AgentConfigurationBackendOptions
let events: Array<{ operation: string; payload: JsonValue }>
let fatal: Mock<(error: ServiceProtocolError) => void>
let allowed: boolean
let storage: AuthenticatedSecretStorage
let priorStorage: SecretStorage
let broker: SecretBroker
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'configuration-epoch', webviewId: 'main', origin: 'app://configuration' }
beforeEach(() => {
  db = createPortableTestDb(); adapter = new ConfigurationAdapter(); events = []; fatal = vi.fn(); allowed = true
  priorStorage = getSecretStorage(); releaseSecretStorage(priorStorage)
  storage = new AuthenticatedSecretStorage(Buffer.alloc(32, 61), 'agent-config-unit'); configureSecretStorage(storage)
  broker = new SecretBroker(db)
  const root = dirname(dirname(db.getWorkspaceDir('fixture')))
  const host: AgentManagerHost = { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' },
    secrets: { kind: 'broker', getPort: () => broker.port, register: (token, id, ids) => broker.register(token, id, ids), unregister: token => broker.unregister(token), writeShellWrapper: () => writeSecretShellWrapper(root) },
    configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => adapter, isCodexAppServerAdapter: () => false }
  manager = new AgentManager(db, host)
  options = { database: db, manager, credentialStorage: storage, engineEpoch: caller.engineEpoch,
    assertAvailable() { if (!db.db.open) throw new Error('Closed profile') },
    isTrustedDesktop: value => value.webviewId === 'main' && value.origin === caller.origin,
    canAccessAgent: () => allowed, canManageGlobalConfiguration: () => allowed, canAccessProject: () => allowed, canQueryBackend: () => allowed,
    canAccessMcpServer: () => allowed, canAccessSecret: () => allowed, canAccessGlobalSkills: () => allowed,
    emit: (operation, payload) => { events.push({ operation, payload }) }, onFatalEvent: fatal }
  backend = new AgentConfigurationBackend(options)
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  await backend.close(); await manager.stopAllSessions(); await broker.close()
  const root = dirname(dirname(db.getWorkspaceDir('cleanup-fixture')))
  db.close(); releaseSecretStorage(storage); storage.dispose(); configureSecretStorage(priorStorage)
  rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks()
})
async function call<K extends AgentConfigurationOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = AGENT_CONFIGURATION_CODECS[operation] as AgentConfigurationCodec<K>
  const encoded = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
  expect(codec.validateWireResult(encoded)).toBe(true)
  return codec.decodeResult((encoded as { defined: boolean; value?: JsonValue }).value)
}
async function live(agentId: string, title: string) {
  const task = db.createTask({ title })!; db.updateTask(task.id, { agent_id: agentId })
  const outcome = await manager.requestSession(agentId, task.id)
  expect(outcome.status).toBe('started')
  if (!('sessionId' in outcome)) throw new Error('Start fixture failed')
  return { task, sessionId: outcome.sessionId }
}
describe('actual owner agent configuration bindings', () => {
  it('creates/reads/updates public records while masking and preserving saved credentials', async () => {
    const created = await call('agent:create', [{ name: 'Public agent', config: { coding_agent: CodingAgentType.OPENCODE, concurrency_cap: 1, max_parallel_sessions: 1 } }])
    const raw = db.getAgent(created.id)!
    db.updateAgent(raw.id, { config: { ...raw.config, api_keys: { openai: 'private-saved-key' } } })
    const all = await call('agent:getAll', [])
    expect(all[0].config.api_keys?.openai).toBe(AGENT_API_KEY_SET_MARKER)
    expect(JSON.stringify(all)).not.toContain('private-saved-key')
    const updated = await call('agent:update', [raw.id, { name: 'Renamed', config: { coding_agent: CodingAgentType.OPENCODE, concurrency_cap: 2, max_parallel_sessions: 2 } }])
    expect(updated).toMatchObject({ name: 'Renamed', config: { api_keys: { openai: AGENT_API_KEY_SET_MARKER } } })
    expect(db.getAgent(raw.id)?.config.api_keys?.openai).toBe('private-saved-key')
    expect(events).toEqual([{ operation: 'tasks:refresh', payload: {} }, { operation: 'tasks:refresh', payload: {} }])
  })

  it('preserves live owners on metadata/cap edits and acknowledges exact owner stops before runtime edits', async () => {
    const agent = db.createAgent({ name: 'Owner', config: { coding_agent: 'opencode', concurrency_cap: 1, max_parallel_sessions: 1 } })!
    const active = await live(agent.id, 'Owned work')
    await call('agent:update', [agent.id, { name: 'Metadata only', config: { ...agent.config, coding_agent: CodingAgentType.OPENCODE, concurrency_cap: 2, max_parallel_sessions: 2 } }])
    expect(manager.getSession(active.sessionId)).toBeDefined()
    expect(adapter.destroySession).not.toHaveBeenCalled()
    expect(adapter.notifyConfigChanged).not.toHaveBeenCalled()
    await call('agent:update', [agent.id, { name: 'Empty inactive key form', config: { ...db.getAgent(agent.id)!.config, coding_agent: CodingAgentType.OPENCODE, api_keys: {} } }])
    expect(manager.getSession(active.sessionId)).toBeDefined(); expect(adapter.destroySession).not.toHaveBeenCalled()
    const updated = await call('agent:update', [agent.id, { config: { ...db.getAgent(agent.id)!.config, coding_agent: CodingAgentType.OPENCODE, system_prompt: 'Changed runtime instructions' } }])
    expect(updated?.config.system_prompt).toBe('Changed runtime instructions')
    expect(adapter.destroySession).toHaveBeenCalledWith(active.sessionId, expect.any(Object))
    expect(manager.getSession(active.sessionId)).toBeUndefined()
    expect(adapter.notifyConfigChanged).toHaveBeenCalledOnce()
  })

  it('refuses disruptive backend changes that would affect an unrelated live owner', async () => {
    const first = db.createAgent({ name: 'One', config: { coding_agent: 'opencode' } })!
    const other = db.createAgent({ name: 'Other', config: { coding_agent: 'opencode' } })!
    const firstLive = await live(first.id, 'First work'), otherLive = await live(other.id, 'Other work')
    await expect(call('agent:update', [first.id, { config: { coding_agent: CodingAgentType.OPENCODE, system_prompt: 'Disruptive change' } }])).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(manager.getSession(firstLive.sessionId)).toBeDefined(); expect(manager.getSession(otherLive.sessionId)).toBeDefined()
    expect(adapter.destroySession).not.toHaveBeenCalled()
    expect(db.getAgent(first.id)?.config.system_prompt).toBeUndefined()
  })

  it('preflights group/reference authority and rejects secret writes without the protected owner before lifecycle effects', async () => {
    const agent = db.createAgent({ name: 'Scoped owner', config: { coding_agent: 'opencode' } })!
    const owned = await live(agent.id, 'Owned task')
    options.credentialStorage = undefined
    await expect(backend.registry.invoke('agent:update', { id: agent.id, data: { config: { api_keys: { openai: 'forbidden-key' } } } }, caller, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.credentialStorage = storage
    options.canAccessProject = () => false
    await expect(call('agent:delete', [agent.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(manager.getSession(owned.sessionId)).toBeDefined(); expect(adapter.destroySession).not.toHaveBeenCalled()
    options.canAccessProject = () => true
    await manager.stopSession(owned.sessionId)
    const tasks = [1, 2].map(index => db.createTask({ title: `Grouped ${index}` })!.id)
    db.createTaskGroup({ title: 'Active definition', task_ids: tasks, agent_id: agent.id })
    const before = adapter.destroySession.mock.calls.length
    await expect(call('agent:delete', [agent.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(adapter.destroySession.mock.calls).toHaveLength(before)
    expect(db.getAgent(agent.id)).toBeDefined()
  })

  it('encrypts agent keys at rest, echoes markers without stopping, and clears only the requested vendor', async () => {
    const created = await call('agent:create', [{ name: 'Protected keys', config: { coding_agent: CodingAgentType.OPENCODE,
      api_keys: { openai: ' \uFEFFprivate-agent-key ', anthropic: 'other-private-key' } } }])
    const raw = db.db.prepare('SELECT config FROM agents WHERE id=?').get(created.id) as { config: string }
    expect(raw.config).not.toContain('private-agent-key'); expect(raw.config).not.toContain('other-private-key')
    expect(raw.config).toContain('21x-record-credential:v1:')
    expect(db.getAgent(created.id)?.config.api_keys).toEqual({ openai: ' \uFEFFprivate-agent-key ', anthropic: 'other-private-key' })
    expect(created.config.api_keys).toEqual({ openai: AGENT_API_KEY_SET_MARKER, anthropic: AGENT_API_KEY_SET_MARKER })
    const active = await live(created.id, 'Protected active task')
    await call('agent:update', [created.id, { config: created.config }])
    expect(adapter.destroySession).not.toHaveBeenCalled(); expect(manager.getSession(active.sessionId)).toBeDefined()
    const cleared = await call('agent:update', [created.id, { config: { ...created.config, api_keys: { openai: '' } } }])
    expect(adapter.destroySession).toHaveBeenCalledWith(active.sessionId, expect.any(Object))
    expect(adapter.notifyConfigChanged).toHaveBeenCalledOnce()
    expect(cleared?.config.api_keys).toEqual({ anthropic: AGENT_API_KEY_SET_MARKER })
    expect(db.getAgent(created.id)?.config.api_keys).toEqual({ openai: '', anthropic: 'other-private-key' })
  })

  it('rejects invented saved markers before storage or lifecycle changes', async () => {
    await expect(call('agent:create', [{ name: 'Invented key', config: { api_keys: { openai: AGENT_API_KEY_SET_MARKER } } }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const agent = db.createAgent({ name: 'No keys' })!
    const active = await live(agent.id, 'No keys task')
    await expect(call('agent:update', [agent.id, { config: { ...agent.config, coding_agent: CodingAgentType.OPENCODE, api_keys: { anthropic: AGENT_API_KEY_SET_MARKER } } }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(manager.getSession(active.sessionId)).toBeDefined(); expect(adapter.destroySession).not.toHaveBeenCalled()
    expect(db.getAgent(agent.id)?.config.api_keys).toBeUndefined(); expect(events).toEqual([])
  })

  it('checks secret, global-skill and MCP read grants before accepting configuration references', async () => {
    const secret = db.createSecret({ name: 'Scoped', description: '', env_var_name: 'SCOPED_TOKEN', value: 'synthetic-secret' })!
    const server = db.createMcpServer({ name: 'Scoped MCP' })!
    const skill = db.createSkill({ name: 'Scoped skill', description: '', content: 'Instruction' })!
    const agent = db.createAgent({ name: 'Reference owner' })!
    const active = await live(agent.id, 'Reference task')
    for (const [field, refs, authority] of [
      ['secret_ids', [secret.id], 'canAccessSecret'], ['mcp_servers', [server.id], 'canAccessMcpServer'], ['skill_ids', [skill.id], 'canAccessGlobalSkills']
    ] as const) {
      const original = options[authority]; options[authority] = () => false
      await expect(call('agent:update', [agent.id, { config: { ...agent.config, coding_agent: CodingAgentType.OPENCODE, [field]: [...refs] } }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      Reflect.set(options, authority, original)
    }
    expect(manager.getSession(active.sessionId)).toBeDefined(); expect(adapter.destroySession).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('encrypts and restores MCP environment, headers and registration secrets through the real database', () => {
    const metadata = { resource_url: 'https://example.test/mcp', authorization_server_url: 'https://example.test',
      authorization_endpoint: 'https://example.test/authorize', token_endpoint: 'https://example.test/token',
      registration_method: 'manual' as const, discovered_at: '2026-10-14T00:00:00Z', client_id: 'public-id', client_secret: 'private-registration' }
    const server = db.createMcpServer({ name: 'Protected MCP', type: 'remote', url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer private-header' }, environment: { TOKEN: 'private-env' },
      oauth_metadata: metadata })!
    const stored = db.db.prepare('SELECT headers, environment, oauth_metadata FROM mcp_servers WHERE id=?').get(server.id)
    expect(JSON.stringify(stored)).not.toMatch(/private-header|private-env|private-registration/)
    expect(server.headers).toEqual({ Authorization: 'Bearer private-header' }); expect(server.environment).toEqual({ TOKEN: 'private-env' })
    expect(server.oauth_metadata).toMatchObject({ client_secret: 'private-registration' })
    db.updateMcpServer(server.id, { environment: { TOKEN: 'replacement-env' }, headers: {}, oauth_metadata: { ...metadata, client_secret: '' } })
    expect(db.getMcpServer(server.id)).toMatchObject({ headers: {}, environment: { TOKEN: 'replacement-env' }, oauth_metadata: { client_secret: '' } })
    expect(JSON.stringify(db.db.prepare('SELECT environment FROM mcp_servers WHERE id=?').get(server.id))).not.toContain('replacement-env')
  })

  it('retains exact task-source ciphertext on public edits and clears the selected credential', () => {
    const source = db.createTaskSource({ name: 'Protected Notion', mcp_server_id: null, plugin_id: 'notion',
      config: { api_token: ' \uFEFFsynthetic-source-key ', data_source_id: 'source-one' } })!
    const before = JSON.parse((db.db.prepare('SELECT config FROM task_sources WHERE id=?').get(source.id) as { config: string }).config)
    expect(before.api_token).toContain('21x-record-credential:v1:'); expect(before.api_token).not.toContain('synthetic-source-key')
    expect(source.config.api_token).toBe(' \uFEFFsynthetic-source-key ')
    db.updateTaskSource(source.id, { config: { data_source_id: 'source-two' } })
    const after = JSON.parse((db.db.prepare('SELECT config FROM task_sources WHERE id=?').get(source.id) as { config: string }).config)
    expect(after.api_token).toBe(before.api_token)
    expect(db.getTaskSource(source.id)?.config).toMatchObject({ data_source_id: 'source-two', api_token: ' \uFEFFsynthetic-source-key ' })
    db.updateTaskSource(source.id, { config: { api_token: '' } })
    expect(db.getTaskSource(source.id)?.config.api_token).toBe('')
  })

  it('deletes after owned teardown, cancels real queued references and removes fallback/default references', async () => {
    const agent = db.createAgent({ name: 'Delete owner', config: { coding_agent: 'opencode', concurrency_cap: 1, max_parallel_sessions: 1 } })!
    const active = await live(agent.id, 'Owned active task')
    const queued = db.createTask({ title: 'Queued reference' })!; db.updateTask(queued.id, { agent_id: agent.id })
    expect((await manager.requestSession(agent.id, queued.id)).status).toBe('queued')
    const fallback = db.createAgent({ name: 'Fallback reference', config: { coding_agent: 'codex', fallback_agent_ids: [agent.id] } })!
    db.setSetting('default_agent_id', agent.id)
    expect(await call('agent:delete', [agent.id])).toBe(true)
    expect(db.getAgent(agent.id)).toBeUndefined()
    expect(manager.getSession(active.sessionId)).toBeUndefined()
    expect(manager.getStartQueue().some(row => row.agentId === agent.id)).toBe(false)
    expect(db.getAgent(fallback.id)?.config.fallback_agent_ids).toEqual([])
    expect(db.getSetting('default_agent_id')).toBe('')
    expect(adapter.destroySession).toHaveBeenCalledWith(active.sessionId, expect.any(Object))
    expect(events).toEqual([{ operation: 'tasks:refresh', payload: {} }])
  })

  it('publishes accepted effects once and latches notification failure without retrying the mutation', async () => {
    options.emit = () => { throw new Error('Sink disconnected') }
    await expect(call('agent:create', [{ name: 'Accepted record' }])).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(db.getAgents().map(agent => agent.name)).toEqual(['Accepted record'])
    expect(fatal).toHaveBeenCalledOnce()
    await expect(call('agent:create', [{ name: 'Must not be created' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(db.getAgents()).toHaveLength(1)
  })

  it('queries actual backend methods with bounded public projection and explicit missing backend state', async () => {
    const result = await call('agentConfig:getProviders', ['http://localhost:4096', 'opencode'])
    expect(result).toMatchObject({ providers: [{ id: 'provider', models: [{ id: 'model' }] }] })
    expect(adapter.notifyConfigChanged).not.toHaveBeenCalled(); expect(adapter.getProviders).toHaveBeenCalledWith('http://localhost:4096', undefined)
    expect(await call('agentConfig:listModels', ['codex'])).toEqual([{ id: 'model', name: 'Model' }])
    expect(adapter.listModels).toHaveBeenCalledOnce()
    expect(await call('agentConfig:getProviders', [undefined, 'claude-code'])).toBeNull()
    expect(adapter.getProviders).toHaveBeenCalledOnce()
    options.canQueryBackend = () => false
    await expect(call('agentConfig:listModels', ['codex'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(adapter.listModels).toHaveBeenCalledOnce()
  })

  it('checks the actual default endpoint and rejects unauthorized config endpoints before Stop', async () => {
    const queryAuthority = vi.fn(() => true)
    options.canQueryBackend = queryAuthority
    await call('agentConfig:getProviders', [])
    expect(queryAuthority).toHaveBeenCalledWith('opencode', 'http://localhost:4096', caller)
    const agent = db.createAgent({ name: 'Endpoint owner', config: { coding_agent: 'opencode' } })!
    const active = await live(agent.id, 'Endpoint work')
    options.canQueryBackend = (_backend, url) => url === 'http://localhost:4096'
    await expect(call('agent:update', [agent.id, { server_url: 'https://foreign.example' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('agent:create', [{ name: 'Foreign endpoint', server_url: 'https://foreign.example' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(manager.getSession(active.sessionId)).toBeDefined()
    expect(adapter.destroySession).not.toHaveBeenCalled()
    expect(adapter.notifyConfigChanged).not.toHaveBeenCalled()
    expect(db.getAgents()).toHaveLength(1)
  })

  it('retains cancelled late model flights until drain and rejects new admission after close', async () => {
    let release!: (value: Array<{ id: string; name: string }>) => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const pending = new Promise<Array<{ id: string; name: string }>>(resolve => { release = resolve })
    adapter.listModels.mockImplementation(async () => { entered(); return pending })
    const controller = new AbortController()
    const flight = call('agentConfig:listModels', ['codex'], controller.signal)
    await started; controller.abort()
    expect(backend.inflightCount).toBe(1)
    await expect(backend.close(20)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(db.db.open).toBe(true); expect(backend.inflightCount).toBe(1)
    release([{ id: 'late', name: 'Late model' }])
    await expect(flight).rejects.toMatchObject({ code: 'CANCELLED' })
    await backend.close()
    expect(backend.inflightCount).toBe(0)
    expect(events).toEqual([])
    await expect(call('agent:getAll', [])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('rejects untrusted/stale callers and pre-cancelled work before mutation', async () => {
    for (const identity of [{ ...caller, webviewId: 'foreign' }, { ...caller, principal: 'service' as const }, { ...caller, engineEpoch: 'previous-epoch' }]) {
      await expect(call('agent:create', [{ name: 'Forbidden' }], new AbortController().signal, identity)).rejects.toBeDefined()
    }
    const controller = new AbortController(); controller.abort()
    await expect(call('agent:create', [{ name: 'Cancelled' }], controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(db.getAgents()).toEqual([]); expect(events).toEqual([])
  })
})
