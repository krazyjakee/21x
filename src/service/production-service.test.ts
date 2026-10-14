import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ProductionService as ProductionServiceType, SealedProductionServiceHost } from './production-service'
let ProductionService: typeof import('./production-service').ProductionService
let sealProductionServiceHost: typeof import('./production-service').sealProductionServiceHost
beforeEach(async () => {
  vi.resetModules()
  ;({ ProductionService, sealProductionServiceHost } = await import('./production-service'))
})
import { PRODUCTION_COMMAND_CODECS, PRODUCTION_EVENT_CODECS, validateProductionEventWire, type ProductionDesktopBindingOptions } from './production-desktop-bindings'
import { PRODUCTION_HOST_SCHEMAS, type ProductionLaunchDescriptor } from '../shared/production-bootstrap'
import { ServicePeer, type OperationSchema } from './transport/peer'
import { hasExactKeys, isBootstrapResult, isRecord, type JsonValue } from '../shared/service-protocol'
import type { CodingAgentAdapter } from '../main/adapters/coding-agent-adapter'
import type { ChatProvider, ChatProviderEvent } from '../main/chat/providers/types'
import { makeTask } from '../../test/helpers/task-fixtures'
import { acquireProfileLock } from '../main/platform/profile-lock'
import { PRODUCTION_RESOURCE_PINS, verifyProductionResources } from './production-stdio'

