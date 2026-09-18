import { useRef, useState, type TouchEvent } from 'react'
import { TaskStatus } from '@shared/constants'
import { cn, STATUS_DOT_COLORS } from '../lib/utils'
import type { Task } from '../stores/task-store'
import { ChevronRightIcon } from './icons'

export function SubtasksSection({ subtasks, onNavigateToTask, onReorderSubtasks }: { subtasks: Task[]; onNavigateToTask: (taskId: string) => void; onReorderSubtasks?: (orderedIds: string[]) => void }) {
  const completedCount = subtasks.filter(s => s.status === TaskStatus.Completed).length
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startY = useRef(0)

  const handleTouchStart = (index: number, e: TouchEvent) => {
    startY.current = e.touches[0].clientY
    longPressTimer.current = setTimeout(() => {
      setDragIndex(index)
      setOverIndex(index)
    }, 300)
  }

  const handleTouchMove = (e: TouchEvent) => {
    // Cancel long press if finger moves too far before activation
    if (dragIndex === null && longPressTimer.current) {
      const dy = Math.abs(e.touches[0].clientY - startY.current)
      if (dy > 10) {
        clearTimeout(longPressTimer.current)
        longPressTimer.current = null
      }
      return
    }
    if (dragIndex === null) return
    e.preventDefault()

    const touchY = e.touches[0].clientY
    for (const [idx, el] of itemRefs.current.entries()) {
      const rect = el.getBoundingClientRect()
      if (touchY >= rect.top && touchY <= rect.bottom) {
        setOverIndex(idx)
        break
      }
    }
  }

  const handleTouchEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
    if (dragIndex !== null && overIndex !== null && dragIndex !== overIndex && onReorderSubtasks) {
      const newOrder = [...subtasks]
      const [moved] = newOrder.splice(dragIndex, 1)
      newOrder.splice(overIndex, 0, moved)
      onReorderSubtasks(newOrder.map(s => s.id))
    }
    setDragIndex(null)
    setOverIndex(null)
  }

  const getDisplayOrder = () => {
    if (dragIndex === null || overIndex === null || dragIndex === overIndex) return subtasks
    const reordered = [...subtasks]
    const [moved] = reordered.splice(dragIndex, 1)
    reordered.splice(overIndex, 0, moved)
    return reordered
  }

  const displaySubtasks = getDisplayOrder()

  return (
    <div className="px-4 py-3 border-b border-border">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>
          </svg>
          Subtasks
          <span className="text-[10px] tabular-nums">({completedCount}/{subtasks.length})</span>
        </span>
      </div>
      <div className="rounded-md border border-border divide-y divide-border">
        {displaySubtasks.map((subtask, idx) => (
          <div
            key={subtask.id}
            ref={(el) => { if (el) itemRefs.current.set(idx, el); else itemRefs.current.delete(idx) }}
            className={cn(
              'flex items-center gap-1 px-1 py-2.5 transition-colors',
              dragIndex !== null && displaySubtasks[idx]?.id === subtasks[dragIndex]?.id && 'bg-accent/30'
            )}
            onTouchStart={(e) => handleTouchStart(idx, e)}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            <div className="shrink-0 p-1 text-muted-foreground/50 touch-none">
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/>
                <circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/>
                <circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/>
              </svg>
            </div>
            <button
              onClick={() => { if (dragIndex === null) onNavigateToTask(subtask.id) }}
              className="flex-1 flex items-center gap-3 text-left min-w-0 pr-2"
            >
              <div className={cn('h-1.5 w-1.5 rounded-full shrink-0', STATUS_DOT_COLORS[subtask.status] || 'bg-muted-foreground')} />
              <div className="min-w-0 flex-1">
                <div className="text-sm truncate">{subtask.title}</div>
              </div>
              <ChevronRightIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
