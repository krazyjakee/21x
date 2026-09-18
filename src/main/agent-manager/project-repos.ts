/**
 * The repos a task may use, and where each one lives, come from the task's
 * project: its `project_repos` rows, then its `git_provider` / `git_org`.
 *
 * The global `git_provider` / `github_org` settings are read only for the
 * Default project, which holds everything that existed before projects did.
 * Any other project that names no provider uses GitHub, and one that names no
 * org can use bare repo names only through its own `project_repos` rows.
 */
import type { DatabaseManager } from '../database'
import { DEFAULT_PROJECT_ID, type ProjectRepoRecord } from '../../shared/projects'
import { getRepoProviders, isGitProvider, type GitProvider } from '../repo-providers'

type ProjectRepoStore = Pick<DatabaseManager, 'getProject' | 'getProjectRepos' | 'getSetting'>

/** A repo as a session sees it: where to clone it from and which branch to start on. */
export interface ResolvedRepo {
  /** `org/name`, or the bare name when neither the repo nor the project has an org. */
  fullName: string
  name: string
  org: string
  provider: GitProvider
  /** null = the remote's default branch. */
  defaultBranch: string | null
}

/** The project a task belongs to; rows written before projects existed belong to the Default project. */
export function taskProjectId(task: { project_id?: string | null } | null | undefined): string {
  return task?.project_id || DEFAULT_PROJECT_ID
}

/** The provider and org a bare repo name of this project resolves against. */
export function projectGitDefaults(db: ProjectRepoStore, projectId: string): { provider: GitProvider; org: string | null } {
  const project = db.getProject(projectId)
  const isDefault = projectId === DEFAULT_PROJECT_ID
  // Transition: the Default project falls back to the global settings; no other project does.
  const provider = project?.git_provider || (isDefault ? db.getSetting('git_provider') : null)
  const org = project?.git_org || (isDefault ? db.getSetting('github_org') : null)
  return { provider: isGitProvider(provider) ? provider : 'github', org: org || null }
}

function toResolved(row: ProjectRepoRecord, fallbackOrg: string | null): ResolvedRepo {
  const org = row.org || fallbackOrg || ''
  return {
    fullName: org ? `${org}/${row.name}` : row.name,
    name: row.name,
    org,
    provider: isGitProvider(row.provider) ? row.provider : 'github',
    defaultBranch: row.default_branch || null
  }
}

/** Every repo attached to the project, in its display order. */
export function listProjectRepos(db: ProjectRepoStore, projectId: string): ResolvedRepo[] {
  const { org } = projectGitDefaults(db, projectId)
  return db.getProjectRepos(projectId).map((row) => toResolved(row, org))
}

function normalizeRepoEntry(entry: string): string {
  return entry.trim().replace(/^\/+|\/+$/g, '')
}

/**
 * The project repo a task's repo entry names: an exact `org/name` match, or a
 * bare name that picks out one repo (the project's own org breaks a tie).
 */
export function matchProjectRepo(repos: ResolvedRepo[], entry: string, defaultOrg: string | null): ResolvedRepo | undefined {
  const wanted = normalizeRepoEntry(entry).toLowerCase()
  if (!wanted) return undefined
  const exact = repos.find((repo) => repo.fullName.toLowerCase() === wanted)
  if (exact || wanted.includes('/')) return exact
  const byName = repos.filter((repo) => repo.name.toLowerCase() === wanted)
  if (byName.length <= 1) return byName[0]
  return byName.find((repo) => defaultOrg && repo.org.toLowerCase() === defaultOrg.toLowerCase())
}

/**
 * Where each of a task's repos is cloned from. A repo attached to the project
 * uses its own row; any other entry (set from the UI, or from a task source)
 * resolves with the provider recorded when it was attached, else the project's.
 * An entry that has no org and whose project has none is dropped with a warning.
 */
export function resolveTaskRepos(
  db: ProjectRepoStore,
  task: { repos?: string[] | null; project_id?: string | null }
): ResolvedRepo[] {
  const projectId = taskProjectId(task)
  const defaults = projectGitDefaults(db, projectId)
  const projectRepos = listProjectRepos(db, projectId)
  const recorded = getRepoProviders({ getSetting: (key) => db.getSetting(key), setSetting: () => {} })
  const resolved: ResolvedRepo[] = []
  for (const raw of task.repos ?? []) {
    if (typeof raw !== 'string') continue
    const entry = normalizeRepoEntry(raw)
    if (!entry) continue
    const match = matchProjectRepo(projectRepos, entry, defaults.org)
    if (match && match.org) {
      resolved.push(match)
      continue
    }
    const slash = entry.lastIndexOf('/')
    const org = slash >= 0 ? entry.slice(0, slash) : defaults.org
    if (!org) {
      console.warn(`[AgentManager] Skipping repo "${entry}": it has no org, and project ${projectId} configures none`)
      continue
    }
    const name = slash >= 0 ? entry.slice(slash + 1) : entry
    const fullName = `${org}/${name}`
    resolved.push({
      fullName,
      name,
      org,
      provider: match?.provider ?? recorded[fullName] ?? defaults.provider,
      defaultBranch: match?.defaultBranch ?? null
    })
  }
  return resolved
}

/**
 * Checks repos an agent asked for against the project's repos. Entries in
 * `alreadyAllowed` (the repos the task or its parent already carries) pass
 * unchanged, so an update does not fail over a repo someone set in the UI.
 * Returns the canonical `org/name` list, or an error naming what is unknown.
 */
export function validateProjectRepos(
  db: ProjectRepoStore,
  projectId: string,
  requested: string[],
  alreadyAllowed: string[] = []
): { repos: string[] } | { error: string } {
  const defaults = projectGitDefaults(db, projectId)
  const projectRepos = listProjectRepos(db, projectId)
  const allowed = new Set(alreadyAllowed.map((repo) => normalizeRepoEntry(repo).toLowerCase()))
  const repos: string[] = []
  const unknown: string[] = []
  for (const raw of requested) {
    if (typeof raw !== 'string') { unknown.push(String(raw)); continue }
    const entry = normalizeRepoEntry(raw)
    if (!entry) continue
    const match = matchProjectRepo(projectRepos, entry, defaults.org)
    if (match) repos.push(match.fullName)
    else if (allowed.has(entry.toLowerCase())) repos.push(entry)
    else unknown.push(raw)
  }
  if (unknown.length > 0) {
    const known = projectRepos.map((repo) => repo.fullName)
    return {
      error: `Unknown repo(s) for this task's project: ${unknown.join(', ')}. ` +
        (known.length > 0
          ? `The project's repos are: ${known.join(', ')}. Call list_repos to see them.`
          : 'This project has no repos, so its tasks run without any. Add a repo to the project first.')
    }
  }
  return { repos: Array.from(new Set(repos)) }
}
