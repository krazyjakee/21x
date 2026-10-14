import { randomUUID } from 'node:crypto'
import {
  applyMobileAccessSettings, assertMobileApiDeps, getMobileApiBinding, getPendingPin,
  isMobileAccessEnabled, isMobileLanAccessEnabled, getMobileSessionIdleDays,
  MOBILE_API_PORT, MOBILE_ACCESS_ENABLED_SETTING, MOBILE_LAN_ACCESS_SETTING, MOBILE_SESSION_IDLE_DAYS_SETTING,
  revalidateMobileClients, type MobileApiDeps
} from '../main/mobile-api-server'
import { TunnelManagerCore } from '../main/tunnel-manager-core'
import { MOBILE_CODECS, MOBILE_EVENT_CODECS, MOBILE_EVENTS, MOBILE_OPERATIONS, MOBILE_LIMITS, mobileAddress, type MobileCodec, type MobileOperation } from '../shared/mobile-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { isJsonValue, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

type Access = 'read' | 'write'
function normalizeBase(value: string): string { const address = new URL(value); address.search = ''; address.hash = ''; return address.href.replace(/\/$/, '') }
export interface MobileBackendOptions {
  deps: MobileApiDeps
  /** Null explicitly denies quick tunnels before filesystem/process effects. */
  tunnel: TunnelManagerCore | null
  engineEpoch: string
  /** Trusted host seam; zero obtains an isolated ephemeral test port. */
  port?: number
  lanAddress(): string
  assertAvailable(): void
  assertMobileOwners(deps: MobileApiDeps, tunnel: TunnelManagerCore | null): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canManageMobile(caller: DesktopCallerContext, access: Access): boolean
  canAccessSession(id: string, caller: DesktopCallerContext, access: Access): boolean
}

/** Exact desktop controls around the single installed HTTP/WS/domain owner.
 * Pairing grants the existing full-profile mobile contract; this backend never
 * invents a second agent/runtime or a per-device project authorization model. */
