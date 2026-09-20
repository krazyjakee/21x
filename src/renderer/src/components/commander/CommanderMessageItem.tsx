import { useId, useState } from 'react'
import { AlertCircle, Ban, Check, ChevronDown, ChevronRight, Inbox, Loader2 } from 'lucide-react'
import type { CommanderMessage } from '@shared/commander'
import { Markdown } from '@/components/ui/Markdown'
import { ChatMessageImages } from '@/components/chat/ChatMessageImages'
import { cachedCommanderImage, loadCommanderImage } from '@/lib/commander-images'
import { cn } from '@/lib/utils'
import { formatToolResult, toolCallLabel } from './tool-call-label'

export interface ToolChipProps {
  name: string
  input: Record<string, unknown>
  /** undefined while the tool runs, unless `notRun` says it never will. */
  result?: string
  isError?: boolean
  /**
   * The call has no result and none is coming: its turn is over. Shown as a
   * failure, never as running and never as a success.
   */
  notRun?: boolean
}

/** Shown for a stored call whose turn ended without recording a result. */
export const TOOL_NOT_RUN_DETAIL = 'Not run: the turn ended before this tool call started.'

/**
 * One tool call, e.g. "Asked Project X…", with its state. The chip stays
 * compact; when the call has a result, the chip is a button that expands the
 * result inline (click, Enter or Space), so it is not hover-only.
 */
export function ToolChip({ name, input, result, isError: resultIsError, notRun = false }: ToolChipProps) {
  const [expanded, setExpanded] = useState(false)
  const regionId = useId()
  const unanswered = result === undefined
  const pending = unanswered && !notRun
  const stopped = unanswered && notRun
  const isError = stopped || resultIsError
  const Icon = pending ? Loader2 : stopped ? Ban : isError ? AlertCircle : Check
  const detail = stopped ? TOOL_NOT_RUN_DETAIL : formatToolResult(result)
  const label = toolCallLabel(name, input)
  const chipClass = cn(
    'inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs',
    isError ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-border bg-muted text-muted-foreground'
  )
  // The icon is decorative; the state is also text for screen readers.
  const stateText = pending ? 'Running' : stopped ? 'Not run' : isError ? 'Failed' : null
  const content = (
    <>
      <Icon className={cn('size-3 shrink-0', pending && 'animate-spin motion-reduce:animate-none')} aria-hidden="true" />
      <span className="truncate">{label}</span>
      {stateText && <span className="sr-only" data-testid="commander-tool-state">{`(${stateText})`}</span>}
    </>
  )

  if (!detail) {
    return <span data-testid="commander-tool-chip" className={chipClass}>{content}</span>
  }

  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <span className={cn('flex max-w-full flex-col gap-1', expanded && 'basis-full')}>
      <button
        type="button"
        data-testid="commander-tool-chip"
        aria-expanded={expanded}
        aria-controls={regionId}
        title={expanded ? 'Hide result' : 'Show result'}
        onClick={() => setExpanded((value) => !value)}
        className={cn(chipClass, 'cursor-pointer self-start text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
      >
        {content}
        <Chevron className="size-3 shrink-0" aria-hidden="true" />
      </button>
      {expanded && (
        <pre
          id={regionId}
          role="region"
          aria-label={`Result: ${label}`}
          data-testid="commander-tool-result"
          className={cn(
            'max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border px-2.5 py-1.5 font-mono text-[11px] leading-relaxed',
            isError ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'border-border bg-muted/40 text-foreground'
          )}
        >
          {detail}
        </pre>
      )}
    </span>
  )
}

interface MessageItemProps {
  message: CommanderMessage
  /** Tool results by call id, so an assistant message can show its calls' outcomes. */
  toolResults: Map<string, CommanderMessage>
  /**
   * True only for the newest message while its session's turn still runs: the
   * one place a stored call can still be waiting for its result. Everywhere
   * else a stored call without a result belongs to a turn that is over
   * (cut off, tool limit, failure, or saved by an older build), and it must
   * not spin for ever (#83).
   */
  turnActive?: boolean
}

export function CommanderMessageItem({ message, toolResults, turnActive = false }: MessageItemProps) {
  if (message.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {message.images && message.images.length > 0 && (
          <ChatMessageImages images={message.images} load={loadCommanderImage} cached={cachedCommanderImage} />
        )}
        {message.content && (
          <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground">
            {message.content}
          </div>
        )}
      </div>
    )
  }

  if (message.role === 'report') {
    return (
      <div data-testid="commander-report" className="rounded-xl border border-border border-l-[3px] border-l-primary bg-primary/5 px-3.5 py-2.5">
        <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
          <Inbox className="size-3.5" aria-hidden="true" />
          <span className="font-medium">Report</span>
          <span className="rounded-md border border-primary/20 bg-primary/10 px-1.5 py-px text-[11px] font-medium text-primary">
            {message.project_id ?? 'Project'}
          </span>
        </div>
        <Markdown size="sm">{message.content}</Markdown>
      </div>
    )
  }

  if (message.role === 'assistant') {
    const calls = message.tool_calls ?? []
    return (
      <div className="flex flex-col gap-1.5">
        {message.content && (
          <div className="max-w-[88%] text-sm text-foreground">
            <Markdown size="sm">{message.content}</Markdown>
          </div>
        )}
        {calls.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {calls.map((call) => {
              const result = toolResults.get(call.id)
              return (
                <ToolChip
                  key={call.id}
                  name={call.name}
                  input={call.input}
                  result={result?.content}
                  isError={result?.is_error}
                  notRun={!result && !turnActive}
                />
              )
            })}
          </div>
        )}
      </div>
    )
  }

  // Tool results render inside their assistant's chips; summaries are model context only.
  return null
}
