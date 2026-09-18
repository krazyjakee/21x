import { memo, type ComponentProps } from 'react'
import { AgentTranscriptPanel } from '@/components/agents/AgentTranscriptPanel'
import { useAgentStore, SessionStatus, type AgentMessage } from '@/stores/agent-store'

const EMPTY_MESSAGES: AgentMessage[] = []

type TranscriptHandlers = Pick<
  ComponentProps<typeof AgentTranscriptPanel>,
  'onStop' | 'onRestart' | 'onSend' | 'onPickAttachments' | 'onAddAttachmentPaths'
>

interface TaskTranscriptPaneProps extends TranscriptHandlers {
  taskId: string
  agentId?: string
}

/**
 * Owns the streamed-session subscription so per-delta re-renders stay inside the
 * transcript instead of re-rendering the whole TaskWorkspace.
 */
export const TaskTranscriptPane = memo(function TaskTranscriptPane({ taskId, agentId, ...handlers }: TaskTranscriptPaneProps) {
  const messages = useAgentStore((s) => s.sessions.get(taskId)?.messages ?? EMPTY_MESSAGES)
  const status = useAgentStore((s) => s.sessions.get(taskId)?.status ?? SessionStatus.IDLE)
  const systemStatus = useAgentStore((s) => s.sessions.get(taskId)?.systemStatus)
  const sessionId = useAgentStore((s) => s.sessions.get(taskId)?.sessionId ?? null)
  const pendingSend = useAgentStore((s) => s.sessions.get(taskId)?.pendingSend)

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <AgentTranscriptPanel
        {...handlers}
        messages={messages}
        status={status}
        systemStatus={systemStatus}
        sessionId={sessionId}
        taskId={taskId}
        agentId={agentId}
        pendingSend={pendingSend}
        className="h-full min-h-0 border-0 bg-background"
      />
    </div>
  )
})
