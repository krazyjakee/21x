import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import {
  emptyProjectDraft,
  draftFromProject,
  isValidResourceUrl,
  moveItem,
  newDraftKey,
  parseRepoInput,
  saveProjectDraft,
  validateProjectDraft,
  type ProjectDraft,
  type RepoDraft
} from './project-editor'
import { useProjectStore } from '@/stores/project-store'
import { DEFAULT_PROJECT_ID, type ProjectRecord, type ProjectRepoRecord, type ProjectResourceRecord } from '@shared/projects'

const NOW = '2026-01-01T00:00:00.000Z'

function projectRecord(id: string, name: string): ProjectRecord {
  return {
    id, name, description: '', default_agent_id: null, captain_agent_id: null, git_provider: null,
    git_org: null, settings: {}, sort_order: 0, archived: false, created_at: NOW, updated_at: NOW
  }
}

let seq = 0

beforeEach(() => {
  seq = 0
  const projectsApi = {
    create: vi.fn(async (data: { name: string }) => projectRecord('new-project', data.name)),
    update: vi.fn(async (id: string, data: { name: string }) => projectRecord(id, data.name))
  }
  const repos = {
    add: vi.fn(async (projectId: string, data: { name: string; provider: string; org: string; default_branch: string | null }) => ({
      id: `repo-${++seq}`, project_id: projectId, provider: data.provider, org: data.org, name: data.name,
      default_branch: data.default_branch, sort_order: seq, created_at: NOW
    })),
    update: vi.fn(async () => undefined),
    remove: vi.fn(async () => true),
    reorder: vi.fn(async () => undefined),
    list: vi.fn(async () => [])
  }
  const resources = {
    add: vi.fn(async (projectId: string, data: { label: string; url: string | null; notes: string }) => ({
      id: `res-${++seq}`, project_id: projectId, ...data, sort_order: seq, created_at: NOW
    })),
    update: vi.fn(async () => undefined),
    remove: vi.fn(async () => true),
    reorder: vi.fn(async () => undefined),
    list: vi.fn(async () => [])
  }
  ;(window.electronAPI as unknown as Record<string, unknown>).projects = { ...projectsApi, repos, resources }
  useProjectStore.setState({ projects: [projectRecord(DEFAULT_PROJECT_ID, 'Default')], currentProjectId: DEFAULT_PROJECT_ID, error: null })
})

function api() {
  return (window.electronAPI as unknown as { projects: { create: Mock; update: Mock; repos: Record<string, Mock>; resources: Record<string, Mock> } }).projects
}

function repo(provider: string, org: string, name: string, extra: Partial<RepoDraft> = {}): RepoDraft {
  return { key: newDraftKey(), provider, org, name, default_branch: '', ...extra }
}

function draft(fields: Partial<ProjectDraft>): ProjectDraft {
  return { ...emptyProjectDraft(), name: 'Relaunch', ...fields }
}

describe('parseRepoInput', () => {
  it('reads bare names, org/name, nested groups and URLs', () => {
    expect(parseRepoInput('api', 'acme')).toEqual({ org: 'acme', name: 'api', provider: undefined })
    expect(parseRepoInput('other/lib', 'acme')).toEqual({ org: 'other', name: 'lib', provider: undefined })
    expect(parseRepoInput('group/sub/lib', '')).toEqual({ org: 'group/sub', name: 'lib', provider: undefined })
    expect(parseRepoInput('https://github.com/acme/web.git', '')).toEqual({ org: 'acme', name: 'web', provider: 'github' })
    expect(parseRepoInput('git@gitlab.com:team/infra.git', '')).toEqual({ org: 'team', name: 'infra', provider: 'gitlab' })
    expect(parseRepoInput('https://github.com/acme/web/tree/main/src', '')).toMatchObject({ org: 'acme', name: 'web' })
    expect(parseRepoInput('https://git.example.org/acme/tool', '')).toEqual({ org: 'acme', name: 'tool', provider: undefined })
  })

  it('rejects empty or malformed input', () => {
    expect(parseRepoInput('  ', 'acme')).toBeNull()
    expect(parseRepoInput('acme/has space', 'acme')).toBeNull()
  })
})

describe('resource URLs (shape only)', () => {
  it('accepts empty, full and bare-host URLs', () => {
    expect(isValidResourceUrl('')).toBe(true)
    expect(isValidResourceUrl('https://drive.google.com/drive/folders/abc')).toBe(true)
    expect(isValidResourceUrl('docs.example.com/handbook')).toBe(true)
    expect(isValidResourceUrl('http://localhost:3000')).toBe(true)
    expect(isValidResourceUrl('mailto:team@example.com')).toBe(true)
  })

  it('rejects what is not a URL', () => {
    expect(isValidResourceUrl('not a url')).toBe(false)
    expect(isValidResourceUrl('https://')).toBe(false)
    expect(isValidResourceUrl('wiki')).toBe(false)
  })
})

