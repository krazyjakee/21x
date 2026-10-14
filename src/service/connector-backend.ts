import type { DatabaseManager } from '../main/database/manager'
import { SourceMutationBusyError, type SyncManager } from '../main/sync-manager'
import type { ConnectorRuntime } from '../main/connectors/bridge/runtime-core'
import { ConnectorBridgeService } from '../main/connectors/bridge/service'
import type { ConnectorBridgeEngine } from '../main/connectors/bridge/engine'
import type { ConnectorCredentialStore } from '../main/connectors/credentials'
import { ConnectorCredentialMutationBusyError, type ConnectorCredentialMutationToken } from '../main/connectors/credential-admission'
import { getAllowedPiece } from '../main/connectors/allowlist'
import { getTaskMapping } from '../main/connectors/bridge/mappings'
import { AUTHENTICATED_SECRET_STORAGE_FORMAT, getSecretStorage, type SecretStorage } from '../main/platform/secret-storage'
import { CONNECTOR_CODECS, CONNECTOR_OPERATIONS, CONNECTOR_LIMITS, CONNECTOR_WRITE_ERROR, CONNECTOR_STORAGE_REMEDIATION, connectorId, type ConnectorCodec, type ConnectorOperation } from '../shared/connector-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

type Access = 'read' | 'write'
export interface ConnectorOwners {
  database: DatabaseManager
  sync: SyncManager
  service: ConnectorBridgeService
  runtime: ConnectorRuntime
  engine: ConnectorBridgeEngine
  credentialStore: ConnectorCredentialStore
  secretStorage: SecretStorage
}
export interface ConnectorBackendOptions extends ConnectorOwners {
  engineEpoch: string
  oauthBrowser: 'available' | 'unavailable'
  assertAvailable(): void
  assertConnectorOwners(owners: ConnectorOwners): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canManageConfiguration(caller: DesktopCallerContext, access: Access): boolean
  canCreateInstance(pieceName: string, caller: DesktopCallerContext): boolean
  canUsePiece(pieceName: string, caller: DesktopCallerContext): boolean
  canAccessInstance(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessSource(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessTask(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessProject(id: string, caller: DesktopCallerContext, access: Access): boolean
}
interface References { sources: Array<{ id: string; projectId: string; config: string; enabled: number | null }>; tasks: Array<{ id: string; projectId: string; sourceId: string; role: string | null; groupId: string | null; externalId: string | null }> }

/** Seven reviewed form controls, using actual shared runtime/credential owners.
 * This surface cannot call arbitrary pieces, open resource paths or enable a
 * browser owner. Existing engine/KV/background transport ownership is retained. */
export class ConnectorBackend {
  readonly registry: DesktopOperationRegistry
  private closing = false
  private readonly flights = new Set<Promise<unknown>>()
  private readonly mutations = new Set<string>()
  constructor(private readonly options: ConnectorBackendOptions) {
    this.available()
    if (!(options.service instanceof ConnectorBridgeService) || options.runtime.credentialStore !== options.credentialStore || typeof options.runtime.runCredentialMutation !== 'function' || typeof options.sync.runSourceMutation !== 'function') throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    this.bindCommands()
  }
  get inflightCount(): number { return this.flights.size }
  shutdown(): void { this.closing = true }
  /** Root stops the actual runtime concurrently; raw OAuth/worker work must join
   * before releasing its credential store or database after an incomplete drain. */
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid connector backend shutdown deadline')
    this.shutdown()
    let timer: NodeJS.Timeout | undefined
    try { await Promise.race([Promise.allSettled([...this.flights]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(CONNECTOR_OPERATIONS.map(operation => [operation, {
      validatePayload: (value: unknown) => { try { return isJsonValue(value) && CONNECTOR_CODECS[operation].validateArguments(CONNECTOR_CODECS[operation].decodeArguments(value)) } catch { return false } },
      validateResult: CONNECTOR_CODECS[operation].validateWireResult,
      handle: (value: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, value, caller, signal)
    }]))
  }
  private available(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertAvailable(); this.options.assertConnectorOwners(this.options)
    if (getSecretStorage() !== this.options.secretStorage || this.options.secretStorage.formatId !== AUTHENTICATED_SECRET_STORAGE_FORMAT || this.options.runtime.credentialStore !== this.options.credentialStore) throw new ServiceProtocolError('DISCONNECTED')
  }
  private retain<T>(work: Promise<T>): Promise<T> { this.flights.add(work); void work.then(() => this.flights.delete(work), () => this.flights.delete(work)); return work }
  private global(caller: DesktopCallerContext, access: Access): boolean { return !!caller.webviewId && !!caller.origin && this.options.canManageConfiguration(caller, 'read') && this.options.canManageConfiguration(caller, access) }
  /** Reject before ConnectorStore's legacy SELECT */
  private instance(id: string) {
    const invalid = this.options.database.db.prepare(`SELECT 1 FROM connector_instances WHERE id=? AND
      (length(CAST(id AS BLOB))>128 OR length(CAST(piece_name AS BLOB))>128 OR length(CAST(piece_version AS BLOB))>64 OR length(CAST(display_name AS BLOB))>256 OR
       length(CAST(config AS BLOB))>? OR COALESCE(length(auth),0)>65536 OR COALESCE(length(CAST(auth_type AS BLOB)),0)>32 OR length(CAST(created_at AS BLOB))>32 OR length(CAST(updated_at AS BLOB))>32) LIMIT 1`).get(id, CONNECTOR_LIMITS.config)
    if (invalid) throw new ServiceProtocolError('FRAME_TOO_LARGE')
    const instance = this.options.runtime.store.getInstance(id)
    if (!instance) throw new ServiceProtocolError('INVALID_REQUEST')
    const allowed = getAllowedPiece(instance.pieceName)
    if (!getTaskMapping(instance.pieceName) || !allowed || instance.pieceVersion !== allowed.version) throw new ServiceProtocolError('INVALID_REQUEST')
    return instance
  }
  private references(id: string, caller: DesktopCallerContext, access: Access): References {
    const db = this.options.database.db
    const stats = db.prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(length(CAST(config AS BLOB))),0) AS bytes,
      COALESCE(SUM(length(CAST(config AS BLOB))),0) AS total FROM task_sources WHERE plugin_id='connector-bridge'`).get() as { count: number; bytes: number; total: number }
    if (stats.count > CONNECTOR_LIMITS.references || stats.bytes > CONNECTOR_LIMITS.config || stats.total > 1024 * 1024) throw new ServiceProtocolError('FRAME_TOO_LARGE')
    const rows = db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB))<=128 THEN id ELSE NULL END AS id,
      CASE WHEN length(CAST(project_id AS BLOB))<=128 THEN project_id ELSE NULL END AS project_id, config, CASE WHEN typeof(enabled)='integer' AND enabled IN (0,1) THEN enabled ELSE NULL END AS enabled FROM task_sources WHERE plugin_id='connector-bridge' ORDER BY id`).all() as Array<{ id: string | null; project_id: string | null; config: string; enabled: number | null }>
    const sources: References['sources'] = []
    for (const row of rows) {
      let config: unknown
      try { config = JSON.parse(row.config) } catch { throw new ServiceProtocolError('INVALID_REQUEST') }
      if (!isRecord(config)) throw new ServiceProtocolError('INVALID_REQUEST')
      if (config.connector_instance_id !== id) continue
      if (row.enabled === null || !row.id || !row.project_id || !connectorId(row.id) || !connectorId(row.project_id) || !this.options.canAccessSource(row.id, caller, access) || !this.options.canAccessProject(row.project_id, caller, access) || config.piece_name !== this.instance(id).pieceName) throw new ServiceProtocolError('INVALID_REQUEST')
      sources.push({ id: row.id, projectId: row.project_id, config: row.config, enabled: row.enabled })
    }
    const tasks: References['tasks'] = []
    if (sources.length) {
      const taskRows = db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB))<=128 THEN id ELSE NULL END AS id,
        CASE WHEN length(CAST(project_id AS BLOB))<=128 THEN project_id ELSE NULL END AS project_id, source_id, CASE WHEN length(CAST(role AS BLOB))<=32 THEN role ELSE NULL END AS role,
        CASE WHEN length(CAST(group_id AS BLOB))<=128 THEN group_id ELSE NULL END AS group_id,
        CASE WHEN length(CAST(external_id AS BLOB))<=256 THEN external_id ELSE NULL END AS external_id,
        MAX(COALESCE(length(CAST(role AS BLOB)),0),COALESCE(length(CAST(group_id AS BLOB)),0),COALESCE(length(CAST(external_id AS BLOB)),0)) AS reference_bytes FROM tasks WHERE source_id IN (${sources.map(() => '?').join(',')}) ORDER BY id LIMIT 513`).all(...sources.map(source => source.id)) as Array<{ id: string | null; project_id: string | null; source_id: string; role: string | null; group_id: string | null; external_id: string | null; reference_bytes: number }>
      if (taskRows.length > CONNECTOR_LIMITS.tasks) throw new ServiceProtocolError('FRAME_TOO_LARGE')
      for (const task of taskRows) {
        if (task.reference_bytes > 256 || !task.id || !task.project_id || !connectorId(task.id) || !connectorId(task.project_id) || !this.options.canAccessTask(task.id, caller, access) || !this.options.canAccessProject(task.project_id, caller, access)) throw new ServiceProtocolError('INVALID_REQUEST')
        tasks.push({ id: task.id, projectId: task.project_id, sourceId: task.source_id, role: task.role, groupId: task.group_id, externalId: task.external_id })
      }
    }
    return { sources, tasks }
  }
  private instanceAllowed(id: string, caller: DesktopCallerContext, access: Access): boolean {
    if (!this.global(caller, access) || !this.options.canAccessInstance(id, caller, 'read') || !this.options.canAccessInstance(id, caller, access)) return false
    const instance = this.instance(id)
    if (!this.options.canUsePiece(instance.pieceName, caller)) return false
    this.references(id, caller, access)
    return true
  }
  private async sourceLease<T>(id: string, caller: DesktopCallerContext, signal: AbortSignal, effect: () => T | Promise<T>): Promise<T> {
    const expected = JSON.stringify({ instance: this.instance(id), references: this.references(id, caller, 'write') })
    const sources = this.references(id, caller, 'write').sources
    const recheck = (): void => { this.available(signal); if (!this.instanceAllowed(id, caller, 'write') || JSON.stringify({ instance: this.instance(id), references: this.references(id, caller, 'write') }) !== expected) throw new ServiceProtocolError('INVALID_REQUEST') }
    const run = (index: number): Promise<T> => {
      recheck()
      return index === sources.length ? Promise.resolve().then(() => { recheck(); return effect() })
        : this.options.sync.runSourceMutation(sources[index].id, () => run(index + 1))
    }
    return run(0)
  }
  private async mutation<T>(id: string, caller: DesktopCallerContext, signal: AbortSignal, effect: (admission: ConnectorCredentialMutationToken, beforeWrite: () => void) => T | Promise<T>): Promise<T> {
    if (this.mutations.has(id)) throw new ServiceProtocolError('BACKPRESSURE')
    this.mutations.add(id)
    try {
      return await this.sourceLease(id, caller, signal, () => {
        // Runtime's real atomic guard covers direct engine/client/OAuth jobs,
        // including work whose public deadline preceded actual process close.
        if (this.options.engine.isBusy(id)) throw new ServiceProtocolError('BACKPRESSURE')
        const expected = JSON.stringify({ instance: this.instance(id), references: this.references(id, caller, 'write') })
        return this.options.runtime.runCredentialMutation(id, admission => {
          const beforeWrite = (): void => {
            this.available(signal)
            if (!this.instanceAllowed(id, caller, 'write') || JSON.stringify({ instance: this.instance(id), references: this.references(id, caller, 'write') }) !== expected) throw new ServiceProtocolError('INVALID_REQUEST')
          }
          beforeWrite()
          return effect(admission, beforeWrite)
        })
      })
    } catch (error) {
      if (error instanceof ConnectorCredentialMutationBusyError || error instanceof SourceMutationBusyError) throw new ServiceProtocolError('BACKPRESSURE')
      throw error
    } finally { this.mutations.delete(id) }
  }
  private persistent(): boolean { return this.options.secretStorage.isEncryptionAvailable() && this.options.credentialStore.isPersistentStorageAvailable() }
  private bind<K extends ConnectorOperation>(operation: K, authorize: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext) => boolean,
    effect: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext, signal: AbortSignal) => unknown | Promise<unknown>, read = false): void {
    const codec = CONNECTOR_CODECS[operation] as ConnectorCodec<K>
    this.registry.bindCommand(operation, { decodeRequest: payload => codec.decodeArguments(structuredClone(payload)), validateArguments: codec.validateArguments,
      authorize: (args, caller) => { this.available(); return authorize(args, caller) },
      invoke: (args, caller, signal) => this.retain((async () => {
        this.available(signal)
        if (!authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        let result: unknown
        try { result = await effect(args, caller, signal) } catch (error) { if (signal.aborted) throw new ServiceProtocolError('CANCELLED'); throw error }
        this.available(signal)
        if (read && !authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const projected = codec.encodeResult(result)
        return codec.decodeResult(projected.defined ? projected.value : undefined)
      })()), validateResult: codec.validateResult, encodeResult: codec.encodeResult })
  }
  private bindCommands(): void {
    const { service, database: db } = this.options
    this.bind('connectors:bridgePieces', (_args, caller) => this.global(caller, 'read'), (_args, caller) => service.bridgePieces().filter(piece => this.options.canUsePiece(piece.pieceName, caller)), true)
    this.bind('connectors:ensureInstance', ([piece, id], caller) => this.global(caller, 'write') && this.options.canUsePiece(piece, caller) && (id === undefined ? this.options.canCreateInstance(piece, caller) : this.instanceAllowed(id, caller, 'write') && this.instance(id).pieceName === piece), ([piece, id], caller, signal) => db.db.transaction(() => {
      this.available(signal)
      if (id !== undefined && (!this.instanceAllowed(id, caller, 'write') || this.instance(id).pieceName !== piece)) throw new ServiceProtocolError('INVALID_REQUEST')
      if (id === undefined) {
        const count = db.db.prepare('SELECT COUNT(*) AS count FROM connector_instances').get() as { count: number }
        if (count.count >= CONNECTOR_LIMITS.instances || !this.options.canCreateInstance(piece, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
      }
      const result = service.ensureInstance(piece, id)
      CONNECTOR_CODECS['connectors:ensureInstance'].encodeResult(result)
      return result
    })())
    this.bind('connectors:credentialStatus', ([id], caller) => this.instanceAllowed(id, caller, 'read'), ([id]) => service.credentialStatus(id), true)
    this.bind('connectors:setCredentials', ([id], caller) => this.instanceAllowed(id, caller, 'write'), ([id, input, storage], caller, signal) => this.mutation(id, caller, signal, () => {
      if (storage !== 'session' && !this.persistent()) return { ok: false as const, error: CONNECTOR_WRITE_ERROR, remediation: CONNECTOR_STORAGE_REMEDIATION, sessionOnlyAvailable: true }
      return service.setCredentials(id, input, storage)
    }))
    this.bind('connectors:clearCredentials', ([id], caller) => this.instanceAllowed(id, caller, 'write'), ([id], caller, signal) => this.mutation(id, caller, signal, () => service.clearCredentials(id)))
    this.bind('connectors:oauthConnect', ([id], caller) => this.instanceAllowed(id, caller, 'write'), ([id, input, storage], caller, signal) => {
      // Check capability before source drains, network/browser/callback effects.
      if (this.options.oauthBrowser !== 'available') throw new ServiceProtocolError('DISCONNECTED')
      return this.mutation(id, caller, signal, (admission, beforeWrite) => {
        if (storage !== 'session' && !this.persistent()) return { ok: false as const, error: CONNECTOR_WRITE_ERROR, remediation: CONNECTOR_STORAGE_REMEDIATION, sessionOnlyAvailable: true }
        return service.oauthConnect(id, input, storage, admission, beforeWrite)
      })
    })
    this.bind('connectors:syncStatus', ([id], caller) => this.instanceAllowed(id, caller, 'read'), ([id]) => {
      const invalidState = db.db.prepare('SELECT 1 FROM connector_sync_state WHERE instance_id=? AND (COALESCE(length(CAST(cursor AS BLOB)),0)>524288 OR COALESCE(length(CAST(last_error AS BLOB)),0)>8192) LIMIT 1').get(id)
      const letters = db.db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(payload AS BLOB))+length(CAST(error AS BLOB))),0) AS bytes FROM connector_dead_letters WHERE instance_id=?').get(id) as { count: number; bytes: number }
      if (invalidState || letters.count > 512 || letters.bytes > 512 * 1024) throw new ServiceProtocolError('FRAME_TOO_LARGE')
      return service.syncStatus(id)
    }, true)
  }
}
