import { useEffect } from 'react'
import { create } from 'zustand'
import { taskApi } from '@/lib/ipc-client'
import { getCurrentProjectId, useProjectStore } from '@/stores/project-store'
import type { ProjectRecord } from '@shared/projects'

/**
 * Which task row hosts each project's Mastermind (#55).
 *
 * A Mastermind is a real row in `tasks` (role 'mastermind', one per project)
 * so its session and transcript persist and resume like any task's. The rows
 * are hidden from every task list, so each id is asked for once, by project,
 * rather than written into the renderer as a string. The Orchestrator drawer
 * and the dashboard talk to the current project's Mastermind: switching
 * projects switches which id they use, and so which conversation they show.
 */
interface CoordinatorState {
  /**
   * Mastermind task id by project id. A project is absent until loaded and
   * null when main has no row for it (an unknown project).
   */
  mastermindTaskIds: Record<string, string | null>
  /** Fetches a project's id once; later calls return the value already loaded. */
  load: (projectId: string) => Promise<string | null>
}

const loading = new Map<string, Promise<string | null>>()

export const useCoordinatorStore = create<CoordinatorState>((set, get) => ({
  mastermindTaskIds: {},

  load: (projectId) => {
    const known = get().mastermindTaskIds[projectId]
    if (known) return Promise.resolve(known)
    let pending = loading.get(projectId)
    if (!pending) {
      // Started inside the chain, so a bridge that is missing (a partial test
      // mock, a page loaded without preload) logs instead of throwing from a
      // render effect.
      pending = Promise.resolve()
        .then(() => taskApi.getCoordinatorTaskId(projectId))
        .then((id) => {
          set((state) => ({ mastermindTaskIds: { ...state.mastermindTaskIds, [projectId]: id } }))
          return id
        })
        .catch((err) => {
          console.error(`[coordinator-store] Failed to load the Mastermind task id of project ${projectId}:`, err)
          return null
        })
        .finally(() => {
          loading.delete(projectId)
        })
      loading.set(projectId, pending)
    }
    return pending
  }
}))

/**
 * The current project's Mastermind task id, or null until it is known. Loads
 * it on first use and again for every project the user switches to.
 */
export function useMastermindTaskId(): string | null {
  const projectId = useProjectStore((s) => s.currentProjectId)
  const taskId = useCoordinatorStore((s) => s.mastermindTaskIds[projectId] ?? null)
  const load = useCoordinatorStore((s) => s.load)
  useEffect(() => {
    void load(projectId)
  }, [projectId, load])
  return taskId
}

/** A project's Mastermind task id right now (the current project's by default), for callers outside React. */
export function getMastermindTaskId(projectId: string = getCurrentProjectId()): string | null {
  return useCoordinatorStore.getState().mastermindTaskIds[projectId] ?? null
}

/**
 * The agent a project's Mastermind runs on: the project's Mastermind agent,
 * else its default agent, else the app's default agent (else the first one).
 * An id that no longer names an agent is skipped.
 */
export function mastermindAgentIdFor(
  project: Pick<ProjectRecord, 'mastermind_agent_id' | 'default_agent_id'> | undefined,
  agents: Array<{ id: string; is_default?: boolean }>
): string | null {
  const known = (id: string | null | undefined): string | null =>
    id && agents.some((agent) => agent.id === id) ? id : null
  return (
    known(project?.mastermind_agent_id) ??
    known(project?.default_agent_id) ??
    agents.find((agent) => agent.is_default)?.id ??
    agents[0]?.id ??
    null
  )
}
