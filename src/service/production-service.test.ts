import { ATTACHMENT_NATIVE_CALLBACK_SCHEMAS, isPrivateAttachmentOpen } from '../shared/attachment-native-callbacks'
import { TASK_ATTACHMENT_CODECS } from '../shared/task-attachment-codecs'
import { AGENT_INSTALLER_CODECS } from '../shared/agent-installer-codecs'
import { UI_NATIVE_CALLBACK_SCHEMAS, isPrivateUiPublication, isPrivateAgentInstallation } from '../shared/ui-native-callbacks'
import { UI_DESKTOP_CODECS } from '../shared/ui-desktop-codecs'
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
import { hasExactKeys, isBootstrapResult, isRecord, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import type { CodingAgentAdapter } from '../main/adapters/coding-agent-adapter'
import type { ChatProvider, ChatProviderEvent } from '../main/chat/providers/types'
import { makeTask } from '../../test/helpers/task-fixtures'
import { acquireProfileLock } from '../main/platform/profile-lock'
import { PRODUCTION_RESOURCE_PINS, verifyProductionResources } from './production-stdio'
import { WORKSPACE_NATIVE_CALLBACK_SCHEMAS } from '../shared/workspace-native-callbacks'

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
function fixture(workspaceFiles = false, ui = false, installation = false, attachmentOpening = false) {
  let uiLease: string | null = 'document_fixture_1'
  let uiAcknowledgement: Promise<void> | null = null
  let attachmentAcknowledgement: Promise<void> | null = null
  const attachmentReceipts: JsonValue[] = []
  let grantWrites = true
  const acceptedUi: JsonValue[] = [], installationProgress: JsonValue[] = []
  const root = mkdtempSync(join(tmpdir(), '21x-private-production-')); roots.push(root)
  const launch = descriptor(root); mkdirSync(launch.paths.resourceRoot)
  if (workspaceFiles) launch.capabilities.workspaceFiles = 'host'
  if (ui) launch.capabilities.ui = 'host'
  if (attachmentOpening) launch.capabilities.attachmentFiles = 'host'
  const selectedNode = process.env.TAURI_NODE_RUNTIME ?? join(process.cwd(), 'src-tauri', 'resources', 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  const fixtureNpm = join(root, 'npm-cli.js')
  if (installation) writeFileSync(fixtureNpm, `const fs=require('node:fs'),p=require('node:path');const prefix=process.argv[process.argv.indexOf('--prefix')+1];const pkg=p.join(prefix,'lib','node_modules','opencode-ai');fs.mkdirSync(pkg,{recursive:true});fs.mkdirSync(p.join(prefix,'bin'),{recursive:true});fs.writeFileSync(p.join(pkg,'package.json'),JSON.stringify({name:'opencode-ai',version:'1.0.0',bin:{opencode:'index.js'}}));fs.writeFileSync(p.join(pkg,'index.js'), '#!'+process.execPath+${JSON.stringify("\nconsole.log('1.0.0')\n")});fs.chmodSync(p.join(pkg,'index.js'),0o700);fs.symlinkSync(p.join(pkg,'index.js'),p.join(prefix,'bin','opencode'));`)

  let permitted = true, badDrain = false, preparation: Promise<void> | null = null
  const nativeCalls: string[] = [], wireEvents: Array<{ operation: string; payload: JsonValue }> = []
  const keys = new Map<string, Buffer>()
  let fileAcknowledgement: Promise<void> | null = null
  const fileReceipts: JsonValue[] = []
  const adapter = { initialize: vi.fn(async () => {}), createSession: vi.fn(async () => 'controlled_native'), resumeSession: vi.fn(async () => []),
    sendPrompt: vi.fn(async () => {}), getStatus: vi.fn(async () => ({ type: 'busy' })), pollMessages: vi.fn(async () => []),
    abortPrompt: vi.fn(async () => {}), destroySession: vi.fn(async () => {}), checkHealth: vi.fn(async () => ({ available: true })) }
  const provider: ChatProvider = { id: 'controlled', model: 'controlled', async *stream(): AsyncGenerator<ChatProviderEvent> { yield { type: 'message_end', stopReason: 'end_turn' } } }
  const check = (): boolean => permitted
  const authority: ProductionDesktopBindingOptions['authority'] = { isTrustedDesktop: check, canAccessTask: (_id, _caller, access) => permitted && (access === 'read' || grantWrites), canAccessSource: check,
    canAccessProject: (_id, _caller, access) => permitted && (access === 'read' || grantWrites), canAccessAgent: (_id, _caller, access) => permitted && (access === 'read' || grantWrites), canAccessSession: check, canAccessGlobalCommander: check,
    canManageGlobalConfiguration: check, canQueryBackend: check, canCreateProject: check, canEditSettings: check,
    canAccessGlobalSkills: check, canChangeSkillScope: check, canReorderProjects: check, canReadSetting: check, canWriteSetting: check, canAccessSecret: check,
    canCreateSecret: check, canUseSecretEnvironment: check, canReadEnvironment: check, canAccessTerminal: check, canAccessMcpServer: check, canAccessCli: check,
    canUseTransport: check, canUseEnvironmentName: check, canAccessConnector: check, canUseSourcePlugin: check,
    canCreateInstance: check, canUsePiece: check, canBorrowSourceCredentials: check, canResolveUnsavedConfig: check,
    canManageMobile: check, canAccessMobileSession: check,
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
  if (workspaceFiles) for (const [operation, schema] of Object.entries(WORKSPACE_NATIVE_CALLBACK_SCHEMAS)) schemas[operation] = { ...schema, handle: async payload => {
    nativeCalls.push(operation); fileReceipts.push((payload as { receipt: JsonValue }).receipt)
    await fileAcknowledgement; return {}
  } }
  schemas['engine.attachment.open'] = { validatePayload: isPrivateAttachmentOpen, validateResult: TASK_ATTACHMENT_CODECS['attachments:open'].validateWireResult }
  if (attachmentOpening) schemas['host.attachment.open'] = { ...ATTACHMENT_NATIVE_CALLBACK_SCHEMAS['host.attachment.open'], handle: async payload => {
    if (!isRecord(payload) || !uiLease || payload.leaseId !== uiLease) throw new ServiceProtocolError('STALE_EPOCH')
    attachmentReceipts.push(structuredClone(payload.receipt))
    await attachmentAcknowledgement
    if (!uiLease || payload.leaseId !== uiLease) throw new ServiceProtocolError('STALE_EPOCH')
    return {}
  } }
  schemas['engine.agent.install'] = { validatePayload: isPrivateAgentInstallation, validateResult: AGENT_INSTALLER_CODECS['agent-installer:install'].validateWireResult }
  schemas['engine.ui.publish'] = { validatePayload: isPrivateUiPublication, validateResult: UI_DESKTOP_CODECS['ui:publishState'].validateWireResult }
  if (ui) {
    schemas['host.ui.snapshot'] = { ...UI_NATIVE_CALLBACK_SCHEMAS['host.ui.snapshot'], handle: (): JsonValue => uiLease ? { available: true, leaseId: uiLease } : { available: false } }
    schemas['host.ui.installerProgress'] = { ...UI_NATIVE_CALLBACK_SCHEMAS['host.ui.installerProgress'], handle: (payload): JsonValue => {
      if (!isRecord(payload) || payload.leaseId !== uiLease || !uiLease) return { ok: false, detail: 'No current document' }
      installationProgress.push(structuredClone(payload.progress)); return { ok: true, leaseId: uiLease }
    } }
    schemas['host.ui.command'] = { ...UI_NATIVE_CALLBACK_SCHEMAS['host.ui.command'], handle: async (payload): Promise<JsonValue> => {
      nativeCalls.push('host.ui.command')
      await uiAcknowledgement
      if (!isRecord(payload) || payload.leaseId !== uiLease || !uiLease) return { ok: false, detail: 'No current document' }
      acceptedUi.push(structuredClone(payload.command)); return { ok: true, leaseId: uiLease }
    } }
  }
  const deliver = (peer: ServicePeer, bytes: Uint8Array): void => { for (let offset = 0; offset < bytes.length; offset += 79) peer.receive(bytes.subarray(offset, offset + 79)) }
  const host = new ServicePeer({ role: 'host', engineEpoch: null, operations: schemas,
    eventSchemas: Object.fromEntries(Object.keys(PRODUCTION_EVENT_CODECS).map(operation => [operation, (value: unknown) => validateProductionEventWire(operation, value)])),
    write: async bytes => { deliver(service.peer, bytes) }, onEvent: event => { wireEvents.push({ operation: event.operation, payload: event.payload }) } })
  hosts.push(host)
  const service = new ProductionService(sealProductionServiceHost({ descriptor: launch, authority,
    caller: { principal: 'trusted-desktop-main', webviewId: 'main', origin: 'tauri://localhost' }, unbridgedOwnerEvent: vi.fn(),
    boundaries: { ...(installation ? { agentInstallation: { nodeExecutable: selectedNode, homeDir: root, environment: {}, npmCliPath: fixtureNpm } } : {}), cliMcp: { homeDir: root, environment: {} }, createAdapter: () => adapter as unknown as CodingAgentAdapter, createProvider: () => provider },
    constructBootstrap: callbacks => ({ profileId: launch.profileId, paths: launch.paths,
      credentials: { mode: 'create', store: { create: async (id, key) => { keys.set(id, Buffer.from(key)) }, load: async id => Buffer.from(keys.get(id)!) } },
      connectors: { kind: 'disabled', reason: 'Controlled fixture has no packaged connectors' }, managedTaskMcp: { disabled: true },
      native: { agents: { renderer: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, configuredMcp: 'disabled' },
        prepareRuntime: callbacks.prepare, drainOwnedProcesses: callbacks.drain, emit: callbacks.emitOwnerEvent,
        ...(ui ? { ui: callbacks.ui, emitInstallationProgress: callbacks.emitInstallationProgress } : {}),
        ...(attachmentOpening ? { openAttachment: callbacks.openAttachment } : {}),
        openExternal: callbacks.openExternal, ...(workspaceFiles ? { openPath: callbacks.openPath, showItemInFolder: callbacks.showItemInFolder } : {}), notify: callbacks.notify, sendUiCommand: () => ({ ok: false, detail: 'Explicit fixture capability' }) } })
  }), { write: async bytes => { deliver(host, bytes) } }); services.push(service)
  const initialize = async (): Promise<void> => {
    const ping = await host.request('engine.ping', {})
    expect(ping).toMatchObject({ engineEpoch: service.owner.snapshot().epoch })
    await host.request('engine.initialize', { protocolVersion: 1, launchId: launch.launchId })
  }
  return { root, launch, service, host, adapter, wireEvents, nativeCalls, initialize, deny: () => { permitted = false }, rejectDrain: () => { badDrain = true },
    attachmentReceipts, denyWrites: () => { grantWrites = false }, holdAttachmentAcknowledgement: (raw: Promise<void>) => { attachmentAcknowledgement = raw },
    installationProgress, acceptedUi, changeUiLease: (lease: string | null) => { uiLease = lease }, holdUiAcknowledgement: (raw: Promise<void>) => { uiAcknowledgement = raw },
    fileReceipts, holdFileAcknowledgement: (raw: Promise<void>) => { fileAcknowledgement = raw },
    holdPreparation: (raw: Promise<void>) => { preparation = raw } }
}

describe('actual private production peer', () => {
  it('exchanges exact captured file receipts only with an advertised private native callback and retains late acknowledgement', async () => {
    const f = fixture(true); await f.initialize()
    const actual = f.service.getReadyServices()!, task = actual.db.createTask(makeTask())!
    const directory = await f.host.request('tasks:getWorkspaceDir', { taskId: task.id }) as { value: string }
    const path = join(directory.value, 'report.md'); writeFileSync(path, 'Private fixture report')
    expect(await f.host.request('shell:readTextFile', { filePath: path })).toMatchObject({ defined: true, value: { content: 'Private fixture report' } })
    expect(await f.host.request('shell:showItemInFolder', { filePath: path })).toEqual({ defined: false })
    expect(f.fileReceipts).toEqual([expect.objectContaining({ version: 1, path, taskId: task.id, workspaceRoot: f.launch.paths.workspaceRoot })])
    const gate = deferred(); release.push(gate.finish); f.holdFileAcknowledgement(gate.promise)
    const abort = new AbortController(), work = f.host.request('shell:openPath', { filePath: path }, { signal: abort.signal })
    const cancelled = expect(work).rejects.toMatchObject({ code: 'CANCELLED' })
    await vi.waitFor(() => expect(f.nativeCalls).toContain('host.workspace.openPath'))
    abort.abort(); await cancelled
    await expect(f.service.owner.close(5)).rejects.toThrow('OWNER_DRAIN_BLOCKED')
    expect(actual.db.db.open).toBe(true); expect(f.nativeCalls).not.toContain('drain')
    gate.finish(); await f.service.close()
    expect(actual.db.db.open).toBe(false); expect(f.nativeCalls.filter(op => op === 'host.workspace.openPath')).toHaveLength(1)
    expect(f.nativeCalls.at(-1)).toBe('drain')
  }, 15_000)
  it('does not expose native file actions when the private descriptor has no file callback capability', async () => {
    const f = fixture(); await f.initialize()
    const task = f.service.getReadyServices()!.db.createTask(makeTask())!
    const directory = await f.host.request('tasks:getWorkspaceDir', { taskId: task.id }) as { value: string }
    await expect(f.host.request('shell:openPath', { filePath: directory.value })).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    expect(f.fileReceipts).toEqual([])
    expect(f.nativeCalls).toEqual(['prepare'])
  }, 15_000)
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

async function resourceFixture(mobile = false, voice = false) {
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
  if (mobile) { put('mobile/index.html', '<main>actual mobile resource</main>'); put('mobile/assets/app.js', 'actual mobile script') }
  if (voice) { put('service/voice-worker.cjs', 'controlled recognition worker'); put('service/voice-tts-worker.cjs', 'controlled synthesis worker') }
  const manifest = { version: 1, kind: 'production-resource-closure', buildIdentity: launch.buildIdentity, nodeVersion: '22.23.2', platform: process.platform, arch: process.arch,
    entries: { ...(mobile ? { mobile: 'mobile/index.html' } : {}), ...(voice ? { voiceWorker: 'service/voice-worker.cjs', voiceTtsWorker: 'service/voice-tts-worker.cjs' } : {}), node, credentialHelper: helper, stdio: 'service/production-stdio.mjs', engine: 'service/production-engine.mjs', taskMcp: 'service/production-task-mcp.mjs' },
    packages: PRODUCTION_RESOURCE_PINS, files, redistributionReviewComplete: false }
  const bytes = JSON.stringify(manifest); writeFileSync(join(resources, 'service/PRODUCTION_RESOURCE_MANIFEST.json'), bytes)
  launch.resourceManifestSha256 = createHash('sha256').update(bytes).digest('hex')
  const runtime = { nodeVersion: 'v22.23.2', platform: process.platform, arch: process.arch, executable: join(resources, node), environment: {}, electron: false }
  return { launch, resources, runtime }
}
describe('production resource gate before engine loading', () => {
  it('requires the complete pinned voice worker pair before admitting portable voice owners', async () => {
    const old = await resourceFixture()
    expect((await verifyProductionResources(old.launch, old.runtime)).voice).toBeUndefined()
    const f = await resourceFixture(false, true)
    expect((await verifyProductionResources(f.launch, f.runtime)).voice).toEqual({ recognitionWorker: join(f.resources, 'service/voice-worker.cjs'), speechWorker: join(f.resources, 'service/voice-tts-worker.cjs') })
    writeFileSync(join(f.resources, 'service/voice-worker.cjs'), 'changed worker')
    await expect(verifyProductionResources(f.launch, f.runtime)).rejects.toThrow('RESOURCE_BYTES_CHANGED')
    const missing = await resourceFixture(false, true)
    const file = join(missing.resources, 'service/PRODUCTION_RESOURCE_MANIFEST.json')
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    delete manifest.entries.voiceTtsWorker
    const bytes = JSON.stringify(manifest); writeFileSync(file, bytes)
    missing.launch.resourceManifestSha256 = createHash('sha256').update(bytes).digest('hex')
    await expect(verifyProductionResources(missing.launch, missing.runtime)).rejects.toThrow('RESOURCE_MANIFEST_INVALID')
  })
  it('verifies an entire physical pinned closure and rejects changed/unmanifested SDK bytes', async () => {
    const f = await resourceFixture()
    expect(await verifyProductionResources(f.launch, f.runtime)).toMatchObject({ engine: join(f.resources, 'service/production-engine.mjs') })
    const sdkFile = join(f.resources, 'service/node_modules/@opencode-ai/sdk/late.js'); writeFileSync(sdkFile, 'unreviewed')
    await expect(verifyProductionResources(f.launch, f.runtime)).rejects.toThrow('RESOURCE_CLOSURE_INCOMPLETE')
    rmSync(sdkFile); writeFileSync(join(f.resources, 'service/node_modules/@opencode-ai/sdk/package.json'), '{"name":"@opencode-ai/sdk","version":"wrong"}')
    await expect(verifyProductionResources(f.launch, f.runtime)).rejects.toThrow('RESOURCE_PIN_CHANGED')
  })
  it('verifies the optional entire mobile web closure and rejects late unmanifested browser resources', async () => {
    const f = await resourceFixture(true)
    expect(await verifyProductionResources(f.launch, f.runtime)).toMatchObject({ mobileDistRoot: join(f.resources, 'mobile') })
    const extra = join(f.resources, 'mobile', 'assets', 'late.js'); writeFileSync(extra, 'unmanifested browser code')
    await expect(verifyProductionResources(f.launch, f.runtime)).rejects.toThrow('RESOURCE_CLOSURE_INCOMPLETE')
    rmSync(extra); writeFileSync(join(f.resources, 'mobile', 'index.html'), 'changed mobile resource')
    await expect(verifyProductionResources(f.launch, f.runtime)).rejects.toThrow('RESOURCE_BYTES_CHANGED')
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

describe('private native document publication into the actual production singleton', () => {
  const state = (projectId: string) => ({ view: 'commander', projectId, modal: null, selectedTaskId: null, selectedTaskTitle: null, dashboardPreviewTaskId: null, captainOpen: false, settingsTab: null, waitingForYou: false, visibleTaskIds: [], canvas: { viewport: { x: 0, y: 0, zoom: 1 }, panels: [] } })
  it('rejects public lease injection and stamps private native ingress before reading actual UI state', async () => {
    const f = fixture(false, true); await f.initialize()
    const services = f.service.getReadyServices()!, snapshot = state(services.db.getDefaultProject()!.id)
    await expect(f.host.request('ui:publishState', { state: snapshot })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.host.request('ui:publishState', { state: snapshot, leaseId: 'document_fixture_1' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(await f.host.request('engine.ui.publish', { state: snapshot, leaseId: 'document_fixture_1' })).toEqual({ defined: false })
    expect(await services.ui!.snapshot()).toMatchObject({ available: true, ...snapshot })
    const api = await import('../main/task-api-server-core'), apiBase = `http://127.0.0.1:${api.getTaskApiPort()}`
    const read = () => fetch(apiBase + '/get_ui_state', { method: 'POST', headers: { Authorization: 'Bearer ' + api.getTaskApiToken(), 'Content-Type': 'application/json' }, body: '{}' })
    expect((await fetch(apiBase + '/get_ui_state')).status).toBe(401)
    expect((await fetch(apiBase + '/get_ui_state', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
    expect(await (await read()).json()).toMatchObject({ available: true, ...snapshot })
    expect(await services.ui!.send({ kind: 'navigate', view: 'tasks' })).toEqual({ success: true, command: 'navigate', accepted: true })
    expect(f.acceptedUi).toEqual([{ kind: 'navigate', view: 'tasks' }])
    f.changeUiLease('document_fixture_2')
    expect(await services.ui!.snapshot()).toEqual({ available: false })
    await expect(f.host.request('engine.ui.publish', { state: snapshot, leaseId: 'document_fixture_1' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await f.host.request('engine.ui.publish', { state: snapshot, leaseId: 'document_fixture_2' })).toEqual({ defined: false })
    f.changeUiLease(null); expect(await services.ui!.snapshot()).toEqual({ available: false })
    expect(await (await read()).json()).toEqual({ available: false })
    expect(await services.ui!.send({ kind: 'navigate', view: 'tasks' })).toHaveProperty('error')
    expect(f.acceptedUi).toHaveLength(1)
  })
  it('retains an outstanding native acknowledgement and refuses a retired lease result', async () => {
    const f = fixture(false, true); await f.initialize()
    const services = f.service.getReadyServices()!, snapshot = state(services.db.getDefaultProject()!.id)
    await f.host.request('engine.ui.publish', { state: snapshot, leaseId: 'document_fixture_1' })
    const gate = deferred(); release.push(gate.finish); f.holdUiAcknowledgement(gate.promise)
    const send = services.ui!.send({ kind: 'navigate', view: 'tasks' })
    await vi.waitFor(() => expect(f.nativeCalls).toContain('host.ui.command'))
    await expect(f.service.owner.close(15)).rejects.toMatchObject({ code: 'OWNER_DRAIN_BLOCKED' })
    expect(f.service.owner.snapshot().owned).toBe(true)
    f.changeUiLease('document_fixture_2'); gate.finish()
    await expect(send).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(f.acceptedUi).toEqual([])
    await f.service.owner.close(); expect(f.service.owner.snapshot().owned).toBe(false)
  })
})

it.skipIf(process.platform === 'win32')('installs a controlled real package through private native ingress and the actual singleton, preserving external files', async () => {
  const f = fixture(false, true, true); await f.initialize()
  const services = f.service.getReadyServices()!, state = { view: 'settings', projectId: services.db.getDefaultProject()!.id, modal: 'settings', selectedTaskId: null, selectedTaskTitle: null, dashboardPreviewTaskId: null, captainOpen: false, settingsTab: 'agents', waitingForYou: false, visibleTaskIds: [], canvas: { viewport: { x: 0, y: 0, zoom: 1 }, panels: [] } }
  await f.host.request('engine.ui.publish', { state, leaseId: 'document_fixture_1' })
  const external = join(f.root, 'external-user-cli.txt'); writeFileSync(external, 'preserve external installation')
  await expect(f.host.request('agent-installer:install', { agentName: 'opencode' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  const result = await f.host.request('engine.agent.install', { agentName: 'opencode', leaseId: 'document_fixture_1' })
  expect(result).toMatchObject({ defined: true, value: { success: true, error: null, newStatus: { opencode: { installed: true, version: '1.0.0' } } } })
  expect(readFileSync(external, 'utf8')).toBe('preserve external installation')
  expect(f.installationProgress.map(value => (value as { stage: string }).stage)).toEqual(['starting', 'installing', 'verifying', 'complete'])
  expect(services.agentInstallation!.childCount).toBe(0)
  expect(existsSync(join(f.launch.paths.profileRoot, 'agent-cli', 'lib', 'node_modules', 'opencode-ai', 'index.js'))).toBe(true)
})


function savedAttachment(f: ReturnType<typeof fixture>, bytes = 2 * 1024 * 1024) {
  const services = f.service.getReadyServices()!, task = services.db.createTask(makeTask())!
  const attachment = { id: '12345678-1234-4234-9234-123456789abc', filename: 'report.bin', size: bytes, mime_type: 'application/octet-stream', added_at: '2026-10-14T00:00:00Z' }
  const directory = join(f.launch.paths.attachmentRoot, task.id); mkdirSync(directory)
  const path = join(directory, attachment.id + '-' + attachment.filename); writeFileSync(path, Buffer.alloc(bytes, 7))
  services.db.updateTask(task.id, { attachments: [attachment] })
  return { services, task, attachment, path }
}
it('opens real saved attachment metadata through the private document ingress while its task agent is active under read grants', async () => {
  const f = fixture(false, true, false, true); await f.initialize()
  const { services, task, attachment, path } = savedAttachment(f)
  const agent = services.db.getAgents()[0]; services.db.updateAgent(agent.id, { config: { coding_agent: 'pi' } }); services.db.updateTask(task.id, { agent_id: agent.id })
  await f.host.request('agentSession:start', { agentId: agent.id, taskId: task.id })
  expect(services.agents.hasTaskStartOwnership(task.id)).toBe(true)
  f.denyWrites()
  const getterTraces: string[] = [], actualTask = services.db.getTask.bind(services.db), actualAgent = services.db.getAgent.bind(services.db)
  vi.spyOn(services.db, 'getTask').mockImplementation(id => { getterTraces.push(new Error().stack!); return actualTask(id) })
  vi.spyOn(services.db, 'getAgent').mockImplementation(id => { getterTraces.push(new Error().stack!); return actualAgent(id) })
  const nativeGate = deferred(); release.push(nativeGate.finish); f.holdAttachmentAcknowledgement(nativeGate.promise)
  await expect(f.host.request('attachments:open', { taskId: task.id, attachmentId: attachment.id })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await expect(f.host.request('engine.attachment.open', { taskId: task.id, attachmentId: attachment.id, leaseId: 'document_fixture_1', path: '/foreign' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  const opening = f.host.request('engine.attachment.open', { taskId: task.id, attachmentId: attachment.id, leaseId: 'document_fixture_1' })
  await vi.waitFor(() => expect(f.attachmentReceipts).toHaveLength(1))
  // A real live agent continues to poll while the native file callback owns
  // its descriptor. Those application-owned reads have separate authority.
  await vi.waitFor(() => expect(getterTraces.some(trace => trace.includes('agent-manager-core.ts'))).toBe(true), { timeout: 5000 })
  nativeGate.finish(); await expect(opening).resolves.toEqual({ defined: false })
  expect(getterTraces.filter(trace => /task-attachment|task-workspace-scope|getTaskAttachmentBindingLease/.test(trace))).toEqual([])
  expect(getterTraces.every(trace => trace.includes('agent-manager-core.ts'))).toBe(true)
  expect(f.attachmentReceipts).toEqual([expect.objectContaining({ attachmentRoot: f.launch.paths.attachmentRoot, path, taskId: task.id, attachmentId: attachment.id, filename: attachment.filename, target: expect.objectContaining({ size: String(attachment.size), nlink: '1', kind: 'file' }) })])
  expect(services.taskAttachmentFiles.inflightCount).toBe(0)
  expect(readFileSync(path).length).toBe(attachment.size)
  expect(services.db.db.prepare('SELECT attachments FROM tasks WHERE id=?').get(task.id)).toEqual({ attachments: JSON.stringify([attachment]) })
  expect(f.adapter.abortPrompt).not.toHaveBeenCalled(); expect(f.adapter.destroySession).not.toHaveBeenCalled()
}, 15000)
it('retains the exact attachment callback and FD after cancel, refusing namespace deletion and profile release until acknowledgement', async () => {
  const f = fixture(false, true, false, true); await f.initialize()
  const { services, task, attachment, path } = savedAttachment(f, 12), gate = deferred(); release.push(gate.finish); f.holdAttachmentAcknowledgement(gate.promise)
  const abort = new AbortController(), work = f.host.request('engine.attachment.open', { taskId: task.id, attachmentId: attachment.id, leaseId: 'document_fixture_1' }, { signal: abort.signal })
  const failed = expect(work).rejects.toMatchObject({ code: 'CANCELLED' })
  await vi.waitFor(() => expect(f.attachmentReceipts).toHaveLength(1))
  expect(services.taskAttachmentFiles.inflightCount).toBeGreaterThan(0)
  await expect(f.host.request('db:deleteTask', { id: task.id })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect(existsSync(path)).toBe(true)
  abort.abort(); await failed
  await expect(f.service.owner.close(5)).rejects.toThrow('OWNER_DRAIN_BLOCKED')
  expect(services.db.db.open).toBe(true); expect(f.nativeCalls).not.toContain('drain')
  gate.finish(); await f.service.close()
  expect(services.db.db.open).toBe(false); expect(f.attachmentReceipts).toHaveLength(1); expect(existsSync(path)).toBe(true)
}, 15000)
it('refuses native attachment effects when the captured launch does not advertise the callback', async () => {
  const f = fixture(false, true); await f.initialize()
  const { task, attachment, path } = savedAttachment(f, 12)
  await expect(f.host.request('engine.attachment.open', { taskId: task.id, attachmentId: attachment.id, leaseId: 'document_fixture_1' })).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
  expect(f.attachmentReceipts).toEqual([]); expect(existsSync(path)).toBe(true)
}, 15000)
