import { useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, Circle, Clock, ListTodo } from 'lucide-react'
import type { AgentMessage, AgentTodo } from '@shared/transcript/types'
import { HighlightedText } from './HighlightedText'

/** `compact` is the smaller, pulsing variant used in the pinned summary. */
function TodoStatusIcon({ status, compact }: { status: AgentTodo['status']; compact?: boolean }) {
  const size = compact ? 'h-3 w-3' : 'h-3.5 w-3.5'
  switch (status) {
    case 'completed': return <CheckCircle2 className={`${size} text-green-400 shrink-0`} />
    case 'in_progress': return <Clock className={`${size} text-yellow-400 shrink-0${compact ? ' animate-pulse' : ''}`} />
    default: return <Circle className={`${size} text-muted-foreground shrink-0`} />
  }
}

export function TodoWriteMessage({ message, searchQuery }: { message: AgentMessage; searchQuery?: string }) {
  const todos = message.tool?.todos || []
  const completed = todos.filter((t) => t.status === 'completed').length

  return (
    <div className="rounded-md bg-card border border-border/50 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/30">
        <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Tasks</span>
        <span className="text-[10px] text-muted-foreground ml-auto">{completed}/{todos.length} done</span>
      </div>
      <div className="px-3 py-2 space-y-1">
        {todos.map((todo) => (
          <div
            key={todo.id}
            className={`flex items-start gap-2.5 rounded px-2 py-1.5 text-xs ${
              todo.status === 'completed' ? 'opacity-60' : ''
            }`}
          >
            <TodoStatusIcon status={todo.status} />
            <span className={`${todo.status === 'completed' ? 'line-through text-muted-foreground' : 'text-foreground'}`}>
              <HighlightedText text={todo.content} query={searchQuery} />
            </span>
          </div>
        ))}
      </div>
      <div className="px-4 pb-2">
        <span className="text-[10px] text-muted-foreground">{message.timestamp.toLocaleTimeString()}</span>
      </div>
    </div>
  )
}

/** Latest todo list, pinned above the transcript. */
export function TodoSummary({ todos }: { todos: AgentTodo[] }) {
  const [expanded, setExpanded] = useState(true)
  if (todos.length === 0) return null

  const completed = todos.filter((t) => t.status === 'completed').length
  const inProgress = todos.filter((t) => t.status === 'in_progress').length

  return (
    <div className="border-b border-border/50 shrink-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2 text-xs hover:bg-white/5 transition-colors"
      >
        {expanded
          ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
          : <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
        }
        <ListTodo className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
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
              className={`flex items-start gap-2 rounded px-2 py-1 text-xs ${
                todo.status === 'completed' ? 'opacity-50' : ''
              }`}
            >
              <TodoStatusIcon status={todo.status} compact />
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
