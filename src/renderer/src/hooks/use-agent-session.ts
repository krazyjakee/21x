import { useCallback, useEffect, useMemo } from 'react'
import { agentSessionApi } from '@/lib/ipc-client'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'

export type { AgentMessage } from '@/stores/agent-store'

export interface AgentSessionState {
  sessionId: string | null
  status: SessionStatus
  messages: import('@/stores/agent-store').AgentMessage[]
  /** Transient system status indicator (e.g. 'compacting') — cleared on next non-status message */
  systemStatus?: string | null
  /** User sent and the backend is still resuming the session. */
  pendingSend?: boolean
}

export interface SendMessageOptions {
  /** Stable across renderer retries; main persists it before claiming delivery. */
  deliveryId?: string
  attachments?: Array<{
    id: string
    filename: string
    size: number
    mime_type: string
  }>
}

const EMPTY_SESSION: AgentSessionState = {
  sessionId: null,
  status: SessionStatus.IDLE,
  messages: []
}

/**
 * Session state plus actions. Re-renders on every streamed delta because the
 * state includes `messages`; components that only act on a session should use
 * useAgentSessionActions instead.
 */
export function useAgentSession(taskId: string | undefined) {
  const actions = useAgentSessionActions(taskId)
  const session = useAgentStore((s) => (taskId ? s.sessions.get(taskId) : undefined))

  // Keyed on individual fields so the object keeps its identity across
  // unrelated store deltas, letting downstream React.memo boundaries bail out.
  const sessionState: AgentSessionState = useMemo(
    () =>
      session
        ? {
            sessionId: session.sessionId,
            status: session.status,
            messages: session.messages,
            systemStatus: session.systemStatus,
            pendingSend: session.pendingSend
          }
        : EMPTY_SESSION,
    [
      session?.sessionId,
      session?.status,
      session?.messages,
      session?.systemStatus,
      session?.pendingSend
    ]
  )

  return useMemo(() => ({ session: sessionState, ...actions }), [sessionState, actions])
}

