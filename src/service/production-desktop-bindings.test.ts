import { AGENT_INSTALLER_CODECS } from '../shared/agent-installer-codecs'
import { ARTIFACT_CODECS } from '../shared/artifact-codecs'
import { VOICE_MANAGEMENT_CODECS } from '../shared/voice-management-codecs'
import { MOBILE_CODECS } from '../shared/mobile-codecs'
import { SESSION_CONTEXT_CODECS } from '../shared/session-context-codecs'
import { CLAUDE_PLUGIN_CODECS } from '../shared/claude-plugin-codecs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProductionOwner, ProductionOwnerBootstrap } from './production-owner'
import type { ProductionDesktopBindingOptions } from './production-desktop-bindings'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AGENT_CONFIGURATION_CODECS } from '../shared/agent-configuration-codecs'
import type { DesktopCallerContext } from './transport/desktop-registry'
import { DATABASE_COMMAND_CODECS } from '../shared/database-desktop-codecs'
import { CONFIGURATION_COMMAND_CODECS } from '../shared/configuration-desktop-codecs'
import { CodingAgentType } from '../renderer/src/types'
import type { ChatProvider } from '../main/chat/providers/types'
import { PRODUCTION_SETTINGS_CODECS } from '../shared/production-settings-codecs'
import { COMMANDER_COMMAND_CODECS } from '../shared/commander-desktop-codecs'
import { MCP_CODECS } from '../shared/mcp-codecs'
import { TASK_SOURCE_CODECS } from '../shared/task-source-codecs'
import { TASK_SOURCE_PLUGIN_CODECS } from '../shared/task-source-plugin-codecs'
import { CONNECTOR_CODECS } from '../shared/connector-codecs'

