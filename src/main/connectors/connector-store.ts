import type Database from 'better-sqlite3'
import { createId } from '@paralleldrive/cuid2'

/**
 * Persistence for embedded connector pieces (docs/connectors.md).
 *
 * Backed by the app's SQLite connection (DatabaseManager.db). Pieces never see
 * this class: the piece host hands them a resolved credential and a KV store
 * bound to one instance + scope. Timestamps are epoch ms.
 */

export type ConnectorKvScope = 'project' | 'flow'
export const CONNECTOR_KV_SCOPES: readonly ConnectorKvScope[] = ['project', 'flow']

/** Largest JSON-encoded value accepted for one key. */
export const CONNECTOR_KV_MAX_VALUE_BYTES = 512 * 1024
/** Largest total (keys + JSON values, all scopes) one instance may hold. */
export const CONNECTOR_KV_MAX_INSTANCE_BYTES = 10 * 1024 * 1024
/** Matches the Activepieces store key limit. */
export const CONNECTOR_KV_MAX_KEY_CHARS = 128

export type ConnectorKvLimitKind = 'key' | 'value' | 'instance'

/** Thrown when a KV write would exceed a size cap. Nothing is written. */
export class ConnectorKvLimitError extends Error {
  readonly code = 'CONNECTOR_KV_LIMIT'
  constructor(
    readonly kind: ConnectorKvLimitKind,
    readonly size: number,
    readonly limit: number
  ) {
    super(
      kind === 'key'
        ? `Connector store key is ${size} characters; the limit is ${limit}`
        : kind === 'value'
          ? `Connector store value is ${size} bytes; the limit is ${limit}`
          : `Connector store would hold ${size} bytes for this connector; the limit is ${limit}`
    )
    this.name = 'ConnectorKvLimitError'
  }
}

