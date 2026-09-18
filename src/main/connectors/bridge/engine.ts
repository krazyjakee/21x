import { createHash } from 'crypto'
import type { TaskRecord } from '../../database'
import type { PluginContext, PluginSyncResult } from '../../plugins/types'
import { upsertSourcedTask } from '../../plugins/sourced-tasks'
import { CONNECTOR_PIECE_ALLOWLIST, type ConnectorPieceAllowlist } from '../allowlist'
import type { ConnectorInstanceRecord, ConnectorStore } from '../connector-store'
import { redactCredentials, type ConnectorCredentials } from '../credentials'
import type { PieceCallRequest, PieceCredentialSource } from '../piece-host/client'
import {
  BRIDGE_MAX_ITEMS_PER_SYNC,
  BRIDGE_MAX_OUTPUT_BYTES,
  buildUpdateProps,
  extractItems,
  fieldsCoveredByUpdate,
  jsonByteLength,
  mapItem,
  redactValue,
  resolveProps,
  validateMapping,
  type ConnectorTaskMapping,
  type ConnectorTaskMappings
} from './mapping'
import { CONNECTOR_TASK_MAPPINGS, getTaskMapping } from './mappings'
import {
  backoffDelayMs,
  classifyError,
  DEFAULT_ITEM_MAX_ATTEMPTS,
  DEFAULT_RETRY_POLICY,
  errorMessage,
  type RetryPolicy
} from './retry'
import { readCursor, trimCursor, type BridgeCursor } from './state'

/**
 * Connector-bridge sync engine (issue #13, docs/connectors.md).
 *
 * The bridge owns sync orchestration, conflict rules and the completion gate;
 * pieces own only the provider API calls, and only the allowlisted ones the
 * task mapping names (PieceHostClient re-checks the allowlist on every call).
 *
 * - One job at a time per connector instance (in-memory lock). A sync
 *   requested while one runs for the same instance shares its result.
 * - Import failures never delete or change cached tasks.
 * - 429 / 5xx failures back off exponentially (Retry-After wins). Attempt
 *   state lives in connector_sync_state, so it survives a restart. Work that
 *   keeps failing lands in connector_dead_letters.
 * - Everything that leaves the engine as text (task fields, errors, logs,
 *   dead letters) is credential-redacted.
 */

export const CONNECTOR_BRIDGE_PLUGIN_ID = 'connector-bridge'
export const DEFAULT_POLL_INTERVAL_MINUTES = 15
export const MIN_POLL_INTERVAL_MINUTES = 1
/** Dead-letter payloads above this are replaced by a size note. */
const MAX_DEAD_LETTER_PAYLOAD_BYTES = 64 * 1024

/** The slice of PieceHostClient the engine uses. */
export interface BridgePieceRunner {
  call(req: PieceCallRequest): Promise<unknown>
}

export interface BridgeRuntime {
  store: ConnectorStore
  credentials: PieceCredentialSource
  client: BridgePieceRunner
}

export interface BridgeSourceConfig {
  pieceName: string
  instanceId: string
  props: Record<string, unknown>
  /** 0 = manual sync only. */
  pollIntervalMinutes: number
}

export function parseBridgeConfig(config: Record<string, unknown>): BridgeSourceConfig {
  const props = config.props && typeof config.props === 'object' && !Array.isArray(config.props)
    ? (config.props as Record<string, unknown>)
    : {}
  const rawInterval = config.poll_interval_minutes
  const interval = typeof rawInterval === 'number' ? rawInterval
    : typeof rawInterval === 'string' && rawInterval.trim() !== '' ? Number(rawInterval)
    : DEFAULT_POLL_INTERVAL_MINUTES
  return {
    pieceName: typeof config.piece_name === 'string' ? config.piece_name : '',
    instanceId: typeof config.connector_instance_id === 'string' ? config.connector_instance_id : '',
    props,
    pollIntervalMinutes: !Number.isFinite(interval) || interval <= 0 ? 0 : Math.max(MIN_POLL_INTERVAL_MINUTES, Math.round(interval))
  }
}

