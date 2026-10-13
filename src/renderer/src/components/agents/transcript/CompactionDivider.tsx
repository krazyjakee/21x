import type { AgentMessage } from '@shared/transcript/types'

export function CompactionDivider({ message }: { message: AgentMessage }) {
  return (
    <div role="separator" aria-label="Conversation context compacted" className="my-3 border-y border-border py-3 text-muted-foreground">
      <p className="text-sm font-medium">Context compacted</p>
      <p className="mt-1 text-sm leading-relaxed">{message.content}</p>
    </div>
  )
}
