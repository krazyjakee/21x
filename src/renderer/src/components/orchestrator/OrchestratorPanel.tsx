import { useState, useEffect, useCallback, useRef } from 'react'
import { X, FolderKanban } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { AgentTranscriptPanel } from '@/components/agents/AgentTranscriptPanel'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { useAgentSession } from '@/hooks/use-agent-session'
import { useCurrentProject } from '@/hooks/use-project-tasks'
import { agentApi, captainRuntimeApi, mergeGrantsApi, settingsApi } from '@/lib/ipc-client'
import { captainAgentIdFor, useCaptainTaskId } from '@/stores/coordinator-store'
import { useProjectStore } from '@/stores/project-store'
import type { Agent } from '@/types'
import type { CaptainRuntimeState } from '@shared/captain-runtime'

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

interface QueuedCaptainMessage {
  message: string
  deliveryId: string
  typed: boolean
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
  const fetchProjects = useProjectStore((state) => state.fetchProjects)
  /** The start in flight and whose it is, shared so a message can wait for it instead of racing. */
  const startingRef = useRef<{ taskId: string; promise: Promise<void> } | null>(null)
  const selectedAgentIdRef = useRef<string | null>(null)
  selectedAgentIdRef.current = selectedAgentId
  const [prewarm, setPrewarm] = useState(false)
  const [runtime, setRuntime] = useState<CaptainRuntimeState | null>(null)
  const [runtimeActivity, setRuntimeActivity] = useState<{ phase: 'starting_server' | 'retrying'; agentId: string } | null>(null)
  const [startFailure, setStartFailure] = useState<StartFailure | null>(null)
  /**
   * Messages sent while the Captain could not be started, per Captain row.
   * Each is delivered once, in order, when a start succeeds.
   */
  const queuedRef = useRef(new Map<string, QueuedCaptainMessage[]>())
  const typedMessageRef = useRef<string | null>(null)
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
    if (!projectId) {
      setRuntime(null)
      return
    }
    let cancelled = false
    void captainRuntimeApi.get(projectId).then((state) => {
      if (cancelled) return
      setRuntime(state)
      if (state && ['failed', 'timed_out', 'rolled_back', 'unhealthy'].includes(state.phase) && state.errorDetail) {
        setStartFailure({ agentId: state.candidateAgentId ?? state.agentId, message: state.errorDetail })
      }
    })
    return () => {
      cancelled = true
    }
  }, [captainTaskId, projectId])

  // Main owns the transaction: the old Captain remains selected and usable
  // until the candidate passes server, protocol and session readiness probes.
  const handleAgentChange = async (newAgentId: string) => {
    const previous = selectedAgentIdRef.current
    if (!newAgentId || newAgentId === previous) return
    selectedAgentIdRef.current = newAgentId
    setSelectedAgentId(newAgentId)
    setStartFailure(null)
    if (!projectId) return
    setRuntimeActivity({ phase: 'starting_server', agentId: newAgentId })
    if (runtime) {
      setRuntime({ ...runtime, phase: 'starting_server', candidateAgentId: newAgentId, errorCode: null, errorDetail: null })
    }
    try {
      const next = await captainRuntimeApi.switch(projectId, newAgentId)
      setRuntime(next)
      if (next.phase === 'healthy') {
        await fetchProjects()
        return
      }
      const restored = next.lastGoodAgentId ?? previous
      selectedAgentIdRef.current = restored
      setSelectedAgentId(restored)
      setStartFailure({ agentId: next.candidateAgentId ?? newAgentId, message: next.errorDetail ?? 'The candidate did not become healthy.' })
    } catch (err) {
      selectedAgentIdRef.current = previous
      setSelectedAgentId(previous)
      setStartFailure({ agentId: newAgentId, message: startFailureMessage(err) })
    } finally {
      setRuntimeActivity(null)
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
    async (message: QueuedCaptainMessage) => {
      // Question answers should use approve() instead of sendMessage()
      const live = captainTaskId ? useAgentStore.getState().sessions.get(captainTaskId) : undefined
      const messages = live?.messages || []
      const lastMessage = messages[messages.length - 1]
      if (lastMessage?.partType === 'question' && lastMessage?.tool?.questions) {
        await approve(true, message.message)
      } else {
        // Stage provenance at delivery, after session warm-up and queueing;
        // IPC consumes this exact text once, then main tracks actual dispatch.
        if (message.typed && captainTaskId) mergeGrantsApi.noteTyped(captainTaskId, message.message)
        await sendMessage(message.message, { deliveryId: message.deliveryId })
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
        const next = queue.shift() as QueuedCaptainMessage
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
      const outgoing: QueuedCaptainMessage = {
        message,
        typed: typedMessageRef.current === message,
        deliveryId: `captain-drawer:${crypto.randomUUID()}`
      }
      typedMessageRef.current = null
      const taskId = captainTaskId
      if (!taskId) return
      try {
        await drainQueue()
        await deliver(outgoing)
      } catch (err) {
        const queue = queuedRef.current.get(taskId) ?? []
        // The main process already persisted this id before attempting the
        // handoff. Keeping it here only drives immediate manual retry; a full
        // renderer/app restart recovers the same row from SQLite.
        if (!queue.some((entry) => entry.deliveryId === outgoing.deliveryId)) queue.push(outgoing)
        queuedRef.current.set(taskId, queue)
        setQueuedCount(queue.length)
        setStartFailure({ agentId: selectedAgentIdRef.current ?? '', message: startFailureMessage(err) })
      }
    },
    [captainTaskId, drainQueue, deliver]
  )

  const retryStart = useCallback(async () => {
    setStartFailure(null)
    setRuntimeActivity({ phase: 'retrying', agentId: runtime?.candidateAgentId ?? selectedAgentIdRef.current ?? '' })
    try {
      if (projectId && runtime?.candidateAgentId) {
        const next = await captainRuntimeApi.retry(projectId)
        setRuntime(next)
        if (next.phase === 'healthy') {
          selectedAgentIdRef.current = next.agentId
          setSelectedAgentId(next.agentId)
          await fetchProjects()
          return
        }
        setStartFailure({ agentId: next.candidateAgentId ?? runtime.candidateAgentId, message: next.errorDetail ?? 'Retry failed.' })
        return
      }
      if (await ensureSession()) await drainQueue()
    } catch (err) {
      console.error('Failed to deliver held Captain messages:', err)
      setStartFailure({ agentId: runtime?.candidateAgentId ?? selectedAgentIdRef.current ?? '', message: startFailureMessage(err) })
    } finally {
      setRuntimeActivity(null)
    }
  }, [projectId, runtime, fetchProjects, ensureSession, drainQueue])

  const rollbackSwitch = useCallback(async () => {
    if (!projectId) return
    const next = await captainRuntimeApi.rollback(projectId)
    setRuntime(next)
    setStartFailure(next.errorDetail ? { agentId: next.candidateAgentId ?? next.agentId, message: next.errorDetail } : null)
    selectedAgentIdRef.current = next.agentId
    setSelectedAgentId(next.agentId)
    await fetchProjects()
  }, [projectId, fetchProjects])

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
          if (detail.typed === true) typedMessageRef.current = detail.message
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
    startFailure && runtime?.lastGoodAgentId && runtime.lastGoodAgentId !== startFailure.agentId && agents.some((agent) => agent.id === runtime.lastGoodAgentId)
      ? runtime.lastGoodAgentId
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

      {runtimeActivity ? (
        <div data-testid="captain-runtime-state" className="border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          Captain is {runtimeActivity.phase.replaceAll('_', ' ')} on {agentName(runtimeActivity.agentId)}.
        </div>
      ) : runtime && !['healthy', 'failed', 'timed_out', 'rolled_back'].includes(runtime.phase) && (
        <div data-testid="captain-runtime-state" className="border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          Captain is {runtime.phase.replaceAll('_', ' ')} on {agentName(runtime.candidateAgentId ?? runtime.agentId)}.
        </div>
      )}

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
              <Button size="sm" variant="ghost" onClick={() => void rollbackSwitch()}>
                Roll back to {agentName(rollbackAgentId)}
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
          onTypedMessage={(text) => { typedMessageRef.current = text }}
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
