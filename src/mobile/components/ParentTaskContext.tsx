import { useState } from 'react'
import { CollapsibleDescription } from '@/components/ui/CollapsibleDescription'
import { Badge } from '@/components/ui/Badge'
import { TaskBadges } from './TaskBadges'
import { cn } from '../lib/utils'
import type { Task } from '@/types'
import type { Route } from '../App'
import { ChevronLeftIcon, ChevronRightIcon } from './icons'

export function ParentTaskContext({ parentTask, onNavigate }: { parentTask: Task; onNavigate: (route: Route) => void }) {
  const [isExpanded, setIsExpanded] = useState(false)

  return (
    <div className="border-b border-border/30 bg-accent/30">
      <div className="flex items-center gap-1">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex-1 flex items-center gap-2 px-4 py-2.5 text-left active:opacity-60"
        >
          <ChevronRightIcon className={cn('h-3 w-3 text-muted-foreground shrink-0 transition-transform', isExpanded && 'rotate-90')} />
          <span className="text-xs text-muted-foreground shrink-0">Parent task:</span>
          <span className="text-sm truncate">{parentTask.title}</span>
        </button>
        <button
          onClick={() => onNavigate({ page: 'detail', taskId: parentTask.id })}
          className="shrink-0 mr-3 px-2 py-1 text-xs text-muted-foreground active:opacity-60 flex items-center gap-1"
        >
          <ChevronLeftIcon className="h-3 w-3" />
          Go to parent
        </button>
      </div>
      {isExpanded && (
        <div className="px-4 pb-3 space-y-2.5 border-t border-border/30">
          <div className="flex items-center gap-2 pt-2.5 flex-wrap">
            <TaskBadges task={parentTask} />
          </div>
          {parentTask.description && (
            <CollapsibleDescription
              taskId={parentTask.id}
              description={parentTask.description}
              size="sm"
              variant="touch"
            />
          )}
          {parentTask.labels && parentTask.labels.length > 0 && (
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
