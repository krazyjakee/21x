import { ATTACHMENT_NATIVE_CALLBACK_SCHEMAS, isAttachmentPathReceipt, isPrivateAttachmentOpen, type AttachmentPathReceipt } from '../shared/attachment-native-callbacks'
import { TASK_ATTACHMENT_CODECS } from '../shared/task-attachment-codecs'
import type { DesktopEventMap } from '../shared/desktop-operations'
import { AGENT_INSTALLER_CODECS } from '../shared/agent-installer-codecs'
import { UI_DESKTOP_CODECS } from '../shared/ui-desktop-codecs'
import { UI_NATIVE_CALLBACK_SCHEMAS, isNativeUiSnapshot, isNativeUiAcknowledgement, isPrivateUiPublication, isPrivateAgentInstallation } from '../shared/ui-native-callbacks'
import type { ProductionUiNativeHost } from '../main/production-ui-owner'
import type { ProductionLaunchDescriptor } from '../shared/production-bootstrap'
import { isProductionLaunchDescriptor, isProductionInitialize, PRODUCTION_HOST_SCHEMAS } from '../shared/production-bootstrap'
import { HOST_OPERATION_SCHEMAS } from '../shared/host-services'
import { isWorkspacePathReceipt, WORKSPACE_NATIVE_CALLBACK_SCHEMAS, type WorkspacePathReceipt } from '../shared/workspace-native-callbacks'
import { hasExactKeys, isBootstrapResult, isRecord, SERVICE_PROTOCOL_VERSION, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { ProductionOwner, type ProductionOwnerBootstrap, type ProductionOwnerExternalBoundaries, type ProductionServices } from './production-owner'
import { ProductionDesktopBindings, PRODUCTION_COMMAND_CODECS, PRODUCTION_EVENT_CODECS, validateProductionEventWire, type ProductionDesktopBindingOptions } from './production-desktop-bindings'
import { NativeApplicationKeyStore } from '../main/platform/native-application-key-store'
import { FULL_ACCESS_SCOPE, listToolsForScope } from '../main/mcp-servers/task-management-core'
import type { DesktopCallerContext } from './transport/desktop-registry'
import { ServicePeer, type OperationSchema } from './transport/peer'

export interface ProductionPrivateCallbacks {
  openAttachment(receipt: AttachmentPathReceipt, leaseId: string): Promise<void>
  ui: ProductionUiNativeHost
  emitInstallationProgress(progress: DesktopEventMap['agent-installer:progress'], leaseId: string): Promise<void>
  prepare(signal: AbortSignal): Promise<void>
  drain(): Promise<{ acknowledged: true }>
  openExternal(url: string): Promise<void>
  openPath(path: string, receipt: WorkspacePathReceipt): Promise<void>
  showItemInFolder(path: string, receipt: WorkspacePathReceipt): Promise<void>
  notify(title: string, body: string): void
  emitOwnerEvent(operation: string, payload: unknown): void
}
export interface ProductionServiceHostConstruction {
  descriptor: ProductionLaunchDescriptor
  /** Typed host construction, never exposed as a renderer/RPC operation. */
  constructBootstrap(callbacks: ProductionPrivateCallbacks): ProductionOwnerBootstrap
  authority: ProductionDesktopBindingOptions['authority']
  caller: Omit<DesktopCallerContext, 'engineEpoch'>
  /** Original sealed sink for owner events without reviewed transport codecs. */
  unbridgedOwnerEvent(operation: string, payload: unknown): void
  boundaries?: ProductionOwnerExternalBoundaries
}
const sealed = new WeakSet<object>()
export interface SealedProductionServiceHost { readonly construction: Readonly<ProductionServiceHostConstruction> }
export function sealProductionServiceHost(construction: ProductionServiceHostConstruction): SealedProductionServiceHost {
  if (!isProductionLaunchDescriptor(construction.descriptor) || construction.caller.principal !== 'trusted-desktop-main') throw new ServiceProtocolError('INVALID_ARGUMENTS')
  const descriptor: ProductionLaunchDescriptor = { ...construction.descriptor, paths: { ...construction.descriptor.paths }, capabilities: { ...construction.descriptor.capabilities } }
  Object.freeze(descriptor.paths); Object.freeze(descriptor.capabilities); Object.freeze(descriptor)
  const host = Object.freeze({ construction: Object.freeze({ ...construction, descriptor, caller: Object.freeze({ ...construction.caller }), authority: Object.freeze({ ...construction.authority }) }) })
  sealed.add(host)
  return host
}

/** Private pipe lifetime around the actual singleton; no RPC selects a profile. */
export class ProductionService {
  readonly peer: ServicePeer
  readonly owner: ProductionOwner
  private bindings: ProductionDesktopBindings | null = null
  private services: ProductionServices | null = null
  private initialized = false
  private initializing = false
  private pinged = false
  private closing = false
  private closeFlight: Promise<void> | null = null
  private initialization: Promise<void> | null = null
  private readonly domainFlights = new Set<Promise<unknown>>()
  private sequence = 0
  private readonly caller: DesktopCallerContext

  constructor(host: SealedProductionServiceHost, transport: {
    write(bytes: Uint8Array): Promise<void>
    onDisconnect?(error: ServiceProtocolError): void
    onShutdownRequested?(): void
  }) {
    if (!sealed.has(host)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    const construction = host.construction, descriptor = construction.descriptor
    const callbacks: ProductionPrivateCallbacks = {
      openAttachment: async (receipt, leaseId) => {
        if (descriptor.capabilities.attachmentFiles !== 'host') throw new ServiceProtocolError('UNKNOWN_OPERATION')
        if (!isAttachmentPathReceipt(receipt)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
        const result = await this.retain(this.peer.request('host.attachment.open', { receipt: structuredClone(receipt) as unknown as JsonValue, leaseId }))
        if (!isRecord(result) || !hasExactKeys(result, [])) throw new ServiceProtocolError('INVALID_RESULT')
      },
      ui: {
        snapshot: async () => {
          if (descriptor.capabilities.ui !== 'host') throw new ServiceProtocolError('UNKNOWN_OPERATION')
          const result = await this.retain(this.peer.request('host.ui.snapshot', {}))
          if (!isNativeUiSnapshot(result)) throw new ServiceProtocolError('INVALID_RESULT')
          return result
        },
        send: async (command, leaseId, signal) => {
          if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
          if (descriptor.capabilities.ui !== 'host') throw new ServiceProtocolError('UNKNOWN_OPERATION')
          // Keep the actual host callback owned even if the requester cancels.
          const result = await this.retain(this.peer.request('host.ui.command', { command: command as unknown as JsonValue, leaseId }))
          if (!isNativeUiAcknowledgement(result)) throw new ServiceProtocolError('INVALID_RESULT')
          return result
        }
      },
      emitInstallationProgress: async (progress, leaseId) => {
        if (descriptor.capabilities.ui !== 'host') throw new ServiceProtocolError('UNKNOWN_OPERATION')
        const acknowledgement = await this.retain(this.peer.request('host.ui.installerProgress', { progress: progress as unknown as JsonValue, leaseId }, { timeoutMs: 5000 }))
        if (!isNativeUiAcknowledgement(acknowledgement) || acknowledgement.ok && acknowledgement.leaseId !== leaseId) throw new ServiceProtocolError('INVALID_RESULT')
        // A retired document suppresses this phase receipt without redirecting
        // it to a replacement. The installation remains application-owned.
      },
      prepare: async signal => {
        if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
        const result = await this.peer.request('host.production.prepare', { launchId: descriptor.launchId, resourceManifestSha256: descriptor.resourceManifestSha256 })
        if (!isRecord(result) || result.launchId !== descriptor.launchId) throw new ServiceProtocolError('INVALID_RESULT')
      },
      drain: async () => {
        const result = await this.peer.request('host.production.drain', { launchId: descriptor.launchId })
        if (!isRecord(result) || result.launchId !== descriptor.launchId) throw new ServiceProtocolError('INVALID_RESULT')
        return { acknowledged: true }
      },
      openExternal: async url => {
        if (descriptor.capabilities.externalUrls !== 'host') throw new ServiceProtocolError('UNKNOWN_OPERATION')
        await this.peer.request('host.shell.openExternal', { url })
      },
      openPath: async (path, receipt) => {
        if (descriptor.capabilities.workspaceFiles !== 'host') throw new ServiceProtocolError('UNKNOWN_OPERATION')
        if (!isWorkspacePathReceipt(receipt) || receipt.path !== path) throw new ServiceProtocolError('INVALID_ARGUMENTS')
        await this.peer.request('host.workspace.openPath', { receipt: structuredClone(receipt) as unknown as JsonValue })
      },
      showItemInFolder: async (path, receipt) => {
        if (descriptor.capabilities.workspaceFiles !== 'host') throw new ServiceProtocolError('UNKNOWN_OPERATION')
        if (!isWorkspacePathReceipt(receipt) || receipt.path !== path) throw new ServiceProtocolError('INVALID_ARGUMENTS')
        await this.peer.request('host.workspace.showItemInFolder', { receipt: structuredClone(receipt) as unknown as JsonValue })
      },
      notify: (title, body) => {
        if (descriptor.capabilities.notifications !== 'host') throw new ServiceProtocolError('UNKNOWN_OPERATION')
        // This callback's raw flight belongs to the owner even if the native
        // consumer hides/reloads. Failure terminates publication, not a retry.
        const raw = this.peer.request('host.notification.show', { title, body })
        this.retain(raw)
        void raw.catch(() => this.peer.disconnect('DISCONNECTED'))
      },
      emitOwnerEvent: (operation, payload) => {
        if (!Object.hasOwn(PRODUCTION_EVENT_CODECS, operation)) { construction.unbridgedOwnerEvent(operation, payload); return }
        if (!this.initialized || this.closing || !this.bindings) return // durable hydration follows trusted initialize
        this.publishScoped(operation, this.bindings.encodeOwnerEvent(operation, payload))
      }
    }
    const bootstrap = construction.constructBootstrap(callbacks)
    if (bootstrap.profileId !== descriptor.profileId || Object.entries(descriptor.paths).some(([key, value]) => bootstrap.paths[key as keyof typeof bootstrap.paths] !== value) ||
      bootstrap.credentials.mode !== (descriptor.profileIntent === 'create-new' ? 'create' : 'load')) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    const nativeUi = bootstrap.native.ui
    if (descriptor.capabilities.ui === 'host' ? !nativeUi || typeof nativeUi.snapshot !== 'function' || typeof nativeUi.send !== 'function' : nativeUi !== undefined) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    if (descriptor.capabilities.attachmentFiles === 'host' ? typeof bootstrap.native.openAttachment !== 'function' || descriptor.capabilities.ui !== 'host' : bootstrap.native.openAttachment !== undefined) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.owner = new ProductionOwner(bootstrap, construction.boundaries)
    this.caller = { ...construction.caller, engineEpoch: this.owner.snapshot().epoch }
    const result = { protocolVersion: SERVICE_PROTOCOL_VERSION, engineEpoch: this.caller.engineEpoch, nodeVersion: process.version }
    const empty = (value: unknown): boolean => isRecord(value) && hasExactKeys(value, [])
    const operations: Record<string, OperationSchema> = Object.fromEntries(Object.entries(PRODUCTION_COMMAND_CODECS).map(([operation, codec]) => [operation, {
      validatePayload: (value: unknown) => {
        try { return codec.validateArguments(codec.decodeArguments(value as JsonValue)) } catch { return false }
      },
      validateResult: codec.validateWireResult,
      handle: (payload: JsonValue, signal: AbortSignal) => {
        if (!this.initialized || this.closing || !this.bindings) throw new ServiceProtocolError('DISCONNECTED')
        return this.retain(this.bindings.invoke(operation, payload, this.caller, signal))
      }
    }]))
    // Public invocation cannot manufacture a document lease. Only the native
    // window owner forwards this private request after checking physical identity.
    operations['ui:publishState'].handle = () => { throw new ServiceProtocolError('INVALID_REQUEST') }
    operations['engine.ui.publish'] = { validatePayload: isPrivateUiPublication,
      validateResult: UI_DESKTOP_CODECS['ui:publishState'].validateWireResult,
      handle: (payload, signal) => {
        if (!this.initialized || this.closing || !this.bindings || !isRecord(payload) || typeof payload.leaseId !== 'string') throw new ServiceProtocolError('DISCONNECTED')
        return this.retain(this.bindings.invoke('ui:publishState', { state: payload.state }, { ...this.caller, uiLeaseId: payload.leaseId }, signal))
      } }
    operations['agent-installer:install'].handle = () => { throw new ServiceProtocolError('INVALID_REQUEST') }
    operations['engine.agent.install'] = { validatePayload: isPrivateAgentInstallation,
      validateResult: AGENT_INSTALLER_CODECS['agent-installer:install'].validateWireResult,
      handle: (payload, signal) => {
        if (!this.initialized || this.closing || !this.bindings || !isRecord(payload) || typeof payload.leaseId !== 'string') throw new ServiceProtocolError('DISCONNECTED')
        return this.retain(this.bindings.invoke('agent-installer:install', { agentName: payload.agentName }, { ...this.caller, uiLeaseId: payload.leaseId }, signal))
      } }
    operations['attachments:open'].handle = () => { throw new ServiceProtocolError('INVALID_REQUEST') }
    operations['engine.attachment.open'] = { validatePayload: isPrivateAttachmentOpen,
      validateResult: TASK_ATTACHMENT_CODECS['attachments:open'].validateWireResult,
      handle: (payload, signal) => {
        if (!this.initialized || this.closing || !this.bindings || !isRecord(payload) || typeof payload.leaseId !== 'string') throw new ServiceProtocolError('DISCONNECTED')
        return this.retain(this.bindings.invoke('attachments:open', { taskId: payload.taskId, attachmentId: payload.attachmentId }, { ...this.caller, uiLeaseId: payload.leaseId }, signal))
      } }
    operations['engine.ping'] = { validatePayload: empty, validateResult: isBootstrapResult, handle: () => { this.pinged = true; return result } }
    operations['engine.initialize'] = { validatePayload: isProductionInitialize, validateResult: isBootstrapResult, handle: async (payload, signal) => {
      if (!this.pinged || this.initialized || this.initializing || this.closing || !isProductionInitialize(payload) || payload.launchId !== descriptor.launchId || signal.aborted) throw new ServiceProtocolError('INVALID_REQUEST')
      this.initializing = true
      const cancel = (): void => { void this.owner.close().catch(() => {}) }
      signal.addEventListener('abort', cancel, { once: true })
      const initialization = (async () => {
        this.services = await this.owner.start()
        if (this.closing || signal.aborted) throw new ServiceProtocolError('CANCELLED')
        this.bindings = await ProductionDesktopBindings.attach(this.owner, { authority: construction.authority,
          emit: (operation, value, recipient) => {
            if (recipient !== undefined && (recipient.webviewId !== this.caller.webviewId || recipient.origin !== this.caller.origin || recipient.engineEpoch !== this.caller.engineEpoch)) return
            if (this.initialized && !this.closing) this.publishScoped(operation, value)
          }, fatal: error => this.peer.disconnect(error.code) })
        this.owner.retainCleanup('private-service-flights', () => { this.closing = true }, () => this.drainDomains())
        if (signal.aborted || this.closing) throw new ServiceProtocolError('CANCELLED')
        this.initialized = true
      })()
      this.initialization = initialization
      try {
        await initialization
        // The initial owner observations were durable; invalidate content rather
        // than manufacturing provider/session heartbeat stamps from old events.
        setImmediate(() => { if (this.initialized && !this.closing) this.publishScoped('tasks:refresh', {}) })
        return result
      } catch (error) {
        if (this.owner.snapshot().phase === 'ready') void this.owner.close().catch(() => {})
        throw error
      } finally { signal.removeEventListener('abort', cancel) }
    } }
    operations['engine.shutdown'] = { validatePayload: empty, validateResult: value => isRecord(value) && hasExactKeys(value, ['stopped']) && value.stopped === true,
      handle: async () => {
        this.closing = true
        await this.owner.close()
        setImmediate(() => {
          void this.peer.drain().then(() => { this.peer.disconnect(); transport.onShutdownRequested?.() }, () => transport.onShutdownRequested?.())
        })
        return { stopped: true }
      } }
    for (const [operation, schema] of Object.entries(PRODUCTION_HOST_SCHEMAS)) operations[operation] = schema
    if (descriptor.capabilities.externalUrls === 'host') operations['host.shell.openExternal'] = { validatePayload: HOST_OPERATION_SCHEMAS['host.shell.openExternal'].validateRequest, validateResult: HOST_OPERATION_SCHEMAS['host.shell.openExternal'].validateResult }
    if (descriptor.capabilities.workspaceFiles === 'host') for (const [operation, schema] of Object.entries(WORKSPACE_NATIVE_CALLBACK_SCHEMAS)) operations[operation] = schema
    if (descriptor.capabilities.notifications === 'host') operations['host.notification.show'] = { validatePayload: HOST_OPERATION_SCHEMAS['host.notification.show'].validateRequest, validateResult: HOST_OPERATION_SCHEMAS['host.notification.show'].validateResult }
    if (descriptor.capabilities.ui === 'host') for (const [operation, schema] of Object.entries(UI_NATIVE_CALLBACK_SCHEMAS)) operations[operation] = schema
    if (descriptor.capabilities.attachmentFiles === 'host') for (const [operation, schema] of Object.entries(ATTACHMENT_NATIVE_CALLBACK_SCHEMAS)) operations[operation] = schema
    this.peer = new ServicePeer({ role: 'service', engineEpoch: this.caller.engineEpoch, operations,
      eventSchemas: Object.fromEntries(Object.keys(PRODUCTION_EVENT_CODECS).map(operation => [operation, (value: unknown) => validateProductionEventWire(operation, value)])),
      write: transport.write, onDisconnect: error => {
        this.closing = true
        // Fence actual schedulers/providers even when an ordinary EventEmitter
        // observer swallows the codec/publication exception. Missing native
        // drain acknowledgement keeps the lease; it is never synthesized.
        void this.owner.close().catch(() => {})
        transport.onDisconnect?.(error)
      } })
  }
  /** Sealed host policy can inspect the actual ready singleton, never RPC data. */
  getReadyServices(): ProductionServices | null {
    return !this.closing && this.owner.snapshot().phase === 'ready' ? this.services : null
  }
  private publishScoped(operation: string, payload: JsonValue): void {
    try {
      const projected = this.bindings?.projectOwnerEvent(operation, payload, this.caller)
      if (projected !== undefined) this.publish(operation, projected)
    } catch { this.peer.disconnect('INVALID_RESULT') }
  }
  private publish(operation: string, payload: JsonValue): void {
    try { this.peer.emit(operation, payload, ++this.sequence) }
    catch (error) { this.peer.disconnect(error instanceof ServiceProtocolError ? error.code : 'INVALID_RESULT') }
  }
  private retain<T>(raw: Promise<T>): Promise<T> {
    this.domainFlights.add(raw)
    void raw.then(() => this.domainFlights.delete(raw), () => this.domainFlights.delete(raw))
    return raw
  }
  private async drainDomains(): Promise<void> { while (this.domainFlights.size) await Promise.allSettled([...this.domainFlights]) }
  /** Keep callback pipes open through acknowledged owner drain. A disconnected
   * host cannot be replaced by a fabricated native process-tree acknowledgement. */
  close(): Promise<void> {
    if (this.closeFlight) return this.closeFlight
    this.closing = true
    const close = (async () => {
      await this.owner.close()
      await this.initialization?.catch(() => undefined)
      await this.drainDomains()
      this.peer.disconnect()
      await this.peer.waitForHandlers()
    })()
    this.closeFlight = close.finally(() => { this.closeFlight = null })
    return this.closeFlight
  }
}

/** Used only by the separately staged entry after physical resource verification.
 * The private host must validate its main WebView before forwarding commands. */
export function createStagedProductionService(descriptor: ProductionLaunchDescriptor, resources: { node: string; credentialHelper: string; taskMcp: string; mobileDistRoot?: string; voice?: { recognitionWorker: string; speechWorker: string } }, transport: ConstructorParameters<typeof ProductionService>[1]): ProductionService {
  const trusted = (caller: DesktopCallerContext): boolean => caller.principal === 'trusted-desktop-main' && caller.webviewId === 'main' && caller.origin === 'tauri://localhost' && caller.engineEpoch === service.owner.snapshot().epoch && service.getReadyServices() !== null
  const authority: ProductionDesktopBindingOptions['authority'] = {
    isTrustedDesktop: trusted,
    // The authenticated main desktop owns the complete application profile.
    // Existence is validated by each finite domain operation, independently of
    // this grant: deleting a row must not revoke its durable tombstone event.
    canAccessTask: (_id, caller) => trusted(caller),
    canAccessProject: (_id, caller) => trusted(caller),
    canAccessAgent: (_id, caller) => trusted(caller),
    canAccessSource: (_id, caller) => trusted(caller),
    canAccessSession: (_id, caller) => trusted(caller),
    canAccessGlobalCommander: trusted, canManageGlobalConfiguration: trusted, canCreateProject: trusted,
    canEditSettings: trusted, canAccessGlobalSkills: trusted, canChangeSkillScope: trusted, canReorderProjects: trusted,
    canQueryBackend: (_type, _url, caller) => trusted(caller),
    canReadSetting: (_key, caller) => trusted(caller), canWriteSetting: (_key, caller) => trusted(caller),
    canAccessSecret: (_id, caller) => trusted(caller), canCreateSecret: trusted,
    canUseSecretEnvironment: (_name, caller) => trusted(caller), canReadEnvironment: (_key, caller) => trusted(caller),
    canAccessTerminal: (_id, caller) => trusted(caller), resolveTerminalDirectory: (_id, caller) => trusted(caller)
      ? { cwd: descriptor.paths.workspaceRoot, root: descriptor.paths.workspaceRoot } : null,
    canAccessCli: (_cli, caller) => trusted(caller),
    canAccessMcpServer: (_id, caller) => trusted(caller),
    canUseTransport: (_input, caller) => trusted(caller) && descriptor.capabilities.configuredMcp === 'enabled',
    canUseEnvironmentName: (_name, caller) => trusted(caller),
    canAccessConnector: (_id, caller) => trusted(caller) && descriptor.capabilities.connectors === 'enabled',
    canCreateInstance: (_piece, caller) => trusted(caller) && descriptor.capabilities.connectors === 'enabled',
    canUsePiece: (_piece, caller) => trusted(caller) && descriptor.capabilities.connectors === 'enabled',
    canBorrowSourceCredentials: (_source, _plugin, caller) => trusted(caller),
    canResolveUnsavedConfig: (_plugin, caller) => trusted(caller),
    canManageMobile: (caller, access) => trusted(caller) && authority.canManageGlobalConfiguration(caller, access),
    canAccessMobileSession: (_id, caller) => trusted(caller),
    canAccessMarketplace: (_id, caller) => trusted(caller), canCreateMarketplace: (_data, caller) => trusted(caller),
    canAccessPluginName: (_name, _marketplace, caller) => trusted(caller), canAccessPlugin: (_id, caller) => trusted(caller),
    // Arbitrary local marketplace reads need a reviewed native path grant.
    canUseMarketplaceSource: (source, caller) => trusted(caller) && source.source_type !== 'local',
    canUsePluginSource: (_source, marketplace, _root, caller) => trusted(caller) && marketplace.source_type !== 'local',
    canUsePluginAddress: (address, caller) => {
      if (!trusted(caller)) return false
      try { const url = new URL(address); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password } catch { return false }
    },
    canAccessSkill: (_id, caller) => trusted(caller), canCreateGlobalSkill: (_data, caller) => trusted(caller),
    canCreateAgent: (_data, caller) => trusted(caller),
    canCreateMcpServer: (_data, caller) => trusted(caller) && descriptor.capabilities.configuredMcp === 'enabled',
    canUseSourcePlugin: (id, caller) => trusted(caller) && !!service.getReadyServices()?.registry.get(id) &&
      (id !== 'connector-bridge' || descriptor.capabilities.connectors === 'enabled')
  }
  const host = sealProductionServiceHost({ descriptor, authority, caller: { principal: 'trusted-desktop-main', webviewId: 'main', origin: 'tauri://localhost' },
    unbridgedOwnerEvent: () => { process.stderr.write('PRODUCTION_NATIVE_EVENT_UNSUPPORTED\n') },
    constructBootstrap: callbacks => ({ agentInstallation: { nodeExecutable: resources.node }, profileId: descriptor.profileId, paths: descriptor.paths,
      credentials: { store: new NativeApplicationKeyStore(resources.credentialHelper), mode: descriptor.profileIntent === 'create-new' ? 'create' : 'load' },
      ...(resources.mobileDistRoot === undefined ? {} : { mobile: { distRoot: resources.mobileDistRoot } }),
      ...(resources.voice === undefined ? {} : { voice: { ...resources.voice, node: resources.node } }),
      connectors: descriptor.capabilities.connectors === 'enabled' ? { kind: 'enabled' } : { kind: 'disabled', reason: 'Private launch explicitly disables connectors' },
      managedTaskMcp: descriptor.capabilities.managedTaskMcp === 'disabled' ? { disabled: true } : {
        command: resources.node, args: [resources.taskMcp], environment: {}, tools: listToolsForScope(FULL_ACCESS_SCOPE).map(tool => ({ name: tool.name, description: tool.description ?? '' })) },
      native: { agents: { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, configuredMcp: descriptor.capabilities.configuredMcp },
        prepareRuntime: callbacks.prepare, drainOwnedProcesses: callbacks.drain, openExternal: callbacks.openExternal,
        ...(descriptor.capabilities.workspaceFiles === 'host' ? { openPath: callbacks.openPath, showItemInFolder: callbacks.showItemInFolder } : {}),
        ...(descriptor.capabilities.attachmentFiles === 'host' ? { openAttachment: callbacks.openAttachment } : {}),
        // Browser opening alone does not register or own OAuth deep-link callbacks.
        oauthBrowser: 'unavailable',
        ...(descriptor.capabilities.ui === 'host' ? { ui: callbacks.ui, emitInstallationProgress: callbacks.emitInstallationProgress } : {}),
        notify: callbacks.notify, emit: callbacks.emitOwnerEvent,
        sendUiCommand: () => ({ ok: false, detail: 'Private production launch has no reviewed UI command callback' }) }
    }) })
  const service = new ProductionService(host, transport)
  return service
}
