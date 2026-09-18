import { projectApi } from '@/lib/ipc-client'
import { useProjectStore } from '@/stores/project-store'
import type { ProjectRecord, ProjectRepoRecord, ProjectResourceRecord } from '@shared/projects'

/**
 * The project editor works on a draft and writes it in one go on save:
 * the project row, then the repo and resource lists (adds, edits, removals
 * and order). A new project and an existing one take the same path.
 */

export type GitProviderId = 'github' | 'gitlab' | 'forgejo'
export const GIT_PROVIDER_LABELS: Record<GitProviderId, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  forgejo: 'Forgejo'
}

export interface RepoDraft {
  /** Stable React key; the record id for saved rows. */
  key: string
  id?: string
  provider: string
  org: string
  name: string
  /** '' = the remote's default branch. */
  default_branch: string
}

export interface ResourceDraft {
  key: string
  id?: string
  label: string
  url: string
  notes: string
}

export interface ProjectDraft {
  name: string
  description: string
  default_agent_id: string | null
  mastermind_agent_id: string | null
  /** null = the global git provider setting. */
  git_provider: string | null
  /** null = the global org setting. */
  git_org: string | null
  /** The project's settings JSON (#49): limits (#65), escalation (#66) and other keyed blocks. */
  settings: Record<string, unknown>
  repos: RepoDraft[]
  resources: ResourceDraft[]
}

export interface ProjectDraftOriginal {
  repos: ProjectRepoRecord[]
  resources: ProjectResourceRecord[]
}

let draftKeySeq = 0
export function newDraftKey(): string {
  draftKeySeq += 1
  return `draft-${draftKeySeq}`
}

export function emptyProjectDraft(): ProjectDraft {
  return {
    name: '',
    description: '',
    default_agent_id: null,
    mastermind_agent_id: null,
    git_provider: null,
    git_org: null,
    settings: {},
    repos: [],
    resources: []
  }
}

export function draftFromProject(
  project: ProjectRecord,
  repos: ProjectRepoRecord[],
  resources: ProjectResourceRecord[]
): ProjectDraft {
  return {
    name: project.name,
    description: project.description,
    default_agent_id: project.default_agent_id,
    mastermind_agent_id: project.mastermind_agent_id,
    git_provider: project.git_provider,
    git_org: project.git_org,
    settings: project.settings ?? {},
    repos: repos.map((r) => ({
      key: r.id,
      id: r.id,
      provider: r.provider,
      org: r.org,
      name: r.name,
      default_branch: r.default_branch ?? ''
    })),
    resources: resources.map((r) => ({
      key: r.id,
      id: r.id,
      label: r.label,
      url: r.url ?? '',
      notes: r.notes
    }))
  }
}

/**
 * Resource URLs are checked for shape only — never fetched. Empty is fine
 * (a resource can be just notes). A bare host such as `docs.example.com/x`
 * is accepted and read as https.
 */
export function normalizeResourceUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/\s/.test(trimmed)) return null
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  const candidate = hasScheme ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    const isWeb = url.protocol === 'http:' || url.protocol === 'https:'
    const hostLooksReal = url.hostname.includes('.') || url.hostname === 'localhost'
    if (isWeb && !hostLooksReal) return null
    return candidate
  } catch {
    return null
  }
}

export function isValidResourceUrl(value: string): boolean {
  return normalizeResourceUrl(value) !== null
}

const HOST_PROVIDERS: Record<string, GitProviderId> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'codeberg.org': 'forgejo'
}

/**
 * Reads a repo typed by hand: `name`, `org/name`, `group/sub/name`, or a
 * clone / web URL (https or ssh). The provider is inferred only from a
 * well-known host; otherwise the caller's choice stands.
 */
export function parseRepoInput(input: string, defaultOrg: string): { org: string; name: string; provider?: GitProviderId } | null {
  let text = input.trim()
  if (!text) return null
  let provider: GitProviderId | undefined

  const ssh = /^[\w.-]+@([\w.-]+):(.+)$/.exec(text)
  const web = /^[a-z]+:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(text)
  const match = ssh ?? web
  if (match) {
    provider = HOST_PROVIDERS[match[1].toLowerCase()]
    text = match[2]
    // Web URLs can carry /tree/<branch>, /-/tree/<branch> and the like.
    if (web) text = text.replace(/\/(?:-\/)?(?:tree|blob|src)\/.*$/, '')
  }

  text = text.replace(/\.git$/i, '').replace(/\/+$/, '').replace(/^\/+/, '')
  const parts = text.split('/').filter(Boolean)
  if (parts.length === 0) return null
  const name = parts[parts.length - 1]
  if (!/^[\w.-]+$/.test(name)) return null
  const org = parts.length > 1 ? parts.slice(0, -1).join('/') : defaultOrg.trim()
  return { org, name, provider }
}

