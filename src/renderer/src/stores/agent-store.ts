import { create } from 'zustand'
import type { Agent, CreateAgentDTO, UpdateAgentDTO } from '@/types'
import { agentApi, agentSessionApi, onAgentStatus, onTranscriptChanged } from '@/lib/ipc-client'
import type { AgentStatusEvent, TranscriptChangedEvent } from '@/types/electron'
import { SessionStatus } from '@shared/constants'
import type { AgentMessage, TranscriptPartRecord } from '@shared/transcript/types'
import { applyPartsToProjection, createProjection, projectMessages, type TranscriptProjection } from '@shared/transcript/projection'
import { useArtifactStore } from './artifact-store'

export { SessionStatus }
export type { AgentMessage }

export interface TaskSession {
  sessionId: string | null
  agentId: string
  taskId: string
  status: SessionStatus
  /** Derived, read-only render list — a pure projection of the durable transcript
   *  (`projections` cache), never mutated directly by live events. */
  messages: AgentMessage[]
  /** Transient system status indicator (e.g. 'compacting'). */
  systemStatus?: string | null
  /**
   * True from the moment the user sends until the backend confirms the turn is
   * running (a non-idle status). Resuming an idle session is slow (worktree +
   * MCP + adapter.resumeSession) and emits an interim `idle` status, so status
   * alone can't drive a "starting" indicator. Cleared on the first
   * working/waiting/error status or a safety timeout.
   */
  pendingSend?: boolean
}

// ── Projection cache (SINGLE source of truth for the transcript) ──
//
// The main process owns the durable transcript (`transcript_parts`). The
// renderer's only write path into a task's messages is applyParts(), fed by a
// full snapshot on bind and idempotent `transcript:changed` deltas.

const projections = new Map<string, TranscriptProjection>()
// Number of mounted transcript views per task. Canvas panels can be kept in the
// workspace indefinitely, but their full transcript only belongs in renderer
// memory while at least one view is actually mounted. The durable DB projection
// is re-hydrated when a view comes back.
const projectionBindings = new Map<string, number>()
const bindingTasks = new Set<string>()
// Tasks whose projection may be missing rows (a live event was blocked, or a
// snapshot is being reconciled) and so must not advance their cursor from
// live events until a delta read has caught up.
const dirtyTranscripts = new Set<string>()
const recoveringTranscripts = new Set<string>()
const recoverAgain = new Set<string>()

function getProjection(taskId: string): TranscriptProjection {
  let p = projections.get(taskId)
  if (!p) { p = createProjection(); projections.set(taskId, p) }
  return p
}

/** Test-only: clear all projection caches between tests. */
export function __clearProjectionsForTest(): void {
  projections.clear()
  projectionBindings.clear()
  bindingTasks.clear()
  dirtyTranscripts.clear()
  recoveringTranscripts.clear()
  recoverAgain.clear()
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
  isLoading: boolean
  error: string | null
  sessions: Map<string, TaskSession>

  fetchAgents: () => Promise<void>
  createAgent: (data: CreateAgentDTO) => Promise<Agent | null>
  updateAgent: (id: string, data: UpdateAgentDTO) => Promise<Agent | null>
  deleteAgent: (id: string) => Promise<boolean>

  initSession: (taskId: string, sessionId: string, agentId: string) => void
  /** Mark a task as "starting" after the user sends, until a turn is confirmed. */
  beginSend: (taskId: string) => void
  /** Clear the "starting" indicator (e.g. the send request failed). */
  endSend: (taskId: string) => void
  /** Bind a task view to the durable transcript projection: load the full
   *  snapshot into the cache and render it. Idempotent; subsequent updates
   *  arrive as `transcript:changed` deltas. */
  hydrateTranscript: (taskId: string) => Promise<void>
  /** Retain a task's transcript while a view is mounted. Returns its cleanup. */
  bindTranscript: (taskId: string) => () => void
  endSession: (taskId: string) => void
  removeSession: (taskId: string) => void
  clearMessageDedup: (taskId: string) => void
  getSession: (taskId: string) => TaskSession | undefined
  stopAndRemoveSessionForTask: (taskId: string) => Promise<void>
}

