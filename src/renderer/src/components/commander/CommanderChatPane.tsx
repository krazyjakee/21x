import { useEffect, useState } from 'react'
import { Radio } from 'lucide-react'
import { COMMANDER_AGENT_SETTING } from '@shared/commander'
import { AgentTranscriptPanel } from '@/components/agents/AgentTranscriptPanel'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { useCoordinatorChat } from '@/hooks/use-coordinator-chat'
import { agentApi, commanderApi, settingsApi } from '@/lib/ipc-client'
import { SessionStatus } from '@/stores/agent-store'
import { useCommanderStore } from '@/stores/commander-store'
import type { Agent } from '@/types'
import { UNTITLED_SESSION } from './CommanderSessionList'

export const COMMANDER_EMPTY_DESCRIPTION =
  'The Commander coordinates your projects. It hands work to each project’s Captain and relays their reports back here — it never does the work itself.'

/**
 * The open session. Its conversation is an ordinary agent session on the
 * session's task row, drawn by the same transcript panel as a task or the
 * Captain, so everything a task session can do (streaming, tools, approvals,
 * stop, voice) works here the same way.
 */
export function CommanderChatPane() {
  const sessionId = useCommanderStore((s) => s.selectedSessionId)
  const session = useCommanderStore((s) => s.sessions.find((x) => x.id === sessionId))
  const createSession = useCommanderStore((s) => s.createSession)
  const [agents, setAgents] = useState<Agent[]>([])
  const [agentId, setAgentId] = useState<string | null>(null)
  /** The session whose task row main has confirmed; nothing binds or starts before that. */
  const [preparedId, setPreparedId] = useState<string | null>(null)
  const [prepareError, setPrepareError] = useState<string | null>(null)

  useEffect(() => {
    agentApi.getAll().then(setAgents).catch(() => setAgents([]))
    commanderApi.getAgentId().then(setAgentId).catch(() => setAgentId(null))
  }, [])

  useEffect(() => {
    let cancelled = false
    setPreparedId(null)
    setPrepareError(null)
    if (!sessionId) return undefined
    commanderApi
      .prepareSession(sessionId)
      .then(({ taskId, agentId: resolved }) => {
        if (cancelled) return
        setPreparedId(taskId)
        if (resolved) setAgentId((current) => current ?? resolved)
      })
      .catch((err) => {
        if (!cancelled) setPrepareError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const { session: live, send, stop, switchAgent } = useCoordinatorChat(preparedId, agentId)

  // One agent for every Commander session. Changing it moves the open
  // conversation to the new agent; other sessions pick it up when they start.
  const handleAgentChange = async (next: string) => {
    setAgentId(next)
    await settingsApi.set(COMMANDER_AGENT_SETTING, next)
    await switchAgent(next)
  }

  if (!sessionId) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          icon={Radio}
          title="Talk to the Commander"
          description={COMMANDER_EMPTY_DESCRIPTION}
          action={<Button size="sm" onClick={() => void createSession()}>New session</Button>}
        />
      </div>
    )
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Commander chat">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        <h2 className="truncate text-sm font-medium">{session?.title || UNTITLED_SESSION}</h2>
        <select
          value={agentId ?? ''}
          onChange={(e) => void handleAgentChange(e.target.value)}
          className="text-xs bg-background border border-border rounded px-2 py-1 cursor-pointer hover:border-primary/50 transition-colors"
          aria-label="Commander agent"
        >
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.config?.model ? `${agent.name} · ${agent.config.model}` : agent.name}
            </option>
          ))}
        </select>
      </header>

      {prepareError ? (
        <div role="alert" className="m-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {prepareError}
        </div>
      ) : !agentId && agents.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Add an agent in Settings to talk to the Commander.
        </div>
      ) : (
        preparedId && (
          <AgentTranscriptPanel
            title={session?.title || UNTITLED_SESSION}
            messages={live?.messages || []}
            status={live?.status || SessionStatus.IDLE}
            systemStatus={live?.systemStatus}
            onStop={stop}
            onSend={send}
            className="flex-1 min-h-0"
            sessionId={live?.sessionId}
            taskId={preparedId}
            pendingSend={live?.pendingSend}
          />
        )
      )}
    </section>
  )
}
