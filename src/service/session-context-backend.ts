import type { DatabaseManager } from '../main/database/manager'
import type { SessionContextService } from '../main/sessions/context-service'
import { DEFAULT_PROJECT_ID } from '../shared/projects'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import type { SessionContextScope } from '../shared/session-context'
import { SESSION_CONTEXT_CODECS, SESSION_CONTEXT_OPERATIONS, SESSION_CONTEXT_SETTING_KEYS, SESSION_CONTEXT_LIMITS, type SessionContextCodec, type SessionContextOperation } from '../shared/session-context-codecs'
import { isDatabaseId } from '../shared/database-desktop-codecs'
import { isJsonValue, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

type Access = 'read' | 'write'
export interface SessionContextOwners { database: DatabaseManager; context: SessionContextService }
export interface SessionContextBackendOptions extends SessionContextOwners {
  engineEpoch: string
  assertAvailable(): void
  assertOwners(owners: SessionContextOwners): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canAccessTask(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessProject(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessAgent(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessSession(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessGlobalCommander(caller: DesktopCallerContext, access: Access): boolean
  canManageConfiguration(caller: DesktopCallerContext, access: Access): boolean
  canAccessSetting(key: typeof SESSION_CONTEXT_SETTING_KEYS[number], caller: DesktopCallerContext, access: Access): boolean
}
type Budget = { bytes: number }
type StoredTable = 'tasks' | 'agents' | 'commander_sessions' | 'session_generations' | 'session_turn_usage' | 'session_lifecycle_events' | 'session_summaries' | 'session_handoffs' | 'settings'

/** Read projection and explicit policy transaction only. The borrowed context
 * service remains the sole writer for these two policy settings. */
export class SessionContextBackend {
  readonly registry: DesktopOperationRegistry
  private closing = false
  private readonly flights = new Set<Promise<unknown>>()
  constructor(private readonly options: SessionContextBackendOptions) {
    this.available()
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    this.bindCommands()
  }
  get inflightCount(): number { return this.flights.size }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(SESSION_CONTEXT_OPERATIONS.map(operation => [operation, {
      validatePayload: (value: unknown) => { try { return isJsonValue(value) && SESSION_CONTEXT_CODECS[operation].validateArguments(SESSION_CONTEXT_CODECS[operation].decodeArguments(value)) } catch { return false } },
      validateResult: SESSION_CONTEXT_CODECS[operation].validateWireResult,
      handle: (value: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, value, caller, signal)
    }]))
  }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid session context shutdown deadline')
    this.closing = true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([Promise.allSettled([...this.flights]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })])
    } finally { if (timer) clearTimeout(timer) }
  }
  private available(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertAvailable(); this.options.assertOwners(this.options); this.options.context.assertSource(this.options.database)
  }
  private retain<T>(flight: Promise<T>): Promise<T> {
    this.flights.add(flight); void flight.then(() => this.flights.delete(flight), () => this.flights.delete(flight)); return flight
  }
  private settingsAllowed(caller: DesktopCallerContext, access: Access): boolean {
    return SESSION_CONTEXT_SETTING_KEYS.every(key => this.options.canAccessSetting(key, caller, access))
  }
  private projectAllowed(id: unknown, caller: DesktopCallerContext): boolean {
    return isDatabaseId(id) && this.options.canAccessProject(id, caller, 'read') && !!this.options.database.db.prepare('SELECT 1 FROM projects WHERE id=?').get(id)
  }
  private scopeAllowed(scope: SessionContextScope, caller: DesktopCallerContext): boolean {
    if (!this.settingsAllowed(caller, 'read')) return false
    const db = this.options.database.db
    // Ledger owner IDs have no separate kind namespace; ambiguous historical IDs cannot be projected safely.
    if (db.prepare('SELECT 1 FROM commander_sessions WHERE id=?').get(scope.ownerId) && db.prepare('SELECT 1 FROM tasks WHERE id=?').get(scope.ownerId)) return false
    if (scope.kind === 'captain') {
      if (!this.options.canAccessTask(scope.ownerId, caller, 'read')) return false
      // Read only tiny scope columns after their lengths have been checked;
      // getTask/getAgent would deserialize unrelated JSON and credentials.
      const sizes = db.prepare(`SELECT length(CAST(role AS BLOB)) AS role_bytes, length(CAST(project_id AS BLOB)) AS project_bytes,
        length(CAST(agent_id AS BLOB)) AS agent_bytes FROM tasks WHERE id=?`).get(scope.ownerId) as { role_bytes: number; project_bytes: number | null; agent_bytes: number | null } | undefined
      if (!sizes || sizes.role_bytes > 128 || (sizes.project_bytes ?? 0) > 128 || (sizes.agent_bytes ?? 0) > 128) return false
      const task = db.prepare('SELECT role,project_id,agent_id FROM tasks WHERE id=?').get(scope.ownerId) as { role: string; project_id: string | null; agent_id: string | null }
      if (task.role !== 'captain' || !this.projectAllowed(task.project_id ?? DEFAULT_PROJECT_ID, caller)) return false
      return task.agent_id === null || isDatabaseId(task.agent_id) && this.options.canAccessAgent(task.agent_id, caller, 'read') && !!db.prepare('SELECT 1 FROM agents WHERE id=?').get(task.agent_id)
    }
    if (!this.options.canAccessGlobalCommander(caller, 'read') || !this.options.canAccessSession(scope.ownerId, caller, 'read') || !db.prepare('SELECT 1 FROM commander_sessions WHERE id=?').get(scope.ownerId)) return false
    const count = db.prepare('SELECT COUNT(DISTINCT project_id) AS count, MAX(length(CAST(project_id AS BLOB))) AS bytes FROM commander_messages WHERE session_id=? AND project_id IS NOT NULL')
      .get(scope.ownerId) as { count: number; bytes: number | null }
    if (count.count > SESSION_CONTEXT_LIMITS.projectReferences || (count.bytes ?? 0) > 128) return false
    const projects = db.prepare('SELECT DISTINCT project_id FROM commander_messages WHERE session_id=? AND project_id IS NOT NULL LIMIT ?')
      .all(scope.ownerId, SESSION_CONTEXT_LIMITS.projectReferences + 1) as Array<{ project_id: string }>
    return projects.every(row => this.projectAllowed(row.project_id, caller))
  }
  /** Select sizes only, never the large legacy values. Queries/order/columns
   * are internal finite constants; no caller-controlled SQL is interpolated. */
  private guardRows(budget: Budget, table: StoredTable, columns: string[], where: string, parameters: unknown[], order = '', limit = 1): void {
    const fields = columns.length ? columns : (this.options.database.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name)
    const sum = fields.map(field => `COALESCE(length(CAST("${field.replaceAll('"', '""')}" AS BLOB)),0)`).join('+')
    const rows = this.options.database.db.prepare(`SELECT ${sum} AS bytes FROM ${table} WHERE ${where} ${order ? `ORDER BY ${order}` : ''} LIMIT ${limit}`)
      .all(...parameters) as Array<{ bytes: number }>
    for (const row of rows) {
      if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > SESSION_CONTEXT_LIMITS.storedBytes) throw new ServiceProtocolError('INVALID_RESULT')
      budget.bytes += row.bytes
    }
    if (budget.bytes > SESSION_CONTEXT_LIMITS.storedBytes) throw new ServiceProtocolError('INVALID_RESULT')
  }
  private preflight(scope: SessionContextScope): void {
    const budget: Budget = { bytes: 0 }, db = this.options.database.db
    this.guardRows(budget, 'settings', ['key', 'value'], "key IN ('sessions.rollover','sessions.rollover_thresholds','sessions.captain_managed','sessions.commander_managed')", [], '', 4)
    if (scope.kind === 'captain') {
      this.guardRows(budget, 'tasks', [], 'id=?', [scope.ownerId])
      const task = db.prepare('SELECT agent_id FROM tasks WHERE id=?').get(scope.ownerId) as { agent_id: string | null }
      if (task.agent_id) this.guardRows(budget, 'agents', [], 'id=?', [task.agent_id])
    }
    this.guardRows(budget, 'session_generations', [], 'owner_id=?', [scope.ownerId], 'created_at DESC,rowid DESC')
    const generation = db.prepare('SELECT id,engine FROM session_generations WHERE owner_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1')
      .get(scope.ownerId) as { id: string; engine: string } | undefined
    if (generation) {
      if (generation.engine !== (scope.kind === 'captain' ? 'adapter' : 'chat')) throw new ServiceProtocolError('INVALID_RESULT')
      if (db.prepare('SELECT 1 FROM session_lifecycle_events WHERE generation_id=? AND owner_id!=? LIMIT 1').get(generation.id, scope.ownerId) ||
        db.prepare('SELECT 1 FROM session_turns WHERE generation_id=? AND owner_id!=? LIMIT 1').get(generation.id, scope.ownerId)) throw new ServiceProtocolError('INVALID_RESULT')
      const counts = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN event_type='wake_disposition' THEN length(CAST(payload AS BLOB)) ELSE 0 END),0) AS bytes
        FROM session_lifecycle_events WHERE generation_id=?`).get(generation.id) as { count: number; bytes: number }
      if (counts.count > SESSION_CONTEXT_LIMITS.lifecycleRows || !Number.isSafeInteger(counts.bytes) || counts.bytes > SESSION_CONTEXT_LIMITS.storedBytes) throw new ServiceProtocolError('INVALID_RESULT')
      if (scope.kind === 'captain') {
        budget.bytes += counts.bytes
        this.guardRows(budget, 'session_lifecycle_events', ['payload'], "generation_id=? AND event_type IN ('session_started','session_resumed')", [generation.id], 'created_at DESC,rowid DESC')
        this.guardRows(budget, 'session_lifecycle_events', ['payload'], "generation_id=? AND event_type='context_usage'", [generation.id], 'created_at DESC,rowid DESC')
      }
    }
    if (scope.kind === 'commander') {
      // Guard the exact latest eligible model row the projection selects;
      // older billing/summary calls and other generations are not hydrated.
      const row = db.prepare(`SELECT t.rowid AS usage_row, length(CAST(t.model AS BLOB)) AS model_bytes FROM session_usage_calls c JOIN session_turn_usage t ON t.turn_id=c.turn_id
        WHERE t.owner_id=? AND t.kind IN ('user','report') AND (? IS NULL OR EXISTS
          (SELECT 1 FROM session_turns st WHERE st.turn_key=t.turn_id AND st.generation_id=?))
        ORDER BY t.started_at DESC,t.rowid DESC,c.call_index DESC LIMIT 1`).get(scope.ownerId, generation?.id ?? null, generation?.id ?? null) as { usage_row: number; model_bytes: number } | undefined
      if (row) {
        if (row.model_bytes > SESSION_CONTEXT_LIMITS.referenceBytes) throw new ServiceProtocolError('INVALID_RESULT')
        this.guardRows(budget, 'session_turn_usage', ['model'], 'rowid=?', [row.usage_row])
      }
    }
    this.guardRows(budget, 'session_handoffs', ['id', 'state'], "owner_id=? AND state!='completed'", [scope.ownerId], 'created_at DESC')
    this.guardRows(budget, 'session_summaries', ['id', 'content', 'created_at'], "owner_id=? AND idempotency_key NOT LIKE 'handoff:%' AND idempotency_key NOT LIKE 'summary:rollover-summary:%'", [scope.ownerId], 'created_at DESC,rowid DESC', 10)
    const summaries = db.prepare("SELECT content FROM session_summaries WHERE owner_id=? AND idempotency_key NOT LIKE 'handoff:%' AND idempotency_key NOT LIKE 'summary:rollover-summary:%' ORDER BY created_at DESC,rowid DESC LIMIT 10")
      .all(scope.ownerId) as Array<{ content: string }>
    for (const row of summaries) {
      let content: unknown
      try { content = JSON.parse(row.content) } catch {
        if (/^[\[{]/.test(row.content.trimStart())) throw new ServiceProtocolError('INVALID_RESULT')
        continue /* Legacy human prose remains readable. */
      }
      if (content !== null && typeof content === 'object' && (Array.isArray(content) || typeof (content as Record<string, unknown>).text !== 'string')) throw new ServiceProtocolError('INVALID_RESULT')
    }
    this.guardRows(budget, 'session_handoffs', ['id', 'summary', 'summary_source', 'created_at'], 'owner_id=? AND summary IS NOT NULL', [scope.ownerId], 'created_at DESC', 10)
    this.guardRows(budget, 'session_lifecycle_events', ['idempotency_key', 'payload', 'created_at'], "owner_id=? AND event_type='replacement_seeded'", [scope.ownerId], 'created_at DESC', 10)
  }
  private bind<K extends SessionContextOperation>(operation: K, authorize: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext) => boolean,
    effect: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext) => DesktopCommandMap[K]['result']): void {
    const codec = SESSION_CONTEXT_CODECS[operation] as SessionContextCodec<K>
    this.registry.bindCommand(operation, { decodeRequest: payload => codec.decodeArguments(structuredClone(payload)), validateArguments: codec.validateArguments,
      authorize: (args, caller) => { this.available(); return authorize(args, caller) }, invoke: (args, caller, signal) => this.retain((async () => {
        this.available(signal)
        if (!authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        // Both actual context methods are synchronous SQLite operations. Keep
        // the coherent read/write and its final grant check in this same turn.
        const result = effect(args, caller)
        this.available(signal)
        if (!authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        if (operation === 'sessionContext:getSnapshot') {
          const requested = args[0] as SessionContextScope, returned = result as DesktopCommandMap['sessionContext:getSnapshot']['result']
          if (returned.scope?.kind !== requested.kind || returned.scope?.ownerId !== requested.ownerId) throw new ServiceProtocolError('INVALID_RESULT')
        }
        const wire = codec.encodeResult(result)
        return codec.decodeResult(wire.defined ? wire.value : undefined)
      })()), validateResult: codec.validateResult, encodeResult: codec.encodeResult })
  }
  private bindCommands(): void {
    this.bind('sessionContext:getSnapshot', ([scope], caller) => this.scopeAllowed(scope, caller), ([scope], caller) => {
      // One SQLite read transaction keeps scope, byte preflight and projection
      // consistent with a concurrent external database writer.
      return this.options.database.db.transaction(() => {
        if (!this.scopeAllowed(scope, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        this.preflight(scope); return this.options.context.getSnapshot(scope)
      })()
    })
    this.bind('sessionContext:setPolicy', (_args, caller) => this.options.canManageConfiguration(caller, 'write') && this.settingsAllowed(caller, 'write'), ([policy]) => this.options.context.setPolicy(policy))
  }
}
