import { powerSaveBlocker } from 'electron'
import type { AgentSession, SessionHost } from './types'
import { isDelegationTool } from './watchdogs'

type LifetimeHost = Pick<SessionHost,
  'db' | 'sessions' | 'sessionConfigFor' | 'hasActiveSubtaskWork' | 'stopSession' | 'scheduleStartQueueDrain'>

// Going idle never terminates a session: idle is only a state flag. This
// low-frequency sweep releases the in-memory runtime of sessions idle for a
// long time. The conversation lives with the backend and the persisted
// task.session_id lets sendMessage resume it on demand, so nothing is lost.
const IDLE_SESSION_REAP_THRESHOLD_MS = 30 * 60 * 1000
const IDLE_REAP_SWEEP_INTERVAL_MS = 5 * 60 * 1000

/**
 * How long session runtimes stay in memory: the idle-session reaper, and the
 * app-suspension blocker held while any runtime is alive.
 */
export class RuntimeLifetime {
  private reaperTimer: ReturnType<typeof setInterval> | null = null
  private powerSaveBlockerId: number | null = null

  constructor(private readonly host: LifetimeHost) {}

  startReaper(): void {
    if (this.reaperTimer) return
    this.reaperTimer = setInterval(() => {
      this.reap().catch((err) => console.error('[AgentManager] Idle-session reaper sweep failed:', err))
    }, IDLE_REAP_SWEEP_INTERVAL_MS)
    this.reaperTimer.unref?.()
  }

  stopReaper(): void {
    if (this.reaperTimer) clearInterval(this.reaperTimer)
    this.reaperTimer = null
  }

  /**
   * Releases long-idle runtimes. Never touches a session with an active turn
   * or coordinators whose children still work, and never resets task status.
   */
  async reap(): Promise<void> {
    // Safety net for limits raised in settings or the agent form: nothing
    // else signals those, so the queue is re-checked on every sweep.
    this.host.scheduleStartQueueDrain()
    const now = Date.now()
    for (const [sessionId, session] of [...this.host.sessions.entries()]) {
      if (session.status !== 'idle') continue
      const idleForMs = now - (session.lastActivityAt ?? session.createdAt.getTime())
      if (idleForMs < IDLE_SESSION_REAP_THRESHOLD_MS) continue

      const task = this.host.db.getTask(session.taskId)
      // Pseudo-tasks (heartbeat-*) have no row and are left alone. Without a
      // persisted resume anchor, releasing the runtime would lose the conversation.
      if (!task?.session_id) continue
      // A coordinator with running children is woken by their completion;
      // tearing it down mid-orchestration churns resume cycles for nothing.
      if (this.host.hasActiveSubtaskWork(session.taskId)) continue
      // In-process background subagents (Claude Code Task tool) have no
      // subtask row, and destroying the session would kill them outright.
      if (await this.hasActiveDelegationTools(sessionId, session)) continue

      console.log(
        `[AgentManager] Releasing runtime of idle session ${sessionId} (task ${session.taskId}, idle ${Math.round(idleForMs / 1000)}s). ` +
        `Resumable on demand from persisted session_id.`
      )
      try {
        // A resource release, not a user stop: the task status stays.
        await this.host.stopSession(sessionId, false)
      } catch (err) {
        console.error(`[AgentManager] Failed to release idle session ${sessionId}:`, err)
      }
    }
  }

  private async hasActiveDelegationTools(sessionId: string, session: AgentSession): Promise<boolean> {
    if (!session.adapter?.getRunningTools) return false
    try {
      const tools = await session.adapter.getRunningTools(sessionId, this.host.sessionConfigFor(session))
      return tools.some((t) => isDelegationTool(t.toolName))
    } catch {
      return false
    }
  }

  /**
   * Updates the blocker once the current change to the sessions map settled.
   * Without it, macOS App Nap (and Windows efficiency mode) can suspend the
   * whole process tree while the window is hidden, pausing agent CLIs mid-run,
   * including background subagents that keep working after a turn goes idle.
   * So it is held while ANY runtime is alive, not only non-idle ones. It does
   * not keep the display awake or prevent sleep.
   */
  scheduleBlockerUpdate(): void {
    setImmediate(() => this.updateBlocker())
  }

  private updateBlocker(): void {
    // Unavailable under ELECTRON_RUN_AS_NODE (tests).
    if (typeof powerSaveBlocker?.start !== 'function') return
    try {
      const hasLiveRuntime = this.host.sessions.size > 0
      if (hasLiveRuntime && this.powerSaveBlockerId === null) {
        this.powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
        console.log('[AgentManager] App-suspension blocker started (agent session runtime alive)')
      } else if (!hasLiveRuntime && this.powerSaveBlockerId !== null) {
        powerSaveBlocker.stop(this.powerSaveBlockerId)
        this.powerSaveBlockerId = null
        console.log('[AgentManager] App-suspension blocker stopped (no live session runtimes)')
      }
    } catch (err) {
      console.error('[AgentManager] Failed to update app-suspension blocker:', err)
    }
  }
}