const owned: Array<{ owner: ProductionOwner; root: string }> = [], finishers: Array<() => void> = []
let ownerModule: typeof import('./production-owner')
let bindingModule: typeof import('./production-desktop-bindings')
beforeEach(async () => {
  vi.resetModules()
  ownerModule = await import('./production-owner')
  bindingModule = await import('./production-desktop-bindings')
})
afterEach(async () => {
  for (const finish of finishers.splice(0)) finish()
  for (const { owner, root } of owned.splice(0)) { await owner.close(); rmSync(root, { recursive: true, force: true }) }
  vi.restoreAllMocks()
})
async function fixture(providerOverride?: ChatProvider, connectors = false, mobile = false, voice = false) {
  const { ProductionOwner } = ownerModule
  const { ProductionDesktopBindings } = bindingModule
  const root = mkdtempSync(join(tmpdir(), '21x-production-bindings-')), resourceRoot = join(root, 'resources')
  mkdirSync(resourceRoot)
  const mobileRoot = join(resourceRoot, 'mobile')
  if (mobile) { mkdirSync(mobileRoot); writeFileSync(join(mobileRoot, 'index.html'), '<main>Actual owned mobile fixture</main>') }
  const keys = new Map<string, Buffer>(), adapter = new FakeAdapter()
  const bootstrap: ProductionOwnerBootstrap = {
    profileId: 'production-bindings-fixture', paths: { profileRoot: join(root, 'profile'), workspaceRoot: join(root, 'workspaces'), attachmentRoot: join(root, 'attachments'), reposRoot: join(root, 'repos'), resourceRoot, tempRoot: join(root, 'temp') },
    credentials: { mode: 'create', store: { create: async (id, key) => { keys.set(id, Buffer.from(key)) }, load: async id => {
      const key = keys.get(id)
      if (!key) throw Object.assign(new Error('KEYSTORE_NO_ENTRY'), { code: 'KEYSTORE_NO_ENTRY' })
      return Buffer.from(key)
    } } },
    ...(mobile ? { mobile: { distRoot: mobileRoot, port: 0 } } : {}),
    ...(voice ? { voice: { node: process.env.TAURI_NODE_RUNTIME ?? process.execPath, recognitionWorker: join(resourceRoot, 'voice-worker.cjs'), speechWorker: join(resourceRoot, 'voice-tts-worker.cjs') } } : {}),
    managedTaskMcp: { disabled: true }, connectors: connectors ? { kind: 'enabled' } : { kind: 'disabled', reason: 'No connector resources in this fixture.' },
    native: { agents: { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, configuredMcp: 'disabled' },
      prepareRuntime: async () => {}, openExternal: async () => {}, notify: () => {}, emit: () => {}, sendUiCommand: () => ({ ok: false, detail: 'No fixture window.' }), drainOwnedProcesses: async () => ({ acknowledged: true }) }
  }
  const owner = new ProductionOwner(bootstrap, { createAdapter: () => adapter, createProvider: () => providerOverride ?? ({ id: 'fixture', model: 'fixture', async *stream() { yield { type: 'message_end', stopReason: 'end_turn' } } }),
    ...(connectors ? { connectorTransport: () => { throw new Error('Credential form fixture must not create a worker') } } : {}) })
  owned.push({ owner, root }); const services = await owner.start(), epoch = owner.snapshot().epoch
  const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: epoch, webviewId: 'main', origin: 'tauri://localhost' }
  const events: Array<{ operation: string; payload: unknown }> = []
  const trusted = (value: DesktopCallerContext) => value.engineEpoch === epoch && value.webviewId === 'main' && value.origin === 'tauri://localhost'
  const options: ProductionDesktopBindingOptions = { authority: {
    isTrustedDesktop: trusted, canAccessProject: (id, value, access) => trusted(value) && !!services.db.getProject(id) && (value.principal === 'trusted-desktop-main') && (access === 'read' || value.webviewId === 'main'),
    canAccessTask: (_id, value) => trusted(value), canAccessSource: (_id, value) => trusted(value),
    canAccessSession: (_id, value) => trusted(value), canAccessGlobalCommander: trusted,
    canAccessAgent: (_id, value) => trusted(value), canManageGlobalConfiguration: trusted, canQueryBackend: (_type, _url, value) => trusted(value),
    canCreateProject: trusted, canEditSettings: trusted, canAccessGlobalSkills: trusted, canChangeSkillScope: trusted, canReorderProjects: trusted,
    canReadSetting: (_key, value) => trusted(value), canWriteSetting: (_key, value) => trusted(value),
    canAccessSecret: (_id, value) => trusted(value), canCreateSecret: trusted,
    canAccessMcpServer: (_id, value) => trusted(value),
    canUseTransport: (_input, value) => trusted(value), canUseEnvironmentName: (_name, value) => trusted(value),
    canAccessConnector: (_id, value) => trusted(value), canUseSourcePlugin: (_id, value) => trusted(value),
    canCreateInstance: (_piece, value) => trusted(value), canUsePiece: (_piece, value) => trusted(value),
    canBorrowSourceCredentials: (_id, _plugin, value) => trusted(value), canResolveUnsavedConfig: (_plugin, value) => trusted(value),
    canManageMobile: trusted, canAccessMobileSession: (_id, value) => trusted(value),
    canAccessMarketplace: (_id, value) => trusted(value), canCreateMarketplace: (_data, value) => trusted(value),
    canAccessPluginName: (_name, _source, value) => trusted(value), canAccessPlugin: (_id, value) => trusted(value),
    canUseMarketplaceSource: (_source, value) => trusted(value), canUsePluginSource: (_source, _marketplace, _root, value) => trusted(value),
    canUsePluginAddress: (_address, value) => trusted(value),
    canAccessSkill: (_id, value) => trusted(value), canCreateGlobalSkill: (_data, value) => trusted(value),
    canCreateAgent: (_data, value) => trusted(value), canCreateMcpServer: (_data, value) => trusted(value),
    canUseSecretEnvironment: (_name, value) => trusted(value), canReadEnvironment: (_key, value) => trusted(value),
    canAccessTerminal: (_id, value) => trusted(value), resolveTerminalDirectory: (_id, value) => trusted(value)
      ? { cwd: bootstrap.paths.workspaceRoot, root: bootstrap.paths.workspaceRoot } : null },
    emit: (operation, payload) => events.push({ operation, payload }), fatal: () => {} }
  const backend = await ProductionDesktopBindings.attach(owner, options), signal = new AbortController().signal
  return { owner, services, backend, options, caller, signal, events }
}

