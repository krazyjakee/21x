import { memo, useRef, useEffect, useCallback, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { buildTranscriptItems, findActiveQuestionId, findLatestTodos, type TranscriptItem } from '@shared/transcript/transcript-items'
import { useTranscriptAutoScroll } from '@/components/agents/transcript/useTranscriptAutoScroll'
import { useTranscriptSearch } from '@/components/agents/transcript/useTranscriptSearch'
import { useTaskStore } from '../stores/task-store'
import { useAgentStore, SessionStatus, type AgentMessage } from '../stores/agent-store'
import { api } from '../api/client'
import { useSessionControls } from '../hooks/useSessionControls'
import { MessageActivityGroup, MessageBubble } from '../components/MessageBubble'
import { ArtifactCard } from '../components/ArtifactCard'
import type { ChatInputAttachment } from '../components/ChatInput'
import { ConversationHeader, ConversationSearchBar } from '../components/ConversationHeader'
import { ConversationInput } from '../components/ConversationInput'
import { PinnedTodoSummary } from '../components/PinnedTodoSummary'
import { useArtifactStore } from '../stores/artifact-store'
import type { Route } from '../App'

// Stable empty list — a fresh `[]` per render would invalidate every memo and
// effect keyed on `messages` while no session exists.
const EMPTY_MESSAGES: AgentMessage[] = []

const TranscriptRow = memo(function TranscriptRow({
  item,
  activeQuestionId,
  normalizedSearchQuery,
  onAnswer
}: {
  item: TranscriptItem
  activeQuestionId: string | null
  normalizedSearchQuery: string
  onAnswer: (answer: string) => void
}) {
  if (item.type === 'activity') {
    return <MessageActivityGroup messages={item.messages} searchQuery={normalizedSearchQuery} />
  }

  return (
    <MessageBubble
      message={item.message}
      onAnswer={onAnswer}
      canAnswerQuestion={item.message.id === activeQuestionId}
      searchQuery={normalizedSearchQuery}
    />
  )
})

export function ConversationPage({ taskId, onNavigate }: { taskId: string; onNavigate: (route: Route) => void }) {
  const task = useTaskStore((s) => s.tasks.find((t) => t.id === taskId))
  const session = useAgentStore((s) => s.sessions.get(taskId))
  const initSession = useAgentStore((s) => s.initSession)
  const bindTranscript = useAgentStore((s) => s.bindTranscript)
  const beginSend = useAgentStore((s) => s.beginSend)
  const endSend = useAgentStore((s) => s.endSend)
  const artifactsByTask = useArtifactStore((s) => s.artifactsByTask)
  const hydrateArtifacts = useArtifactStore((s) => s.hydrate)
  const artifacts = artifactsByTask.get(taskId) || []

  // Bind this task's transcript from the durable projection on open (and taskId
  // change). The view renders projection state; live updates arrive as deltas.
  useEffect(() => {
    void bindTranscript(taskId)
  }, [taskId, bindTranscript])

  useEffect(() => {
    void hydrateArtifacts(taskId)
  }, [hydrateArtifacts, taskId])

  const scrollRef = useRef<HTMLDivElement>(null)
  const messages = session?.messages || EMPTY_MESSAGES
  const transcriptItems = useMemo(() => buildTranscriptItems(messages), [messages])
  const search = useTranscriptSearch(transcriptItems)
  const normalizedSearchQuery = search.normalizedQuery

  const isWorking = session?.status === SessionStatus.WORKING
  const isWaitingApproval = session?.status === SessionStatus.WAITING_APPROVAL
  const hasSession = !!session?.sessionId
  // The user sent a message and the backend is still resuming the session.
  const isStarting = !!session?.pendingSend && !isWorking && !isWaitingApproval

  const activeQuestionId = useMemo(() => findActiveQuestionId(messages), [messages])

  // An unanswered question routes the composer's text as its answer.
  const isQuestion = !!activeQuestionId

  // Can the user send input? Blocked while the session is starting (resuming)
  // to prevent a confusing double-send during the init window.
  const canSendInput = hasSession && !isStarting && (isWorking || isWaitingApproval || session?.status === SessionStatus.IDLE)
  const taskAttachments = useMemo(
    () => (Array.isArray(task?.attachments) ? task.attachments : []) as ChatInputAttachment[],
    [task?.attachments]
  )

  const latestTodos = useMemo(() => findLatestTodos(messages), [messages])

  const placeholder = useMemo(() => {
    if (!hasSession) return 'No active session'
    if (isStarting) return 'Starting agent…'
    if (isQuestion) return 'Type your answer...'
    if (isWaitingApproval) return 'Approve or provide feedback...'
    return 'Write a message...'
  }, [hasSession, isStarting, isQuestion, isWaitingApproval])

  // Mirrors desktop TaskWorkspace.handleSend.
  const handleSend = useCallback(
    async (message: string, options?: { attachments?: ChatInputAttachment[] }): Promise<boolean> => {
      // Read the latest session from the store; the closure's copy may be stale.
      const currentSession = useAgentStore.getState().sessions.get(taskId)
      if (!currentSession?.sessionId) return false
      try {
        if (isQuestion) {
          const activeQuestion = currentSession.messages.find((item) => item.id === activeQuestionId)
          const responseType = activeQuestion?.tool?.name === 'permission' ? 'permission' : 'question'
          await api.sessions.approve(currentSession.sessionId, true, message, responseType, activeQuestion?.tool?.requestId)
        } else {
          // Resuming an idle session is slow. Show "starting" immediately (the
          // send request blocks until the resume completes) so the UI isn't
          // stuck on "Idle" with an open input. Cleared by the first non-idle
          // status (see the store) or here on failure.
          beginSend(taskId)
          const result = await api.sessions.send(
            currentSession.sessionId,
            message,
            taskId,
            currentSession.agentId,
            options?.attachments
          )
          if (result.newSessionId && taskId) {
            initSession(taskId, result.newSessionId, currentSession.agentId)
          }
        }
        return true
      } catch (e) {
        console.error('Failed to send message:', e)
        endSend(taskId)
        return false
      }
    },
    [taskId, isQuestion, activeQuestionId, initSession, beginSend, endSend]
  )

  const handleAnswer = useCallback(
    async (answer: string) => {
      const currentSession = useAgentStore.getState().sessions.get(taskId)
      if (!currentSession?.sessionId || !activeQuestionId) return
      try {
        const activeQuestion = currentSession.messages.find((item) => item.id === activeQuestionId)
        const responseType = activeQuestion?.tool?.name === 'permission' ? 'permission' : 'question'
        await api.sessions.approve(currentSession.sessionId, true, answer, responseType, activeQuestion?.tool?.requestId)
      } catch (e) {
        console.error('Failed to send answer:', e)
      }
    },
    [taskId, activeQuestionId]
  )

  // Session controls (shared hook provides double-click protection and rollback)
  const { handleStart: _startSession, handleResume: _resumeSession, handleStop: _stopSession, handleRestart: _restartSession } = useSessionControls(taskId)

  const handleStart = useCallback(() => {
    if (task?.agent_id) _startSession(task.agent_id)
  }, [task?.agent_id, _startSession])

  const handleResume = useCallback(() => {
    if (task?.agent_id && task?.session_id) _resumeSession(task.agent_id, task.session_id)
  }, [task?.agent_id, task?.session_id, _resumeSession])

  const handleStop = useCallback(() => {
    if (session?.sessionId) _stopSession(session.sessionId)
  }, [session?.sessionId, _stopSession])

  const handleRestart = useCallback(() => {
    if (task?.agent_id && session?.sessionId) _restartSession(task.agent_id, session.sessionId)
  }, [task?.agent_id, session?.sessionId, _restartSession])

  const virtualizer = useVirtualizer({
    count: transcriptItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    overscan: 8
  })
  const { handleScroll, scrollToBottom, showScrollToBottom } = useTranscriptAutoScroll({
    items: transcriptItems,
    virtualizer,
    scrollRef,
    activeSearchItemIndex: search.activeItemIndex,
    bottomThreshold: 80
  })

  // Session state flags — matches TaskDetailPage logic
  const isSessionRunning = session?.sessionId && (session.status === SessionStatus.WORKING || session.status === SessionStatus.WAITING_APPROVAL)
  const canStart = task?.agent_id && !task.session_id && (!session || session.status === SessionStatus.IDLE) && task.status !== 'completed'
  const canResume = task?.agent_id && task.session_id && !isSessionRunning && !session?.sessionId && (!session || session.status === SessionStatus.IDLE)
  const canStop = isSessionRunning

  return (
    <div className="flex flex-col h-full bg-background">
      <ConversationHeader
        title={task?.title || 'Agent transcript'}
        messageCount={messages.length}
        status={session?.status}
        isStarting={isStarting}
        canRestart={messages.length > 0 && hasSession}
        canStop={!!canStop}
        canStart={!!canStart}
        canResume={!!canResume}
        onBack={() => onNavigate({ page: 'detail', taskId })}
        onToggleSearch={search.toggle}
        onRestart={handleRestart}
        onStop={handleStop}
        onStart={handleStart}
        onResume={handleResume}
      />

      {search.isOpen && <ConversationSearchBar search={search} />}

      {latestTodos && <PinnedTodoSummary todos={latestTodos} />}

      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto p-4 space-y-2 text-sm"
        >
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
              {!hasSession && !canStart && !canResume && (
                <>
                  <svg className="h-8 w-8 opacity-20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>
                  </svg>
                  <p className="text-xs">No agent session available</p>
                </>
              )}
              {(canStart || canResume) && (
                <>
                  <svg className="h-8 w-8 opacity-20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>
                  </svg>
                  <p className="text-xs">No messages yet</p>
                  <button
                    onClick={canResume ? handleResume : handleStart}
                    className="bg-primary text-primary-foreground text-xs font-medium px-4 py-2 rounded-md active:opacity-80 mt-2 hover:bg-primary/90"
                  >
                    {canResume ? 'Resume Session' : 'Start Agent'}
                  </button>
                </>
              )}
              {hasSession && messages.length === 0 && (
                <>
                  <svg className="h-8 w-8 opacity-30 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                  </svg>
                  <p className="text-xs">Starting agent session...</p>
                </>
              )}
            </div>
          )}

          {/* System status bar (e.g. 'Compacting conversation history…') */}
          {session?.systemStatus && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-yellow-500/10 rounded-md border border-yellow-500/20">
              <svg className="h-3 w-3 text-yellow-400 animate-spin shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
              </svg>
              <span className="text-xs text-yellow-300">{session.systemStatus}</span>
            </div>
          )}

          {artifacts.length > 0 && (
            <div className="space-y-2 pb-2" aria-label="Task artifacts">
              {artifacts.slice(0, 3).map((artifact) => (
                <ArtifactCard
                  key={`${artifact.id}:${artifact.reloadTrigger}`}
                  artifact={artifact}
                  onOpen={() => onNavigate({ page: 'artifact', taskId, artifactId: artifact.id })}
                />
              ))}
            </div>
          )}

          {messages.length > 0 && (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const item = transcriptItems[virtualRow.index]
                return (
                  <div
                    key={item.key}
                    ref={virtualizer.measureElement}
                    data-index={virtualRow.index}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      transform: `translateY(${virtualRow.start}px)`
                    }}
                  >
                    <div className="pb-2 rounded-md">
                      <TranscriptRow
                        item={item}
                        activeQuestionId={activeQuestionId}
                        normalizedSearchQuery={normalizedSearchQuery}
                        onAnswer={handleAnswer}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {isWorking && messages.length > 0 && (
            <div className="flex items-center gap-2 px-3 py-2">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
                <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse [animation-delay:0.2s]" />
                <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse [animation-delay:0.4s]" />
              </div>
              <span className="text-xs text-muted-foreground">Agent is working...</span>
            </div>
          )}
        </div>

        {showScrollToBottom && messages.length > 0 && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full bg-card border border-border/50 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-border shadow-lg transition-all duration-200 opacity-80 hover:opacity-100 active:opacity-100"
            title="Scroll to bottom"
          >
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>
            </svg>
            <span>Bottom</span>
          </button>
        )}
      </div>

      <ConversationInput
        onSend={handleSend}
        disabled={!canSendInput}
        placeholder={placeholder}
        taskAttachments={taskAttachments}
      />
    </div>
  )
}
