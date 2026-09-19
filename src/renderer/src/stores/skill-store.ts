import { create } from 'zustand'
import type { Skill, CreateSkillDTO, UpdateSkillDTO } from '@/types'
import { skillApi } from '@/lib/ipc-client'

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

export const useSkillStore = create<SkillState>((set) => ({
  skills: [],
  selectedSkillId: null,
  scopeFilter: 'all',
  isLoading: false,
  error: null,

  fetchSkills: async () => {
    set({ isLoading: true, error: null })
    try {
      const skills = await skillApi.getAll()
      // Sort by confidence (high to low)
      const sortedSkills = skills.sort((a, b) => b.confidence - a.confidence)
      set({ skills: sortedSkills, isLoading: false })
    } catch (err) {
      set({ error: String(err), isLoading: false })
    }
  },

  createSkill: async (data) => {
    try {
      const skill = await skillApi.create(data)
      // Sort by confidence (high to low)
      set((state) => ({ skills: [...state.skills, skill].sort((a, b) => b.confidence - a.confidence) }))
      return skill
    } catch (err) {
      set({ error: String(err) })
      return null
    }
  },

  updateSkill: async (id, data) => {
    try {
      const updated = await skillApi.update(id, data)
      if (updated) {
        set((state) => ({
          // Sort by confidence (high to low) after update
          skills: state.skills.map((s) => (s.id === id ? updated : s)).sort((a, b) => b.confidence - a.confidence)
        }))
      }
      return updated || null
    } catch (err) {
      set({ error: String(err) })
      return null
    }
  },

  deleteSkill: async (id) => {
    try {
      const success = await skillApi.delete(id)
      if (success) {
        set((state) => ({
          skills: state.skills.filter((s) => s.id !== id),
          selectedSkillId: state.selectedSkillId === id ? null : state.selectedSkillId
        }))
      }
      return success
    } catch (err) {
      set({ error: String(err) })
      return false
    }
  },

  setSkillProject: async (id, projectId) => {
    try {
      const updated = await skillApi.setProject(id, projectId)
      if (updated) {
        set((state) => ({ skills: state.skills.map((s) => (s.id === id ? updated : s)), error: null }))
      }
      return updated || null
    } catch (err) {
      set({ error: String(err) })
      return null
    }
  },

  selectSkill: (id) => set({ selectedSkillId: id }),
  setScopeFilter: (scopeFilter) => set({ scopeFilter }),
  clearError: () => set({ error: null })
}))
