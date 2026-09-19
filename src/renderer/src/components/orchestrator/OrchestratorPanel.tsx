import { useState, useEffect } from 'react'
import { X, FolderKanban } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { AgentTranscriptPanel } from '@/components/agents/AgentTranscriptPanel'
import { SessionStatus } from '@/stores/agent-store'
import { useCoordinatorChat } from '@/hooks/use-coordinator-chat'
import { useCurrentProject } from '@/hooks/use-project-tasks'
import { agentApi, settingsApi } from '@/lib/ipc-client'
import { captainAgentIdFor, useCaptainTaskId } from '@/stores/coordinator-store'
import type { Agent } from '@/types'

/** Start the agent at app start, so the first sentence does not wait for it. */
export const CAPTAIN_PREWARM_SETTING = 'captain_prewarm'

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
  const { session: currentSession, ensureSession, send: handleSendMessage, stop, switchAgent } = useCoordinatorChat(
    captainTaskId,
    selectedAgentId
  )
  const [prewarm, setPrewarm] = useState(false)

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

  // Switch agent: the conversation moves to the freshly picked one.
  const handleAgentChange = async (newAgentId: string) => {
    setSelectedAgentId(newAgentId)
    await switchAgent(newAgentId)
  }

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
    if (!prewarm || !selectedAgentId || !captainTaskId || currentSession?.sessionId) return
    void ensureSession()
  }, [prewarm, selectedAgentId, captainTaskId, currentSession?.sessionId, ensureSession])

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
