import { create } from 'zustand'
import type { Skill, CreateSkillDTO, UpdateSkillDTO } from '@/types'
import { skillApi } from '@/lib/ipc-client'
import { captureDesktopRead } from '@/lib/desktop-api'
import { createDesktopSnapshotReader } from '@/lib/desktop-snapshot'

/** The Skills view filter (#74): every scope, global skills only, or one project's skills. */
export type SkillScopeFilter = 'all' | 'global' | { projectId: string }

interface SkillState {
  skills: Skill[]
  selectedSkillId: string | null
  scopeFilter: SkillScopeFilter
  isLoading: boolean
  error: string | null

  fetchSkills: () => Promise<void>
  createSkill: (data: CreateSkillDTO) => Promise<Skill | null>
  updateSkill: (id: string, data: UpdateSkillDTO) => Promise<Skill | null>
  deleteSkill: (id: string) => Promise<boolean>
  /** Promote to global (null) or move into a project: the explicit scope change. */
  setSkillProject: (id: string, projectId: string | null) => Promise<Skill | null>
  selectSkill: (id: string | null) => void
  setScopeFilter: (filter: SkillScopeFilter) => void
  clearError: () => void
}

/** True when the skill is in the filter's scope. */
export function matchesScopeFilter(skill: Pick<Skill, 'project_id'>, filter: SkillScopeFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'global') return !skill.project_id
  return skill.project_id === filter.projectId
}

let requested = false, documentGeneration = 0
let releaseListeners: (() => void) | undefined
function captureSkillIntent() {
  initializeSkillDesktopState()
  const generation = documentGeneration, scope = captureDesktopRead()
  return () => generation === documentGeneration && scope.isCurrent()
}

export const useSkillStore = create<SkillState>((set) => ({
  skills: [],
  selectedSkillId: null,
  scopeFilter: 'all',
  isLoading: false,
  error: null,

  fetchSkills: async () => {
    initializeSkillDesktopState(); requested = true
    skillSnapshot.invalidate()
    await skillSnapshot.refresh().catch(() => {})
  },

  createSkill: async (data) => {
    const current = captureSkillIntent()
    try {
      const skill = await skillApi.create(data)
      if (!current()) return skill
      requested = true; skillSnapshot.invalidate()
      // Sort by confidence (high to low)
      set((state) => ({ skills: [...state.skills.filter(item => item.id !== skill.id), skill].sort((a, b) => b.confidence - a.confidence) }))
      return skill
    } catch (err) {
      if (current()) set({ error: String(err) })
      return null
    }
  },

  updateSkill: async (id, data) => {
    const current = captureSkillIntent()
    try {
      const updated = await skillApi.update(id, data)
      if (updated && current()) {
        requested = true; skillSnapshot.invalidate()
        set((state) => ({
          // Sort by confidence (high to low) after update
          skills: state.skills.map((s) => (s.id === id ? updated : s)).sort((a, b) => b.confidence - a.confidence)
        }))
      }
      return updated || null
    } catch (err) {
      if (current()) set({ error: String(err) })
      return null
    }
  },

  deleteSkill: async (id) => {
    const current = captureSkillIntent()
    try {
      const success = await skillApi.delete(id)
      if (success && current()) {
        requested = true; skillSnapshot.invalidate()
        set((state) => ({
          skills: state.skills.filter((s) => s.id !== id),
          selectedSkillId: state.selectedSkillId === id ? null : state.selectedSkillId
        }))
      }
      return success
    } catch (err) {
      if (current()) set({ error: String(err) })
      return false
    }
  },

  setSkillProject: async (id, projectId) => {
    const current = captureSkillIntent()
    try {
      const updated = await skillApi.setProject(id, projectId)
      if (updated && current()) {
        requested = true; skillSnapshot.invalidate()
        set((state) => ({ skills: state.skills.map((s) => (s.id === id ? updated : s)), error: null }))
      }
      return updated || null
    } catch (err) {
      if (current()) set({ error: String(err) })
      return null
    }
  },

  selectSkill: (id) => set({ selectedSkillId: id }),
  setScopeFilter: (scopeFilter) => set({ scopeFilter }),
  clearError: () => set({ error: null })
}))

const skillSnapshot = createDesktopSnapshotReader({
  read: () => skillApi.getAll(),
  start: () => useSkillStore.setState({ isLoading: true, error: null }),
  apply: skills => useSkillStore.setState(state => ({
    skills: [...skills].sort((a, b) => b.confidence - a.confidence), isLoading: false, error: null,
    selectedSkillId: skills.some(skill => skill.id === state.selectedSkillId) ? state.selectedSkillId : null
  })),
  fail: error => useSkillStore.setState({ isLoading: false, error: String(error) })
})

/** One document-owned invalidation listener also serves agent/task selectors. */
export function initializeSkillDesktopState(): () => void {
  if (releaseListeners) return releaseListeners
  let active = true
  const off = skillApi.onChanged?.(() => {
    if (!active) return
    skillSnapshot.invalidate()
    if (requested) void skillSnapshot.refresh().catch(() => {})
  })
  const release = () => {
    if (releaseListeners !== release) return
    active = false; releaseListeners = undefined; requested = false; documentGeneration++
    skillSnapshot.dispose(); off?.(); window.removeEventListener('pagehide', release)
  }
  releaseListeners = release
  window.addEventListener('pagehide', release, { once: true })
  return release
}
export async function rehydrateSkillDesktopState(): Promise<void> {
  if (!requested) return
  initializeSkillDesktopState(); skillSnapshot.invalidate()
  await skillSnapshot.refresh()
}
initializeSkillDesktopState()
if (import.meta.hot) import.meta.hot.dispose(() => releaseListeners?.())
