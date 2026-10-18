import { copyAttachmentBaseline } from '@/lib/task-attachment-import'
import { useState, useEffect, useRef } from 'react'
import { useProjectStore } from '@/stores/project-store'
import { captureDesktopRead, getDesktopHost } from '@/lib/desktop-api'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Label } from '@/components/ui/Label'
import { TaskAttachments, type PendingFile } from './TaskAttachments'
import { OutputFieldsEditor } from './OutputFieldsEditor'
import { RecurrenceEditor } from './RecurrenceEditor'
import { TaskStatus, TASK_TYPES, TASK_PRIORITIES, TASK_STATUSES } from '@/types'
import type {
  Task,
  CreateTaskDTO,
  UpdateTaskDTO,
  FileAttachment,
  OutputField,
  TaskType,
  TaskPriority,
  RecurrencePattern
} from '@/types'

export interface TaskFormSubmitData extends CreateTaskDTO {
  _pendingFiles?: PendingFile[]
  _attachmentsBaseline?: FileAttachment[]
}

interface TaskFormProps {
  task?: Task
  prefill?: { title: string; description: string } | null
  onSubmit: (data: TaskFormSubmitData | UpdateTaskDTO) => Promise<void>
  onCancel: () => void
}

export function TaskForm({ task, prefill, onSubmit, onCancel }: TaskFormProps) {
  const [title, setTitle] = useState(prefill?.title || '')
  const [description, setDescription] = useState(prefill?.description || '')
  const [type, setType] = useState<TaskType>('general')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [status, setStatus] = useState<TaskStatus>(TaskStatus.NotStarted)
  const [assignee, setAssignee] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [labels, setLabels] = useState('')
  const attachmentsBaseline = useRef(copyAttachmentBaseline(task?.attachments ?? []))
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const [outputFields, setOutputFields] = useState<OutputField[]>([])
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [recurrencePattern, setRecurrencePattern] = useState<RecurrencePattern | null>(null)
  const [autoStartAgent, setAutoStartAgent] = useState(false)
  const [autoCompleteWithoutReview, setAutoCompleteWithoutReview] = useState(false)
  const initialScope = useRef(captureDesktopRead())
  const active = useRef(true)
  const generation = useRef(0)
  const review = useRef(false)
  const [reviewRequired, setReviewRequired] = useState(false)
  const submitting = useRef(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Collapsible "Additional fields" — collapsed by default, auto-expands on edit with values
  const [showMore, setShowMore] = useState(false)

  useEffect(() => {
    active.current = true
    const host = getDesktopHost()
    const fence = () => {
      if (!active.current) return
      ++generation.current; review.current = true; setReviewRequired(true); setIsSubmitting(false)
      setSubmitError('Task context changed. Close this draft and review the saved task before saving again.')
    }
    const offConnection = host.kind === 'tauri' ? host.subscribeConnection(() => { if (!initialScope.current.isSameConnection()) fence() }) : () => {}
    const offProject = host.kind === 'tauri' ? useProjectStore.subscribe((state, previous) => { if (state.currentProjectId !== previous.currentProjectId) fence() }) : () => {}
    const retire = () => { active.current = false; ++generation.current; offConnection(); offProject(); window.removeEventListener('pagehide', retire) }
    window.addEventListener('pagehide', retire, { once: true })
    return retire
  }, [])

  useEffect(() => {
    ++generation.current
    if (task) {
      setTitle(task.title)
      setDescription(task.description)
      setType(task.type)
      setPriority(task.priority)
      setStatus(task.status)
      setAssignee(task.assignee)
      setDueDate(task.due_date ? task.due_date.slice(0, 10) : '')
      setLabels(task.labels.join(', '))
      attachmentsBaseline.current = copyAttachmentBaseline(task.attachments)
      setAttachments(copyAttachmentBaseline(task.attachments))
      setOutputFields(task.output_fields)
      setRecurrencePattern(task.recurrence_pattern)
      setAutoStartAgent(task.auto_start_agent)
      setAutoCompleteWithoutReview(task.auto_complete_without_review)

      // Auto-expand if task has non-default values in optional fields
      if (
        task.type !== 'general' ||
        task.priority !== 'medium' ||
        task.due_date ||
        task.labels.length > 0 ||
        task.output_fields.length > 0 ||
        task.recurrence_pattern
      ) {
        setShowMore(true)
      }
    }
  }, [task?.id])

  const hasOptionalValues = type !== 'general' || priority !== 'medium' || dueDate || labels || outputFields.length > 0 || !!recurrencePattern

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || submitting.current || review.current || !active.current || getDesktopHost().kind === 'tauri' && !initialScope.current.isCurrent()) return
    const intent = generation.current
    const current = () => active.current && generation.current === intent

    submitting.current = true
    setIsSubmitting(true)
    setSubmitError(null)
    try {
      const parsedLabels = labels
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean)

      const formData: TaskFormSubmitData = {
        title: title.trim(),
        description,
        type,
        priority,
        status,
        assignee,
        due_date: dueDate ? new Date(dueDate).toISOString() : null,
        labels: parsedLabels,
        attachments,
        output_fields: outputFields,
        is_recurring: !!recurrencePattern,
        recurrence_pattern: recurrencePattern,
        auto_start_agent: !!recurrencePattern && autoStartAgent,
        auto_complete_without_review: !!recurrencePattern && autoCompleteWithoutReview
      }

      if (task && getDesktopHost().kind === 'tauri') formData._attachmentsBaseline = copyAttachmentBaseline(attachmentsBaseline.current)

      if (!task && pendingFiles.length > 0) {
        formData._pendingFiles = pendingFiles
      }

      await onSubmit(formData)
    } catch (err) {
      if (!current()) return
      if (getDesktopHost().kind === 'tauri') {
        review.current = true; setReviewRequired(true)
        setSubmitError('Task save could not be confirmed. Close this draft and review the task list before saving again.')
      } else setSubmitError(err instanceof Error ? err.message : String(err))
    } finally {
      submitting.current = false
      if (current()) setIsSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <fieldset disabled={isSubmitting || reviewRequired} className="space-y-5 border-0 p-0 m-0 min-w-0">
      <div className="space-y-2">
        <Label htmlFor="title">Title</Label>
        <Input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs to be done?"
          required
          autoFocus
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Add details, context, or notes..."
          rows={3}
        />
      </div>

      <div className="rounded-md border p-4">
        <TaskAttachments
          items={attachments}
          onChange={next => setAttachments(next)}
          onNativeRemovalSettled={(attachmentId, canonical) => {
            review.current = true
            if (canonical && !canonical.some(item => item.id === attachmentId)) setAttachments(previous => previous.filter(item => item.id !== attachmentId))
            // Do not replace the original baseline to authorize other stale edits.
            setReviewRequired(true)
            setSubmitError('Attachment removal needs review. Close this draft and review the saved task before saving other edits.')
          }}
          taskId={task?.id ?? null}
          disabled={isSubmitting || reviewRequired}
          readOnly={getDesktopHost().kind === 'tauri' && !!task && task.role !== 'task'}
          pendingFiles={pendingFiles}
          onPendingChange={setPendingFiles}
        />
      </div>

      {/* Collapsible additional fields — same pattern as mobile */}
      <button
        type="button"
        onClick={() => setShowMore(!showMore)}
        className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors py-1 cursor-pointer"
      >
        <ChevronRight className={`h-3 w-3 transition-transform ${showMore ? 'rotate-90' : ''}`} />
        Additional fields
        {!showMore && hasOptionalValues && (
          <span className="text-primary text-[10px]">(has values)</span>
        )}
      </button>

      {showMore && (
        <div className="space-y-5 pl-1">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="type">Type</Label>
              <Select id="type" value={type} onChange={(e) => setType(e.target.value as TaskType)} options={TASK_TYPES} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="priority">Priority</Label>
              <Select id="priority" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)} options={TASK_PRIORITIES} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="status">Status</Label>
              <Select id="status" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)} options={TASK_STATUSES} />
            </div>
            {task?.source_id && (
              <div className="space-y-2">
                <Label htmlFor="assignee">Assignee</Label>
                <p className="text-sm text-muted-foreground py-1">{assignee || 'Unassigned'}</p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="dueDate">Due Date</Label>
              <Input id="dueDate" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="labels">Labels</Label>
              <Input id="labels" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="bug, feature..." />
            </div>
          </div>

          <div className="rounded-md border p-4">
            <OutputFieldsEditor fields={outputFields} onChange={setOutputFields} />
          </div>

          <div className="rounded-md border p-4">
            <RecurrenceEditor value={recurrencePattern} onChange={setRecurrencePattern} />
            {recurrencePattern && (
              <div className="space-y-3 pt-4 mt-4 border-t border-border" data-testid="auto-flags-section">
                <p className="text-sm font-medium text-muted-foreground">Automation</p>
                <label className="flex items-center gap-2 cursor-pointer" data-testid="form-auto-start-toggle">
                  <input
                    type="checkbox"
                    checked={autoStartAgent}
                    onChange={(e) => setAutoStartAgent(e.target.checked)}
                    className="h-4 w-4 rounded border-border bg-background text-primary cursor-pointer"
                  />
                  <span className="text-sm">Auto-start agent on new instances</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer" data-testid="form-auto-complete-toggle">
                  <input
                    type="checkbox"
                    checked={autoCompleteWithoutReview}
                    onChange={(e) => setAutoCompleteWithoutReview(e.target.checked)}
                    className="h-4 w-4 rounded border-border bg-background text-primary cursor-pointer"
                  />
                  <span className="text-sm">Auto-complete without review</span>
                </label>
              </div>
            )}
          </div>
        </div>
      )}

      </fieldset>
      {submitError && (
        <p className="text-sm text-destructive">{submitError}</p>
      )}

      <div className="flex justify-end gap-3 pt-4 border-t">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={!title.trim() || isSubmitting || reviewRequired}>
          {isSubmitting ? 'Saving...' : task ? 'Save Changes' : 'Create Task'}
        </Button>
      </div>
    </form>
  )
}
