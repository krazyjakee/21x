import type { BrowserWindow } from 'electron'
import type { DatabaseManager } from '../database'
import type { CodingAgentAdapter } from '../adapters/coding-agent-adapter'
import { guardedIpcSend } from '../guarded-ipc-send'
import { transcriptDisplayPart } from '../transcript-display'
import { emitArtifactUpdatesFromParts, transcriptPartsFromEvent, transcriptPartsFromMessages } from './transcript-events'

type TranscriptParts = ReturnType<DatabaseManager['getTranscriptParts']>

const TRANSCRIPT_CHANGED_FLUSH_MS = 125

/**
 * The durable transcript projection and delivery to clients (the main window
 * and external listeners such as the mobile WebSocket). Live output is written
 * through and pushed as coalesced `transcript:changed` deltas; clients hydrate
 * from snapshots instead of depending on having seen every event, so output
 * produced while no view is bound is never lost.
 */
export class TranscriptProjection {
  private externalListeners: Array<(channel: string, data: unknown) => void> = []
  private pendingChanged = new Map<string, { sinceRev: number; maxRev: number }>()
  private changedTimer: ReturnType<typeof setTimeout> | null = null
  private backfillInFlight = new Set<string>()
  /** Tasks whose persisted history was already considered for backfill this app run. */
  private ingestedTasks = new Set<string>()

  constructor(
    private readonly db: DatabaseManager,
    private readonly getAdapter: (agentId: string) => CodingAgentAdapter | null,
    private readonly getWindow: () => BrowserWindow | null
  ) {}

  addExternalListener(fn: (channel: string, data: unknown) => void): void {
    this.externalListeners.push(fn)
  }

  /** Sends to the main window and to external listeners. */
  broadcast(channel: string, payload: unknown): void {
    const window = this.getWindow()
    if (window && !window.isDestroyed()) guardedIpcSend(window.webContents, channel, payload)
    this.notifyExternal(channel, payload)
  }

  private notifyExternal(channel: string, payload: unknown): void {
    for (const fn of this.externalListeners) {
      try { fn(channel, payload) } catch { /* one failing listener must not block the rest */ }
    }
  }

  /**
   * Snapshot of a task's projection. The first read per app run seeds an EMPTY
   * projection from the task's persisted session history; a task that already
   * has parts is returned as-is.
   */
  async snapshot(taskId: string, sinceSeq?: number): Promise<TranscriptParts> {
    await this.backfill(taskId)
    return this.db.getTranscriptParts(taskId, sinceSeq)
  }

  /** Parts changed since `sinceRev`, plus the current maxRev. */
  async delta(taskId: string, sinceRev: number): Promise<ReturnType<DatabaseManager['getTranscriptDelta']>> {
    await this.backfill(taskId)
    return this.db.getTranscriptDelta(taskId, sinceRev)
  }

  /**
   * Writes the parts of an `agent:output` / `agent:output-batch` event.
   * Upserts are keyed by stable part id, so re-emitting a part is a no-op.
   */
  persist(channel: string, data: unknown): void {
    const event = transcriptPartsFromEvent(channel, data)
    if (!event || event.parts.length === 0) return
    const result = this.db.upsertTranscriptParts(event.taskId, event.parts)
    if (!result || result.changedPartIds.length === 0) return
    this.queueChanged(event.taskId, result.maxRev - result.changedPartIds.length, result.maxRev)
  }

  /**
   * One-time seed for sessions that predate the store. Only EMPTY projections
   * are seeded: persisted-history part ids differ from live-captured ids, so
   * ingesting into a populated projection would duplicate messages, and every
   * upsert is pushed to all clients. A reader connecting must never mutate it.
   */
  private async backfill(taskId: string): Promise<void> {
    if (this.backfillInFlight.has(taskId) || this.ingestedTasks.has(taskId)) return
    if (this.db.hasTranscriptParts(taskId)) {
      this.ingestedTasks.add(taskId)
      return
    }

    const task = this.db.getTask(taskId)
    const sessionId = task?.session_id
    const agentId = task?.agent_id
    if (!sessionId || !agentId) return

    const adapter = this.getAdapter(agentId)
    if (!adapter?.getPersistedMessages) return

    this.backfillInFlight.add(taskId)
    try {
      const workspaceDir = this.db.getWorkspaceDir(taskId)
      const messages = await adapter.getPersistedMessages(sessionId, { agentId, taskId, workspaceDir })
      const parts = transcriptPartsFromMessages(messages)
      if (parts.length > 0) {
        this.db.upsertTranscriptParts(taskId, parts)
        console.log(`[AgentManager] Backfilled ${parts.length} transcript part(s) into the projection for task ${taskId}`)
      }
    } catch (err) {
      console.error(`[AgentManager] Transcript projection backfill failed for task ${taskId}:`, err)
    } finally {
      this.backfillInFlight.delete(taskId)
      // Don't repeat the full history read this app run; write-through keeps it current.
      this.ingestedTasks.add(taskId)
    }
  }

  /** Coalesces deltas per task behind one trailing read. */
  private queueChanged(taskId: string, sinceRev: number, maxRev: number): void {
    const pending = this.pendingChanged.get(taskId)
    this.pendingChanged.set(taskId, {
      sinceRev: pending ? Math.min(pending.sinceRev, sinceRev) : sinceRev,
      maxRev: pending ? Math.max(pending.maxRev, maxRev) : maxRev
    })
    if (this.changedTimer) return
    this.changedTimer = setTimeout(() => {
      this.changedTimer = null
      this.flushChanged()
    }, TRANSCRIPT_CHANGED_FLUSH_MS)
  }

  private flushChanged(): void {
    const pending = this.pendingChanged
    this.pendingChanged = new Map()
    for (const [taskId, { sinceRev, maxRev: queuedMaxRev }] of pending) {
      const { parts, maxRev } = this.db.getTranscriptDelta(taskId, sinceRev)
      const effectiveMaxRev = Math.max(maxRev, queuedMaxRev)
      if (parts.length === 0 && effectiveMaxRev <= sinceRev) continue
      this.sendChanged(taskId, parts, effectiveMaxRev)
    }
  }

  private sendChanged(taskId: string, parts: TranscriptParts, maxRev: number): void {
    const payload = { taskId, parts, maxRev }
    const window = this.getWindow()
    if (window && !window.isDestroyed()) {
      // The window gets display previews of oversized records (stored data is
      // unchanged); external listeners keep the full payload.
      let sent = false
      try {
        sent = guardedIpcSend(window.webContents, 'transcript:changed', {
          ...payload, parts: parts.map(part => transcriptDisplayPart(part))
        })
      } catch (err) {
        console.error('[AgentManager] Could not prepare transcript update for display:', err)
      }
      if (!sent) {
        // Keep the client cursor unchanged; the renderer reconciles via a delta read.
        guardedIpcSend(window.webContents, 'transcript:changed', {
          taskId, parts: [], maxRev: 0, reloadRequired: true
        })
      }
    }
    this.notifyExternal('transcript:changed', payload)
    emitArtifactUpdatesFromParts(this.db, taskId, parts, (artifact) => {
      this.broadcast('artifact:updated', { taskId: artifact.taskId, artifact })
    })
  }
}
