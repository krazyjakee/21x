import { create } from 'zustand'
import { isAgentStatusHeartbeat } from '@shared/activity'
import {
  overviewApi,
  projectApi,
  escalationApi,
  onTaskUpdated,
  onTaskCreated,
  onTaskDeleted,
  onAgentStatus,
  onAgentStartQueueChanged
} from '@/lib/ipc-client'
import type { ProjectOverviewEntry } from '@shared/project-overview'

/** Events arriving within this window fold into one refresh. */
export const OVERVIEW_REFRESH_DEBOUNCE_MS = 400
/** A slow safety net for facts no event announces (daily caps, token totals). */
export const OVERVIEW_FALLBACK_POLL_MS = 30_000

/**
 * The all-projects overview (#63). One main-process call returns every
 * active project's status; the store refetches it, debounced, whenever a
 * task, session, queue, status snapshot, project or held escalation changes
 * in any project. No LLM output is read here.
 */
interface OverviewState {
  entries: ProjectOverviewEntry[]
  isLoading: boolean
  error: string | null
  /** Epoch ms of the last successful load; null until the first. */
  loadedAt: number | null

  fetchAll: () => Promise<void>
  /** Coalesces bursts of events into one fetch. */
  scheduleRefresh: () => void
  /**
   * Subscribes to the live events and loads once. Reference counted: several
   * mounted views share one set of listeners. Returns the matching stop.
   */
  start: () => () => void
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let inFlight: Promise<void> | null = null
let refetchAfter = false
let subscribers = 0
let unsubscribeAll: (() => void) | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

export const useOverviewStore = create<OverviewState>((set, get) => ({
  entries: [],
  isLoading: false,
  error: null,
  loadedAt: null,

  fetchAll: async () => {
    // A change that lands mid-fetch is not lost: one more fetch follows.
    if (inFlight) {
      refetchAfter = true
      return inFlight
    }
    set({ isLoading: true })
    inFlight = (async () => {
      try {
        const entries = await overviewApi.getAllStatuses()
        set({ entries, error: null, loadedAt: Date.now() })
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      } finally {
        set({ isLoading: false })
        inFlight = null
      }
    })()
    await inFlight
    if (refetchAfter) {
      refetchAfter = false
      await get().fetchAll()
    }
  },

  scheduleRefresh: () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void get().fetchAll()
    }, OVERVIEW_REFRESH_DEBOUNCE_MS)
  },

  start: () => {
    subscribers += 1
    if (subscribers === 1) {
      const refresh = (): void => get().scheduleRefresh()
      const offs = [
        onTaskUpdated(refresh),
        onTaskCreated(refresh),
        onTaskDeleted(refresh),
        // Heartbeats (#95) carry no change; only transitions refresh.
        onAgentStatus((event) => { if (!isAgentStatusHeartbeat(event)) refresh() }),
        onAgentStartQueueChanged(refresh),
        projectApi.onStatusChanged(refresh),
        projectApi.onChanged(refresh),
        escalationApi.onHeldChanged(refresh)
      ]
      pollTimer = setInterval(() => { void get().fetchAll() }, OVERVIEW_FALLBACK_POLL_MS)
      unsubscribeAll = () => {
        for (const off of offs) off()
        if (pollTimer) clearInterval(pollTimer)
        pollTimer = null
      }
    }
    void get().fetchAll()

    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      subscribers -= 1
      if (subscribers === 0) {
        unsubscribeAll?.()
        unsubscribeAll = null
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = null
      }
    }
  }
}))

/** Test seam: drops listeners and timers so a test starts clean. */
export function resetOverviewStoreForTests(): void {
  unsubscribeAll?.()
  unsubscribeAll = null
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = null
  inFlight = null
  refetchAfter = false
  subscribers = 0
  useOverviewStore.setState({ entries: [], isLoading: false, error: null, loadedAt: null })
}
