import { useState } from 'react'
import { AlertTriangle, ChevronRight, Circle, Loader2, Terminal } from 'lucide-react'
import { Markdown } from '@/components/ui/Markdown'
import type { AgentMessage } from '@shared/transcript/types'
import { formatDuration } from '@shared/transcript/tool-format'
import { HighlightedText } from './HighlightedText'

export function TaskProgressMessage({ message, searchQuery }: { message: AgentMessage; searchQuery?: string }) {
  const [expanded, setExpanded] = useState(false)
  const tp = message.taskProgress!
  const isRunning = tp.status === 'started' || tp.status === 'running'
  const isError = tp.status === 'failed'
  const isDone = tp.status === 'completed'
  const isStopped = tp.status === 'stopped'

  return (
    <div className={`rounded-md bg-card border overflow-hidden ${
      isError ? 'border-red-500/30' : isStopped ? 'border-yellow-500/30' : isDone ? 'border-border/50' : 'border-blue-500/30'
    }`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-mono hover:bg-white/5 transition-colors"
      >
        <ChevronRight className={`h-3 w-3 text-muted-foreground shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        <Terminal className="h-3 w-3 text-blue-400 shrink-0" />
        <span className="text-foreground truncate"><HighlightedText text={tp.description || 'Subagent task'} query={searchQuery} /></span>
        {tp.lastToolName && isRunning && (
          <span className="text-muted-foreground text-[10px] truncate">· <HighlightedText text={tp.lastToolName} query={searchQuery} /></span>
        )}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {tp.usage && (
            <span className="text-[10px] text-muted-foreground">
              {tp.usage.tool_uses} tools · {formatDuration(tp.usage.duration_ms)}
            </span>
          )}
          {isRunning && <Loader2 className="h-3 w-3 text-blue-400 animate-spin" />}
          {isError && <AlertTriangle className="h-3 w-3 text-red-400" />}
          {isStopped && <Circle className="h-3 w-3 text-yellow-400" />}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border/30 px-3 py-2 space-y-2">
          {tp.summary && (
            <div className="text-xs">
              <Markdown size="sm" highlightQuery={searchQuery}>{tp.summary}</Markdown>
            </div>
          )}
          {tp.usage && (
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground font-mono">
              <span>{tp.usage.tool_uses} tool uses</span>
              <span>{tp.usage.total_tokens.toLocaleString()} tokens</span>
              <span>{formatDuration(tp.usage.duration_ms)}</span>
            </div>
          )}
          {!tp.summary && !tp.usage && (
            <div className="text-[11px] text-muted-foreground">No additional details available</div>
          )}
        </div>
      )}
    </div>
  )
}
