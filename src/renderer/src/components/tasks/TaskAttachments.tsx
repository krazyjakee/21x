import { rehydrateTaskDesktopState, useTaskStore } from '@/stores/task-store'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'
import { useNativeAttachmentDrop } from '@/hooks/use-native-attachment-drop'
import { captureDesktopRead, desktopApi, getDesktopHost } from '@/lib/desktop-api'
import { useState, useCallback, useEffect, useRef } from 'react'
import { Paperclip, X, FileText, Download } from 'lucide-react'
import { attachmentApi } from '@/lib/ipc-client'
import type { FileAttachment } from '@/types'
import { formatFileSize } from '@/lib/utils'
import { ATTACHMENT_IMPORT_FAILURE, copyAttachmentBaseline, importTaskAttachments, mergeTaskAttachments, NATIVE_FILE_DROP_MESSAGE } from '@/lib/task-attachment-import'

export interface PendingFile {
  id: string
  filename: string
  size: number
  sourcePath: string
}

interface TaskAttachmentsProps {
  items: FileAttachment[]
  onChange: (items: FileAttachment[], baseline?: FileAttachment[]) => void | Promise<void>
  taskId: string | null
  onNativeRemovalSettled?: (attachmentId: string, canonical: FileAttachment[] | undefined) => void
  readOnly?: boolean
  disabled?: boolean
  pendingFiles?: PendingFile[]
  onPendingChange?: (files: PendingFile[]) => void
}

