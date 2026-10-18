import { CompleteAtSourceDialog } from '@/components/tasks/CompleteAtSourceDialog'
import { getTaskCompletionAction, getTaskSourceName } from '@shared/task-completion'
import { useCallback, useRef, useState } from 'react'
import { getDesktopHost } from '@/lib/desktop-api'
import { taskApi } from '@/lib/ipc-client'
import { useProjectStore } from '@/stores/project-store'
import { useTaskEditReceipt } from './use-task-edit-receipt'
import { useTaskSourceStore } from '@/stores/task-source-store'
import { rehydrateTaskDesktopState, useTaskStore } from '@/stores/task-store'
import { TaskStatus } from '@/types'
import type { Task } from '@/types'

export interface UseTaskCompletionOptions {
  onToast?: (message: string, isError?: boolean) => void
  /** The mounted task view, distinct from the task chosen from a board. */
  viewKey?: string
}
export interface CompleteTaskRequestOptions {
  completeAtSource?: boolean
  beforeComplete?: () => Promise<void>
  onCompleted?: (task: Task) => void
}

/** Ask before a source write; a manual completion changes only the local task. */
export function useTaskCompletion(options: UseTaskCompletionOptions = {}) {
  // Both hooks remain unconditional; host installation precedes the renderer.
  const native = useNativeTaskCompletion(options)
  const legacy = useLegacyTaskCompletion(options)
  return getDesktopHost().kind === 'tauri' ? native : legacy
}
function useLegacyTaskCompletion({ onToast }: UseTaskCompletionOptions) {
  const [pending, setPending] = useState<{ taskId: string; options?: CompleteTaskRequestOptions } | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const sources = useTaskSourceStore(s => s.sources)
  const tasks = useTaskStore(s => s.tasks)
  const executeAction = useTaskSourceStore(s => s.executeAction)
  const requestComplete = useCallback(async (taskId: string, options?: CompleteTaskRequestOptions) => {
    const task = useTaskStore.getState().tasks.find(t => t.id === taskId)
    if (!task) return
    if (task.source_id && options?.completeAtSource === undefined) {
      setPending({ taskId, options })
      return
    }
    setIsBusy(true)
    try {
      // A board move withdraws execution only after the source choice is made.
      // Cancelling that choice must leave the running task untouched.
      await options?.beforeComplete?.()
      // Completing again while feedback learning is pending is an explicit
      // request to stop learning. Moving back to review clears the durable
      // feedback marker before the normal completion path runs; otherwise the
      // database deliberately preserves AgentLearning and the click appears to
      // do nothing.
      if (task.status === TaskStatus.AgentLearning) {
        await useTaskStore.getState().updateTask(task.id, { status: TaskStatus.ReadyForReview })
      }
      if (!task.source_id || options?.completeAtSource === false) {
        await useTaskStore.getState().updateTask(task.id, { status: TaskStatus.Completed, ...(task.source_id ? { complete_at_source: false } : {}) })
        const completedTask = { ...task, status: TaskStatus.Completed }
        setPending(null)
        options?.onCompleted?.(completedTask)
        onToast?.(`"${task.title}" completed`)
        return
      }
      await useTaskStore.getState().updateTask(task.id, { complete_at_source: true })
      const action = getTaskCompletionAction(task.output_fields)
      const result = await executeAction(action, task.id, task.source_id)
      if (!result.success) throw new Error(result.error || 'The server did not confirm completion.')
      await useTaskStore.getState().fetchTasks()
      setPending(null)
      options?.onCompleted?.(task)
      onToast?.(`"${task.title}" completed`)
    } catch (error) {
      onToast?.(error instanceof Error ? error.message : 'Task completion failed.', true)
    } finally {
      setIsBusy(false)
    }
  }, [executeAction, onToast])
  const pendingTask = tasks.find(task => task.id === pending?.taskId)
  const completionDialog = pendingTask && pending ? <CompleteAtSourceDialog
    isOpen={true}
    taskTitle={pendingTask.title}
    sourceName={getTaskSourceName(pendingTask, sources.find(source => source.id === pendingTask.source_id)?.name)}
    isBusy={isBusy}
    onCompleteAtSource={() => void requestComplete(pending.taskId, { ...pending.options, completeAtSource: true })}
    onCompleteManually={() => void requestComplete(pending.taskId, { ...pending.options, completeAtSource: false })}
    onCancel={() => setPending(null)}
  /> : null
  return { requestComplete, completionDialog }
}

