import { FileText } from 'lucide-react'
import { Markdown } from '@/components/ui/Markdown'
import type { AgentMessage } from '@shared/transcript/types'
import { HighlightedText } from './HighlightedText'

export function PlanReviewMessage({ message, searchQuery }: { message: AgentMessage; searchQuery?: string }) {
  const tool = message.tool
  const label = tool?.title || message.content || 'Plan mode'
  const rawOutput = tool?.output || ''
  // Confirmation prompts carry no useful content.
  const details = /^(exit|enter) plan mode\??$/i.test(rawOutput.trim()) ? '' : rawOutput

  return (
    <div className="rounded-md bg-card border border-border/50 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 text-xs font-mono">
        <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="text-foreground"><HighlightedText text={label} query={searchQuery} /></span>
      </div>
      {details && (
        <div className="px-3 py-2 border-t border-border/30 max-h-[60vh] overflow-y-auto">
          <Markdown size="xs" highlightQuery={searchQuery}>{details}</Markdown>
        </div>
      )}
    </div>
  )
}
