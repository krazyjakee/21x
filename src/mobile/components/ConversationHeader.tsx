import type { ReactNode } from 'react'
import { SessionStatus } from '@shared/constants'
import type { TranscriptSearch } from '@/components/agents/transcript/useTranscriptSearch'
import { cn } from '../lib/utils'
import { ICON_PROPS } from './icons'
import { BackButton } from './PageHeader'

function HeaderIconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:bg-white/5 hover:text-foreground active:opacity-60 transition-colors"
    >
      <svg className="h-3.5 w-3.5" {...ICON_PROPS}>{children}</svg>
    </button>
  )
}

interface ConversationHeaderProps {
  title: string
  messageCount: number
  /** Undefined when the task has no session entry yet. */
  status?: SessionStatus
  isStarting: boolean
  canRestart: boolean
  canStop: boolean
  canStart: boolean
  canResume: boolean
  onBack: () => void
  onToggleSearch: () => void
  onRestart: () => void
  onStop: () => void
  onStart: () => void
  onResume: () => void
}

/** Mirrors the desktop AgentTranscriptPanel header. */
export function ConversationHeader(props: ConversationHeaderProps) {
  const { status, isStarting } = props
  return (
    <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-border/50">
      <div className="flex items-center gap-2 min-w-0">
        <BackButton
          onBack={props.onBack}
          className="p-1.5 shrink-0 active:opacity-60 hover:bg-accent rounded-md transition-colors"
          iconClassName="w-4 h-4 text-muted-foreground"
        />
        <svg className="h-4 w-4 text-muted-foreground shrink-0" {...ICON_PROPS}>
          <polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>
        </svg>
        <span className="text-sm font-medium truncate">
          {props.title}
          <span className="ml-2 text-xs font-mono text-muted-foreground">
            ({props.messageCount})
          </span>
        </span>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {status && (
          <span className={cn(
            'text-xs flex items-center gap-1',
            isStarting && 'text-green-400',
            !isStarting && status === SessionStatus.WORKING && 'text-green-400',
            !isStarting && status === SessionStatus.ERROR && 'text-red-400',
            !isStarting && status === SessionStatus.WAITING_APPROVAL && 'text-yellow-400',
            !isStarting && status === SessionStatus.IDLE && 'text-muted-foreground'
          )}>
            {(isStarting || status === SessionStatus.WORKING) && (
              <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            )}
            {isStarting ? 'Starting…' : (
              <>
                {status === SessionStatus.WORKING && 'Working'}
                {status === SessionStatus.IDLE && 'Idle'}
                {status === SessionStatus.ERROR && '● Error'}
                {status === SessionStatus.WAITING_APPROVAL && '● Waiting'}
              </>
            )}
          </span>
        )}
        <div className="flex items-center gap-1">
          <HeaderIconButton title="Search transcript" onClick={props.onToggleSearch}>
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
          </HeaderIconButton>
          {props.canRestart && (
            <HeaderIconButton title="Restart session" onClick={props.onRestart}>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
              <path d="M3 3v5h5"/>
            </HeaderIconButton>
          )}
          {props.canStop && (
            <HeaderIconButton title="Stop session" onClick={props.onStop}>
              <circle cx="12" cy="12" r="10"/><rect x="9" y="9" width="6" height="6"/>
            </HeaderIconButton>
          )}
          {props.canStart && (
            <HeaderIconButton title="Start agent" onClick={props.onStart}>
              <polygon points="6 3 20 12 6 21 6 3"/>
            </HeaderIconButton>
          )}
          {props.canResume && (
            <HeaderIconButton title="Resume session" onClick={props.onResume}>
              <polygon points="6 3 20 12 6 21 6 3"/>
            </HeaderIconButton>
          )}
        </div>
      </div>
    </div>
  )
}

function SearchNavButton({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-white/5 hover:text-foreground disabled:opacity-40"
    >
      <svg className="h-3.5 w-3.5" {...ICON_PROPS}>{children}</svg>
    </button>
  )
}

export function ConversationSearchBar({ search }: { search: TranscriptSearch }) {
  const noResults = search.resultCount === 0
  return (
    <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-border/50">
      <div className="relative min-w-0 flex-1">
        <svg className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" {...ICON_PROPS}>
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
        </svg>
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
      <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{search.counter}</span>
      <SearchNavButton title="Previous result" onClick={() => search.goToResult(-1)} disabled={noResults}>
        <path d="m18 15-6-6-6 6"/>
      </SearchNavButton>
      <SearchNavButton title="Next result" onClick={() => search.goToResult(1)} disabled={noResults}>
        <path d="m6 9 6 6 6-6"/>
      </SearchNavButton>
      <SearchNavButton title="Close search" onClick={search.close}>
        <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
      </SearchNavButton>
    </div>
  )
}
