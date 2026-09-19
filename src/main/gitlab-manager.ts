import { execFile } from 'child_process'
import { promisify } from 'util'
import type { GitHubRepo } from './github-manager'
import { otherOwners, repoOwner, uniqueRepos } from './repo-providers'

const execFileAsync = promisify(execFile)

const GLAB_API_MAX_BUFFER = 10 * 1024 * 1024

export interface GlabCliStatus {
  installed: boolean
  authenticated: boolean
  username?: string
}

/** Maps a GitLab project onto the shared GitHubRepo shape so the UI handles every provider alike. */
function mapGitLabProject(raw: Record<string, unknown>): GitHubRepo {
  return {
    name: raw.path as string,
    fullName: raw.path_with_namespace as string,
    defaultBranch: (raw.default_branch as string) || 'main',
    cloneUrl: raw.http_url_to_repo as string,
    description: (raw.description as string) || '',
    isPrivate: (raw.visibility as string) === 'private'
  }
}

export class GitLabManager {

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

    const repos = uniqueRepos(JSON.parse(stdout) as Record<string, unknown>[], mapGitLabProject)
    console.log(`[GitLabManager] Fetched ${repos.length} projects from ${basePath}`)
    return repos
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
    // Nested namespaces ("group/subgroup/project") are listed by their top-level group.
    return otherOwners(repos.map(repoOwner), status.username)
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
