import type { AgentMessage } from '@shared/transcript/types'
import { ContextDivider } from '@/components/context/ContextDivider'

export function CompactionDivider({ message }: { message: AgentMessage }) {
  return <ContextDivider kind="compaction" title="Context compacted" summary={message.content} />
}