export function repoIdentity(repo: { provider: string; org: string; name: string }): string {
  return `${repo.provider}:${repo.org.toLowerCase()}/${repo.name.toLowerCase()}`
}

/** Problems that block saving, keyed for display. Empty when the draft can be saved. */
export function validateProjectDraft(draft: ProjectDraft): string[] {
  const problems: string[] = []
  if (!draft.name.trim()) problems.push('Give the project a name.')
  const seen = new Set<string>()
  for (const repo of draft.repos) {
    if (!repo.name.trim()) {
      problems.push('Every repo needs a name.')
      continue
    }
    const id = repoIdentity(repo)
    if (seen.has(id)) problems.push(`${repo.org ? `${repo.org}/` : ''}${repo.name} is listed twice.`)
    seen.add(id)
  }
  for (const resource of draft.resources) {
    if (!resource.label.trim()) problems.push('Every resource needs a label.')
    if (!isValidResourceUrl(resource.url)) problems.push(`"${resource.url}" is not a valid URL.`)
  }
  return problems
}

/**
 * Writes the draft: creates or updates the project, then brings its repos and
 * resources in line with the draft, in the draft's order. Returns the saved
 * project; throws with the first validation problem.
 */
export async function saveProjectDraft(
  projectId: string | null,
  draft: ProjectDraft,
  original: ProjectDraftOriginal = { repos: [], resources: [] }
): Promise<ProjectRecord> {
  const problems = validateProjectDraft(draft)
  if (problems.length > 0) throw new Error(problems[0])

  const store = useProjectStore.getState()
  const fields = {
    name: draft.name.trim(),
    description: draft.description,
    default_agent_id: draft.default_agent_id || null,
    mastermind_agent_id: draft.mastermind_agent_id || null,
    git_provider: draft.git_provider || null,
    git_org: draft.git_org?.trim() || null,
    settings: draft.settings
  }
  const project = projectId
    ? await store.updateProject(projectId, fields)
    : await store.createProject(fields)
  if (!project) throw new Error(useProjectStore.getState().error ?? 'The project could not be saved.')

  // ── Repos ──
  const keptRepoIds = new Set(draft.repos.map((r) => r.id).filter(Boolean))
  for (const repo of original.repos) {
    if (!keptRepoIds.has(repo.id)) await projectApi.removeRepo(repo.id)
  }
  const originalRepos = new Map(original.repos.map((r) => [r.id, r]))
  const repoOrder: string[] = []
  for (const repo of draft.repos) {
    const data = {
      name: repo.name.trim(),
      provider: repo.provider,
      org: repo.org.trim(),
      default_branch: repo.default_branch.trim() || null
    }
    const before = repo.id ? originalRepos.get(repo.id) : undefined
    if (!before) {
      const added = await projectApi.addRepo(project.id, data)
      if (added) repoOrder.push(added.id)
      continue
    }
    if (before.name !== data.name || before.provider !== data.provider || before.org !== data.org || (before.default_branch ?? null) !== data.default_branch) {
      await projectApi.updateRepo(before.id, data)
    }
    repoOrder.push(before.id)
  }
  if (repoOrder.length > 1) await projectApi.reorderRepos(project.id, repoOrder)

  // ── Resources ──
  const keptResourceIds = new Set(draft.resources.map((r) => r.id).filter(Boolean))
  for (const resource of original.resources) {
    if (!keptResourceIds.has(resource.id)) await projectApi.removeResource(resource.id)
  }
  const originalResources = new Map(original.resources.map((r) => [r.id, r]))
  const resourceOrder: string[] = []
  for (const resource of draft.resources) {
    const data = {
      label: resource.label.trim(),
      url: normalizeResourceUrl(resource.url) || null,
      notes: resource.notes
    }
    const before = resource.id ? originalResources.get(resource.id) : undefined
    if (!before) {
      const added = await projectApi.addResource(project.id, data)
      if (added) resourceOrder.push(added.id)
      continue
    }
    if (before.label !== data.label || (before.url ?? null) !== data.url || before.notes !== data.notes) {
      await projectApi.updateResource(before.id, data)
    }
    resourceOrder.push(before.id)
  }
  if (resourceOrder.length > 1) await projectApi.reorderResources(project.id, resourceOrder)

  return project
}

/** Moves the item at `index` one step up (-1) or down (+1). */
export function moveItem<T>(items: T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta
  if (target < 0 || target >= items.length) return items
  const next = [...items]
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item)
  return next
}
