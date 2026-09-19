import { create } from 'zustand'
import { api, type MobileProject } from '../api/client'
import { onEvent } from '../api/websocket'
import type { Task } from '@/types'

/** Where the phone remembers its chosen project (per device, not shared with the desktop). */
export const CURRENT_PROJECT_STORAGE_KEY = 'mobile:current_project_id'

function readStoredProjectId(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(CURRENT_PROJECT_STORAGE_KEY) : null
  } catch {
    return null
  }
}

function storeProjectId(id: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (id) localStorage.setItem(CURRENT_PROJECT_STORAGE_KEY, id)
    else localStorage.removeItem(CURRENT_PROJECT_STORAGE_KEY)
  } catch { /* storage unavailable (private mode) */ }
}

interface TaskState {
  tasks: Task[]
  isLoading: boolean
  isSyncing: boolean
  projects: MobileProject[]
  /** The project the list shows and new tasks go to; null until projects load. */
  currentProjectId: string | null
  fetchProjects: () => Promise<void>
  setCurrentProject: (id: string) => Promise<void>
  fetchTasks: () => Promise<void>
  syncAndFetch: () => Promise<void>
  createTask: (data: Record<string, unknown>) => Promise<Task | null>
  updateTask: (id: string, data: Record<string, unknown>) => Promise<boolean>
}

export const useTaskStore = create<TaskState>((set, get) => {
  onEvent('task:updated', (payload) => {
    const { taskId, updates } = payload as { taskId: string; updates: Partial<Task> }
    const found = get().tasks.some((t) => t.id === taskId)
    const inCurrentProject = belongsToCurrentProject((updates ?? {}) as Task, get().currentProjectId)
    if (found && !inCurrentProject) {
      // Moved to another project on the desktop
      set((state) => ({ tasks: state.tasks.filter((t) => t.id !== taskId) }))
    } else if (found) {
      set((state) => ({
        tasks: state.tasks.map((t) =>
          t.id === taskId ? { ...t, ...updates } : t
        )
      }))
    } else if (inCurrentProject) {
      // Task not yet in the list (created on desktop) — fetch to pick it up
      get().fetchTasks()
    }
  })

  onEvent('task:created', (payload) => {
    const { task } = payload as { task: Task }
    set((state) => {
      // Another project's task (created on the desktop or another phone)
      if (!belongsToCurrentProject(task, state.currentProjectId)) return state
      // Deduplicate — task may already exist from a concurrent fetchTasks()
      if (state.tasks.some((t) => t.id === task.id)) return state
      return { tasks: [task, ...state.tasks] }
    })
  })

  /** The current project's tasks, or null when the project changed mid-request. */
  const listCurrent = async (): Promise<Task[] | null> => {
    const projectId = get().currentProjectId
    const tasks = (await (projectId ? api.tasks.list({ project_id: projectId }) : api.tasks.list())) as Task[]
    return get().currentProjectId === projectId ? tasks : null
  }

  return {
    tasks: [],
    isLoading: false,
    isSyncing: false,
    projects: [],
    currentProjectId: readStoredProjectId(),

    fetchProjects: async () => {
      try {
        const projects = await api.projects.list()
        const stored = get().currentProjectId
        // Keep the phone's choice while it still exists; otherwise follow the
        // desktop's current project, then Default.
        const next = (stored && projects.some((p) => p.id === stored))
          ? stored
          : (projects.find((p) => p.current) ?? projects.find((p) => p.is_default) ?? projects[0])?.id ?? null
        set({ projects })
        if (next !== stored) await get().setCurrentProject(next ?? '')
      } catch (e) {
        console.error('Failed to fetch projects:', e)
      }
    },

    setCurrentProject: async (id) => {
      const projectId = id || null
      storeProjectId(projectId)
      set({ currentProjectId: projectId, tasks: [] })
      await get().fetchTasks()
    },

    fetchTasks: async () => {
      set({ isLoading: true })
      try {
        const tasks = await listCurrent()
        set(tasks ? { tasks, isLoading: false } : { isLoading: false })
      } catch {
        set({ isLoading: false })
      }
    },

    syncAndFetch: async () => {
      set({ isSyncing: true })
      try {
        await api.taskSources.syncAll()
      } catch (e) {
        console.error('Failed to sync task sources:', e)
      }
      // Always re-fetch tasks after sync (even if sync failed, tasks may have changed)
      try {
        const tasks = await listCurrent()
        set(tasks ? { tasks, isSyncing: false } : { isSyncing: false })
      } catch {
        set({ isSyncing: false })
      }
    },

    createTask: async (data) => {
      try {
        const projectId = get().currentProjectId
        const payload = projectId && data.project_id === undefined && !data.parent_task_id
          ? { ...data, project_id: projectId }
          : data
        const task = (await api.tasks.create(payload)) as Task
        set((state) => {
          if (state.tasks.some((t) => t.id === task.id)) return state
          if (!belongsToCurrentProject(task, state.currentProjectId)) return state
          return { tasks: [task, ...state.tasks] }
        })
        return task
      } catch (e) {
        console.error('Failed to create task:', e)
        return null
      }
    },

    updateTask: async (id, data) => {
      try {
        const updated = (await api.tasks.update(id, data)) as Task
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === id ? updated : t))
        }))
        return true
      } catch (e) {
        console.error('Failed to update task:', e)
        return false
      }
    }
  }
})

function belongsToCurrentProject(task: Task, currentProjectId: string | null): boolean {
  return !currentProjectId || !task.project_id || task.project_id === currentProjectId
}
