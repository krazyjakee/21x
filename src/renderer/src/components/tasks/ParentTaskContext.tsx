import React from 'react'
import { ArrowLeft, ChevronRight, ChevronDown } from 'lucide-react'
import { CollapsibleDescription } from '@/components/ui/CollapsibleDescription'
import { Badge } from '@/components/ui/Badge'
import { TaskStatusBadge } from './TaskStatusBadge'
import { TaskPriorityBadge } from './TaskPriorityBadge'
import { TaskTypeBadge } from './TaskTypeBadge'
import type { Task } from '@/types'

export function ParentTaskContext({ parentTask, onNavigateToTask }: { parentTask: Task; onNavigateToTask: (taskId: string) => void }) {
  const [isExpanded, setIsExpanded] = React.useState(false)

  return (
    <div className="mb-4 rounded-lg border border-border/60 bg-accent/30">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2.5 text-left cursor-pointer hover:bg-accent/50 rounded-lg transition-colors"
        >
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
          <span className="text-xs text-muted-foreground shrink-0">Parent task:</span>
          <span className="text-sm truncate">{parentTask.title}</span>
        </button>
        <button
          onClick={() => onNavigateToTask(parentTask.id)}
          className="shrink-0 mr-2 px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer flex items-center gap-1"
          title="Go to parent task"
        >
          <ArrowLeft className="h-3 w-3" />
          Go to parent
        </button>
      </div>
      {isExpanded && (
        <div className="px-4 pb-3 space-y-3 border-t border-border/40">
          <div className="flex items-center gap-2 pt-3">
            <TaskStatusBadge status={parentTask.status} />
            <TaskTypeBadge type={parentTask.type} />
            <TaskPriorityBadge priority={parentTask.priority} />
          </div>
          {parentTask.description && (
            <CollapsibleDescription
              taskId={parentTask.id}
              description={parentTask.description}
              size="sm"
              className="text-sm text-muted-foreground"
            />
          )}
          {parentTask.labels.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {parentTask.labels.map((label) => (
                <Badge key={label} variant="blue" className="text-[10px]">{label}</Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
