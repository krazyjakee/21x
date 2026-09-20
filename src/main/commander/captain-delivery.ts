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
  return `cmd-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
}

export class CaptainDeliveryService {
  readonly store: DeliveryStore
  private readonly owner = `captain-delivery:${process.pid}:${randomUUID()}`
  private readonly now: () => number
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: CaptainDeliveryOptions) {
    this.now = options.now ?? Date.now
    this.store = new DeliveryStore(options.db, this.now)
  }

  enqueueRequest(input: CaptainRequestInput): DeliveryRecord {
    const correlationId = correlationForDeliveryKey(input.idempotencyKey)
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
    if (record.state === 'pending' || (record.state === 'claimed' && (record.claimExpiresAt ?? 0) <= this.now())) {
      void this.dispatch(record)
    }
    return record
  }

  async dispatch(record: DeliveryRecord): Promise<void> {
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
        undefined,
        `captain-request-message:${claimed.id}`
      )
      this.store.accept(claimed.id, this.owner, result.newSessionId ?? claimed.taskId ?? claimed.id)
      // Deliberately remains accepted: the correlated report is the terminal
      // acknowledgement. The deadline sweep makes silence visible.
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const failed = this.store.terminal(claimed.id, 'failed', detail)
      if (failed) this.options.onTerminalFailure(failed, detail, false)
    }
  }

  async reconcile(): Promise<void> {
    for (const record of this.store.listRecoverable('captain_request')) {
      if (record.state !== 'accepted') await this.dispatch(record)
    }
    this.sweepDeadlines()
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweepDeadlines(), 30_000)
      this.sweepTimer.unref?.()
    }
  }

  private sweepDeadlines(): void {
    for (const record of this.store.expireDeadlines(this.now())) {
      if (record.kind === 'captain_request') {
        this.options.onTerminalFailure(record, record.lastError ?? 'The Captain did not report back before the deadline.', true)
      }
    }
  }
}
