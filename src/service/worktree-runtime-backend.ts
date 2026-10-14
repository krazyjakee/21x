import { AgentManager } from '../main/agent-manager-core'
import { SyncManager } from '../main/sync-manager'
import { WorktreeManager, WORKTREE_PORTABLE_LIMITS, type WorktreeRepo } from '../main/worktree-manager-core'
import { WorkspaceCleanupSchedulerCore, createBoundedWorkspaceCleanupStore, type WorkspaceCleanupRequestControls } from '../main/workspace-cleanup-scheduler-core'
import { WorkspaceFileOwner, WorkspaceFileError } from '../main/workspace-file-owner'
import { GitProviderProcessOwner, GitProviderProcessError } from '../main/git-provider-process-owner'
import { GitHubManager } from '../main/github-manager'
import { GitLabManager } from '../main/gitlab-manager'
import { ForgejoManager } from '../main/forgejo-manager'
import type { DatabaseManager } from '../main/database/manager'
import { resolveTaskRepos, type ResolvedRepo } from '../main/agent-manager/project-repos'
import { isGitProvider, recordRepoProviders, REPO_PROVIDERS_SETTING, FORGEJO_LOGIN_SETTING } from '../main/repo-providers'
import { TaskWorkspaceScopeReader } from './task-workspace-scope'
import { isDatabaseId } from '../shared/database-desktop-codecs'
import { GIT_PROVIDER_CODECS, gitProviderAddress, gitProviderRepository, type GitProviderCodec, type GitProviderOperation } from '../shared/git-provider-codecs'
import { WORKTREE_RUNTIME_CODECS, WORKTREE_RUNTIME_OPERATIONS, WORKTREE_RUNTIME_LIMITS, WORKSPACE_RUNTIME_ERROR, type WorktreeRuntimeCodec, type WorktreeRuntimeOperation } from '../shared/worktree-runtime-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { isRecord, isJsonValue, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

