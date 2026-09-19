import { create } from 'zustand'
import { SessionStatus } from '@shared/constants'
import type { AgentMessage, TranscriptPartRecord } from '@shared/transcript/types'
import { applyPartsToProjection, createProjection, projectMessages, type TranscriptProjection } from '@shared/transcript/projection'
import { api } from '../api/client'
import { onEvent } from '../api/websocket'
import type { Agent, Skill } from '@/types'

export { SessionStatus }
export type { AgentMessage }

export interface TaskSession {
  sessionId: string | null
  agentId: string
  taskId: string
  status: SessionStatus
  /** Derived, read-only render list — a pure projection of the durable transcript. */
  messages: AgentMessage[]
  systemStatus?: string | null
  /**
   * True from the moment the user sends a message until the backend confirms the
   * turn is running (a non-idle status). Resuming an idle session is slow
   * (worktree + MCP + adapter.resumeSession) and even emits an interim `idle`
   * status, so we can't rely on status alone to show "starting". Cleared on the
   * first working/waiting/error status or a safety timeout.
   */
  pendingSend?: boolean
}

// ── Projection cache (SINGLE source of truth for the transcript) ──
// Same model as the desktop store: one write path, applyParts(), fed by a full
// snapshot on bind (REST) and idempotent `transcript:changed` deltas (WS).

const projections = new Map<string, TranscriptProjection>()
const bindingTasks = new Set<string>()

/** Test-only: reset the module-level projection cache between tests. */
export function __clearProjectionsForTest(): void {
  projections.clear()
  bindingTasks.clear()
}

function getProjection(taskId: string): TranscriptProjection {
  let p = projections.get(taskId)
  if (!p) { p = createProjection(); projections.set(taskId, p) }
  return p
}

function findBySessionId(sessions: Map<string, TaskSession>, sid: string): TaskSession | undefined {
  for (const s of sessions.values()) {
    if (s.sessionId === sid) return s
  }
  return undefined
}

// ── Store ─────────────────────────────────────────────────────

interface AgentState {
  agents: Agent[]
  skills: Skill[]
  sessions: Map<string, TaskSession>
  fetchAgents: () => Promise<void>
  fetchSkills: () => Promise<void>
  syncActiveSessions: () => Promise<void>
  /** Bind a task view to the durable transcript projection (load snapshot). */
  bindTranscript: (taskId: string) => Promise<void>
  initSession: (taskId: string, sessionId: string, agentId: string) => void
  /** Mark a task as "starting" after the user sends, until a turn is confirmed. */
  beginSend: (taskId: string) => void
  /** Clear the "starting" indicator (e.g. the send request failed). */
  endSend: (taskId: string) => void
  endSession: (taskId: string) => void
  removeSession: (taskId: string) => void
  getSession: (taskId: string) => TaskSession | undefined
}

