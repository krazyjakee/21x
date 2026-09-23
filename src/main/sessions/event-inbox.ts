import { ownerKey, type GenerationInfo, type SessionLedger, type SessionOwner, type TurnTrigger } from './ledger'

/**
 * The per-owner event queue of a managed session (managed sessions B3, #99).
 * B4 moves the Commander's `pendingRelay` onto it and B5 the Captain waker's
 * deferred batch; see docs/managed-sessions.md.
 *
 * - **Dedupe.** An event is accepted once per owner and `dedupeKey`. With a
 *   ledger, the key is checked against `session_turns` (so a repeat after a
 *   restart is still a no-op) and the accepted event is recorded `queued`.
 *   Without one, a bounded in-memory window of recent keys is used.
 * - **Coalescing.** A `coalesce` event whose kind matches the newest waiting
 *   batch of the owner joins that batch instead of queueing another turn;
 *   the ledger records it `coalesced` into the batch's turn.
 * - **Order.** Batches leave in arrival order, one at a time (`take`).
 */

export type SessionEventKind = Exclude<TurnTrigger, 'start' | 'system'> | 'system'

export interface SessionEvent {
  owner: SessionOwner
  kind: SessionEventKind
  /** Unique per owner: the same key is the same event. */
  dedupeKey: string
  /** The text the turn is given, already fenced by the role. */
  payload: string
  /** What a busy session does with it. Recorded for the engines (B4/B5); the inbox itself only queues. */
  interrupt?: 'never' | 'queue' | 'bargeIn'
  /** May join the newest waiting batch of the same kind. */
  coalesce?: boolean
}

export interface InboxBatch {
  owner: SessionOwner
  kind: SessionEventKind
  /** The first event's key; the ledger turn carries it. */
  dedupeKey: string
  events: SessionEvent[]
  /** The events' payloads, oldest first, separated by a blank line. */
  payload: string
  /** The ledger turn (`queued`) the batch runs as, when a ledger is attached. */
  turnId: string | null
}

export type PushResult =
  | { status: 'queued'; batch: InboxBatch }
  | { status: 'coalesced'; batch: InboxBatch }
  | { status: 'duplicate' }

export interface EventInboxOptions {
  /** Records every accepted event; null records nothing (the flag is off). */
  ledger?: () => SessionLedger | null
  /** How the owner's generation is described when the ledger opens one. */
  generation?: (owner: SessionOwner) => GenerationInfo
  /** In-memory dedupe window per owner when there is no ledger. */
  recentKeys?: number
}

const DEFAULT_RECENT_KEYS = 500

export class EventInbox {
  private readonly queues = new Map<string, InboxBatch[]>()
  private readonly recent = new Map<string, Set<string>>()

  constructor(private readonly options: EventInboxOptions = {}) {}

  private ledger(): SessionLedger | null {
    return this.options.ledger?.() ?? null
  }

  private generationFor(owner: SessionOwner): GenerationInfo {
    return this.options.generation?.(owner) ?? { engine: owner.kind === 'commander' ? 'chat' : 'adapter' }
  }

  private seen(owner: SessionOwner, key: string): boolean {
    return this.recent.get(ownerKey(owner))?.has(key) ?? false
  }

  private remember(owner: SessionOwner, key: string): void {
    const k = ownerKey(owner)
    let keys = this.recent.get(k)
    if (!keys) {
      keys = new Set()
      this.recent.set(k, keys)
    }
    keys.add(key)
    const max = this.options.recentKeys ?? DEFAULT_RECENT_KEYS
    while (keys.size > max) {
      const oldest = keys.values().next().value
      if (oldest === undefined) break
      keys.delete(oldest)
    }
  }

  /** Accepts an event once. A repeated key changes nothing and returns `duplicate`. */
  push(event: SessionEvent): PushResult {
    if (!event.dedupeKey) throw new Error('A session event needs a dedupe key')
    if (this.seen(event.owner, event.dedupeKey)) return { status: 'duplicate' }
    const ledger = this.ledger()
    const generation = this.generationFor(event.owner)
    if (ledger?.getTurnByKey(event.owner, event.dedupeKey)) {
      this.remember(event.owner, event.dedupeKey)
      return { status: 'duplicate' }
    }

    const key = ownerKey(event.owner)
    const queue = this.queues.get(key) ?? []
    const tail = queue[queue.length - 1]
    if (event.coalesce && tail && tail.kind === event.kind && tail.events.every((e) => e.coalesce)) {
      if (ledger && tail.turnId) {
        ledger.recordCoalesced(event.owner, { dedupeKey: event.dedupeKey, trigger: event.kind, generation, into: tail.turnId })
      }
      tail.events.push(event)
      tail.payload = `${tail.payload}\n\n${event.payload}`
      this.remember(event.owner, event.dedupeKey)
      return { status: 'coalesced', batch: tail }
    }

    const recorded = ledger?.enqueueTurn(event.owner, { dedupeKey: event.dedupeKey, trigger: event.kind, generation })
    const batch: InboxBatch = {
      owner: event.owner,
      kind: event.kind,
      dedupeKey: event.dedupeKey,
      events: [event],
      payload: event.payload,
      turnId: recorded?.turn.id ?? null
    }
    queue.push(batch)
    this.queues.set(key, queue)
    this.remember(event.owner, event.dedupeKey)
    return { status: 'queued', batch }
  }

  /** The owner's next batch, removed from the queue; null when it is empty. */
  take(owner: SessionOwner): InboxBatch | null {
    const key = ownerKey(owner)
    const queue = this.queues.get(key)
    const batch = queue?.shift() ?? null
    if (queue && queue.length === 0) this.queues.delete(key)
    return batch
  }

  /** The owner's waiting batches, oldest first (a copy). */
  pending(owner: SessionOwner): InboxBatch[] {
    return [...(this.queues.get(ownerKey(owner)) ?? [])]
  }

  size(owner: SessionOwner): number {
    return this.queues.get(ownerKey(owner))?.length ?? 0
  }

  /**
   * Removes the owner's waiting batches that match, recording each as
   * `dropped` with the reason (a stale wake-up is recorded, never lost
   * silently). Returns the dropped batches.
   */
  drop(owner: SessionOwner, reason: string, match: (batch: InboxBatch) => boolean = () => true): InboxBatch[] {
    const key = ownerKey(owner)
    const queue = this.queues.get(key)
    if (!queue) return []
    const dropped = queue.filter(match)
    const kept = queue.filter((b) => !match(b))
    if (kept.length > 0) this.queues.set(key, kept)
    else this.queues.delete(key)
    const ledger = this.ledger()
    for (const batch of dropped) {
      if (ledger && batch.turnId) ledger.dropQueued(batch.turnId, reason)
    }
    return dropped
  }
}