export const useAgentStore = create<AgentState>((set, get) => {
  // Recompute a task's derived messages from its projection cache and write it
  // into the session (creating a placeholder session if the view isn't bound yet,
  // e.g. a background-wake delta arriving before the user opens the task).
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

  // Apply a delta (or snapshot) of parts into the cache, idempotently by id.
  const applyParts = (taskId: string, parts: TranscriptPartRecord[], maxRev?: number): void => {
    if (parts.length === 0 && maxRev == null) return
    const projection = getProjection(taskId)
    applyPartsToProjection(projection, parts, maxRev)
    if (projection.parts.size || get().sessions.has(taskId)) commitMessages(taskId)
  }

  const hydrateTranscript = async (taskId: string, requireBinding = false): Promise<void> => {
    if (!taskId || bindingTasks.has(taskId)) return
    if (requireBinding && !projectionBindings.has(taskId)) return
    if (typeof window.electronAPI?.agentSession?.getTranscriptSnapshot !== 'function') return
    bindingTasks.add(taskId)
    dirtyTranscripts.add(taskId)
    try {
      const snapshot = await agentSessionApi.getTranscriptSnapshot(taskId)
      // The panel may have gone off-screen while the snapshot IPC was in
      // flight. Do not repopulate the cache after its final consumer left.
      if (requireBinding && !projectionBindings.has(taskId)) return
      const maxRev = snapshot.reduce((m, p) => Math.max(m, p.rev || 0), 0)
      const projection = createProjection(snapshot, maxRev)
      // Live events can arrive while the snapshot is in flight. Keep their
      // newer rows, then reconcile from the snapshot cursor to cover changes
      // behind the scan.
      const live = projections.get(taskId)
      if (live) applyPartsToProjection(projection, [...live.parts.values()])
      projections.set(taskId, projection)
      useArtifactStore.getState().projectTranscriptParts(taskId, snapshot)
      if (projection.parts.size || get().sessions.has(taskId)) commitMessages(taskId)
    } catch (err) {
      console.error(`[agent-store] hydrateTranscript failed for task ${taskId}:`, err)
    } finally {
      bindingTasks.delete(taskId)
    }
    if (projections.has(taskId)) await reconcileDelta(taskId)
  }

  // Reconcile a task against the durable projection by fetching everything
  // changed since our cursor. Used as a safety net at idle to catch any delta
  // the renderer may have missed (dropped IPC event).
  const reconcileDelta = async (taskId: string): Promise<void> => {
    if (typeof window.electronAPI?.agentSession?.getTranscriptDelta !== 'function') return
    if (!projections.has(taskId)) return
    if (bindingTasks.has(taskId)) return
    // One delta read per task at a time; a request that arrives meanwhile
    // runs another pass from the advanced cursor.
    if (recoveringTranscripts.has(taskId)) { recoverAgain.add(taskId); return }
    recoveringTranscripts.add(taskId)
    try {
      do {
        recoverAgain.delete(taskId)
        const projection = getProjection(taskId)
        const { parts, maxRev } = await agentSessionApi.getTranscriptDelta(taskId, projection.rev)
        // Unbound (or re-hydrated) while the read was in flight.
        if (projections.get(taskId) !== projection) return
        applyParts(taskId, parts, maxRev)
      } while (recoverAgain.has(taskId))
      dirtyTranscripts.delete(taskId)
    } catch (err) {
      dirtyTranscripts.add(taskId)
      console.error(`[agent-store] reconcileDelta failed for task ${taskId}:`, err)
    } finally {
      recoveringTranscripts.delete(taskId)
      recoverAgain.delete(taskId)
    }
  }

  // ── IPC event subscriptions ──

  // Transcript content: the ONLY writer of messages. Idempotent delta apply.
  onTranscriptChanged((event: TranscriptChangedEvent) => {
    if (!event?.taskId) return
    // The main process could not deliver a live batch (IPC size guard): the
    // projection is missing rows until a delta read catches up.
    if (event.reloadRequired && projections.has(event.taskId)) dirtyTranscripts.add(event.taskId)
    useArtifactStore.getState().projectTranscriptParts(event.taskId, event.parts || [])
    // Background agents continue writing to the durable projection, but an
    // unmounted task has no renderer consumer. Ignoring its payload here avoids
    // rebuilding every off-screen transcript in memory; bindTranscript() loads
    // the authoritative snapshot when the task becomes visible again.
    if (projections.has(event.taskId)) {
      // While recovering, apply the rows but keep the cursor where it is, so
      // the delta read does not skip the rows that never arrived.
      const recovering = dirtyTranscripts.has(event.taskId) || recoveringTranscripts.has(event.taskId)
      applyParts(event.taskId, event.parts || [], recovering ? undefined : event.maxRev)
      if (recovering) void reconcileDelta(event.taskId)
    }
  })

  // Session state only (status / sessionId) — never messages.
  onAgentStatus((event: AgentStatusEvent) => {
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
            messages: projectMessages(projections.get(event.taskId))
          })
        })
      }
      return
    }

    const previousStatus = session.status
    const updated = { ...session, status: event.status }
    if (event.sessionId && session.sessionId !== event.sessionId) updated.sessionId = event.sessionId
    // Turn confirmed running (or errored/awaiting input) — stop showing
    // "starting". Interim `idle` events during resume must NOT clear it.
    if (event.status !== SessionStatus.IDLE) updated.pendingSend = false
    set({ sessions: new Map(state.sessions).set(session.taskId, updated) })
    if (previousStatus === SessionStatus.IDLE && event.status !== SessionStatus.IDLE) {
      useArtifactStore.getState().beginTurn(session.taskId)
    } else if (previousStatus !== SessionStatus.IDLE && event.status === SessionStatus.IDLE) {
      useArtifactStore.getState().endTurn(session.taskId)
    }

    // Safety-net reconcile at end of each turn — catches any missed delta.
    if (event.status === SessionStatus.IDLE) void reconcileDelta(session.taskId)
  })

  const clearPendingSend = (taskId: string): void => {
    set((state) => {
      const s = state.sessions.get(taskId)
      if (!s?.pendingSend) return state
      return { sessions: new Map(state.sessions).set(taskId, { ...s, pendingSend: false }) }
    })
  }

  // ── Return store ──

  return {
    agents: [],
    isLoading: false,
    error: null,
    sessions: new Map(),

    fetchAgents: async () => {
      set({ isLoading: true, error: null })
      try {
        const agents = await agentApi.getAll()
        set({ agents, isLoading: false })
      } catch (err) {
        set({ error: String(err), isLoading: false })
      }
    },

    createAgent: async (data) => {
      try {
        const agent = await agentApi.create(data)
        set((state) => ({ agents: [...state.agents, agent] }))
        return agent
      } catch (err) {
        set({ error: String(err) })
        return null
      }
    },

    updateAgent: async (id, data) => {
      try {
        const updated = await agentApi.update(id, data)
        if (updated) {
          set((state) => ({ agents: state.agents.map((a) => (a.id === id ? updated : a)) }))
        }
        return updated || null
      } catch (err) {
        set({ error: String(err) })
        return null
      }
    },

    deleteAgent: async (id) => {
      try {
        const success = await agentApi.delete(id)
        if (success) {
          set((state) => ({ agents: state.agents.filter((a) => a.id !== id) }))
        }
        return success
      } catch (err) {
        set({ error: String(err) })
        return false
      }
    },

    hydrateTranscript: (taskId) => hydrateTranscript(taskId),

    bindTranscript: (taskId) => {
      const previousCount = projectionBindings.get(taskId) ?? 0
      projectionBindings.set(taskId, previousCount + 1)
      if (previousCount === 0) void hydrateTranscript(taskId, true)

      let released = false
      return () => {
        if (released) return
        released = true

        const nextCount = (projectionBindings.get(taskId) ?? 1) - 1
        if (nextCount > 0) {
          projectionBindings.set(taskId, nextCount)
          return
        }

        projectionBindings.delete(taskId)
        projections.delete(taskId)
        set((state) => {
          const session = state.sessions.get(taskId)
          if (!session || session.messages.length === 0) return state
          return {
            sessions: new Map(state.sessions).set(taskId, {
              ...session,
              messages: []
            })
          }
        })
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
            // Messages are always the projection of the durable transcript.
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
          sessions: new Map(state.sessions).set(taskId, {
            ...session,
            sessionId: null,
            status: SessionStatus.IDLE
          })
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

    // Retained for API compatibility. In the projection model there is no client
    // dedup state to clear and the message list is never rebuilt from replays,
    // so this is a no-op (the durable projection remains the source of truth).
    clearMessageDedup: () => {},

    stopAndRemoveSessionForTask: async (taskId) => {
      const session = get().sessions.get(taskId)
      if (session?.sessionId) {
        try {
          await agentSessionApi.stop(session.sessionId)
        } catch (err) {
          console.error('Failed to stop session:', err)
        }
      }
      get().removeSession(taskId)
    },

    getSession: (taskId) => get().sessions.get(taskId)
  }
})
