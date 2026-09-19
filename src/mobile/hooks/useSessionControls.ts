import { useCallback, useRef } from 'react'
import { useAgentStore } from '../stores/agent-store'
import { api, type SessionStartResult } from '../api/client'
import { useStartQueueStore } from '../stores/start-queue-store'

/**
 * Shared session control handlers used by both ConversationPage and TaskDetailPage.
 * Provides double-click protection via busyRef and rollback on failure via endSession.
 */
export function useSessionControls(taskId: string) {
  const initSession = useAgentStore((s) => s.initSession)
  const endSession = useAgentStore((s) => s.endSession)
  const markQueued = useStartQueueStore((s) => s.markQueued)
  const clearQueued = useStartQueueStore((s) => s.clear)
  const busyRef = useRef(false)

  // Over a concurrency limit the desktop queues the start instead of running
  // it: show that rather than a session that never begins.
  const applyStartResult = useCallback((result: SessionStartResult, agentId: string) => {
    if (result.queued) {
      endSession(taskId)
      markQueued(taskId, { position: result.queuePosition ?? 1, reason: result.queueReason })
      return
    }
    clearQueued(taskId)
    initSession(taskId, result.sessionId, agentId)
  }, [taskId, initSession, endSession, markQueued, clearQueued])

  const handleStart = useCallback(async (agentId: string) => {
    if (busyRef.current) return
    busyRef.current = true
    initSession(taskId, '', agentId)
    try {
      applyStartResult(await api.sessions.start(agentId, taskId), agentId)
    } catch (e) {
      console.error('Failed to start session:', e)
      endSession(taskId)
    } finally {
      busyRef.current = false
    }
  }, [taskId, initSession, endSession, applyStartResult])

  const handleResume = useCallback(async (agentId: string, existingSessionId: string) => {
    if (busyRef.current) return
    busyRef.current = true
    initSession(taskId, '', agentId)
    try {
      const { sessionId } = await api.sessions.resume(existingSessionId, agentId, taskId)
      initSession(taskId, sessionId, agentId)
    } catch (e) {
      console.error('Failed to resume session:', e)
      endSession(taskId)
    } finally {
      busyRef.current = false
    }
  }, [taskId, initSession, endSession])

  const handleStop = useCallback(async (sessionId: string) => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      await api.sessions.stop(sessionId)
      endSession(taskId)
    } catch (e) {
      console.error('Failed to stop session:', e)
    } finally {
      busyRef.current = false
    }
  }, [taskId, endSession])

  const handleRestart = useCallback(async (agentId: string, currentSessionId: string) => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      await api.sessions.stop(currentSessionId)
      endSession(taskId)
      initSession(taskId, '', agentId)
      applyStartResult(await api.sessions.start(agentId, taskId), agentId)
    } catch (e) {
      console.error('Failed to restart session:', e)
      endSession(taskId)
    } finally {
      busyRef.current = false
    }
  }, [taskId, initSession, endSession, applyStartResult])

  return { handleStart, handleResume, handleStop, handleRestart, busyRef }
}