export interface BridgeEngineOptions {
  runtime: BridgeRuntime
  mappings?: ConnectorTaskMappings
  allowlist?: ConnectorPieceAllowlist
  retry?: RetryPolicy
  itemMaxAttempts?: number
  now?: () => number
  log?: (message: string) => void
}

export interface BridgeSyncOptions {
  /** A user-requested sync skips the 5xx backoff window (never a Retry-After). */
  manual?: boolean
}

export interface BridgeUpdateResult {
  ok: boolean
  error?: string
  /** The change failed transiently and will be retried by the scheduler. */
  queued?: boolean
  /** Nothing the mapping can round-trip changed. */
  skipped?: boolean
}

interface Resolved {
  mapping: ConnectorTaskMapping
  cfg: BridgeSourceConfig
  instance: ConnectorInstanceRecord
}

const ROUND_TRIP_FIELDS = ['title', 'due_date', 'status'] as const

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex').slice(0, 16)
}

export class ConnectorBridgeEngine {
  private readonly runtime: BridgeRuntime
  private readonly mappings: ConnectorTaskMappings
  private readonly allowlist: ConnectorPieceAllowlist
  private readonly retry: RetryPolicy
  private readonly itemMaxAttempts: number
  private readonly now: () => number
  private readonly log: (message: string) => void
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly inflightSyncs = new Map<string, Promise<PluginSyncResult>>()

  constructor(options: BridgeEngineOptions) {
    this.runtime = options.runtime
    this.mappings = options.mappings ?? CONNECTOR_TASK_MAPPINGS
    this.allowlist = options.allowlist ?? CONNECTOR_PIECE_ALLOWLIST
    this.retry = options.retry ?? DEFAULT_RETRY_POLICY
    this.itemMaxAttempts = options.itemMaxAttempts ?? DEFAULT_ITEM_MAX_ATTEMPTS
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((m) => console.warn(`[connector-bridge] ${m}`))
  }

  get store(): ConnectorStore {
    return this.runtime.store
  }

  getMapping(pieceName: string): ConnectorTaskMapping | undefined {
    return getTaskMapping(pieceName, this.mappings)
  }

  /** Whether a job for the instance is running or queued. */
  isBusy(instanceId: string): boolean {
    return this.chains.has(instanceId)
  }

  // ── Import ──────────────────────────────────────────────────

  sync(sourceId: string, config: Record<string, unknown>, ctx: PluginContext, options: BridgeSyncOptions = {}): Promise<PluginSyncResult> {
    const resolved = this.resolve(config)
    if ('error' in resolved) return Promise.resolve({ imported: 0, updated: 0, errors: [resolved.error] })
    const key = resolved.cfg.instanceId
    const inflight = this.inflightSyncs.get(key)
    if (inflight) return inflight
    const job = this.withLock(key, () => this.runSync(sourceId, resolved, ctx, options))
    this.inflightSyncs.set(key, job)
    void job.finally(() => {
      if (this.inflightSyncs.get(key) === job) this.inflightSyncs.delete(key)
    }).catch(() => undefined)
    return job
  }

