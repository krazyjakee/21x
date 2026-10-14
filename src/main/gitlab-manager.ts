import { execFile, type ExecFileOptions } from 'child_process'
import { GitProviderProcessOwner, GitProviderProcessError, type GitProviderManagerHost } from './git-provider-process-owner'
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

  constructor(private readonly host?: GitProviderManagerHost) {
    if (!host) return
    if (!(host.process instanceof GitProviderProcessOwner)) throw new GitProviderProcessError('GIT_PROVIDER_INVALID_OPTIONS')
    for (const name of ['checkGlabCli','fetchUserOrgs','fetchOrgRepos','fetchUserRepos'] as const) {
      const original = this[name].bind(this) as (...args: unknown[]) => Promise<unknown>
      ;(this as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name] = (...args) => {
        try { this.current(); return host.process.retain(original(...args).then(value => { this.current(); return value }).catch(cause => { this.current(); if (cause instanceof GitProviderProcessError) throw cause; throw new GitProviderProcessError('GIT_PROVIDER_INVALID_RESULT') })) }
        catch (cause) { return Promise.reject(cause) }
      }
    }
  }
  assertOwners(owner: GitProviderProcessOwner): void { if (!this.host || this.host.process !== owner) throw new GitProviderProcessError('GIT_PROVIDER_INVALID_OPTIONS'); owner.assertOpen() }
  withRequestGuard<T>(effect: () => T | Promise<T>, guard: () => void, signal?: AbortSignal): Promise<T> {
    if (!this.host) return Promise.reject(new GitProviderProcessError('GIT_PROVIDER_INVALID_OPTIONS'))
    return this.host.process.withRequestGuard(effect, guard, signal)
  }
  private current(): void { this.host?.process.assertCurrent(); this.host?.assertCurrent?.() }
  private async exec(command: 'glab', args: string[], options?: ExecFileOptions): Promise<{ stdout: string; stderr: string }> {
    if (!this.host) {
      const result = options ? await execFileAsync(command, args, options) : await execFileAsync(command, args)
      return { stdout: String(result.stdout), stderr: String(result.stderr) }
    }
    this.current()
    const result = await this.host.process.exec(command, args, { maxBuffer: options?.maxBuffer ?? 65536, timeout: options?.timeout, allowNonzero: args[0] === 'auth' && args[1] === 'status' })
    this.current(); return result
  }

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

    let raw: Record<string, unknown>[]
    if (this.host) {
      raw = []; let bytes = 0; let complete = false
      for (let page = 1; page <= 40; page++) {
        const { stdout } = await this.exec('glab', ['api', `${url}&page=${page}`], { maxBuffer: GLAB_API_MAX_BUFFER, timeout: 60000 })
        bytes += Buffer.byteLength(stdout, 'utf8')
        const batch = JSON.parse(stdout) as Record<string, unknown>[]
        if (!Array.isArray(batch) || batch.length > 100 || raw.length + batch.length > 4096 || bytes > GLAB_API_MAX_BUFFER) throw new GitProviderProcessError('GIT_PROVIDER_INVALID_RESULT')
        raw.push(...batch)
        if (batch.length < 100) { complete = true; break }
      }
      if (!complete) throw new GitProviderProcessError('GIT_PROVIDER_INVALID_RESULT')
    } else {
      console.log(`[GitLabManager] Fetching: glab api ${url} --paginate`)
      const { stdout } = await this.exec('glab', ['api', url, '--paginate'], { maxBuffer: GLAB_API_MAX_BUFFER, timeout: 60000 })
      raw = JSON.parse(stdout) as Record<string, unknown>[]
    }

    // Deduplicate by fullName
    const deduped = new Map<string, GitHubRepo>()
    for (const project of raw) {
      const mapped = this.mapRepo(project)
      deduped.set(mapped.fullName, mapped)
    }
    if (!this.host) console.log(`[GitLabManager] Fetched ${deduped.size} projects from ${basePath}`)
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
      await this.exec('glab', ['--version'])
    } catch (cause) {
      this.current()
      if (this.host && (!(cause instanceof GitProviderProcessError) || cause.code !== 'GIT_PROVIDER_CLI_MISSING')) throw cause
      return { installed: false, authenticated: false }
    }

    try {
      const { stdout, stderr } = await this.exec('glab', ['auth', 'status'])
      const output = this.host ? `${stdout}\n${stderr}` : stdout
      if (this.host && !output.includes('Logged in')) return { installed: true, authenticated: false }
      // glab auth status outputs "Logged in to <hostname> as <username>"
      const match = output.match(/Logged in to .+ as (\S+)/) ||
                    output.match(/as (\S+)/)
      return { installed: true, authenticated: true, username: match?.[1] }
    } catch (error: unknown) {
      this.current()
      if (this.host) throw error
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
      if (!this.host) console.log(`[GitLabManager] fetchOrgRepos via Groups API: ${repos.length} repos for "${org}"`)
      return repos
    } catch (error) {
      this.current()
      if (this.host && (!(error instanceof GitProviderProcessError) || error.code !== 'GIT_PROVIDER_COMMAND_FAILED')) throw error
      // Group lookup can fail for personal namespaces — fall back to general search
      if (!this.host) console.log(`[GitLabManager] Groups API failed for "${org}", falling back to /projects:`, (error as Error).message)
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
