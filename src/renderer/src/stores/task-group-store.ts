import { create } from 'zustand'
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
const requests = new Map<string, number>()
const snapshotReaders = new Map<string, number>()
const sources = new Map<string, { consumers: number; scheduled: boolean; stop: () => void }>()
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The task group could not be updated. Try again.'
export const useTaskGroupStore = create<GroupState>((set, get) => {
  const write = async <T,>(groupId: string, action: () => Promise<T>): Promise<T> => {
    if (get().busy[groupId]) throw new Error('A group update is already in progress.')
    set(state => ({ busy: { ...state.busy, [groupId]: true }, errors: { ...state.errors, [groupId]: undefined } }))
    try {
      const result = await action()
      await Promise.all([get().load(groupId), useTaskStore.getState().fetchTasks()])
      const projectId = get().snapshots[groupId]?.group.project_id
      if (projectId) await get().fetch(projectId)
      return result
    } catch (error) {
      set(state => ({ errors: { ...state.errors, [groupId]: errorText(error) } }))
      throw error
    } finally { set(state => ({ busy: { ...state.busy, [groupId]: false } })) }
  }
  return {
    projects: {}, snapshots: {}, errors: {}, busy: {},
    fetch: async projectId => {
      const key = `project:${projectId}`, request = (requests.get(key) ?? 0) + 1
      requests.set(key, request)
      try {
        const groups = await taskGroupsApi.list(projectId)
        if (requests.get(key) !== request) return
        set(state => ({ projects: { ...state.projects, [projectId]: groups }, errors: { ...state.errors, [key]: undefined } }))
      } catch (error) {
        if (requests.get(key) === request) set(state => ({ errors: { ...state.errors, [key]: errorText(error) } }))
      }
    },
    load: async groupId => {
      const key = `group:${groupId}`, request = (requests.get(key) ?? 0) + 1
      requests.set(key, request)
      try {
        const snapshot = await taskGroupsApi.get(groupId)
        if (requests.get(key) !== request) return
        set(state => ({ snapshots: { ...state.snapshots, [groupId]: snapshot }, errors: { ...state.errors, [groupId]: undefined } }))
      } catch (error) {
        if (requests.get(key) === request) set(state => ({ errors: { ...state.errors, [groupId]: errorText(error) } }))
      }
    },
    remove: (groupId, taskId) => write(groupId, () => taskGroupsApi.remove(groupId, taskId)).then(() => undefined),
    dissolve: groupId => write(groupId, () => taskGroupsApi.dissolve(groupId)).then(() => undefined),
    move: (groupId, status) => write(groupId, () => taskGroupsApi.move(groupId, status)).then(() => undefined),
    review: data => write(data.group_id, () => taskGroupsApi.review(data)),
    retainSnapshot: groupId => {
      snapshotReaders.set(groupId, (snapshotReaders.get(groupId) ?? 0) + 1)
      void get().load(groupId)
      let released = false
      return () => {
        if (released) return
        released = true
        const count = (snapshotReaders.get(groupId) ?? 1) - 1
        if (count) snapshotReaders.set(groupId, count); else snapshotReaders.delete(groupId)
      }
    },
    subscribe: projectId => {
      let source = sources.get(projectId)
      if (!source) {
        const owned = { consumers: 0, scheduled: false, stop: () => {} }
        const reload = () => {
          if (owned.scheduled) return
          owned.scheduled = true
          // A shared session may update every member and then refresh tasks.
          // One source owner coalesces the burst before reading group state.
          queueMicrotask(() => {
            owned.scheduled = false
            if (sources.get(projectId) !== owned || !owned.consumers) return
            void get().fetch(projectId)
            for (const id of snapshotReaders.keys()) if (get().snapshots[id]?.group.project_id === projectId) void get().load(id)
          })
        }
        const offUpdate = onTaskUpdated(reload)
        const offRefresh = onTasksRefresh(reload)
        owned.stop = () => { offUpdate(); offRefresh() }
        source = owned; sources.set(projectId, owned)
        reload()
      }
      source.consumers++
      let released = false
      return () => {
        if (released) return
        released = true
        source!.consumers--
        if (!source!.consumers) { source!.stop(); sources.delete(projectId) }
      }
    }
  }
})
