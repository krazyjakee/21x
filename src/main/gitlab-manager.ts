import { execFile } from 'child_process'
import { promisify } from 'util'
import type { GitHubRepo } from './github-manager'

const execFileAsync = promisify(execFile)

const GLAB_API_MAX_BUFFER = 10 * 1024 * 1024

export interface GlabCliStatus {
  installed: boolean
  authenticated: boolean
  username?: string
}

export class GitLabManager {

  /**
   * Maps a raw GitLab API project object to the shared GitHubRepo interface
   * so the UI can handle both providers uniformly.
   */
  private mapRepo(raw: Record<string, unknown>): GitHubRepo {
    const pathWithNamespace = raw.path_with_namespace as string
    const httpUrl = raw.http_url_to_repo as string
    return {
      name: raw.path as string,
      fullName: pathWithNamespace,
      defaultBranch: (raw.default_branch as string) || 'main',
      cloneUrl: httpUrl,
      description: (raw.description as string) || '',
      isPrivate: (raw.visibility as string) === 'private'
    }
  }

  /**
   * Fetches paginated results from a GitLab API endpoint.
   * Uses glab's built-in --paginate flag (supported since glab 1.x) which
   * automatically follows pagination headers and merges results.
   * Query params are embedded directly in the URL for clarity.
   */
  private async fetchPaginatedProjects(basePath: string, extraParams = ''): Promise<GitHubRepo[]> {
    const separator = basePath.includes('?') ? '&' : '?'
    const url = `${basePath}${separator}per_page=100&order_by=updated_at&sort=desc${extraParams ? '&' + extraParams : ''}`

    console.log(`[GitLabManager] Fetching: glab api ${url} --paginate`)
    const { stdout } = await execFileAsync('glab', [
      'api', url, '--paginate'
    ], { maxBuffer: GLAB_API_MAX_BUFFER, timeout: 60000 })

    const raw = JSON.parse(stdout) as Record<string, unknown>[]

    // Deduplicate by fullName
    const deduped = new Map<string, GitHubRepo>()
    for (const project of raw) {
      const mapped = this.mapRepo(project)
      deduped.set(mapped.fullName, mapped)
    }
    console.log(`[GitLabManager] Fetched ${deduped.size} projects from ${basePath}`)
    return Array.from(deduped.values())
  }

  /**
   * Fetches all projects accessible to the authenticated user via the GitLab REST API.
   * Uses glab to proxy the request so authentication tokens are handled automatically.
   */
  private async fetchAccessibleRepos(): Promise<GitHubRepo[]> {
    return this.fetchPaginatedProjects('/projects', 'membership=true')
  }

  async checkGlabCli(): Promise<GlabCliStatus> {
    try {
      await execFileAsync('glab', ['--version'])
    } catch {
      return { installed: false, authenticated: false }
    }

    try {
      const { stdout } = await execFileAsync('glab', ['auth', 'status'])
      // glab auth status outputs "Logged in to <hostname> as <username>"
      const match = stdout.match(/Logged in to .+ as (\S+)/) ||
                    stdout.match(/as (\S+)/)
      return { installed: true, authenticated: true, username: match?.[1] }
    } catch (error: unknown) {
      const execErr = error as { stderr?: string; stdout?: string }
      const output = (execErr?.stderr || '') + (execErr?.stdout || '')
      if (output.includes('Logged in')) {
        const match = output.match(/as (\S+)/)
        return { installed: true, authenticated: true, username: match?.[1] }
      }
      return { installed: true, authenticated: false }
    }
  }

  /**
   * Fetches all unique groups/namespaces the authenticated user has access to.
   * Mirrors GitHubManager.fetchUserOrgs() for UI compatibility.
   */
  async fetchUserOrgs(): Promise<string[]> {
    const [status, repos] = await Promise.all([
      this.checkGlabCli(),
      this.fetchAccessibleRepos()
    ])

    const owners = new Set<string>()
    for (const repo of repos) {
      // GitLab uses nested namespaces (e.g. "group/subgroup/project")
      // We extract the top-level namespace (first segment)
      const parts = repo.fullName.split('/')
      if (parts.length >= 2) {
        const owner = parts[0]
        if (owner && owner !== status.username) {
          owners.add(owner)
        }
      }
    }

    return Array.from(owners).sort((left, right) => left.localeCompare(right))
  }

  /**
   * Fetches repos for a specific organization/group.
   * Uses the GitLab Groups API directly for efficiency instead of fetching
   * all accessible projects. Falls back to the general /projects endpoint
   * with prefix filtering if the group lookup fails (e.g. personal namespace).
   */
  async fetchOrgRepos(org: string): Promise<GitHubRepo[]> {
    try {
      // Use the Groups API — more targeted and reliable than fetching all projects
      const encodedGroup = encodeURIComponent(org)
      const repos = await this.fetchPaginatedProjects(
        `/groups/${encodedGroup}/projects`,
        'include_subgroups=true'
      )
      console.log(`[GitLabManager] fetchOrgRepos via Groups API: ${repos.length} repos for "${org}"`)
      return repos
    } catch (error) {
      // Group lookup can fail for personal namespaces — fall back to general search
      console.log(`[GitLabManager] Groups API failed for "${org}", falling back to /projects:`, (error as Error).message)
      const repos = await this.fetchAccessibleRepos()
      return repos.filter((repo) => repo.fullName.startsWith(`${org}/`))
    }
  }

  /**
   * Fetches repos owned by the authenticated user.
   */
  async fetchUserRepos(): Promise<GitHubRepo[]> {
    const status = await this.checkGlabCli()
    if (!status.username) return []

    const repos = await this.fetchAccessibleRepos()
    return repos.filter((repo) => repo.fullName.startsWith(`${status.username}/`))
  }
}
