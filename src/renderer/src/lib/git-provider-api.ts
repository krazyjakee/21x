/**
 * Unified Git provider API that delegates to GitHub, GitLab, or Forgejo
 * based on the user's configured git_provider setting.
 *
 * When several providers are authenticated, orgs from all of them
 * are merged so the user sees everything in one list.
 */
import { githubApi, gitlabApi, forgejoApi } from './ipc-client'
import type { GhCliStatus, GitHubRepo } from '@/types/electron'
import type { GitProvider } from '@/stores/settings-store'

export interface GitProviderApi {
  checkCli: () => Promise<GhCliStatus>
  fetchOrgs: () => Promise<string[]>
  fetchOrgRepos: (org: string) => Promise<GitHubRepo[]>
  fetchUserRepos: () => Promise<GitHubRepo[]>
}

/** An org/account entry tagged with the provider it came from. */
export interface OrgEntry {
  value: string
  label: string
  provider: GitProvider
}

const PROVIDER_APIS: Record<GitProvider, GitProviderApi> = {
  github: githubApi,
  gitlab: gitlabApi,
  forgejo: forgejoApi
}

/** Defaults to GitHub when no provider is set. */
export function getGitProviderApi(provider: GitProvider | null): GitProviderApi {
  return PROVIDER_APIS[provider ?? 'github'] ?? githubApi
}

/**
 * Fetch orgs from ALL authenticated providers and merge them into
 * a single list. Each entry is tagged with its provider so callers
 * can route repo fetches to the correct backend.
 */
export async function fetchAllProviderOrgs(): Promise<OrgEntry[]> {
  const tryProvider = async (provider: GitProvider, providerLabel: string): Promise<OrgEntry[]> => {
    const { checkCli, fetchOrgs } = PROVIDER_APIS[provider]
    try {
      const [status, orgs] = await Promise.all([checkCli(), fetchOrgs()])
      if (!status.authenticated) return []
      const result: OrgEntry[] = []
      if (status.username) {
        result.push({
          value: status.username,
          label: `${status.username} (${providerLabel} personal)`,
          provider
        })
      }
      for (const org of orgs) {
        result.push({ value: org, label: `${org} (${providerLabel})`, provider })
      }
      return result
    } catch {
      return [] // provider not available — skip
    }
  }

  const [ghEntries, glEntries, fjEntries] = await Promise.all([
    tryProvider('github', 'GitHub'),
    tryProvider('gitlab', 'GitLab'),
    tryProvider('forgejo', 'Forgejo')
  ])

  return [...ghEntries, ...glEntries, ...fjEntries]
}