  private async runSync(sourceId: string, { mapping, cfg, instance }: Resolved, ctx: PluginContext, options: BridgeSyncOptions): Promise<PluginSyncResult> {
    const result: PluginSyncResult = { imported: 0, updated: 0, errors: [] }
    const now = this.now()
    const creds = await this.credentialsFor(instance.id)
    const redact = (text: string): string => redactCredentials(text, creds)
    if (!creds) {
      result.errors.push(`${mapping.label} is not connected: enter its credentials in the task source settings.`)
      return result
    }

    const state = this.store.getSyncState(instance.id)
    const cursor = readCursor(state?.cursor)
    if (cursor.rateLimitedUntil && cursor.rateLimitedUntil > now) {
      result.errors.push(`${mapping.label} asked 21x to slow down; the next sync runs after ${new Date(cursor.rateLimitedUntil).toISOString()}. Existing tasks are unchanged.`)
      return result
    }
    if (!options.manual && state?.nextRetryAt && state.nextRetryAt > now) {
      result.errors.push(`Waiting until ${new Date(state.nextRetryAt).toISOString()} before retrying: ${state.lastError ?? 'previous sync failed'}`)
      return result
    }
    cursor.lastRunAt = now

    await this.flushPending(instance, mapping, cfg, cursor, creds, result)

    let output: unknown
    try {
      const props = resolveProps(mapping.import.props, cfg.props, mapping)
      output = await this.callImport(instance, mapping, props, cursor)
      delete cursor.rateLimitedUntil
    } catch (err) {
      this.failJob(instance.id, mapping, cursor, err, creds, result, state?.attemptCount ?? 0)
      return result
    }

    const size = jsonByteLength(output)
    if (size > BRIDGE_MAX_OUTPUT_BYTES) {
      this.failJob(instance.id, mapping, cursor, new Error(`${mapping.label} returned ${size} bytes; the limit is ${BRIDGE_MAX_OUTPUT_BYTES}`), creds, result, 0)
      return result
    }
    const items = extractItems(output, mapping)
    if (!items) {
      this.failJob(instance.id, mapping, cursor, new Error(`${mapping.label} returned no item list${mapping.import.itemsPath ? ` at "${mapping.import.itemsPath}"` : ''}`), creds, result, 0)
      return result
    }
    if (items.length > BRIDGE_MAX_ITEMS_PER_SYNC) {
      result.errors.push(`${mapping.label} returned ${items.length} items; only the first ${BRIDGE_MAX_ITEMS_PER_SYNC} were imported.`)
    }

    const projectId = ctx.db.getTaskSource(sourceId)?.project_id
    for (const item of items.slice(0, BRIDGE_MAX_ITEMS_PER_SYNC)) {
      const mapped = mapItem(item, mapping, creds)
      // Dead-lettered items are skipped until their content changes.
      const itemId = mapped.ok ? mapped.item.externalId : mapped.externalId
      const prior = itemId ? cursor.items[itemId] : undefined
      if (prior?.dead && prior.fingerprint === fingerprint(item)) continue
      if (!mapped.ok) {
        this.recordItemFailure(instance.id, mapping, cursor, mapped.externalId, item, mapped.error, creds, result)
        continue
      }
      const { externalId, fields, completed } = mapped.item
      const title = fields.title as string
      try {
        // Conflict rule: a local change still waiting to reach the source wins.
        const pending = cursor.pending[externalId]
        if (pending) for (const f of fieldsCoveredByUpdate(pending.changed)) delete fields[f]

        const existing = ctx.db.getTaskByExternalId(sourceId, externalId)
        // Items already closed at the source never create new tasks.
        if (!existing && completed) {
          delete cursor.items[externalId]
          continue
        }
        const upserted = upsertSourcedTask(ctx, sourceId, externalId, fields, {
          title,
          source: mapping.label,
          ...(projectId ? { project_id: projectId } : {})
        })
        if (!upserted) throw new Error('the task could not be saved')
        if (upserted.created) result.imported++
        else result.updated++
        delete cursor.items[externalId]
      } catch (err) {
        this.recordItemFailure(instance.id, mapping, cursor, externalId, item, errorMessage(err), creds, result)
      }
    }

    this.store.updateSyncState(instance.id, {
      cursor: trimCursor(cursor),
      attemptCount: 0,
      nextRetryAt: null,
      lastError: result.errors.length ? redact(result.errors.join('\n')).slice(0, 4000) : null,
      lastSyncedAt: now
    })
    return result
  }

