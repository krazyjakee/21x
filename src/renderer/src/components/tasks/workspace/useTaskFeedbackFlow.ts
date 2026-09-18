import { useCallback, useState } from 'react'
import { useAgentStore } from '@/stores/agent-store'
import { useProgressToastStore } from '@/stores/progress-toast-store'
import { taskApi } from '@/lib/ipc-client'
import { TaskStatus } from '@/types'
import type { Task } from '@/types'

interface TaskFeedbackFlowOptions {
  task: Task | undefined
  sessionId: string | null
  hasMessages: boolean
  onCompleteTask: (completeAtSource?: boolean) => void
  ensureChatSession: (allowFreshStart?: boolean) => Promise<string | null>
  start: (agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean) => Promise<string>
  sendMessage: (message: string) => Promise<void>
}

function buildFeedbackPrompt(rating: number, comment: string): string {
  const commentPart = comment ? ` Comment: "${comment}".` : ''
  const today = new Date().toISOString().split('T')[0]
  return `User rated this session ${rating}/5.${commentPart}

Review the session and update skills in .agents/skills/:

**For skills you used:**
Update the YAML frontmatter:
- confidence: ${rating >= 4 ? '+0.05 (was helpful)' : rating <= 2 ? '-0.10 (was wrong/outdated)' : 'no change'}
- uses: increment by 1
- lastUsed: ${today}
- tags: add relevant keywords if missing

**If you discovered a new reusable pattern:**
Create a new skill file with:
\`\`\`yaml
---
name: skill-name
description: Brief description of when to use this skill
confidence: 0.5
uses: 1
lastUsed: ${today}
tags:
  - relevant-tag
---
# Skill content here
\`\`\`

Update existing skills that were helpful or create new ones for patterns worth reusing.`
}

/** Completing a task that had an agent session asks for feedback, which drives a skill-learning turn. */
export function useTaskFeedbackFlow({
  task,
  sessionId,
  hasMessages,
  onCompleteTask,
  ensureChatSession,
  start,
  sendMessage
}: TaskFeedbackFlowOptions) {
  const [showFeedback, setShowFeedback] = useState(false)
  const showProgressToast = useProgressToastStore((s) => s.show)
  const failProgressToast = useProgressToastStore((s) => s.fail)

  const handleCompleteTask = useCallback(async () => {
    const hasActiveSession = sessionId && hasMessages
    const hasResumableSession = !sessionId && task?.session_id

    console.log('[TaskWorkspace] Complete check:', {
      hasActiveSession,
      hasResumableSession,
      sessionId,
      taskSessionId: task?.session_id,
      hasMessages
    })

    if (hasActiveSession || hasResumableSession) {
      setShowFeedback(true)
    } else {
      await onCompleteTask()
    }
  }, [sessionId, hasMessages, task?.session_id, onCompleteTask])

  const handleFeedbackSubmit = useCallback(async (rating: number, comment: string, completeAtSource: boolean) => {
    if (!task?.agent_id || !task?.id) return
    setShowFeedback(false)

    // The Learning status is what stops the completed-task effect from
    // auto-stopping the session we are about to reuse.
    console.log('[TaskWorkspace] Setting task status to AgentLearning:', task.id)
    let updatedTask: Task | null | undefined
    try {
      updatedTask = await taskApi.update(task.id, {
        status: TaskStatus.AgentLearning,
        complete_at_source: completeAtSource,
        feedback_rating: rating,
        feedback_comment: comment || null,
      })
    } catch (error) {
      // The dialog is already closed at this point, so a rejected write left the
      // task untouched with nothing on screen — the user just saw the dialog
      // vanish and nothing happen. Say so and let them retry.
      console.error('[TaskWorkspace] Failed to record feedback:', error)
      // `fail` is a no-op unless the toast already exists, so show it first.
      const toastId = `feedback-${task.id}`
      showProgressToast(toastId, 'Feedback not saved')
      failProgressToast(
        toastId,
        `Could not save feedback for "${task.title}": ${error instanceof Error ? error.message : String(error)}`
      )
      setShowFeedback(true)
      return
    }
    console.log('[TaskWorkspace] Task status set to AgentLearning, verified:', updatedTask?.status)

    const prompt = buildFeedbackPrompt(rating, comment)

    try {
      // Resume if possible, or start a learning-only session when the old
      // adapter session has ended. The feedback prompt is the sole new task.
      if (!useAgentStore.getState().sessions.get(task.id)?.sessionId) {
        const readySessionId = task.session_id
          ? await ensureChatSession(true)
          : await start(task.agent_id, task.id, undefined, true)
        if (!readySessionId) throw new Error('Could not start the learning session.')
      }

      // Sent through the normal flow so it shows in the transcript. The backend
      // syncs skills and completes the task once the session goes idle.
      await sendMessage(prompt)
    } catch (error) {
      console.error('Failed to send feedback:', error)
      const toastId = `feedback-${task.id}`
      showProgressToast(toastId, 'Learning could not start')
      failProgressToast(toastId, error instanceof Error ? error.message : String(error))
      await taskApi.update(task.id, { status: TaskStatus.ReadyForReview })
      setShowFeedback(true)
    }
  }, [ensureChatSession, sendMessage, start, task])

  const handleFeedbackSkip = useCallback(async (completeAtSource: boolean) => {
    if (!task?.id) return
    setShowFeedback(false)
    await onCompleteTask(completeAtSource)
  }, [task?.id, onCompleteTask])

  const handleFeedbackCancel = useCallback(() => setShowFeedback(false), [])

  return { showFeedback, handleCompleteTask, handleFeedbackSubmit, handleFeedbackSkip, handleFeedbackCancel }
}