describe('validateProjectDraft', () => {
  it('needs a name, labels, valid URLs and no duplicate repos', () => {
    expect(validateProjectDraft(draft({}))).toEqual([])
    expect(validateProjectDraft(draft({ name: ' ' }))).toHaveLength(1)
    expect(validateProjectDraft(draft({ repos: [repo('github', 'acme', 'api'), repo('github', 'ACME', 'API')] }))).toHaveLength(1)
    // The same name on another provider is a different repo.
    expect(validateProjectDraft(draft({ repos: [repo('github', 'acme', 'api'), repo('gitlab', 'acme', 'api')] }))).toEqual([])
    expect(validateProjectDraft(draft({ resources: [{ key: 'r', label: '', url: 'nope nope', notes: '' }] }))).toHaveLength(2)
  })
})

describe('saveProjectDraft — create', () => {
  it('creates a project with zero repos', async () => {
    const saved = await saveProjectDraft(null, draft({ description: '# Brief' }))
    expect(saved.id).toBe('new-project')
    expect(api().create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Relaunch', description: '# Brief' }))
    expect(api().repos.add).not.toHaveBeenCalled()
    expect(useProjectStore.getState().projects.map((p) => p.id)).toContain('new-project')
  })

  it('creates a project with one repo', async () => {
    await saveProjectDraft(null, draft({ repos: [repo('github', 'acme', 'api', { default_branch: 'develop' })] }))
    expect(api().repos.add).toHaveBeenCalledTimes(1)
    expect(api().repos.add).toHaveBeenCalledWith('new-project', { name: 'api', provider: 'github', org: 'acme', default_branch: 'develop' })
    expect(api().repos.reorder).not.toHaveBeenCalled()
  })

  it('creates a project with several repos across providers, in order', async () => {
    await saveProjectDraft(null, draft({
      git_provider: 'gitlab',
      git_org: 'team',
      repos: [repo('github', 'acme', 'web'), repo('gitlab', 'team', 'infra'), repo('forgejo', 'self', 'tool')],
      resources: [{ key: 'r1', label: 'Drive', url: 'drive.google.com/x', notes: 'Specs' }]
    }))
    expect(api().create).toHaveBeenCalledWith(expect.objectContaining({ git_provider: 'gitlab', git_org: 'team' }))
    expect(api().repos.add.mock.calls.map(([, d]) => `${d.provider}:${d.org}/${d.name}`))
      .toEqual(['github:acme/web', 'gitlab:team/infra', 'forgejo:self/tool'])
    expect(api().repos.reorder).toHaveBeenCalledWith('new-project', ['repo-1', 'repo-2', 'repo-3'])
    expect(api().resources.add).toHaveBeenCalledWith('new-project', { label: 'Drive', url: 'https://drive.google.com/x', notes: 'Specs' })
  })

  it('refuses an invalid draft without writing anything', async () => {
    await expect(saveProjectDraft(null, draft({ name: '' }))).rejects.toThrow()
    expect(api().create).not.toHaveBeenCalled()
  })
})

describe('saveProjectDraft — edit', () => {
  it('adds, updates, removes and reorders repos and resources', async () => {
    const project = projectRecord('p', 'P')
    const originalRepos: ProjectRepoRecord[] = [
      { id: 'a', project_id: 'p', provider: 'github', org: 'acme', name: 'a', default_branch: null, sort_order: 0, created_at: NOW },
      { id: 'b', project_id: 'p', provider: 'github', org: 'acme', name: 'b', default_branch: null, sort_order: 1, created_at: NOW },
      { id: 'c', project_id: 'p', provider: 'github', org: 'acme', name: 'c', default_branch: null, sort_order: 2, created_at: NOW }
    ]
    const originalResources: ProjectResourceRecord[] = [
      { id: 'x', project_id: 'p', label: 'Old', url: null, notes: '', sort_order: 0, created_at: NOW }
    ]
    const start = draftFromProject(project, originalRepos, originalResources)
    // Drop "b", move "c" first, set a branch on "a", add a GitLab repo, drop the resource.
    const [a, , c] = start.repos
    const edited: ProjectDraft = {
      ...start,
      name: 'P renamed',
      repos: [c, { ...a, default_branch: 'main' }, repo('gitlab', 'team', 'new')],
      resources: []
    }

    await saveProjectDraft('p', edited, { repos: originalRepos, resources: originalResources })

    expect(api().update).toHaveBeenCalledWith('p', expect.objectContaining({ name: 'P renamed' }))
    expect(api().repos.remove).toHaveBeenCalledWith('b')
    expect(api().repos.update).toHaveBeenCalledTimes(1)
    expect(api().repos.update).toHaveBeenCalledWith('a', expect.objectContaining({ default_branch: 'main' }))
    expect(api().repos.add).toHaveBeenCalledWith('p', expect.objectContaining({ provider: 'gitlab', name: 'new' }))
    expect(api().repos.reorder).toHaveBeenCalledWith('p', ['c', 'a', 'repo-1'])
    expect(api().resources.remove).toHaveBeenCalledWith('x')
  })
})

describe('moveItem', () => {
  it('moves within bounds and ignores moves off the ends', () => {
    expect(moveItem([1, 2, 3], 0, 1)).toEqual([2, 1, 3])
    expect(moveItem([1, 2, 3], 2, -1)).toEqual([1, 3, 2])
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3])
  })
})
