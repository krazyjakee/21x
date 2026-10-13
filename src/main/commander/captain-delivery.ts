import { createHash, randomUUID } from 'crypto'
import type { AgentManager } from '../agent-manager'
import type { DatabaseManager } from '../database'
import { DeliveryStore, type DeliveryRecord } from '../sessions/delivery-store'

const CLAIM_MS = 60_000
export const CAPTAIN_REPORT_DEADLINE_MS = 15 * 60_000

export interface CaptainRequestInput {
  idempotencyKey: string
  sourceSessionId: string
  projectId: string
  taskId: string
  agentId: string
  payload: string
}

export interface CaptainDeliveryOptions {
  db: DatabaseManager
  agents: Pick<AgentManager, 'sendMessage'>
  onTerminalFailure: (record: DeliveryRecord, detail: string, timedOut: boolean) => void
  now?: () => number
}

export function correlationForDeliveryKey(key: string): string {
  return `cmd-${createHash('sha256').update(key).digest('hex')}`
}

export class CaptainDeliveryService {
  readonly store: DeliveryStore
  private readonly owner = `captain-delivery:${process.pid}:${randomUUID()}`
  private readonly now: () => number
  private readonly inFlight = new Map<string, Promise<void>>()
  private closing = false
  private recovery: Promise<void> | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: CaptainDeliveryOptions) {
    this.now = options.now ?? Date.now
    this.store = new DeliveryStore(options.db, this.now)
  }

  enqueueRequest(input: CaptainRequestInput): DeliveryRecord {
    if (this.closing) throw new Error('CAPTAIN_DELIVERY_CLOSED')
    const correlationId = correlationForDeliveryKey(input.idempotencyKey)
    const record = this.options.db.db.transaction(() => {
      const { record } = this.store.enqueue({
        idempotencyKey: input.idempotencyKey,
        kind: 'captain_request',
        sourceSessionId: input.sourceSessionId,
        projectId: input.projectId,
        taskId: input.taskId,
        agentId: input.agentId,
        correlationId,
        payload: input.payload,
        deadlineAt: this.now() + CAPTAIN_REPORT_DEADLINE_MS
      })
      return record
    })()
    if (record.state === 'pending' || (record.state === 'claimed' && (record.claimExpiresAt ?? 0) <= this.now())) {
      void this.dispatch(record).catch((error) => console.error('[CaptainDelivery] Dispatch failed:', error))
    }
    return record
  }

  dispatch(record: DeliveryRecord): Promise<void> {
    if (this.closing) return Promise.reject(new Error('CAPTAIN_DELIVERY_CLOSED'))
    const existing = this.inFlight.get(record.id)
    if (existing) return existing
    const work = Promise.resolve().then(() => this.dispatchNow(record)).finally(() => this.inFlight.delete(record.id))
    this.inFlight.set(record.id, work)
    return work
  }

  private async dispatchNow(record: DeliveryRecord): Promise<void> {
    if (this.closing) return
    if (record.state === 'accepted' || record.state === 'acknowledged') return
    const claimed = this.store.claim(record.id, this.owner, CLAIM_MS)
    if (!claimed) return
    try {
      const result = await this.options.agents.sendMessage(
        '',
        claimed.payload,
        claimed.taskId ?? undefined,
        claimed.agentId ?? undefined,
        undefined,
        `captain-request-message:${claimed.id}`
      )
      this.store.accept(claimed.id, this.owner, result.newSessionId ?? claimed.taskId ?? claimed.id)
      // Deliberately remains accepted: the correlated report is the terminal
      // acknowledgement. The deadline sweep makes silence visible.
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const failed = this.store.terminal(claimed.id, 'failed', detail)
      if (failed?.state === 'failed') {
        const message = this.store.getByKey(`captain-request-message:${claimed.id}`)
        if (message?.state === 'pending') this.store.terminal(message.id, 'cancelled', 'The originating Captain request failed.')
        if (!this.closing) this.options.onTerminalFailure(failed, detail, false)
      }
    }
  }

  reconcile(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('CAPTAIN_DELIVERY_CLOSED'))
    if (this.recovery) return this.recovery
    const work = Promise.resolve().then(() => this.reconcileNow())
    this.recovery = work
    void work.finally(() => { if (this.recovery === work) this.recovery = null }).catch(() => {})
    return work
  }

  private async reconcileNow(): Promise<void> {
    if (this.closing) return
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => { void this.reconcile().catch((error) => console.error('[CaptainDelivery] Recovery failed:', error)) }, 30_000)
      this.sweepTimer.unref?.()
    }
    this.sweepDeadlines()
    const dispatches: Promise<void>[] = []
    for (const record of this.store.listRecoverable('captain_request')) {
      if (this.closing) break
      if (record.state !== 'accepted') dispatches.push(this.dispatch(record))
    }
    // Replaying is safe: the terminal callback uses a stable outbox/inbox key.
    for (const record of this.store.listTerminalRequests()) {
      if (this.closing) break
      this.options.onTerminalFailure(record, record.lastError ?? 'Captain request failed.', record.state === 'timed_out')
    }
    await Promise.all(dispatches)
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
  }

  shutdown(): void {
    this.closing = true
    this.dispose()
  }

  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) {
      throw new RangeError('Captain delivery shutdown deadline must be an integer from 1 to 3000 ms')
    }
    this.shutdown()
    const drain = Promise.allSettled([...this.inFlight.values(), ...(this.recovery ? [this.recovery] : [])])
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('CAPTAIN_DELIVERY_SHUTDOWN_INCOMPLETE')), timeoutMs)
    })
    try { await Promise.race([drain, expired]) }
    finally { if (timer) clearTimeout(timer) }
  }

  private sweepDeadlines(): void {
    // Terminal requests are replayed below with stable report keys, including
    // failures persisted by a process that died before publishing the report.
    // A request that expired while still queued must not reach the Captain later.
    for (const expired of this.store.expireDeadlines(this.now())) {
      if (expired.kind !== 'captain_request') continue
      const message = this.store.getByKey(`captain-request-message:${expired.id}`)
      if (message?.state === 'pending') this.store.terminal(message.id, 'cancelled', 'The originating Captain request timed out.')
    }
  }
}