export class MobileBackend {
  readonly registry: DesktopOperationRegistry
  private closing = false
  private readonly flights = new Set<Promise<unknown>>()
  private queue: Promise<unknown> = Promise.resolve()
  private queued = 0
  constructor(private readonly options: MobileBackendOptions) {
    if (!options.deps.mobileDistRoot || !options.deps.taskOwners || options.tunnel !== null && !(options.tunnel instanceof TunnelManagerCore) || !Number.isSafeInteger(options.port ?? MOBILE_API_PORT) || (options.port ?? MOBILE_API_PORT) < 0 || (options.port ?? MOBILE_API_PORT) > 65535) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.available()
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    for (const event of MOBILE_EVENTS) { const codec = MOBILE_EVENT_CODECS[event]; this.registry.bindEvent(event, { validatePayload: codec.validatePayload, encodePayload: value => codec.encodePayload(value as never) }) }
    this.bindCommands()
  }
  get inflightCount(): number { return this.flights.size }
  shutdown(): void { this.closing = true }
  /** Root concurrently closes the actual API/tunnel; failed deadlines retain
   * this queue and raw service operations for retry before DB release. */
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid mobile shutdown deadline')
    this.shutdown()
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.allSettled([...this.flights]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(MOBILE_OPERATIONS.map(operation => [operation, {
      validatePayload: (v: unknown) => { try { return isJsonValue(v) && MOBILE_CODECS[operation].validateArguments(MOBILE_CODECS[operation].decodeArguments(v)) } catch { return false } },
      validateResult: MOBILE_CODECS[operation].validateWireResult,
      handle: (v: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, v, caller, signal)
    }]))
  }
  private available(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertAvailable(); this.options.assertMobileOwners(this.options.deps, this.options.tunnel); assertMobileApiDeps(this.options.deps)
  }
  private global(caller: DesktopCallerContext, access: Access): boolean { return !!caller.webviewId && !!caller.origin && this.options.canManageMobile(caller, 'read') && this.options.canManageMobile(caller, access) }
  private settings(): void {
    const db = this.options.deps.db
    if (db.db.prepare(`SELECT 1 FROM settings WHERE key IN (?,?,?,?,?) AND length(CAST(value AS BLOB))>2048 LIMIT 1`).get(MOBILE_ACCESS_ENABLED_SETTING, MOBILE_LAN_ACCESS_SETTING, MOBILE_SESSION_IDLE_DAYS_SETTING, 'mobile_remote_mode', 'mobile_custom_url')) throw new ServiceProtocolError('FRAME_TOO_LARGE')
    const custom = db.getSetting('mobile_custom_url')
    if (custom && !mobileAddress(custom) || getMobileSessionIdleDays(db) > MOBILE_LIMITS.idleDays || !['quick', 'custom'].includes(db.getSetting('mobile_remote_mode') || 'quick')) throw new ServiceProtocolError('INVALID_REQUEST')
  }
  private sessions() {
    const db = this.options.deps.db
    const stats = db.db.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(length(CAST(id AS BLOB))),0) AS idBytes, COALESCE(MAX(length(CAST(device_name AS BLOB))),0) AS nameBytes FROM mobile_sessions WHERE revoked=0').get() as { count: number; idBytes: number; nameBytes: number }
    if (stats.count > MOBILE_LIMITS.sessions || stats.idBytes > 128 || stats.nameBytes > 256) throw new ServiceProtocolError('FRAME_TOO_LARGE')
    const rows = db.getMobileSessions()
    MOBILE_CODECS['mobile:getSessions'].encodeResult(rows)
    return rows
  }
  private authorizeSession(id: string, caller: DesktopCallerContext, access: Access): boolean {
    return this.global(caller, access) && this.options.canAccessSession(id, caller, 'read') && this.options.canAccessSession(id, caller, access) && this.sessions().some(row => row.id === id)
  }
  private initCode(): string {
    const db = this.options.deps.db, now = Math.floor(Date.now() / 1000)
    return db.db.transaction(() => {
      // Prune only this finite code namespace. Live QR codes are never evicted
      // to manufacture capacity, and expired values never confer authority.
      const rows = db.db.prepare("SELECT CASE WHEN length(CAST(key AS BLOB))<=160 THEN key ELSE NULL END AS key, CASE WHEN length(CAST(value AS BLOB))<=16 THEN value ELSE NULL END AS value FROM settings WHERE key GLOB 'mobile_init_code_*_exp' LIMIT 129").all() as Array<{ key: string | null; value: string | null }>
      if (rows.length > MOBILE_LIMITS.pairingCodes || rows.some(row => !row.key || !row.value || !/^\d+$/.test(row.value))) throw new ServiceProtocolError('FRAME_TOO_LARGE')
      for (const row of rows) if (Number(row.value) < now) { db.deleteSetting(row.key!); db.deleteSetting(row.key!.slice(0, -4)) }
      const count = db.db.prepare("SELECT COUNT(*) AS count FROM settings WHERE key GLOB 'mobile_init_code_*_exp'").get() as { count: number }
      if (count.count >= MOBILE_LIMITS.pairingCodes) throw new ServiceProtocolError('BACKPRESSURE')
      const code = randomUUID(); db.setSetting(`mobile_init_code_${code}`, '1'); db.setSetting(`mobile_init_code_${code}_exp`, String(now + 300)); return code
    })()
  }
  private retain<T>(work: Promise<T>): Promise<T> { this.flights.add(work); void work.then(() => this.flights.delete(work), () => this.flights.delete(work)); return work }
  private serialize<T>(signal: AbortSignal, caller: DesktopCallerContext, effect: () => T | Promise<T>): Promise<T> {
    if (this.queued >= 16) return Promise.reject(new ServiceProtocolError('BACKPRESSURE'))
    this.queued++
    const run = () => { this.available(signal); this.settings(); if (!this.global(caller, 'write')) throw new ServiceProtocolError('INVALID_REQUEST'); return effect() }
    const result = this.queue.then(run, run).finally(() => { this.queued-- })
    this.queue = result.catch(() => {})
    return result
  }
  private bind<K extends MobileOperation>(operation: K, access: Access, effect: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext, signal: AbortSignal) => unknown | Promise<unknown>, authorize?: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext) => boolean): void {
    const codec = MOBILE_CODECS[operation] as MobileCodec<K>
    const allowed = (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext) => this.global(caller, access) && (!authorize || authorize(args, caller))
    this.registry.bindCommand(operation, { decodeRequest: v => codec.decodeArguments(structuredClone(v)), validateArguments: codec.validateArguments,
      authorize: (args, caller) => { this.available(); this.settings(); return allowed(args, caller) },
      invoke: (args, caller, signal) => this.retain((async () => {
        this.available(signal); if (!allowed(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const result = access === 'write' ? await this.serialize(signal, caller, () => { if (!allowed(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST'); return effect(args, caller, signal) }) : await effect(args, caller, signal)
        this.available(signal)
        if (access === 'read' && !allowed(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const encoded = codec.encodeResult(result); return codec.decodeResult(encoded.defined ? encoded.value : undefined)
      })()), validateResult: codec.validateResult, encodeResult: codec.encodeResult })
  }
  private bindCommands(): void {
    const db = this.options.deps.db
    this.bind('mobile:getInfo', 'write', () => {
      const enabled = isMobileAccessEnabled(db), lanAccess = isMobileLanAccessEnabled(db), port = getMobileApiBinding()?.port ?? (this.options.port || MOBILE_API_PORT)
      const remoteMode = (db.getSetting('mobile_remote_mode') || 'quick') as 'quick' | 'custom', customUrl = db.getSetting('mobile_custom_url') || null
      const remoteBase = remoteMode === 'custom' ? customUrl : this.options.tunnel?.url ?? null
      const lan = this.options.lanAddress()
      if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(lan) && lan !== 'localhost') throw new ServiceProtocolError('INVALID_RESULT')
      const base = remoteBase ? normalizeBase(remoteBase) : `http://${lanAccess ? lan : '127.0.0.1'}:${port}`, suffix = `/pair?code=${this.initCode()}`
      return { enabled, lanAccess, sessionIdleDays: getMobileSessionIdleDays(db), url: base.replace(/\/$/, '') + suffix, port,
        lanUrl: enabled && lanAccess ? `http://${lan}:${port}${suffix}` : null, tunnelUrl: enabled && remoteBase ? normalizeBase(remoteBase) + suffix : null,
        tunnelActive: remoteMode === 'custom' ? !!customUrl : this.options.tunnel?.active ?? false, remoteMode, customUrl }
    })
    this.bind('mobile:setAccess', 'write', async ([settings]) => {
      if (settings.enabled !== undefined) db.setSetting(MOBILE_ACCESS_ENABLED_SETTING, String(settings.enabled))
      if (settings.lanAccess !== undefined) db.setSetting(MOBILE_LAN_ACCESS_SETTING, String(settings.lanAccess))
      if (settings.sessionIdleDays !== undefined) db.setSetting(MOBILE_SESSION_IDLE_DAYS_SETTING, String(settings.sessionIdleDays))
      const applying = applyMobileAccessSettings(this.options.port)
      const joined = await Promise.allSettled([applying, settings.enabled === false ? this.options.tunnel?.stop() : Promise.resolve()])
      const failure = joined.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      return { enabled: isMobileAccessEnabled(db), lanAccess: isMobileLanAccessEnabled(db), sessionIdleDays: getMobileSessionIdleDays(db), listening: getMobileApiBinding() !== null }
    })
    this.bind('mobile:startTunnel', 'write', async (_args, caller, signal) => {
      if (!this.options.tunnel) throw new ServiceProtocolError('UNKNOWN_OPERATION')
      if (!isMobileAccessEnabled(db)) throw new ServiceProtocolError('INVALID_REQUEST')
      const port = getMobileApiBinding()?.port
      if (!port) throw new ServiceProtocolError('DISCONNECTED')
      const abort = () => { void this.options.tunnel!.stop() }
      signal.addEventListener('abort', abort, { once: true })
      try {
        const url = await this.options.tunnel.start(port)
        this.available(signal); if (!this.global(caller, 'write') || !isMobileAccessEnabled(db)) { await this.options.tunnel.stop(); throw new ServiceProtocolError('INVALID_REQUEST') }
        db.setSetting('mobile_remote_mode', 'quick'); return { tunnelUrl: `${url}/pair?code=${this.initCode()}` }
      } catch (error) { await this.options.tunnel.stop(); if (signal.aborted) throw new ServiceProtocolError('CANCELLED'); throw error }
      finally { signal.removeEventListener('abort', abort) }
    })
    this.bind('mobile:stopTunnel', 'write', async () => { await this.options.tunnel?.stop(); return { success: true } })
    this.bind('mobile:setCustomUrl', 'write', async ([url], caller, signal) => {
      await this.options.tunnel?.stop(); this.available(signal); if (!this.global(caller, 'write')) throw new ServiceProtocolError('INVALID_REQUEST')
      const base = normalizeBase(url)
      db.setSetting('mobile_remote_mode', 'custom'); db.setSetting('mobile_custom_url', base); return { url: `${base}/pair?code=${this.initCode()}` }
    })
    this.bind('mobile:clearCustomUrl', 'write', () => { db.setSetting('mobile_remote_mode', 'quick'); db.deleteSetting('mobile_custom_url'); return { success: true } })
    this.bind('mobile:getPendingPin', 'read', () => getPendingPin(), (_args, caller) => this.global(caller, 'write'))
    this.bind('mobile:getSessions', 'read', (_args, caller) => this.sessions().filter(row => this.options.canAccessSession(row.id, caller, 'read')))
    this.bind('mobile:revokeSession', 'write', ([id]) => { const success = db.revokeMobileSession(id); revalidateMobileClients(); return { success } }, ([id], caller) => this.authorizeSession(id, caller, 'write'))
    this.bind('mobile:revokeAllSessions', 'write', () => { db.revokeAllMobileSessions(); revalidateMobileClients(); return { success: true } }, (_args, caller) => this.sessions().every(row => this.options.canAccessSession(row.id, caller, 'read') && this.options.canAccessSession(row.id, caller, 'write')))
  }
}
