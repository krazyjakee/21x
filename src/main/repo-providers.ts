/**
 * Remembers which git provider each attached repository came from. Task repos
 * are stored as bare `owner/repo` names, so without this map a Forgejo or
 * GitLab repo attached while another provider is the global default would be
 * cloned with the wrong CLI when the agent session starts. Also holds the
 * repo-listing helpers the provider managers share.
 */

import type { GitHubRepo } from './github-manager'

export type GitProvider = 'github' | 'gitlab' | 'forgejo'

export const REPO_PROVIDERS_SETTING = 'repo_providers'

/** Setting key holding the tea login name the user chose in 20x for Forgejo. */
export const FORGEJO_LOGIN_SETTING = 'forgejo_login'

const GIT_PROVIDERS: readonly GitProvider[] = ['github', 'gitlab', 'forgejo']

interface SettingsStore {
  getSetting(key: string): string | undefined | null
  setSetting(key: string, value: string): void
}

export function isGitProvider(value: unknown): value is GitProvider {
  return typeof value === 'string' && (GIT_PROVIDERS as readonly string[]).includes(value)
}

export function getRepoProviders(db: SettingsStore): Record<string, GitProvider> {
  const raw = db.getSetting(REPO_PROVIDERS_SETTING)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => isGitProvider(value))) as Record<string, GitProvider>
  } catch {
    return {}
  }
}

export function recordRepoProviders(db: SettingsStore, fullNames: string[], provider: GitProvider): void {
  const map = getRepoProviders(db)
  let changed = false
  for (const fullName of fullNames) {
    if (map[fullName] !== provider) {
      map[fullName] = provider
      changed = true
    }
  }
  if (changed) db.setSetting(REPO_PROVIDERS_SETTING, JSON.stringify(map))
}

/** GitHub's repo JSON; Forgejo's API returns the same shape. */
export function mapGitHubStyleRepo(raw: Record<string, unknown>): GitHubRepo {
  return {
    name: raw.name as string,
    fullName: raw.full_name as string,
    defaultBranch: (raw.default_branch as string) || 'main',
    cloneUrl: raw.clone_url as string,
    description: (raw.description as string) || '',
    isPrivate: raw.private === true
  }
}

/** Maps raw repos, keeping one per fullName (paginated listings can repeat a repo). */
export function uniqueRepos(raw: Record<string, unknown>[], map: (raw: Record<string, unknown>) => GitHubRepo): GitHubRepo[] {
  const byFullName = new Map<string, GitHubRepo>()
  for (const item of raw) {
    const repo = map(item)
    byFullName.set(repo.fullName, repo)
  }
  return Array.from(byFullName.values())
}

/** Top-level namespace of a repo (`group/sub/project` → `group`). */
export function repoOwner(repo: GitHubRepo): string {
  return repo.fullName.split('/')[0]
}

/** Distinct owner names other than the signed-in user, sorted. */
export function otherOwners(names: Array<string | undefined>, username: string | undefined): string[] {
  const owners = new Set(names.filter((name): name is string => !!name && name !== username))
  return Array.from(owners).sort((left, right) => left.localeCompare(right))
}
