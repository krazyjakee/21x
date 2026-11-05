import { agentApi } from '@/lib/ipc-client'
import { useAgentStore } from '@/stores/agent-store'
import { DeletionDialog } from './DeletionDialog'
import type { Agent } from '@/types'

export function AgentDeleteDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const deleteAgent = useAgentStore((state) => state.deleteAgent)
  return (
    <DeletionDialog
      subjectId={agent.id}
      title={`Delete “${agent.name}”?`}
      doneTitle={`“${agent.name}” was deleted`}
      idleText="Nothing is running on this agent. Other agents are not affected."
      runningText="Other agents keep running. Only this agent’s own work stops."
      actionLabel="Delete agent"
      stopLabel="Stop and delete"
      readImpacts={async () => {
        const impact = await agentApi.deletionImpact(agent.id)
        return impact && [impact]
      }}
      remove={async () => {
        const result = await deleteAgent(agent.id)
        return result && 'agent_id' in result ? [result] : result
      }}
      onClose={onClose}
    />
  )
}
