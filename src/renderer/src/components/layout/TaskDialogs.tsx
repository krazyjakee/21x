import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TaskWorkspace } from '@/components/tasks/TaskWorkspace'
import { TaskForm, type TaskFormSubmitData } from '@/components/tasks/TaskForm'
import { DeleteConfirmDialog } from '@/components/tasks/DeleteConfirmDialog'
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle, DialogDescription } from '@/components/ui/Dialog'
import { useCurrentProject } from '@/hooks/use-project-tasks'
import { useUIStore } from '@/stores/ui-store'
import { useTaskStore } from '@/stores/task-store'
import { useAgentStore } from '@/stores/agent-store'
import { worktreeApi, settingsApi } from '@/lib/ipc-client'
import { ATTACHMENT_IMPORT_FAILURE, attachmentPrecondition, copyAttachmentBaseline, importTaskAttachments, mergeTaskAttachments } from '@/lib/task-attachment-import'
import { captureDesktopRead, getDesktopHost } from '@/lib/desktop-api'
import { useTaskEditReceipt } from '@/hooks/use-task-edit-receipt'
import { useProjectStore } from '@/stores/project-store'
import type { Agent, FileAttachment, OutputField } from '@/types'

interface TaskDialogsProps {
  agents: Agent[]
  showToast: (message: string, isError?: boolean) => void
  completeTask: (taskId: string, options?: { completeAtSource?: boolean }) => Promise<void>
  onGoToFullView: (taskId: string) => void
  onNavigateFromPreview: (taskId: string) => void
  onAssignAgent: (taskId: string, agentId: string | null) => Promise<void>
  onUpdateTask: (taskId: string, data: Record<string, unknown>) => Promise<void>
}

