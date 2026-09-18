/**
 * Remembers which git provider each attached repository came from. Task repos
 * are stored as bare `owner/repo` names, so without this map a Forgejo or
 * GitLab repo attached while another provider is the global default would be
 * cloned with the wrong CLI when the agent session starts.
 */

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

/** Provider recorded for the repo, else the global default, else GitHub. */
export function resolveRepoProvider(db: SettingsStore, fullName: string): GitProvider {
  const recorded = getRepoProviders(db)[fullName]
  if (recorded) return recorded
  const configured = db.getSetting('git_provider')
  return isGitProvider(configured) ? configured : 'github'
}
