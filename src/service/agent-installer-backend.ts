import { AgentDetectionError, PortableAgentDetectionOwner } from '../main/agent-installer/portable-detection'
import { AGENT_INSTALLER_CODECS } from '../shared/agent-installer-codecs'
import { isJsonValue, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

export interface AgentInstallerOwners { detection: PortableAgentDetectionOwner }
export interface AgentInstallerBackendOptions extends AgentInstallerOwners {
  engineEpoch: string
  assertAvailable(): void
  assertOwners(owners: AgentInstallerOwners): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canManageConfiguration(caller: DesktopCallerContext, access: 'read'): boolean
}
export class AgentInstallerBackend {
  readonly registry: DesktopOperationRegistry
  private closing = false
  private readonly work = new Set<Promise<unknown>>()
  private readonly controllers = new Set<AbortController>()
  constructor(private readonly options: AgentInstallerBackendOptions) {
    this.available()
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    const codec = AGENT_INSTALLER_CODECS['agent-installer:detect']
    this.registry.bindCommand('agent-installer:detect', { decodeRequest: value => codec.decodeArguments(value), validateArguments: codec.validateArguments,
      authorize: (_args, caller) => { this.available(); return options.canManageConfiguration(caller, 'read') },
      invoke: (_args, caller, signal) => {
        const controller = new AbortController(), abort = () => controller.abort()
        this.controllers.add(controller); signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) controller.abort()
        const raw = (async () => {
          this.available(signal)
          if (!options.canManageConfiguration(caller, 'read')) throw new ServiceProtocolError('INVALID_REQUEST')
          let result
          try { result = await options.detection.detect(controller.signal) }
          catch (error) {
            if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
            if (error instanceof AgentDetectionError) throw new ServiceProtocolError(error.code === 'AGENT_DETECTION_CANCELLED' ? 'CANCELLED' : error.code === 'AGENT_DETECTION_TIMEOUT' ? 'TIMEOUT' : error.code === 'AGENT_DETECTION_BACKPRESSURE' ? 'BACKPRESSURE' : 'DISCONNECTED')
            throw new ServiceProtocolError('INTERNAL_ERROR')
          }
          this.available(signal)
          if (!options.canManageConfiguration(caller, 'read')) throw new ServiceProtocolError('INVALID_REQUEST')
          const wire = codec.encodeResult(result)
          return codec.decodeResult(wire.defined ? wire.value : undefined)
        })()
        this.work.add(raw)
        const done = () => { signal.removeEventListener('abort', abort); this.controllers.delete(controller); this.work.delete(raw) }
        void raw.then(done, done); return raw
      }, validateResult: codec.validateResult, encodeResult: codec.encodeResult })
  }
  get inflightCount(): number { return this.work.size }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    const codec = AGENT_INSTALLER_CODECS['agent-installer:detect']
    return { 'agent-installer:detect': {
      validatePayload: value => { try { return isJsonValue(value) && codec.validateArguments(codec.decodeArguments(value)) } catch { return false } },
      validateResult: codec.validateWireResult,
      handle: (value: JsonValue, signal: AbortSignal) => this.registry.invoke('agent-installer:detect', value, caller, signal)
    } }
  }
  private available(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertAvailable(); this.options.assertOwners(this.options)
    if (!(this.options.detection instanceof PortableAgentDetectionOwner)) throw new ServiceProtocolError('DISCONNECTED')
    this.options.detection.assertOpen()
  }
  stop(): void { this.closing = true; for (const controller of this.controllers) controller.abort() }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid installer detection boundary shutdown deadline')
    this.stop()
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.allSettled([...this.work]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
}
