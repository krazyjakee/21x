import { useTaskStore } from '@/stores/task-store'
import { useProjectStore } from '@/stores/project-store'
import { rehydrateDesktopAgentState } from '@/stores/agent-store'
import { ServiceProtocolError } from '@shared/service-protocol'

/** Read-only recovery. A failed owner leaves native mutation/approval fenced. */
export async function rehydrateProductionDesktop(): Promise<void> {
  await Promise.all([useTaskStore.getState().fetchTasks(), useProjectStore.getState().fetchProjects(), rehydrateDesktopAgentState()])
  if (useTaskStore.getState().error || useProjectStore.getState().error) throw new ServiceProtocolError('DISCONNECTED')
}
