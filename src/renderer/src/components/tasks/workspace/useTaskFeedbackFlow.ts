import { useCallback, useRef, useState } from 'react'
import { getDesktopHost } from '@/lib/desktop-api'
import { useTaskEditReceipt } from '@/hooks/use-task-edit-receipt'
import { useProjectStore } from '@/stores/project-store'
import { useAgentStore, SESSION_RECEIPT } from '@/stores/agent-store'
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
export function useTaskFeedbackFlow(options: TaskFeedbackFlowOptions) {
  const native = useNativeTaskFeedbackFlow(options)
  const legacy = useLegacyTaskFeedbackFlow(options)
  return getDesktopHost().kind === 'tauri' ? native : { ...legacy, feedbackBusy: false, feedbackReview: false, feedbackTask: options.task }
}
function useLegacyTaskFeedbackFlow({
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


function feedbackBinding(task: Task): string {
  return JSON.stringify([task.id, task.project_id, task.role ?? 'task', task.group_id, task.parent_task_id, task.agent_id, task.source_id, task.external_id, task.source, task.output_fields])
}
interface NativeFeedbackIntent {
  task: Task
  binding: string
  sendMessage: TaskFeedbackFlowOptions['sendMessage']
  completeTask: TaskFeedbackFlowOptions['onCompleteTask']
  current: () => boolean
  retained: () => boolean
  phase: 'form' | 'progress' | 'review'
  sessionOwner?: object
  sessionId?: string | null
  agentId?: string
}
function useNativeTaskFeedbackFlow(options: TaskFeedbackFlowOptions) {
  const projectId = useProjectStore(s => s.currentProjectId)
  const receipt = useTaskEditReceipt(`feedback:${projectId}:${options.task?.id ?? 'no-task'}`)
  const observed = useRef(options); observed.current = options
  const owner = useRef<NativeFeedbackIntent | null>(null)
  const [visible, setVisible] = useState(false)
  // Each rendered form owns its callbacks, including Cancel/reopen in one
  // task view. A cached callback must never borrow the replacement form.
  const renderedIntent = owner.current
  const assertIntent = (intent: NativeFeedbackIntent, checkSession = true) => {
    const task = observed.current.task
    const session = useAgentStore.getState().sessions.get(intent.task.id)
    if (checkSession && ((session?.[SESSION_RECEIPT] ?? session) !== intent.sessionOwner || session?.sessionId !== intent.sessionId || session?.agentId !== intent.agentId)) throw new Error('The conversation owner changed.')
    if (owner.current !== intent || !intent.current() || !task || feedbackBinding(task) !== intent.binding || task.project_id !== useProjectStore.getState().currentProjectId || task.role && task.role !== 'task') throw new Error('Review the task before submitting feedback.')
  }
  const handleCompleteTask = async () => {
    if (owner.current?.retained()) { setVisible(true); return }
    if (!receipt.admit()) return
    const task = options.task
    if (!task) return
    const session = useAgentStore.getState().sessions.get(task.id)
    const intent: NativeFeedbackIntent = { sessionOwner: session?.[SESSION_RECEIPT] ?? session, sessionId: session?.sessionId, agentId: session?.agentId, task: structuredClone(task), binding: feedbackBinding(task), sendMessage: options.sendMessage, completeTask: options.onCompleteTask, current: receipt.current, retained: receipt.retained, phase: 'form' }
    owner.current = intent
    if (task.role && task.role !== 'task' || task.project_id !== projectId) { intent.phase = 'review'; setVisible(true); return }
    if (options.sessionId && options.hasMessages || task.session_id) setVisible(true)
    else {
      await receipt.run(async () => {
        try { assertIntent(intent); await intent.completeTask(); if (intent.retained()) { owner.current = null; setVisible(false) } }
        catch (error) { intent.phase = 'review'; if (intent.retained()) setVisible(true); throw error }
      })
    }
  }
  const handleFeedbackSubmit = async (rating: number, comment: string, completeAtSource: boolean) => {
    const intent = renderedIntent
    if (!intent || owner.current !== intent || intent.phase !== 'form' || !receipt.admit()) return
    intent.phase = 'progress'; setVisible(true)
    await receipt.run(async () => {
      try {
        assertIntent(intent)
        if (!intent.task.agent_id) throw new Error('No learning owner is available.')
        const accepted = await taskApi.update(intent.task.id, {
          status: TaskStatus.AgentLearning, complete_at_source: completeAtSource,
          feedback_rating: rating, feedback_comment: comment || null
        })
        assertIntent(intent)
        if (!accepted || feedbackBinding(accepted) !== intent.binding || accepted.status !== TaskStatus.AgentLearning || accepted.feedback_rating !== rating || accepted.feedback_comment !== (comment || null) || accepted.complete_at_source !== completeAtSource) throw new Error('Learning intent was not confirmed.')
        // The retained send owner owns resume/create, learning-only startup and
        // its durable delivery nonce. Do not pre-start or replay from this UI.
        await intent.sendMessage(buildFeedbackPrompt(rating, comment))
        assertIntent(intent, false)
        owner.current = null; setVisible(false)
      } catch (error) {
        intent.phase = 'review'; if (intent.retained()) setVisible(true)
        throw error
      }
    })
  }
  const handleFeedbackSkip = async (completeAtSource: boolean) => {
    const intent = renderedIntent
    if (!intent || owner.current !== intent || intent.phase !== 'form' || !receipt.admit()) return
    intent.phase = 'progress'
    await receipt.run(async () => {
      try {
        assertIntent(intent)
        // Transfer this explicit choice to the completion receipt owner. It
        // publishes its own accepted/review state; this owner does not replay.
        setVisible(false)
        await intent.completeTask(completeAtSource)
        intent.phase = 'review'
      } catch (error) { intent.phase = 'review'; if (intent.retained()) setVisible(true); throw error }
    })
  }
  const handleFeedbackCancel = () => {
    const intent = renderedIntent
    if (!intent || owner.current !== intent || !intent.retained() || intent.phase === 'progress') return
    if (intent.phase === 'form') owner.current = null
    setVisible(false)
  }
  return { showFeedback: visible && !!owner.current?.retained(), handleCompleteTask, handleFeedbackSubmit, handleFeedbackSkip, handleFeedbackCancel, feedbackBusy: receipt.busy, feedbackReview: owner.current?.phase === 'review', feedbackTask: owner.current?.task }
}