  private async callImport(
    instance: ConnectorInstanceRecord,
    mapping: ConnectorTaskMapping,
    props: Record<string, unknown>,
    cursor: BridgeCursor
  ): Promise<unknown> {
    const base = { instanceId: instance.id, pieceName: instance.pieceName, pieceVersion: instance.pieceVersion, propsValue: props }
    const { target } = mapping.import
    if (target.type === 'action') {
      return this.runtime.client.call({ ...base, target: { type: 'action', name: target.name } })
    }
    if (cursor.triggerEnabled !== target.name) {
      await this.runtime.client.call({ ...base, target: { type: 'trigger', name: target.name, hook: 'onEnable' } })
      cursor.triggerEnabled = target.name
      // Persist now: re-running onEnable would reset the trigger's own cursor.
      this.store.updateSyncState(instance.id, { cursor })
    }
    return this.runtime.client.call({ ...base, target: { type: 'trigger', name: target.name, hook: 'run' } })
  }

  /** Records a failed import job. Cached tasks are left exactly as they were. */
  private failJob(
    instanceId: string,
    mapping: ConnectorTaskMapping,
    cursor: BridgeCursor,
    err: unknown,
    creds: ConnectorCredentials | null,
    result: PluginSyncResult,
    previousAttempts: number
  ): void {
    const now = this.now()
    const message = redactCredentials(errorMessage(err), creds)
    const cls = classifyError(err, now)
    this.log(`${mapping.label} sync failed for ${instanceId}: ${message}`)
    if (!cls.retryable) {
      this.store.updateSyncState(instanceId, { cursor: trimCursor(cursor), attemptCount: 0, nextRetryAt: null, lastError: message })
      result.errors.push(`${mapping.label} sync failed: ${message}. Existing tasks were kept.`)
      return
    }
    const attempts = previousAttempts + 1
    if (attempts >= this.retry.maxAttempts) {
      this.store.addDeadLetter(instanceId, {
        externalId: null,
        payload: { operation: 'import', target: mapping.import.target },
        error: message,
        attempts
      })
      delete cursor.rateLimitedUntil
      this.store.updateSyncState(instanceId, { cursor: trimCursor(cursor), attemptCount: 0, nextRetryAt: null, lastError: message })
      result.errors.push(`${mapping.label} sync failed ${attempts} times and was moved to dead letters: ${message}. Existing tasks were kept.`)
      return
    }
    const delay = backoffDelayMs(attempts, this.retry, cls.retryAfterMs)
    const nextRetryAt = now + delay
    if (cls.rateLimited) cursor.rateLimitedUntil = nextRetryAt
    this.store.updateSyncState(instanceId, { cursor: trimCursor(cursor), attemptCount: attempts, nextRetryAt, lastError: message })
    result.errors.push(
      `${mapping.label} sync failed (attempt ${attempts} of ${this.retry.maxAttempts}); retrying after ${new Date(nextRetryAt).toISOString()}: ${message}. Existing tasks were kept.`
    )
  }

  private recordItemFailure(
    instanceId: string,
    mapping: ConnectorTaskMapping,
    cursor: BridgeCursor,
    externalId: string | null,
    item: unknown,
    error: string,
    creds: ConnectorCredentials | null,
    result: PluginSyncResult
  ): void {
    const message = redactCredentials(error, creds)
    if (!externalId) {
      result.errors.push(`${mapping.label} item skipped: ${message}`)
      return
    }
    const prev = cursor.items[externalId]
    const attempts = (prev && !prev.dead ? prev.attempts : 0) + 1
    const fp = fingerprint(item)
    if (attempts >= this.itemMaxAttempts) {
      this.store.addDeadLetter(instanceId, { externalId, payload: this.deadLetterPayload(item, creds), error: message, attempts })
      cursor.items[externalId] = { attempts, lastError: message, fingerprint: fp, dead: true }
      result.errors.push(`${mapping.label} item ${externalId}: ${message} (failed ${attempts} times; moved to dead letters)`)
      return
    }
    cursor.items[externalId] = { attempts, lastError: message, fingerprint: fp }
    result.errors.push(`${mapping.label} item ${externalId}: ${message} (attempt ${attempts} of ${this.itemMaxAttempts})`)
  }

