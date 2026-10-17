import { create } from 'zustand'
import { createDesktopSnapshotReader } from '@/lib/desktop-snapshot'
import { ServiceProtocolError } from '@shared/service-protocol'
import { isAgentStatusHeartbeat } from '@shared/activity'
import {
  overviewApi,
  projectApi,
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
 * task, session, queue, status snapshot or project changes in any project. No LLM output is read here.
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
let owner: { active: boolean; subscribers: number; stop: () => void } | undefined

export function retireOverviewDesktopState(): void {
  if (owner) { owner.active = false; owner.stop(); owner = undefined }
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = null
  overviewSnapshot.dispose()
  window.removeEventListener('pagehide', retireOverviewDesktopState)
}

/** Only mounted overview consumers participate in durable reconnect recovery. */
export async function rehydrateOverviewDesktopState(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const owned = owner
    if (!owned) return
    overviewSnapshot.invalidate()
    try { await overviewSnapshot.refresh() }
    catch (error) { if (owner === owned) throw error }
    if (owner === owned) return
  }
  throw new ServiceProtocolError('BACKPRESSURE')
}

export const useOverviewStore = create<OverviewState>((_set, get) => ({
  entries: [],
  isLoading: false,
  error: null,
  loadedAt: null,

  fetchAll: async () => {
    overviewSnapshot.invalidate()
    await overviewSnapshot.refresh().catch(() => {})
  },

  scheduleRefresh: () => {
    overviewSnapshot.invalidate()
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void get().fetchAll()
    }, OVERVIEW_REFRESH_DEBOUNCE_MS)
  },

  start: () => {
    if (!owner) {
      const owned = { active: true, subscribers: 0, stop: () => {} }
      owner = owned
      const refresh = (): void => { if (owned.active) get().scheduleRefresh() }
      const offs = [
        onTaskUpdated(refresh), onTaskCreated(refresh), onTaskDeleted(refresh),
        onAgentStatus(event => { if (!isAgentStatusHeartbeat(event)) refresh() }),
        onAgentStartQueueChanged(refresh), projectApi.onStatusChanged(refresh), projectApi.onChanged(refresh)
      ]
      const poll = setInterval(() => { if (owned.active) void get().fetchAll() }, OVERVIEW_FALLBACK_POLL_MS)
      owned.stop = () => { for (const off of offs) off?.(); clearInterval(poll) }
      window.addEventListener('pagehide', retireOverviewDesktopState, { once: true })
    }
    const owned = owner
    owned.subscribers++
    void get().fetchAll()
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      if (owned.active && --owned.subscribers === 0) retireOverviewDesktopState()
    }
  }

}))

const overviewSnapshot = createDesktopSnapshotReader({
  read: () => overviewApi.getAllStatuses(),
  start: () => useOverviewStore.setState({ isLoading: true }),
  apply: entries => useOverviewStore.setState({ entries, error: null, loadedAt: Date.now(), isLoading: false }),
  fail: error => useOverviewStore.setState({ error: error instanceof Error ? error.message : String(error), isLoading: false })
})
if (import.meta.hot) import.meta.hot.dispose(retireOverviewDesktopState)

/** Test seam: drops listeners, readers and timers so a test starts clean. */
export function resetOverviewStoreForTests(): void {
  retireOverviewDesktopState()
  useOverviewStore.setState({ entries: [], isLoading: false, error: null, loadedAt: null })
}