/** Create / edit / delete task dialogs and the dashboard task preview. */
export function TaskDialogs({
  agents,
  showToast,
  completeTask,
  onGoToFullView,
  onNavigateFromPreview,
  onAssignAgent,
  onUpdateTask
}: TaskDialogsProps) {
  const allTasks = useTaskStore((s) => s.tasks)
  const createTask = useTaskStore((s) => s.createTask)
  const updateTask = useTaskStore((s) => s.updateTask)
  const deleteTask = useTaskStore((s) => s.deleteTask)
  const selectTask = useTaskStore((s) => s.selectTask)
  const stopAndRemoveSessionForTask = useAgentStore((s) => s.stopAndRemoveSessionForTask)
  const currentProject = useCurrentProject()
  const formIntentRef = useRef(0)
  const [formIntent, setFormIntent] = useState(0)
  const creating = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const off = useUIStore.subscribe((state, previous) => {
      if (state.activeModal !== previous.activeModal || state.editingTaskId !== previous.editingTaskId || state.deletingTaskId !== previous.deletingTaskId) setFormIntent(++formIntentRef.current)
    })
    const retire = () => { mounted.current = false; ++formIntentRef.current; off(); window.removeEventListener('pagehide', retire) }
    window.addEventListener('pagehide', retire, { once: true })
    return retire
  }, [])

  const activeModal = useUIStore((s) => s.activeModal)
  const closeModal = useUIStore((s) => s.closeModal)
  const editingTaskId = useUIStore((s) => s.editingTaskId)
  const deletingTaskId = useUIStore((s) => s.deletingTaskId)
  const native = getDesktopHost().kind === 'tauri', deleteReceipt = useTaskEditReceipt(`delete:${deletingTaskId}:${formIntent}`)
  const openEditModal = useUIStore((s) => s.openEditModal)
  const openDeleteModal = useUIStore((s) => s.openDeleteModal)
  const createTaskPrefill = useUIStore((s) => s.createTaskPrefill)
  const clearCreateTaskPrefill = useUIStore((s) => s.clearCreateTaskPrefill)
  const sidebarView = useUIStore((s) => s.sidebarView)
  const setSidebarView = useUIStore((s) => s.setSidebarView)
  const setCanvasPendingTaskId = useUIStore((s) => s.setCanvasPendingTaskId)
  const clearCanvasPendingTask = useUIStore((s) => s.clearCanvasPendingTask)
  const dashboardPreviewTaskId = useUIStore((s) => s.dashboardPreviewTaskId)
  const closeDashboardPreview = useUIStore((s) => s.closeDashboardPreview)

  const editingTask = useMemo(
    () => editingTaskId ? allTasks.find((t) => t.id === editingTaskId) : undefined,
    [editingTaskId, allTasks]
  )
  const deletingTask = useMemo(
    () => deletingTaskId ? allTasks.find((t) => t.id === deletingTaskId) : undefined,
    [deletingTaskId, allTasks]
  )
  const dashboardPreviewTask = useMemo(
    () => dashboardPreviewTaskId ? allTasks.find((t) => t.id === dashboardPreviewTaskId) : undefined,
    [dashboardPreviewTaskId, allTasks]
  )

  const handleEditPreviewTask = useCallback(() => {
    if (dashboardPreviewTaskId) openEditModal(dashboardPreviewTaskId)
  }, [dashboardPreviewTaskId, openEditModal])
  const handleDeletePreviewTask = useCallback(() => {
    if (dashboardPreviewTaskId) openDeleteModal(dashboardPreviewTaskId)
  }, [dashboardPreviewTaskId, openDeleteModal])
  const handleUpdatePreviewAttachments = useCallback(
    async (attachments: FileAttachment[], baseline?: FileAttachment[]) => {
      if (dashboardPreviewTaskId && !await updateTask(dashboardPreviewTaskId, { attachments }, attachmentPrecondition(baseline))) throw new Error(ATTACHMENT_IMPORT_FAILURE)
    },
    [dashboardPreviewTaskId, updateTask]
  )
  const handleUpdatePreviewOutputFields = useCallback(
    async (output_fields: OutputField[]) => {
      if (dashboardPreviewTaskId) await updateTask(dashboardPreviewTaskId, { output_fields })
    },
    [dashboardPreviewTaskId, updateTask]
  )
  const handleCompletePreviewTask = useCallback(async (completeAtSource?: boolean) => {
    if (dashboardPreviewTaskId) await completeTask(dashboardPreviewTaskId, { completeAtSource })
  }, [completeTask, dashboardPreviewTaskId])

  const closeCreate = () => { closeModal(); clearCreateTaskPrefill() }

  const handleCreate = async (data: unknown) => {
    if (creating.current) throw new Error('A previous task creation is still settling. Review the task list before trying again.')
    creating.current = true
    const scope = captureDesktopRead()
    let retained = true
    const releaseModal = useUIStore.subscribe((state, previous) => { if (state.activeModal !== previous.activeModal) retained = false })
    const releaseProject = useProjectStore.subscribe((state, previous) => { if (state.currentProjectId !== previous.currentProjectId) retained = false })
    const isCurrent = () => mounted.current && retained && scope.isCurrent()
    try {
      const formData = { ...data as TaskFormSubmitData }
      const pendingFiles = formData._pendingFiles
      delete formData._pendingFiles
      delete formData._attachmentsBaseline
      const newTask = await createTask(formData)
      if (!newTask) throw new Error('The task could not be created. Check the task list before trying again.')
      // Creation was accepted. Attachment failure must not leave the form able
      // to repeat that create; preserve known receipts and open the real task.
      if (pendingFiles?.length) {
        const baseline = copyAttachmentBaseline(newTask.attachments)
        try {
          const { saved, incomplete } = await importTaskAttachments(newTask.id, pendingFiles.map(file => file.sourcePath), isCurrent)
          if (!isCurrent()) return
          if (saved.length && !await updateTask(newTask.id, { attachments: mergeTaskAttachments(baseline, saved) }, attachmentPrecondition(baseline))) {
            throw new Error(ATTACHMENT_IMPORT_FAILURE)
          }
          if (incomplete && isCurrent()) showToast(ATTACHMENT_IMPORT_FAILURE, true)
        } catch { if (isCurrent()) showToast(ATTACHMENT_IMPORT_FAILURE, true) }
      }
      if (!isCurrent()) return
      closeCreate()
      if (sidebarView === 'canvas') {
        setCanvasPendingTaskId(newTask.id)
      } else {
        selectTask(newTask.id)
        setSidebarView('tasks')
      }
    } finally { releaseModal(); releaseProject(); creating.current = false }
  }

  const handleConfirmDelete = async () => {
    if (!deletingTaskId) return
    if (native) {
      const id = deletingTaskId, intent = formIntent
      if (intent !== formIntentRef.current || useUIStore.getState().activeModal !== 'delete' || useUIStore.getState().deletingTaskId !== id) return
      await deleteReceipt.run(async () => {
        if (deletingTask?.role !== 'task' || !await deleteTask(id)) throw new Error('The deletion could not be confirmed.')
      }, () => {
        const current = useUIStore.getState()
        if (intent !== formIntentRef.current || current.activeModal !== 'delete' || current.deletingTaskId !== id) return
        if (current.canvasPendingTaskId === id) clearCanvasPendingTask()
        if (current.dashboardPreviewTaskId === id) closeDashboardPreview()
        closeModal()
      })
      return
    }
    await stopAndRemoveSessionForTask(deletingTaskId)
    if (deletingTask && deletingTask.repos?.length > 0) {
      try {
        const org = await settingsApi.get('github_org')
        if (org) {
          await worktreeApi.cleanup(
            deletingTaskId,
            deletingTask.repos.map((r) => ({ fullName: r })),
            org
          )
        }
      } catch (error) {
        console.error('Failed to cleanup worktrees:', error)
      }
    }
    try {
      await deleteTask(deletingTaskId)
      if (useUIStore.getState().canvasPendingTaskId === deletingTaskId) {
        clearCanvasPendingTask()
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      showToast(`Failed to delete task: ${reason}`, true)
      return
    }
    if (dashboardPreviewTaskId === deletingTaskId) {
      closeDashboardPreview()
    }
    closeModal()
  }

  return (
    <>
      <Dialog open={activeModal === 'create'} onOpenChange={(open) => { if (!open) closeCreate() }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Task</DialogTitle>
            {/* createTask files the task under the current project. */}
            <DialogDescription>In {currentProject?.name ?? 'Default'}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <TaskForm key={formIntent} prefill={createTaskPrefill} onSubmit={handleCreate} onCancel={closeCreate} />
          </DialogBody>
        </DialogContent>
      </Dialog>

      <Dialog open={activeModal === 'edit'} onOpenChange={(open) => !open && closeModal()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Task</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {editingTask && (
              <TaskForm
                key={formIntent}
                task={editingTask}
                onSubmit={async (data) => {
                  const scope = captureDesktopRead(), intent = formIntentRef.current, id = editingTask.id
                  const update = { ...data as TaskFormSubmitData }, baseline = update._attachmentsBaseline
                  delete update._attachmentsBaseline
                  delete update._pendingFiles
                  const saved = await updateTask(id, update, attachmentPrecondition(baseline))
                  if (!saved) throw new Error('Task save could not be confirmed. Review the task before saving again.')
                  const ui = useUIStore.getState()
                  if (mounted.current && intent === formIntentRef.current && scope.isCurrent() && ui.activeModal === 'edit' && ui.editingTaskId === id) closeModal()
                }}
                onCancel={closeModal}
              />
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>

      <DeleteConfirmDialog
        isOpen={activeModal === 'delete'}
        taskTitle={deletingTask?.title || ''}
        onConfirm={handleConfirmDelete}
        retainUntilReceipt={native}
        blocked={native && (deleteReceipt.blocked || deletingTask?.role !== 'task')}
        failed={native && (deleteReceipt.failed || deleteReceipt.review)}
        retainsWorkspace={native}
        unavailable={native && deletingTask?.role !== 'task'}
        onCancel={closeModal}
      />

      {/* Dashboard task preview — reuses the full TaskWorkspace inside a dialog */}
      <Dialog open={!!dashboardPreviewTaskId} onOpenChange={(open) => { if (!open) closeDashboardPreview() }}>
        <DialogContent className="h-[90vh] w-[94vw] max-w-[94vw] overflow-hidden p-0 [&>button]:hidden">
          <DialogTitle className="sr-only">{dashboardPreviewTask?.title || 'Task preview'}</DialogTitle>
          <div className="min-h-0 flex-1 overflow-hidden rounded-2xl">
            {dashboardPreviewTask && (
              <TaskWorkspace
                task={dashboardPreviewTask}
                agents={agents}
                onEdit={handleEditPreviewTask}
                onDelete={handleDeletePreviewTask}
                onUpdateAttachments={handleUpdatePreviewAttachments}
                onUpdateOutputFields={handleUpdatePreviewOutputFields}
                onCompleteTask={handleCompletePreviewTask}
                onAssignAgent={onAssignAgent}
                onUpdateTask={onUpdateTask}
                onNavigateToTask={onNavigateFromPreview}
                onBack={closeDashboardPreview}
                onOpenFullView={() => dashboardPreviewTaskId && onGoToFullView(dashboardPreviewTaskId)}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
