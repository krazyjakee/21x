import { randomUUID } from 'crypto'
import { ACTIVITY_REVALIDATE_MS, type AgentStatusActivityMeta } from '../../shared/activity'

/**
 * Observation metadata for `agent:status` (GitHub #95).
 *
 * Status pushes are transition-only, so an agent that works quietly for a
 * minute looks exactly like one whose process died. This stamps every push
 * with an epoch and a sequence number, and decides when a successful adapter
 * poll may publish a heartbeat: an unchanged status that proves the backend
 * answered just now. Heartbeats are rate-limited per session and are sent
 * separately from `emitStatus`, so they never trigger its transition side
 * effects (Captain wakes, queue drains, notifications).
 */
export class ActivityObservations {
  /** One main-process lifetime. The renderer resets its sequence check when it changes. */
  readonly epoch: string
  private seq = 0
  private readonly lastHeartbeatAt = new Map<string, number>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly minIntervalMs: number = ACTIVITY_REVALIDATE_MS,
    epoch: string = randomUUID()
  ) {
    this.epoch = epoch
  }

  /** Metadata for the next push. Every call advances the sequence. */
  stamp(heartbeat = false): AgentStatusActivityMeta {
    this.seq += 1
    return heartbeat ? { epoch: this.epoch, seq: this.seq, heartbeat: true } : { epoch: this.epoch, seq: this.seq }
  }

  /**
   * True when a successful poll of this session may publish a heartbeat now.
   * Records the publication, so callers must send when this returns true.
   */
  takeHeartbeat(sessionId: string): boolean {
    const now = this.now()
    const last = this.lastHeartbeatAt.get(sessionId)
    if (last !== undefined && now - last < this.minIntervalMs) return false
    this.lastHeartbeatAt.set(sessionId, now)
    return true
  }

  /** Drops the rate-limit entry of a session that stopped polling. */
  forget(sessionId: string): void {
    this.lastHeartbeatAt.delete(sessionId)
  }

  /** Test/diagnostic: number of sessions with a heartbeat entry. */
  get trackedSessions(): number {
    return this.lastHeartbeatAt.size
  }
}

/** Only sessions doing something, or waiting on the user, publish heartbeats. */
export function shouldPublishHeartbeat(status: string): boolean {
  return status === 'working' || status === 'waiting_approval'
}
