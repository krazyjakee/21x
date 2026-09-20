import { useRef, useEffect, useState, useMemo, useCallback, type MouseEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Loader2, Terminal, AlertTriangle, ArrowDown } from 'lucide-react'
import type { AgentMessage } from '@/hooks/use-agent-session'
import { SessionStatus } from '@/stores/agent-store'
import { serializeTranscriptForDebug, type RawTranscriptMessage } from '@/lib/serialize-transcript-debug'
import { agentSessionApi } from '@/lib/ipc-client'
import { cn } from '@/lib/utils'
import { useArtifactStore } from '@/stores/artifact-store'
import type { Artifact } from '@shared/artifacts'
import { buildTranscriptItems, findActiveQuestionId, findLatestTodos } from '@shared/transcript/transcript-items'
import { ActivityMessageGroup } from './transcript/ActivityMessageGroup'
import { MessageBubble } from './transcript/MessageBubble'
import { TodoSummary } from './transcript/TodoMessages'
import { TranscriptComposer, type ComposerAttachment, type SaveImagesHandler, type SendHandler } from './transcript/TranscriptComposer'
import { TranscriptHeader, TranscriptSearchBar } from './transcript/TranscriptHeader'
import { useTranscriptAutoScroll } from './transcript/useTranscriptAutoScroll'
import { useTranscriptSearch } from './transcript/useTranscriptSearch'

const EMPTY_ARTIFACTS: Artifact[] = []

interface AgentTranscriptPanelProps {
  title?: string
  messages: AgentMessage[]
  status: SessionStatus
  onStop: () => void
  onRestart?: () => void
  /** May be async: a rejected send is reported to the user instead of vanishing. */
  onSend?: SendHandler
  onPickAttachments?: () => Promise<ComposerAttachment[]>
  onAddAttachmentPaths?: (filePaths: string[]) => Promise<ComposerAttachment[]>
  /** Stores pasted images (#144); without it the composer refuses them. */
  onSaveImages?: SaveImagesHandler
  className?: string
  /** Transient system status (e.g. 'Compacting conversation history…') */
  systemStatus?: string | null
  /** Session metadata for debug copy (hidden feature) */
  sessionId?: string | null
  taskId?: string
  agentId?: string
  /** User sent a message and the backend is still resuming the session. */
  pendingSend?: boolean
  /** Text the user typed and sent (not dictated); see TranscriptComposer. */
  onTypedMessage?: (text: string) => void
}

