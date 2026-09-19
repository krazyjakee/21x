import { useCallback, useRef } from 'react'
import { useAgentSession } from '@/hooks/use-agent-session'
import { useAgentStore } from '@/stores/agent-store'

/**
 * A chat with a coordinator conversation: a project's Captain, or a
 * Commander session. Both are agent sessions on a hidden task row, so both
 * start, resume, send and stop exactly like a task's session; this adds only
 * what a chat that starts on demand needs on top of that.
 *
 * `taskId` is the row; `agentId` the agent it runs on. Nothing starts until
 * both are known.
 */
export function useCoordinatorChat(taskId: string | null, agentId: string | null) {
  const { start, stop, sendMessage, approve } = useAgentSession(taskId ?? undefined)
  const session = useAgentStore((state) => (taskId ? state.sessions.get(taskId) : undefined))
  const removeSession = useAgentStore((state) => state.removeSession)
  /** The start in flight and whose it is, shared so a message can wait for it instead of racing. */
  const startingRef = useRef<{ taskId: string; promise: Promise<void> } | null>(null)
  const agentIdRef = useRef<string | null>(agentId)
  agentIdRef.current = agentId

  /**
   * Brings up the session, or joins the one already starting.
   *
   * Starting an agent takes seconds, so callers may do it ahead of time. That
   * creates a window where a message can arrive while the session is still
   * coming up: without the shared promise the message would be dropped,
   * because there is no session yet and one is already being made.
   */
  const ensureSession = useCallback(async (): Promise<boolean> => {
    if (!taskId) return false
    const live = useAgentStore.getState().sessions.get(taskId)
    if (live?.sessionId) return true

    const chosenAgentId = agentIdRef.current
    if (!chosenAgentId) return false

    // A start still in flight for another row is not ours.
    if (!startingRef.current || startingRef.current.taskId !== taskId) {
      const promise = (async () => {
        // Clean up any old session data first
        removeSession(taskId)
        // skipInitialPrompt keeps the agent quiet until the user speaks. Main
        // resumes the persisted conversation when there is one, so a restart
        // continues where the last one left off.
        await start(chosenAgentId, taskId, undefined, true)
        // Small delay to ensure session is fully initialized
        await new Promise((resolve) => setTimeout(resolve, 100))
      })().finally(() => {
        if (startingRef.current?.taskId === taskId) startingRef.current = null
      })
      startingRef.current = { taskId, promise }
    }

    try {
      await startingRef.current.promise
      return Boolean(useAgentStore.getState().sessions.get(taskId)?.sessionId)
    } catch (err) {
      console.error('Failed to start the coordinator session:', err)
      return false
    }
  }, [taskId, start, removeSession])

  /** Sends, starting the session first when needed. A pending question is answered instead. */
  const send = useCallback(
    async (message: string) => {
      if (!(await ensureSession())) return

      // Question answers should use approve() instead of sendMessage()
      const live = taskId ? useAgentStore.getState().sessions.get(taskId) : undefined
      const messages = live?.messages || []
      const lastMessage = messages[messages.length - 1]
      if (lastMessage?.partType === 'question' && lastMessage?.tool?.questions) {
        await approve(true, message)
      } else {
        await sendMessage(message)
      }
    },
    [taskId, ensureSession, sendMessage, approve]
  )

  /**
   * Moves the conversation to another agent. The new choice is recorded
   * before the old session is stopped, or a warm-up would race in and start
   * the old agent again.
   */
  const switchAgent = useCallback(
    async (nextAgentId: string) => {
      agentIdRef.current = nextAgentId
      if (taskId && useAgentStore.getState().sessions.get(taskId)?.sessionId) {
        await stop()
        removeSession(taskId)
      }
    },
    [taskId, stop, removeSession]
  )

  return { session, ensureSession, send, stop, switchAgent }
}