  private deadLetterPayload(value: unknown, creds: ConnectorCredentials | null): unknown {
    const size = jsonByteLength(value)
    if (size > MAX_DEAD_LETTER_PAYLOAD_BYTES) return { omitted: true, bytes: size }
    return redactValue(value, creds)
  }

  // ── Round trip ──────────────────────────────────────────────

  /**
   * Pushes a local title / due date / status change through the mapping's
   * allowlisted update action. With `queueOnFailure`, a transient failure is
   * stored and retried by the scheduler, and a permanent one is dead-lettered;
   * without it (user-driven actions) the error is simply returned.
   */
  pushUpdate(
    task: Pick<TaskRecord, 'external_id'>,
    changedFields: Record<string, unknown>,
    config: Record<string, unknown>,
    options: { queueOnFailure: boolean }
  ): Promise<BridgeUpdateResult> {
    const resolved = this.resolve(config)
    if ('error' in resolved) return Promise.resolve({ ok: false, error: resolved.error })
    const externalId = task.external_id
    if (!externalId) return Promise.resolve({ ok: false, error: 'Task is not linked to a source item' })
    const changed: Record<string, unknown> = {}
    for (const f of ROUND_TRIP_FIELDS) if (f in changedFields) changed[f] = changedFields[f]
    const { mapping, cfg, instance } = resolved
    if (!mapping.update) return Promise.resolve({ ok: false, skipped: true, error: `${mapping.label} tasks cannot be updated from 21x` })
    let props: Record<string, unknown> | null
    try {
      props = buildUpdateProps(mapping, externalId, changed, cfg.props)
    } catch (err) {
      return Promise.resolve({ ok: false, error: errorMessage(err) })
    }
    if (!props) return Promise.resolve({ ok: true, skipped: true })
    const updateProps = props

    return this.withLock(instance.id, async () => {
      const creds = await this.credentialsFor(instance.id)
      const cursor = readCursor(this.store.getSyncState(instance.id)?.cursor)
      const now = this.now()
      if (options.queueOnFailure && cursor.rateLimitedUntil && cursor.rateLimitedUntil > now) {
        this.queuePending(cursor, externalId, changed, 0, cursor.rateLimitedUntil, 'rate limited')
        this.store.updateSyncState(instance.id, { cursor })
        return { ok: false, queued: true, error: `${mapping.label} is rate limited; the change will be sent later` }
      }
      try {
        await this.callUpdate(instance, mapping, updateProps)
        this.clearPending(cursor, externalId, changed)
        this.store.updateSyncState(instance.id, { cursor })
        return { ok: true }
      } catch (err) {
        const message = redactCredentials(errorMessage(err), creds)
        this.log(`${mapping.label} update of ${externalId} failed: ${message}`)
        if (!options.queueOnFailure) return { ok: false, error: message }
        const cls = classifyError(err, now)
        if (!cls.retryable) {
          this.store.addDeadLetter(instance.id, {
            externalId,
            payload: { operation: 'update', changed: redactValue(changed, creds) },
            error: message,
            attempts: 1
          })
          this.clearPending(cursor, externalId, changed)
          this.store.updateSyncState(instance.id, { cursor })
          return { ok: false, error: message }
        }
        const prev = cursor.pending[externalId]?.attempts ?? 0
        const delay = backoffDelayMs(prev + 1, this.retry, cls.retryAfterMs)
        if (cls.rateLimited) cursor.rateLimitedUntil = now + delay
        this.queuePending(cursor, externalId, changed, prev + 1, now + delay, message)
        this.store.updateSyncState(instance.id, { cursor })
        return { ok: false, queued: true, error: message }
      }
    })
  }

  private async callUpdate(instance: ConnectorInstanceRecord, mapping: ConnectorTaskMapping, props: Record<string, unknown>): Promise<unknown> {
    return this.runtime.client.call({
      instanceId: instance.id,
      pieceName: instance.pieceName,
      pieceVersion: instance.pieceVersion,
      target: { type: 'action', name: mapping.update!.action },
      propsValue: props
    })
  }

