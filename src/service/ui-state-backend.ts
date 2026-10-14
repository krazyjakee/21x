import type { DatabaseManager } from '../main/database/manager'
import type { AgentManager } from '../main/agent-manager'
import { ProductionUiOwner, assertUiStateReferences } from '../main/production-ui-owner'
import type { UiStateSnapshot } from '../shared/ui-commands'
import { UI_DESKTOP_CODECS, isUiLeaseId } from '../shared/ui-desktop-codecs'
import { isJsonValue, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

export interface UiStateOwners { database: DatabaseManager; manager: AgentManager; ui: ProductionUiOwner }
export interface UiStateBackendOptions extends UiStateOwners {
  engineEpoch: string
  assertAvailable(): void
  assertUiOwners(owners: UiStateOwners): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canPublishUi(caller: DesktopCallerContext): boolean
  canAccessProject(id: string, caller: DesktopCallerContext, access: 'read'): boolean
  canAccessTask(id: string, caller: DesktopCallerContext, access: 'read'): boolean
  canAccessAgent(id: string, caller: DesktopCallerContext, access: 'read'): boolean
}
/** Publication is associated with a native-stamped document lease, never a
 * public lease or availability flag in renderer JSON. */
export class UiStateBackend {
  readonly registry: DesktopOperationRegistry
  private closing = false
  private readonly work = new Set<Promise<unknown>>()
  private readonly requests = new Set<AbortController>()
  constructor(private readonly options: UiStateBackendOptions) {
    if (!(options.ui instanceof ProductionUiOwner)) throw new ServiceProtocolError('DISCONNECTED')
    this.available()
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    const codec = UI_DESKTOP_CODECS['ui:publishState']
    this.registry.bindCommand('ui:publishState', {
      decodeRequest: payload => codec.decodeArguments(structuredClone(payload)), validateArguments: codec.validateArguments,
      authorize: ([state], caller) => { this.current(state as unknown as UiStateSnapshot, caller); return true },
      validateResult: codec.validateResult, encodeResult: codec.encodeResult,
      invoke: ([value], caller, signal) => {
        if (this.work.size >= 64) throw new ServiceProtocolError('BACKPRESSURE')
        const state = structuredClone(value) as unknown as UiStateSnapshot, identity = Object.freeze({ ...caller }), request = new AbortController()
        const cancel = () => request.abort(); signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel()
        this.requests.add(request)
        const beforeEffect = () => { this.available(request.signal); this.current(state, identity) }
        const raw = Promise.resolve().then(() => this.options.ui.publish(state, identity.uiLeaseId!, { beforeEffect, signal: request.signal }))
        this.work.add(raw)
        void raw.finally(() => { this.work.delete(raw); this.requests.delete(request); signal.removeEventListener('abort', cancel) }).catch(() => {})
        return raw
      }
    })
  }
  get inflightCount(): number { return this.work.size }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    const codec = UI_DESKTOP_CODECS['ui:publishState']
    return { 'ui:publishState': {
      validatePayload: value => { try { return isJsonValue(value) && codec.validateArguments(codec.decodeArguments(value)) } catch { return false } },
      validateResult: codec.validateWireResult,
      handle: (value: JsonValue, signal: AbortSignal) => this.registry.invoke('ui:publishState', value, caller, signal)
    } }
  }
  shutdown(): void { this.closing = true; for (const request of this.requests) request.abort() }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid UI backend shutdown deadline')
    this.shutdown(); let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([(async () => { while (this.work.size) await Promise.allSettled([...this.work]) })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  private available(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertAvailable(); this.options.assertUiOwners(this.options); this.options.ui.assertOwners(this.options)
  }
  private current(state: UiStateSnapshot, caller: DesktopCallerContext): void {
    this.available()
    if (caller.engineEpoch !== this.options.engineEpoch || caller.principal !== 'trusted-desktop-main' || !this.options.isTrustedDesktop(caller) || !isUiLeaseId(caller.uiLeaseId) || !this.options.canPublishUi(caller)) throw new ServiceProtocolError('INVALID_REQUEST')
    this.options.database.db.transaction(() => assertUiStateReferences(this.options.database, state, {
      canAccessProject: id => this.options.canAccessProject(id, caller, 'read'),
      canAccessTask: id => this.options.canAccessTask(id, caller, 'read'),
      canAccessAgent: id => this.options.canAccessAgent(id, caller, 'read')
    }))()
  }
}
