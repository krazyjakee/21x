import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { EventInbox, type SessionObservation } from './event-inbox'
import { SessionLedger } from './ledger'
import { SESSION_PROCESS_RUN_ID } from './token-accounting'

const locksByDatabase = new WeakMap<Database.Database, Map<string, Promise<void>>>()

/** Shared by ChatRuntime and adapters' observational integrations. A lock is
 * scoped to the logical owner, independent of which engine emits an event. */
export async function withSessionOwnerLock<T>(db: Database.Database, ownerId: string, work: () => Promise<T> | T): Promise<T> {
  const locks = locksByDatabase.get(db) ?? new Map<string, Promise<void>>()
  locksByDatabase.set(db, locks)
  const previous = locks.get(ownerId)
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  locks.set(ownerId, current)
  try {
    if (previous) await previous
    return await work()
  } finally {
    release()
    if (locks.get(ownerId) === current) locks.delete(ownerId)
  }
}

export class ManagedSessionObserver {
  private closed = false
  private readonly ownedTurns = new Map<string, SessionObservation>()
  private readonly ownedObservations = new Map<string, SessionObservation>()
  private readonly claimOwner: string
  readonly inbox: EventInbox
  readonly ledger: SessionLedger
  constructor(private readonly db: Database.Database, private readonly processRunId: string = SESSION_PROCESS_RUN_ID) {
    this.claimOwner = `${processRunId}:${randomUUID()}`
    this.inbox = new EventInbox(db)
    this.ledger = new SessionLedger(db)
  }
  get enabled(): boolean {
    if (this.closed) return false
    const setting = this.db.prepare("SELECT value FROM settings WHERE key = 'sessions.ledger'").get() as { value: string } | undefined
    return ['1', 'true', 'observe'].includes(setting?.value?.trim().toLowerCase() ?? '')
  }
  observe(input: SessionObservation): Promise<void> {
    if (!this.enabled) return Promise.resolve()
    // Commit the inbox before yielding: a crash between reception and
    // projection leaves a durable pending observation for startup.
    const inserted = this.inbox.enqueue(input, this.processRunId)
    if (inserted) this.ownedObservations.set(input.idempotencyKey, input)
    const turnIdentity = JSON.stringify([input.ownerId, input.generationKey, input.turnKey])
    if (input.turnKey && input.eventType === 'turn_started' && inserted) this.ownedTurns.set(turnIdentity, input)
    if (input.turnKey && input.eventType === 'turn_done') this.ownedTurns.delete(turnIdentity)
    return withSessionOwnerLock(this.db, input.ownerId, () => {
      if (this.closed) return
      this.drainOwned(input.ownerId)
    })
  }
  async reconcileStartup(): Promise<string[]> {
    if (!this.enabled) return []
    this.inbox.recoverClaims(this.processRunId)
    for (const owner of this.inbox.pendingOwners()) {
      if (this.closed) return []
      await withSessionOwnerLock(this.db, owner, () => {
        if (!this.closed) this.inbox.drain(owner, this.claimOwner, (event) => this.ledger.apply(event, event.processRunId))
      })
    }
    if (this.closed) return []
    return this.ledger.reconcileInterrupted(this.processRunId)
  }

  shutdown(): void {
    if (this.closed) return
    try {
      // These projections are synchronous SQLite transactions, so no queued
      // lock callback can be inside one while shutdown owns this JS turn.
      // Drain every instance-owned observation, including queued non-turn
      // projections and terminal events that have already released a turn.
      // Sibling observers retain their exact keys and live turn ownership.
      for (const input of this.ownedTurns.values()) {
        const terminal = { ...input, eventType: 'turn_done',
          idempotencyKey: `${input.idempotencyKey}:shutdown:${this.claimOwner}`, payload: { stopReason: 'shutdown' } }
        if (this.inbox.enqueue(terminal, this.processRunId)) this.ownedObservations.set(terminal.idempotencyKey, terminal)
      }
      for (const ownerId of new Set([...this.ownedObservations.values()].map((event) => event.ownerId))) this.drainOwned(ownerId)
    } finally {
      this.closed = true
      this.ownedTurns.clear()
      this.ownedObservations.clear()
    }
  }

  private drainOwned(ownerId: string): void {
    const keys = [...this.ownedObservations.entries()].filter(([, event]) => event.ownerId === ownerId).map(([key]) => key)
    if (!keys.length) return
    this.inbox.drainOwned(ownerId, keys, this.claimOwner, (event) => this.ledger.apply(event, event.processRunId))
    for (const key of keys) this.ownedObservations.delete(key)
  }
}
