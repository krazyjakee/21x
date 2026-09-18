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
  private ticking = false

  constructor(private readonly options: BridgeSchedulerOptions) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? BRIDGE_SCHEDULER_TICK_MS)
    this.timer.unref?.()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
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
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = (this.options.now ?? Date.now)()
      const seen = new Set<string>()
      const runs: Promise<void>[] = []
      for (const source of this.options.db.getTaskSources()) {
        if (source.plugin_id !== CONNECTOR_BRIDGE_PLUGIN_ID || !source.enabled) continue
        const cfg = parseBridgeConfig(source.config ?? {})
        if (!cfg.instanceId || seen.has(cfg.instanceId)) continue
        seen.add(cfg.instanceId)
        if (this.options.isBusy(cfg.instanceId)) continue
        if (!this.isDue(cfg.instanceId, cfg.pollIntervalMinutes, now)) continue
        runs.push(
          this.options.runSource(source.id).catch((err) => {
            console.warn('[connector-bridge] Scheduled sync failed:', err instanceof Error ? err.message : err)
          })
        )
      }
      await Promise.all(runs)
    } finally {
      this.ticking = false
    }
  }
}
