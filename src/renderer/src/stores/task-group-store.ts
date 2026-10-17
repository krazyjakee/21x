import { create } from 'zustand'
import { captureDesktopRead } from '@/lib/desktop-api'
import { createDesktopSnapshotReader } from '@/lib/desktop-snapshot'
import { ServiceProtocolError } from '@shared/service-protocol'
import type { TaskGroupRecord, TaskGroupReviewData, TaskGroupReviewResult, TaskGroupSnapshot as SharedTaskGroupSnapshot } from '@shared/task-groups'
import type { Task, TaskStatus } from '@/types'
import { onTaskUpdated, onTasksRefresh, taskGroupsApi } from '@/lib/ipc-client'
import { useTaskStore } from './task-store'

export type TaskGroupSnapshot = SharedTaskGroupSnapshot<Task>
interface GroupState {
  projects: Record<string, TaskGroupRecord[]>
  snapshots: Record<string, TaskGroupSnapshot>
  errors: Record<string, string | undefined>
  busy: Record<string, boolean | undefined>
  fetch: (projectId: string) => Promise<void>
  load: (groupId: string) => Promise<void>
  remove: (groupId: string, taskId: string) => Promise<void>
  dissolve: (groupId: string) => Promise<void>
  move: (groupId: string, status: TaskStatus) => Promise<void>
  review: (data: TaskGroupReviewData) => Promise<TaskGroupReviewResult>
  subscribe: (projectId: string) => () => void
  retainSnapshot: (groupId: string) => () => void
}
const snapshotReaders = new Map<string, number>()
const sources = new Map<string, { active: boolean; consumers: number; scheduled: boolean; stop: () => void }>()
const projectReaders = new Map<string, ReturnType<typeof createDesktopSnapshotReader<TaskGroupRecord[]>>>()
const groupReaders = new Map<string, ReturnType<typeof createDesktopSnapshotReader<TaskGroupSnapshot>>>()
let viewGeneration = 0
let documentGeneration = 0
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The task group could not be updated. Try again.'
function ownDocument() { window.addEventListener('pagehide', retireTaskGroupDesktopState, { once: true }) }
function projectReader(projectId: string) {
  ownDocument()
  let reader = projectReaders.get(projectId)
  if (!reader) {
    reader = createDesktopSnapshotReader({
      read: () => taskGroupsApi.list(projectId),
      apply: groups => useTaskGroupStore.setState(state => ({ projects: { ...state.projects, [projectId]: groups }, errors: { ...state.errors, [`project:${projectId}`]: undefined } })),
      fail: error => useTaskGroupStore.setState(state => ({ errors: { ...state.errors, [`project:${projectId}`]: errorText(error) } }))
    })
    projectReaders.set(projectId, reader)
  }
  return reader
}
function groupReader(groupId: string) {
  ownDocument()
  let reader = groupReaders.get(groupId)
  if (!reader) {
    reader = createDesktopSnapshotReader({
      read: () => taskGroupsApi.get(groupId),
      apply: snapshot => useTaskGroupStore.setState(state => ({ snapshots: { ...state.snapshots, [groupId]: snapshot }, errors: { ...state.errors, [groupId]: undefined } })),
      fail: error => useTaskGroupStore.setState(state => ({ errors: { ...state.errors, [groupId]: errorText(error) } }))
    })
    groupReaders.set(groupId, reader)
  }
  return reader
}

export function retireTaskGroupDesktopState(): void {
  documentGeneration++; viewGeneration++
  for (const source of sources.values()) { source.active = false; source.stop() }
  sources.clear(); snapshotReaders.clear()
  for (const reader of [...projectReaders.values(), ...groupReaders.values()]) reader.dispose()
  projectReaders.clear(); groupReaders.clear()
  window.removeEventListener('pagehide', retireTaskGroupDesktopState)
}

/** Join the currently mounted group views, including a replacement during recovery. */
export async function rehydrateTaskGroupDesktopState(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const generation = viewGeneration
    const readers = [...[...sources.keys()].map(projectReader), ...[...snapshotReaders.keys()].map(groupReader)]
    for (const reader of readers) reader.invalidate()
    try { await Promise.all(readers.map(reader => reader.refresh())) }
    catch (error) { if (generation === viewGeneration) throw error }
    if (generation === viewGeneration) return
  }
  throw new ServiceProtocolError('BACKPRESSURE')
}

