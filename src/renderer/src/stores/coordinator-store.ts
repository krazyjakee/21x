import { create } from 'zustand'
import { taskApi } from '@/lib/ipc-client'

/**
 * Which task row hosts the Mastermind.
 *
 * The Mastermind is a real row in `tasks` (role 'mastermind') so its session
 * and transcript persist and resume like any task's. It is hidden from every
 * task list, so the id is asked for once, by role, rather than written into
 * the renderer as a string. Until it is known there is no Mastermind session
 * to look at, which is the same as before the panel has started anything.
 */
interface CoordinatorState {
  /** The Mastermind's task id, or null until loaded (or when the row is missing). */
  mastermindTaskId: string | null
  /** Fetches the id once; later calls return the value already loaded. */
  load: () => Promise<string | null>
}

let loading: Promise<string | null> | null = null

export const useCoordinatorStore = create<CoordinatorState>((set, get) => ({
  mastermindTaskId: null,

  load: () => {
    const known = get().mastermindTaskId
    if (known) return Promise.resolve(known)
    if (!loading) {
      loading = taskApi
        .getCoordinatorTaskId()
        .then((id) => {
          set({ mastermindTaskId: id })
          return id
        })
        .catch((err) => {
          console.error('[coordinator-store] Failed to load the Mastermind task id:', err)
          return null
        })
        .finally(() => {
          loading = null
        })
    }
    return loading
  }
}))

/** The Mastermind's task id right now, for callers outside React. */
export function getMastermindTaskId(): string | null {
  return useCoordinatorStore.getState().mastermindTaskId
}
