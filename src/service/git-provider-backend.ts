import { GitHubManager } from '../main/github-manager'
import { GitLabManager } from '../main/gitlab-manager'
import { ForgejoManager } from '../main/forgejo-manager'
import { GitProviderProcessOwner, GitProviderProcessError } from '../main/git-provider-process-owner'
import type { DatabaseManager } from '../main/database/manager'
import { FORGEJO_LOGIN_SETTING, REPO_PROVIDERS_SETTING, recordRepoProviders, type GitProvider } from '../main/repo-providers'
import { GIT_PROVIDER_CODECS, GIT_PROVIDER_OPERATIONS, GIT_PROVIDER_LIMITS, gitProviderRepository, gitProviderLoginName, type GitProviderCodec, type GitProviderOperation } from '../shared/git-provider-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

export interface GitProviderOwners {
  database: DatabaseManager
  github: GitHubManager
  gitlab: GitLabManager
  forgejo: ForgejoManager
  processOwner: GitProviderProcessOwner
}
export interface GitProviderBackendOptions extends GitProviderOwners {
  engineEpoch: string
  assertAvailable(): void
  assertGitProviderOwners(owners: GitProviderOwners): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canManageGitProviders(caller: DesktopCallerContext, access: 'read' | 'write'): boolean
}
const mutation = (operation: GitProviderOperation): boolean => operation === 'forgejo:setLogin' || operation === 'git:recordRepoProviders'

/** Retained provider discovery/settings controls, borrowing one actual process
 * owner. No CLI installation, login/authentication flow, or endpoint grants. */
