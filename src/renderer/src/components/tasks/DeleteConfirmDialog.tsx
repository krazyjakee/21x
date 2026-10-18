import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel
} from '@/components/ui/AlertDialog'

interface DeleteConfirmDialogProps {
  isOpen: boolean
  taskTitle: string
  onConfirm: () => void
  onCancel: () => void
  retainUntilReceipt?: boolean
  blocked?: boolean
  failed?: boolean
  retainsWorkspace?: boolean
  unavailable?: boolean
}

export function DeleteConfirmDialog({ isOpen, taskTitle, onConfirm, onCancel, retainUntilReceipt, blocked, failed, retainsWorkspace, unavailable }: DeleteConfirmDialogProps) {
  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Task</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete "{taskTitle}"? This action cannot be undone.
            {retainsWorkspace && ' Workspace directories are retained for separate cleanup.'}
          </AlertDialogDescription>
          {unavailable && <p role="alert">Use the owning project or group controls for this row.</p>}
          {failed && !unavailable && <p role="alert">Deletion could not be confirmed. Close and review the task before trying again.</p>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={blocked} onClick={(event) => { if (retainUntilReceipt) event.preventDefault(); onConfirm() }}>Delete Task</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
