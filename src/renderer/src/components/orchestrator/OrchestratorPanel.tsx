import { ipcErrorReason } from '@/lib/ipc-error'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { X, FolderKanban } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { AgentTranscriptPanel } from '@/components/agents/AgentTranscriptPanel'
import { useAgentStore, SessionStatus, type AgentMessage } from '@/stores/agent-store'
import { useAgentSession } from '@/hooks/use-agent-session'
import { useCurrentProject } from '@/hooks/use-project-tasks'
import { agentApi, captainRuntimeApi, settingsApi } from '@/lib/ipc-client'
import { captainAgentIdFor, useCaptainTaskId } from '@/stores/coordinator-store'
import { activeProjects, useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'
import type { Agent } from '@/types'
import type { ComposerAttachment } from '@/components/agents/transcript/TranscriptComposer'
import { taskImageSaver, withAttachmentNote } from '@/lib/chat-image-attachments'
import { keepComposerDraft, readComposerDraft } from '@/lib/composer-drafts'
import { dispatchShortcutFeedback, insertIntoComposer } from '@/lib/keyboard-shortcuts'
import { CAPTAIN_COMPOSER_KEY } from '@/lib/voice-dictation-target'
import { CaptainProjectSelect } from './CaptainProjectSelect'
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
  options?: { attachments?: ComposerAttachment[] }
  sentAt: number
}

/**
 * The held messages that have reached their Captain since.
 *
 * Main saved each of these before the send failed and retries it on its own
 * timer. Nothing tells the panel when one lands, except the message itself
 * appearing in the transcript as the user part of its outbox row.
 */
