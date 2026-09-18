import { useState } from 'react'
import type { AgentTodo } from '@shared/transcript/types'
import { cn } from '../lib/utils'
import { ChevronRightIcon, ICON_PROPS } from './icons'

function TodoStatusIcon({ status }: { status: AgentTodo['status'] }) {
  if (status === 'completed') {
    return (
      <svg className="h-3.5 w-3.5 text-green-400 shrink-0 mt-0.5" {...ICON_PROPS}>
        <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="m9 12 2 2 4-4"/>
      </svg>
    )
  }
  if (status === 'in_progress') {
    return (
      <svg className="h-3.5 w-3.5 text-yellow-400 shrink-0 mt-0.5" {...ICON_PROPS}>
        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
      </svg>
    )
  }
  if (status === 'pending') {
    return (
      <svg className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" {...ICON_PROPS}>
        <circle cx="12" cy="12" r="10"/>
      </svg>
    )
  }
  return null
}

/** Latest todo list, pinned above the transcript (mirrors desktop TodoSummary). */
export function PinnedTodoSummary({ todos }: { todos: AgentTodo[] }) {
  const [expanded, setExpanded] = useState(false)
  const completed = todos.filter((t) => t.status === 'completed').length
  const inProgress = todos.filter((t) => t.status === 'in_progress').length

  return (
    <div className="border-b border-border/50 shrink-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2 text-xs hover:bg-white/5 transition-colors"
      >
        <ChevronRightIcon className={cn('h-3 w-3 text-muted-foreground shrink-0 transition-transform', expanded && 'rotate-90')} />
        <svg className="h-3.5 w-3.5 text-muted-foreground shrink-0" {...ICON_PROPS}>
          <rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>
        </svg>
        <span className="text-muted-foreground font-medium">Tasks</span>
        <span className="text-muted-foreground ml-auto tabular-nums">
          {completed}/{todos.length}
          {inProgress > 0 && <span className="text-yellow-400 ml-1.5">({inProgress} active)</span>}
        </span>
      </button>
      {expanded && (
        <div className="px-4 pb-2.5 space-y-0.5">
          {todos.map((todo) => (
            <div
              key={todo.id}
              className={cn('flex items-start gap-2 rounded px-2 py-1 text-xs', todo.status === 'completed' && 'opacity-50')}
            >
              <TodoStatusIcon status={todo.status} />
              <span className={todo.status === 'completed' ? 'line-through text-muted-foreground' : 'text-foreground'}>
                {todo.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
