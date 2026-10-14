import type { DatabaseManager } from '../main/database/manager'
import { AgentManager } from '../main/agent-manager-core'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { isUiLeaseId } from '../shared/ui-desktop-codecs'
import { TRAY_PREFERENCE_CODECS, TRAY_PREFERENCE_OPERATIONS, TRAY_PREFERENCE_SETTING, TRAY_PREFERENCE_LIMITS, type TrayPreferenceCodec, type TrayPreferenceOperation } from '../shared/tray-preference-codecs'
import { isJsonValue, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

export interface TrayPreferenceOwners { database: DatabaseManager; manager: AgentManager }
export interface TrayPreferenceBackendOptions extends TrayPreferenceOwners {
  engineEpoch: string
  /** Captured actual native tray capability, never a caller or callback guess. */
  trayAvailable: boolean
  assertAvailable(): void
  assertOwners(owners: TrayPreferenceOwners): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canManageGlobalConfiguration(caller: DesktopCallerContext, access: 'read' | 'write'): boolean
}
/** One durable preference writer. Native close reads this setting and alone
 * chooses hide/quit; a preference mutation invokes no window/tray callback. */
export class TrayPreferenceBackend {
  readonly registry: DesktopOperationRegistry
  private readonly owners: TrayPreferenceOwners
  private readonly trayAvailable: boolean
  private readonly epoch: string
  private closing = false
  private readonly flights = new Set<Promise<unknown>>()
  private readonly controllers = new Set<AbortController>()
  constructor(private readonly options: TrayPreferenceBackendOptions) {
    if (typeof options.trayAvailable !== 'boolean' || !(options.manager instanceof AgentManager)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.owners = Object.freeze({ database: options.database, manager: options.manager }); this.trayAvailable = options.trayAvailable; this.epoch = options.engineEpoch
    this.available(undefined, false)
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: this.epoch, isTrustedDesktop: options.isTrustedDesktop })
    if (this.trayAvailable) for (const operation of TRAY_PREFERENCE_OPERATIONS) this.bind(operation)
  }
  get inflightCount(): number { return this.flights.size }
  shutdown(): void { this.closing = true; for (const controller of this.controllers) controller.abort() }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid tray preference close deadline')
    this.shutdown(); let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.allSettled([...this.flights]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) } finally { if (timer) clearTimeout(timer) }
  }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return this.trayAvailable ? Object.fromEntries(TRAY_PREFERENCE_OPERATIONS.map(operation => [operation, {
      validatePayload: (value: unknown) => { try { return isJsonValue(value) && TRAY_PREFERENCE_CODECS[operation].validateArguments(TRAY_PREFERENCE_CODECS[operation].decodeArguments(value)) } catch { return false } },
      validateResult: TRAY_PREFERENCE_CODECS[operation].validateWireResult,
      handle: (value: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, value, caller, signal)
    }])) : {}
  }
  private available(signal?: AbortSignal, requireTray = true): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing || !this.owners.database.db.open || this.options.database !== this.owners.database || this.options.manager !== this.owners.manager || this.options.trayAvailable !== this.trayAvailable) throw new ServiceProtocolError('DISCONNECTED')
    try { this.options.assertAvailable(); this.options.assertOwners(this.owners) } catch (error) { if (error instanceof ServiceProtocolError) throw error; throw new ServiceProtocolError('DISCONNECTED') }
    if (requireTray && !this.trayAvailable) throw new ServiceProtocolError('UNKNOWN_OPERATION')
  }
  /** App-owned native close lookup: no renderer identity or secret projection.
   * The SQL result is one integer even for huge/malformed legacy setting rows. */
  getPreference(): boolean {
    this.available()
    try {
      const row = this.owners.database.db.prepare("SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=4 THEN CASE WHEN CAST(substr(CAST(value AS BLOB),1,4) AS TEXT)='true' THEN 1 ELSE 0 END ELSE 0 END AS enabled FROM settings WHERE key=?").get(TRAY_PREFERENCE_SETTING) as { enabled: number } | undefined
      this.available(); return row?.enabled === 1
    } catch (error) { this.available(); if (error instanceof ServiceProtocolError) throw error; throw new ServiceProtocolError('INTERNAL_ERROR') }
  }
  private authorize(caller: DesktopCallerContext, access: 'read' | 'write', signal?: AbortSignal): void {
    this.available(signal)
    if (caller.principal !== 'trusted-desktop-main' || caller.engineEpoch !== this.epoch || !caller.origin || !caller.webviewId || !isUiLeaseId(caller.uiLeaseId) || !this.options.isTrustedDesktop(caller) || !this.options.canManageGlobalConfiguration(caller, access)) throw new ServiceProtocolError('INVALID_REQUEST')
  }
  private bind<K extends TrayPreferenceOperation>(operation: K): void {
    const codec = TRAY_PREFERENCE_CODECS[operation] as TrayPreferenceCodec<K>, access = operation === 'app:setMinimizeToTray' ? 'write' : 'read'
    this.registry.bindCommand(operation, { decodeRequest: value => codec.decodeArguments(structuredClone(value)), validateArguments: codec.validateArguments, authorize: (_args, caller) => { this.authorize(caller, access); return true },
      invoke: (args, caller, signal) => {
        this.authorize(caller, access, signal)
        if (this.flights.size >= TRAY_PREFERENCE_LIMITS.requests) throw new ServiceProtocolError('BACKPRESSURE')
        const captured = Object.freeze({ ...caller }), controller = new AbortController(), abort = (): void => controller.abort()
        this.controllers.add(controller); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
        const raw = Promise.resolve().then(() => {
          this.authorize(captured, access, controller.signal)
          if (operation === 'app:getMinimizeToTray') { const preference = this.getPreference(); this.authorize(captured, access, controller.signal); return preference }
          // Synchronous accepted DB effects are never rolled back/replayed due
          // to a later revoked grant. No native or session action is involved.
          try { this.owners.database.setSetting(TRAY_PREFERENCE_SETTING, String(args[0])) } catch { this.authorize(captured, access, controller.signal); throw new ServiceProtocolError('INTERNAL_ERROR') }
          this.authorize(captured, access, controller.signal)
          return args[0] as boolean
        }).finally(() => { this.controllers.delete(controller); signal.removeEventListener('abort', abort) })
        this.flights.add(raw); void raw.then(() => this.flights.delete(raw), () => this.flights.delete(raw)); return raw as Promise<DesktopCommandMap[K]['result']>
      }, validateResult: codec.validateResult, encodeResult: codec.encodeResult })
  }
}