function deliveredHeldMessages(held: QueuedCaptainMessage[], messages: AgentMessage[]): QueuedCaptainMessage[] {
  const parts = messages.filter((message) => message.role === 'user' && message.id.startsWith('delivery-'))
  const matched = new Set<string>()
  return held.filter((entry) => {
    const part = parts.find((candidate) => !matched.has(candidate.id) && candidate.timestamp.getTime() >= entry.sentAt &&
      (candidate.content === entry.message || candidate.content.startsWith(`${entry.message}\n\nAttached to this message:`)))
    if (part) matched.add(part.id)
    return !!part
  })
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
  // Nothing starts until the id is known, and switching itself starts nothing:
  // the transcript hydrates from the durable record with no session at all.
  const project = useCurrentProject()
  const captainTaskId = useCaptainTaskId()
  const mountedRef = useRef(true)
  const captainViewRef = useRef({ taskId: captainTaskId, projectId: project?.id })
  if (captainViewRef.current.taskId !== captainTaskId || captainViewRef.current.projectId !== project?.id) {
    captainViewRef.current = { taskId: captainTaskId, projectId: project?.id }
  }
  useEffect(() => {
    mountedRef.current = true
    // A remount also starts a new view generation for pending replies.
    captainViewRef.current = { ...captainViewRef.current }
    return () => { mountedRef.current = false; captainViewRef.current = { ...captainViewRef.current } }
  }, [])
  /** A late result belongs to its project: it must not land on the Captain shown since. */
  const showsProject = useCallback((id: string) => mountedRef.current && captainViewRef.current.projectId === id, [])
  const { start, stop, sendMessage, approve } = useAgentSession(captainTaskId ?? undefined)
  const currentSession = useAgentStore((state) => (captainTaskId ? state.sessions.get(captainTaskId) : undefined))
  const resetSession = useAgentStore((state) => state.resetSession)
  const fetchProjects = useProjectStore((state) => state.fetchProjects)
  const setCurrentProject = useProjectStore((state) => state.setCurrentProject)
  const projects = useProjectStore((state) => state.projects)
  const projectsLoaded = useProjectStore((state) => state.isLoaded)
  const drawerOpen = useUIStore((state) => state.showOrchestrator)
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
   * These are what the panel knows about: main owns delivery, keeps retrying
   * them on its own, and a successful start or Send now also pushes them.
   */
  const queuedRef = useRef(new Map<string, QueuedCaptainMessage[]>())
  /** The drain in flight for each Captain, so one Captain's slow start holds up only itself. */
  const drainsRef = useRef(new Map<string, Promise<void>>())
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
    setRuntime(null)
    setRuntimeActivity(null)
    setQueuedCount(captainTaskId ? queuedRef.current.get(captainTaskId)?.length ?? 0 : 0)
    if (!projectId) return
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
    setStartFailure(null)
    if (!projectId) return
    setRuntimeActivity({ phase: 'starting_server', agentId: newAgentId })
    if (runtime) {
      setRuntime({ ...runtime, phase: 'starting_server', candidateAgentId: newAgentId, errorCode: null, errorDetail: null })
    }
    try {
      const next = await captainRuntimeApi.switch(projectId, newAgentId)
      // Main kept the outcome: the column reads it on returning to this Captain.
      if (!showsProject(projectId)) {
        if (mountedRef.current) await fetchProjects()
        return
      }
      setRuntime(next)
      if (next.phase === 'healthy') {
        selectedAgentIdRef.current = next.agentId
        setSelectedAgentId(next.agentId)
        await fetchProjects()
        if (showsProject(projectId)) void deliverHeld().catch((err: unknown) => console.error('Failed to deliver held Captain messages:', err))
        return
      }
      const restored = next.lastGoodAgentId ?? previous
      selectedAgentIdRef.current = restored
      setSelectedAgentId(restored)
      setStartFailure({ agentId: next.candidateAgentId ?? newAgentId, message: next.errorDetail ?? 'The candidate did not become healthy.' })
    } catch (err) {
      if (!showsProject(projectId)) return
      selectedAgentIdRef.current = previous
      setSelectedAgentId(previous)
      setStartFailure({ agentId: newAgentId, message: ipcErrorReason(err) })
    } finally {
      if (showsProject(projectId)) setRuntimeActivity(null)
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
          if (captainViewRef.current.taskId === taskId && selectedAgentIdRef.current === agentId) setStartFailure({ agentId, message: ipcErrorReason(err) })
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

  const handleSaveImages = useMemo(() => (captainTaskId ? taskImageSaver(captainTaskId) : undefined), [captainTaskId])

  const deliver = useCallback(
    async (message: QueuedCaptainMessage) => {
      // Question answers should use approve() instead of sendMessage()
      const live = captainTaskId ? useAgentStore.getState().sessions.get(captainTaskId) : undefined
      const messages = live?.messages || []
      const lastMessage = messages[messages.length - 1]
      // Only while the Captain is actually waiting: a question card left over
      // from an answered or released turn must not swallow new messages.
      if (live?.status === SessionStatus.WAITING_APPROVAL && lastMessage?.partType === 'question' && lastMessage?.tool?.questions) {
        await approve(true, withAttachmentNote(message.message, message.options?.attachments))
      } else {
        await sendMessage(message.message, { ...message.options, deliveryId: message.deliveryId })
      }
    },
    [captainTaskId, sendMessage, approve]
  )

  const showHeldCount = useCallback((taskId: string) => {
    if (captainViewRef.current.taskId === taskId) setQueuedCount(queuedRef.current.get(taskId)?.length ?? 0)
  }, [])

  /**
   * Sends what is held for this Captain, oldest first. A message that fails
   * stays held and the rest still go, so one main has given up on cannot block
   * those behind it. A second call joins the drain already running.
   */
  const drainQueue = useCallback((): Promise<void> => {
    const taskId = captainTaskId
    if (!taskId) return Promise.resolve()
    const running = drainsRef.current.get(taskId)
    if (running) return running
    const queue = queuedRef.current.get(taskId)
    if (!queue?.length) return Promise.resolve()
    const drain = (async () => {
      const failures: unknown[] = []
      for (const next of [...queue]) {
        // Main may have delivered it while an earlier one was going out.
        if (!queue.includes(next)) continue
        try {
          await deliver(next)
          if (queue.includes(next)) queue.splice(queue.indexOf(next), 1)
          showHeldCount(taskId)
        } catch (err) {
          failures.push(err)
        }
      }
      if (failures.length > 0) throw failures[0]
    })().finally(() => {
      drainsRef.current.delete(taskId)
    })
    drainsRef.current.set(taskId, drain)
    return drain
  }, [captainTaskId, deliver, showHeldCount])

  /** After the user brought a Captain up by hand: what warming does at launch, for what it holds. */
  const deliverHeld = useCallback(async () => {
    if (!captainTaskId || !queuedRef.current.get(captainTaskId)?.length) return
    if (await ensureSession()) await drainQueue()
  }, [captainTaskId, ensureSession, drainQueue])

  // Main's own retry landed: this Captain is no longer holding that message.
  const captainMessages = currentSession?.messages
  useEffect(() => {
    const queue = captainTaskId ? queuedRef.current.get(captainTaskId) : undefined
    if (!queue?.length || !captainMessages?.length) return
    const delivered = deliveredHeldMessages(queue, captainMessages)
    if (delivered.length === 0) return
    for (const entry of delivered) queue.splice(queue.indexOf(entry), 1)
    setQueuedCount(queue.length)
    if (queue.length === 0) setStartFailure(null)
  }, [captainTaskId, captainMessages])

  // Stop cancels undelivered messages in main, so nothing held here can go any
  // more. The words go back in the box instead of staying on a dead button.
  const handleStop = useCallback(async () => {
    const taskId = captainTaskId
    await stop()
    const held = taskId ? queuedRef.current.get(taskId) : undefined
    if (!taskId || !held?.length) return
    const words = held.splice(0).map((entry) => entry.message).join('\n\n')
    showHeldCount(taskId)
    const field = captainViewRef.current.taskId === taskId
      ? document.querySelector<HTMLTextAreaElement>(`[data-voice-composer="${CAPTAIN_COMPOSER_KEY}"] textarea`)
      : null
    if (field) {
      insertIntoComposer(field, words)
      return
    }
    const draft = readComposerDraft(taskId)
    keepComposerDraft(taskId, { ...draft, text: draft?.text ? `${draft.text}\n\n${words}` : words })
  }, [captainTaskId, stop, showHeldCount])

  // Send message - the session is usually warm already, so this just sends.
  // When the Captain cannot be started the message is held, not dropped. Main
  // keeps retrying it, and a successful retry or switch sends it at once.
  const handleSendMessage = useCallback(
    async (message: string, options?: { attachments?: ComposerAttachment[] }) => {
      const outgoing: QueuedCaptainMessage = {
        message,
        deliveryId: `captain-drawer:${crypto.randomUUID()}`,
        options,
        sentAt: Date.now()
      }
      const taskId = captainTaskId
      if (!taskId) {
        dispatchShortcutFeedback('Could not send the message — this project’s Captain is not ready yet', true)
        return
      }
      try {
        // Older held messages go first. A failing one must not prevent main
        // from owning this message.
        await drainQueue().catch(() => {})
        await deliver(outgoing)
      } catch (err) {
        const queue = queuedRef.current.get(taskId) ?? []
        // The main process already persisted this id before attempting the
        // handoff. Keeping it here only drives immediate manual retry; a full
        // renderer/app restart recovers the same row from SQLite.
        if (!queue.some((entry) => entry.deliveryId === outgoing.deliveryId)) queue.push(outgoing)
        queuedRef.current.set(taskId, queue)
        if (captainViewRef.current.taskId === taskId) {
          setQueuedCount(queue.length)
          setStartFailure({ agentId: selectedAgentIdRef.current ?? '', message: ipcErrorReason(err) })
        }
      }
    },
    [captainTaskId, drainQueue, deliver]
  )

  const retryStart = useCallback(async () => {
    const view = captainViewRef.current
    const ownsView = (): boolean => mountedRef.current && captainViewRef.current === view
    if (!ownsView()) return
    setStartFailure(null)
    setRuntimeActivity({ phase: 'retrying', agentId: runtime?.candidateAgentId ?? selectedAgentIdRef.current ?? '' })
    try {
      if (projectId && runtime?.candidateAgentId) {
        const next = await captainRuntimeApi.retry(projectId)
        if (!ownsView()) return
        setRuntime(next)
        if (next.phase === 'healthy') {
          selectedAgentIdRef.current = next.agentId
          setSelectedAgentId(next.agentId)
          await fetchProjects()
          if (ownsView()) await deliverHeld()
          return
        }
        setStartFailure({ agentId: next.candidateAgentId ?? runtime.candidateAgentId, message: next.errorDetail ?? 'Retry failed.' })
        return
      }
      if (await ensureSession() && ownsView()) await drainQueue()
    } catch (err) {
      if (!ownsView()) return
      console.error('Failed to deliver held Captain messages:', err)
      setStartFailure({ agentId: runtime?.candidateAgentId ?? selectedAgentIdRef.current ?? '', message: ipcErrorReason(err) })
    } finally {
      if (ownsView()) setRuntimeActivity(null)
    }
  }, [projectId, runtime, fetchProjects, ensureSession, drainQueue, deliverHeld])

  const rollbackSwitch = useCallback(async () => {
    if (!projectId) return
    try {
      const next = await captainRuntimeApi.rollback(projectId)
      if (!showsProject(projectId)) return
      setRuntime(next)
      setStartFailure(next.errorDetail ? { agentId: next.candidateAgentId ?? next.agentId, message: next.errorDetail } : null)
      selectedAgentIdRef.current = next.agentId
      setSelectedAgentId(next.agentId)
      await fetchProjects()
      if (showsProject(projectId)) await deliverHeld()
    } catch (error) {
      if (showsProject(projectId)) setStartFailure({ agentId: selectedAgentIdRef.current ?? '', message: ipcErrorReason(error) })
    }
  }, [projectId, fetchProjects, showsProject, deliverHeld])

  /**
   * Start the agent in the background, before there is anything to say.
   *
   * The panel is mounted for the whole life of the window, so this runs at
   * app start. It costs one idle agent process and saves the seconds a user
   * would otherwise wait after their first sentence — which is most of the
   * delay when talking to Captain by voice.
   *
   * It waits for the saved project, so launch does not warm Default on the way,
   * and stops for good once the app leaves the project it opened on: looking at
   * a project must not start its Captain. The first message there starts it.
   *
   * Switched off in Settings → General for anyone who does not want the
   * process. Failure is silent: the first message starts the session as before.
   */
  useEffect(() => {
    if (!projectsLoaded || useProjectStore.getState().leftLaunchProject || !prewarm || !selectedAgentId || !captainTaskId || currentSession?.sessionId || startFailure) return
    void ensureSession().then((ok) => (ok ? drainQueue() : undefined)).catch((err: unknown) => {
      console.error('Failed to deliver held Captain messages:', err)
    })
  }, [projectsLoaded, prewarm, selectedAgentId, captainTaskId, currentSession?.sessionId, startFailure, ensureSession, drainQueue])

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
  // A project choice only when there is one: the current project among at least two.
  const projectChoices = activeProjects(projects)
  const canFlip = projectChoices.length > 1 && projectChoices.some((choice) => choice.id === projectId)
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
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground" title={`The Captain of ${projectName}`}>
            <FolderKanban className="size-icon-xs shrink-0" />
            {canFlip && projectId ? (
              // The app's current project, not a second selection: the top bar,
              // the dashboard box and voice all talk to the same Captain as this.
              <CaptainProjectSelect projects={projectChoices} currentId={projectId} onChoose={setCurrentProject} tabbable={drawerOpen} />
            ) : (
              <span className="truncate font-medium text-foreground/80" data-testid="captain-project">{projectName}</span>
            )}
          </span>
          {/* The Captain's coding agent. It stays usable the whole time:
              changing it re-warms the session on the freshly picked agent. */}
          <select
            value={selectedAgentId || ''}
            onChange={(e) => handleAgentChange(e.target.value)}
            className="min-w-0 max-w-[50%] text-xs bg-background border border-border rounded px-2 py-1 cursor-pointer hover:border-primary/50 transition-colors"
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
              {queuedCount === 1 ? '1 message is' : `${queuedCount} messages are`} waiting. 21x retries on its own, and Retry tries now.
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

      {/* Held messages stay with their Captain. Main retries them on its own, so
          this says that rather than promising they wait for the button. */}
      {!startFailure && queuedCount > 0 && (
        <div role="status" className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground shrink-0">
          <span>{queuedCount === 1 ? '1 message is' : `${queuedCount} messages are`} waiting. 21x retries on its own.</span>
          <Button size="sm" variant="outline" onClick={() => void retryStart()}>
            Send now
          </Button>
        </div>
      )}

      {/* Chat interface. One panel per Captain, so nothing typed for one is on
          screen for the next; with no Captain yet there is nowhere to send. */}
      {selectedAgentId && (
        <AgentTranscriptPanel
          key={captainTaskId}
          draftKey={captainTaskId ?? undefined}
          title={`Captain den · ${projectName}`}
          messages={currentSession?.messages || []}
          status={currentSession?.status || SessionStatus.IDLE}
          systemStatus={currentSession?.systemStatus}
          onStop={() => void handleStop()}
          onSend={captainTaskId ? handleSendMessage : undefined}
          onSaveImages={handleSaveImages}
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
