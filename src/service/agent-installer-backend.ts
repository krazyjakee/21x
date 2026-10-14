import { AgentDetectionError, PortableAgentDetectionOwner } from '../main/agent-installer/portable-detection'
import { AgentInstallationError, PortableAgentInstallationOwner } from '../main/agent-installer/portable-installation'
import { AGENT_INSTALLER_CODECS, AGENT_INSTALLER_EVENT_CODECS, AGENT_INSTALLER_LIMITS, AGENT_INSTALLER_OPERATIONS, projectAgentInstallerProgress, type AgentInstallerCodec, type AgentInstallerName, type AgentInstallerOperation } from '../shared/agent-installer-codecs'
import type { DesktopCommandMap, DesktopEventMap } from '../shared/desktop-operations'
import { isUiLeaseId } from '../shared/ui-desktop-codecs'
import { isJsonValue, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

type InstallResult = DesktopCommandMap['agent-installer:install']['result']
type Progress = DesktopEventMap['agent-installer:progress']
export interface AgentInstallerOwners { detection: PortableAgentDetectionOwner; installation?: PortableAgentInstallationOwner }
export interface AgentInstallerBackendOptions extends AgentInstallerOwners {
  engineEpoch: string
  assertAvailable(): void
  assertOwners(owners: AgentInstallerOwners): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canManageConfiguration(caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  /** Root holds actual selected backend/provider/admission leases and retains
   * failed-install fences. Required whenever installation is supplied. */
  canInstallBackend?(agentName: AgentInstallerName, caller: DesktopCallerContext): boolean
  runInstallation?(agentName: AgentInstallerName, caller: DesktopCallerContext, effect: () => Promise<InstallResult>, beforeEffect: () => void, signal: AbortSignal): Promise<InstallResult>
  /** The document identity is stamped by native ingress, never a public DTO. */
  isCurrentProgressRecipient?(caller: DesktopCallerContext): boolean
  emitProgress?(progress: Progress, caller: DesktopCallerContext): void | Promise<void>
}

/** Detection can stand alone. Installation borrows a real private process
 * owner and an actual Root configuration lease, with no shell fallback. */
export class AgentInstallerBackend {
  readonly registry: DesktopOperationRegistry
  private readonly owners: AgentInstallerOwners
  private closing = false
  private installing = false
  private readonly work = new Set<Promise<unknown>>()
  private readonly controllers = new Set<AbortController>()
  constructor(private readonly options: AgentInstallerBackendOptions) {
    this.owners = Object.freeze({ detection: options.detection, ...(options.installation ? { installation: options.installation } : {}) })
    if (!(options.detection instanceof PortableAgentDetectionOwner) || options.installation && (!(options.installation instanceof PortableAgentInstallationOwner) || typeof options.runInstallation !== 'function' || typeof options.canInstallBackend !== 'function') || options.emitProgress && (!options.installation || typeof options.isCurrentProgressRecipient !== 'function')) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.available()
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    for (const operation of this.operations()) this.bind(operation)
    if (options.emitProgress) this.registry.bindEvent('agent-installer:progress', AGENT_INSTALLER_EVENT_CODECS['agent-installer:progress'])
  }
  get inflightCount(): number { return this.work.size }
  private operations(): readonly AgentInstallerOperation[] { return this.owners.installation ? AGENT_INSTALLER_OPERATIONS : ['agent-installer:detect'] }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(this.operations().map(operation => [operation, {
      validatePayload: (value: unknown) => { try { return isJsonValue(value) && AGENT_INSTALLER_CODECS[operation].validateArguments(AGENT_INSTALLER_CODECS[operation].decodeArguments(value)) } catch { return false } },
      validateResult: AGENT_INSTALLER_CODECS[operation].validateWireResult,
      handle: (value: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, value, caller, signal)
    }]))
  }
  private available(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertAvailable(); this.options.assertOwners(this.owners)
    this.owners.detection.assertOpen()
    if (this.owners.installation) this.owners.installation.assertOwners({ detection: this.owners.detection, home: this.owners.installation.home, cwd: this.owners.installation.cwd })
  }
  private authorize(operation: AgentInstallerOperation, caller: DesktopCallerContext, signal?: AbortSignal, name?: AgentInstallerName): void {
    this.available(signal)
    if (caller.principal !== 'trusted-desktop-main' || caller.engineEpoch !== this.options.engineEpoch || !caller.webviewId || !caller.origin || !this.options.isTrustedDesktop(caller) || !this.options.canManageConfiguration(caller, 'read') || operation === 'agent-installer:install' && (!name || !this.options.canManageConfiguration(caller, 'write') || !this.options.canInstallBackend?.(name, caller))) throw new ServiceProtocolError('INVALID_REQUEST')
  }
  private error(error: unknown, signal: AbortSignal): never {
    if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
    if (error instanceof ServiceProtocolError) throw error
    if (error instanceof AgentDetectionError || error instanceof AgentInstallationError) {
      if (error.code.endsWith('_CANCELLED')) throw new ServiceProtocolError('CANCELLED')
      if (error.code.endsWith('_TIMEOUT')) throw new ServiceProtocolError('TIMEOUT')
      if (error.code.endsWith('_BACKPRESSURE')) throw new ServiceProtocolError('BACKPRESSURE')
      if (error.code.endsWith('_CLOSED')) throw new ServiceProtocolError('DISCONNECTED')
    }
    throw new ServiceProtocolError('INTERNAL_ERROR')
  }
  private async execute<K extends AgentInstallerOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext, signal: AbortSignal): Promise<DesktopCommandMap[K]['result']> {
    const name = operation === 'agent-installer:install' ? args[0] as AgentInstallerName : undefined
    let active = true, progressOpen = true
    let progressFailure: unknown
    const beforeEffect = (): void => { if (!active) throw new ServiceProtocolError('INVALID_REQUEST'); this.authorize(operation, caller, signal, name); if (progressFailure) throw progressFailure }
    const codec = AGENT_INSTALLER_CODECS[operation] as AgentInstallerCodec<K>
    const validate = (value: unknown): DesktopCommandMap[K]['result'] => { const wire = codec.encodeResult(value); return codec.decodeResult(wire.defined ? wire.value : undefined) }
    let progress = Promise.resolve(), phases = 0
    const onProgress = (event: { stage: string }): void => {
      if (!active || !progressOpen || !this.options.emitProgress || !name) return
      if (++phases > AGENT_INSTALLER_LIMITS.progressEvents) { progressFailure = new ServiceProtocolError('BACKPRESSURE'); return }
      let projected: Progress
      try { projected = projectAgentInstallerProgress(name, event.stage) }
      catch { progressFailure = new ServiceProtocolError('INVALID_RESULT'); return }
      // Fixed phase receipts are serialized and joined on cancellation. Raw
      // process stdout never enters this bounded queue.
      progress = progress.then(async () => {
        if (signal.aborted || this.closing || !isUiLeaseId(caller.uiLeaseId)) return
        this.authorize(operation, caller, signal, name)
        if (!this.options.isCurrentProgressRecipient?.(caller)) return
        await this.options.emitProgress!(projected, caller)
      }).catch(error => { progressFailure ??= error instanceof ServiceProtocolError ? error : new ServiceProtocolError('DISCONNECTED') })
    }
    try {
      beforeEffect()
      let result: unknown
      if (operation === 'agent-installer:detect') result = await this.owners.detection.detect(signal, { beforeEffect })
      else result = await this.options.runInstallation!(name!, caller, async () => {
        try {
          const value = await this.owners.installation!.install(name!, { beforeEffect, signal, onProgress })
          progressOpen = false
          await progress; beforeEffect()
          const wire = AGENT_INSTALLER_CODECS['agent-installer:install'].encodeResult(value)
          return AGENT_INSTALLER_CODECS['agent-installer:install'].decodeResult(wire.defined ? wire.value : undefined)
        } finally { progressOpen = false; await progress }
      }, beforeEffect, signal)
      beforeEffect()
      return validate(result)
    } catch (error) { this.error(error, signal) }
    finally { progressOpen = false; await progress; active = false }
  }
  private bind<K extends AgentInstallerOperation>(operation: K): void {
    const codec = AGENT_INSTALLER_CODECS[operation] as AgentInstallerCodec<K>
    this.registry.bindCommand(operation, {
      decodeRequest: value => codec.decodeArguments(structuredClone(value)), validateArguments: codec.validateArguments,
      authorize: (args, caller) => { this.authorize(operation, caller, undefined, operation === 'agent-installer:install' ? args[0] as AgentInstallerName : undefined); return true },
      invoke: (args, caller, signal) => {
        if (this.work.size >= AGENT_INSTALLER_LIMITS.requests || operation === 'agent-installer:install' && this.installing) throw new ServiceProtocolError('BACKPRESSURE')
        if (operation === 'agent-installer:install') this.installing = true
        const controller = new AbortController(), abort = (): void => controller.abort()
        this.controllers.add(controller); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) controller.abort()
        const raw = this.execute(operation, args, Object.freeze({ ...caller }), controller.signal)
        this.work.add(raw)
        const done = (): void => { signal.removeEventListener('abort', abort); this.controllers.delete(controller); this.work.delete(raw); if (operation === 'agent-installer:install') this.installing = false }
        void raw.then(done, done); return raw
      }, validateResult: codec.validateResult, encodeResult: codec.encodeResult
    })
  }
  stop(): void { this.closing = true; for (const controller of this.controllers) controller.abort() }
  shutdown(): void { this.stop() }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid installer boundary shutdown deadline')
    this.stop(); let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.allSettled([...this.work]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
}
