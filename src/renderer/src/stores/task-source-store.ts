import { create } from 'zustand'
import { captureDesktopRead } from '@/lib/desktop-api'
import { createDesktopSnapshotReader } from '@/lib/desktop-snapshot'
import { ServiceProtocolError } from '@shared/service-protocol'
import { useTaskStore } from './task-store'
import { getCurrentProjectId, isInProject } from './project-store'
import type { TaskSource, CreateTaskSourceDTO, UpdateTaskSourceDTO, SyncResult, ActionResult } from '@/types'
import { taskSourceApi, pluginApi } from '@/lib/ipc-client'

/**
 * `sources` holds every project's sources; Settings and the sidebar read the
 * current project's through `useProjectTaskSources` (hooks/use-project-tasks).
 */
interface TaskSourceState {
  sources: TaskSource[]
  isLoading: boolean
  error: string | null
  syncingIds: Set<string>
  lastSyncResults: Map<string, SyncResult>

  fetchSources: () => Promise<void>
  createSource: (data: CreateTaskSourceDTO) => Promise<TaskSource | null>
  updateSource: (id: string, data: UpdateTaskSourceDTO) => Promise<TaskSource | null>
  deleteSource: (id: string) => Promise<boolean>
  syncSource: (sourceId: string) => Promise<SyncResult | null>
  /** Syncs the current project's enabled sources. */
  syncAllEnabled: () => Promise<void>
  executeAction: (actionId: string, taskId: string, sourceId: string, input?: string) => Promise<ActionResult>
}

let requested = false, documentGeneration = 0
const syncs = new Map<string, { current: () => boolean; promise: Promise<SyncResult | null> }>()
export function retireTaskSourceDesktopState(): void {
  requested = false; documentGeneration++; sourceSnapshot.dispose()
  useTaskSourceStore.setState({ syncingIds: new Set(), lastSyncResults: new Map() })
  window.removeEventListener('pagehide', retireTaskSourceDesktopState)
}
function ownDocument() { window.addEventListener('pagehide', retireTaskSourceDesktopState, { once: true }) }
function captureSourceIntent() {
  ownDocument()
  const generation = documentGeneration, scope = captureDesktopRead()
  return () => generation === documentGeneration && scope.isCurrent()
}
function invalidateMetadata() { requested = true; sourceSnapshot.invalidate() }

export const useTaskSourceStore = create<TaskSourceState>((set, get) => ({
  sources: [],
  isLoading: false,
  error: null,
  syncingIds: new Set(),
  lastSyncResults: new Map(),

  fetchSources: async () => {
    ownDocument(); invalidateMetadata()
    await sourceSnapshot.refresh().catch(() => {})
  },

  createSource: async (data) => {
    const current = captureSourceIntent()
    try {
      // A new source belongs to the current project unless told otherwise.
      const source = await taskSourceApi.create(data.project_id ? data : { ...data, project_id: getCurrentProjectId() })
      if (current()) {
        invalidateMetadata()
        set((state) => ({ sources: [...state.sources.filter(item => item.id !== source.id), source] }))
      }
      return source
    } catch (err) {
      if (current()) set({ error: String(err) })
      return null
    }
  },

  updateSource: async (id, data) => {
    const current = captureSourceIntent()
    try {
      const updated = await taskSourceApi.update(id, data)
      if (updated && current()) {
        invalidateMetadata()
        set((state) => ({
          sources: state.sources.map((s) => (s.id === id ? updated : s))
        }))
      }
      return updated || null
    } catch (err) {
      if (current()) set({ error: String(err) })
      return null
    }
  },

  deleteSource: async (id) => {
    const current = captureSourceIntent()
    try {
      const success = await taskSourceApi.delete(id)
      if (success && current()) {
        invalidateMetadata()
        set((state) => ({
          sources: state.sources.filter((s) => s.id !== id)
        }))
      }
      return success
    } catch (err) {
      if (current()) set({ error: String(err) })
      return false
    }
  },

  syncSource: async (sourceId) => {
    const previous = syncs.get(sourceId)
    if (previous) return previous.current() ? previous.promise : null
    const current = captureSourceIntent()
    set(state => ({ syncingIds: new Set([...state.syncingIds, sourceId]) }))
    const run = { current, promise: Promise.resolve<SyncResult | null>(null) }
    run.promise = Promise.resolve().then(async () => {
      try {
        if (!current()) return null
        const result = await taskSourceApi.sync(sourceId)
        if (result.source_id !== sourceId) throw new ServiceProtocolError('INVALID_RESULT')
        if (!current()) return result
        // Canonical import and metadata readback only. Never invent the stored
        // last_synced_at timestamp or run another sync to recover a reply.
        await Promise.all([useTaskStore.getState().fetchTasks(), get().fetchSources()])
        if (current()) set(state => ({ lastSyncResults: new Map(state.lastSyncResults).set(sourceId, result) }))
        return result
      } catch (error) {
        if (current()) set({ error: String(error) })
        return null
      } finally {
        if (syncs.get(sourceId) === run) {
          syncs.delete(sourceId)
          // This exact public work owner has settled, including disconnect.
          // A replacement request cannot own the same map slot yet.
          set(state => { const ids = new Set(state.syncingIds); ids.delete(sourceId); return { syncingIds: ids } })
        }
      }
    })
    syncs.set(sourceId, run)
    return run.promise
  },

  syncAllEnabled: async () => {
    const current = captureSourceIntent(), projectId = getCurrentProjectId()
    const enabled = get().sources.filter(source => source.enabled && isInProject(source, projectId))
    // Use the retained mutation lane sequentially; a project change withdraws
    // follow-up requests but never replays or retargets accepted work.
    for (const source of enabled) {
      if (!current() || getCurrentProjectId() !== projectId) return
      await get().syncSource(source.id)
    }
  },

  executeAction: async (actionId, taskId, sourceId, input) => {
    const current = captureSourceIntent()
    try {
      const result = await pluginApi.executeAction(actionId, taskId, sourceId, input)
      return current() ? result : { success: false, error: 'The desktop connection changed. Review current task state.' }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }
}))


const sourceSnapshot = createDesktopSnapshotReader({
  read: () => taskSourceApi.getAll(),
  start: () => useTaskSourceStore.setState({ isLoading: true, error: null }),
  apply: sources => useTaskSourceStore.setState({ sources, isLoading: false, error: null }),
  fail: error => useTaskSourceStore.setState({ isLoading: false, error: String(error) })
})
/** Only demanded source metadata; no sync/export/action/auth replay. */
export async function rehydrateTaskSourceDesktopState(): Promise<void> {
  if (!requested) return
  ownDocument(); invalidateMetadata()
  useTaskSourceStore.setState({ syncingIds: new Set(), lastSyncResults: new Map() })
  await sourceSnapshot.refresh()
}
if (import.meta.hot) import.meta.hot.dispose(retireTaskSourceDesktopState)
