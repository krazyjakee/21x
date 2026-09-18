import { isCompactActivityMessage } from '@shared/transcript/tool-format'
import { MessageActivityGroup, MessageBubble } from './MessageBubble'
import type { AgentMessage } from '../stores/agent-store'
import type { Route } from '../App'

const PREVIEW_MESSAGE_COUNT = 3

export function TranscriptPreview({ taskId, messages, onNavigate }: {
  taskId: string
  messages: AgentMessage[]
  onNavigate: (route: Route) => void
}) {
  const previewMessages = messages.slice(-PREVIEW_MESSAGE_COUNT)
  const openConversation = () => onNavigate({ page: 'conversation', taskId })

  return (
    <div className="px-4 py-3">
      <button onClick={openConversation} className="w-full text-left">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>
            Agent Transcript
          </span>
          <span className="text-xs text-primary">Open →</span>
        </div>
      </button>
      {messages.length > 0 && (
        <>
          <div className="space-y-2 bg-background rounded-md border border-border/50 p-3">
            {previewMessages.map((msg, index) => {
              if (!isCompactActivityMessage(msg)) {
                return <MessageBubble key={msg.id} message={msg} />
              }
              if (index > 0 && isCompactActivityMessage(previewMessages[index - 1])) return null

              const group = [msg]
              for (let nextIndex = index + 1; nextIndex < previewMessages.length && isCompactActivityMessage(previewMessages[nextIndex]); nextIndex += 1) {
                group.push(previewMessages[nextIndex])
              }
              // Stable key (first member) so a growing trailing group doesn't remount.
              return <MessageActivityGroup key={group[0].id} messages={group} />
            })}
          </div>
          {messages.length > PREVIEW_MESSAGE_COUNT && (
            <button
              onClick={openConversation}
              className="w-full text-center text-xs text-primary mt-2 py-2 active:opacity-60 font-mono"
            >
              View all {messages.length} messages
            </button>
          )}
        </>
      )}
    </div>
  )
}