const roots: string[] = [], services: ProductionServiceType[] = [], hosts: ServicePeer[] = [], release: Array<() => void> = []
afterEach(async () => {
  for (const finish of release.splice(0)) finish()
  for (const service of services.splice(0)) await service.close()
  for (const host of hosts.splice(0)) { host.disconnect(); await host.waitForHandlers() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})
function deferred() { let finish!: () => void; const promise = new Promise<void>(done => { finish = done }); return { promise, finish } }
function descriptor(root: string): ProductionLaunchDescriptor {
  return { version: 1, kind: 'production-private-launch', launchId: 'launch_transport_001', profileId: 'synthetic-profile',
    profileIntent: 'create-new', buildIdentity: 'production-fixture', resourceManifestSha256: 'a'.repeat(64),
    paths: { profileRoot: join(root, 'profile'), workspaceRoot: join(root, 'workspaces'), attachmentRoot: join(root, 'attachments'),
      reposRoot: join(root, 'repos'), resourceRoot: join(root, 'resources'), tempRoot: join(root, 'temp') },
    capabilities: { externalUrls: 'unsupported', notifications: 'unsupported', energy: 'unsupported', ui: 'unsupported', voice: 'unsupported',
      configuredMcp: 'disabled', managedTaskMcp: 'disabled', connectors: 'disabled' } }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), '21x-private-production-')); roots.push(root)
  const launch = descriptor(root); mkdirSync(launch.paths.resourceRoot)
  let permitted = true, badDrain = false, preparation: Promise<void> | null = null
  const nativeCalls: string[] = [], wireEvents: Array<{ operation: string; payload: JsonValue }> = []
  const keys = new Map<string, Buffer>()
  const adapter = { initialize: vi.fn(async () => {}), createSession: vi.fn(async () => 'controlled_native'), resumeSession: vi.fn(async () => []),
    sendPrompt: vi.fn(async () => {}), getStatus: vi.fn(async () => ({ type: 'busy' })), pollMessages: vi.fn(async () => []),
    abortPrompt: vi.fn(async () => {}), destroySession: vi.fn(async () => {}), checkHealth: vi.fn(async () => ({ available: true })) }
  const provider: ChatProvider = { id: 'controlled', model: 'controlled', async *stream(): AsyncGenerator<ChatProviderEvent> { yield { type: 'message_end', stopReason: 'end_turn' } } }
  const check = (): boolean => permitted
  const authority: ProductionDesktopBindingOptions['authority'] = { isTrustedDesktop: check, canAccessTask: check, canAccessSource: check,
    canAccessProject: check, canAccessAgent: check, canAccessSession: check, canAccessGlobalCommander: check,
    canManageGlobalConfiguration: check, canQueryBackend: check, canCreateProject: check, canEditSettings: check,
    canAccessGlobalSkills: check, canChangeSkillScope: check, canReorderProjects: check, canReadSetting: check, canWriteSetting: check, canAccessSecret: check,
    canCreateSecret: check, canUseSecretEnvironment: check, canReadEnvironment: check, canAccessTerminal: check, canAccessMcpServer: check,
    canUseTransport: check, canUseEnvironmentName: check, canAccessConnector: check, canUseSourcePlugin: check,
    canCreateInstance: check, canUsePiece: check, canBorrowSourceCredentials: check, canResolveUnsavedConfig: check,
    canAccessMarketplace: check, canCreateMarketplace: check, canAccessPluginName: check, canAccessPlugin: check,
    canUseMarketplaceSource: check, canUsePluginAddress: check, canUsePluginSource: check, canAccessSkill: check,
    canCreateGlobalSkill: check, canCreateAgent: check, canCreateMcpServer: check,
    resolveTerminalDirectory: () => ({ cwd: launch.paths.workspaceRoot, root: launch.paths.workspaceRoot }) }
  const schemas: Record<string, OperationSchema> = Object.fromEntries(Object.entries(PRODUCTION_COMMAND_CODECS).map(([operation, codec]) => [operation, {
    validatePayload: (value: unknown) => { try { return codec.validateArguments(codec.decodeArguments(value as JsonValue)) } catch { return false } }, validateResult: codec.validateWireResult
  }]))
  schemas['engine.ping'] = { validatePayload: value => isRecord(value) && hasExactKeys(value, []), validateResult: isBootstrapResult }
  schemas['engine.initialize'] = { validatePayload: value => isRecord(value), validateResult: isBootstrapResult }
  schemas['engine.shutdown'] = { validatePayload: value => isRecord(value), validateResult: value => isRecord(value) && value.stopped === true }
  schemas['host.production.prepare'] = { ...PRODUCTION_HOST_SCHEMAS['host.production.prepare'], handle: async payload => {
    expect(payload).toEqual({ launchId: launch.launchId, resourceManifestSha256: launch.resourceManifestSha256 }); nativeCalls.push('prepare')
    await preparation
    return { launchId: launch.launchId, ready: true, processTree: 'supervised' }
  } }
  schemas['host.production.drain'] = { ...PRODUCTION_HOST_SCHEMAS['host.production.drain'], handle: payload => {
    expect(payload).toEqual({ launchId: launch.launchId }); nativeCalls.push('drain')
    const id = badDrain ? 'foreign_launch_001' : launch.launchId; badDrain = false
    return { launchId: id, acknowledged: true }
  } }
  const deliver = (peer: ServicePeer, bytes: Uint8Array): void => { for (let offset = 0; offset < bytes.length; offset += 79) peer.receive(bytes.subarray(offset, offset + 79)) }
  const host = new ServicePeer({ role: 'host', engineEpoch: null, operations: schemas,
    eventSchemas: Object.fromEntries(Object.keys(PRODUCTION_EVENT_CODECS).map(operation => [operation, (value: unknown) => validateProductionEventWire(operation, value)])),
    write: async bytes => { deliver(service.peer, bytes) }, onEvent: event => { wireEvents.push({ operation: event.operation, payload: event.payload }) } })
  hosts.push(host)
  const service = new ProductionService(sealProductionServiceHost({ descriptor: launch, authority,
    caller: { principal: 'trusted-desktop-main', webviewId: 'main', origin: 'tauri://localhost' }, unbridgedOwnerEvent: vi.fn(),
    boundaries: { createAdapter: () => adapter as unknown as CodingAgentAdapter, createProvider: () => provider },
    constructBootstrap: callbacks => ({ profileId: launch.profileId, paths: launch.paths,
      credentials: { mode: 'create', store: { create: async (id, key) => { keys.set(id, Buffer.from(key)) }, load: async id => Buffer.from(keys.get(id)!) } },
      connectors: { kind: 'disabled', reason: 'Controlled fixture has no packaged connectors' }, managedTaskMcp: { disabled: true },
      native: { agents: { renderer: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, configuredMcp: 'disabled' },
        prepareRuntime: callbacks.prepare, drainOwnedProcesses: callbacks.drain, emit: callbacks.emitOwnerEvent,
        openExternal: callbacks.openExternal, notify: callbacks.notify, sendUiCommand: () => ({ ok: false, detail: 'Explicit fixture capability' }) } })
  }), { write: async bytes => { deliver(host, bytes) } }); services.push(service)
  const initialize = async (): Promise<void> => {
    const ping = await host.request('engine.ping', {})
    expect(ping).toMatchObject({ engineEpoch: service.owner.snapshot().epoch })
    await host.request('engine.initialize', { protocolVersion: 1, launchId: launch.launchId })
  }
  return { root, launch, service, host, adapter, wireEvents, nativeCalls, initialize, deny: () => { permitted = false }, rejectDrain: () => { badDrain = true },
    holdPreparation: (raw: Promise<void>) => { preparation = raw } }
}

