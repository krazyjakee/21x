import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { InboxEvent, SessionObservation } from './event-inbox'

/** Projection only. Existing Commander/adapter sessions remain the sole
 * behavioral owners; this store cannot send prompts, retry, fold, or run tools. */
export class SessionLedger {
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {}

  apply(observation: SessionObservation | InboxEvent, processRunId: string): void {
    const proposed = randomUUID()
    this.db.prepare(`INSERT OR IGNORE INTO session_generations
      (id, owner_id, generation_key, engine, process_run_id, backend_id, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
      .run(proposed, observation.ownerId, observation.generationKey, observation.engine, processRunId,
        observation.backendId ?? null, this.now(), this.now())
    const generation = this.db.prepare('SELECT id FROM session_generations WHERE owner_id = ? AND generation_key = ?')
      .get(observation.ownerId, observation.generationKey) as { id: string }
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO session_lifecycle_events
      (idempotency_key, generation_id, owner_id, turn_key, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(observation.idempotencyKey, generation.id, observation.ownerId, observation.turnKey ?? null,
        observation.eventType, JSON.stringify(observation.payload), this.now()).changes === 1
    if (!inserted) return
    const payload = observation.payload && typeof observation.payload === 'object' ? observation.payload as Record<string, unknown> : {}
    if (observation.eventType === 'turn_started' && observation.turnKey) {
      this.db.prepare(`INSERT OR IGNORE INTO session_turns
        (id, generation_id, owner_id, turn_key, kind, state, input, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`)
        .run(randomUUID(), generation.id, observation.ownerId, observation.turnKey, String(payload.kind ?? 'user'),
          typeof payload.input === 'string' ? payload.input : '', this.now())
      this.db.prepare("UPDATE session_generations SET state = 'running', updated_at = ?, backend_id = COALESCE(?, backend_id) WHERE id = ?")
        .run(this.now(), observation.backendId ?? null, generation.id)
    } else if (observation.eventType === 'turn_done' && observation.turnKey) {
      const reason = String(payload.stopReason ?? 'unknown')
      const state = reason === 'cancelled' ? 'cancelled' : reason === 'error' ? 'failed'
        : reason === 'interrupted' || reason === 'shutdown' ? 'interrupted' : 'completed'
      this.db.prepare("UPDATE session_turns SET state = ?, stop_reason = ?, finished_at = ? WHERE generation_id = ? AND owner_id = ? AND turn_key = ? AND state = 'running'")
        .run(state, reason, this.now(), generation.id, observation.ownerId, observation.turnKey)
      this.db.prepare(`UPDATE session_generations SET state = CASE WHEN EXISTS
        (SELECT 1 FROM session_turns WHERE generation_id = ? AND state = 'running') THEN 'running' ELSE 'open' END,
        updated_at = ? WHERE id = ?`).run(generation.id, this.now(), generation.id)
    } else if (observation.eventType === 'summary_saved') {
      this.db.prepare(`INSERT OR IGNORE INTO session_summaries
        (id, generation_id, owner_id, idempotency_key, last_folded_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), generation.id, observation.ownerId, observation.idempotencyKey,
          typeof payload.lastFoldedId === 'string' ? payload.lastFoldedId : null, String(payload.content ?? ''), this.now())
    } else if (observation.eventType === 'owner_closed') {
      this.db.prepare("UPDATE session_generations SET state = 'closed', updated_at = ? WHERE id = ?").run(this.now(), generation.id)
    }
  }

  /** Interrupted turns retain their input and every observed tool/output
   * event. Only their audit state changes; no work is replayed or discarded. */
  reconcileInterrupted(processRunId: string): string[] {
    return this.db.transaction(() => {
      const turns = this.db.prepare(`SELECT t.id, t.owner_id, t.turn_key, t.generation_id FROM session_turns t
        JOIN session_generations g ON g.id = t.generation_id WHERE t.state = 'running' AND g.process_run_id != ?`)
        .all(processRunId) as Array<{ id: string; owner_id: string; turn_key: string; generation_id: string }>
      for (const turn of turns) {
        this.db.prepare("UPDATE session_turns SET state = 'interrupted', stop_reason = 'crash_unconfirmed', finished_at = ? WHERE id = ?")
          .run(this.now(), turn.id)
        this.db.prepare(`INSERT OR IGNORE INTO session_lifecycle_events
          (idempotency_key, generation_id, owner_id, turn_key, event_type, payload, created_at)
          VALUES (?, ?, ?, ?, 'crash_reconciled', ?, ?)`)
          .run(`crash:${turn.id}`, turn.generation_id, turn.owner_id, turn.turn_key,
            JSON.stringify({ result: 'interrupted_preserved', replay: false }), this.now())
      }
      this.db.prepare("UPDATE session_generations SET state = CASE WHEN state = 'running' THEN 'interrupted' ELSE 'closed' END, updated_at = ? WHERE process_run_id != ? AND state IN ('running', 'open')")
        .run(this.now(), processRunId)
      return turns.map(({ turn_key }) => turn_key)
    })()
  }
}
