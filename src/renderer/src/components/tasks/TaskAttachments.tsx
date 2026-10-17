import { captureDesktopRead, desktopApi, getDesktopHost } from '@/lib/desktop-api'
import { useState, useCallback, useEffect, useRef } from 'react'
import { Paperclip, X, FileText, Download } from 'lucide-react'
import { attachmentApi } from '@/lib/ipc-client'
import type { FileAttachment } from '@/types'
import { formatFileSize } from '@/lib/utils'
import { ATTACHMENT_IMPORT_FAILURE, importTaskAttachments, mergeTaskAttachments, NATIVE_FILE_DROP_MESSAGE } from '@/lib/task-attachment-import'

export interface PendingFile {
  id: string
  filename: string
  size: number
  sourcePath: string
}

interface TaskAttachmentsProps {
  items: FileAttachment[]
  onChange: (items: FileAttachment[]) => void | Promise<void>
  taskId: string | null
  readOnly?: boolean
  pendingFiles?: PendingFile[]
  onPendingChange?: (files: PendingFile[]) => void
}

export function TaskAttachments({
  items,
  onChange,
  taskId,
  readOnly = false,
  pendingFiles = [],
  onPendingChange
}: TaskAttachmentsProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false), mounted = useRef(true)
  const current = useRef({ taskId, items, pendingFiles, onChange, onPendingChange })
  current.current = { taskId, items, pendingFiles, onChange, onPendingChange }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const run = async (action: (isCurrent: () => boolean) => Promise<void>, allowReadOnly = false) => {
    if (pending.current || readOnly && !allowReadOnly) return
    const owner = taskId, scope = captureDesktopRead()
    const isCurrent = () => mounted.current && current.current.taskId === owner && scope.isCurrent()
    pending.current = true; setBusy(true); setError(null)
    try { await action(isCurrent) }
    catch { if (isCurrent()) setError(ATTACHMENT_IMPORT_FAILURE) }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }

  const processFilePaths = useCallback(
    async (filePaths: string[], isCurrent: () => boolean) => {
      if (!filePaths.length || !isCurrent()) return

      if (taskId) {
        const { saved, incomplete } = await importTaskAttachments(taskId, filePaths, isCurrent)
        if (!isCurrent()) return
        if (saved.length) {
          const next = mergeTaskAttachments(current.current.items, saved)
          await current.current.onChange(next)
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

  const handleAdd = async () => {
    await run(async isCurrent => {
      const filePaths = await attachmentApi.pick()
      await processFilePaths(filePaths, isCurrent)
    })
  }

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (readOnly) return
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(true)
    },
    [readOnly]
  )

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (readOnly) return
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)
    },
    [readOnly]
  )

  const handleDrop = (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)
      if (readOnly) return

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
    await run(async isCurrent => {
      if (taskId) await attachmentApi.remove(taskId, attachment.id)
      if (isCurrent()) await current.current.onChange(current.current.items.filter(a => a.id !== attachment.id))
    })
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
                disabled={busy}
                className="text-sm flex-1 text-left truncate hover:underline cursor-pointer"
                title="Click to preview"
              >
                {a.filename}
              </button>
              <span className="text-xs text-muted-foreground shrink-0">{formatFileSize(a.size)}</span>
              <button
                type="button"
                onClick={() => handleDownload(a)}
                disabled={busy}
                className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground cursor-pointer"
                title="Download to Downloads folder"
              >
                <Download className="h-3.5 w-3.5" />
              </button>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => handleRemove(a)}
                  disabled={busy}
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
                  disabled={busy}
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
          disabled={busy}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground cursor-pointer"
        >
          <Paperclip className="h-3.5 w-3.5" />
          Add files
        </button>
      )}
    </div>
  )
}
