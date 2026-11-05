import { useEffect, useRef } from 'react'
import { useAgentStore } from '@/stores/agent-store'

/**
 * Calls back with the ids that have just left the shared agent list, for forms
 * holding a local draft of an agent choice. Compares against the previous list,
 * so the first load (empty to full) never looks like a removal and a draft is
 * not emptied while the list is still arriving.
 */
export function useAgentsRemoved(onRemoved: (ids: string[]) => void): void {
  const agents = useAgentStore((state) => state.agents)
  const previous = useRef(agents)
  const callback = useRef(onRemoved)
  callback.current = onRemoved
  useEffect(() => {
    const removed = previous.current.filter((agent) => !agents.some((next) => next.id === agent.id)).map((agent) => agent.id)
    previous.current = agents
    if (removed.length > 0) callback.current(removed)
  }, [agents])
}