export const useAgentStore = create<AgentState>((set, get) => {
  const commitMessages = (taskId: string): void => {
    const messages = projectMessages(getProjection(taskId))
    set((state) => {
      const existing = state.sessions.get(taskId)
      const session: TaskSession = existing
        ? { ...existing, messages }
        : { sessionId: null, agentId: '', taskId, status: SessionStatus.IDLE, messages }
      return { sessions: new Map(state.sessions).set(taskId, session) }
    })
  }

  const applyParts = (taskId: string, parts: TranscriptPartRecord[], maxRev?: number): void => {
    if (parts.length === 0 && maxRev == null) return
    applyPartsToProjection(getProjection(taskId), parts, maxRev)
    commitMessages(taskId)
  }

  const bindTranscript = async (taskId: string): Promise<void> => {
    if (!taskId || bindingTasks.has(taskId)) return
    bindingTasks.add(taskId)
    try {
      const snapshot = await api.transcript.snapshot(taskId)
      if (!Array.isArray(snapshot) || snapshot.length === 0) {
        // Keep the (empty) projection so live deltas reach the bound view.
        getProjection(taskId)
        return
      }
      const maxRev = snapshot.reduce((m, p) => Math.max(m, p.rev || 0), 0)
      projections.set(taskId, createProjection(snapshot, maxRev))
      commitMessages(taskId)
    } catch (e) {
      console.error(`[mobile] bindTranscript failed for ${taskId}:`, e)
    } finally {
      bindingTasks.delete(taskId)
    }
  }

  const reconcileDelta = async (taskId: string): Promise<void> => {
    try {
      const sinceRev = getProjection(taskId).rev
      const { parts, maxRev } = await api.transcript.delta(taskId, sinceRev)
      if (parts.length > 0) applyParts(taskId, parts, maxRev)
      else if (maxRev > sinceRev) getProjection(taskId).rev = maxRev
    } catch (e) {
      console.error(`[mobile] reconcileDelta failed for ${taskId}:`, e)
    }
  }

  // ── WebSocket event subscriptions ──

  // Transcript content: the ONLY writer of messages. Idempotent delta apply.
  onEvent('transcript:changed', (payload) => {
    const event = payload as { taskId?: string; parts?: TranscriptPartRecord[]; maxRev?: number }
    if (!event?.taskId) return
    // Only bound tasks or tasks with a known session have a consumer; others
    // load the authoritative snapshot when they gain one.
    if (projections.has(event.taskId) || get().sessions.has(event.taskId)) applyParts(event.taskId, event.parts || [], event.maxRev)
  })

  // Session state only (status / sessionId) — never messages.
  onEvent('agent:status', (payload) => {
    const event = payload as { sessionId: string; agentId: string; taskId: string; status: SessionStatus }
    const state = get()
    const session = findBySessionId(state.sessions, event.sessionId) || state.sessions.get(event.taskId)
    if (!session) {
      if (event.taskId && event.sessionId && event.status !== SessionStatus.IDLE) {
        set({
          sessions: new Map(state.sessions).set(event.taskId, {
            sessionId: event.sessionId,
            agentId: event.agentId || '',
            taskId: event.taskId,
            status: event.status,
            messages: projectMessages(getProjection(event.taskId))
          })
        })
        // Deltas that arrived before this session was known were skipped.
        void bindTranscript(event.taskId)
      } else if (event.taskId && event.status === SessionStatus.IDLE) {
        void bindTranscript(event.taskId)
      }
      return
    }
    const updated = { ...session, status: event.status }
    if (event.sessionId && session.sessionId !== event.sessionId) updated.sessionId = event.sessionId
    // The turn is confirmed running (or errored/awaiting input) — stop showing
    // "starting". Interim `idle` events during resume must NOT clear it.
    if (event.status !== SessionStatus.IDLE) updated.pendingSend = false
    set({ sessions: new Map(state.sessions).set(session.taskId, updated) })
    if (event.status === SessionStatus.IDLE) void reconcileDelta(session.taskId)
  })

  // Clear a stuck "starting" indicator if the backend never reports a turn.
  const clearPendingSend = (taskId: string): void => {
    set((state) => {
      const s = state.sessions.get(taskId)
      if (!s?.pendingSend) return state
      return { sessions: new Map(state.sessions).set(taskId, { ...s, pendingSend: false }) }
    })
  }

  return {
    agents: [],
    skills: [],
    sessions: new Map(),

    fetchAgents: async () => {
      try {
        const agents = (await api.agents.list()) as Agent[]
        set({ agents })
      } catch (e) {
        console.error('Failed to fetch agents:', e)
      }
    },

    fetchSkills: async () => {
      try {
        const skills = (await api.skills.list()) as Skill[]
        set({ skills })
      } catch (e) {
        console.error('Failed to fetch skills:', e)
      }
    },

    bindTranscript,

    /**
     * Reconnect / first-connect: register active sessions and bind each one's
     * transcript from the durable projection (no replay push needed). Idle tasks
     * are bound on demand when their view opens (bindTranscript in the page).
     */
    syncActiveSessions: async () => {
      try {
        const activeSessions = (await api.sessions.list()) as Array<{
          sessionId: string; agentId: string; taskId: string; status: string
        }>
        if (activeSessions.length === 0) return

        set((state) => {
          const nextSessions = new Map(state.sessions)
          for (const active of activeSessions) {
            const existing = state.sessions.get(active.taskId)
            nextSessions.set(active.taskId, {
              sessionId: active.sessionId,
              agentId: active.agentId,
              taskId: active.taskId,
              status: active.status as SessionStatus,
              messages: existing?.messages || projectMessages(getProjection(active.taskId))
            })
          }
          return { sessions: nextSessions }
        })

        await Promise.all(activeSessions.map((a) => bindTranscript(a.taskId)))
      } catch (e) {
        console.error('Failed to sync active sessions:', e)
      }
    },

    initSession: (taskId, sessionId, agentId) => {
      set((state) => {
        const existing = state.sessions.get(taskId)
        return {
          sessions: new Map(state.sessions).set(taskId, {
            sessionId,
            agentId,
            taskId,
            status: existing?.status || SessionStatus.WORKING,
            messages: existing?.messages || projectMessages(getProjection(taskId))
          })
        }
      })
    },

    beginSend: (taskId) => {
      set((state) => {
        const s = state.sessions.get(taskId)
        if (!s) return state
        return { sessions: new Map(state.sessions).set(taskId, { ...s, pendingSend: true }) }
      })
      // Safety net: never leave the composer stuck if no status ever arrives.
      setTimeout(() => clearPendingSend(taskId), 120_000)
    },

    endSend: (taskId) => clearPendingSend(taskId),

    endSession: (taskId) => {
      set((state) => {
        const session = state.sessions.get(taskId)
        if (!session) return state
        return {
          sessions: new Map(state.sessions).set(taskId, { ...session, sessionId: null, status: SessionStatus.IDLE })
        }
      })
    },

    removeSession: (taskId) => {
      projections.delete(taskId)
      set((state) => {
        const next = new Map(state.sessions)
        next.delete(taskId)
        return { sessions: next }
      })
    },

    getSession: (taskId) => get().sessions.get(taskId)
  }
})
