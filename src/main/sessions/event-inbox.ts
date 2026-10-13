import type Database from 'better-sqlite3'

export interface SessionObservation {
  ownerId: string
  generationKey: string
  engine: 'chat' | 'adapter'
  backendId?: string
  turnKey?: string
  eventType: string
  idempotencyKey: string
  payload: unknown
}
export interface InboxEvent extends SessionObservation { id: number; processRunId: string }
interface InboxRow {
  id: number; process_run_id: string; owner_id: string; generation_key: string; engine: 'chat' | 'adapter'; backend_id: string | null
  turn_key: string | null; event_type: string; idempotency_key: string; payload: string
}

function event(row: InboxRow): InboxEvent {
  return { id: row.id, processRunId: row.process_run_id, ownerId: row.owner_id, generationKey: row.generation_key, engine: row.engine,
    backendId: row.backend_id ?? undefined, turnKey: row.turn_key ?? undefined, eventType: row.event_type,
    idempotencyKey: row.idempotency_key, payload: JSON.parse(row.payload) }
}

/** Durable observational events. Acknowledgement and ledger projection share
 * one transaction; draining never invokes a provider, tool, or application action. */
export class EventInbox {
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {}
  enqueue(input: SessionObservation, processRunId = 'unknown'): boolean {
    const payload = JSON.stringify(input.payload)
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO session_event_inbox
      (owner_id, generation_key, engine, backend_id, process_run_id, turn_key, event_type, idempotency_key, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.ownerId, input.generationKey, input.engine, input.backendId ?? null, processRunId, input.turnKey ?? null,
        input.eventType, input.idempotencyKey, payload, this.now()).changes === 1
    if (!inserted) {
      const existing = this.db.prepare('SELECT * FROM session_event_inbox WHERE idempotency_key = ?').get(input.idempotencyKey) as InboxRow
      if (existing.owner_id !== input.ownerId || existing.generation_key !== input.generationKey
        || existing.engine !== input.engine || existing.backend_id !== (input.backendId ?? null)
        || existing.event_type !== input.eventType || existing.turn_key !== (input.turnKey ?? null)
        || existing.payload !== payload) throw new Error('Session event idempotency key belongs to a different observation')
    }
    return inserted
  }

  pendingOwners(): string[] {
    return (this.db.prepare("SELECT DISTINCT owner_id FROM session_event_inbox WHERE state = 'pending'").all() as Array<{ owner_id: string }>).map(({ owner_id }) => owner_id)
  }

  recoverClaims(processRunId: string): number {
    return this.db.prepare("UPDATE session_event_inbox SET state = 'pending', claim_owner = NULL WHERE state = 'processing' AND process_run_id != ?")
      .run(processRunId).changes
  }

  drain(ownerId: string, processRunId: string, project: (observation: InboxEvent) => void,
    ownedTurn?: { turnKey: string; generationKey: string }): number {
    const rows = ownedTurn
      ? this.db.prepare("SELECT * FROM session_event_inbox WHERE owner_id = ? AND state = 'pending' AND turn_key = ? AND generation_key = ? ORDER BY id")
          .all(ownerId, ownedTurn.turnKey, ownedTurn.generationKey) as InboxRow[]
      : this.db.prepare("SELECT * FROM session_event_inbox WHERE owner_id = ? AND state = 'pending' ORDER BY id").all(ownerId) as InboxRow[]
    return this.projectRows(rows, processRunId, project)
  }

  /** Exact instance-owned keys fence shutdown from sibling observers, even
   * when they share an owner, generation, database and process identity. */
  drainOwned(ownerId: string, keys: string[], claimOwner: string, project: (observation: InboxEvent) => void): number {
    let processed = 0
    for (let offset = 0; offset < keys.length; offset += 500) {
      const batch = keys.slice(offset, offset + 500)
      const rows = this.db.prepare(`SELECT * FROM session_event_inbox WHERE owner_id = ? AND state = 'pending'
        AND idempotency_key IN (${batch.map(() => '?').join(',')}) ORDER BY id`).all(ownerId, ...batch) as InboxRow[]
      processed += this.projectRows(rows, claimOwner, project)
    }
    return processed
  }

  private projectRows(rows: InboxRow[], processRunId: string, project: (observation: InboxEvent) => void): number {
    let processed = 0
    for (const row of rows) {
      this.db.transaction(() => {
        if (!this.db.prepare("UPDATE session_event_inbox SET state = 'processing', claim_owner = ? WHERE id = ? AND state = 'pending'").run(processRunId, row.id).changes) return
        project(event(row))
        this.db.prepare("UPDATE session_event_inbox SET state = 'processed', processed_at = ?, claim_owner = NULL WHERE id = ? AND claim_owner = ?")
          .run(this.now(), row.id, processRunId)
        processed++
      })()
    }
    return processed
  }
}
