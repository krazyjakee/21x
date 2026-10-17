import { NATIVE_ATTACHMENT_IMAGE_CODECS } from '../shared/attachment-image-codecs'
import { NATIVE_WINDOW_STATE_SCHEMAS } from '../shared/native-window-state'
import { ATTACHMENT_SELECTION_SCHEMAS, isSelectionOffer, isSelectionRevocation } from '../shared/attachment-selection-callbacks'
import { ARTIFACT_NATIVE_CALLBACK_SCHEMAS, isPrivateArtifactCopy, isPrivateArtifactCopyCheck } from '../shared/artifact-native-callbacks'
import { ARTIFACT_CODECS } from '../shared/artifact-codecs'
import { ATTACHMENT_NATIVE_CALLBACK_SCHEMAS, isPrivateAttachmentOpen, isPrivateAttachmentDownload, isPrivateAttachmentDownloadCheck } from '../shared/attachment-native-callbacks'
import { TASK_ATTACHMENT_CODECS } from '../shared/task-attachment-codecs'
import { AGENT_INSTALLER_CODECS } from '../shared/agent-installer-codecs'
import { UI_NATIVE_CALLBACK_SCHEMAS, isPrivateUiPublication, isPrivateAgentInstallation } from '../shared/ui-native-callbacks'
import { UI_DESKTOP_CODECS } from '../shared/ui-desktop-codecs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import type { ProductionService as ProductionServiceType, SealedProductionServiceHost, ProductionPrivateCallbacks } from './production-service'
let ProductionService: typeof import('./production-service').ProductionService
let sealProductionServiceHost: typeof import('./production-service').sealProductionServiceHost
beforeEach(async () => {
  vi.resetModules()
  ;({ ProductionService, sealProductionServiceHost } = await import('./production-service'))
})
import { PRODUCTION_COMMAND_CODECS, PRODUCTION_EVENT_CODECS, validateProductionEventWire, type ProductionDesktopBindingOptions } from './production-desktop-bindings'
import { PRODUCTION_HOST_SCHEMAS, isProductionOwnerState, type ProductionLaunchDescriptor } from '../shared/production-bootstrap'
import { ServicePeer, type OperationSchema } from './transport/peer'
import { hasExactKeys, isBootstrapResult, isRecord, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import type { CodingAgentAdapter } from '../main/adapters/coding-agent-adapter'
import type { ChatProvider, ChatProviderEvent } from '../main/chat/providers/types'
import { makeTask } from '../../test/helpers/task-fixtures'
import { acquireProfileLock } from '../main/platform/profile-lock'
import { PRODUCTION_RESOURCE_PINS, verifyProductionResources } from './production-stdio'
import { SessionStatus } from '../shared/constants'
import { HOST_OPERATION_SCHEMAS } from '../shared/host-services'
import { WORKSPACE_NATIVE_CALLBACK_SCHEMAS } from '../shared/workspace-native-callbacks'
import { OAUTH_DELIVERY_SCHEMA, OAUTH_NATIVE_CALLBACK_SCHEMAS } from '../shared/oauth-native-callbacks'
import { PiAdapter } from '../main/adapters/pi-adapter'

const roots: string[] = [], services: ProductionServiceType[] = [], hosts: ServicePeer[] = [], release: Array<() => void> = []
afterEach(async () => {
  for (const finish of release.splice(0)) finish()
  for (const service of services.splice(0)) await service.close()
  for (const host of hosts.splice(0)) { host.disconnect(); await host.waitForHandlers() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
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
function fixture(workspaceFiles = false, ui = false, installation = false, attachmentOpening = false, attachmentDownloading = false, artifactClipboard = false, notifications = false, tray = false, energy = false, oauth = false, selections = false, windowState = false) {
  let selectedAdapter: CodingAgentAdapter | null = null
  let privateCallbacks: ProductionPrivateCallbacks | null = null
  let notificationAcknowledgement: Promise<void> | null = null
  let notificationResult: 'shown' | 'denied' | 'error' | 'malformed' | 'timeout' = 'shown'
  const notificationCalls: Array<{ operation: string; payload: JsonValue }> = []
  const energyCalls: boolean[] = []
  let energyAcknowledgement: Promise<void> | null = null
  let energyResult: 'applied' | 'refused' | 'error' | 'malformed' = 'applied'
  let uiLease: string | null = 'document_fixture_1'
  let uiAcknowledgement: Promise<void> | null = null
  let uiSnapshotAcknowledgement: Promise<void> | null = null
  let uiSnapshots = 0
  let attachmentAcknowledgement: Promise<void> | null = null
  const attachmentReceipts: JsonValue[] = []
  const attachmentAuthorizations: string[] = []
  let grantWrites = true
  const acceptedUi: JsonValue[] = [], installationProgress: JsonValue[] = []
  const root = mkdtempSync(join(tmpdir(), '21x-private-production-')); roots.push(root)
  const launch = descriptor(root); mkdirSync(launch.paths.resourceRoot)
  if (notifications) launch.capabilities.notifications = 'host'
  if (tray) launch.capabilities.tray = 'host'
  if (energy) launch.capabilities.energy = 'host'
  if (workspaceFiles) launch.capabilities.workspaceFiles = 'host'
  if (ui) launch.capabilities.ui = 'host'
  if (selections) launch.capabilities.attachmentSelections = 'host'
  if (windowState) launch.capabilities.windowState = 'host'
  if (attachmentOpening) launch.capabilities.attachmentFiles = 'host'
  if (attachmentDownloading) launch.capabilities.attachmentDownloads = 'host'
  if (artifactClipboard) launch.capabilities.artifactClipboard = 'host'
  if (oauth) { launch.capabilities.oauthFlows = 'host'; launch.capabilities.externalUrls = 'host' }
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
    canManageGlobalConfiguration: (_caller, access) => permitted && (access === 'read' || grantWrites), canQueryBackend: check, canCreateProject: check, canEditSettings: check,
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
  schemas['engine.ownerState'] = { validatePayload: value => isRecord(value) && hasExactKeys(value, []), validateResult: isProductionOwnerState }
  schemas['engine.shutdown'] = { validatePayload: value => isRecord(value), validateResult: value => isRecord(value) && value.stopped === true }
  schemas['engine.oauth.callback'] = OAUTH_DELIVERY_SCHEMA
  if (oauth) for (const [operation, schema] of Object.entries(OAUTH_NATIVE_CALLBACK_SCHEMAS)) schemas[operation] = { ...schema, handle: payload => {
    nativeCalls.push(operation)
    const field = operation === 'host.oauth.register' ? 'registered' : operation === 'host.oauth.open' ? 'opened' : 'retired'
    return { flowId: (payload as { flowId: string }).flowId, [field]: true }
  } }
  schemas['engine.tray.preference'] = { validatePayload: value => isRecord(value) && Object.keys(value).length === 0, validateResult: value => isRecord(value) && typeof value.enabled === 'boolean' }
  schemas['engine.tray.preferenceCommand'] = { validatePayload: value => isRecord(value), validateResult: value => isRecord(value) && value.defined === true && typeof value.value === 'boolean' }
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
  if (notifications) for (const operation of ['host.notification.show', 'host.notification.status'] as const) schemas[operation] = {
    validatePayload: HOST_OPERATION_SCHEMAS[operation].validateRequest,
    validateResult: HOST_OPERATION_SCHEMAS[operation].validateResult,
    handle: async payload => {
      notificationCalls.push({ operation, payload: structuredClone(payload) })
      await notificationAcknowledgement
      if (notificationResult === 'timeout') throw new ServiceProtocolError('TIMEOUT')
      if (notificationResult === 'error') throw new ServiceProtocolError('INVALID_REQUEST')
      if (notificationResult === 'malformed') return { shown: 'wrong' }
      return { shown: notificationResult === 'shown' }
    }
  }
  if (energy) schemas['host.sleep.set'] = {
    validatePayload: HOST_OPERATION_SCHEMAS['host.sleep.set'].validateRequest, validateResult: HOST_OPERATION_SCHEMAS['host.sleep.set'].validateResult,
    handle: async payload => {
      const enabled = (payload as { enabled: boolean }).enabled; energyCalls.push(enabled)
      await energyAcknowledgement
      if (enabled && energyResult === 'error') throw new ServiceProtocolError('TIMEOUT')
      if (enabled && energyResult === 'malformed') return { enabled: 'wrong' }
      return { enabled: energyResult === 'refused' ? false : enabled }
    }
  }
  if (workspaceFiles) for (const [operation, schema] of Object.entries(WORKSPACE_NATIVE_CALLBACK_SCHEMAS)) schemas[operation] = { ...schema, handle: async payload => {
    nativeCalls.push(operation); fileReceipts.push((payload as { receipt: JsonValue }).receipt)
    await fileAcknowledgement; return {}
  } }
  Object.assign(schemas, NATIVE_WINDOW_STATE_SCHEMAS)
  schemas['engine.attachment.selection.offer'] = { validatePayload: isSelectionOffer, validateResult: value => isRecord(value) && hasExactKeys(value, ['accepted']) && typeof value.accepted === 'boolean' }
  schemas['engine.attachment.selection.revoke'] = { validatePayload: isSelectionRevocation, validateResult: value => isRecord(value) && hasExactKeys(value, ['retired']) && value.retired === true }
  schemas['engine.attachment.save'] = { validatePayload: value => isRecord(value), validateResult: TASK_ATTACHMENT_CODECS['attachments:save'].validateWireResult }
  if (selections) for (const [operation, schema] of Object.entries(ATTACHMENT_SELECTION_SCHEMAS)) schemas[operation] = { ...schema, handle: async (payload): Promise<JsonValue> => {
    if (!isRecord(payload)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    nativeCalls.push(operation)
    if (operation.endsWith('.retire')) return { retired: true }
    if (!uiLease || payload.leaseId !== uiLease) throw new ServiceProtocolError('STALE_EPOCH')
    await attachmentAcknowledgement
    if (!uiLease || payload.leaseId !== uiLease) throw new ServiceProtocolError('STALE_EPOCH')
    if (operation.endsWith('.finish')) return { verified: true }
    return { data: Buffer.alloc(Number(payload.length), 7).toString('base64') }
  } }
  schemas['engine.attachment.image'] = { validatePayload: isPrivateAttachmentOpen, validateResult: NATIVE_ATTACHMENT_IMAGE_CODECS['attachments:readImage'].validateWireResult }
  schemas['engine.attachment.open'] = { validatePayload: isPrivateAttachmentOpen, validateResult: TASK_ATTACHMENT_CODECS['attachments:open'].validateWireResult }
  schemas['engine.attachment.download'] = { validatePayload: isPrivateAttachmentDownload, validateResult: TASK_ATTACHMENT_CODECS['attachments:download'].validateWireResult }
  schemas['engine.attachment.download.check'] = { validatePayload: isPrivateAttachmentDownloadCheck, validateResult: value => isRecord(value) && hasExactKeys(value,['authorized']) && value.authorized===true }
  if (attachmentOpening) schemas['host.attachment.open'] = { ...ATTACHMENT_NATIVE_CALLBACK_SCHEMAS['host.attachment.open'], handle: async payload => {
    if (!isRecord(payload) || !uiLease || payload.leaseId !== uiLease) throw new ServiceProtocolError('STALE_EPOCH')
    attachmentReceipts.push(structuredClone(payload.receipt))
    await attachmentAcknowledgement
    if (!uiLease || payload.leaseId !== uiLease) throw new ServiceProtocolError('STALE_EPOCH')
    return {}
  } }
  if (attachmentDownloading) schemas['host.attachment.download'] = { ...ATTACHMENT_NATIVE_CALLBACK_SCHEMAS['host.attachment.download'], handle: async payload => {
    if (!isRecord(payload) || !uiLease || payload.leaseId !== uiLease) throw new ServiceProtocolError('STALE_EPOCH')
    attachmentReceipts.push(structuredClone(payload.receipt))
    if (typeof payload.authorizationId !== 'string') throw new ServiceProtocolError('INVALID_ARGUMENTS')
    attachmentAuthorizations.push(payload.authorizationId)
    await attachmentAcknowledgement
    if (!uiLease || payload.leaseId !== uiLease) throw new ServiceProtocolError('STALE_EPOCH')
    await host.request('engine.attachment.download.check', {authorizationId:payload.authorizationId})
    return {}
  } }
  schemas['engine.artifact.copyFile'] = { validatePayload: isPrivateArtifactCopy, validateResult: ARTIFACT_CODECS['artifacts:copyFile'].validateWireResult }
  schemas['engine.artifact.copyFile.check'] = { validatePayload: isPrivateArtifactCopyCheck, validateResult: value => isRecord(value) && hasExactKeys(value, ['authorized']) && value.authorized === true }
  if (artifactClipboard) schemas['host.artifact.copyFile'] = { ...ARTIFACT_NATIVE_CALLBACK_SCHEMAS['host.artifact.copyFile'], handle: async payload => {
    if (!isRecord(payload) || !uiLease || payload.leaseId !== uiLease) throw new ServiceProtocolError('STALE_EPOCH')
    fileReceipts.push(structuredClone(payload.receipt)); attachmentAuthorizations.push(payload.authorizationId as string)
    await fileAcknowledgement
    if (!uiLease || payload.leaseId !== uiLease) throw new ServiceProtocolError('STALE_EPOCH')
    await host.request('engine.artifact.copyFile.check', { authorizationId: payload.authorizationId })
    nativeCalls.push('host.artifact.copyFile'); return { mode: 'file' }
  } }
  schemas['engine.agent.install'] = { validatePayload: isPrivateAgentInstallation, validateResult: AGENT_INSTALLER_CODECS['agent-installer:install'].validateWireResult }
  schemas['engine.ui.publish'] = { validatePayload: isPrivateUiPublication, validateResult: UI_DESKTOP_CODECS['ui:publishState'].validateWireResult }
  if (ui) {
    schemas['host.ui.snapshot'] = { ...UI_NATIVE_CALLBACK_SCHEMAS['host.ui.snapshot'], handle: async (): Promise<JsonValue> => { uiSnapshots++; await uiSnapshotAcknowledgement; return uiLease ? { available: true, leaseId: uiLease } : { available: false } } }
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
    boundaries: { ...(installation ? { agentInstallation: { nodeExecutable: selectedNode, homeDir: root, environment: {}, npmCliPath: fixtureNpm } } : {}), cliMcp: { homeDir: root, environment: {} }, createAdapter: () => selectedAdapter ?? adapter as unknown as CodingAgentAdapter, createProvider: () => provider },
    constructBootstrap: callbacks => { privateCallbacks = callbacks; return ({ profileId: launch.profileId, paths: launch.paths,
      credentials: { mode: 'create', store: { create: async (id, key) => { keys.set(id, Buffer.from(key)) }, load: async id => Buffer.from(keys.get(id)!) } },
      connectors: { kind: 'disabled', reason: 'Controlled fixture has no packaged connectors' }, managedTaskMcp: { disabled: true },
      native: { trayAvailable: tray, ...(energy ? { energy: { setActive: callbacks.setSleep! } } : {}), agents: { renderer: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, notifications: notifications ? { kind: 'native', isSupported: () => true, show: ({ title, body }) => callbacks.notifyStatus!(title, body) } : { kind: 'unsupported' }, configuredMcp: 'disabled' },
        prepareRuntime: callbacks.prepare, drainOwnedProcesses: callbacks.drain, emit: callbacks.emitOwnerEvent,
        ...(ui ? { ui: callbacks.ui, emitInstallationProgress: callbacks.emitInstallationProgress } : {}),
        ...(attachmentOpening ? { openAttachment: callbacks.openAttachment } : {}),
        ...(attachmentDownloading ? { downloadAttachment: callbacks.downloadAttachment } : {}),
        ...(artifactClipboard ? { copyArtifact: callbacks.copyArtifact } : {}),
        openExternal: callbacks.openExternal, ...(workspaceFiles ? { openPath: callbacks.openPath, showItemInFolder: callbacks.showItemInFolder } : {}), notify: callbacks.notify, sendUiCommand: () => ({ ok: false, detail: 'Explicit fixture capability' }) } }) }
  }), { write: async bytes => { deliver(host, bytes) } }); services.push(service)
  const initialize = async (): Promise<void> => {
    const ping = await host.request('engine.ping', {})
    expect(ping).toMatchObject({ engineEpoch: service.owner.snapshot().epoch })
    await host.request('engine.initialize', { protocolVersion: 1, launchId: launch.launchId })
  }
  return { root, launch, service, host, adapter, wireEvents, nativeCalls, initialize, deny: () => { permitted = false }, rejectDrain: () => { badDrain = true },
    useAdapter: (value: CodingAgentAdapter) => { selectedAdapter = value }, allow: () => { permitted = true },
    notificationCalls, privateCallbacks: () => privateCallbacks!, holdNotificationAcknowledgement: (raw: Promise<void> | null) => { notificationAcknowledgement = raw }, setNotificationResult: (value: typeof notificationResult) => { notificationResult = value },
    energyCalls, holdEnergyAcknowledgement: (raw: Promise<void> | null) => { energyAcknowledgement = raw }, setEnergyResult: (value: typeof energyResult) => { energyResult = value },
    attachmentReceipts, attachmentAuthorizations, denyWrites: () => { grantWrites = false }, holdAttachmentAcknowledgement: (raw: Promise<void>) => { attachmentAcknowledgement = raw },
    installationProgress, acceptedUi, changeUiLease: (lease: string | null) => { uiLease = lease }, holdUiAcknowledgement: (raw: Promise<void>) => { uiAcknowledgement = raw },
    uiSnapshots: () => uiSnapshots, holdUiSnapshot: (raw: Promise<void>) => { uiSnapshotAcknowledgement = raw },
    fileReceipts, holdFileAcknowledgement: (raw: Promise<void>) => { fileAcknowledgement = raw },
    holdPreparation: (raw: Promise<void>) => { preparation = raw } }
}

describe('actual private production peer', () => {
  it('delivers periodic real adapter freshness through the scoped peer while the desktop detaches without replay or transition effects', async () => {
    const f = fixture(), cli = join(f.root, 'controlled-pi.cjs'), receiptFile = join(f.root, 'child-receipt.json')
    const emptyPath = join(f.root, 'empty-path'); mkdirSync(emptyPath)
    writeFileSync(cli, `#!${process.execPath}\n` + readFileSync(join(process.cwd(), 'test/fixtures/agent-rpc-process.cjs'), 'utf8'), { mode: 0o700 })
    vi.stubEnv('HOME', f.root); vi.stubEnv('PATH', emptyPath); vi.stubEnv('PI_CODING_AGENT_DIR', f.root)
    vi.stubEnv('TWENTYX_SYNTHETIC_AGENT', '1'); vi.stubEnv('TWENTYX_FIXTURE_PROTOCOL', 'pi'); vi.stubEnv('TWENTYX_FIXTURE_RECEIPT', receiptFile)
    const adapter = new PiAdapter(); Object.assign(adapter, { piExecutablePath: cli }); f.useAdapter(adapter)
    const polls = vi.spyOn(adapter, 'getStatus')
    let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock)
    await f.initialize()
    const actual = f.service.getReadyServices()!, db = actual.db, project = db.getProjects()[0]
    const { projectEvents } = await import('../main/project-events')
    const projectEvent = vi.fn(); release.push(projectEvents.onEvent(projectEvent))
    db.updateProject(project.id, { settings: { ...project.settings, captain_wakeups: { enabled: false } } })
    const agent = db.getAgents()[0]; db.updateAgent(agent.id, { config: { coding_agent: 'pi', auth_method: 'subscription', max_parallel_sessions: 1 } })
    const task = db.createTask(makeTask())!; db.updateTask(task.id, { agent_id: agent.id })
    const started = await f.host.request('agentSession:start', { agentId: agent.id, taskId: task.id }) as { value: { sessionId: string } }
    let waitingId: string | undefined
    try {
      const heartbeatEvents = () => f.wireEvents.filter(event => event.operation === 'agent:status' && isRecord(event.payload) && event.payload.heartbeat === true)
      await expect.poll(() => heartbeatEvents().length, { timeout: 4000 }).toBe(1)
      expect(heartbeatEvents()[0].payload).toMatchObject({ sessionId: started.value.sessionId, taskId: task.id, status: 'waiting_approval', epoch: expect.any(String), seq: expect.any(Number) })
      await expect.poll(() => f.wireEvents.some(event => event.operation === 'transcript:changed'
        && JSON.stringify(event.payload).includes('native-permission-211')), { timeout: 4000 }).toBe(true)
      const waiting = db.createTask(makeTask({ title: 'Held by real admission' }))!; db.updateTask(waiting.id, { agent_id: agent.id })
      waitingId = waiting.id
      expect(await f.host.request('agentSession:start', { agentId: agent.id, taskId: waiting.id })).toMatchObject({ value: { queued: true, queuePosition: 1 } })
      // Positive control: observe the real initial permission transition on
      // the same module instance used by the reset production service graph.
      expect(projectEvent).toHaveBeenCalled(); projectEvent.mockClear()
      const external = vi.fn(); actual.agents.addExternalListener(external)
      release.push(() => actual.agents.removeExternalListener(external))
      const before = db.db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id)
      const schedulerStarts = [actual.automation, actual.recurrence, actual.heartbeat, actual.wakeups, actual.coordination, actual.cleanup].map(owner => vi.spyOn(owner, 'start'))
      expect(await f.service.owner.start()).toBe(actual)
      clock += 5000
      await expect.poll(() => heartbeatEvents().length, { timeout: 4000 }).toBe(2)
      const visible = heartbeatEvents()[1].payload as Record<string, JsonValue>, count = polls.mock.calls.length
      f.deny(); clock += 5000
      await expect.poll(() => polls.mock.calls.length, { timeout: 4000 }).toBeGreaterThan(count)
      await f.host.drain(); expect(heartbeatEvents()).toHaveLength(2)
      f.allow(); clock += 5000
      await expect.poll(() => heartbeatEvents().length, { timeout: 4000 }).toBe(3)
      const restored = heartbeatEvents()[2].payload as Record<string, JsonValue>
      expect(restored.epoch).toBe(visible.epoch); expect(restored.seq).toBeGreaterThan(visible.seq as number)
      expect(external).not.toHaveBeenCalled(); expect(projectEvent).not.toHaveBeenCalled()
      expect(schedulerStarts.every(start => start.mock.calls.length === 0)).toBe(true)
      expect(db.db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id)).toEqual(before)
      expect(actual.agents.getStartQueue()).toEqual([expect.objectContaining({ taskId: waiting.id, reason: 'agent_limit' })])
      const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'))
      expect(receipt).toMatchObject({ runtime: process.execPath, path: emptyPath, promptCount: 1 })
    } finally {
      f.allow()
      // Cancel the real queue before retiring the only occupied slot. Teardown
      // joins the TERM-refusing child before the ordinary application close.
      if (waitingId) await actual.agents.stopByTaskId(waitingId)
      await actual.agents.stopByTaskId(task.id)
      await f.service.close()
    }
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'))
    expect(() => process.kill(receipt.pid, 0)).toThrow()
    expect(db.db.open).toBe(false)
  }, 15_000)

  it('carries a known adapter disconnect as activity invalidation through the private peer without replaying its prompt', async () => {
    const f = fixture(); await f.initialize(); const actual = f.service.getReadyServices()!
    const agent = actual.db.getAgents()[0]; actual.db.updateAgent(agent.id, { config: { coding_agent: 'pi' } })
    const task = actual.db.createTask(makeTask())!; actual.db.updateTask(task.id, { agent_id: agent.id })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await f.host.request('agentSession:start', { agentId: agent.id, taskId: task.id })
    // The readiness probe must succeed before simulating an observed polling
    // disconnect; startup failure is a different lifecycle outcome.
    f.adapter.getStatus.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }))
    await expect.poll(() => f.wireEvents.find(event => event.operation === 'agent:status'
      && isRecord(event.payload) && event.payload.disconnected === true), { timeout: 4000 }).toBeDefined()
    const disconnected = f.wireEvents.find(event => isRecord(event.payload) && event.payload.disconnected === true)!.payload
    expect(disconnected).toMatchObject({ taskId: task.id, heartbeat: true, disconnected: true, epoch: expect.any(String), seq: expect.any(Number) })
    expect(disconnected).not.toHaveProperty('activityOutcome')
    expect(f.adapter.sendPrompt).toHaveBeenCalledOnce()
    expect(f.service.owner.snapshot().phase).toBe('ready')
    await f.service.close()
  })

  it('claims a private OAuth delivery before async exchange and preserves captured Source write authority', async () => {
    const f = fixture(false, false, false, false, false, false, false, false, false, true); await f.initialize()
    const db = f.service.getReadyServices()!.db
    const source = db.createTaskSource({ name: 'Synthetic private OAuth', plugin_id: 'linear', mcp_server_id: null, config: { client_id: 'synthetic' } })!
    const nonce = 'synthetic_nonce_0123456789', redirectUri = 'twentyonex://oauth/callback'
    let permitted = true
    const beforeEffect = (): void => { f.service.owner.getDatabaseBindingLease(); if (!permitted || db.getTaskSource(source.id)?.plugin_id !== 'linear') throw new Error('captured source intent retired') }
    const lease = await f.privateCallbacks().oauthFlows!.register({ kind: 'custom-scheme', redirectUri, ttlMs: 300000,
      authorizationUrl: `https://provider.example/authorize?state=${nonce}&redirect_uri=${encodeURIComponent(redirectUri)}` }, beforeEffect)
    await lease.open()
    const exchange = deferred(); release.push(exchange.finish)
    let exchanges = 0
    const raw = lease.waitForCallback().then(async () => {
      exchanges++
      await exchange.promise
      beforeEffect()
      db.createOAuthToken({ provider: 'linear', source_id: source.id, access_token: 'synthetic-token', refresh_token: null, expires_in: 3600, scope: null })
    }).finally(() => lease.close())
    void raw.catch(() => {})
    const payload = { flowId: lease.flowId, kind: 'custom-scheme', redirectUri, state: nonce, outcome: { status: 'code', code: 'synthetic-code' } }
    expect(await f.host.request('engine.oauth.callback', payload)).toEqual({ accepted: true })
    expect(exchanges).toBe(1)
    expect(db.getOAuthTokenBySource(source.id)).toBeUndefined()
    expect(await f.host.request('engine.oauth.callback', payload)).toEqual({ accepted: false })
    expect(f.nativeCalls.filter(value => value.startsWith('host.oauth'))).toEqual(['host.oauth.register', 'host.oauth.open'])
    permitted = false
    exchange.finish()
    await expect(raw).rejects.toThrow('captured source intent retired')
    expect(db.getOAuthTokenBySource(source.id)).toBeUndefined()
    expect(f.nativeCalls.filter(value => value.startsWith('host.oauth'))).toEqual(['host.oauth.register', 'host.oauth.open', 'host.oauth.retire'])
    expect(JSON.stringify(f.wireEvents)).not.toContain('synthetic-code')
    expect(JSON.stringify(f.wireEvents)).not.toContain(nonce)
    expect(Object.hasOwn(PRODUCTION_COMMAND_CODECS, 'engine.oauth.callback')).toBe(false)
  }, 15000)
  it('acknowledges private OAuth denial without token work or a delivery/retirement join cycle', async () => {
    const f = fixture(false, false, false, false, false, false, false, false, false, true); await f.initialize()
    const nonce = 'synthetic_nonce_0123456789', redirectUri = 'nuanu://oauth/callback'
    const lease = await f.privateCallbacks().oauthFlows!.register({ kind: 'custom-scheme', redirectUri, ttlMs: 300000,
      authorizationUrl: `https://provider.example/authorize?state=${nonce}&redirect_uri=${encodeURIComponent(redirectUri)}` }, () => {})
    await lease.open()
    const waiting = lease.waitForCallback()
    expect(await f.host.request('engine.oauth.callback', { flowId: lease.flowId, kind: 'custom-scheme', redirectUri, state: nonce, outcome: { status: 'denied' } })).toEqual({ accepted: true })
    await expect(waiting).rejects.toThrow('OAUTH_FLOW_DENIED')
    expect(f.nativeCalls.filter(value => value === 'host.oauth.retire')).toHaveLength(0)
    await lease.close()
  }, 15000)
  it('publishes finite owner failure metadata after initialize fails without retrying its effects', async () => {
    const f = fixture()
    await expect(f.host.request('engine.ownerState', {})).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    await f.host.request('engine.ping', {})
    expect(await f.host.request('engine.ownerState', {})).toEqual({ phase: 'new', stage: 'new', code: null, owned: false })
    rmSync(f.launch.paths.resourceRoot, { recursive: true, force: true })
    await expect(f.host.request('engine.initialize', { protocolVersion: 1, launchId: f.launch.launchId })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    const expected = { phase: 'failed', stage: 'resources', code: 'RESOURCE_UNAVAILABLE', owned: false }
    expect(await f.host.request('engine.ownerState', {})).toEqual(expected)
    expect(await f.host.request('engine.ownerState', {})).toEqual(expected)
    await expect(f.host.request('engine.ownerState', { path: '/private/canary' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(f.adapter.initialize).not.toHaveBeenCalled()
    expect(f.nativeCalls).toEqual(['drain'])
    expect(existsSync(join(f.launch.paths.profileRoot, '21x.db'))).toBe(false)
  }, 15_000)
  it('persists tray preferences through the actual owner and keeps the app-owned close lookup separate from renderer authority', async () => {
    const f = fixture(false, true, false, false, false, false, false, true); await f.initialize()
    const command = (operation: string, payload: JsonValue = {}, leaseId = 'document_fixture_1') => f.host.request('engine.tray.preferenceCommand', { operation, payload, leaseId })
    expect(await f.host.request('engine.tray.preference', {})).toEqual({ enabled: false })
    await expect(f.host.request('app:setMinimizeToTray', { enabled: true })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await command('app:setMinimizeToTray', { enabled: true })).toEqual({ defined: true, value: true })
    expect(f.service.getReadyServices()!.db.getSetting('minimize_to_tray')).toBe('true')
    expect(await f.host.request('engine.tray.preference', {})).toEqual({ enabled: true })
    f.changeUiLease('document_fixture_2')
    await expect(command('app:setMinimizeToTray', { enabled: false })).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    expect(await f.host.request('engine.tray.preference', {})).toEqual({ enabled: true })
    expect(await command('app:getMinimizeToTray', {}, 'document_fixture_2')).toEqual({ defined: true, value: true })
    f.denyWrites()
    await expect(command('app:setMinimizeToTray', { enabled: false }, 'document_fixture_2')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.service.getReadyServices()!.db.getSetting('minimize_to_tray')).toBe('true')
  })
  it('keeps tray controls unavailable without a captured native tray owner', async () => {
    const f = fixture(false, true); await f.initialize()
    await expect(f.host.request('engine.tray.preference', {})).rejects.toMatchObject({ code: 'DISCONNECTED' })
    await expect(f.host.request('engine.tray.preferenceCommand', { operation: 'app:setMinimizeToTray', payload: { enabled: true }, leaseId: 'document_fixture_1' })).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    expect(f.service.getReadyServices()!.db.getSetting('minimize_to_tray')).not.toBe('true')
  })
  it('retains the actual profile during a pending tray document check and suppresses a late preference write', async () => {
    const f = fixture(false, true, false, false, false, false, false, true); await f.initialize()
    const actual = f.service.getReadyServices()!, gate = deferred(); release.push(gate.finish); f.holdUiSnapshot(gate.promise)
    const work = f.host.request('engine.tray.preferenceCommand', { operation: 'app:setMinimizeToTray', payload: { enabled: true }, leaseId: 'document_fixture_1' })
    const failed = expect(work).rejects.toMatchObject({ code: 'CANCELLED' })
    await vi.waitFor(() => expect(f.uiSnapshots()).toBeGreaterThan(0))
    await expect(f.service.owner.close(5)).rejects.toThrow('OWNER_DRAIN_BLOCKED')
    expect(actual.db.db.open).toBe(true)
    expect(actual.db.getSetting('minimize_to_tray')).not.toBe('true')
    gate.finish(); await failed; await f.service.close()
    expect(actual.db.db.open).toBe(false)
  })
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
it.each(['open', 'download'] as const)('uses %s for real saved attachment metadata through private document ingress while its task agent is active under read grants', async method => {
  const f = fixture(false, true, false, method === 'open', method === 'download'); await f.initialize()
  const { services, task, attachment, path } = savedAttachment(f)
  const agent = services.db.getAgents()[0]; services.db.updateAgent(agent.id, { config: { coding_agent: 'pi' } }); services.db.updateTask(task.id, { agent_id: agent.id })
  await f.host.request('agentSession:start', { agentId: agent.id, taskId: task.id })
  expect(services.agents.hasTaskStartOwnership(task.id)).toBe(true)
  f.denyWrites()
  const getterTraces: string[] = [], actualTask = services.db.getTask.bind(services.db), actualAgent = services.db.getAgent.bind(services.db)
  vi.spyOn(services.db, 'getTask').mockImplementation(id => { getterTraces.push(new Error().stack!); return actualTask(id) })
  vi.spyOn(services.db, 'getAgent').mockImplementation(id => { getterTraces.push(new Error().stack!); return actualAgent(id) })
  const nativeGate = deferred(); release.push(nativeGate.finish); f.holdAttachmentAcknowledgement(nativeGate.promise)
  await expect(f.host.request(`attachments:${method}`, { taskId: task.id, attachmentId: attachment.id })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await expect(f.host.request(`engine.attachment.${method}`, { taskId: task.id, attachmentId: attachment.id, leaseId: 'document_fixture_1', path: '/foreign' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  const opening = f.host.request(`engine.attachment.${method}`, { taskId: task.id, attachmentId: attachment.id, leaseId: 'document_fixture_1' })
  await vi.waitFor(() => expect(f.attachmentReceipts).toHaveLength(1))
  // A real live agent continues to poll while the native file callback owns
  // its descriptor. Those application-owned reads have separate authority.
  await vi.waitFor(() => expect(getterTraces.some(trace => trace.includes('agent-manager-core.ts'))).toBe(true), { timeout: 5000 })
  nativeGate.finish(); await expect(opening).resolves.toEqual({ defined: false })
  if (method === 'download') {
    expect(f.attachmentAuthorizations).toHaveLength(1)
    await expect(f.host.request('engine.attachment.download.check', { authorizationId: f.attachmentAuthorizations[0] })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  }
  expect(getterTraces.filter(trace => /task-attachment|task-workspace-scope|getTaskAttachmentBindingLease/.test(trace))).toEqual([])
  expect(getterTraces.every(trace => trace.includes('agent-manager-core.ts'))).toBe(true)
  expect(f.attachmentReceipts).toEqual([expect.objectContaining({ attachmentRoot: f.launch.paths.attachmentRoot, path, taskId: task.id, attachmentId: attachment.id, filename: attachment.filename, target: expect.objectContaining({ size: String(attachment.size), nlink: '1', kind: 'file' }) })])
  expect(services.taskAttachmentFiles.inflightCount).toBe(0)
  expect(readFileSync(path).length).toBe(attachment.size)
  expect(services.db.db.prepare('SELECT attachments FROM tasks WHERE id=?').get(task.id)).toEqual({ attachments: JSON.stringify([attachment]) })
  expect(f.adapter.abortPrompt).not.toHaveBeenCalled(); expect(f.adapter.destroySession).not.toHaveBeenCalled()
}, 15000)
it.each(['open', 'download'] as const)('retains the exact %s callback and FD after cancel, refusing namespace deletion and profile release until acknowledgement', async method => {
  const f = fixture(false, true, false, method === 'open', method === 'download'); await f.initialize()
  const { services, task, attachment, path } = savedAttachment(f, 12), gate = deferred(); release.push(gate.finish); f.holdAttachmentAcknowledgement(gate.promise)
  const abort = new AbortController(), work = f.host.request(`engine.attachment.${method}`, { taskId: task.id, attachmentId: attachment.id, leaseId: 'document_fixture_1' }, { signal: abort.signal })
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
it.each(['open', 'download'] as const)('refuses native attachment %s when the captured launch does not advertise the callback', async method => {
  const f = fixture(false, true); await f.initialize()
  const { task, attachment, path } = savedAttachment(f, 12)
  await expect(f.host.request(`engine.attachment.${method}`, { taskId: task.id, attachmentId: attachment.id, leaseId: 'document_fixture_1' })).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
  expect(f.attachmentReceipts).toEqual([]); expect(existsSync(path)).toBe(true)
}, 15000)

it('rechecks live Source download scope after the dialog wait and retires authorization tickets without changing files', async () => {
  const f = fixture(false, true, false, false, true); await f.initialize()
  const { services, task, attachment, path } = savedAttachment(f, 12), gate = deferred(); release.push(gate.finish); f.holdAttachmentAcknowledgement(gate.promise)
  const work = f.host.request('engine.attachment.download', { taskId: task.id, attachmentId: attachment.id, leaseId: 'document_fixture_1' }), failure = expect(work).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await vi.waitFor(() => expect(f.attachmentAuthorizations).toHaveLength(1))
  const authorizationId = f.attachmentAuthorizations[0]
  expect(await f.host.request('engine.attachment.download.check', { authorizationId })).toEqual({ authorized: true })
  await expect(f.host.request('engine.attachment.download.check', { authorizationId: '00000000-0000-4000-8000-000000000001' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  const reassigned = services.db.createProject({ name: 'Reassigned while choosing a destination' })!
  services.db.db.prepare('UPDATE tasks SET project_id=? WHERE id=?').run(reassigned.id, task.id)
  await expect(f.host.request('engine.attachment.download.check', { authorizationId })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect(services.taskAttachmentFiles.inflightCount).toBeGreaterThan(0)
  gate.finish(); await failure
  await vi.waitFor(() => expect(services.taskAttachmentFiles.inflightCount).toBe(0))
  await expect(f.host.request('engine.attachment.download.check', { authorizationId })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect(readFileSync(path).length).toBe(attachment.size); expect(f.attachmentReceipts).toHaveLength(1)
}, 15000)

describe('private artifact clipboard handoff', () => {
  async function ready(capability = true) {
    const f = fixture(false, true, false, false, false, capability); await f.initialize()
    const actual = f.service.getReadyServices()!, task = actual.db.createTask(makeTask())!
    const directory = join(f.launch.paths.workspaceRoot, task.id); mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'report.md'), 'report')
    return { ...f, actual, task, request: { taskId: task.id, relativePath: 'report.md', leaseId: 'document_fixture_1' } }
  }
  it('keeps file copy independent of open authority, read-only, and refuses public lease manufacture and nonce replay', async () => {
    const f = await ready(); f.denyWrites()
    await expect(f.host.request('artifacts:copyFile', { taskId: f.task.id, relativePath: 'report.md' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await f.host.request('engine.artifact.copyFile', f.request)).toEqual({ defined: true, value: { mode: 'file' } })
    expect(f.fileReceipts).toEqual([expect.objectContaining({ taskId: f.task.id, path: join(f.launch.paths.workspaceRoot, f.task.id, 'report.md') })])
    expect(f.nativeCalls.filter(name => name === 'host.artifact.copyFile')).toHaveLength(1)
    await expect(f.host.request('engine.artifact.copyFile.check', { authorizationId: f.attachmentAuthorizations[0] })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.wireEvents.filter(event => event.operation === 'task:updated' || event.operation === 'artifact:updated')).toEqual([])
  })
  it('returns unavailable without probing native clipboard when its capability is absent', async () => {
    const f = await ready(false)
    expect(await f.host.request('engine.artifact.copyFile', f.request)).toEqual({ defined: true, value: { mode: 'unavailable' } })
    expect(f.fileReceipts).toEqual([])
  })
  it('returns unavailable without probing native clipboard when the saved file is absent', async () => {
    const f = await ready()
    expect(await f.host.request('engine.artifact.copyFile', { ...f.request, relativePath: 'missing.md' })).toEqual({ defined: true, value: { mode: 'unavailable' } })
    expect(f.fileReceipts).toEqual([])
  })
  it('rechecks the original scope immediately before native handoff after a queued permission change', async () => {
    const f = await ready(), gate = deferred(); release.push(gate.finish); f.holdFileAcknowledgement(gate.promise)
    const request = f.host.request('engine.artifact.copyFile', f.request), failure = expect(request).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await vi.waitFor(() => expect(f.fileReceipts).toHaveLength(1))
    f.deny(); gate.finish(); await failure
    expect(f.nativeCalls.filter(name => name === 'host.artifact.copyFile')).toEqual([])
  })
  it('keeps the raw callback and profile owner until acknowledgement even after cancellation', async () => {
    const f = await ready(), gate = deferred(); release.push(gate.finish); f.holdFileAcknowledgement(gate.promise)
    const abort = new AbortController(), raw = f.host.request('engine.artifact.copyFile', f.request, { signal: abort.signal })
    const cancelled = expect(raw).rejects.toMatchObject({ code: 'CANCELLED' })
    await vi.waitFor(() => expect(f.fileReceipts).toHaveLength(1)); abort.abort(); await cancelled
    expect(() => acquireProfileLock(f.launch.paths.profileRoot)).toThrow('PROFILE_DUPLICATE_OWNER')
    await expect(f.service.owner.close(5)).rejects.toThrow('OWNER_DRAIN_BLOCKED'); expect(f.service.getReadyServices()).toBeNull()
    let closed = false; const closing = f.service.close().then(() => { closed = true })
    await new Promise(resolve => setTimeout(resolve, 20)); expect(closed).toBe(false)
    gate.finish(); await closing
  })
})


describe('private native energy bridge around actual production ownership', () => {
  async function start(f: ReturnType<typeof fixture>) {
    const actual = f.service.getReadyServices()!, agent = actual.db.createAgent({ name: 'Owned energy session', config: { coding_agent: 'opencode' } })!, task = actual.db.createTask({ title: 'Background work' })!
    const result = await actual.agents.requestSession(agent.id, task.id)
    expect(result.status).toBe('started')
    return { actual, task }
  }
  it('keeps energy unsupported without a captured callback and never exposes it as a public desktop command', async () => {
    const f = fixture(); await f.initialize(); expect(f.privateCallbacks().setSleep).toBeUndefined()
    await expect(f.service.peer.request('host.sleep.set', { enabled: true })).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    expect(Object.hasOwn(PRODUCTION_COMMAND_CODECS, 'host.sleep.set')).toBe(false); expect(f.energyCalls).toEqual([])
  })
  it('routes actual session lifetime to the sealed native capability without a window or renderer publication', async () => {
    const f = fixture(false, false, false, false, false, false, false, false, true); await f.initialize()
    const { actual, task } = await start(f)
    await vi.waitFor(() => expect(f.energyCalls).toEqual([true]))
    f.launch.capabilities.energy = 'unsupported'
    await actual.agents.stopByTaskId(task.id)
    await vi.waitFor(() => expect(f.energyCalls).toEqual([true, false]))
    expect(f.service.owner.snapshot().phase).toBe('ready')
  })
  it.each(['refused', 'error', 'malformed'] as const)('keeps actual durable work alive after optional portal %s and does not replay activation', async mode => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = fixture(false, false, false, false, false, false, false, false, true); await f.initialize(); f.setEnergyResult(mode)
    const { actual, task } = await start(f)
    await vi.waitFor(() => expect(f.energyCalls.filter(value => value)).toHaveLength(1))
    await f.host.drain(); await Promise.resolve(); await Promise.resolve()
    expect(f.service.owner.snapshot().phase).toBe('ready'); expect(actual.agents.hasTaskStartOwnership(task.id)).toBe(true)
    expect(isRecord(await f.host.request('db:getTasks', {}))).toBe(true)
    await actual.agents.stopByTaskId(task.id)
    await vi.waitFor(() => expect(f.energyCalls.at(-1)).toBe(false))
    expect(f.energyCalls.filter(value => value)).toHaveLength(1)
  })
  it('retains the real profile during late activation and joins its final release before native drain', async () => {
    const f = fixture(false, false, false, false, false, false, false, false, true); await f.initialize()
    const gate = deferred(); release.push(gate.finish); f.holdEnergyAcknowledgement(gate.promise)
    const { actual } = await start(f); await vi.waitFor(() => expect(f.energyCalls).toEqual([true]))
    await expect(f.service.owner.close(5)).rejects.toThrow('OWNER_DRAIN_BLOCKED')
    expect(actual.db.db.open).toBe(true); expect(f.nativeCalls).not.toContain('drain')
    gate.finish(); await f.service.close()
    expect(f.energyCalls).toEqual([true, false]); expect(actual.db.db.open).toBe(false); expect(f.nativeCalls.at(-1)).toBe('drain')
  })
})

describe('private native notification bridge around actual production ownership', () => {
  it('has no status callback or host notification operation without the captured capability', async () => {
    const f = fixture(); await f.initialize()
    expect(f.privateCallbacks().notifyStatus).toBeUndefined()
    expect(() => f.privateCallbacks().notify('Optional unsupported update', 'No native effect')).not.toThrow()
    expect(f.service.getReadyServices()!.agents).toBeDefined()
    await expect(f.service.peer.request('host.notification.status', { title: 'Agent finished', body: 'A task is ready for review' })).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    expect(f.notificationCalls).toEqual([]); expect(f.service.getReadyServices()).not.toBeNull()
    for (const operation of ['host.notification.show', 'host.notification.status']) expect(Object.hasOwn(PRODUCTION_COMMAND_CODECS, operation)).toBe(false)
  })
  it('routes actual Manager status through the independent callback and preserves its captured descriptor scope', async () => {
    const f = fixture(false, false, false, false, false, false, true); await f.initialize()
    const db = f.service.getReadyServices()!.db, task = db.createTask({ title: 'Review the output' })!
    const callback = f.privateCallbacks().notifyStatus!; expect(typeof callback).toBe('function')
    f.launch.capabilities.notifications = 'unsupported'
    callback('Agent finished', 'A task is ready for review')
    await vi.waitFor(() => expect(f.notificationCalls).toHaveLength(1))
    await f.host.drain()
    expect(f.notificationCalls).toEqual([{ operation: 'host.notification.status', payload: { title: 'Agent finished', body: 'A task is ready for review' } }])
    // Use the actual production AgentManager host rather than a result facade.
    const manager = f.service.getReadyServices()!.agents, agent = db.createAgent({ name: 'Notification task owner' })!
    const publisher = manager as unknown as { sendToRenderer(channel: string, payload: unknown): void }
    const status = { sessionId: 'native_notification_session', agentId: agent.id, taskId: task.id }
    publisher.sendToRenderer('agent:status', { ...status, status: SessionStatus.WORKING })
    publisher.sendToRenderer('agent:status', { ...status, status: SessionStatus.WAITING_APPROVAL })
    f.privateCallbacks().notify('Human notification', 'General native messages remain unconditional')
    await vi.waitFor(() => expect(f.notificationCalls).toHaveLength(3)); await f.host.drain()
    expect(f.notificationCalls.slice(1)).toEqual([
      { operation: 'host.notification.status', payload: { title: 'Agent needs approval', body: '"Review the output" is waiting for your approval' } },
      { operation: 'host.notification.show', payload: { title: 'Human notification', body: 'General native messages remain unconditional' } }
    ])
    expect(f.service.getReadyServices()).not.toBeNull()
  })
  it.each(['denied', 'error', 'malformed', 'timeout'] as const)('keeps the singleton usable after optional native %s without retry or private public-command exposure', async result => {
    const f = fixture(false, false, false, false, false, false, true); await f.initialize(); f.setNotificationResult(result)
    f.privateCallbacks().notifyStatus!('Agent finished', 'A task is ready for review'); f.privateCallbacks().notify('General update', 'No automatic replay')
    await vi.waitFor(() => expect(f.notificationCalls).toHaveLength(2)); await f.host.drain(); await Promise.resolve(); await Promise.resolve()
    expect(f.notificationCalls).toHaveLength(2); expect(f.service.getReadyServices()).not.toBeNull()
    const tasks = await f.host.request('db:getTasks', {})
    expect(isRecord(tasks)).toBe(true); expect(f.service.owner.snapshot().phase).toBe('ready')
  })
  it('retains concurrent raw native callbacks through shutdown and suppresses new late publications', async () => {
    const f = fixture(false, false, false, false, false, false, true); await f.initialize(); const gate = deferred(); release.push(gate.finish); f.holdNotificationAcknowledgement(gate.promise)
    f.privateCallbacks().notifyStatus!('Agent finished', 'Held status'); f.privateCallbacks().notify('General update', 'Held general update')
    await vi.waitFor(() => expect(f.notificationCalls).toHaveLength(2))
    await expect(f.service.owner.close(5)).rejects.toThrow('OWNER_DRAIN_BLOCKED'); expect(f.service.getReadyServices()).toBeNull()
    let closed = false; const closing = f.service.close().then(() => { closed = true })
    await Promise.resolve(); expect(closed).toBe(false)
    f.privateCallbacks().notifyStatus!('Agent finished', 'Retired scope'); f.privateCallbacks().notify('General update', 'Retired scope')
    expect(f.notificationCalls).toHaveLength(2); gate.finish(); await closing; expect(closed).toBe(true); expect(f.notificationCalls).toHaveLength(2)
  })
})


describe('private selection receipts through actual service peer and SQLite owners',()=>{
 const selection={selectionId:'61f07006-c85b-438e-83a7-497c77b0dcae',path:'/tmp/selected.txt',filename:'selected.txt',size:131073},leaseId='document_fixture_1'
 function create(){return fixture(false,true,false,false,false,false,false,false,false,false,true)}
 it('registers only the native offer, refuses public path save, and returns one exact imported file without metadata append',async()=>{
  const f=create();await f.initialize();const db=f.service.getReadyServices()!.db,task=db.createTask(makeTask())!
  await expect(f.host.request('attachments:save',{taskId:task.id,filePath:selection.path})).rejects.toMatchObject({code:'INVALID_REQUEST'})
  await expect(f.host.request('engine.attachment.save',{taskId:task.id,filePath:selection.path,leaseId})).rejects.toMatchObject({code:'INVALID_REQUEST'})
  expect(await f.host.request('engine.attachment.selection.offer',{leaseId,selections:[selection]})).toEqual({accepted:true})
  const response=await f.host.request('engine.attachment.save',{taskId:task.id,filePath:selection.path,leaseId}) as {defined:true,value:typeof selection&{id:string}}
  expect(response).toMatchObject({defined:true,value:{filename:selection.filename,size:selection.size,mime_type:'text/plain'}})
  expect(readFileSync(join(f.launch.paths.attachmentRoot,task.id,`${response.value.id}-${response.value.filename}`))).toEqual(Buffer.alloc(selection.size,7))
  expect(db.getTask(task.id)!.attachments).toEqual([])
  expect(f.nativeCalls.filter(v=>v==='host.attachment.selection.read')).toHaveLength(3);expect(f.nativeCalls).toContain('host.attachment.selection.finish');expect(f.nativeCalls).toContain('host.attachment.selection.retire')
  await expect(f.host.request('engine.attachment.save',{taskId:task.id,filePath:selection.path,leaseId})).rejects.toMatchObject({code:'INVALID_REQUEST'})
 })
 it('retains actual database/profile ownership while a cancelled raw read remains unsettled',async()=>{
  const f=create();await f.initialize();const actual=f.service.getReadyServices()!,task=actual.db.createTask(makeTask())!
  await f.host.request('engine.attachment.selection.offer',{leaseId,selections:[selection]});const gate=deferred();release.push(gate.finish);f.holdAttachmentAcknowledgement(gate.promise)
  const abort=new AbortController(),pending=f.host.request('engine.attachment.save',{taskId:task.id,filePath:selection.path,leaseId},{signal:abort.signal}),failure=expect(pending).rejects.toMatchObject({code:'CANCELLED'})
  await vi.waitFor(()=>expect(f.nativeCalls).toContain('host.attachment.selection.read'));abort.abort();await failure
  await expect(f.service.owner.close(5)).rejects.toThrow('OWNER_DRAIN_BLOCKED');expect(actual.db.db.open).toBe(true);expect(f.nativeCalls).not.toContain('host.attachment.selection.retire')
  gate.finish();await f.service.close();expect(actual.db.db.open).toBe(false);expect(f.nativeCalls.filter(v=>v==='host.attachment.selection.read')).toHaveLength(1);expect(f.nativeCalls).toContain('host.attachment.selection.retire')
 })
 it('private group revocation fences an accepted import and joins its raw read before retirement without changing metadata',async()=>{
  const f=create();await f.initialize();const actual=f.service.getReadyServices()!,task=actual.db.createTask(makeTask())!
  await f.host.request('engine.attachment.selection.offer',{leaseId,selections:[selection]})
  const gate=deferred();release.push(gate.finish);f.holdAttachmentAcknowledgement(gate.promise)
  const pending=f.host.request('engine.attachment.save',{taskId:task.id,filePath:selection.path,leaseId})
  const failed=expect(pending).rejects.toMatchObject({code:'INVALID_REQUEST'})
  await vi.waitFor(()=>expect(f.nativeCalls).toContain('host.attachment.selection.read'))
  let settled=false
  const retired=f.host.request('engine.attachment.selection.revoke',{leaseId,selectionIds:[selection.selectionId]}).then(value=>{settled=true;return value})
  // A subsequent private ping is a wire-order barrier, not a timing guess.
  await f.host.request('engine.ping',{});expect(settled).toBe(false);expect(f.nativeCalls).not.toContain('host.attachment.selection.retire')
  gate.finish();await failed;await expect(retired).resolves.toEqual({retired:true})
  expect(actual.db.getTask(task.id)!.attachments).toEqual([])
  expect(readdirSync(join(f.launch.paths.attachmentRoot,task.id))).toEqual([])
  expect(f.nativeCalls.filter(v=>v==='host.attachment.selection.read')).toHaveLength(1)
  expect(f.nativeCalls.filter(v=>v==='host.attachment.selection.retire')).toHaveLength(1)
  await expect(f.host.request('engine.attachment.save',{taskId:task.id,filePath:selection.path,leaseId})).rejects.toMatchObject({code:'INVALID_REQUEST'})
 })
 it('private revocation before an offer refuses resurrection without reading files',async()=>{
  const f=create();await f.initialize();const calls=[...f.nativeCalls]
  await expect(f.host.request('engine.attachment.selection.revoke',{leaseId,selectionIds:[selection.selectionId]})).resolves.toEqual({retired:true})
  await expect(f.host.request('engine.attachment.selection.offer',{leaseId,selections:[selection]})).resolves.toEqual({accepted:false})
  expect(f.nativeCalls).toEqual(calls)
 })
})


describe('private native window state under the actual profile owner', () => {
  const state = { version: 1, x: -1920, y: 100, width: 1400, height: 900, scale: 1, maximized: true, fullscreen: false }
  it('retains exact profile geometry privately while a document reload has no authority to choose a setting or profile', async () => {
    const f = fixture(false, true, false, false, false, false, false, false, false, false, false, true)
    await f.initialize(); f.changeUiLease(null)
    expect(await f.host.request('engine.windowState.load', {})).toEqual({ state: null })
    expect(await f.host.request('engine.windowState.save', { state })).toEqual({ saved: true })
    expect(await f.host.request('engine.windowState.load', {})).toEqual({ state })
    await expect(f.host.request('settings:get', { key: '__native_window_state_v1' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    await expect(f.host.request('engine.windowState.save', { state, profileId: 'foreign' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(await f.host.request('engine.windowState.load', {})).toEqual({ state })
  })
  it('refuses missing native capability and parent shutdown before persistence', async () => {
    const f = fixture(); await f.initialize()
    await expect(f.host.request('engine.windowState.save', { state })).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(f.service.getReadyServices()!.db.db.prepare("SELECT 1 FROM settings WHERE key='__native_window_state_v1'").get()).toBeUndefined()
  })
})

it('delivers bounded saved raster bytes only through native-stamped private ingress and repeated actual document receipts',async()=>{
 const f=fixture(false,true,false,true);await f.initialize()
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII='
 const {services,task,attachment,path}=savedAttachment(f,Buffer.from(png,'base64').length)
 const record={...attachment,mime_type:'image/png'};services.db.updateTask(task.id,{attachments:[record]});writeFileSync(path,Buffer.from(png,'base64'));f.denyWrites()
 await expect(f.host.request('attachments:readImage',{taskId:task.id,attachmentId:record.id})).rejects.toMatchObject({code:'UNKNOWN_OPERATION'})
 const input={taskId:task.id,attachmentId:record.id,leaseId:'document_fixture_1'}
 expect(await f.host.request('engine.attachment.image',input)).toEqual({defined:true,value:{mimeType:'image/png',data:png}})
 expect(f.uiSnapshots()).toBeGreaterThanOrEqual(4);expect(f.attachmentReceipts).toEqual([])
 const gate=deferred();release.push(gate.finish);f.holdUiSnapshot(gate.promise)
 const before=f.uiSnapshots(),pending=f.host.request('engine.attachment.image',input),failure=expect(pending).rejects.toMatchObject({code:'STALE_EPOCH'})
 await vi.waitFor(()=>expect(f.uiSnapshots()).toBeGreaterThan(before));f.changeUiLease('replacement_document');gate.finish();await failure
 expect(services.db.getTask(task.id)!.attachments).toEqual([record]);expect(f.attachmentReceipts).toEqual([])
})
it('retains a raw image document callback across requester cancellation and prevents premature Source database release',async()=>{
 const f=fixture(false,true,false,true);await f.initialize();const {services,task,attachment}=savedAttachment(f,12),gate=deferred();release.push(gate.finish);f.holdUiSnapshot(gate.promise)
 const abort=new AbortController(),before=f.uiSnapshots(),pending=f.host.request('engine.attachment.image',{taskId:task.id,attachmentId:attachment.id,leaseId:'document_fixture_1'},{signal:abort.signal}),failure=expect(pending).rejects.toMatchObject({code:'CANCELLED'})
 await vi.waitFor(()=>expect(f.uiSnapshots()).toBeGreaterThan(before));abort.abort();await failure
 await expect(f.service.owner.close(5)).rejects.toThrow('OWNER_DRAIN_BLOCKED');expect(services.db.db.open).toBe(true)
 gate.finish();await f.service.close();expect(services.db.db.open).toBe(false);expect(f.attachmentReceipts).toEqual([])
})

if (process.env.TAURI_PRODUCTION_SERVICE_ENTRY) it('uses the actual staged production engine for saved raster bytes and physical-document rejection',async()=>{
 ;({ProductionService,sealProductionServiceHost}=await import(/* @vite-ignore */ pathToFileURL(join(dirname(process.env.TAURI_PRODUCTION_SERVICE_ENTRY!), 'production-engine.mjs')).href))
 const f=fixture(false,true,false,true);await f.initialize()
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII='
 const {services,task,attachment,path}=savedAttachment(f,Buffer.from(png,'base64').length);services.db.updateTask(task.id,{attachments:[{...attachment,mime_type:'image/png'}]});writeFileSync(path,Buffer.from(png,'base64'));f.denyWrites()
 const input={taskId:task.id,attachmentId:attachment.id,leaseId:'document_fixture_1'}
 expect(await f.host.request('engine.attachment.image',input)).toEqual({defined:true,value:{mimeType:'image/png',data:png}})
 f.changeUiLease('new_staged_document');await expect(f.host.request('engine.attachment.image',input)).rejects.toMatchObject({code:'STALE_EPOCH'})
 expect(f.attachmentReceipts).toEqual([]);expect(f.uiSnapshots()).toBeGreaterThanOrEqual(5)
 await f.service.close();expect(services.db.db.open).toBe(false)
})
