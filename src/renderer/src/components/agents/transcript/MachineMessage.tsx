import { useState } from 'react'
import { Bot, ChevronRight, Megaphone, ShieldCheck } from 'lucide-react'
import { Markdown } from '@/components/ui/Markdown'
import type { AgentMessage } from '@shared/transcript/types'
import type { MachineMessageView } from '@shared/transcript/machine-message'

/**
 * A relayed or automated prompt. The chip says where it came from and the
 * body is the request itself; the provenance header, the fence and the
 * standing authority notice the agent was sent are behind the chevron.
 */
export function MachineMessage({
  message,
  view,
  searchQuery
}: {
  message: AgentMessage
  view: MachineMessageView
  searchQuery?: string
}) {
  const [showRaw, setShowRaw] = useState(false)
  const Icon = view.kind === 'commander-relay' ? Megaphone : Bot

  return (
    <div className="flex justify-end">
      <div className="max-w-[90%] min-w-0 overflow-hidden rounded-md bg-secondary text-foreground px-3 py-2">
        <button
          onClick={() => setShowRaw(!showRaw)}
          className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          title={showRaw ? 'Show the request only' : 'Show the full relayed prompt'}
        >
          <Icon className="h-3 w-3 shrink-0" />
          <span>{view.label}</span>
          {view.authorizes && (
            <span className="flex items-center gap-1 text-emerald-400">
              <ShieldCheck className="h-3 w-3" /> merge grant
            </span>
          )}
          <ChevronRight className={`h-3 w-3 transition-transform ${showRaw ? 'rotate-90' : ''}`} />
        </button>
        <Markdown size="sm" highlightQuery={searchQuery}>{showRaw ? message.content : view.body}</Markdown>
        <span className="text-[10px] text-muted-foreground">{message.timestamp.toLocaleTimeString()}</span>
      </div>
    </div>
  )
}
