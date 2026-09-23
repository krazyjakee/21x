import type Database from 'better-sqlite3'
import { EventInbox, type InboxBatch, type PushResult, type SessionEvent } from './event-inbox'
import { ownerKey, SessionLedger, type GenerationRecord, type RecoveryReport, type SessionOwner } from './ledger'

/**
 * The managed session (managed sessions B3, #99): one owner (a Commander
 * session, a Captain, a task agent), its event inbox, and a lock that lets
 * exactly one of its turns run at a time. See docs/managed-sessions.md.
 *
 * B3 provides the core and records only (flag `sessions.ledger`): the
 * Commander and AgentManager still run their own turns and report them
 * through SessionLedgerRecorder. B4 (ChatEngine) and B5 (AdapterEngine) give
 * ManagedSession a `run` and route their triggers through `deliver`.
 */

/**
 * A mutex per owner. `run` waits for the owner's earlier holders, in call
 * order, then runs `fn`; a failing holder releases the lock like any other.
 * Different owners never wait for each other.
 */
export class OwnerLocks {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly holders = new Set<string>()

  async run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>((resolve) => { release = resolve })
    const tail = prior.then(() => mine)
    this.tails.set(key, tail)
    await prior
    this.holders.add(key)
    try {
      return await fn()
    } finally {
      this.holders.delete(key)
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }

  /** Whether a holder is running for the owner right now. */
  isHeld(key: string): boolean {
    return this.holders.has(key)
  }

  /** Whether anyone holds or waits for the owner's lock. */
  isBusy(key: string): boolean {
    return this.tails.has(key)
  }
}

/** What the engine gives a turn to record its progress. Every method is safe without a ledger. */
export interface TurnContext {
  /** The ledger turn, or null when nothing is recorded. */
  turnId: string | null
  toolCallStarted(call: { id: string; name: string }): void
  toolCallFinished(call: { id: string; name?: string; isError?: boolean }): void
  /** Links a `session_usage` row (by `turn_key`) to the turn. */
  usage(usageTurnKey: string): void
}

export interface TurnOutcome {
  status: 'done' | 'failed'
  stopReason?: string | null
  errorKind?: string | null
  errorDetail?: string | null
}

/** Runs one batch of events as one turn. Engine-specific (B4/B5). */
export type TurnRunner = (batch: InboxBatch, context: TurnContext) => Promise<TurnOutcome>

export interface ManagedSessionDeps {
  inbox: EventInbox
  locks: OwnerLocks
  /** The ledger to record in, or null when the flag is off. */
  ledger: () => SessionLedger | null
  run: TurnRunner
}

export interface DeliverResult {
  /** `duplicate`: the event was already delivered; nothing happens. */
  status: PushResult['status']
  /** Settles when the owner's queue, including this event, has drained. */
  done: Promise<void>
}

export interface ManagedSessionState {
  owner: SessionOwner
  /** A turn is running. */
  busy: boolean
  /** Batches waiting behind it. */
  queued: number
  generation: GenerationRecord | null
}

function noteFailure(what: string, err: unknown): void {
  console.warn(`[ManagedSession] ${what}:`, err instanceof Error ? err.message : err)
}

export class ManagedSession {
  private readonly key: string

  constructor(readonly owner: SessionOwner, private readonly deps: ManagedSessionDeps) {
    this.key = ownerKey(owner)
  }

  /**
   * Accepts an event for the owner and runs it in turn. A repeated
   * `dedupeKey` is a no-op (`duplicate`), before and after a restart.
   */
  deliver(event: Omit<SessionEvent, 'owner'>): DeliverResult {
    const pushed = this.deps.inbox.push({ ...event, owner: this.owner })
    if (pushed.status === 'duplicate') return { status: 'duplicate', done: this.idle() }
    return { status: pushed.status, done: this.drain() }
  }

  /**
   * Runs every waiting batch, one at a time under the owner's lock. Each call
   * queues one holder, so an event pushed before the call has run (by this
   * holder or an earlier one) when the returned promise settles.
   */
  drain(): Promise<void> {
    return this.deps.locks.run(this.key, async () => {
      for (let batch = this.deps.inbox.take(this.owner); batch; batch = this.deps.inbox.take(this.owner)) {
        await this.runBatch(batch)
      }
    })
  }

  /** Settles once every turn delivered before the call has run. */
  idle(): Promise<void> {
    return this.deps.locks.run(this.key, () => undefined)
  }

  state(): ManagedSessionState {
    let generation: GenerationRecord | null = null
    try {
      generation = this.deps.ledger()?.currentGeneration(this.owner) ?? null
    } catch (err) {
      noteFailure('could not read the generation', err)
    }
    return { owner: this.owner, busy: this.deps.locks.isHeld(this.key), queued: this.deps.inbox.size(this.owner), generation }
  }

  private async runBatch(batch: InboxBatch): Promise<void> {
    const ledger = this.deps.ledger()
    let turnId: string | null = null
    if (ledger && batch.turnId) {
      try {
        const started = ledger.startTurn(batch.turnId)
        // Dropped (or recovered) meanwhile: the event does not run.
        if (!started) return
        turnId = started.id
      } catch (err) {
        noteFailure('could not record the turn start', err)
      }
    }
    const record = (fn: (l: SessionLedger, id: string) => void, what: string): void => {
      if (!ledger || !turnId) return
      try {
        fn(ledger, turnId)
      } catch (err) {
        noteFailure(`could not record ${what}`, err)
      }
    }
    const context: TurnContext = {
      turnId,
      toolCallStarted: (call) => record((l, id) => l.toolCallStarted(id, call), 'a tool call'),
      toolCallFinished: (call) => record((l, id) => l.toolCallFinished(id, call), 'a tool result'),
      usage: (key) => record((l, id) => l.attachUsage(id, key), 'turn usage')
    }
    let outcome: TurnOutcome
    try {
      outcome = await this.deps.run(batch, context)
    } catch (err) {
      outcome = { status: 'failed', errorKind: 'exception', errorDetail: err instanceof Error ? err.message : String(err) }
    }
    record((l, id) => l.finishTurn(id, outcome), 'the turn end')
  }
}

/**
 * Startup crash recovery (#99): marks the turns a previous process left
 * unfinished as `interrupted` and closes their open tool calls. Runs whatever
 * the flag says, so turns recorded before it was switched off are still
 * closed. Never throws: a failure is logged and startup continues.
 */
export function recoverSessionLedger(source: { db: Database.Database }): RecoveryReport | null {
  try {
    return new SessionLedger(source).recoverInterrupted()
  } catch (err) {
    noteFailure('startup recovery failed', err)
    return null
  }
}