export const useTaskGroupStore = create<GroupState>((set, get) => {
  const write = async <T,>(groupId: string, action: () => Promise<T>): Promise<T> => {
    if (get().busy[groupId]) throw new Error('A group update is already in progress.')
    set(state => ({ busy: { ...state.busy, [groupId]: true }, errors: { ...state.errors, [groupId]: undefined } }))
    const scope = captureDesktopRead()
    try {
      const result = await action()
      if (!scope.isCurrent()) return result
      groupReaders.get(groupId)?.invalidate()
      for (const reader of projectReaders.values()) reader.invalidate()
      await Promise.all([get().load(groupId), useTaskStore.getState().fetchTasks()])
      const projectId = get().snapshots[groupId]?.group.project_id
      if (projectId) await get().fetch(projectId)
      return result
    } catch (error) {
      if (scope.isCurrent()) set(state => ({ errors: { ...state.errors, [groupId]: errorText(error) } }))
      throw error
    } finally { set(state => ({ busy: { ...state.busy, [groupId]: false } })) }
  }
  return {
    projects: {}, snapshots: {}, errors: {}, busy: {},
    fetch: async projectId => {
      const reader = projectReader(projectId)
      reader.invalidate()
      await reader.refresh().catch(() => {})
    },
    load: async groupId => {
      const reader = groupReader(groupId)
      reader.invalidate()
      await reader.refresh().catch(() => {})
    },
    remove: (groupId, taskId) => write(groupId, () => taskGroupsApi.remove(groupId, taskId)).then(() => undefined),
    dissolve: groupId => write(groupId, () => taskGroupsApi.dissolve(groupId)).then(() => undefined),
    move: (groupId, status) => write(groupId, () => taskGroupsApi.move(groupId, status)).then(() => undefined),
    review: data => write(data.group_id, () => taskGroupsApi.review(data)),
    retainSnapshot: groupId => {
      const generation = documentGeneration
      if (!snapshotReaders.has(groupId)) viewGeneration++
      snapshotReaders.set(groupId, (snapshotReaders.get(groupId) ?? 0) + 1)
      void get().load(groupId)
      let released = false
      return () => {
        if (released) return
        released = true
        if (generation !== documentGeneration) return
        const count = (snapshotReaders.get(groupId) ?? 1) - 1
        if (count) snapshotReaders.set(groupId, count)
        else { snapshotReaders.delete(groupId); viewGeneration++; groupReaders.get(groupId)?.dispose(); groupReaders.delete(groupId) }
      }
    },
    subscribe: projectId => {
      let source = sources.get(projectId)
      if (!source) {
        viewGeneration++
        ownDocument()
        const owned = { active: true, consumers: 0, scheduled: false, stop: () => {} }
        const reload = () => {
          if (!owned.active) return
          projectReaders.get(projectId)?.invalidate()
          for (const id of snapshotReaders.keys()) if (!get().snapshots[id] || get().snapshots[id].group.project_id === projectId) groupReaders.get(id)?.invalidate()
          if (owned.scheduled) return
          owned.scheduled = true
          // A shared session may update every member and then refresh tasks.
          // One source owner coalesces the burst before reading group state.
          queueMicrotask(() => {
            owned.scheduled = false
            if (!owned.active || sources.get(projectId) !== owned || !owned.consumers) return
            void get().fetch(projectId)
            for (const id of snapshotReaders.keys()) if (get().snapshots[id]?.group.project_id === projectId) void get().load(id)
          })
        }
        const offUpdate = onTaskUpdated(reload)
        const offRefresh = onTasksRefresh(reload)
        owned.stop = () => { offUpdate?.(); offRefresh?.() }
        source = owned; sources.set(projectId, owned)
        reload()
      }
      source.consumers++
      let released = false
      return () => {
        if (released) return
        released = true
        source!.consumers--
        if (!source!.active) return
        if (!source!.consumers) {
          source!.active = false; source!.stop(); sources.delete(projectId); viewGeneration++
          projectReaders.get(projectId)?.dispose(); projectReaders.delete(projectId)
        }
      }
    }
  }
})

if (import.meta.hot) import.meta.hot.dispose(retireTaskGroupDesktopState)
