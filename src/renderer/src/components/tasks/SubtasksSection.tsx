import React from 'react'
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

function SortableSubtaskItem({ subtask, onNavigateToTask, onOpenSubtaskInWindow }: { subtask: Task; onNavigateToTask?: (taskId: string) => void; onOpenSubtaskInWindow?: (taskId: string) => void }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: subtask.id })

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

export function SubtasksSection({ subtasks, onNavigateToTask, onOpenSubtaskInWindow, onAddSubtask, onReorderSubtasks }: { subtasks: Task[]; onNavigateToTask?: (taskId: string) => void; onOpenSubtaskInWindow?: (taskId: string) => void; onAddSubtask?: (title: string) => void; onReorderSubtasks?: (orderedIds: string[]) => void }) {
  const [isAdding, setIsAdding] = React.useState(false)
  const [newTitle, setNewTitle] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)
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
    if (title && onAddSubtask) {
      onAddSubtask(title)
      setNewTitle('')
      setIsAdding(false)
    }
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = subtasks.findIndex(s => s.id === active.id)
    const newIndex = subtasks.findIndex(s => s.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    const reordered = arrayMove(subtasks, oldIndex, newIndex)
    onReorderSubtasks?.(reordered.map(s => s.id))
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
            onClick={() => setIsAdding(true)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            <Plus className="h-3 w-3" /> Add
          </button>
        )}
      </div>
      <div className="rounded-md border divide-y">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={subtaskIds} strategy={verticalListSortingStrategy}>
            {subtasks.map((subtask) => (
              <SortableSubtaskItem
                key={subtask.id}
                subtask={subtask}
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
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSubmit()
                if (e.key === 'Escape') { setIsAdding(false); setNewTitle('') }
              }}
              onBlur={() => { if (!newTitle.trim()) { setIsAdding(false); setNewTitle('') } }}
              placeholder="Subtask title..."
              className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground/50"
            />
            <button onClick={handleSubmit} className="text-xs text-primary hover:text-primary/80 cursor-pointer">Add</button>
            <button onClick={() => { setIsAdding(false); setNewTitle('') }} className="text-xs text-muted-foreground hover:text-foreground cursor-pointer">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
