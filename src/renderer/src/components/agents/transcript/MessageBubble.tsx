import { memo } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Markdown } from '@/components/ui/Markdown'
import { SpeakMessageButton } from '@/components/voice/SpeakMessageButton'
import type { AgentMessage, StepMeta } from '@shared/transcript/types'
import { isCompactActivityMessage } from '@shared/transcript/tool-format'
import { ActivityMessageGroup } from './ActivityMessageGroup'
import { PlanReviewMessage } from './PlanReviewMessage'
import { QuestionMessage } from './QuestionMessage'
import { TaskProgressMessage } from './TaskProgressMessage'
import { TodoWriteMessage } from './TodoMessages'

function formatStepMeta(meta: StepMeta): string {
  const parts: string[] = []
  if (meta.durationMs != null) parts.push(`${(meta.durationMs / 1000).toFixed(1)}s`)
  if (meta.tokens) {
    const t = meta.tokens
    const items = [`in:${t.input}`, `out:${t.output}`]
    if (t.cache) items.push(`cache:${t.cache}`)
    parts.push(items.join(' '))
  }
  return parts.join(' · ')
}

interface MessageBubbleProps {
  message: AgentMessage
  onAnswer?: (answer: string) => void
  canAnswerQuestion?: boolean
  searchQuery?: string
}

export const MessageBubble = memo(function MessageBubble({ message, onAnswer, canAnswerQuestion = false, searchQuery }: MessageBubbleProps) {
  if (message.partType === 'question' && message.tool?.questions) {
    return <QuestionMessage message={message} onAnswer={onAnswer} canAnswer={canAnswerQuestion} searchQuery={searchQuery} />
  }

  if (message.partType === 'todowrite' && message.tool?.todos) {
    return <TodoWriteMessage message={message} searchQuery={searchQuery} />
  }

  if (message.partType === 'planreview') {
    return <PlanReviewMessage message={message} searchQuery={searchQuery} />
  }

  if (isCompactActivityMessage(message)) {
    return <ActivityMessageGroup messages={[message]} searchQuery={searchQuery} />
  }

  if (message.partType === 'task_progress' && message.taskProgress) {
    return <TaskProgressMessage message={message} searchQuery={searchQuery} />
  }

  // Step markers are absorbed into stepMeta and system status into
  // session.systemStatus — skip any that slip through.
  if (message.partType === 'step-start' || message.partType === 'step-finish' || message.partType === 'system-status') {
    return null
  }

  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  const isError = message.partType === 'error' || message.partType === 'retry'

  return (
    <div className={`flex gap-2 ${isUser ? 'justify-end' : 'justify-start'} ${!isUser ? 'w-full' : ''}`}>
      <div
        className={`overflow-hidden min-w-0 ${
          isError
            ? 'w-full text-red-200 border-l border-red-500/40 pl-3 py-1'
            : isUser
              ? 'max-w-[90%] rounded-md px-3 py-2 bg-secondary text-foreground'
              : isSystem
                ? 'w-full text-yellow-200 border-l border-yellow-500/40 pl-3 py-1'
                : 'w-full text-foreground/80 py-1'
        }`}
      >
        {isError && (
          <span className="text-[10px] text-red-400 flex items-center gap-1 mb-1">
            <AlertTriangle className="h-3 w-3" /> Error
          </span>
        )}
        <Markdown size="sm" highlightQuery={searchQuery}>{message.content}</Markdown>
        <div className={`flex items-center gap-2 mt-1 ${!isUser ? 'opacity-70' : ''}`}>
          <span className="text-[10px] text-muted-foreground">{message.timestamp.toLocaleTimeString()}</span>
          {message.stepMeta && (
            <span className="text-[10px] text-muted-foreground">{formatStepMeta(message.stepMeta)}</span>
          )}
          {/* Only a plain agent answer can be read aloud. An error and a system
              line are not answers, and a user message is the user's own words. */}
          {!isUser && !isSystem && !isError && <SpeakMessageButton text={message.content} />}
        </div>
      </div>
    </div>
  )
})
