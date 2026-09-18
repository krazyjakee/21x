import { useCallback, useMemo } from 'react'
import { TaskWorkspace } from '@/components/tasks/TaskWorkspace'
import { TaskForm, type TaskFormSubmitData } from '@/components/tasks/TaskForm'
import { DeleteConfirmDialog } from '@/components/tasks/DeleteConfirmDialog'
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle } from '@/components/ui/Dialog'
import { useUIStore } from '@/stores/ui-store'
import { useTaskStore } from '@/stores/task-store'
import { useAgentStore } from '@/stores/agent-store'
import { attachmentApi, worktreeApi, settingsApi } from '@/lib/ipc-client'
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

  const activeModal = useUIStore((s) => s.activeModal)
  const closeModal = useUIStore((s) => s.closeModal)
  const editingTaskId = useUIStore((s) => s.editingTaskId)
  const deletingTaskId = useUIStore((s) => s.deletingTaskId)
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
    async (attachments: FileAttachment[]) => {
      if (dashboardPreviewTaskId) await updateTask(dashboardPreviewTaskId, { attachments })
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
    const formData = data as TaskFormSubmitData
    const pendingFiles = formData._pendingFiles
    delete formData._pendingFiles

    const newTask = await createTask(formData)
    if (newTask && pendingFiles?.length) {
      const attachments: FileAttachment[] = []
      for (const pf of pendingFiles) {
        const a = await attachmentApi.save(newTask.id, pf.sourcePath)
        attachments.push(a)
      }
      await updateTask(newTask.id, { attachments })
    }
    closeCreate()
    if (newTask) {
      if (sidebarView === 'canvas') {
        setCanvasPendingTaskId(newTask.id)
      } else {
        selectTask(newTask.id)
        setSidebarView('tasks')
      }
    }
  }

  const handleConfirmDelete = async () => {
    if (!deletingTaskId) return
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
          </DialogHeader>
          <DialogBody>
            <TaskForm prefill={createTaskPrefill} onSubmit={handleCreate} onCancel={closeCreate} />
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
                task={editingTask}
                onSubmit={async (data) => {
                  await updateTask(editingTask.id, data)
                  closeModal()
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
