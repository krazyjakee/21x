import React from 'react'
import { getDesktopHost } from '@/lib/desktop-api'
import { Plus, X, ListTree, ChevronRight, GripVertical, SquareArrowOutUpRight } from 'lucide-react'
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { TaskStatus } from '@/types'
import type { Task } from '@/types'

const subtaskStatusDotColor: Record<TaskStatus, string> = {
  [TaskStatus.NotStarted]: 'bg-muted-foreground',
  [TaskStatus.Triaging]: 'bg-muted-foreground animate-pulse',
  [TaskStatus.AgentWorking]: 'bg-amber-400 animate-pulse',
  [TaskStatus.ReadyForReview]: 'bg-pink-400',
  [TaskStatus.AgentLearning]: 'bg-blue-400 animate-pulse',
  [TaskStatus.Completed]: 'bg-emerald-400'
}

function SortableSubtaskItem({ subtask, onNavigateToTask, onOpenSubtaskInWindow, disabled }: { disabled?: boolean; subtask: Task; onNavigateToTask?: (taskId: string) => void; onOpenSubtaskInWindow?: (taskId: string) => void }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: subtask.id, disabled })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-1 px-1 py-2.5 hover:bg-accent/50 transition-colors"
    >
      <button
        disabled={disabled}
        className="shrink-0 cursor-grab active:cursor-grabbing p-1 text-muted-foreground/50 hover:text-muted-foreground touch-none"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => onNavigateToTask?.(subtask.id)}
        className="flex-1 flex items-center gap-3 text-left cursor-pointer min-w-0 pr-2"
      >
        <div className={`h-2 w-2 rounded-full shrink-0 ${subtaskStatusDotColor[subtask.status]}`} />
        <div className="min-w-0 flex-1">
          <div className="text-sm truncate">{subtask.title}</div>
        </div>
      </button>
      {onOpenSubtaskInWindow && (
        <button
          onClick={(e) => { e.stopPropagation(); onOpenSubtaskInWindow(subtask.id) }}
          title="Open in a separate window"
          aria-label="Open subtask in a separate window"
          className="shrink-0 p-1 rounded text-muted-foreground/50 hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
        >
          <SquareArrowOutUpRight className="h-3.5 w-3.5" />
        </button>
      )}
      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
    </div>
  )
}

export function SubtasksSection({ subtasks, onNavigateToTask, onOpenSubtaskInWindow, onAddSubtask, onReorderSubtasks }: { subtasks: Task[]; onNavigateToTask?: (taskId: string) => void; onOpenSubtaskInWindow?: (taskId: string) => void; onAddSubtask?: (title: string) => void | Promise<void>; onReorderSubtasks?: (orderedIds: string[]) => void | Promise<void> }) {
  const [isAdding, setIsAdding] = React.useState(false)
  const [newTitle, setNewTitle] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)
  const pending = React.useRef(false), active = React.useRef(true), intent = React.useRef(0), refused = React.useRef(false)
  const [busy, setBusy] = React.useState(false)
  const [reviewRequired, setReviewRequired] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    active.current = true
    const retire = () => { active.current = false; ++intent.current; window.removeEventListener('pagehide', retire) }
    window.addEventListener('pagehide', retire, { once: true })
    return retire
  }, [])
  const run = async (action: () => void | Promise<void>, accepted?: () => void) => {
    if (!active.current || pending.current || refused.current) return
    const captured = intent.current
    pending.current = true; setBusy(true); setError(null)
    try { await action(); if (active.current && intent.current === captured) accepted?.() }
    catch {
      if (active.current && (intent.current === captured || getDesktopHost().kind === 'tauri')) {
        setError('Subtask change could not be confirmed. Reopen this task and review its subtasks before trying again.')
        refused.current = getDesktopHost().kind === 'tauri'
        setReviewRequired(refused.current)
      }
    } finally { pending.current = false; if (active.current) setBusy(false) }
  }
  const cancel = () => { ++intent.current; setIsAdding(false); setNewTitle('') }

  const completedCount = subtasks.filter(s => s.status === TaskStatus.Completed).length

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  React.useEffect(() => {
    if (isAdding) inputRef.current?.focus()
  }, [isAdding])

  const handleSubmit = () => {
    const title = newTitle.trim()
    if (title && onAddSubtask) void run(() => onAddSubtask(title), () => { setNewTitle(''); setIsAdding(false) })
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = subtasks.findIndex(s => s.id === active.id)
    const newIndex = subtasks.findIndex(s => s.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    const reordered = arrayMove(subtasks, oldIndex, newIndex)
    if (onReorderSubtasks) void run(() => onReorderSubtasks(reordered.map(s => s.id)))
  }

  const subtaskIds = subtasks.map(s => s.id)

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ListTree className="h-3.5 w-3.5" /> Subtasks
          {subtasks.length > 0 && (
            <span className="text-xs tabular-nums">({completedCount}/{subtasks.length})</span>
          )}
        </div>
        {onAddSubtask && !isAdding && (
          <button
            onClick={() => { ++intent.current; setIsAdding(true) }}
            disabled={busy || reviewRequired}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            <Plus className="h-3 w-3" /> Add
          </button>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="rounded-md border divide-y">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={subtaskIds} strategy={verticalListSortingStrategy}>
            {subtasks.map((subtask) => (
              <SortableSubtaskItem
                key={subtask.id}
                subtask={subtask}
                disabled={busy || reviewRequired}
                onNavigateToTask={onNavigateToTask}
                onOpenSubtaskInWindow={onOpenSubtaskInWindow}
              />
            ))}
          </SortableContext>
        </DndContext>
        {isAdding && (
          <div className="flex items-center gap-2 px-3 py-2">
            <div className="h-2 w-2 rounded-full shrink-0 bg-muted-foreground" />
            <input
              ref={inputRef}
              type="text"
              value={newTitle}
              disabled={busy || reviewRequired}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); handleSubmit() }
                if (e.key === 'Escape') cancel()
              }}
              onBlur={() => { if (!newTitle.trim()) { setIsAdding(false); setNewTitle('') } }}
              placeholder="Subtask title..."
              className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground/50"
            />
            <button disabled={busy || reviewRequired} onClick={handleSubmit} className="text-xs text-primary hover:text-primary/80 cursor-pointer">Add</button>
            <button aria-label="Cancel subtask draft" onClick={cancel} className="text-xs text-muted-foreground hover:text-foreground cursor-pointer">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