describe('actual private production peer', () => {
  it('negotiates epoch before native initialization and binds the singleton database/admission owner', async () => {
    const f = fixture(); await f.initialize()
    const actual = f.service.getReadyServices()!
    const agent = actual.db.getAgents()[0]; actual.db.updateAgent(agent.id, { config: { coding_agent: 'pi', max_parallel_sessions: 1 } })
    const task = actual.db.createTask(makeTask())!; actual.db.updateTask(task.id, { agent_id: agent.id })
    const result = await f.host.request('agentSession:start', { agentId: agent.id, taskId: task.id })
    expect(result).toMatchObject({ defined: true, value: { sessionId: 'controlled_native' } })
    expect(f.adapter.sendPrompt).toHaveBeenCalledOnce()
    const second = actual.db.createTask(makeTask({ title: 'Actually queued' }))!; actual.db.updateTask(second.id, { agent_id: agent.id })
    expect(await f.host.request('agentSession:start', { agentId: agent.id, taskId: second.id })).toMatchObject({ defined: true, value: { queued: true, queuePosition: 1 } })
    expect(actual.agents.getStartQueue().some(entry => entry.taskId === second.id)).toBe(true)
    expect(f.nativeCalls).toEqual(['prepare'])
    expect(f.wireEvents.some(event => event.operation === 'agent:status')).toBe(true)
    expect(await f.host.request('engine.shutdown', {})).toEqual({ stopped: true })
    expect(actual.db.db.open).toBe(false)
    expect(f.nativeCalls).toEqual(['prepare', 'drain'])
  }, 15_000)
  it('rejects unsealed/RPC bootstrap, a second initialization and withdrawn read/write scope', async () => {
    expect(() => new ProductionService({ construction: {} } as SealedProductionServiceHost, { write: async () => {} })).toThrow('Invalid operation arguments')
    const f = fixture(); await f.initialize()
    await expect(f.host.request('engine.initialize', { protocolVersion: 1, launchId: f.launch.launchId })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.host.request('engine.initialize', { protocolVersion: 1, launchId: f.launch.launchId, paths: { profileRoot: '/foreign' } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    f.deny()
    await expect(f.host.request('project:getAll', {})).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.host.request('settings:set', { key: 'theme', value: 'dark' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  }, 15_000)
  it('does not release its physical profile on a foreign native drain acknowledgement; explicit retry joins the same owner', async () => {
    const f = fixture(); await f.initialize(); const db = f.service.getReadyServices()!.db
    f.rejectDrain()
    await expect(f.host.request('engine.shutdown', {})).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(f.service.owner.snapshot()).toMatchObject({ phase: 'blocked', owned: true })
    expect(db.db.open).toBe(true)
    expect(() => acquireProfileLock(f.launch.paths.profileRoot)).toThrow('PROFILE_DUPLICATE_OWNER')
    await f.service.close()
    expect(db.db.open).toBe(false)
    expect(f.nativeCalls).toEqual(['prepare', 'drain', 'drain'])
  }, 15_000)
  it('retains an accepted raw request ignoring cancel and does not resend it while shutdown is blocked', async () => {
    const f = fixture(); await f.initialize(); const actual = f.service.getReadyServices()!
    const agent = actual.db.getAgents()[0]; actual.db.updateAgent(agent.id, { config: { coding_agent: 'pi' } })
    const task = actual.db.createTask(makeTask())!; actual.db.updateTask(task.id, { agent_id: agent.id })
    await f.host.request('agentSession:start', { agentId: agent.id, taskId: task.id })
    const gate = deferred(), entered = deferred(); release.push(gate.finish)
    f.adapter.sendPrompt.mockImplementation(async () => { entered.finish(); await gate.promise })
    const abort = new AbortController()
    const sending = f.host.request('agentSession:sendByTaskId', { taskId: task.id, message: 'Only once', deliveryId: 'delivery_private_001' }, { signal: abort.signal })
    const cancelled = expect(sending).rejects.toMatchObject({ code: 'CANCELLED' })
    await entered.promise; abort.abort(); await cancelled
    await expect(f.service.owner.close(5)).rejects.toThrow('OWNER_DRAIN_BLOCKED')
    expect(actual.db.db.open).toBe(true)
    expect(f.adapter.sendPrompt).toHaveBeenCalledTimes(2)
    gate.finish(); await f.service.close()
    expect(f.adapter.sendPrompt).toHaveBeenCalledTimes(2)
    expect(actual.db.db.open).toBe(false)
  }, 15_000)
  it('retains late native initialization and fences database creation after cancellation', async () => {
    const f = fixture(), gate = deferred(); release.push(gate.finish); f.holdPreparation(gate.promise)
    await f.host.request('engine.ping', {})
    const abort = new AbortController()
    const initialization = f.host.request('engine.initialize', { protocolVersion: 1, launchId: f.launch.launchId }, { signal: abort.signal })
    const cancelled = expect(initialization).rejects.toMatchObject({ code: 'CANCELLED' })
    await vi.waitFor(() => expect(f.nativeCalls).toEqual(['prepare']))
    abort.abort(); await cancelled
    await expect(f.service.owner.close(5)).rejects.toThrow('OWNER_DRAIN_BLOCKED')
    expect(f.service.owner.snapshot()).toMatchObject({ owned: true, phase: 'blocked' })
    expect(() => acquireProfileLock(f.launch.paths.profileRoot)).toThrow('PROFILE_DUPLICATE_OWNER')
    gate.finish(); await f.service.close()
    expect(existsSync(join(f.launch.paths.profileRoot, '21x.db'))).toBe(false)
    expect(f.adapter.createSession).not.toHaveBeenCalled()
    expect(f.nativeCalls).toEqual(['prepare', 'drain'])
  }, 15_000)
})

async function resourceFixture() {
  const root = mkdtempSync(join(tmpdir(), '21x-production-resources-')); roots.push(root)
  const launch = descriptor(root), resources = launch.paths.resourceRoot
  const node = process.platform === 'win32' ? 'node/node.exe' : 'node/node'
  const helper = `native/twentyonex-credential-key${process.platform === 'win32' ? '.exe' : ''}`
  const files: Record<string, { sha256: string; bytes: number }> = {}
  const put = (name: string, bytes: string): void => {
    const file = join(resources, name); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, bytes)
    files[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: Buffer.byteLength(bytes) }
  }
  for (const name of [node, helper, 'service/production-stdio.mjs', 'service/production-engine.mjs', 'service/production-task-mcp.mjs']) put(name, 'controlled-resource-not-executed')
  for (const [name, version] of Object.entries(PRODUCTION_RESOURCE_PINS)) put(`service/node_modules/${name}/package.json`, JSON.stringify({ name, version }))
  put('service/node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'controlled-native-boundary-not-loaded')
  put('service/.native-prepared.json', JSON.stringify({ nodeVersion: '22.23.2', platform: process.platform, arch: process.arch, dependencies: PRODUCTION_RESOURCE_PINS }))
  const manifest = { version: 1, kind: 'production-resource-closure', buildIdentity: launch.buildIdentity, nodeVersion: '22.23.2', platform: process.platform, arch: process.arch,
    entries: { node, credentialHelper: helper, stdio: 'service/production-stdio.mjs', engine: 'service/production-engine.mjs', taskMcp: 'service/production-task-mcp.mjs' },
    packages: PRODUCTION_RESOURCE_PINS, files, redistributionReviewComplete: false }
  const bytes = JSON.stringify(manifest); writeFileSync(join(resources, 'service/PRODUCTION_RESOURCE_MANIFEST.json'), bytes)
  launch.resourceManifestSha256 = createHash('sha256').update(bytes).digest('hex')
  const runtime = { nodeVersion: 'v22.23.2', platform: process.platform, arch: process.arch, executable: join(resources, node), environment: {}, electron: false }
  return { launch, resources, runtime }
}
describe('production resource gate before engine loading', () => {
  it('verifies an entire physical pinned closure and rejects changed/unmanifested SDK bytes', async () => {
    const f = await resourceFixture()
    expect(await verifyProductionResources(f.launch, f.runtime)).toMatchObject({ engine: join(f.resources, 'service/production-engine.mjs') })
    const sdkFile = join(f.resources, 'service/node_modules/@opencode-ai/sdk/late.js'); writeFileSync(sdkFile, 'unreviewed')
    await expect(verifyProductionResources(f.launch, f.runtime)).rejects.toThrow('RESOURCE_CLOSURE_INCOMPLETE')
    rmSync(sdkFile); writeFileSync(join(f.resources, 'service/node_modules/@opencode-ai/sdk/package.json'), '{"name":"@opencode-ai/sdk","version":"wrong"}')
    await expect(verifyProductionResources(f.launch, f.runtime)).rejects.toThrow('RESOURCE_PIN_CHANGED')
  })
  it('rejects resource/profile overlap, alternate Node/preloads and changed pinned manifest', async () => {
    const f = await resourceFixture()
    await expect(verifyProductionResources({ ...f.launch, paths: { ...f.launch.paths, profileRoot: join(f.resources, 'profile') } }, f.runtime)).rejects.toThrow('PROFILE_RESOURCE_OVERLAP')
    await expect(verifyProductionResources(f.launch, { ...f.runtime, environment: { NODE_OPTIONS: '--require untrusted' } })).rejects.toThrow('RUNTIME_IDENTITY_INVALID')
    await expect(verifyProductionResources(f.launch, { ...f.runtime, executable: process.execPath })).rejects.toThrow('RUNTIME_IDENTITY_INVALID')
    const path = join(f.resources, 'service/PRODUCTION_RESOURCE_MANIFEST.json'); writeFileSync(path, readFileSync(path, 'utf8') + '\n')
    await expect(verifyProductionResources(f.launch, f.runtime)).rejects.toThrow('RESOURCE_MANIFEST_CHANGED')
  })
})