  private queuePending(cursor: BridgeCursor, externalId: string, changed: Record<string, unknown>, attempts: number, nextRetryAt: number, lastError: string): void {
    const prev = cursor.pending[externalId]
    cursor.pending[externalId] = {
      changed: { ...(prev?.changed ?? {}), ...changed },
      attempts,
      nextRetryAt,
      lastError
    }
  }

  private clearPending(cursor: BridgeCursor, externalId: string, pushed: Record<string, unknown>): void {
    const pending = cursor.pending[externalId]
    if (!pending) return
    for (const key of Object.keys(pushed)) delete pending.changed[key]
    if (Object.keys(pending.changed).length === 0) delete cursor.pending[externalId]
  }

  /** Retries queued updates that are due. Runs inside the instance lock. */
  private async flushPending(
    instance: ConnectorInstanceRecord,
    mapping: ConnectorTaskMapping,
    cfg: BridgeSourceConfig,
    cursor: BridgeCursor,
    creds: ConnectorCredentials | null,
    result: PluginSyncResult
  ): Promise<void> {
    for (const [externalId, pending] of Object.entries(cursor.pending)) {
      const now = this.now()
      if (pending.nextRetryAt > now) continue
      if (cursor.rateLimitedUntil && cursor.rateLimitedUntil > now) return
      let props: Record<string, unknown> | null = null
      try {
        props = buildUpdateProps(mapping, externalId, pending.changed, cfg.props)
      } catch {
        props = null
      }
      if (!props) {
        delete cursor.pending[externalId]
        continue
      }
      try {
        await this.callUpdate(instance, mapping, props)
        delete cursor.pending[externalId]
      } catch (err) {
        const message = redactCredentials(errorMessage(err), creds)
        const cls = classifyError(err, now)
        const attempts = pending.attempts + 1
        if (!cls.retryable || attempts >= this.retry.maxAttempts) {
          this.store.addDeadLetter(instance.id, {
            externalId,
            payload: { operation: 'update', changed: redactValue(pending.changed, creds) },
            error: message,
            attempts
          })
          delete cursor.pending[externalId]
          result.errors.push(`${mapping.label} item ${externalId}: update failed ${attempts} times and was moved to dead letters: ${message}`)
          continue
        }
        const delay = backoffDelayMs(attempts, this.retry, cls.retryAfterMs)
        cursor.pending[externalId] = { ...pending, attempts, nextRetryAt: now + delay, lastError: message }
        result.errors.push(`${mapping.label} item ${externalId}: update failed (attempt ${attempts} of ${this.retry.maxAttempts}): ${message}`)
        if (cls.rateLimited) {
          cursor.rateLimitedUntil = now + delay
          return
        }
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────

  private resolve(config: Record<string, unknown>): Resolved | { error: string } {
    const cfg = parseBridgeConfig(config)
    if (!cfg.pieceName) return { error: 'Choose a connector piece' }
    const mapping = this.getMapping(cfg.pieceName)
    if (!mapping) return { error: `${cfg.pieceName} cannot be used as a task source` }
    const problems = validateMapping(mapping, this.allowlist)
    if (problems.length) return { error: `The ${mapping.label} task mapping is invalid: ${problems.join('; ')}` }
    if (!cfg.instanceId) return { error: `Connect ${mapping.label} first` }
    const instance = this.store.getInstance(cfg.instanceId)
    if (!instance) return { error: `The ${mapping.label} connection no longer exists; connect it again` }
    if (instance.pieceName !== cfg.pieceName) return { error: 'The connection belongs to a different piece' }
    if (!instance.enabled) return { error: `The ${mapping.label} connection is disabled` }
    return { mapping, cfg, instance }
  }

  private async credentialsFor(instanceId: string): Promise<ConnectorCredentials | null> {
    try {
      return (await this.runtime.credentials.get(instanceId)) ?? null
    } catch {
      return null
    }
  }

  /** Serialises work per connector instance. */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => undefined)
    this.chains.set(key, tail)
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key)
    })
    return run
  }
}
