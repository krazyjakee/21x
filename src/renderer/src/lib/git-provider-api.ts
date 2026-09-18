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

/**
 * Returns the appropriate API client for the given provider.
 * Defaults to GitHub if provider is not set.
 */
export function getGitProviderApi(provider: GitProvider | null): GitProviderApi {
  if (provider === 'gitlab') {
    return {
      checkCli: gitlabApi.checkCli,
      fetchOrgs: gitlabApi.fetchOrgs,
      fetchOrgRepos: gitlabApi.fetchOrgRepos,
      fetchUserRepos: gitlabApi.fetchUserRepos
    }
  }

  if (provider === 'forgejo') {
    return {
      checkCli: forgejoApi.checkCli,
      fetchOrgs: forgejoApi.fetchOrgs,
      fetchOrgRepos: forgejoApi.fetchOrgRepos,
      fetchUserRepos: forgejoApi.fetchUserRepos
    }
  }

  // Default: GitHub
  return {
    checkCli: githubApi.checkCli,
    fetchOrgs: githubApi.fetchOrgs,
    fetchOrgRepos: githubApi.fetchOrgRepos,
    fetchUserRepos: githubApi.fetchUserRepos
  }
}

/**
 * Fetch orgs from ALL authenticated providers and merge them into
 * a single list. Each entry is tagged with its provider so callers
 * can route repo fetches to the correct backend.
 */
export async function fetchAllProviderOrgs(): Promise<OrgEntry[]> {
  // Helper: fetch orgs from one provider, swallowing errors
  const tryProvider = async (
    provider: GitProvider,
    checkCli: () => Promise<{ authenticated: boolean; username?: string }>,
    fetchOrgs: () => Promise<string[]>,
    providerLabel: string
  ): Promise<OrgEntry[]> => {
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
    tryProvider('github', githubApi.checkCli, githubApi.fetchOrgs, 'GitHub'),
    tryProvider('gitlab', gitlabApi.checkCli, gitlabApi.fetchOrgs, 'GitLab'),
    tryProvider('forgejo', forgejoApi.checkCli, forgejoApi.fetchOrgs, 'Forgejo')
  ])

  return [...ghEntries, ...glEntries, ...fjEntries]
}

/**
 * Returns a human-readable label for the provider.
 */
export function getProviderLabel(provider: GitProvider | null): string {
  if (provider === 'gitlab') return 'GitLab'
  if (provider === 'forgejo') return 'Forgejo'
  return 'GitHub'
}
