import { HttpError } from '../http-utils'
import { isGitProvider, recordRepoProviders } from '../repo-providers'
import { deps, type MobileRoute } from './state'

type Owner = { value: string; label: string; provider: string }

/** Every personal account and org of each authenticated provider. */
async function listOwners(): Promise<Owner[]> {
  const { githubManager: github, gitlabManager: gitlab, forgejoManager: forgejo } = deps
  const owners: Owner[] = []
  const add = (username: string | undefined, orgs: string[], provider: string, name: string): void => {
    if (username) owners.push({ value: username, label: `${username} (${name} personal)`, provider })
    for (const orgName of orgs) owners.push({ value: orgName, label: `${orgName} (${name})`, provider })
  }

  if (github) {
    try {
      const [status, orgs] = await Promise.all([github.checkGhCli(), github.fetchUserOrgs()])
      if (status.authenticated) add(status.username, orgs, 'github', 'GitHub')
    } catch { /* GitHub not available — skip */ }
  }

  if (gitlab) {
    try {
      const [status, orgs] = await Promise.all([gitlab.checkGlabCli(), gitlab.fetchUserOrgs()])
      if (status.authenticated) add(status.username, orgs, 'gitlab', 'GitLab')
    } catch { /* GitLab not available — skip */ }
  }

  // Forgejo goes through the tea login selected in 20x.
  if (forgejo) {
    try {
      const status = await forgejo.checkTeaCli()
      if (status.authenticated) add(status.username, await forgejo.fetchUserOrgs(), 'forgejo', 'Forgejo')
    } catch { /* Forgejo not available — skip */ }
  }

  if (owners.length === 0) throw new HttpError(500, 'No git provider authenticated')
  return owners
}

export const gitRoutes: MobileRoute[] = [
  {
    method: 'GET',
    path: '/api/github/pull-request',
    handle: async ({ url }) => {
      const { githubManager: github, forgejoManager: forgejo } = deps
      const pullRequestUrl = url.searchParams.get('url')
      if (!pullRequestUrl) throw new HttpError(400, 'url is required')
      if (forgejo && !/^https:\/\/github\.com\//i.test(pullRequestUrl) && await forgejo.isForgejoUrl(pullRequestUrl)) {
        return forgejo.fetchPullRequestDetails(pullRequestUrl)
      }
      if (!github) throw new HttpError(500, 'GitHub not configured')
      return github.fetchPullRequestDetails(pullRequestUrl)
    }
  },
  { method: 'GET', path: '/api/github/org', handle: () => ({ org: deps.db.getSetting('github_org') || '' }) },
  { method: 'GET', path: '/api/git/provider', handle: () => ({ provider: deps.db.getSetting('git_provider') || 'github' }) },
  { method: 'GET', path: '/api/github/orgs', handle: listOwners },
  {
    // `provider` picks the backend; without it the configured git_provider
    // setting does, for older clients.
    method: 'POST',
    path: '/api/github/repos',
    handle: async ({ params }) => {
      const { db, githubManager: github, gitlabManager: gitlab, forgejoManager: forgejo } = deps
      const { org, provider: reqProvider } = params as { org?: string; provider?: string }
      if (!org) throw new HttpError(400, 'org is required')

      const provider = reqProvider || db.getSetting('git_provider') || 'github'
      if (provider === 'gitlab') {
        if (!gitlab) throw new HttpError(500, 'GitLab not configured')
        return gitlab.fetchOrgRepos(org)
      }
      if (provider === 'forgejo') {
        if (!forgejo) throw new HttpError(500, 'Forgejo not configured')
        return forgejo.fetchOrgRepos(org)
      }
      if (!github) throw new HttpError(500, 'GitHub not configured')
      return github.fetchOrgRepos(org)
    }
  },
  {
    // Remembers which provider attached repos came from.
    method: 'POST',
    path: '/api/git/repo-providers',
    handle: ({ params }) => {
      const { repos, provider } = params as { repos?: unknown; provider?: unknown }
      if (!Array.isArray(repos) || !isGitProvider(provider)) {
        throw new HttpError(400, 'repos and a valid provider are required')
      }
      recordRepoProviders(deps.db, repos.filter((repo): repo is string => typeof repo === 'string'), provider)
      return { success: true }
    }
  },
  {
    method: 'POST',
    path: '/api/github/org',
    handle: ({ params }) => {
      const { org } = params as { org?: string }
      if (!org) throw new HttpError(400, 'org is required')
      deps.db.setSetting('github_org', org)
      return { org }
    }
  }
]