export function AgentTranscriptPanel({
  title = 'Agent transcript',
  messages,
  status,
  onStop,
  onRestart,
  onSend,
  onPickAttachments,
  onAddAttachmentPaths,
  onSaveImages,
  className,
  systemStatus,
  sessionId,
  taskId,
  agentId,
  pendingSend,
  onTypedMessage
}: AgentTranscriptPanelProps) {
  // The user sent and the backend is still resuming — status still reads idle.
  const isStarting = !!pendingSend && status !== SessionStatus.WORKING && status !== SessionStatus.WAITING_APPROVAL
  const scrollRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [debugCopyToast, setDebugCopyToast] = useState(false)
  const taskArtifacts = useArtifactStore((state) => taskId ? (state.artifactsByTask[taskId] || EMPTY_ARTIFACTS) : EMPTY_ARTIFACTS)
  const selectArtifactTab = useArtifactStore((state) => state.selectTab)
  const handleOpenArtifact = useCallback((artifact: Artifact) => {
    selectArtifactTab(artifact.taskId, artifact.id, true)
  }, [selectArtifactTab])

  const transcriptItems = useMemo(() => buildTranscriptItems(messages), [messages])
  const latestTodos = useMemo(() => findLatestTodos(messages), [messages])
  const activeQuestionId = useMemo(() => findActiveQuestionId(messages), [messages])
  const search = useTranscriptSearch(transcriptItems)
  const openSearch = search.open

  // Hidden debug copy (Cmd/Ctrl+Shift+D or header right-click). Read messages
  // through a ref: depending on `messages` (new identity per streamed delta)
  // would re-create this callback and tear down / re-register the global
  // keydown listener 10–20×/s per open transcript panel.
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const copyDebugInfo = useCallback(async () => {
    let rawTranscript: RawTranscriptMessage[] | undefined
    if (taskId) {
      try {
        rawTranscript = await agentSessionApi.getRawTranscript(taskId)
      } catch (err) {
        console.warn('Failed to fetch raw transcript:', err)
      }
    }

    const currentMessages = messagesRef.current
    const debugText = serializeTranscriptForDebug(currentMessages, {
      sessionId,
      taskId,
      agentId,
      status,
      systemStatus,
      messageCount: currentMessages.length
    }, rawTranscript)
    navigator.clipboard.writeText(debugText).then(() => {
      setDebugCopyToast(true)
      setTimeout(() => setDebugCopyToast(false), 2000)
    }).catch((err) => {
      console.error('Failed to copy debug info:', err)
    })
  }, [sessionId, taskId, agentId, status, systemStatus])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const key = e.key.toLowerCase()
      const isDebugCopy = e.shiftKey && key === 'd'
      if (!isDebugCopy && key !== 'f') return
      // Only fire when this panel (or a descendant) has focus.
      if (!panelRef.current?.contains(document.activeElement) && document.activeElement !== panelRef.current) return
      e.preventDefault()
      if (isDebugCopy) void copyDebugInfo()
      else openSearch()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [copyDebugInfo, openSearch])

  const handleHeaderContextMenu = useCallback((e: MouseEvent) => {
    e.preventDefault()
    void copyDebugInfo()
  }, [copyDebugInfo])

  // A retry that ended the session gets a banner; a final error message is
  // already visible in the transcript.
  const lastMessage = messages[messages.length - 1]
  const errorBannerMessage = status === SessionStatus.IDLE && lastMessage?.partType === 'retry' ? lastMessage : null

  const virtualizer = useVirtualizer({
    count: transcriptItems.length,
    getScrollElement: () => scrollRef.current,
    // Transcript rows can change indexes when adjacent tool/reasoning parts are
    // grouped. Keep measured heights attached to the message/group itself,
    // rather than allowing an index to inherit the previous row's height.
    getItemKey: (index) => transcriptItems[index]?.key ?? index,
    estimateSize: () => 120,
    overscan: 8,
  })
  const virtualRows = virtualizer.getVirtualItems()
  const virtualWindowOffset = virtualRows[0]?.start ?? 0
  const { handleScroll, scrollToBottom, showScrollToBottom } = useTranscriptAutoScroll({
    items: transcriptItems,
    virtualizer,
    scrollRef,
    activeSearchItemIndex: search.activeItemIndex,
    bottomThreshold: 100
  })

  return (
    <div ref={panelRef} tabIndex={-1} className={cn('flex flex-col min-h-0 bg-background border-l border-border relative', className)}>
      {debugCopyToast && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-50 bg-card border border-border rounded-md px-3 py-1.5 text-xs text-foreground shadow-lg animate-in fade-in duration-150">
          Debug info copied to clipboard
        </div>
      )}
      <TranscriptHeader
        title={title}
        messageCount={messages.length}
        status={status}
        isStarting={isStarting}
        onToggleSearch={search.toggle}
        onRestart={onRestart}
        onStop={onStop}
        onContextMenu={handleHeaderContextMenu}
      />

      {search.isOpen && <TranscriptSearchBar search={search} />}

      {errorBannerMessage && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-red-500/10 border-b border-red-500/20 shrink-0">
          <AlertTriangle className="h-3.5 w-3.5 text-red-400 shrink-0" />
          <span className="text-xs text-red-300 truncate">{errorBannerMessage.content}</span>
        </div>
      )}

      {systemStatus && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-yellow-500/10 border-b border-yellow-500/20 shrink-0">
          <Loader2 className="h-3 w-3 text-yellow-400 animate-spin shrink-0" />
          <span className="text-xs text-yellow-300">{systemStatus}</span>
        </div>
      )}

      {latestTodos && <TodoSummary todos={latestTodos} />}

      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto p-4 text-sm"
        >
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-xs">
              {status === SessionStatus.WORKING ? (
                <>
                  <Loader2 className="h-8 w-8 mb-3 animate-spin opacity-30" />
                  <p>Agent is starting...</p>
                </>
              ) : (
                <>
                  <Terminal className="h-8 w-8 mb-2 opacity-20" />
                  <p>No messages yet</p>
                </>
              )}
            </div>
          ) : (
            <>
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {/* Position the visible window once, then let its rows stack in
                    normal flow. If ResizeObserver has not reported a newly
                    mounted tall message yet, its real DOM height still pushes
                    every following row down instead of letting absolute rows
                    paint over it. */}
                <div
                  data-testid="transcript-virtual-window"
                  style={{ transform: `translateY(${virtualWindowOffset}px)` }}
                >
                  {virtualRows.map((virtualRow) => {
                    const item = transcriptItems[virtualRow.index]
                    return (
                      <div
                        key={item.key}
                        ref={virtualizer.measureElement}
                        data-index={virtualRow.index}
                      >
                        <div className="pb-2">
                          {item.type === 'activity' ? (
                            <ActivityMessageGroup messages={item.messages} searchQuery={search.normalizedQuery} artifacts={taskArtifacts} onOpenArtifact={handleOpenArtifact} />
                          ) : (
                            <MessageBubble
                              message={item.message}
                              onAnswer={onSend}
                              canAnswerQuestion={item.message.id === activeQuestionId}
                              searchQuery={search.normalizedQuery}
                            />
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
              {status === SessionStatus.WORKING && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Agent is working...
                </div>
              )}
            </>
          )}
        </div>

        {showScrollToBottom && messages.length > 0 && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full bg-card border border-border/50 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-border shadow-lg transition-[color,border-color,opacity] duration-200 opacity-80 hover:opacity-100"
            title="Scroll to bottom"
          >
            <ArrowDown className="h-3 w-3" />
            <span>Bottom</span>
          </button>
        )}
      </div>

      <div className="border-t border-border shrink-0">
        {onSend && (
          <TranscriptComposer
            key={taskId}
            onSend={onSend}
            onPickAttachments={onPickAttachments}
            onAddAttachmentPaths={onAddAttachmentPaths}
            onSaveImages={onSaveImages}
            taskId={taskId}
            isStarting={isStarting}
            onTypedMessage={onTypedMessage}
          />
        )}
      </div>
    </div>
  )
}
