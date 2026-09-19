import type Database from 'better-sqlite3'
import { createId } from '@paralleldrive/cuid2'

export type DeliveryKind = 'agent_message' | 'captain_request' | 'captain_report'
export type DeliveryState = 'pending' | 'claimed' | 'accepted' | 'acknowledged' | 'failed' | 'timed_out' | 'cancelled'

export interface DeliveryRecord {
  id: string
  idempotencyKey: string
  kind: DeliveryKind
  state: DeliveryState
  sourceSessionId: string | null
  projectId: string | null
  taskId: string | null
  agentId: string | null
  correlationId: string | null
  payload: string
  destinationId: string | null
  attemptCount: number
  claimOwner: string | null
  claimExpiresAt: number | null
  deadlineAt: number | null
  lastError: string | null
  createdAt: number
  updatedAt: number
  acknowledgedAt: number | null
}

interface DeliveryRow {
  id: string
  idempotency_key: string
  kind: DeliveryKind
  state: DeliveryState
  source_session_id: string | null
  project_id: string | null
  task_id: string | null
  agent_id: string | null
  correlation_id: string | null
  payload: string
  destination_id: string | null
  attempt_count: number
  claim_owner: string | null
  claim_expires_at: number | null
  deadline_at: number | null
  last_error: string | null
  created_at: number
  updated_at: number
  acknowledged_at: number | null
}

function delivery(row: DeliveryRow): DeliveryRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    kind: row.kind,
    state: row.state,
    sourceSessionId: row.source_session_id,
    projectId: row.project_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    correlationId: row.correlation_id,
    payload: row.payload,
    destinationId: row.destination_id,
    attemptCount: row.attempt_count,
    claimOwner: row.claim_owner,
    claimExpiresAt: row.claim_expires_at,
    deadlineAt: row.deadline_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acknowledgedAt: row.acknowledged_at
  }
}

export class DeliveryStore {
  constructor(private readonly source: { db: Database.Database }, private readonly now: () => number = Date.now) {}

  enqueue(input: {
    idempotencyKey: string
    kind: DeliveryKind
    payload: string
    sourceSessionId?: string | null
    projectId?: string | null
    taskId?: string | null
    agentId?: string | null
    correlationId?: string | null
    deadlineAt?: number | null
  }): { record: DeliveryRecord; inserted: boolean } {
    const ts = this.now()
    const id = createId()
    const result = this.source.db.prepare(`
      INSERT OR IGNORE INTO delivery_outbox
        (id, idempotency_key, kind, state, source_session_id, project_id, task_id,
         agent_id, correlation_id, payload, attempt_count, deadline_at, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      id,
      input.idempotencyKey,
      input.kind,
      input.sourceSessionId ?? null,
      input.projectId ?? null,
      input.taskId ?? null,
      input.agentId ?? null,
      input.correlationId ?? null,
      input.payload,
      input.deadlineAt ?? null,
      ts,
      ts
    )
    return { record: this.getByKey(input.idempotencyKey)!, inserted: result.changes === 1 }
  }

  get(id: string): DeliveryRecord | null {
    const row = this.source.db.prepare('SELECT * FROM delivery_outbox WHERE id = ?').get(id) as DeliveryRow | undefined
    return row ? delivery(row) : null
  }

  getByKey(key: string): DeliveryRecord | null {
    const row = this.source.db.prepare('SELECT * FROM delivery_outbox WHERE idempotency_key = ?').get(key) as DeliveryRow | undefined
    return row ? delivery(row) : null
  }

  getCaptainRequest(correlationId: string): DeliveryRecord | null {
    const row = this.source.db.prepare(`
      SELECT * FROM delivery_outbox
      WHERE kind = 'captain_request' AND correlation_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(correlationId) as DeliveryRow | undefined
    return row ? delivery(row) : null
  }

  listRecoverable(kind?: DeliveryKind, now = this.now()): DeliveryRecord[] {
    const params: unknown[] = [now]
    let filter = ''
    if (kind) {
      filter = ' AND kind = ?'
      params.push(kind)
    }
    const rows = this.source.db.prepare(`
      SELECT * FROM delivery_outbox
      WHERE (state = 'pending' OR state = 'accepted' OR (state = 'claimed' AND COALESCE(claim_expires_at, 0) <= ?))${filter}
      ORDER BY created_at ASC
    `).all(...params) as DeliveryRow[]
    return rows.map(delivery)
  }

  claim(id: string, owner: string, leaseMs: number): DeliveryRecord | null {
    const ts = this.now()
    const result = this.source.db.prepare(`
      UPDATE delivery_outbox SET
        state = 'claimed', claim_owner = ?, claim_expires_at = ?,
        attempt_count = attempt_count + 1, updated_at = ?
      WHERE id = ? AND (state = 'pending' OR (state = 'claimed' AND COALESCE(claim_expires_at, 0) <= ?))
    `).run(owner, ts + leaseMs, ts, id, ts)
    return result.changes ? this.get(id) : null
  }

  accept(id: string, owner: string, destinationId: string): DeliveryRecord | null {
    const ts = this.now()
    const result = this.source.db.prepare(`
      UPDATE delivery_outbox SET state = 'accepted', destination_id = ?, updated_at = ?
      WHERE id = ? AND state = 'claimed' AND claim_owner = ?
    `).run(destinationId, ts, id, owner)
    return result.changes ? this.get(id) : null
  }

  acknowledge(id: string, owner?: string): DeliveryRecord | null {
    const ts = this.now()
    const result = this.source.db.prepare(`
      UPDATE delivery_outbox SET
        state = 'acknowledged', claim_owner = NULL, claim_expires_at = NULL,
        acknowledged_at = ?, updated_at = ?
      WHERE id = ? AND state IN ('claimed', 'accepted', 'acknowledged')
        AND (? IS NULL OR claim_owner = ? OR state = 'acknowledged')
    `).run(ts, ts, id, owner ?? null, owner ?? null)
    return result.changes ? this.get(id) : null
  }

  release(id: string, owner: string, error: string): DeliveryRecord | null {
    const result = this.source.db.prepare(`
      UPDATE delivery_outbox SET state = 'pending', claim_owner = NULL,
        claim_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND state = 'claimed' AND claim_owner = ?
    `).run(error, this.now(), id, owner)
    return result.changes ? this.get(id) : null
  }

  terminal(id: string, state: 'failed' | 'timed_out' | 'cancelled', error: string): DeliveryRecord | null {
    this.source.db.prepare(`
      UPDATE delivery_outbox SET state = ?, claim_owner = NULL, claim_expires_at = NULL,
        last_error = ?, updated_at = ?
      WHERE id = ? AND state NOT IN ('acknowledged', 'failed', 'timed_out', 'cancelled')
    `).run(state, error, this.now(), id)
    return this.get(id)
  }

  expireDeadlines(now = this.now()): DeliveryRecord[] {
    const rows = this.source.db.prepare(`
      SELECT * FROM delivery_outbox
      WHERE deadline_at IS NOT NULL AND deadline_at <= ?
        AND state NOT IN ('acknowledged', 'failed', 'timed_out', 'cancelled')
    `).all(now) as DeliveryRow[]
    for (const row of rows) this.terminal(row.id, 'timed_out', 'No terminal report arrived before the request deadline.')
    return rows.map((row) => this.get(row.id)!).filter(Boolean)
  }
}