function completionBinding(task: Task): string {
  return JSON.stringify([task.id, task.project_id, task.role ?? 'task', task.source_id, task.external_id, task.source, task.agent_id, task.output_fields])
}
interface NativeCompletionIntent {
  task: Task
  binding: string
  options?: CompleteTaskRequestOptions
  current: () => boolean
  retained: () => boolean
  phase: 'choice' | 'progress' | 'review'
}
function useNativeTaskCompletion({ onToast, viewKey }: UseTaskCompletionOptions) {
  const projectId = useProjectStore(s => s.currentProjectId)
  const selectedTaskId = useTaskStore(s => s.selectedTaskId)
  const receipt = useTaskEditReceipt(`completion:${projectId}:${viewKey ?? selectedTaskId ?? 'dashboard'}`)
  const owner = useRef<NativeCompletionIntent | null>(null)
  const [visible, setVisible] = useState<NativeCompletionIntent | null>(null)
  const sources = useTaskSourceStore(s => s.sources)
  const assertIntent = (intent: NativeCompletionIntent) => {
    const current = useTaskStore.getState().tasks.find(row => row.id === intent.task.id)
    if (owner.current !== intent || !intent.current() || !current || completionBinding(current) !== intent.binding) {
      throw new Error('Review the task before completing it.')
    }
  }
  const acceptTask = (intent: NativeCompletionIntent, task: Task | null | undefined, status?: TaskStatus) => {
    assertIntent(intent)
    if (!task || completionBinding(task) !== intent.binding || status && task.status !== status) throw new Error('Task completion was not confirmed.')
    return task
  }
  const execute = async (intent: NativeCompletionIntent, completeAtSource: boolean) => {
    if (owner.current !== intent || intent.phase !== 'choice' || !intent.current() || !receipt.admit()) return
    intent.phase = 'progress'; setVisible({ ...intent })
    await receipt.run(async () => {
      try {
        assertIntent(intent)
        if (intent.task.project_id !== useProjectStore.getState().currentProjectId || intent.task.role && intent.task.role !== 'task') throw new Error('Ordinary task completion is unavailable here.')
        await intent.options?.beforeComplete?.()
        assertIntent(intent)
        // Completion markers are local lifecycle state. The general content
        // store also exports updates; that would create a second, unowned
        // Source effect after this view retires or chooses local-only.
        if (intent.task.status === TaskStatus.AgentLearning) {
          acceptTask(intent, await taskApi.update(intent.task.id, { status: TaskStatus.ReadyForReview }), TaskStatus.ReadyForReview)
        }
        let completed: Task
        if (!intent.task.source_id || !completeAtSource) {
          completed = acceptTask(intent, await taskApi.update(intent.task.id, { status: TaskStatus.Completed, ...(intent.task.source_id ? { complete_at_source: false } : {}) }), TaskStatus.Completed)
        } else {
          acceptTask(intent, await taskApi.update(intent.task.id, { complete_at_source: true }))
          assertIntent(intent)
          const action = getTaskCompletionAction(intent.task.output_fields)
          const result = await useTaskSourceStore.getState().executeAction(action, intent.task.id, intent.task.source_id)
          assertIntent(intent)
          if (result.success !== true) throw new Error('Source completion was not confirmed.')
          await rehydrateTaskDesktopState()
          completed = acceptTask(intent, useTaskStore.getState().tasks.find(row => row.id === intent.task.id), TaskStatus.Completed)
        }
        assertIntent(intent)
        intent.options?.onCompleted?.(completed)
        // Selection callbacks may retire this view. They already received the
        // canonical receipt; do not publish into a replacement view afterward.
        if (intent.current()) onToast?.(`"${completed.title}" completed`)
        if (owner.current === intent) { owner.current = null; if (intent.retained()) setVisible(null) }
      } catch (error) {
        intent.phase = 'review'
        if (owner.current === intent && intent.retained()) setVisible({ ...intent })
        throw error
      }
    })
  }
  const requestComplete = async (taskId: string, options?: CompleteTaskRequestOptions) => {
    const previous = owner.current
    if (previous && previous.retained()) { setVisible({ ...previous }); return }
    if (!receipt.admit()) return
    const task = useTaskStore.getState().tasks.find(row => row.id === taskId)
    if (!task) return
    const intent: NativeCompletionIntent = { task: structuredClone(task), binding: completionBinding(task), options, current: receipt.current, retained: receipt.retained, phase: 'choice' }
    owner.current = intent; setVisible({ ...intent })
    if (!task.source_id || options?.completeAtSource !== undefined || task.role && task.role !== 'task' || task.project_id !== projectId) await execute(intent, options?.completeAtSource === true)
  }
  const intent = owner.current
  const completionDialog = visible && intent && intent.retained() ? <CompleteAtSourceDialog
    isOpen={true}
    taskTitle={intent.task.title}
    sourceName={getTaskSourceName(intent.task, sources.find(source => source.id === intent.task.source_id)?.name)}
    mode={intent.phase}
    isBusy={receipt.busy}
    onCompleteAtSource={() => void execute(intent, true)}
    onCompleteManually={() => void execute(intent, false)}
    onCancel={() => {
      if (intent.phase === 'progress') return
      if (intent.phase === 'choice') owner.current = null
      setVisible(null)
    }}
  /> : null
  return { requestComplete, completionDialog }
}