/** Binds the task's transcript and returns stable session actions, without subscribing to session state. */
export function useAgentSessionActions(taskId: string | undefined) {
  const initSession = useAgentStore((s) => s.initSession)
  const endSession = useAgentStore((s) => s.endSession)
  const bindTranscript = useAgentStore((s) => s.bindTranscript)

  // Hydrate from the durable transcript projection when a task view binds.
  // The store renders state, not history-of-pushes: output produced while
  // this window wasn't open (background wake-ups, app restarts, resumed
  // sessions) appears immediately without needing a live session.
  useEffect(() => {
    // Guard for partial store mocks. Releasing the binding drops the renderer
    // projection while leaving the durable transcript and agent runtime intact.
    if (taskId && typeof bindTranscript === 'function') return bindTranscript(taskId)
    return undefined
  }, [taskId, bindTranscript])

  const start = useCallback(
    async (agentId: string, tId: string, workspaceDir?: string, skipInitialPrompt?: boolean) => {
      // Pre-register so events arriving during start() are captured via taskId fallback
      initSession(tId, '', agentId)
      try {
        const result = await agentSessionApi.start(agentId, tId, workspaceDir, skipInitialPrompt)
        if (result.queued) {
          // A durable queue row is not a live session. Leave the task idle;
          // TaskWorkspace renders queue/retry state separately.
          endSession(tId)
          return ''
        }
        const { sessionId } = result
        // Update with the real sessionId (preserves any messages that arrived early)
        initSession(tId, sessionId, agentId)
        return sessionId
      } catch (err) {
        // Start failed (e.g. the backend died before it came up). The
        // pre-registered session is left in WORKING and would otherwise pin
        // the panel on "Agent is starting..." forever — drop it and let the
        // user retry. The main process also surfaces the reason in the
        // transcript and as an error status (see requestSession).
        endSession(tId)
        throw err
      }
    },
    [initSession, endSession]
  )

  const removeSession = useAgentStore((s) => s.removeSession)

  const resume = useCallback(
    async (agentId: string, tId: string, ocSessionId: string) => {
      // NOTE: do NOT clear the message list here. The durable transcript
      // projection is hydrated into the view on mount; clearing would wipe that
      // full history, and the resume replay would only partially repopulate it.
      // The replay batch dedups against the hydrated messages (shared part ids),
      // so nothing is lost or duplicated by leaving them in place.
      initSession(tId, '', agentId)
      try {
        const result = await agentSessionApi.resume(agentId, tId, ocSessionId)
        if (result.ended) {
          // Session ended normally (task completed) — clean up the pre-registered session
          removeSession(tId)
          return ''
        }
        initSession(tId, result.sessionId, agentId)
        return result.sessionId
      } catch (err) {
        // Resume failed — clear the pre-registered session so the panel
        // doesn't sit on the "starting" state (start() does the same).
        endSession(tId)
        throw err
      }
    },
    [initSession, removeSession, endSession]
  )

  const switchAgent = useCallback(
    async (tId: string, newAgentId: string) => {
      // Pre-register so events arriving during the switch are captured via
      // taskId fallback, same as start(). The main process stops the
      // outgoing agent's session and seeds the new one with a recap of the
      // existing transcript — nothing to clear here, the durable transcript
      // projection already reflects the prior conversation.
      initSession(tId, '', newAgentId)
      try {
        const { sessionId } = await agentSessionApi.switchAgent(tId, newAgentId)
        initSession(tId, sessionId, newAgentId)
        return sessionId
      } catch (err) {
        // The outgoing session was already stopped on the main side; without
        // this the panel would keep showing an agent that no longer exists.
        endSession(tId)
        throw err
      }
    },
    [initSession, endSession]
  )

  const abort = useCallback(async () => {
    const currentSession = useAgentStore.getState().sessions.get(taskId!)
    if (!currentSession?.sessionId) return
    await agentSessionApi.abort(currentSession.sessionId)
  }, [taskId])

  const stop = useCallback(async () => {
    if (!taskId) return
    const currentSession = useAgentStore.getState().sessions.get(taskId)
    if (currentSession?.sessionId) {
      console.log('[use-agent-session] stop() called for session:', currentSession.sessionId)
      await agentSessionApi.stop(currentSession.sessionId)
    } else {
      // Fallback: session mapping lost in renderer — ask the backend
      // to find and stop the session by taskId directly.
      console.log('[use-agent-session] stop() no sessionId, falling back to stopByTaskId:', taskId)
      await agentSessionApi.stopByTaskId(taskId)
    }
    endSession(taskId)
  }, [taskId, endSession])

  const sendMessage = useCallback(
    async (message: string, options?: SendMessageOptions) => {
      if (!taskId) throw new Error('No taskId')
      // Get latest session from store, not from closure
      const currentSession = useAgentStore.getState().sessions.get(taskId)
      // Resuming an idle session is slow (the send call blocks until the resume
      // completes). Show "starting" immediately so the UI isn't stuck on "Idle"
      // with an open input. Cleared by the first non-idle status or on failure.
      const store = useAgentStore.getState()
      const deliveryId = options?.deliveryId ?? `renderer:${crypto.randomUUID()}`
      store.beginSend(taskId)
      try {
        if (currentSession?.sessionId) {
          const result = await agentSessionApi.send(currentSession.sessionId, message, taskId, currentSession.agentId, options?.attachments, deliveryId)
          // Session was recreated on the main process — update renderer store
          if (result.newSessionId && taskId) {
            initSession(taskId, result.newSessionId, currentSession.agentId)
          }
        } else {
          // Fallback: session mapping lost in renderer — ask the backend
          // to find (or resume/create) the session by taskId directly.
          console.log('[use-agent-session] sendMessage() no sessionId, falling back to sendByTaskId:', taskId)
          const result = await agentSessionApi.sendByTaskId(taskId, message, options?.attachments, deliveryId)
          // Update renderer store with the recovered/new sessionId
          const resolvedSessionId = result.newSessionId || result.sessionId
          if (resolvedSessionId) {
            initSession(taskId, resolvedSessionId, currentSession?.agentId ?? '')
          }
        }
      } catch (e) {
        store.endSend(taskId)
        throw e
      }
    },
    [taskId, initSession]
  )

  const approve = useCallback(
    async (approved: boolean, message?: string, responseType?: 'permission' | 'question', requestId?: string) => {
      const currentSession = useAgentStore.getState().sessions.get(taskId!)
      if (!currentSession?.sessionId) throw new Error('No active session')
      await agentSessionApi.approve(currentSession.sessionId, approved, message, responseType, requestId)
    },
    [taskId]
  )

  return useMemo(
    () => ({ start, resume, switchAgent, abort, stop, sendMessage, approve }),
    [start, resume, switchAgent, abort, stop, sendMessage, approve]
  )
}