/** Renderer-safe: never carries the auth ciphertext. */
export interface ConnectorInstanceRecord {
  id: string
  pieceName: string
  pieceVersion: string
  displayName: string
  config: Record<string, unknown>
  authType: string | null
  hasStoredAuth: boolean
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface CreateConnectorInstanceInput {
  pieceName: string
  pieceVersion: string
  displayName?: string
  config?: Record<string, unknown>
  enabled?: boolean
}

export interface UpdateConnectorInstanceInput {
  pieceVersion?: string
  displayName?: string
  config?: Record<string, unknown>
  enabled?: boolean
}

export interface ConnectorSyncState {
  instanceId: string
  cursor: unknown
  attemptCount: number
  nextRetryAt: number | null
  lastError: string | null
  lastSyncedAt: number | null
}

export type ConnectorSyncStatePatch = Partial<Omit<ConnectorSyncState, 'instanceId'>>

export interface ConnectorDeadLetter {
  id: string
  instanceId: string
  externalId: string | null
  payload: unknown
  error: string
  attempts: number
  createdAt: number
}

export interface AddConnectorDeadLetterInput {
  externalId?: string | null
  payload: unknown
  error: string
  attempts?: number
}

interface InstanceRow {
  id: string
  piece_name: string
  piece_version: string
  display_name: string
  config: string
  auth: Buffer | null
  auth_type: string | null
  enabled: number
  created_at: number
  updated_at: number
}

interface SyncStateRow {
  instance_id: string
  cursor: string | null
  attempt_count: number
  next_retry_at: number | null
  last_error: string | null
  last_synced_at: number | null
}

interface DeadLetterRow {
  id: string
  instance_id: string
  external_id: string | null
  payload: string
  error: string
  attempts: number
  created_at: number
}

function parseJson(value: string | null, fallback: unknown): unknown {
  if (value === null) return fallback
  try {
    return JSON.parse(value) as unknown
  } catch {
    return fallback
  }
}

function toInstance(row: InstanceRow): ConnectorInstanceRecord {
  const config = parseJson(row.config, {})
  return {
    id: row.id,
    pieceName: row.piece_name,
    pieceVersion: row.piece_version,
    displayName: row.display_name,
    config: config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>) : {},
    authType: row.auth_type,
    hasStoredAuth: row.auth !== null,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function assertScope(scope: ConnectorKvScope): void {
  if (!CONNECTOR_KV_SCOPES.includes(scope)) throw new Error(`Unknown connector store scope: ${String(scope)}`)
}

/** `undefined` has no JSON form; it is stored as null, the value a missing key reads as. */
function encodeValue(value: unknown): string {
  return JSON.stringify(value) ?? 'null'
}

export class ConnectorStore {
  private readonly deleteListeners = new Set<(instanceId: string) => void>()

  constructor(private readonly source: { db: Database.Database }) {}

  private get db(): Database.Database {
    return this.source.db
  }

  // ── Instances ──────────────────────────────────────────────

  listInstances(): ConnectorInstanceRecord[] {
    const rows = this.db.prepare('SELECT * FROM connector_instances ORDER BY created_at ASC, id ASC').all() as InstanceRow[]
    return rows.map(toInstance)
  }

  getInstance(id: string): ConnectorInstanceRecord | undefined {
    const row = this.db.prepare('SELECT * FROM connector_instances WHERE id = ?').get(id) as InstanceRow | undefined
    return row ? toInstance(row) : undefined
  }

  createInstance(input: CreateConnectorInstanceInput): ConnectorInstanceRecord {
    const id = createId()
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO connector_instances (id, piece_name, piece_version, display_name, config, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.pieceName,
      input.pieceVersion,
      input.displayName ?? '',
      JSON.stringify(input.config ?? {}),
      input.enabled === false ? 0 : 1,
      now,
      now
    )
    return this.getInstance(id)!
  }

  updateInstance(id: string, input: UpdateConnectorInstanceInput): ConnectorInstanceRecord | undefined {
    const sets: string[] = []
    const values: unknown[] = []
    if (input.pieceVersion !== undefined) { sets.push('piece_version = ?'); values.push(input.pieceVersion) }
    if (input.displayName !== undefined) { sets.push('display_name = ?'); values.push(input.displayName) }
    if (input.config !== undefined) { sets.push('config = ?'); values.push(JSON.stringify(input.config)) }
    if (input.enabled !== undefined) { sets.push('enabled = ?'); values.push(input.enabled ? 1 : 0) }
    if (sets.length > 0) {
      sets.push('updated_at = ?')
      values.push(Date.now(), id)
      this.db.prepare(`UPDATE connector_instances SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    }
    return this.getInstance(id)
  }

  /**
   * Removes the instance; its KV entries, sync state, dead letters and stored
   * credentials go with it (FK cascade + the auth column on the row itself).
   * Delete listeners (e.g. session-only credentials) run afterwards.
   */
  deleteInstance(id: string): boolean {
    const result = this.db.prepare('DELETE FROM connector_instances WHERE id = ?').run(id)
    for (const listener of this.deleteListeners) listener(id)
    return result.changes > 0
  }

  /** Called with the instance id after every deleteInstance(). Returns an unsubscribe. */
  onInstanceDeleted(listener: (instanceId: string) => void): () => void {
    this.deleteListeners.add(listener)
    return () => this.deleteListeners.delete(listener)
  }

  // ── Auth ciphertext (for credentials.ts only) ──────────────

  /** @internal Raw ciphertext; use ConnectorCredentialStore instead. */
  getAuthBlob(id: string): { authType: string | null; auth: Buffer | null } | undefined {
    const row = this.db.prepare('SELECT auth, auth_type FROM connector_instances WHERE id = ?').get(id) as
      { auth: Buffer | null; auth_type: string | null } | undefined
    return row ? { authType: row.auth_type, auth: row.auth } : undefined
  }

  /** @internal Writes ciphertext (or clears it with null); use ConnectorCredentialStore instead. */
  setAuthBlob(id: string, authType: string | null, auth: Buffer | null): boolean {
    const result = this.db.prepare(
      'UPDATE connector_instances SET auth = ?, auth_type = ?, updated_at = ? WHERE id = ?'
    ).run(auth, authType, Date.now(), id)
    return result.changes > 0
  }

  // ── Key-value store ────────────────────────────────────────

  /** The stored JSON value, or null when the key is absent (the pieces `store.get` contract). */
  kvGet<T = unknown>(instanceId: string, scope: ConnectorKvScope, key: string): T | null {
    assertScope(scope)
    const row = this.db.prepare('SELECT value FROM connector_kv WHERE instance_id = ? AND scope = ? AND key = ?')
      .get(instanceId, scope, key) as { value: string } | undefined
    return row ? (parseJson(row.value, null) as T | null) : null
  }

  /** Stores `value` as JSON. Throws ConnectorKvLimitError (and writes nothing) past a cap. */
  kvPut(instanceId: string, scope: ConnectorKvScope, key: string, value: unknown): void {
    assertScope(scope)
    if (key.length > CONNECTOR_KV_MAX_KEY_CHARS) {
      throw new ConnectorKvLimitError('key', key.length, CONNECTOR_KV_MAX_KEY_CHARS)
    }
    const encoded = encodeValue(value)
    const valueBytes = Buffer.byteLength(encoded, 'utf8')
    if (valueBytes > CONNECTOR_KV_MAX_VALUE_BYTES) {
      throw new ConnectorKvLimitError('value', valueBytes, CONNECTOR_KV_MAX_VALUE_BYTES)
    }
    const entryBytes = valueBytes + Buffer.byteLength(key, 'utf8')

    this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT COALESCE(SUM(length(CAST(key AS BLOB)) + length(CAST(value AS BLOB))), 0) AS total
        FROM connector_kv
        WHERE instance_id = ? AND NOT (scope = ? AND key = ?)
      `).get(instanceId, scope, key) as { total: number }
      const total = row.total + entryBytes
      if (total > CONNECTOR_KV_MAX_INSTANCE_BYTES) {
        throw new ConnectorKvLimitError('instance', total, CONNECTOR_KV_MAX_INSTANCE_BYTES)
      }
      this.db.prepare(`
        INSERT INTO connector_kv (instance_id, scope, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (instance_id, scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(instanceId, scope, key, encoded, Date.now())
    })()
  }

  kvDelete(instanceId: string, scope: ConnectorKvScope, key: string): boolean {
    assertScope(scope)
    return this.db.prepare('DELETE FROM connector_kv WHERE instance_id = ? AND scope = ? AND key = ?')
      .run(instanceId, scope, key).changes > 0
  }

  kvList(instanceId: string, scope: ConnectorKvScope): string[] {
    assertScope(scope)
    const rows = this.db.prepare('SELECT key FROM connector_kv WHERE instance_id = ? AND scope = ? ORDER BY key')
      .all(instanceId, scope) as { key: string }[]
    return rows.map((r) => r.key)
  }

  /** Clears one scope, or every scope when omitted. Returns the number of keys removed. */
  kvClear(instanceId: string, scope?: ConnectorKvScope): number {
    if (scope === undefined) {
      return this.db.prepare('DELETE FROM connector_kv WHERE instance_id = ?').run(instanceId).changes
    }
    assertScope(scope)
    return this.db.prepare('DELETE FROM connector_kv WHERE instance_id = ? AND scope = ?').run(instanceId, scope).changes
  }

  /** Bytes counted against CONNECTOR_KV_MAX_INSTANCE_BYTES. */
  kvUsage(instanceId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(length(CAST(key AS BLOB)) + length(CAST(value AS BLOB))), 0) AS total
      FROM connector_kv WHERE instance_id = ?
    `).get(instanceId) as { total: number }
    return row.total
  }

  // ── Sync state ─────────────────────────────────────────────

  getSyncState(instanceId: string): ConnectorSyncState | null {
    const row = this.db.prepare('SELECT * FROM connector_sync_state WHERE instance_id = ?').get(instanceId) as SyncStateRow | undefined
    if (!row) return null
    return {
      instanceId: row.instance_id,
      cursor: parseJson(row.cursor, null),
      attemptCount: row.attempt_count,
      nextRetryAt: row.next_retry_at,
      lastError: row.last_error,
      lastSyncedAt: row.last_synced_at
    }
  }

  /** Merges `patch` into the instance's sync state, creating it on first use. */
  updateSyncState(instanceId: string, patch: ConnectorSyncStatePatch): ConnectorSyncState {
    const current = this.getSyncState(instanceId)
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
    const next: ConnectorSyncState = {
      instanceId,
      cursor: null,
      attemptCount: 0,
      nextRetryAt: null,
      lastError: null,
      lastSyncedAt: null,
      ...current,
      ...defined
    }
    this.db.prepare(`
      INSERT INTO connector_sync_state (instance_id, cursor, attempt_count, next_retry_at, last_error, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (instance_id) DO UPDATE SET
        cursor = excluded.cursor, attempt_count = excluded.attempt_count, next_retry_at = excluded.next_retry_at,
        last_error = excluded.last_error, last_synced_at = excluded.last_synced_at
    `).run(
      instanceId,
      next.cursor === null || next.cursor === undefined ? null : JSON.stringify(next.cursor),
      next.attemptCount,
      next.nextRetryAt,
      next.lastError,
      next.lastSyncedAt
    )
    return this.getSyncState(instanceId)!
  }

  // ── Dead letters ───────────────────────────────────────────

  /** `error` must already be redacted (see redactCredentials in credentials.ts). */
  addDeadLetter(instanceId: string, input: AddConnectorDeadLetterInput): ConnectorDeadLetter {
    const payload = encodeValue(input.payload)
    const record: ConnectorDeadLetter = {
      id: createId(),
      instanceId,
      externalId: input.externalId ?? null,
      payload: JSON.parse(payload) as unknown,
      error: input.error,
      attempts: input.attempts ?? 0,
      createdAt: Date.now()
    }
    this.db.prepare(`
      INSERT INTO connector_dead_letters (id, instance_id, external_id, payload, error, attempts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(record.id, instanceId, record.externalId, payload, record.error, record.attempts, record.createdAt)
    return record
  }

  listDeadLetters(instanceId: string): ConnectorDeadLetter[] {
    const rows = this.db.prepare(
      'SELECT * FROM connector_dead_letters WHERE instance_id = ? ORDER BY created_at ASC, rowid ASC'
    ).all(instanceId) as DeadLetterRow[]
    return rows.map((r) => ({
      id: r.id,
      instanceId: r.instance_id,
      externalId: r.external_id,
      payload: parseJson(r.payload, null),
      error: r.error,
      attempts: r.attempts,
      createdAt: r.created_at
    }))
  }

  /** Removes the given dead letters, or all of the instance's when `ids` is omitted. */
  clearDeadLetters(instanceId: string, ids?: string[]): number {
    if (ids === undefined) {
      return this.db.prepare('DELETE FROM connector_dead_letters WHERE instance_id = ?').run(instanceId).changes
    }
    const stmt = this.db.prepare('DELETE FROM connector_dead_letters WHERE instance_id = ? AND id = ?')
    return this.db.transaction(() => ids.reduce((n, id) => n + stmt.run(instanceId, id).changes, 0))()
  }
}