describe('reviewed bindings attached to the actual production singleton', () => {
  it('borrows actual local voice owners while refusing unbound microphone, playback and hosted effects', async () => {
    const f = await fixture(undefined, false, false, true)
    const lease = f.owner.getVoiceBindingLease()!
    expect(lease.voice).toBe(f.services.voice!.voice); expect(lease.speech).toBe(f.services.voice!.speech)
    lease.assertVoiceOwners({ voice: lease.voice, speech: lease.speech })
    const snapshot = await f.backend.invoke('voice:getSnapshot', {}, f.caller, f.signal)
    expect(snapshot).toMatchObject({ defined: true, value: { enabled: false, state: 'disabled', turnId: null, runtime: { installed: false } } })
    const saved = await f.backend.invoke('voice:setEndpointSilence', VOICE_MANAGEMENT_CODECS['voice:setEndpointSilence'].encodeArguments([1.5]), f.caller, f.signal)
    expect(saved).toMatchObject({ defined: true, value: { success: true } })
    const grant = f.options.authority.canManageGlobalConfiguration
    f.options.authority.canManageGlobalConfiguration = () => false
    await expect(f.backend.invoke('voice:setEndpointSilence', VOICE_MANAGEMENT_CODECS['voice:setEndpointSilence'].encodeArguments([2]), f.caller, f.signal)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    f.options.authority.canManageGlobalConfiguration = grant
    await expect(f.backend.invoke('voice:installRuntime', {}, f.caller, f.signal)).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    for (const operation of ['voice:startTurn', 'voice:pushAudio', 'voice:confirm', 'voice:setShortcut', 'voice:tts:speak', 'voice:tts:preview', 'voice:tts:elevenlabs:setKey']) {
      await expect(f.backend.invoke(operation, {}, f.caller, f.signal)).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    }
    await f.owner.close()
    expect(() => lease.assertVoiceOwners({ voice: lease.voice, speech: lease.speech })).toThrow()
    expect(f.services.db.db.open).toBe(false)
  })

  it('keeps voice management absent when the trusted artifact has no worker pair', async () => {
    const f = await fixture()
    expect(f.owner.getVoiceBindingLease()).toBeNull()
    expect(f.backend.operationSchemas(f.caller)['voice:getSnapshot']).toBeUndefined()
    await expect(f.backend.invoke('voice:getSnapshot', {}, f.caller, f.signal)).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
  })
  it('borrows real CLI detection and artifact workspace ownership without exposing unbound installs or native file effects', async () => {
    const f = await fixture(), { db, agentDetection } = f.services
    expect(f.owner.getAgentInstallerBindingLease().detection).toBe(agentDetection)
    expect(agentDetection.childCount).toBe(0)
    const grant = f.options.authority.canManageGlobalConfiguration
    f.options.authority.canManageGlobalConfiguration = () => false
    await expect(f.backend.invoke('agent-installer:detect', AGENT_INSTALLER_CODECS['agent-installer:detect'].encodeArguments([]), f.caller, f.signal)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(agentDetection.childCount).toBe(0)
    f.options.authority.canManageGlobalConfiguration = grant
    await expect(f.backend.invoke('agent-installer:install', { agentName: 'codex' }, f.caller, f.signal)).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    const task = db.createTask({ title: 'Actual owned report' })!
    const directory = db.getWorkspaceDir(task.id)
    writeFileSync(join(directory, 'report.md'), 'Owned report\n')
    const scan = await f.backend.invoke('artifacts:scan', ARTIFACT_CODECS['artifacts:scan'].encodeArguments([task.id]), f.caller, f.signal)
    expect(scan).toMatchObject({ defined: true, value: [{ path: 'report.md' }] })
    const content = await f.backend.invoke('artifacts:read', ARTIFACT_CODECS['artifacts:read'].encodeArguments([task.id, 'report.md']), f.caller, f.signal)
    expect(content).toMatchObject({ defined: true, value: { kind: 'text', content: 'Owned report\n' } })
    f.options.authority.canAccessTask = () => false
    await expect(f.backend.invoke('artifacts:read', { taskId: task.id, relativePath: 'report.md' }, f.caller, f.signal)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.backend.invoke('shell:openExternal', { url: 'https://example.test' }, f.caller, f.signal)).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    await f.owner.close()
    expect(() => agentDetection.assertOpen()).toThrow()
    expect(db.db.open).toBe(false)
  })

  it('pairs against the actual mobile HTTP owner and sends a phone start through shared admission', async () => {
    const f = await fixture(undefined, false, true)
    expect(Object.keys(f.backend.operationSchemas(f.caller))).toHaveLength(133)
    const lease = f.owner.getMobileBindingLease()!
    expect(lease.deps.db).toBe(f.services.db); expect(lease.deps.agentManager).toBe(f.services.agents)
    expect(lease.deps.taskOwners?.automation).toBe(f.services.automation)
    await f.backend.invoke('mobile:setAccess', MOBILE_CODECS['mobile:setAccess'].encodeArguments([{ enabled: true }]), f.caller, f.signal)
    const infoWire = await f.backend.invoke('mobile:getInfo', {}, f.caller, f.signal) as { value: { url: string; port: number } }
    const info = infoWire.value, base = `http://127.0.0.1:${info.port}`
    expect(await (await fetch(base)).text()).toContain('Actual owned mobile fixture')
    expect((await fetch(base + '/api/tasks')).status).toBe(401)
    const post = async (path: string, body: unknown, token?: string) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) })
    const initiated = await post('/api/auth/pair/initiate', { code: new URL(info.url).searchParams.get('code') })
    expect(initiated.status).toBe(200)
    const pinWire = await f.backend.invoke('mobile:getPendingPin', {}, f.caller, f.signal) as { value: { pin: string; pairCodeId: string; expiresAt: number } }
    const pin = pinWire.value
    const event = f.backend.encodeOwnerEvent('mobile:pairing-initiated', pin)
    f.options.authority.canManageMobile = (_caller, access) => access === 'read'
    expect(f.backend.projectOwnerEvent('mobile:pairing-initiated', event, f.caller)).toBeUndefined()
    await expect(f.backend.invoke('mobile:getPendingPin', {}, f.caller, f.signal)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    f.options.authority.canManageMobile = () => true
    const paired = await (await post('/api/auth/pair/verify', { pin: pin.pin, pairCodeId: pin.pairCodeId })).json() as { sessionToken: string; sessionId: string }
    const agent = f.services.db.getAgents()[0], task = f.services.db.createTask({ title: 'Phone shared owner' })!
    f.services.db.updateAgent(agent.id, { config: { coding_agent: 'pi', api_keys: { openai: 'private-phone-fixture' } } })
    const start = await post('/api/sessions/start', { agentId: agent.id, taskId: task.id }, paired.sessionToken)
    expect(start.status).toBe(200)
    expect(f.services.agents.findSessionByTaskId(task.id)).toMatchObject({ sessionId: expect.any(String) })
    const agents = await (await fetch(base + '/api/agents', { headers: { Authorization: 'Bearer ' + paired.sessionToken } })).text()
    expect(agents).not.toContain('private-phone-fixture'); expect(agents).not.toContain('api_keys')
    await expect(f.backend.invoke('mobile:startTunnel', {}, f.caller, f.signal)).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    await f.backend.invoke('mobile:revokeSession', MOBILE_CODECS['mobile:revokeSession'].encodeArguments([paired.sessionId]), f.caller, f.signal)
    expect((await fetch(base + '/api/tasks', { headers: { Authorization: 'Bearer ' + paired.sessionToken } })).status).toBe(401)
    await f.owner.close(); expect(f.services.db.db.open).toBe(false)
    await expect(fetch(base)).rejects.toThrow()
  })
  it('binds connector credentials to the actual runtime and profile key without starting a worker', async () => {
    const f = await fixture(undefined, true)
    expect(Object.keys(f.backend.operationSchemas(f.caller))).toHaveLength(130)
    const lease = f.owner.getConnectorBindingLease()!
    const ensured = await f.backend.invoke('connectors:ensureInstance', CONNECTOR_CODECS['connectors:ensureInstance'].encodeArguments(['@activepieces/piece-trello']), f.caller, f.signal)
    const id = (ensured as { value: { instanceId: string } }).value.instanceId
    expect(await f.backend.invoke('connectors:setCredentials', CONNECTOR_CODECS['connectors:setCredentials'].encodeArguments([id, { username: 'fixture-key', password: 'fixture-token' }, 'persistent']), f.caller, f.signal)).toEqual({ defined: true, value: { ok: true, storage: 'persistent' } })
    expect(lease.credentialStore.get(id)).toEqual({ type: 'basic', username: 'fixture-key', password: 'fixture-token' })
    const row = f.services.db.db.prepare('SELECT auth FROM connector_instances WHERE id=?').get(id) as { auth: Buffer }
    expect(row.auth.toString()).not.toContain('fixture-token')
    expect(await f.backend.invoke('connectors:credentialStatus', { instanceId: id }, f.caller, f.signal)).toEqual({ defined: true, value: { storage: 'persistent', persistentAvailable: true } })
    expect(f.owner.getConnectorBindingLease()!.runtime).toBe(lease.runtime)
    expect(lease.runtime.client.starts).toBe(0)
    await f.backend.invoke('connectors:clearCredentials', { instanceId: id }, f.caller, f.signal)
    expect(lease.credentialStore.get(id)).toBeNull()
  })
  it('borrows the actual plugin registry and refuses absent connector ownership', async () => {
    const f = await fixture()
    const result = await f.backend.invoke('plugin:list', TASK_SOURCE_PLUGIN_CODECS['plugin:list'].encodeArguments([]), f.caller, f.signal)
    expect(result).toEqual({ defined: true, value: f.services.registry.list() })
    const doc = await f.backend.invoke('plugin:getDocumentation', TASK_SOURCE_PLUGIN_CODECS['plugin:getDocumentation'].encodeArguments(['notion']), f.caller, f.signal)
    expect(doc).toEqual({ defined: true, value: f.services.registry.getDocumentation('notion') })
    expect(f.owner.getConnectorBindingLease()).toBeNull()
    await expect(f.backend.invoke('connectors:bridgePieces', CONNECTOR_CODECS['connectors:bridgePieces'].encodeArguments([]), f.caller, f.signal)).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    f.options.authority.canUseSourcePlugin = () => false
    expect(await f.backend.invoke('plugin:list', {}, f.caller, f.signal)).toEqual({ defined: true, value: [] })
  })
  it('binds protected agent, MCP and source records to the same actual singleton without enabling missing transports', async () => {
    const f = await fixture(), { db } = f.services
    const agent = await f.backend.invoke('agent:create', AGENT_CONFIGURATION_CODECS['agent:create'].encodeArguments([
      { name: 'Protected actual agent', config: { api_keys: { openai: 'synthetic-agent-secret' } } }
    ]), f.caller, f.signal)
    expect(agent).toMatchObject({ defined: true, value: { config: { api_keys: { openai: '__21x_api_key_set__' } } } })
    const mcp = await f.backend.invoke('mcp:create', MCP_CODECS['mcp:create'].encodeArguments([
      { name: 'Protected actual MCP', type: 'remote', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer synthetic-mcp-secret' } }
    ]), f.caller, f.signal)
    expect(mcp).toMatchObject({ defined: true, value: { headers: { Authorization: '__21x_mcp_secret_set__' } } })
    const source = await f.backend.invoke('taskSource:create', TASK_SOURCE_CODECS['taskSource:create'].encodeArguments([
      { name: 'Protected actual source', plugin_id: 'notion', mcp_server_id: null, config: { api_token: 'synthetic-source-secret', data_source_id: 'data-one' } }
    ]), f.caller, f.signal)
    expect(source).toMatchObject({ defined: true, value: { config: { api_token: '__21x_api_key_set__', data_source_id: 'data-one' } } })
    const stored = JSON.stringify({
      agents: db.db.prepare('SELECT config FROM agents').all(), mcp: db.db.prepare('SELECT headers FROM mcp_servers').all(),
      sources: db.db.prepare('SELECT config FROM task_sources').all()
    })
    expect(stored).not.toMatch(/synthetic-agent-secret|synthetic-mcp-secret|synthetic-source-secret/)
    expect(stored).toContain('21x-record-credential:v1:')
    await expect(f.backend.invoke('mcp:testConnection', MCP_CODECS['mcp:testConnection'].encodeArguments([
      { name: 'Missing configured transport', type: 'remote', url: 'https://example.test/mcp' }
    ]), f.caller, f.signal)).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(f.services.mcpProbes.pendingCount).toBe(0)
    const sources = await f.backend.invoke('taskSource:getAll', TASK_SOURCE_CODECS['taskSource:getAll'].encodeArguments([]), f.caller, f.signal)
    expect(sources).toMatchObject({ defined: true, value: [{ config: { api_token: '__21x_api_key_set__' } }] })
    expect(JSON.stringify(sources)).not.toContain('synthetic-source-secret')
  })
  it('fences actual conversation and briefing owners before changing a global key and joins ignored cancellation', async () => {
    let finish!: () => void, entered!: () => void, calls = 0
    const gate = new Promise<void>(resolve => { finish = resolve })
    const entry = new Promise<void>(resolve => { entered = resolve })
    const signals: AbortSignal[] = []
    const provider: ChatProvider = { id: 'controlled', model: 'controlled', async *stream(_request, signal) {
      signals.push(signal); if (++calls === 3) entered()
      await gate
      yield { type: 'message_end', stopReason: 'end_turn' }
    } }
    const f = await fixture(provider); finishers.push(finish)
    const chat = f.services.chat.startTurn({ provider, messages: [{ role: 'user', content: 'Chat' }] }, () => {})
    const session = f.services.commanderStore.createSession()
    const commander = f.services.commander.sendUserMessage(session.id, 'Commander')
    const briefing = f.services.coordination.runBriefingNow()
    await entry
    const write = f.backend.invoke('settings:set', PRODUCTION_SETTINGS_CODECS['settings:set'].encodeArguments(['openai_api_key', 'controlled-new-key']), f.caller, f.signal)
    await vi.waitFor(() => expect(signals.every(signal => signal.aborted)).toBe(true))
    expect(f.services.db.getSetting('openai_api_key')).toBeUndefined()
    expect(() => f.services.chat.startTurn({ provider, messages: [] }, () => {})).toThrow('CONFIGURATION_CHANGING')
    expect(() => f.services.commander.sendUserMessage(session.id, 'New request')).toThrow('CONFIGURATION_CHANGING')
    await expect(f.services.coordination.runBriefingNow()).rejects.toThrow('CONFIGURATION_CHANGING')
    finish(); await Promise.all([chat.done, commander.done, briefing, write])
    expect(f.services.db.getSetting('openai_api_key')).toBe('controlled-new-key')
    expect(f.services.db.db.prepare('SELECT value FROM settings WHERE key=?').get('openai_api_key')).not.toEqual({ value: 'controlled-new-key' })
    const read = await f.backend.invoke('settings:get', PRODUCTION_SETTINGS_CODECS['settings:get'].encodeArguments(['openai_api_key']), f.caller, f.signal)
    expect(read).toEqual({ defined: true, value: '__21x_api_key_set__' })
    await f.services.chat.startTurn({ provider, messages: [] }, () => {}).done
  })
  it('borrows the actual context and plugin owners, with independently revocable grants', async () => {
    const f = await fixture(), session = f.services.commanderStore.createSession()
    const context = SESSION_CONTEXT_CODECS['sessionContext:getSnapshot']
    const wire = await f.backend.invoke('sessionContext:getSnapshot', context.encodeArguments([{ kind: 'commander', ownerId: session.id }]), f.caller, f.signal)
    expect(wire).toMatchObject({ defined: true, value: { scope: { kind: 'commander', ownerId: session.id } } })
    const plugin = CLAUDE_PLUGIN_CODECS['claudePlugin:getMarketplaceSources']
    expect(await f.backend.invoke('claudePlugin:getMarketplaceSources', plugin.encodeArguments([]), f.caller, f.signal)).toMatchObject({ defined: true, value: expect.any(Array) })
    f.options.authority.canAccessSession = () => false
    await expect(f.backend.invoke('sessionContext:getSnapshot', context.encodeArguments([{ kind: 'commander', ownerId: session.id }]), f.caller, f.signal)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    f.options.authority.canManageGlobalConfiguration = () => false
    await expect(f.backend.invoke('claudePlugin:getMarketplaceSources', plugin.encodeArguments([]), f.caller, f.signal)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
  it('joins ignored actual chat work before changing plugin state and retains the provider fence', async () => {
    let finish!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve }), entry = new Promise<void>(resolve => { entered = resolve })
    let signal!: AbortSignal
    const provider: ChatProvider = { id: 'controlled', model: 'controlled', async *stream(_request, current) { signal = current; entered(); await gate; yield { type: 'message_end', stopReason: 'end_turn' } } }
    const f = await fixture(provider); finishers.push(finish)
    const source = f.services.plugins.getMarketplaceSources()[0]
    const installed = f.services.db.createInstalledPlugin({ name: 'controlled-plugin', marketplace_id: source.id, manifest: { name: 'controlled-plugin' } })
    const chat = f.services.chat.startTurn({ provider, messages: [] }, () => {}); await entry
    const write = f.backend.invoke('claudePlugin:disablePlugin', CLAUDE_PLUGIN_CODECS['claudePlugin:disablePlugin'].encodeArguments([installed.id]), f.caller, f.signal)
    await vi.waitFor(() => expect(signal.aborted).toBe(true))
    expect(f.services.db.getInstalledPlugin(installed.id)?.enabled).toBe(true)
    expect(() => f.services.chat.startTurn({ provider, messages: [] }, () => {})).toThrow('CONFIGURATION_CHANGING')
    finish(); await Promise.all([chat.done, write])
    expect(f.services.db.getInstalledPlugin(installed.id)?.enabled).toBe(false)
  })
  it('shares one database across task, content and agent mutations without replacing its lifecycle owner', async () => {
    const f = await fixture(), db = f.services.db
    expect(Object.keys(f.backend.operationSchemas(f.caller))).toHaveLength(123)
    const task = await f.backend.invoke('db:createTask', DATABASE_COMMAND_CODECS['db:createTask'].encodeArguments([{ title: 'Shared task' }]), f.caller, f.signal)
    expect(task).toMatchObject({ defined: true, value: { title: 'Shared task' } })
    const skill = await f.backend.invoke('skills:create', CONFIGURATION_COMMAND_CODECS['skills:create'].encodeArguments([{ name: 'Shared skill', description: 'Description', content: 'Instructions' }]), f.caller, f.signal)
    expect(skill).toMatchObject({ defined: true, value: { name: 'Shared skill' } })
    const agent = await f.backend.invoke('agent:create', AGENT_CONFIGURATION_CODECS['agent:create'].encodeArguments([{ name: 'Shared agent', config: { coding_agent: CodingAgentType.CODEX } }]), f.caller, f.signal)
    expect(agent).toMatchObject({ defined: true, value: { name: 'Shared agent' } })
    expect(db.getTasks().some(task => task.title === 'Shared task')).toBe(true)
    expect(db.getSkills().some(skill => skill.name === 'Shared skill')).toBe(true)
    expect(db.getAgents().some(agent => agent.name === 'Shared agent')).toBe(true)
    expect(f.events.map(event => event.operation)).toEqual(expect.arrayContaining(['task:created', 'skills:changed', 'tasks:refresh']))
    expect((await f.owner.start()).db).toBe(db)
    await f.owner.close(); expect(db.db.open).toBe(false)
    await expect(f.backend.invoke('db:getTasks', {}, f.caller, f.signal)).rejects.toMatchObject({ code: 'DISCONNECTED' })
  })
  it('denies stale/foreign callers, browser operations and nonexistent session owners', async () => {
    const f = await fixture()
    await expect(f.backend.invoke('db:getTasks', {}, { ...f.caller, engineEpoch: 'stale' }, f.signal)).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    await expect(f.backend.invoke('db:getTasks', {}, { ...f.caller, webviewId: 'artifact' }, f.signal)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.backend.invoke('browser:create', {}, f.caller, f.signal)).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    await expect(f.backend.invoke('db:updateTask', { id: 'invented', data: { status: 'completed' } }, f.caller, f.signal)).resolves.toEqual({ defined: false })
    await expect(f.backend.invoke('agentSession:start', { agentId: 'invented', taskId: 'invented' }, f.caller, f.signal)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
  it('keeps a cancelled raw model flight and the database lease until explicit drain retry', async () => {
    const f = await fixture(); let finish!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve }), entry = new Promise<void>(resolve => { entered = resolve })
    finishers.push(finish)
    vi.spyOn(f.services.agents, 'getProviders').mockImplementation(async () => { entered(); await gate; return { providers: [], default: {} } })
    const control = new AbortController()
    const reading = f.backend.invoke('agentConfig:getProviders', AGENT_CONFIGURATION_CODECS['agentConfig:getProviders'].encodeArguments([undefined, 'pi']), f.caller, control.signal)
    const result = expect(reading).rejects.toMatchObject({ code: 'CANCELLED' }); await entry; control.abort()
    await expect(f.owner.close(5)).rejects.toThrow('OWNER_DRAIN_BLOCKED')
    expect(f.services.db.db.open).toBe(true); expect(f.owner.snapshot().owned).toBe(true)
    finish(); await result; await f.owner.close(); expect(f.services.db.db.open).toBe(false)
  })
  it('requires write authority separately from read authority at the borrowed database boundary', async () => {
    const f = await fixture()
    f.options.authority.canAccessProject = (id, _caller, access) => !!f.services.db.getProject(id) && access === 'read'
    // The root identity is still trusted, but project write ownership is withdrawn.
    await expect(f.backend.invoke('db:createTask', { data: { title: 'Denied write' } }, f.caller, f.signal)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.backend.invoke('db:getTasks', {}, f.caller, f.signal)).resolves.toMatchObject({ defined: true })
    expect(f.services.db.getTasks().some(task => task.title === 'Denied write')).toBe(false)
  })
  it('projects actual owner events with current read grants and closes publication on invalid provider output', async () => {
    const f = await fixture(), task = f.services.db.createTask({ title: 'Scoped event' })!
    const wire = f.backend.encodeOwnerEvent('task:updated', { taskId: task.id, updates: { title: 'Fresh title' } })
    expect(f.backend.projectOwnerEvent('task:updated', wire, f.caller)).toEqual(wire)
    f.options.authority.canAccessTask = () => false
    expect(f.backend.projectOwnerEvent('task:updated', wire, f.caller)).toBeUndefined()
    expect(f.backend.projectOwnerEvent('tasks:refresh', {}, f.caller)).toEqual({})
    f.options.authority.canAccessProject = () => false
    expect(f.backend.projectOwnerEvent('tasks:refresh', {}, f.caller)).toBeUndefined()
    const fatal = vi.fn(); f.options.fatal = fatal
    expect(() => f.backend.encodeOwnerEvent('agent:status', { sessionId: 'invented', taskId: task.id, agentId: 'invented', status: 'manufactured' })).toThrow()
    expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_RESULT' }))
    await expect(f.backend.invoke('db:getTasks', {}, f.caller, f.signal)).rejects.toMatchObject({ code: 'DISCONNECTED' })
  })
  it('uses the same Commander store for session creation and durable history while enforcing session read scope', async () => {
    const f = await fixture(), codec = COMMANDER_COMMAND_CODECS['commander:createSession']
    const result = await f.backend.invoke('commander:createSession', codec.encodeArguments([{ title: 'Production conversation' }]), f.caller, f.signal)
    expect(result).toMatchObject({ defined: true, value: { title: 'Production conversation' } })
    if (!result || typeof result !== 'object' || Array.isArray(result) || !('value' in result) || typeof result.value !== 'object' || !result.value || Array.isArray(result.value)) throw new Error('Missing Commander session')
    const id = result.value.id as string
    expect(f.services.commanderStore.getSession(id)?.title).toBe('Production conversation')
    const history = COMMANDER_COMMAND_CODECS['commander:listMessages']
    await expect(f.backend.invoke('commander:listMessages', history.encodeArguments([id]), f.caller, f.signal)).resolves.toMatchObject({ value: { messages: [], activeTurnId: null } })
    f.options.authority.canAccessSession = () => false
    await expect(f.backend.invoke('commander:listMessages', history.encodeArguments([id]), f.caller, f.signal)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})
