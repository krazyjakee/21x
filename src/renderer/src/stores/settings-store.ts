import { create } from 'zustand'
import { settingsApi, githubApi, gitlabApi, forgejoApi } from '@/lib/ipc-client'
import type { GhCliStatus, GlabCliStatus, TeaCliStatus } from '@/types/electron'
import { createDesktopSnapshotReader } from '@/lib/desktop-snapshot'

export type GitProvider = 'github' | 'gitlab' | 'forgejo'

const GIT_PROVIDERS: readonly string[] = ['github', 'gitlab', 'forgejo']

interface SettingsState {
  githubOrg: string | null
  ghCliStatus: GhCliStatus | null
  glabCliStatus: GlabCliStatus | null
  teaCliStatus: TeaCliStatus | null
  gitProvider: GitProvider | null
  isLoading: boolean
  error: string | null

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
  error: null,

  fetchSettings: async () => {
    await settingsSnapshot.refresh().catch(() => {})
  },

  setGithubOrg: async (org: string) => {
    await settingsApi.set('github_org', org)
    settingsSnapshot.invalidate()
    set({ githubOrg: org })
  },

  setGitProvider: async (provider: GitProvider | null) => {
    await settingsApi.set('git_provider', provider ?? '')
    settingsSnapshot.invalidate()
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

const settingsSnapshot = createDesktopSnapshotReader({
  read: () => settingsApi.getAll(),
  start: () => useSettingsStore.setState({ isLoading: true, error: null }),
  apply: all => useSettingsStore.setState({
    githubOrg: all.github_org || null,
    gitProvider: GIT_PROVIDERS.includes(all.git_provider) ? all.git_provider as GitProvider : null,
    isLoading: false, error: null
  }),
  fail: error => useSettingsStore.setState({ isLoading: false, error: String(error) })
})

export function rehydrateSettingsDesktopState(): Promise<void> { return settingsSnapshot.refresh() }
function disposeSettingsDesktopState(): void {
  settingsSnapshot.dispose()
  window.removeEventListener('pagehide', disposeSettingsDesktopState)
}
window.addEventListener('pagehide', disposeSettingsDesktopState, { once: true })
if (import.meta.hot) import.meta.hot.dispose(disposeSettingsDesktopState)
