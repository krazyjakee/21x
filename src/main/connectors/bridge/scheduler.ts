import type { DatabaseManager } from '../../database'
import type { ConnectorStore } from '../connector-store'
import { CONNECTOR_BRIDGE_PLUGIN_ID, parseBridgeConfig } from './engine'
import { nextPendingAt, readCursor } from './state'

/**
 * Interval polling and retry scheduling for connector-bridge task sources
 * (issue #13).
 *
 * A single timer ticks every `tickMs`. On each tick every enabled bridge
 * source whose instance is idle is checked against the state persisted in
 * connector_sync_state, so retries resume after a restart:
 *
 * - rate limited (Retry-After) -> wait
 * - a job retry is scheduled   -> run once it is due, not before
 * - a queued update is due     -> run
 * - otherwise                  -> run every `poll_interval_minutes` (0 = manual only)
 *
 * The engine's per-instance lock still guarantees one job at a time; manual
 * syncs go through SyncManager as for every other task source.
 */

export const BRIDGE_SCHEDULER_TICK_MS = 30_000

export class BridgeSchedulerShutdownIncompleteError extends Error {
  readonly code = 'BRIDGE_SCHEDULER_SHUTDOWN_INCOMPLETE'
  constructor() { super('Connector polling work has not finished'); this.name = 'BridgeSchedulerShutdownIncompleteError' }
}

export interface BridgeSchedulerOptions {
  db: Pick<DatabaseManager, 'getTaskSources'>
  store: ConnectorStore
  isBusy: (instanceId: string) => boolean
  /** Runs one scheduled sync for the source. */
  runSource: (sourceId: string) => Promise<void>
  tickMs?: number
  now?: () => number
}

export class BridgeScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private activeTick: Promise<void> | null = null
  private closing = false

  constructor(private readonly options: BridgeSchedulerOptions) {}

  start(): void {
    if (this.closing) throw new Error('Connector polling is shutting down')
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? BRIDGE_SCHEDULER_TICK_MS)
    this.timer.unref?.()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Stop scheduling and join the active pass, including all source callbacks. */
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) {
      throw new RangeError('Connector polling shutdown deadline must be an integer from 1 to 3000 ms')
    }
    this.closing = true
    this.stop()
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new BridgeSchedulerShutdownIncompleteError()), timeoutMs)
    })
    try { await Promise.race([Promise.allSettled(this.activeTick ? [this.activeTick] : []), expired]) }
    finally { if (timer) clearTimeout(timer) }
  }

  /** Whether the instance should run now. */
  isDue(instanceId: string, pollIntervalMinutes: number, now: number): boolean {
    const state = this.options.store.getSyncState(instanceId)
    const cursor = readCursor(state?.cursor)
    if (cursor.rateLimitedUntil && cursor.rateLimitedUntil > now) return false
    if (state?.nextRetryAt) return state.nextRetryAt <= now
    const pending = nextPendingAt(cursor)
    if (pending !== null && pending <= now) return true
    if (pollIntervalMinutes <= 0) return false
    return cursor.lastRunAt === undefined || now - cursor.lastRunAt >= pollIntervalMinutes * 60_000
  }

  /** One scheduling pass. Exposed for tests. */
  tick(): Promise<void> {
    if (this.closing) return Promise.resolve()
    if (this.activeTick) return this.activeTick
    // Install ownership before callbacks can reenter scheduling or shutdown.
    const work = Promise.resolve().then(() => this.closing ? undefined : this.runTick())
    this.activeTick = work
    void work.finally(() => { if (this.activeTick === work) this.activeTick = null }).catch(() => undefined)
    return work
  }

  private async runTick(): Promise<void> {
    const now = (this.options.now ?? Date.now)()
    const seen = new Set<string>()
    const runs: Promise<void>[] = []
    try {
      for (const source of this.options.db.getTaskSources()) {
        if (source.plugin_id !== CONNECTOR_BRIDGE_PLUGIN_ID || !source.enabled) continue
        const cfg = parseBridgeConfig(source.config ?? {})
        if (!cfg.instanceId || seen.has(cfg.instanceId)) continue
        seen.add(cfg.instanceId)
        if (this.options.isBusy(cfg.instanceId)) continue
        if (!this.isDue(cfg.instanceId, cfg.pollIntervalMinutes, now)) continue
        runs.push(
          Promise.resolve().then(() => this.options.runSource(source.id)).catch((err) => {
            console.warn('[connector-bridge] Scheduled sync failed:', err instanceof Error ? err.message : err)
          })
        )
      }
    } finally { await Promise.all(runs) }
  }
}