export class GitProviderBackend {
  readonly registry: DesktopOperationRegistry
  private readonly owners: GitProviderOwners
  private readonly flights = new Set<Promise<unknown>>()
  private readonly controllers = new Set<AbortController>()
  private closing = false
  private mutationBusy = false
  constructor(private readonly options: GitProviderBackendOptions) {
    this.owners = Object.freeze({ database: options.database, github: options.github, gitlab: options.gitlab, forgejo: options.forgejo, processOwner: options.processOwner })
    if (!(options.github instanceof GitHubManager) || !(options.gitlab instanceof GitLabManager) || !(options.forgejo instanceof ForgejoManager) || !(options.processOwner instanceof GitProviderProcessOwner)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.available()
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    for (const operation of GIT_PROVIDER_OPERATIONS) this.bind(operation)
  }
  get inflightCount(): number { return this.flights.size }
  shutdown(): void { this.closing = true; for (const controller of this.controllers) controller.abort() }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid Git provider shutdown deadline')
    this.shutdown(); let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.allSettled([...this.flights]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(GIT_PROVIDER_OPERATIONS.map(operation => [operation, {
      validatePayload: (value: unknown) => { try { return isJsonValue(value) && GIT_PROVIDER_CODECS[operation].validateArguments(GIT_PROVIDER_CODECS[operation].decodeArguments(value)) } catch { return false } },
      validateResult: GIT_PROVIDER_CODECS[operation].validateWireResult,
      handle: (value: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, value, caller, signal)
    }]))
  }
  private available(signal?: AbortSignal): void {
    if (this.closing) throw new ServiceProtocolError('DISCONNECTED')
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    this.options.assertAvailable(); this.options.assertGitProviderOwners(this.owners)
    if (!this.owners.database.db.open) throw new ServiceProtocolError('DISCONNECTED')
    this.owners.github.assertOwners(this.owners.processOwner); this.owners.gitlab.assertOwners(this.owners.processOwner); this.owners.forgejo.assertOwners(this.owners.processOwner)
  }
  private authorize(operation: GitProviderOperation, caller: DesktopCallerContext, signal?: AbortSignal): void {
    this.available(signal)
    if (caller.principal !== 'trusted-desktop-main' || caller.engineEpoch !== this.options.engineEpoch || !caller.webviewId || !caller.origin || !this.options.isTrustedDesktop(caller) || !this.options.canManageGitProviders(caller, 'read') || mutation(operation) && !this.options.canManageGitProviders(caller, 'write')) throw new ServiceProtocolError('INVALID_REQUEST')
  }
  private setting(key: string, max: number): string | null {
    const row = this.owners.database.db.prepare('SELECT typeof(value) AS type, length(CAST(value AS BLOB)) AS bytes FROM settings WHERE key=?').get(key) as { type: string; bytes: number } | undefined
    if (!row) return null
    if (row.type !== 'text') throw new ServiceProtocolError('INVALID_REQUEST')
    if (row.bytes > max) throw new ServiceProtocolError('FRAME_TOO_LARGE')
    return (this.owners.database.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string }).value
  }
  private loginSetting(): string | null {
    const value = this.setting(FORGEJO_LOGIN_SETTING, 128)
    if (value !== null && value !== '' && !gitProviderLoginName(value)) throw new ServiceProtocolError('INVALID_REQUEST')
    return value
  }
  private providerMap(): { raw: string | null; map: Record<string, GitProvider> } {
    const raw = this.setting(REPO_PROVIDERS_SETTING, GIT_PROVIDER_LIMITS.providerMapBytes)
    let value: unknown
    try { value = raw ? JSON.parse(raw) : {} } catch { throw new ServiceProtocolError('INVALID_REQUEST') }
    if (!isRecord(value) || Object.keys(value).length > GIT_PROVIDER_LIMITS.providerMapEntries || Object.entries(value).some(([name, provider]) => !gitProviderRepository(name) || !['github', 'gitlab', 'forgejo'].includes(provider as string))) throw new ServiceProtocolError('INVALID_REQUEST')
    return { raw, map: value as Record<string, GitProvider> }
  }
  private async execute<K extends GitProviderOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext, signal: AbortSignal): Promise<DesktopCommandMap[K]['result']> {
    this.authorize(operation, caller, signal)
    const forgejoScope = operation.startsWith('forgejo:') || operation === 'github:fetchPullRequestDetails'
    let login = forgejoScope ? this.loginSetting() : null
    const providers = operation === 'git:recordRepoProviders' ? this.providerMap() : null
    const recheck = (): void => {
      this.authorize(operation, caller, signal)
      if (forgejoScope && this.loginSetting() !== login || providers && this.setting(REPO_PROVIDERS_SETTING, GIT_PROVIDER_LIMITS.providerMapBytes) !== providers.raw) throw new ServiceProtocolError('INVALID_REQUEST')
    }
    try { return await this.owners.processOwner.withRequestGuard(async () => {
      recheck(); let result: unknown
      switch (operation) {
        case 'github:checkCli': result = await this.owners.github.checkGhCli(); break
        case 'github:fetchOrgs': result = await this.owners.github.fetchUserOrgs(); break
        case 'github:fetchOrgRepos': result = await this.owners.github.fetchOrgRepos(args[0] as string); break
        case 'github:fetchUserRepos': result = await this.owners.github.fetchUserRepos(); break
        case 'github:fetchPullRequestDetails': {
          const url = args[0] as string
          if (new URL(url).hostname.toLowerCase() === 'github.com') result = await this.owners.github.fetchPullRequestDetails(url)
          else { const configured = await this.owners.forgejo.isForgejoUrl(url); recheck(); if (!configured) throw new ServiceProtocolError('INVALID_ARGUMENTS'); result = await this.owners.forgejo.fetchPullRequestDetails(url) }
          break
        }
        case 'gitlab:checkCli': result = await this.owners.gitlab.checkGlabCli(); break
        case 'gitlab:fetchOrgs': result = await this.owners.gitlab.fetchUserOrgs(); break
        case 'gitlab:fetchOrgRepos': result = await this.owners.gitlab.fetchOrgRepos(args[0] as string); break
        case 'gitlab:fetchUserRepos': result = await this.owners.gitlab.fetchUserRepos(); break
        case 'forgejo:checkCli': result = await this.owners.forgejo.checkTeaCli(); break
        case 'forgejo:fetchOrgs': result = await this.owners.forgejo.fetchUserOrgs(); break
        case 'forgejo:fetchOrgRepos': result = await this.owners.forgejo.fetchOrgRepos(args[0] as string); break
        case 'forgejo:fetchUserRepos': result = await this.owners.forgejo.fetchUserRepos(); break
        case 'forgejo:setLogin': {
          const name = args[0] as string | null
          const before = GIT_PROVIDER_CODECS['forgejo:checkCli'].encodeResult(await this.owners.forgejo.checkTeaCli())
          recheck()
          const status = (before as { value: JsonValue }).value as unknown as { installed: boolean; logins: Array<{ name: string }> }
          if (name !== null && (!status.installed || status.logins.filter(row => row.name === name).length !== 1)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
          this.owners.database.setSetting(FORGEJO_LOGIN_SETTING, name ?? '')
          login = this.loginSetting()
          result = await this.owners.forgejo.checkTeaCli()
          break
        }
        case 'git:recordRepoProviders': {
          const names = args[0] as string[], provider = args[1] as GitProvider
          const next = { ...providers!.map, ...Object.fromEntries(names.map(name => [name, provider])) }
          if (Object.keys(next).length > GIT_PROVIDER_LIMITS.providerMapEntries || Buffer.byteLength(JSON.stringify(next)) > GIT_PROVIDER_LIMITS.providerMapBytes) throw new ServiceProtocolError('FRAME_TOO_LARGE')
          recheck(); recordRepoProviders(this.owners.database, names, provider)
          providers!.raw = this.setting(REPO_PROVIDERS_SETTING, GIT_PROVIDER_LIMITS.providerMapBytes)
          result = undefined; break
        }
      }
      recheck()
      const codec = GIT_PROVIDER_CODECS[operation] as GitProviderCodec<K>, encoded = codec.encodeResult(result)
      return codec.decodeResult(encoded.defined ? encoded.value : undefined)
    }, recheck, signal) }
    catch (error) {
      recheck()
      if (error instanceof ServiceProtocolError) throw error
      if (error instanceof GitProviderProcessError) {
        const codes = { GIT_PROVIDER_CANCELLED: 'CANCELLED', GIT_PROVIDER_CLOSED: 'DISCONNECTED', GIT_PROVIDER_BUSY: 'BACKPRESSURE', GIT_PROVIDER_TIMEOUT: 'TIMEOUT', GIT_PROVIDER_OUTPUT_LIMIT: 'FRAME_TOO_LARGE', GIT_PROVIDER_INVALID_RESULT: 'INVALID_RESULT' } as const
        if (Object.hasOwn(codes, error.code)) throw new ServiceProtocolError(codes[error.code as keyof typeof codes])
      }
      throw new ServiceProtocolError('INTERNAL_ERROR')
    }
  }
  private bind<K extends GitProviderOperation>(operation: K): void {
    const codec = GIT_PROVIDER_CODECS[operation] as GitProviderCodec<K>
    this.registry.bindCommand(operation, { decodeRequest: value => codec.decodeArguments(structuredClone(value)), validateArguments: codec.validateArguments,
      authorize: (_args, caller) => { this.authorize(operation, caller); return true },
      invoke: (args, caller, signal) => {
        if (this.flights.size >= 16 || mutation(operation) && this.mutationBusy) throw new ServiceProtocolError('BACKPRESSURE')
        if (mutation(operation)) this.mutationBusy = true
        const controller = new AbortController(), abort = (): void => controller.abort()
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) controller.abort(); this.controllers.add(controller)
        const work = this.execute(operation, args, Object.freeze({ ...caller }), controller.signal).finally(() => { this.controllers.delete(controller); signal.removeEventListener('abort', abort); if (mutation(operation)) this.mutationBusy = false })
        this.flights.add(work); void work.then(() => this.flights.delete(work), () => this.flights.delete(work)); return work
      }, validateResult: codec.validateResult, encodeResult: codec.encodeResult })
  }
}
