import type { MouseEvent } from 'react'
import { ArrowDown, ArrowUp, Loader2, RotateCcw, Search, StopCircle, Terminal, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { SessionStatus } from '@shared/constants'
import type { TranscriptSearch } from './useTranscriptSearch'

interface TranscriptHeaderProps {
  title: string
  messageCount: number
  status: SessionStatus
  isStarting: boolean
  onToggleSearch: () => void
  onRestart?: () => void
  onStop: () => void
  onContextMenu: (e: MouseEvent) => void
}

function statusColor(status: SessionStatus, isStarting: boolean): string {
  if (isStarting) return 'text-green-400'
  switch (status) {
    case SessionStatus.WORKING: return 'text-green-400'
    case SessionStatus.ERROR: return 'text-red-400'
    case SessionStatus.WAITING_APPROVAL: return 'text-yellow-400'
    default: return 'text-muted-foreground'
  }
}

function statusLabel(status: SessionStatus, isStarting: boolean): string {
  if (isStarting) return 'Starting…'
  switch (status) {
    case SessionStatus.WORKING: return 'Working'
    case SessionStatus.ERROR: return 'Error'
    case SessionStatus.WAITING_APPROVAL: return 'Waiting for approval'
    default: return 'Idle'
  }
}

export function TranscriptHeader({ title, messageCount, status, isStarting, onToggleSearch, onRestart, onStop, onContextMenu }: TranscriptHeaderProps) {
  return (
    // windows-titlebar-safe adds right padding on Windows to avoid the title bar overlay.
    <div
      className="flex items-center justify-between px-4 py-3 border-b border-border/60 shrink-0 windows-titlebar-safe"
      onContextMenu={onContextMenu}
      title="Right-click to copy debug info"
    >
      <div className="flex items-center gap-2">
        <Terminal className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">
          {title}
          <span className="ml-2 text-xs font-mono text-muted-foreground">
            ({messageCount})
          </span>
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className={`text-xs flex items-center gap-1 ${statusColor(status, isStarting)}`}>
          {(isStarting || status === SessionStatus.WORKING) && <Loader2 className="h-3 w-3 animate-spin" />}
          {statusLabel(status, isStarting)}
        </span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onToggleSearch} className="h-7 px-2" title="Search transcript">
            <Search className="h-3.5 w-3.5" />
          </Button>
          {onRestart && messageCount > 0 && (
            <Button variant="ghost" size="sm" onClick={onRestart} className="h-7 px-2" title="Restart session">
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          )}
          {(status === SessionStatus.WORKING || status === SessionStatus.WAITING_APPROVAL) && (
            <Button variant="ghost" size="sm" onClick={onStop} className="h-7 px-2" title="Stop session">
              <StopCircle className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

export function TranscriptSearchBar({ search }: { search: TranscriptSearch }) {
  const noResults = search.resultCount === 0
  return (
    <div className="flex items-center gap-2 border-b border-border/50 px-4 py-2 shrink-0">
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={search.inputRef}
          type="search"
          value={search.query}
          onChange={(e) => search.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') search.close()
            if (e.key === 'Enter') {
              e.preventDefault()
              search.goToResult(e.shiftKey ? -1 : 1)
            }
          }}
          placeholder="Search transcript..."
          className="h-8 w-full rounded-md border border-input bg-transparent pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring/30"
        />
      </div>
      <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{search.counter}</span>
      <Button type="button" variant="ghost" size="icon" onClick={() => search.goToResult(-1)} disabled={noResults} className="h-8 w-8" title="Previous result">
        <ArrowUp className="h-3.5 w-3.5" />
      </Button>
      <Button type="button" variant="ghost" size="icon" onClick={() => search.goToResult(1)} disabled={noResults} className="h-8 w-8" title="Next result">
        <ArrowDown className="h-3.5 w-3.5" />
      </Button>
      <Button type="button" variant="ghost" size="icon" onClick={search.close} className="h-8 w-8" title="Close search">
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
