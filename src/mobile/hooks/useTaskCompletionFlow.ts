import { useCallback, useState } from 'react'
import { TaskStatus } from '@shared/constants'
import { api } from '../api/client'
import { useTaskStore } from '../stores/task-store'
import type { Task } from '@/types'
import { useAgentStore } from '../stores/agent-store'

async function completeTaskNow(task: Task, completeAtSource = true): Promise<void> {
  try {
    await api.tasks.complete(task.id, completeAtSource)
  } catch (error) {
    window.alert(error instanceof Error ? error.message : 'The task source has not confirmed completion.')
  }
}

/**
 * Completing an agent- or source-backed task opens a modal first: agent tasks
 * collect session feedback (which starts a learning session), source tasks
 * choose whether to close the record at the source.
 */
export function useTaskCompletionFlow(task: Task | undefined, activeSessionId: string | null | undefined) {
  const updateTask = useTaskStore((s) => s.updateTask)
  const initSession = useAgentStore((s) => s.initSession)
  const [completeModal, setCompleteModal] = useState<{ withFeedback: boolean } | null>(null)

  const handleCompleteTask = useCallback(async () => {
    if (!task) return
    if (task.agent_id || task.source_id) setCompleteModal({ withFeedback: !!task.agent_id })
    else await completeTaskNow(task)
  }, [task])

  const handleFeedbackSubmit = useCallback(async (rating: number, comment: string, completeAtSource: boolean) => {
    if (!task?.agent_id) return
    const saved = await updateTask(task.id, {status: TaskStatus.AgentLearning, feedback_rating: rating,
      feedback_comment: comment || null, complete_at_source: completeAtSource})
    if (!saved) return
    setCompleteModal(null)
    try {
      let sessionId = activeSessionId
      if (!sessionId && task.session_id) {
        sessionId = (await api.sessions.resume(task.session_id, task.agent_id, task.id)).sessionId
      }
      if (!sessionId) sessionId = (await api.sessions.start(task.agent_id, task.id, true)).sessionId
      initSession(task.id, sessionId, task.agent_id)
      await api.sessions.send(sessionId,
        `User rated this session ${rating}/5. Comment: "${comment}". Review the session and update skills in .agents/skills/. Update confidence, uses, lastUsed, and tags for useful skills. Create skills for new reusable patterns.`,
        task.id, task.agent_id)
    } catch (error) {
      await updateTask(task.id, {status: TaskStatus.ReadyForReview})
      window.alert(error instanceof Error ? error.message : 'Could not start the learning session.')
    }
  }, [task, activeSessionId, updateTask, initSession])

  const handleFeedbackSkip = useCallback(async (completeAtSource: boolean) => {
    if (!task) return
    setCompleteModal(null)
    await completeTaskNow(task, completeAtSource)
  }, [task])

  const cancelCompletion = useCallback(() => setCompleteModal(null), [])

  return { completeModal, handleCompleteTask, handleFeedbackSubmit, handleFeedbackSkip, cancelCompletion }
}
