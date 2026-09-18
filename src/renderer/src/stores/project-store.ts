import { create } from 'zustand'
import { projectApi, settingsApi } from '@/lib/ipc-client'
import {
  DEFAULT_PROJECT_ID,
  type ProjectRecord,
  type CreateProjectData,
  type UpdateProjectData
} from '@shared/projects'

/** Settings key holding the project the task-facing views are scoped to. */
export const CURRENT_PROJECT_SETTING = 'current_project_id'

/**
 * The current project and the list of projects. Every task-facing view reads
 * `currentProjectId` from here; later features (the per-project canvas, the
 * per-project Mastermind) subscribe to the same field. The Commander view is
 * deliberately cross-project and ignores it.
 */
interface ProjectState {
  /** Every project, archived ones included, in the user's order. */
  projects: ProjectRecord[]
  currentProjectId: string
  isLoaded: boolean
  error: string | null

  /** Loads the projects and restores the persisted selection (Default when it is gone or archived). */
  init: () => Promise<void>
  fetchProjects: () => Promise<void>
  setCurrentProject: (id: string) => void
  createProject: (data: CreateProjectData) => Promise<ProjectRecord | null>
  updateProject: (id: string, data: UpdateProjectData) => Promise<ProjectRecord | null>
  archiveProject: (id: string, archived?: boolean) => Promise<ProjectRecord | null>
  reorderProjects: (orderedIds: string[]) => Promise<void>
}

function isSelectable(projects: ProjectRecord[], id: string | null | undefined): id is string {
  return !!id && projects.some((project) => project.id === id && !project.archived)
}

function sortProjects(projects: ProjectRecord[]): ProjectRecord[] {
  return [...projects].sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
}

function replaceProject(projects: ProjectRecord[], updated: ProjectRecord): ProjectRecord[] {
  return projects.some((p) => p.id === updated.id)
    ? projects.map((p) => (p.id === updated.id ? updated : p))
    : sortProjects([...projects, updated])
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentProjectId: DEFAULT_PROJECT_ID,
  isLoaded: false,
  error: null,

  init: async () => {
    await get().fetchProjects()
    let stored: string | null = null
    try {
      stored = await settingsApi.get(CURRENT_PROJECT_SETTING)
    } catch {
      stored = null
    }
    const { projects, currentProjectId } = get()
    // A switch made while the setting was loading wins over the stored value.
    const wanted = currentProjectId !== DEFAULT_PROJECT_ID ? currentProjectId : stored
    get().setCurrentProject(isSelectable(projects, wanted) ? wanted : DEFAULT_PROJECT_ID)
    set({ isLoaded: true })
  },

  fetchProjects: async () => {
    try {
      const projects = sortProjects(await projectApi.getAll({ includeArchived: true }))
      set({ projects, error: null })
      // The current project was archived elsewhere: fall back to Default.
      const { currentProjectId } = get()
      if (projects.length > 0 && !isSelectable(projects, currentProjectId)) {
        get().setCurrentProject(DEFAULT_PROJECT_ID)
      }
    } catch (err) {
      set({ error: String(err) })
    }
  },

  setCurrentProject: (id) => {
    const target = id || DEFAULT_PROJECT_ID
    if (get().currentProjectId === target) return
    set({ currentProjectId: target })
    settingsApi.set(CURRENT_PROJECT_SETTING, target).catch((err) => {
      console.error('[projects] Failed to persist the current project:', err)
    })
  },

  createProject: async (data) => {
    try {
      const created = await projectApi.create(data)
      if (!created) return null
      set((state) => ({ projects: replaceProject(state.projects, created), error: null }))
      return created
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      return null
    }
  },

  updateProject: async (id, data) => {
    try {
      const updated = await projectApi.update(id, data)
      if (!updated) return null
      set((state) => ({ projects: replaceProject(state.projects, updated), error: null }))
      return updated
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      return null
    }
  },

  archiveProject: async (id, archived = true) => {
    try {
      const updated = await projectApi.archive(id, archived)
      if (!updated) return null
      set((state) => ({ projects: replaceProject(state.projects, updated), error: null }))
      if (updated.archived && get().currentProjectId === id) get().setCurrentProject(DEFAULT_PROJECT_ID)
      return updated
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      return null
    }
  },

  reorderProjects: async (orderedIds) => {
    const previous = get().projects
    const rank = new Map(orderedIds.map((id, index) => [id, index]))
    // Optimistic: archived projects not in the list keep their place after the ordered ones.
    set({
      projects: [...previous]
        .map((p) => (rank.has(p.id) ? { ...p, sort_order: rank.get(p.id)! } : p))
        .sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER))
    })
    try {
      await projectApi.reorder(orderedIds)
    } catch (err) {
      set({ projects: previous, error: err instanceof Error ? err.message : String(err) })
    }
  }
}))

/** The current project id, read outside React. */
export function getCurrentProjectId(): string {
  return useProjectStore.getState().currentProjectId
}

/** Tasks written before projects existed have no project; they belong to Default. */
export function projectIdOf(item: { project_id?: string | null }): string {
  return item.project_id || DEFAULT_PROJECT_ID
}

export function isInProject(item: { project_id?: string | null }, projectId: string): boolean {
  return projectIdOf(item) === projectId
}

export function filterToProject<T extends { project_id?: string | null }>(items: T[], projectId: string): T[] {
  return items.filter((item) => isInProject(item, projectId))
}

/** Projects the switcher offers: everything not archived, in order. */
export function activeProjects(projects: ProjectRecord[]): ProjectRecord[] {
  return projects.filter((project) => !project.archived)
}

export function projectName(projects: ProjectRecord[], id: string): string {
  return projects.find((project) => project.id === id)?.name ?? (id === DEFAULT_PROJECT_ID ? 'Default' : 'Unknown project')
}
