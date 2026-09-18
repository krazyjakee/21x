import { create } from 'zustand'
import { settingsApi, githubApi, gitlabApi, forgejoApi } from '@/lib/ipc-client'
import type { GhCliStatus, GlabCliStatus, TeaCliStatus } from '@/types/electron'

export type GitProvider = 'github' | 'gitlab' | 'forgejo'

const GIT_PROVIDERS: readonly string[] = ['github', 'gitlab', 'forgejo']

interface SettingsState {
  githubOrg: string | null
  ghCliStatus: GhCliStatus | null
  glabCliStatus: GlabCliStatus | null
  teaCliStatus: TeaCliStatus | null
  gitProvider: GitProvider | null
  isLoading: boolean

  fetchSettings: () => Promise<void>
  setGithubOrg: (org: string) => Promise<void>
  setGitProvider: (provider: GitProvider | null) => Promise<void>
  checkGhCli: () => Promise<GhCliStatus>
  checkGlabCli: () => Promise<GlabCliStatus>
  checkTeaCli: () => Promise<TeaCliStatus>
  setForgejoLogin: (loginName: string | null) => Promise<TeaCliStatus>
}

export const useSettingsStore = create<SettingsState>((set) => ({
  githubOrg: null,
  ghCliStatus: null,
  glabCliStatus: null,
  teaCliStatus: null,
  gitProvider: null,
  isLoading: false,

  fetchSettings: async () => {
    set({ isLoading: true })
    try {
      const all = await settingsApi.getAll()
      set({
        githubOrg: all.github_org || null,
        gitProvider: GIT_PROVIDERS.includes(all.git_provider)
          ? all.git_provider as GitProvider
          : null,
        isLoading: false
      })
    } catch {
      set({ isLoading: false })
    }
  },

  setGithubOrg: async (org: string) => {
    await settingsApi.set('github_org', org)
    set({ githubOrg: org })
  },

  setGitProvider: async (provider: GitProvider | null) => {
    await settingsApi.set('git_provider', provider ?? '')
    set({ gitProvider: provider })
  },

  checkGhCli: async () => {
    const status = await githubApi.checkCli()
    set({ ghCliStatus: status })
    return status
  },

  checkGlabCli: async () => {
    const status = await gitlabApi.checkCli()
    set({ glabCliStatus: status })
    return status
  },

  checkTeaCli: async () => {
    const status = await forgejoApi.checkCli()
    set({ teaCliStatus: status })
    return status
  },

  setForgejoLogin: async (loginName: string | null) => {
    const status = await forgejoApi.setLogin(loginName)
    set({ teaCliStatus: status })
    return status
  }
}))
