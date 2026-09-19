import { useState, useEffect, useCallback, useRef } from 'react'
import { X, FolderKanban } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { AgentTranscriptPanel } from '@/components/agents/AgentTranscriptPanel'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { useAgentSession } from '@/hooks/use-agent-session'
import { useCurrentProject } from '@/hooks/use-project-tasks'
import { agentApi, settingsApi } from '@/lib/ipc-client'
import { captainAgentIdFor, useCaptainTaskId } from '@/stores/coordinator-store'
import { useProjectStore } from '@/stores/project-store'
import type { Agent } from '@/types'

/** Start the agent at app start, so the first sentence does not wait for it. */
export const CAPTAIN_PREWARM_SETTING = 'captain_prewarm'

/**
 * How long the drawer waits for a Captain to come up before it offers Retry.
 * Main gives up at 90 s and says why; this is the backstop for a start whose
 * answer never arrives.
 */
export const CAPTAIN_START_TIMEOUT_MS = 100_000

/** A Captain that could not be brought up, and the agent it was started on. */
interface StartFailure {
  agentId: string
  message: string
}

/** The reason without Electron's "Error invoking remote method '…': Error: " wrapper. */
function startFailureMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
}

interface OrchestratorPanelProps {
  onClose: () => void
}

export function OrchestratorPanel({ onClose }: OrchestratorPanelProps) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  // The drawer talks to the current project's Captain (#55): a task row
  // per project, hidden from every list, whose id is asked for by project.
  // Switching projects switches the id, and with it the conversation shown.
  // Nothing starts until the id is known.
  const project = useCurrentProject()
  const captainTaskId = useCaptainTaskId()
  const { start, stop, sendMessage, approve } = useAgentSession(captainTaskId ?? undefined)
  const currentSession = useAgentStore((state) => (captainTaskId ? state.sessions.get(captainTaskId) : undefined))
  const resetSession = useAgentStore((state) => state.resetSession)
  const updateProject = useProjectStore((state) => state.updateProject)
  /** The start in flight and whose it is, shared so a message can wait for it instead of racing. */
  const startingRef = useRef<{ taskId: string; promise: Promise<void> } | null>(null)
  const selectedAgentIdRef = useRef<string | null>(null)
  selectedAgentIdRef.current = selectedAgentId
  const [prewarm, setPrewarm] = useState(false)
  /** The agent in use before the last switch, offered as the way back when the new one will not start. */
  const [previousAgentId, setPreviousAgentId] = useState<string | null>(null)
  const [startFailure, setStartFailure] = useState<StartFailure | null>(null)
  /**
   * Messages sent while the Captain could not be started, per Captain row.
   * Each is delivered once, in order, when a start succeeds.
   */
  const queuedRef = useRef(new Map<string, string[]>())
  const drainingRef = useRef(false)
  const [queuedCount, setQueuedCount] = useState(0)

  // Read the preference before warming anything: a user who switched this off
  // must not get an agent process on every launch.
  useEffect(() => {
    let cancelled = false
    settingsApi
      .get(CAPTAIN_PREWARM_SETTING)
      .then((value) => {
        if (!cancelled) setPrewarm(value !== 'false')
      })
      .catch(() => {
        if (!cancelled) setPrewarm(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Load agents on mount
  useEffect(() => {
    agentApi.getAll().then(setAgents)
  }, [])

  // The project's Captain agent, else its default agent, else the app
  // default. Re-picked when the project changes; a choice made by hand in the
  // selector below holds until then.
  const projectId = project?.id
  const projectCaptainAgentId = project?.captain_agent_id ?? null
  const projectDefaultAgentId = project?.default_agent_id ?? null
  useEffect(() => {
    if (agents.length === 0) return
    setSelectedAgentId(captainAgentIdFor({ captain_agent_id: projectCaptainAgentId, default_agent_id: projectDefaultAgentId }, agents))
  }, [agents, projectId, projectCaptainAgentId, projectDefaultAgentId])

  // A failure belongs to the Captain it happened to.
  useEffect(() => {
    setStartFailure(null)
    setQueuedCount(captainTaskId ? queuedRef.current.get(captainTaskId)?.length ?? 0 : 0)
  }, [captainTaskId])

  // Switch agent. The new choice is recorded before the old session is
  // stopped, or the warm-up would race in and start the old agent again. It
  // is saved on the project too: the Commander, wake-ups and the next launch
  // start the Captain on the project's agent, and a choice that lived only
  // here was silently undone by all three. Main stops a session still
  // running on the old agent when the project changes.
  const handleAgentChange = async (newAgentId: string) => {
    const previous = selectedAgentIdRef.current
    if (!newAgentId || newAgentId === previous) return
    setPreviousAgentId(previous)
    selectedAgentIdRef.current = newAgentId
    setSelectedAgentId(newAgentId)
    setStartFailure(null)
    if (projectId) void updateProject(projectId, { captain_agent_id: newAgentId })
    if (currentSession?.sessionId && captainTaskId) {
      await stop()
      // Keeps the transcript: the conversation is the same Captain's.
      resetSession(captainTaskId)
    }
  }

  /**
   * Brings up the session, or joins the one already starting.
   *
   * Starting an agent takes seconds, so it is done ahead of time (see the
   * warm-up below). That creates a window where a message can arrive while the
   * session is still coming up: without the shared promise the message would be
   * dropped, because there is no session yet and one is already being made.
   */
  const ensureSession = useCallback(async (): Promise<boolean> => {
    const taskId = captainTaskId
    if (!taskId) return false
    const live = useAgentStore.getState().sessions.get(taskId)
    if (live?.sessionId) return true

    const agentId = selectedAgentIdRef.current
    if (!agentId) return false

    // A start still in flight for another project's Captain is not ours.
    if (!startingRef.current || startingRef.current.taskId !== taskId) {
      const promise = (async () => {
        // Drop the old session state (not the transcript) first.
        resetSession(taskId)
        setStartFailure(null)
        // skipInitialPrompt keeps the agent quiet until the user speaks. Main
        // resumes the persisted conversation when there is one, so a restart
        // continues where the last one left off. Bounded, so a start that
        // never answers ends in Retry rather than "Agent is starting..." forever.
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`No answer after ${Math.round(CAPTAIN_START_TIMEOUT_MS / 1000)} seconds`)),
            CAPTAIN_START_TIMEOUT_MS
          )
        })
        try {
          await Promise.race([start(agentId, taskId, undefined, true), timeout])
        } catch (err) {
          // start() already cleared its "starting" state when it failed; a
          // timeout left it behind.
          useAgentStore.getState().endSession(taskId)
          if (selectedAgentIdRef.current === agentId) setStartFailure({ agentId, message: startFailureMessage(err) })
          throw err
        } finally {
          clearTimeout(timer)
        }
        // Small delay to ensure session is fully initialized
        await new Promise((resolve) => setTimeout(resolve, 100))
      })().finally(() => {
        if (startingRef.current?.taskId === taskId) startingRef.current = null
      })
      startingRef.current = { taskId, promise }
    }

    try {
      await startingRef.current.promise
      return Boolean(useAgentStore.getState().sessions.get(taskId)?.sessionId)
    } catch (err) {
      console.error('Failed to start captain session:', err)
      return false
    }
  }, [captainTaskId, start, resetSession])

  const deliver = useCallback(
    async (message: string) => {
      // Question answers should use approve() instead of sendMessage()
      const live = captainTaskId ? useAgentStore.getState().sessions.get(captainTaskId) : undefined
      const messages = live?.messages || []
      const lastMessage = messages[messages.length - 1]
      if (lastMessage?.partType === 'question' && lastMessage?.tool?.questions) {
        await approve(true, message)
      } else {
        await sendMessage(message)
      }
    },
    [captainTaskId, sendMessage, approve]
  )

  /** Sends what was held while the Captain was down, oldest first, each once. */
  const drainQueue = useCallback(async () => {
    const taskId = captainTaskId
    if (!taskId || drainingRef.current) return
    const queue = queuedRef.current.get(taskId)
    if (!queue?.length) return
    drainingRef.current = true
    try {
      while (queue.length > 0) {
        // Taken off before sending, so a second drain cannot send it again.
        const next = queue.shift() as string
        setQueuedCount(queue.length)
        try {
          await deliver(next)
        } catch (err) {
          queue.unshift(next)
          setQueuedCount(queue.length)
          throw err
        }
      }
    } finally {
      drainingRef.current = false
    }
  }, [captainTaskId, deliver])

  // Send message - the session is usually warm already, so this just sends.
  // When the Captain cannot be started the message is held, not dropped, and
  // goes out after a successful retry or switch.
  const handleSendMessage = useCallback(
    async (message: string) => {
      const taskId = captainTaskId
      if (!(await ensureSession())) {
        if (!taskId) return
        const queue = queuedRef.current.get(taskId) ?? []
        queue.push(message)
        queuedRef.current.set(taskId, queue)
        setQueuedCount(queue.length)
        return
      }
      await drainQueue()
      await deliver(message)
    },
    [captainTaskId, ensureSession, drainQueue, deliver]
  )

  const retryStart = useCallback(async () => {
    setStartFailure(null)
    try {
      if (await ensureSession()) await drainQueue()
    } catch (err) {
      console.error('Failed to deliver held Captain messages:', err)
    }
  }, [ensureSession, drainQueue])

  /**
   * Start the agent in the background, before there is anything to say.
   *
   * The panel is mounted for the whole life of the window, so this runs at
   * app start, and again for each project the user switches to. It costs one
   * idle agent process and saves the seconds a user would otherwise wait
   * after their first sentence — which is most of the delay when talking to
   * Captain by voice.
   *
   * Switched off in Settings → General for anyone who does not want the
   * process. Failure is silent: the first message starts the session as before.
   */
  useEffect(() => {
    if (!prewarm || !selectedAgentId || !captainTaskId || currentSession?.sessionId || startFailure) return
    void ensureSession().then((ok) => (ok ? drainQueue() : undefined)).catch((err: unknown) => {
      console.error('Failed to deliver held Captain messages:', err)
    })
  }, [prewarm, selectedAgentId, captainTaskId, currentSession?.sessionId, startFailure, ensureSession, drainQueue])

  // Listen for pre-fill messages from the dashboard command input
  useEffect(() => {
    const handlePrefill = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.message && typeof detail.message === 'string') {
        // Small delay to ensure the panel is mounted and agent is selected
        setTimeout(() => {
          handleSendMessage(detail.message)
        }, 200)
      }
    }
    window.addEventListener('captain-prefill', handlePrefill)
    return () => window.removeEventListener('captain-prefill', handlePrefill)
  }, [handleSendMessage])

  const projectName = project?.name ?? 'Default'
  const agentName = (id: string | null): string => agents.find((agent) => agent.id === id)?.name ?? 'the agent'
  const rollbackAgentId =
    startFailure && previousAgentId && previousAgentId !== startFailure.agentId && agents.some((agent) => agent.id === previousAgentId)
      ? previousAgentId
      : null

  return (
    // Floats as a card, like the workspace and the sidebar: same radius,
    // hairline, fill and shadow. It was the one panel still sitting flush and
    // square against the work.
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-card">
      {/* Header: which project's Captain this is, and the agent it runs on */}
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border shrink-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={`The Captain of ${projectName}`}>
            <FolderKanban className="size-icon-xs shrink-0" />
            <span className="truncate font-medium text-foreground/80" data-testid="captain-project">{projectName}</span>
          </span>
          {/* The Captain's coding agent. It stays usable the whole time:
              changing it re-warms the session on the freshly picked agent. */}
          <select
            value={selectedAgentId || ''}
            onChange={(e) => handleAgentChange(e.target.value)}
            className="text-xs bg-background border border-border rounded px-2 py-1 cursor-pointer hover:border-primary/50 transition-colors"
            aria-label="Captain agent"
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </div>

        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* A start that failed or timed out: why, and the ways out. */}
      {startFailure && (
        <div role="alert" className="flex flex-col gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2.5 text-xs shrink-0">
          <p>
            <span className="font-medium text-foreground">The Captain could not start on {agentName(startFailure.agentId)}.</span>{' '}
            <span className="text-muted-foreground">{startFailure.message}</span>
          </p>
          {queuedCount > 0 && (
            <p className="text-muted-foreground">
              {queuedCount === 1 ? '1 message is' : `${queuedCount} messages are`} waiting and will be sent once the Captain is up.
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void retryStart()}>
              Retry
            </Button>
            {rollbackAgentId && (
              <Button size="sm" variant="ghost" onClick={() => void handleAgentChange(rollbackAgentId)}>
                Switch back to {agentName(rollbackAgentId)}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Chat interface */}
      {selectedAgentId && (
        <AgentTranscriptPanel
          title={`Captain den · ${projectName}`}
          messages={currentSession?.messages || []}
          status={currentSession?.status || SessionStatus.IDLE}
          systemStatus={currentSession?.systemStatus}
          onStop={stop}
          onSend={handleSendMessage}
          className="flex-1 min-h-0"
          sessionId={currentSession?.sessionId}
          pendingSend={currentSession?.pendingSend}
        />
      )}

      {!selectedAgentId && (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          No agent selected
        </div>
      )}
    </div>
  )
}
