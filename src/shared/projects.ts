/**
 * Projects group tasks, task sources and (later) the canvas, drawings and a
 * Captain. A project may have zero, one or many git repos; everything else
 * it points at (a Google Drive, docs, a dashboard) is a resource — a link and
 * notes given to agents as context, with no integration.
 */

/**
 * The project every install has. Schema migration 15 creates it and moves all
 * existing tasks and task sources into it; a task created without a project
 * lands here. It is never archived.
 */
export const DEFAULT_PROJECT_ID = 'default'
export const DEFAULT_PROJECT_NAME = 'Default'

export interface ProjectChangedEvent {
  projectId: string
  kind: 'created' | 'updated' | 'archived' | 'restored' | 'repos' | 'resources'
}

export interface ProjectRecord {
  id: string
  name: string
  /** The brief the project's Captain reads as context. */
  description: string
  default_agent_id: string | null
  captain_agent_id: string | null
  /** null = use the global `git_provider` setting. */
  git_provider: string | null
  /** null = use the global `github_org` setting. */
  git_org: string | null
  settings: Record<string, unknown>
  sort_order: number
  archived: boolean
  created_at: string
  updated_at: string
}

export interface CreateProjectData {
  name: string
  description?: string
  default_agent_id?: string | null
  captain_agent_id?: string | null
  git_provider?: string | null
  git_org?: string | null
  settings?: Record<string, unknown>
}

export interface UpdateProjectData {
  name?: string
  description?: string
  default_agent_id?: string | null
  captain_agent_id?: string | null
  git_provider?: string | null
  git_org?: string | null
  settings?: Record<string, unknown>
}

export interface ProjectRepoRecord {
  id: string
  project_id: string
  provider: string
  /** Owner / group; '' when the repo was attached as a bare name and no org was configured. */
  org: string
  name: string
  /** null = the remote's default branch. */
  default_branch: string | null
  sort_order: number
  created_at: string
}

export interface CreateProjectRepoData {
  name: string
  provider?: string
  org?: string
  default_branch?: string | null
}

export interface UpdateProjectRepoData {
  name?: string
  provider?: string
  org?: string
  default_branch?: string | null
}

/** A non-repo thing the project uses. Context only: 20x never calls it. */
export interface ProjectResourceRecord {
  id: string
  project_id: string
  label: string
  url: string | null
  notes: string
  sort_order: number
  created_at: string
}

export interface CreateProjectResourceData {
  label: string
  url?: string | null
  notes?: string
}

export interface UpdateProjectResourceData {
  label?: string
  url?: string | null
  notes?: string
}
