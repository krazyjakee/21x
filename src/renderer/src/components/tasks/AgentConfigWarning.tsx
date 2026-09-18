import { Settings2, AlertCircle } from 'lucide-react'
import { isAgentConfigured, getAgentConfigIssue } from '@shared/agent-utils'
import type { Task, Agent } from '@/types'

/**
 * Inline warning shown under the Agent row when the task's agent (or, when no
 * agent is assigned, the default agent picked by Triage) is missing a provider
 * or model. Blocks the user from starting/triaging until they fix it.
 */
export function AgentConfigWarning({ task, agents, onEditAgent }: { task: Task; agents: Agent[]; onEditAgent?: (agentId: string) => void }) {
  const assignedAgent = task.agent_id ? agents.find((a) => a.id === task.agent_id) : null
  const triageAgent = !task.agent_id ? (agents.find((a) => a.is_default) || agents[0] || null) : null
  const targetAgent = assignedAgent || triageAgent
  if (!targetAgent) return null
  if (isAgentConfigured(targetAgent)) return null

  const issue = getAgentConfigIssue(targetAgent) || 'Agent is not fully configured'
  const isAssigned = !!assignedAgent
  const action = isAssigned ? 'Start' : 'Triage'
  const message = isAssigned
    ? `${issue}. ${action} is disabled — edit the agent to continue.`
    : `The default agent "${targetAgent.name}" is not fully configured (${issue.toLowerCase()}). ${action} is disabled — edit the agent to continue.`

  return (
    <div
      data-testid="agent-config-warning"
      className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"
    >
      <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0 space-y-1.5">
        <p className="leading-snug">{message}</p>
        {onEditAgent && (
          <button
            type="button"
            onClick={() => onEditAgent(targetAgent.id)}
            className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-200 transition-colors cursor-pointer"
            data-testid="agent-config-warning-edit"
          >
            <Settings2 className="h-3 w-3" />
            Edit agent
          </button>
        )}
      </div>
    </div>
  )
}
