import { AlertCircle, Check, Inbox, Loader2 } from 'lucide-react'
import type { CommanderMessage } from '@shared/commander'
import { Markdown } from '@/components/ui/Markdown'
import { cn } from '@/lib/utils'
import { toolCallLabel } from './tool-call-label'

export interface ToolChipProps {
  name: string
  input: Record<string, unknown>
  /** undefined while the tool runs. */
  result?: string
  isError?: boolean
}

/** One tool call, e.g. "Asked Project X…", with its state. */
export function ToolChip({ name, input, result, isError }: ToolChipProps) {
  const pending = result === undefined
  const Icon = pending ? Loader2 : isError ? AlertCircle : Check
  return (
    <span
      title={result ?? undefined}
      data-testid="commander-tool-chip"
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs',
        isError ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-border bg-muted text-muted-foreground'
      )}
    >
      <Icon className={cn('size-3 shrink-0', pending && 'animate-spin')} aria-hidden="true" />
      <span className="truncate">{toolCallLabel(name, input)}</span>
    </span>
  )
}

interface MessageItemProps {
  message: CommanderMessage
  /** Tool results by call id, so an assistant message can show its calls' outcomes. */
  toolResults: Map<string, CommanderMessage>
}

export function CommanderMessageItem({ message, toolResults }: MessageItemProps) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground">
          {message.content}
        </div>
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
                <ToolChip key={call.id} name={call.name} input={call.input} result={result?.content ?? ''} isError={result?.is_error} />
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