export interface WorktreeRuntimeOwners {
  database: DatabaseManager; manager: AgentManager; sync: SyncManager; worktrees: WorktreeManager; processOwner: GitProviderProcessOwner; github: GitHubManager; gitlab: GitLabManager; forgejo: ForgejoManager; cleanup: WorkspaceCleanupSchedulerCore; files: WorkspaceFileOwner; workspaceRoot: string; reposRoot: string
}
export interface WorktreeRuntimeBackendOptions extends WorktreeRuntimeOwners {
  engineEpoch: string
  assertAvailable(): void
  assertWorktreeRuntimeOwners(owners: WorktreeRuntimeOwners): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canManageGlobalConfiguration(caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canAccessTask(id: string, caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canAccessProject(id: string, caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canAccessAgent(id: string, caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canAccessSource(id: string, caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canAccessRepository(projectId: string, fullName: string, caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  beforeWorkspaceMutation(taskIds: readonly string[]): void
  runWorktreeMutation?<T>(taskIds: string[], sourceIds: string[], effect: () => Promise<T>): Promise<T>
}
const mutation = (op: WorktreeRuntimeOperation): boolean => op === 'worktree:setup' || op === 'worktree:cleanup' || op === 'workspace:runCleanupNow'
type Row = Record<string, unknown>

/** Existing worktree algorithms with captured SQL/CLI/filesystem/lifecycle
 * owners. No renderer roots, transport callbacks or provider overrides. */
export class WorktreeRuntimeBackend {
  readonly registry: DesktopOperationRegistry
  private readonly owners: WorktreeRuntimeOwners
  private readonly flights = new Set<Promise<unknown>>()
  private readonly controllers = new Set<AbortController>()
  private closing = false
  private mutationBusy = false
  constructor(private readonly options: WorktreeRuntimeBackendOptions) {
    this.owners = Object.freeze({ database: options.database, manager: options.manager, sync: options.sync, worktrees: options.worktrees, processOwner: options.processOwner, github: options.github, gitlab: options.gitlab, forgejo: options.forgejo, cleanup: options.cleanup, files: options.files, workspaceRoot: options.workspaceRoot, reposRoot: options.reposRoot })
    if (!(options.manager instanceof AgentManager) || !(options.sync instanceof SyncManager) || !(options.worktrees instanceof WorktreeManager) || !(options.processOwner instanceof GitProviderProcessOwner) || !(options.github instanceof GitHubManager) || !(options.gitlab instanceof GitLabManager) || !(options.forgejo instanceof ForgejoManager) || !(options.cleanup instanceof WorkspaceCleanupSchedulerCore) || !(options.files instanceof WorkspaceFileOwner)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.available()
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    for (const operation of WORKTREE_RUNTIME_OPERATIONS) this.bind(operation)
  }
  get inflightCount(): number { return this.flights.size }
  shutdown(): void { this.closing = true; for (const controller of this.controllers) controller.abort() }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid worktree shutdown deadline')
    this.shutdown(); let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.allSettled([...this.flights]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(WORKTREE_RUNTIME_OPERATIONS.map(operation => [operation, { validatePayload: (v: unknown) => { try { return isJsonValue(v) && WORKTREE_RUNTIME_CODECS[operation].validateArguments(WORKTREE_RUNTIME_CODECS[operation].decodeArguments(v)) } catch { return false } }, validateResult: WORKTREE_RUNTIME_CODECS[operation].validateWireResult, handle: (v: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, v, caller, signal) }]))
  }
  private available(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing || !this.owners.database.db.open) throw new ServiceProtocolError('DISCONNECTED')
    try {
      this.options.assertAvailable(); this.options.assertWorktreeRuntimeOwners(this.owners)
      this.owners.processOwner.assertOpen(); this.owners.github.assertOwners(this.owners.processOwner); this.owners.gitlab.assertOwners(this.owners.processOwner); this.owners.forgejo.assertOwners(this.owners.processOwner)
      this.owners.files.assertOwners(this.owners.workspaceRoot); this.owners.worktrees.assertOwners(this.owners.reposRoot, this.owners.workspaceRoot, this.owners.forgejo); this.owners.cleanup.assertOwners(this.owners.database, this.owners.worktrees, this.owners.workspaceRoot)
    } catch (error) { if (error instanceof ServiceProtocolError) throw error; throw new ServiceProtocolError('DISCONNECTED') }
  }
  private authorize(caller: DesktopCallerContext, signal?: AbortSignal): void {
    this.available(signal)
    if (caller.principal !== 'trusted-desktop-main' || caller.engineEpoch !== this.options.engineEpoch || !caller.webviewId || !caller.origin || !this.options.isTrustedDesktop(caller)) throw new ServiceProtocolError('INVALID_REQUEST')
  }
  private async execute<K extends WorktreeRuntimeOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext, signal: AbortSignal): Promise<DesktopCommandMap[K]['result']> {
    const { database, manager, sync, worktrees, processOwner, github, gitlab, forgejo, cleanup, files } = this.owners, db = database.db
    const access = mutation(operation) ? 'write' : 'read'
    const usedTasks = new Set<string>(), usedProjects = new Set<string>(), usedAgents = new Set<string>(), usedSources = new Set<string>(), usedRepos = new Map<string, { projectId: string; name: string }>()
    const receipts = new Map<string, { read: () => unknown; value: string }>()
    let receiptBytes = 0
    const retainReceipt = (key: string, read: () => unknown, value: string): void => {
      const bytes = Buffer.byteLength(key) + Buffer.byteLength(value)
      if (receiptBytes + bytes >= WORKTREE_RUNTIME_LIMITS.resultBytes) throw new ServiceProtocolError('FRAME_TOO_LARGE')
      receipts.set(key, { read, value }); receiptBytes += bytes
    }
    const forgetReceipt = (key: string): void => {
      const receipt = receipts.get(key); if (receipt) { receiptBytes -= Buffer.byteLength(key) + Buffer.byteLength(receipt.value); receipts.delete(key) }
    }
    const current = (): void => { this.authorize(caller, signal) }
    const grant = (kind: 'task' | 'project' | 'agent' | 'source', id: unknown): string => {
      current(); if (!isDatabaseId(id)) throw new ServiceProtocolError('INVALID_REQUEST')
      const allowed = kind === 'task' ? this.options.canAccessTask : kind === 'project' ? this.options.canAccessProject : kind === 'agent' ? this.options.canAccessAgent : this.options.canAccessSource
      if (!allowed.call(this.options, id, caller, 'read') || access === 'write' && !allowed.call(this.options, id, caller, 'write')) throw new ServiceProtocolError('INVALID_REQUEST')
      const set = kind === 'task' ? usedTasks : kind === 'project' ? usedProjects : kind === 'agent' ? usedAgents : usedSources
      if (!set.has(id) && set.size >= (kind === 'task' ? 4096 : 128)) throw new ServiceProtocolError('FRAME_TOO_LARGE'); set.add(id); return id
    }
    const rows = (sql: string, params: unknown[], bounds: Record<string, number>, count = 128): Row[] => {
      const read = (): Row[] => {
        current(); const fields = Object.entries(bounds).map(([field, max]) => ({ bytes: `COALESCE(length(CAST(${field} AS BLOB)),0)`, max }))
        const stats = db.prepare(`SELECT COUNT(*) AS count,COALESCE(MAX(${fields.map(field => `(${field.bytes}>${field.max})`).join(' OR ')}),0) AS oversized,COALESCE(SUM(${fields.map(field => field.bytes).join('+')}),0) AS total FROM (${sql})`).get(...params) as { count: number; oversized: number; total: number }
        if (stats.count > count || stats.oversized || stats.total >= WORKTREE_RUNTIME_LIMITS.resultBytes) throw new ServiceProtocolError('FRAME_TOO_LARGE')
        return db.prepare(sql).all(...params) as Row[]
      }
      const value = read(), key = JSON.stringify([sql, params]), encoded = JSON.stringify(value), previous = receipts.get(key)
      if (previous && previous.value !== encoded) throw new ServiceProtocolError('INVALID_REQUEST')
      if (!previous) retainReceipt(key, read, encoded)
      return value
    }
    const setting = (key: string): string | undefined => {
      const row = rows('SELECT value FROM settings WHERE key=?', [key], { value: key === REPO_PROVIDERS_SETTING ? 524288 : 4096 }, 1)[0]
      if (row && typeof row.value !== 'string') throw new ServiceProtocolError('INVALID_REQUEST')
      return row?.value as string | undefined
    }
    const projectStore = {
      getProject: (id: string): ReturnType<DatabaseManager['getProject']> => { grant('project', id); const row = rows('SELECT id,git_provider,git_org,default_agent_id,captain_agent_id FROM projects WHERE id=?', [id], { id: 128, git_provider: 32, git_org: 512, default_agent_id: 128, captain_agent_id: 128 }, 1)[0]; if (!row) throw new ServiceProtocolError('INVALID_REQUEST'); for (const key of ['default_agent_id', 'captain_agent_id']) if (row[key] !== null) grant('agent', row[key]); return row as unknown as ReturnType<DatabaseManager['getProject']> },
      getProjectRepos: (id: string): ReturnType<DatabaseManager['getProjectRepos']> => { grant('project', id); return rows('SELECT id,project_id,provider,org,name,default_branch,sort_order,created_at FROM project_repos WHERE project_id=? ORDER BY sort_order,created_at', [id], { id: 128, project_id: 128, provider: 32, org: 512, name: 128, default_branch: 1024, sort_order: 32, created_at: 64 }) as unknown as ReturnType<DatabaseManager['getProjectRepos']> }, getSetting: setting
    }
    const scopeReader = new TaskWorkspaceScopeReader({ database, assertAvailable: current, canAccessTask: (id, _caller, mode) => { grant('task', id); return this.options.canAccessTask(id, caller, mode) }, canAccessProject: (id, _caller, mode) => { grant('project', id); return this.options.canAccessProject(id, caller, mode) } })
    const scoped = (id: string): { repos: ResolvedRepo[]; tasks: string[]; sources: string[] } => {
      const scope = scopeReader.capture(id, caller), key = `workspace-scope:${id}`, value = JSON.stringify(scope), before = receipts.get(key)
      if (before && before.value !== value) throw new ServiceProtocolError('INVALID_REQUEST')
      if (!before) retainReceipt(key, () => scopeReader.capture(id, caller), value)
      for (const task of scope.tasks) {
        if (task.agent_id) grant('agent', task.agent_id)
        const binding = rows('SELECT source_id,status FROM tasks WHERE id=?', [task.id], { source_id: 128, status: 64 }, 1)[0]!
        if (binding.source_id !== null) {
          const sourceId = grant('source', binding.source_id), source = rows('SELECT id,project_id,plugin_id,config,mcp_server_id,list_tool,list_tool_args,update_tool,update_tool_args,enabled FROM task_sources WHERE id=?', [sourceId], { id: 128, project_id: 128, plugin_id: 128, config: 65536, mcp_server_id: 128, list_tool: 512, list_tool_args: 65536, update_tool: 512, update_tool_args: 65536, enabled: 32 }, 1)[0]
          if (!source) throw new ServiceProtocolError('INVALID_REQUEST'); grant('project', source.project_id)
        }
      }
      const map = setting(REPO_PROVIDERS_SETTING)
      if (map) { let parsed: unknown; try { parsed = JSON.parse(map) } catch { throw new ServiceProtocolError('INVALID_REQUEST') }; if (!isRecord(parsed) || Object.keys(parsed).length > 4096 || Object.entries(parsed).some(([name, provider]) => !gitProviderRepository(name) || !isGitProvider(provider))) throw new ServiceProtocolError('INVALID_REQUEST') }
      setting(FORGEJO_LOGIN_SETTING)
      const resolved = resolveTaskRepos(projectStore, { project_id: scope.task.project_id, repos: JSON.parse(scope.task.repos) as string[] })
      if (resolved.length > 128 || new Set(resolved.map(repo => repo.fullName)).size !== resolved.length || new Set(resolved.map(repo => repo.name)).size !== resolved.length) throw new ServiceProtocolError('INVALID_REQUEST')
      for (const repo of resolved) {
        if (!gitProviderRepository(repo.fullName) || !this.options.canAccessRepository(scope.task.project_id, repo.fullName, caller, 'read') || access === 'write' && !this.options.canAccessRepository(scope.task.project_id, repo.fullName, caller, 'write')) throw new ServiceProtocolError('INVALID_REQUEST')
        usedRepos.set(`${scope.task.project_id}:${repo.fullName}`, { projectId: scope.task.project_id, name: repo.fullName })
      }
      return { repos: resolved, tasks: scope.tasks.map(task => task.id), sources: [...usedSources] }
    }
    const global = (): void => { current(); if (!this.options.canManageGlobalConfiguration(caller, 'read') || !this.options.canManageGlobalConfiguration(caller, 'write')) throw new ServiceProtocolError('INVALID_REQUEST'); for (const row of rows('SELECT id FROM projects ORDER BY id', [], { id: 128 })) grant('project', row.id) }
    const recheck = (): void => {
      current()
      for (const id of usedTasks) grant('task', id); for (const id of usedProjects) grant('project', id); for (const id of usedAgents) grant('agent', id); for (const id of usedSources) grant('source', id)
      for (const repo of usedRepos.values()) if (!this.options.canAccessRepository(repo.projectId, repo.name, caller, 'read') || access === 'write' && !this.options.canAccessRepository(repo.projectId, repo.name, caller, 'write')) throw new ServiceProtocolError('INVALID_REQUEST')
      for (const receipt of receipts.values()) if (JSON.stringify(receipt.read()) !== receipt.value) throw new ServiceProtocolError('INVALID_REQUEST')
      if (mutation(operation)) this.options.beforeWorkspaceMutation([...usedTasks])
      if (operation === 'workspace:runCleanupNow') global()
    }
    const assertIdle = (ids: string[]): void => {
      for (const id of ids) {
        const bound = rows('SELECT id,role,group_id,status FROM tasks WHERE id=?', [id], { id: 128, role: 32, group_id: 128, status: 64 }, 1)[0]
        if (!bound || ['agent_working','agent_learning','triaging'].includes(bound.status as string) || manager.findSessionByTaskId(id, { getTask: () => bound as unknown as ReturnType<DatabaseManager['getTask']> })) throw new ServiceProtocolError('BACKPRESSURE')
        if (rows("SELECT id FROM agent_start_queue WHERE task_id=? AND state IN ('queued','retrying','claimed','starting')", [id], { id: 128 }, 1).length) throw new ServiceProtocolError('BACKPRESSURE')
      }
    }
    const lease = <T>(ids: string[], sourceIds: string[], effect: () => Promise<T>): Promise<T> => {
      recheck(); assertIdle(ids)
      // The existing lifecycle lease calls getTask before invoking us. Bound
      // its complete stored row before that legacy getter copies any text/JSON.
      const columns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
      const lengths = columns.map(column => `COALESCE(length(CAST("${column.name.replaceAll('"', '""')}" AS BLOB)),0)`).join('+')
      for (const id of ids) {
        const stored = db.prepare(`SELECT ${lengths} AS bytes FROM tasks WHERE id=?`).get(id) as { bytes: number } | undefined
        if (!stored || !Number.isSafeInteger(stored.bytes) || stored.bytes < 0 || stored.bytes > 128000) throw new ServiceProtocolError('FRAME_TOO_LARGE')
      }
      for (const id of ids) rows('SELECT labels,checklist,attachments,repos,output_fields,next_subtask_ids,recurrence_pattern FROM tasks WHERE id=?', [id], { labels: 65536, checklist: 65536, attachments: 65536, repos: 65536, output_fields: 65536, next_subtask_ids: 65536, recurrence_pattern: 65536 }, 1)
      const joined = (): Promise<T> => { recheck(); assertIdle(ids); return effect() }
      if (this.options.runWorktreeMutation) return this.options.runWorktreeMutation(ids, sourceIds, joined)
      const sources = (index: number): Promise<T> => index === sourceIds.length ? manager.runTaskLifecycleMutation(ids, joined) : sync.runSourceMutation(sourceIds[index]!, () => sources(index + 1))
      return sources(0)
    }
    try {
      current(); let result: unknown
      return await processOwner.withRequestGuard(async () => worktrees.withRequestGuard(async () => {
        if (operation === 'workspace:runCleanupNow') {
          global()
          const store = createBoundedWorkspaceCleanupStore(database, current), allTasks = store.getTasks({ includeCoordinators: true })
          for (const task of allTasks) scoped(task.id)
          const controls: WorkspaceCleanupRequestControls = { beforeEffect: recheck, signal, store: { getSetting: store.getSetting, getTasks: opts => { recheck(); return store.getTasks(opts) } }, getRepoGroups: id => {
            const groups = new Map<string, { org: string; repos: { fullName: string }[] }>(); for (const repo of scoped(id).repos) { const group = groups.get(repo.org) ?? { org: repo.org, repos: [] }; group.repos.push({ fullName: repo.fullName }); groups.set(repo.org, group) }; return [...groups.values()]
          }, runMutation: (ids, effect) => lease(ids, [...usedSources], effect) }
          const actual = await cleanup.runNow(controls); recheck(); result = { ...actual, errors: actual.errors.map(error => error === 'Cleanup is already in progress' ? error : WORKSPACE_RUNTIME_ERROR) }
        } else {
          const id = args[0] as string, binding = scoped(id), supplied = operation === 'worktree:readFile' ? (args[1] === null ? [] : [{ fullName: args[1] as string }]) : args[1] as { fullName: string; defaultBranch?: string }[]
          for (const repo of supplied) if (!binding.repos.some(bound => bound.fullName === repo.fullName)) throw new ServiceProtocolError('INVALID_REQUEST')
          if (operation === 'worktree:setup' || operation === 'worktree:cleanup') {
            const org = args[2] as string
            if (supplied.some(repo => binding.repos.find(bound => bound.fullName === repo.fullName)!.org !== org)) throw new ServiceProtocolError('INVALID_REQUEST')
          }
          if (operation === 'worktree:setup') {
            const requested = args[3], providers = new Set(supplied.map(repo => binding.repos.find(bound => bound.fullName === repo.fullName)!.provider))
            if (providers.size > 1 || requested !== undefined && [...providers].some(provider => provider !== requested)) throw new ServiceProtocolError('INVALID_REQUEST')
            const provider = [...providers][0] ?? (isGitProvider(requested) ? requested : 'github'), org = args[2] as string
            const metadata: WorktreeRepo[] = []
            if (supplied.length) {
              const owner = provider === 'gitlab' ? gitlab : provider === 'forgejo' ? forgejo : github, codecName = `${provider}:fetchOrgRepos` as GitProviderOperation
              let available: Array<{ fullName: string; defaultBranch: string; cloneUrl?: string }> = []
              try { const codec = GIT_PROVIDER_CODECS[codecName] as GitProviderCodec<typeof codecName>, encoded = codec.encodeResult(await owner.fetchOrgRepos(org)); available = codec.decodeResult(encoded.defined ? encoded.value : undefined) as typeof available }
              catch (error) { recheck(); if (!(error instanceof GitProviderProcessError) || !['GIT_PROVIDER_COMMAND_FAILED','GIT_PROVIDER_CLI_MISSING','GIT_PROVIDER_TIMEOUT'].includes(error.code)) throw error }
              recheck()
              for (const repo of supplied) {
                const bound = binding.repos.find(value => value.fullName === repo.fullName)!, observed = available.find(value => value.fullName === repo.fullName), branch = bound.defaultBranch || observed?.defaultBranch || 'main'
                if (repo.defaultBranch !== branch) throw new ServiceProtocolError('INVALID_REQUEST')
                metadata.push({ fullName: repo.fullName, defaultBranch: branch, ...(observed?.cloneUrl ? { cloneUrl: observed.cloneUrl } : {}) })
              }
            }
            let mutationTasks = binding.tasks, mutationSources = binding.sources
            if (requested !== undefined && supplied.length) {
              global()
              // The setting is shared by automatic setup too. Scope and fence
              // all current users before entering any source/task lease.
              const all = createBoundedWorkspaceCleanupStore(database, current).getTasks({ includeCoordinators: true })
              for (const task of all) scoped(task.id)
              mutationTasks = [...usedTasks]; mutationSources = [...usedSources]
              if (mutationTasks.length > 128) throw new ServiceProtocolError('FRAME_TOO_LARGE')
            }
            result = await lease(mutationTasks, mutationSources, async () => {
              recheck()
              if (requested !== undefined && supplied.length) {
                global()
                recheck(); recordRepoProviders(database, supplied.map(repo => repo.fullName), provider); forgetReceipt(JSON.stringify(['SELECT value FROM settings WHERE key=?', [REPO_PROVIDERS_SETTING]]))
              }
              recheck(); return worktrees.setupWorkspaceForTask(id, metadata, args[2] as string, provider, recheck)
            })
          } else if (operation === 'worktree:cleanup') result = await lease(binding.tasks, binding.sources, () => worktrees.cleanupTaskWorkspace(id, supplied, args[2] as string, args[3] === undefined ? true : args[3] as boolean))
          else if (operation === 'worktree:readFile') result = await worktrees.readTaskFileOwned(id, args[1] as string | null, args[2] as string, path => files.readFilePreview(id, path, WORKTREE_RUNTIME_LIMITS.previewBytes, { beforeEffect: recheck, signal }))
          else if (operation === 'worktree:files') result = await worktrees.getTaskFiles(id, supplied)
          else result = await worktrees.getTaskChanges(id, supplied)
        }
        recheck(); const codec = WORKTREE_RUNTIME_CODECS[operation] as WorktreeRuntimeCodec<K>, encoded = codec.encodeResult(result); return codec.decodeResult(encoded.defined ? encoded.value : undefined)
      }, recheck, signal, { limits: WORKTREE_PORTABLE_LIMITS, beforeRemoteRequest: async (repo, address) => {
        recheck(); if (!gitProviderAddress(address)) throw new ServiceProtocolError('INVALID_REQUEST')
        const id = args[0] as string, bound = scoped(id).repos.find(value => value.fullName === repo)
        if (!bound) throw new ServiceProtocolError('INVALID_REQUEST')
        if (bound.provider === 'github') { if (address !== `https://github.com/${repo}.git`) throw new ServiceProtocolError('INVALID_REQUEST') }
        else { const owner = bound.provider === 'gitlab' ? gitlab : forgejo, name = `${bound.provider}:fetchOrgRepos` as GitProviderOperation, codec = GIT_PROVIDER_CODECS[name] as GitProviderCodec<typeof name>, encoded = codec.encodeResult(await owner.fetchOrgRepos(bound.org)), values = codec.decodeResult(encoded.defined ? encoded.value : undefined) as Array<{ fullName: string; cloneUrl: string }>; recheck(); if (values.filter(value => value.fullName === repo && value.cloneUrl === address).length !== 1) throw new ServiceProtocolError('INVALID_REQUEST') }
      } }), recheck, signal)
    } catch (error) {
      current(); if (error instanceof ServiceProtocolError) throw error
      if (error instanceof GitProviderProcessError) {
        const codes = { GIT_PROVIDER_CANCELLED: 'CANCELLED', GIT_PROVIDER_CLOSED: 'DISCONNECTED', GIT_PROVIDER_BUSY: 'BACKPRESSURE', GIT_PROVIDER_TIMEOUT: 'TIMEOUT', GIT_PROVIDER_OUTPUT_LIMIT: 'FRAME_TOO_LARGE', GIT_PROVIDER_INVALID_RESULT: 'INVALID_RESULT' } as const
        if (Object.hasOwn(codes, error.code)) throw new ServiceProtocolError(codes[error.code as keyof typeof codes])
      }
      if (error instanceof WorkspaceFileError && ['WORKSPACE_PATH_REFUSED','WORKSPACE_PATH_CHANGED'].includes(error.code)) throw new ServiceProtocolError('INVALID_REQUEST')
      if (error instanceof Error) {
        if (/^WORKSPACE_CLEANUP_.*UNAVAILABLE$/.test(error.message) || error.message === 'WORKTREE_REMOTE_SCOPE_UNAVAILABLE') throw new ServiceProtocolError('UNKNOWN_OPERATION')
        if (/^WORKTREE_(?:OUTPUT|FILES|SCAN|DEPTH)_LIMIT$/.test(error.message) || error.message === 'WORKSPACE_CLEANUP_DATA_LIMIT' || error.message === 'WORKSPACE_CLEANUP_SCAN_LIMIT') throw new ServiceProtocolError('FRAME_TOO_LARGE')
        if (/^WORKSPACE_CLEANUP_(?:ORPHAN|SCOPE|PATH|DATA|REPOSITORY)/.test(error.message) || /^WORKTREE_(?:PATH|REF|CLONE|DIRECTORY)/.test(error.message)) throw new ServiceProtocolError('INVALID_REQUEST')
      }
      throw new ServiceProtocolError('INTERNAL_ERROR')
    }
  }
  private bind<K extends WorktreeRuntimeOperation>(operation: K): void {
    const codec = WORKTREE_RUNTIME_CODECS[operation] as WorktreeRuntimeCodec<K>
    this.registry.bindCommand(operation, { decodeRequest: value => codec.decodeArguments(structuredClone(value)), validateArguments: codec.validateArguments, authorize: (_args, caller) => { this.authorize(caller); return true }, invoke: (args, caller, signal) => {
      if (this.flights.size >= WORKTREE_RUNTIME_LIMITS.requests || mutation(operation) && this.mutationBusy) throw new ServiceProtocolError('BACKPRESSURE')
      if (mutation(operation)) this.mutationBusy = true
      const controller = new AbortController(), abort = (): void => controller.abort(); this.controllers.add(controller); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
      const work = this.execute(operation, args, Object.freeze({ ...caller }), controller.signal).finally(() => { this.controllers.delete(controller); signal.removeEventListener('abort', abort); if (mutation(operation)) this.mutationBusy = false })
      this.flights.add(work); void work.then(() => this.flights.delete(work), () => this.flights.delete(work)); return work
    }, validateResult: codec.validateResult, encodeResult: codec.encodeResult })
  }
}