export function TaskAttachments({
  items,
  onChange,
  taskId,
  readOnly = false,
  disabled = false,
  pendingFiles = [],
  onPendingChange,
  onNativeRemovalSettled
}: TaskAttachmentsProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [reviewRequired, setReviewRequired] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dropRoot = useRef<HTMLDivElement | null>(null)
  const pending = useRef(false), mounted = useRef(true), review = useRef(false)
  const current = useRef({ taskId, items, pendingFiles, onChange, onPendingChange, onNativeRemovalSettled })
  current.current = { taskId, items, pendingFiles, onChange, onPendingChange, onNativeRemovalSettled }
  useEffect(() => {
    mounted.current = true
    const retire = () => { mounted.current = false; window.removeEventListener('pagehide', retire) }
    window.addEventListener('pagehide', retire, { once: true })
    return retire
  }, [])

  const run = async (action: (isCurrent: () => boolean) => Promise<void>, allowReadOnly = false, failureMessage = ATTACHMENT_IMPORT_FAILURE) => {
    if (disabled || pending.current || (readOnly || review.current) && !allowReadOnly) return
    const owner = taskId, scope = captureDesktopRead()
    let retained = true
    const offProject = useProjectStore.subscribe((state, previous) => { if (state.currentProjectId !== previous.currentProjectId) retained = false })
    const offUi = useUIStore.subscribe((state, previous) => {
      if (state.activeModal !== previous.activeModal || state.editingTaskId !== previous.editingTaskId || state.dashboardPreviewTaskId !== previous.dashboardPreviewTaskId) retained = false
    })
    const isCurrent = () => retained && mounted.current && current.current.taskId === owner && scope.isCurrent()
    pending.current = true; setBusy(true); setError(null)
    try { await action(isCurrent) }
    catch { if (isCurrent()) setError(failureMessage) }
    finally { offProject(); offUi(); pending.current = false; if (mounted.current) setBusy(false) }
  }

  const processFilePaths = useCallback(
    async (filePaths: string[], isCurrent: () => boolean) => {
      if (!filePaths.length || !isCurrent()) return

      if (taskId) {
        const baseline = copyAttachmentBaseline(current.current.items)
        const { saved, incomplete } = await importTaskAttachments(taskId, filePaths, isCurrent)
        if (!isCurrent()) return
        if (saved.length) {
          const next = mergeTaskAttachments(baseline, saved)
          if (getDesktopHost().kind === 'tauri') await current.current.onChange(next, baseline)
          else await current.current.onChange(next)
          if (isCurrent()) current.current.items = next
        }
        if (incomplete && isCurrent()) setError(ATTACHMENT_IMPORT_FAILURE)
      } else {
        const existing = new Set(current.current.pendingFiles.map(file => file.sourcePath))
        const pending: PendingFile[] = filePaths.filter(fp => !existing.has(fp)).map((fp) => ({
          id: crypto.randomUUID(),
          filename: fp.split(/[\\/]/).pop() || fp,
          size: 0,
          sourcePath: fp
        }))
        current.current.onPendingChange?.([...current.current.pendingFiles, ...pending])
      }
    },
    [taskId]
  )

  useNativeAttachmentDrop({
    root: dropRoot, identity: taskId ?? 'new-task-draft', enabled: !readOnly,
    busy: () => disabled || review.current || pending.current,
    capacity: () => 128 - current.current.items.length - current.current.pendingFiles.length,
    consume: async (paths, receiptCurrent) => {
      await run(async localCurrent => { await processFilePaths(paths, () => localCurrent() && receiptCurrent()) })
    },
    error: () => { if (mounted.current) setError(ATTACHMENT_IMPORT_FAILURE) },
    pendingPaths: taskId ? undefined : pendingFiles.map(file => file.sourcePath),
    retirePending: paths => {
      if (!mounted.current) return
      const previous = current.current.pendingFiles, next = previous.filter(file => !paths.includes(file.sourcePath))
      if (next.length !== previous.length) current.current.onPendingChange?.(next)
    }
  })

  const handleAdd = async () => {
    await run(async isCurrent => {
      const filePaths = await attachmentApi.pick()
      await processFilePaths(filePaths, isCurrent)
    })
  }

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (readOnly || disabled || reviewRequired) return
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(true)
    },
    [readOnly, disabled, reviewRequired]
  )

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (readOnly || disabled || reviewRequired) return
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)
    },
    [readOnly, disabled, reviewRequired]
  )

  const handleDrop = (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)
      if (readOnly || disabled || reviewRequired) return

      if (getDesktopHost().kind === 'tauri') {
        setError(NATIVE_FILE_DROP_MESSAGE)
        return
      }

      void run(async isCurrent => {
        const filePaths = Array.from(e.dataTransfer.files).map(f => desktopApi.webUtils.getPathForFile(f)).filter(Boolean)
        await processFilePaths(filePaths, isCurrent)
      })
  }

  const handleRemove = async (attachment: FileAttachment) => {
    const attachmentId = attachment.id
    const failureMessage = 'Attachment removal could not be fully confirmed. Reopen the task and review its saved attachments before trying again.'
    await run(async isCurrent => {
      if (getDesktopHost().kind === 'tauri' && taskId) {
        // Source owns the exact-ID metadata delta before raw unlink. A rejected
        // reply can still follow an accepted delta; read canonical state and
        // never submit a second full-array replacement or replay the unlink.
        let failed = false, canonical: FileAttachment[] | undefined
        try { await attachmentApi.remove(taskId, attachmentId) } catch { failed = true }
        if (!isCurrent()) return
        try {
          await rehydrateTaskDesktopState()
          if (!isCurrent()) return
          const saved = useTaskStore.getState().tasks.find(task => task.id === taskId)
          if (saved) canonical = copyAttachmentBaseline(saved.attachments)
        } catch { failed = true }
        if (!isCurrent()) return
        const uncertain = failed || !canonical || canonical.some(item => item.id === attachmentId)
        // Admission must close before React paints disabled draft controls.
        if (uncertain || current.current.onNativeRemovalSettled) { review.current = true; setReviewRequired(true) }
        current.current.onNativeRemovalSettled?.(attachmentId, canonical)
        if (uncertain) {
          throw new Error(failureMessage)
        }
        return
      }
      const baseline = copyAttachmentBaseline(current.current.items)
      if (taskId) await attachmentApi.remove(taskId, attachmentId)
      if (isCurrent()) await current.current.onChange(baseline.filter(item => item.id !== attachmentId))
    }, false, failureMessage)
  }

  const handleRemovePending = (id: string) => {
    onPendingChange?.(pendingFiles.filter((f) => f.id !== id))
  }

  const handleOpen = (attachment: FileAttachment) => {
    if (taskId) void run(async () => { await attachmentApi.open(taskId, attachment.id) }, true)
  }

  const handleDownload = (attachment: FileAttachment) => {
    if (taskId) void run(async () => { await attachmentApi.download(taskId, attachment.id) }, true)
  }

  const totalCount = items.length + pendingFiles.length

  return (
    <div
      ref={dropRoot}
      className={`relative space-y-2 rounded-md p-2 -m-2 transition-colors ${
        isDragging ? 'border-2 border-dashed border-primary/50 bg-primary/5' : 'border-2 border-transparent'
      }`}
      role="group"
      aria-label="Attachments"
      aria-busy={busy}
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-md bg-primary/5 pointer-events-none">
          <span className="text-sm font-medium text-primary">Drop files here</span>
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Attachments</span>
        {totalCount > 0 && (
          <span className="text-xs text-muted-foreground">{totalCount} file{totalCount !== 1 ? 's' : ''}</span>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {(items.length > 0 || pendingFiles.length > 0) && (
        <div className="space-y-1" role="list">
          {items.map((a) => (
            <div key={a.id} className="flex items-center gap-2 group" role="listitem">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <button
                type="button"
                onClick={() => handleOpen(a)}
                disabled={busy || disabled}
                className="text-sm flex-1 text-left truncate hover:underline cursor-pointer"
                title="Click to preview"
              >
                {a.filename}
              </button>
              <span className="text-xs text-muted-foreground shrink-0">{formatFileSize(a.size)}</span>
              <button
                type="button"
                onClick={() => handleDownload(a)}
                disabled={busy || disabled}
                className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground cursor-pointer"
                title="Download to Downloads folder"
              >
                <Download className="h-3.5 w-3.5" />
              </button>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => handleRemove(a)}
                  disabled={busy || disabled || reviewRequired}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive cursor-pointer"
                  title="Remove attachment"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
          {pendingFiles.map((f) => (
            <div key={f.id} className="flex items-center gap-2 group" role="listitem">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-sm flex-1 truncate">{f.filename}</span>
              <span className="text-xs text-muted-foreground shrink-0">pending</span>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => handleRemovePending(f.id)}
                  aria-label={`Remove ${f.filename}`}
                  disabled={busy || disabled || reviewRequired}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {!readOnly && (
        <button
          type="button"
          onClick={handleAdd}
          disabled={busy || disabled || reviewRequired}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground cursor-pointer"
        >
          <Paperclip className="h-3.5 w-3.5" />
          Add files
        </button>
      )}
    </div>
  )
}
