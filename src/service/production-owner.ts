import { resolveTaskRepos } from '../main/agent-manager/project-repos'
import { ProductionWorkspaceProcessOwner } from './production-workspace-process-owner'
import type { ArtifactCopyFileResult } from '../shared/artifacts'
import type { AttachmentPathReceipt } from '../shared/attachment-native-callbacks'
import type { DesktopCallerContext } from './transport/desktop-registry'
import { ProductionEnergyOwner } from './production-energy-owner'
import { isUiLeaseId } from '../shared/ui-desktop-codecs'
import { PortableAgentInstallationOwner, type PortableAgentInstallationOwnerOptions } from '../main/agent-installer/portable-installation'
import { resolveProductionNpmCli } from './production-installation-host'
import type { DesktopEventMap } from '../shared/desktop-operations'
import { ProductionUiOwner, assertUiStateReferences, assertUiCommandReferences, type ProductionUiNativeHost } from '../main/production-ui-owner'
import { CliMcpConfigManager } from '../main/cli-mcp-config/core'
import { CliMcpFileOwner, type CliMcpFileOwnerOptions } from '../main/cli-mcp-config/portable-file-owner'
import { TaskAttachmentFileOwner, type TaskAttachmentFileOwnerOptions } from '../main/task-attachment-file-owner'
import { TaskAttachmentJournal } from '../main/task-attachment-journal'
import { AttachmentExecutionOwner, AttachmentExecutionError } from '../main/attachment-execution-owner'
import type { FileAttachmentRecord } from '../main/database/types'
import { homedir, networkInterfaces } from 'node:os'
import { PortableAgentDetectionOwner } from '../main/agent-installer/portable-detection'
import { createProductionGitProviderOwner } from './production-git-provider-owner'
import { WorkspaceFileOwner, type WorkspaceFileOwnerOptions } from '../main/workspace-file-owner'
import type { WorkspacePathReceipt, WorkspaceCleanupObserver } from '../shared/workspace-native-callbacks'
import { GitProviderProcessOwner, type GitProviderProcessOwnerOptions } from '../main/git-provider-process-owner'
import { ProductionVoiceActionOwner, type VoiceActionAuthority } from './production-voice-actions'
import { createProductionVoiceOwner, type ProductionVoiceOwner, type ProductionVoiceResources } from './production-voice-owner'
import { setMobileApiDeps, assertMobileApiDeps, setMobileApiNotifier, applyMobileAccessSettings, stopMobileApiServer, closeMobileApiServer, broadcastToMobileClients, type MobileApiDeps } from '../main/mobile-api-server'
import { ProductionMobileActions } from './production-mobile-actions'
import { TunnelManagerCore } from '../main/tunnel-manager-core'
import SQLite from 'better-sqlite3'
import { createRequire } from 'node:module'
import { TerminalServiceCore, type TerminalProcessHost } from '../main/terminal-service-core'
import { createNodePty, resolveShell, terminalProcessCwd } from '../main/terminal-process'
import type { ProductionCredentialMutation } from '../shared/production-credential-mutation'
import { TASK_SOURCE_STORED_CREDENTIAL_FIELDS } from '../shared/task-source-credentials'
import { ProductionAdapters } from './production-adapters'
import { ProductionProviderOwner } from './production-provider-owner'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { McpProbeService } from '../main/agent-manager/mcp-probe-service'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statfsSync, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseManager, type DatabaseRuntimeOptions } from '../main/database/manager'
import { decryptSettingValue, decryptRecordCredential } from '../main/database/serializers'
import { acquireProfileLock, type ProfileLock } from '../main/platform/profile-lock'
import { initializeProtectedSecretStorage, type AuthenticatedSecretStorage, type ProtectedApplicationKeyStore } from '../main/platform/authenticated-secret-storage'
import { configureSecretStorage, releaseSecretStorage } from '../main/platform/secret-storage'
import { AgentManager } from '../main/agent-manager-core'
import type { AgentManagerHost } from '../main/agent-manager/host'
import { createAdapter, isCodexAppServerAdapter } from '../main/agent-manager/adapter-factory'
import { createChatProviderFromSettings } from '../main/chat/provider-factory'
import { OAuthManager } from '../main/oauth/oauth-manager-core'
import { WorktreeManager, WORKTREE_PORTABLE_LIMITS } from '../main/worktree-manager-core'
import { GitHubManager } from '../main/github-manager'
import { GitLabManager } from '../main/gitlab-manager'
import { ForgejoManager } from '../main/forgejo-manager'
import { SecretBroker } from '../main/secret-broker-core'
import { writeSecretShellWrapper } from '../main/secret-shell'
import { PluginRegistry } from '../main/plugins/registry'
import { LinearPlugin } from '../main/plugins/linear-plugin'
import { HubSpotPlugin } from '../main/plugins/hubspot-plugin'
import { GitHubIssuesPlugin } from '../main/plugins/github-issues-plugin'
import { ForgejoIssuesPlugin } from '../main/plugins/forgejo-issues-plugin'
import { NotionPlugin } from '../main/plugins/notion-plugin'
import { YouTrackPlugin } from '../main/plugins/youtrack-plugin'
import { ConnectorBridgeCore } from '../main/plugins/connector-bridge-core'
import { getConnectorRuntime, disposeConnectorRuntime, closeConnectorRuntime, type ConnectorRuntimeHost, type ConnectorRuntime } from '../main/connectors/bridge/runtime-core'
import type { ConnectorOAuthFlowAuthority } from '../main/oauth/connector-oauth-flow'
import type { ArtifactViewerNativeBridge } from '../shared/artifact-viewer-native'
import { ConnectorBridgeService } from '../main/connectors/bridge/service'
import { SessionContextService } from '../main/sessions/context-service'
import { createPackagedConnectorTransport, validateConnectorResources } from '../main/connectors/piece-host/packaged-resources'
import { SyncManager } from '../main/sync-manager'
import { TaskGroupService } from '../main/task-groups/service'
import { HeartbeatSchedulerCore } from '../main/heartbeat-scheduler-core'
import { HeartbeatFileOwner, type HeartbeatFileOwnerOptions } from '../main/heartbeat-file-owner'
import { assertHeartbeatTaskEffects, captureHeartbeatTaskEffects, type HeartbeatTaskAuthority } from './heartbeat-backend'
import { runOwnedPreflightChecks } from '../main/heartbeat-preflight'
import { RecurrenceSchedulerCore } from '../main/recurrence-scheduler-core'
import { TaskAutomationScheduler } from '../main/task-automation-scheduler'
import { WorkspaceCleanupSchedulerCore, createBoundedWorkspaceCleanupStore } from '../main/workspace-cleanup-scheduler-core'
import { CaptainWaker } from '../main/captain-waker'
import { ScheduledCoordination, type BriefingSpeech } from '../main/scheduled-coordination-core'
import { OverdueNotifier } from '../main/overdue-notifier'
import { ClaudePluginManager } from '../main/claude-plugin-manager'
import { ChatRuntime } from '../main/chat/chat-runtime'
import { CommanderStore } from '../main/commander/commander-store'
import { CommanderService } from '../main/commander/commander-service'
import { CaptainDeliveryService } from '../main/commander/captain-delivery'
import { createCommanderProjectTools } from '../main/commander/project-tools'
import { createCommanderSkillTools } from '../main/commander/skill-tools'
import { installCommanderReportBridge } from '../main/commander/report-tools'
import { configureCaptainGithubTools, recoverIssueWriteOutcomes } from '../main/captain-github-tools'
import { setCoordinatorCallHandler } from '../main/mcp-servers/task-management-core'
import { startTaskApiServer, stopTaskApiServer, closeTaskApiServer, waitForTaskApiServer, getTaskApiPort, getTaskApiToken } from '../main/task-api-server-core'
import { setTaskApiAgentController, setTaskApiNotifier, setTaskApiTaskGroupService, setTaskApiUiState, setTaskApiUiOwner, assertTaskApiUiOwner, setTranscriptProvider } from '../main/task-api/state'
import { buildTaskMcpUrl } from '../main/task-mcp-endpoint'
import { setTaskAutomationTrigger, setTaskSchedulers } from '../main/task-updates'
import { PRODUCTION_OWNER_STAGES, PRODUCTION_RECOVERY_CODES, type ProductionOwnerState } from '../shared/production-bootstrap'
import { reconcileProductionRestart } from './production-recovery'
import type { UiCommand } from '../shared/ui-commands'

export type ProductionOwnerPhase = 'new' | 'starting' | 'ready' | 'stopping' | 'blocked' | 'stopped' | 'failed'
export interface ProductionOwnerSnapshot {
  epoch: string
  sequence: number
  phase: ProductionOwnerPhase
  stage: string
  owned: boolean
  code?: string
  capabilities: { connectors: 'enabled' | 'disabled'; managedTaskMcp: 'enabled' | 'disabled' }
}

export class ProductionOwnerError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ProductionOwnerError' }
}

/** Trusted host bootstrap only: none of these paths or callbacks come from RPC. */
export interface ProductionOwnerBootstrap {
  profileId: string
  paths: DatabaseRuntimeOptions['paths'] & { reposRoot: string; resourceRoot: string; tempRoot: string }
  credentials: { store: ProtectedApplicationKeyStore; mode: 'load' | 'create' }
  managedTaskMcp: DatabaseRuntimeOptions['managedTaskMcp']
  connectors: { kind: 'disabled'; reason: string } | { kind: 'enabled' }
  /** Verified browser resource root; absent artifacts never expose mobile access. */
  mobile?: { distRoot: string; port?: number }
  /** Verified optional worker pair and selected standalone runtime, never RPC paths. */
  voice?: ProductionVoiceResources
  agentInstallation?: { nodeExecutable: string }
  native: {
    workspaceCleanup?: { observe: WorkspaceCleanupObserver }
    /** Captured actual native tray owner, never a renderer setting grant. */
    trayAvailable?: boolean
    /** Actual optional suspend-inhibition bridge, selected at private launch. */
    energy?: { setActive(active: boolean): Promise<boolean> }
    agents: Pick<AgentManagerHost, 'renderer' | 'notifications' | 'energy' | 'configuredMcp'>
    /** PATH/native supervision readiness, before any adapter or scheduler starts. */
    prepareRuntime(signal: AbortSignal): Promise<void>
    openExternal(url: string): Promise<void> | void
    openPath?(path: string, receipt: WorkspacePathReceipt): Promise<void>
    showItemInFolder?(path: string, receipt: WorkspacePathReceipt): Promise<void>
    /** Trusted capability, separate from merely having an erroring callback. */
    oauthBrowser?: 'available' | 'unavailable'
    connectorOAuthFlows?: ConnectorOAuthFlowAuthority
    /** Private static viewer authority; never a public desktop operation. */
    artifactViewer?: ArtifactViewerNativeBridge
    notify(title: string, body: string): void
    emit(channel: string, data: unknown): void
    ui?: ProductionUiNativeHost
    emitInstallationProgress?(progress: DesktopEventMap['agent-installer:progress'], leaseId: string): Promise<void>
    openAttachment?(receipt: AttachmentPathReceipt, leaseId: string): Promise<void>
    copyArtifact?(receipt: WorkspacePathReceipt, leaseId: string, beforeEffect: () => void): Promise<ArtifactCopyFileResult>
    downloadAttachment?(receipt: AttachmentPathReceipt, leaseId: string, beforeEffect: () => void): Promise<void>
    sendUiCommand(command: UiCommand): { ok: true } | { ok: false; detail: string }
    /** Join only this launch's supervised children. Failure retains the lease. */
    drainOwnedProcesses(): Promise<{ acknowledged: true }>
    speech?: { get(): BriefingSpeech | null; canPlayAudio(): boolean }
  }
  onState?(state: ProductionOwnerSnapshot): void
}

/** External boundaries for deterministic tests; lifecycles and stores remain real. */
export interface ProductionOwnerExternalBoundaries {
  createAdapter?: AgentManagerHost['createAdapter']
  createProvider?: typeof createChatProviderFromSettings
  connectorTransport?: ConnectorRuntimeHost['createTransport']
  terminalProcessHost?: TerminalProcessHost
  mobileTunnel?: TunnelManagerCore
  agentDetection?: PortableAgentDetectionOwner
  agentInstallation?: { nodeExecutable: string; homeDir: string; environment: NodeJS.ProcessEnv; npmCliPath?: string | null; create?: (options: PortableAgentInstallationOwnerOptions) => PortableAgentInstallationOwner }
  gitProviderProcess?: (options: GitProviderProcessOwnerOptions) => GitProviderProcessOwner
  workspaceFiles?: (options: WorkspaceFileOwnerOptions) => WorkspaceFileOwner
  heartbeatFiles?: (options: HeartbeatFileOwnerOptions) => HeartbeatFileOwner
  cliMcp?: { homeDir: string; environment: NodeJS.ProcessEnv; files?: (options: CliMcpFileOwnerOptions) => CliMcpFileOwner }
  taskAttachmentFiles?: (options: TaskAttachmentFileOwnerOptions) => TaskAttachmentFileOwner
}

export interface ProductionServices {
  ui: ProductionUiOwner | null
  cliMcp: CliMcpConfigManager
  cliMcpFiles: CliMcpFileOwner
  taskAttachmentFiles: TaskAttachmentFileOwner
  workspaceFiles: WorkspaceFileOwner
  heartbeatFiles: HeartbeatFileOwner
  github: GitHubManager
  gitlab: GitLabManager
  forgejo: ForgejoManager
  gitProviderProcess: GitProviderProcessOwner
  voice: ProductionVoiceOwner | null
  agentDetection: PortableAgentDetectionOwner
  agentInstallation: PortableAgentInstallationOwner | null
  sessionContext: SessionContextService
  db: DatabaseManager
  agents: AgentManager
  oauth: OAuthManager
  worktrees: WorktreeManager
  sync: SyncManager
  registry: PluginRegistry
  groups: TaskGroupService
  chat: ChatRuntime
  createChatProvider: () => ReturnType<typeof createChatProviderFromSettings>
  commander: CommanderService
  commanderStore: CommanderStore
  captainDelivery: CaptainDeliveryService
  plugins: ClaudePluginManager
  heartbeat: HeartbeatSchedulerCore
  recurrence: RecurrenceSchedulerCore
  automation: TaskAutomationScheduler
  wakeups: CaptainWaker
  coordination: ScheduledCoordination
  cleanup: WorkspaceCleanupSchedulerCore
  reminders: OverdueNotifier
  terminals: TerminalServiceCore
  mcpProbes: McpProbeService
}

// Task API, secret storage, report bridge and task lifecycle hooks are process
// globals. Reserve them before asynchronous key access, even for distinct profiles.
const MOBILE_OWNER_EVENTS = new Set(['agent:status', 'agent:incompatible-session', 'agent:recoveryStateChanged', 'agent:startQueueChanged', 'concurrency:changed', 'project:statusChanged', 'task:source-action-failed', 'task:updated', 'transcript:changed', 'task:created', 'task:subtasks-reordered', 'task:checkpointAnswered', 'artifact:updated', 'task:deleted', 'tasks:refresh', 'ui:command', 'project:changed'])
const registryKey = Symbol.for('21x.production-service.owner.v1')
const processRegistry = globalThis as typeof globalThis & { [registryKey]?: object }

/** One application lifetime independent of any renderer/window attachment. */
export class ProductionOwner {
  private mobile: { deps: MobileApiDeps; tunnel: TunnelManagerCore | null; port?: number } | null = null
  private ownedPath: { previous: string | undefined; installed: string } | null = null
  private ownedPiEnvironment: { previous: string | undefined; installed: string } | null = null
  private phase: ProductionOwnerPhase = 'new'
  private stage = 'new'
  private code: string | undefined
  private sequence = 0
  private readonly epoch = randomUUID()
  private readonly identity = {}
  private readonly abort = new AbortController()
  private readonly rawWork = new Set<Promise<unknown>>()
  private rawInitialization: Promise<void> | null = null
  private startup: Promise<ProductionServices> | null = null
  private closing: Promise<void> | null = null
  private rawDrain: Promise<void> | null = null
  private readonly fenced = new Set<() => void>()
  private lock: ProfileLock | null = null
  private storage: AuthenticatedSecretStorage | null = null
  private storageRegistered = false
  private db: DatabaseManager | null = null
  private databaseRuntime: DatabaseRuntimeOptions | null = null
  private broker: SecretBroker | null = null
  private services: ProductionServices | null = null
  private workspaceProcesses: ProductionWorkspaceProcessOwner | null = null
  private readonly workspaceTerminalUsers = new Set<object>()
  private connector: ConnectorBridgeCore | null = null
  private connectorRuntime: ConnectorRuntime | null = null
  private connectorService: ConnectorBridgeService | null = null
  private removeReportBridge: (() => void) | null = null
  private apiOwned = false
  private voiceActions: { authority: VoiceActionAuthority; owner: ProductionVoiceActionOwner } | null = null
  private readonly stopOwners: Array<() => void> = []
  private readonly drains = new Map<string, () => Promise<void>>()
  private nativeDrained = false
  private readonly providers = new ProductionProviderOwner()

  constructor(private readonly bootstrap: ProductionOwnerBootstrap, private readonly boundaries: ProductionOwnerExternalBoundaries = {}) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(bootstrap.profileId)) throw new ProductionOwnerError('PROFILE_ID_INVALID')
    for (const path of Object.values(bootstrap.paths)) {
      if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new ProductionOwnerError('BOOTSTRAP_PATH_INVALID')
    }
    if (bootstrap.connectors.kind === 'disabled' && !bootstrap.connectors.reason.trim()) throw new ProductionOwnerError('CONNECTOR_POLICY_INVALID')
  }

  snapshot(): ProductionOwnerSnapshot {
    return { epoch: this.epoch, sequence: this.sequence, phase: this.phase, stage: this.stage,
      owned: processRegistry[registryKey] === this.identity, ...(this.code ? { code: this.code } : {}),
      capabilities: { connectors: this.bootstrap.connectors.kind,
        managedTaskMcp: 'disabled' in this.bootstrap.managedTaskMcp ? 'disabled' : 'enabled' } }
  }

  /** Read-only private observation remains available after failed admission or
   * blocked cleanup. Unknown internal error codes cannot cross this boundary. */
  recoveryState(): ProductionOwnerState {
    const state = this.snapshot()
    const stage = PRODUCTION_OWNER_STAGES.find(value => value === state.stage) ?? 'services'
    let code = PRODUCTION_RECOVERY_CODES.find(value => value === state.code) ?? null
    if (state.code && !code) code = state.code.startsWith('AGENT_CLI_') ? 'AGENT_CLI_UNAVAILABLE'
      : state.code.startsWith('CONNECTOR_') ? 'CONNECTOR_RESOURCES_REQUIRED' : 'BOOTSTRAP_FAILED'
    return { phase: state.phase, stage, code, owned: state.owned }
  }

  start(): Promise<ProductionServices> {
    if (this.startup) return this.startup
    if (this.phase !== 'new') return Promise.reject(new ProductionOwnerError('OWNER_NOT_STARTABLE'))
    if (processRegistry[registryKey]) return Promise.reject(new ProductionOwnerError('SERVICE_DUPLICATE_OWNER'))
    processRegistry[registryKey] = this.identity
    this.update('starting', 'profile-lock')
    this.rawInitialization = this.initialize()
    this.startup = this.rawInitialization.then(() => {
      this.assertStarting()
      this.update('ready', 'ready')
      return this.services!
    }, async error => {
      const failedStage = this.stage
      const code = safeStartupCode(error, failedStage)
      // A caller already closing the owner controls release/retry. Late init
      // failure cannot turn its blocked shutdown into an automatic lease release.
      if (this.abort.signal.aborted) throw new ProductionOwnerError(code)
      this.code = code
      try { await this.close() } catch { throw new ProductionOwnerError(code) }
      this.update('failed', failedStage, code)
      throw new ProductionOwnerError(code)
    })
    return this.startup
  }

  /** Every service-facing request owns its raw promise, including ignored abort. */
  run<T>(operation: (services: ProductionServices, signal: AbortSignal) => Promise<T> | T): Promise<T> {
    if (this.phase !== 'ready' || this.abort.signal.aborted || !this.services) return Promise.reject(new ProductionOwnerError('OWNER_NOT_READY'))
    return this.own(Promise.resolve().then(() => {
      if (this.abort.signal.aborted) throw new ProductionOwnerError('OWNER_CLOSING')
      this.lock!.assertHeld()
      return operation(this.services!, this.abort.signal)
    }))
  }

  /** Main-process binding only; a captured lease remains valid during drain
   * while new binding requests are fenced as soon as shutdown begins. */
  getDatabaseBindingLease(): { lock: Pick<ProfileLock, 'profileRoot' | 'assertHeld'>; runtime: DatabaseRuntimeOptions } {
    if (this.phase !== 'ready' || this.abort.signal.aborted || !this.lock || !this.databaseRuntime || processRegistry[registryKey] !== this.identity) {
      throw new ProductionOwnerError('OWNER_NOT_READY')
    }
    const lock = this.lock
    lock.assertHeld()
    const runtime = this.databaseRuntime
    return {
      lock: { profileRoot: lock.profileRoot, assertHeld: () => {
        if (this.lock !== lock || processRegistry[registryKey] !== this.identity) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
        lock.assertHeld()
      } },
      runtime: { paths: { ...runtime.paths }, managedTaskMcp: 'disabled' in runtime.managedTaskMcp ? { disabled: true } : {
        ...runtime.managedTaskMcp, args: [...runtime.managedTaskMcp.args], tools: runtime.managedTaskMcp.tools.map(tool => ({ ...tool })), environment: { ...runtime.managedTaskMcp.environment }
      } }
    }
  }

  getSettingsBindingLease(): { secretStorage: AuthenticatedSecretStorage; assertSettingsOwners(owners: {
    database: DatabaseManager; manager: AgentManager; recurrence: RecurrenceSchedulerCore; heartbeat: HeartbeatSchedulerCore;
    automation: TaskAutomationScheduler; coordination: ScheduledCoordination; cleanup: WorkspaceCleanupSchedulerCore; secretStorage: unknown
  }): void } {
    this.getDatabaseBindingLease()
    const storage = this.storage!
    const services = this.services!
    return { secretStorage: storage, assertSettingsOwners: owners => {
      this.getDatabaseBindingLease()
      if (this.storage !== storage || this.services !== services || owners.secretStorage !== storage || owners.database !== services.db ||
        owners.manager !== services.agents || owners.recurrence !== services.recurrence || owners.heartbeat !== services.heartbeat ||
        owners.automation !== services.automation || owners.coordination !== services.coordination || owners.cleanup !== services.cleanup)
        throw new ProductionOwnerError('SERVICE_OWNER_LOST')
    } }
  }

  getTrayBindingLease(): { database: DatabaseManager; manager: AgentManager; trayAvailable: boolean; assertOwners(owners: { database: DatabaseManager; manager: AgentManager }): void } {
    this.getDatabaseBindingLease()
    const services = this.services!, database = services.db, manager = services.agents
    const trayAvailable = this.bootstrap.native.trayAvailable === true
    return { database, manager, trayAvailable, assertOwners: owners => {
      this.getDatabaseBindingLease()
      if (this.services !== services || owners.database !== database || owners.manager !== manager || services.db !== database || services.agents !== manager || (this.bootstrap.native.trayAvailable === true) !== trayAvailable) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
    } }
  }
  /** Source-only transcript consumer; no desktop operation or native capability. */
  createVoiceActions(authority: VoiceActionAuthority): ProductionVoiceActionOwner {
    this.getDatabaseBindingLease()
    if (this.voiceActions) {
      if (this.voiceActions.authority !== authority) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
      return this.voiceActions.owner
    }
    const owner = new ProductionVoiceActionOwner(this.getVoiceActionBindingLease(), authority, this.epoch)
    this.voiceActions = { authority, owner }
    this.retainCleanup('voice-actions', () => owner.shutdown(), () => owner.close())
    return owner
  }
  getVoiceActionBindingLease() {
    this.getDatabaseBindingLease()
    const services = this.services!
    return { database: services.db, manager: services.agents, sync: services.sync, registry: services.registry,
      recurrence: services.recurrence, heartbeat: services.heartbeat, automation: services.automation,
      emit: (operation: string, payload: import('../shared/service-protocol').JsonValue) => this.emit(operation, payload),
      onFatalEvent: (_error: unknown) => { void this.close().catch(() => {}) },
      assertOwners: () => { this.getDatabaseBindingLease(); if (this.services !== services) throw new ProductionOwnerError('SERVICE_OWNER_LOST') } }
  }

  getVoiceBindingLease(): { voice: ProductionVoiceOwner['voice']; speech: ProductionVoiceOwner['speech']; assertVoiceOwners(owners: { voice: ProductionVoiceOwner['voice']; speech: ProductionVoiceOwner['speech'] }): void } | null {
    this.getDatabaseBindingLease()
    const services = this.services!, owned = services.voice
    if (!owned) return null
    return { voice: owned.voice, speech: owned.speech, assertVoiceOwners: owners => {
      this.getDatabaseBindingLease()
      if (this.services !== services || this.services.voice !== owned || owners.voice !== owned.voice || owners.speech !== owned.speech) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
      owned.assertOwners(services.db, services.agents, this.storage!)
    } }
  }

  getGitProviderBindingLease() {
    this.getDatabaseBindingLease()
    const services = this.services!, { github, gitlab, forgejo, gitProviderProcess: processOwner, db: database } = services
    return { database, github, gitlab, forgejo, processOwner,
      assertGitProviderOwners: (owners: { database: DatabaseManager; github: GitHubManager; gitlab: GitLabManager; forgejo: ForgejoManager; processOwner: GitProviderProcessOwner }): void => {
        this.getDatabaseBindingLease()
        if (this.services !== services || owners.database !== database || owners.github !== github || owners.gitlab !== gitlab || owners.forgejo !== forgejo || owners.processOwner !== processOwner ||
          services.github !== github || services.gitlab !== gitlab || services.forgejo !== forgejo || services.gitProviderProcess !== processOwner) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
        processOwner.assertOpen(); github.assertOwners(processOwner); gitlab.assertOwners(processOwner); forgejo.assertOwners(processOwner)
      } }
  }

  getWorkspaceFileBindingLease() {
    this.getDatabaseBindingLease()
    const services = this.services!, files = services.workspaceFiles, database = services.db, workspaceRoot = this.bootstrap.paths.workspaceRoot
    return { database, files, workspaceRoot,
      assertWorkspaceFileOwners: (db: DatabaseManager, owner: WorkspaceFileOwner, root: string): void => {
        this.getDatabaseBindingLease()
        if (this.services !== services || services.db !== database || services.workspaceFiles !== files || db !== database || owner !== files || root !== workspaceRoot) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
        files.assertOwners(workspaceRoot)
      } }
  }

  getCliMcpBindingLease() {
    this.getDatabaseBindingLease()
    const services = this.services!, { cliMcp: manager, cliMcpFiles: files, mcpProbes: probes } = services
    return { manager, files, probes, assertCliMcpOwners: (owners: { manager: CliMcpConfigManager; files: CliMcpFileOwner; probes: McpProbeService }): void => {
      this.getDatabaseBindingLease()
      if (this.services !== services || services.cliMcp !== manager || services.cliMcpFiles !== files || services.mcpProbes !== probes || owners.manager !== manager || owners.files !== files || owners.probes !== probes) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
      manager.assertOwners({ files, probes }); files.assertOwners(files.homeDir)
    } }
  }

  getTaskAttachmentBindingLease() {
    this.getDatabaseBindingLease()
    const services = this.services!, { db: database, agents: manager, taskAttachmentFiles: files } = services, attachmentRoot = this.bootstrap.paths.attachmentRoot
    const native = this.bootstrap.native, openAttachment = native.openAttachment, downloadAttachment = native.downloadAttachment
    return { database, manager, files, attachmentRoot,
      ...(openAttachment ? { openAttachment: async (receipt: AttachmentPathReceipt, caller: DesktopCallerContext, signal: AbortSignal): Promise<void> => {
        this.getDatabaseBindingLease()
        if (signal.aborted || !isUiLeaseId(caller.uiLeaseId) || this.bootstrap.native !== native || native.openAttachment !== openAttachment) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
        await this.own(openAttachment.call(native, receipt, caller.uiLeaseId))
        this.getDatabaseBindingLease()
        if (signal.aborted || this.bootstrap.native !== native || native.openAttachment !== openAttachment) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
      } } : {}),
      ...(downloadAttachment ? { downloadAttachment: async (receipt: AttachmentPathReceipt, caller: DesktopCallerContext, signal: AbortSignal, beforeEffect: () => void): Promise<void> => {
        this.getDatabaseBindingLease()
        if (signal.aborted || !isUiLeaseId(caller.uiLeaseId) || this.bootstrap.native !== native || native.downloadAttachment !== downloadAttachment) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
        const current = (): void => {
          beforeEffect(); this.getDatabaseBindingLease()
          if (signal.aborted || this.bootstrap.native !== native || native.downloadAttachment !== downloadAttachment) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
        }
        current(); await this.own(downloadAttachment.call(native, receipt, caller.uiLeaseId, current))
        this.getDatabaseBindingLease()
        if (signal.aborted || this.bootstrap.native !== native || native.downloadAttachment !== downloadAttachment) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
      } } : {}),
      onTaskUpdated: (taskId: string, attachments: FileAttachmentRecord[]): void => { this.emit('task:updated', { taskId, updates: { attachments } }) },
      assertTaskAttachmentOwners: (owners: { database: DatabaseManager; manager: AgentManager; files: TaskAttachmentFileOwner; attachmentRoot: string }): void => {
        this.getDatabaseBindingLease()
        if (this.services !== services || this.bootstrap.native !== native || native.openAttachment !== openAttachment || native.downloadAttachment !== downloadAttachment || services.db !== database || services.agents !== manager || services.taskAttachmentFiles !== files || owners.database !== database || owners.manager !== manager || owners.files !== files || owners.attachmentRoot !== attachmentRoot) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
        files.assertOwners(attachmentRoot)
      } }
  }

  getTaskGroupBindingLease() {
    this.getDatabaseBindingLease()
    const services = this.services!, { db: database, groups, agents: manager, sync, registry: plugins, oauth } = services
    return { database, groups, manager, sync, plugins, oauth,
      assertTaskGroupOwners: (owners: { database: DatabaseManager; groups: TaskGroupService; manager: AgentManager; sync: SyncManager; plugins: PluginRegistry; oauth: OAuthManager }): void => {
        this.getDatabaseBindingLease()
        if (this.services !== services || services.db !== database || services.groups !== groups || services.agents !== manager || services.sync !== sync ||
          owners.database !== database || owners.groups !== groups || owners.manager !== manager || owners.sync !== sync || services.registry !== plugins || services.oauth !== oauth || owners.plugins !== plugins || owners.oauth !== oauth) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
        groups.assertOwners({ database, manager, sync }); sync.assertOwners(database, plugins, oauth)
      } }
  }

  getProjectRuntimeBindingLease() {
    this.getDatabaseBindingLease()
    const services = this.services!, { db: database, agents: manager, workspaceFiles: files } = services, workspaceRoot = this.bootstrap.paths.workspaceRoot
    return { database, manager, files, workspaceRoot,
      assertProjectRuntimeOwners: (owners: { database: DatabaseManager; manager: AgentManager; files: WorkspaceFileOwner; workspaceRoot: string }): void => {
        this.getDatabaseBindingLease()
        if (this.services !== services || services.db !== database || services.agents !== manager || services.workspaceFiles !== files ||
          owners.database !== database || owners.manager !== manager || owners.files !== files || owners.workspaceRoot !== workspaceRoot) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
        files.assertOwners(workspaceRoot)
      } }
  }

  getHeartbeatBindingLease() {
    this.getDatabaseBindingLease()
    const services = this.services!, { db: database, agents: manager, heartbeat, heartbeatFiles: files } = services, workspaceRoot = this.bootstrap.paths.workspaceRoot
    return { database, manager, heartbeat, files, workspaceRoot,
      assertHeartbeatOwners: (owners: { database: DatabaseManager; manager: AgentManager; heartbeat: HeartbeatSchedulerCore; files: HeartbeatFileOwner; workspaceRoot: string }): void => {
        this.getDatabaseBindingLease()
        if (this.services !== services || services.db !== database || services.agents !== manager || services.heartbeat !== heartbeat || services.heartbeatFiles !== files ||
          owners.database !== database || owners.manager !== manager || owners.heartbeat !== heartbeat || owners.files !== files || owners.workspaceRoot !== workspaceRoot) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
        files.assertOwners(workspaceRoot); heartbeat.assertOwners({ database, manager, files, workspaceRoot })
      } }
  }

  getWorktreeRuntimeBindingLease() {
    this.getDatabaseBindingLease()
    const services = this.services!, { db: database, agents: manager, sync, registry: plugins, oauth, worktrees, gitProviderProcess: processOwner, github, gitlab, forgejo, cleanup, workspaceFiles: files } = services
    const workspaceRoot = this.bootstrap.paths.workspaceRoot, reposRoot = this.bootstrap.paths.reposRoot
    return { database, manager, sync, worktrees, processOwner, github, gitlab, forgejo, cleanup, files, workspaceRoot, reposRoot,
      assertIdleWorkspace: (taskId: string, path: string) => this.workspaceProcesses!.assertIdleWorkspace(taskId, path),
      runWorkspaceCleanupMutation: <T>(ids: string[], effect: () => Promise<T>, beforeEffect: () => void, signal: AbortSignal, absentIds: readonly string[] = []): Promise<T> => {
        const current = (): void => { beforeEffect(); this.assertWorkspaceCleanupTasksIdle(manager, database, ids, absentIds); this.assertWorkspaceCleanupUsersIdle(services, ids) }
        return manager.withWorkspaceCleanupExclusion(ids, () => this.workspaceProcesses!.run(ids, effect, current, signal), () => this.workspaceProcesses!.inflightCount === 0)
      },
      beforeWorkspaceMutation: (taskIds: readonly string[]): void => {
        this.getDatabaseBindingLease()
        this.workspaceProcesses!.assertOtherWorkAllowed()
        if (files.inflightCount || services.heartbeatFiles.inflightCount || taskIds.some(id => services.heartbeat.hasTaskOwnership(id))) throw new ProductionOwnerError('WORKSPACE_BUSY')
      },
      assertWorktreeRuntimeOwners: (owners: { database: DatabaseManager; manager: AgentManager; sync: SyncManager; worktrees: WorktreeManager; processOwner: GitProviderProcessOwner; github: GitHubManager; gitlab: GitLabManager; forgejo: ForgejoManager; cleanup: WorkspaceCleanupSchedulerCore; files: WorkspaceFileOwner; workspaceRoot: string; reposRoot: string }): void => {
        this.getDatabaseBindingLease()
        if (this.services !== services || services.db !== database || services.agents !== manager || services.sync !== sync || services.worktrees !== worktrees || services.gitProviderProcess !== processOwner || services.github !== github || services.gitlab !== gitlab || services.forgejo !== forgejo || services.cleanup !== cleanup || services.workspaceFiles !== files ||
          owners.database !== database || owners.manager !== manager || owners.sync !== sync || owners.worktrees !== worktrees || owners.processOwner !== processOwner || owners.github !== github || owners.gitlab !== gitlab || owners.forgejo !== forgejo || owners.cleanup !== cleanup || owners.files !== files || owners.workspaceRoot !== workspaceRoot || owners.reposRoot !== reposRoot) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
        if (services.registry !== plugins || services.oauth !== oauth) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
        sync.assertOwners(database, plugins, oauth); files.assertOwners(workspaceRoot); worktrees.assertOwners(reposRoot, workspaceRoot, forgejo); processOwner.assertOpen(); github.assertOwners(processOwner); gitlab.assertOwners(processOwner); forgejo.assertOwners(processOwner)
      } }
  }

  /** Bounded scheduled repo binding; the manual route obtains the same facts
   * through its per-caller TaskWorkspaceScopeReader. Retain exact snapshots. */
  private captureCleanupRepositories(database: DatabaseManager, ids: readonly string[], absentIds: readonly string[] = []) {
    const read = () => {
      const table = (name: 'projects' | 'project_repos', fields: Record<string, number>, where: string, params: readonly string[], maximum: number) => {
        const lengths = Object.entries(fields).map(([field, max]) => ({ bytes: `COALESCE(length(CAST(${field} AS BLOB)),0)`, max }))
        const stats = database.db.prepare(`SELECT COUNT(*) AS count,COALESCE(MAX(${lengths.map(value => `(${value.bytes}>${value.max})`).join(' OR ')}),0) AS oversized,COALESCE(SUM(${lengths.map(value => value.bytes).join('+')}),0) AS bytes FROM ${name} WHERE ${where}`).get(...params) as { count: number; oversized: number; bytes: number }
        if (stats.count > maximum || stats.oversized || stats.bytes >= 890000) throw new Error('WORKSPACE_CLEANUP_DATA_LIMIT')
        return database.db.prepare(`SELECT ${Object.keys(fields).join(',')} FROM ${name} WHERE ${where} ORDER BY id`).all(...params) as Array<Record<string, unknown>>
      }
      const tasks = createBoundedWorkspaceCleanupStore(database, () => {}).getTasks({ includeCoordinators: true }).filter(task => ids.includes(task.id))
      if (absentIds.some(id => !ids.includes(id) || tasks.some(task => task.id === id)) || tasks.length + new Set(absentIds).size !== ids.length) throw new Error('WORKSPACE_CLEANUP_SCOPE_CHANGED')
      const projectIds = [...new Set(tasks.map(task => task.project_id))], slots = projectIds.map(() => '?').join(',')
      const projects = table('projects', { id: 128, git_provider: 32, git_org: 512 }, `id IN (${slots})`, projectIds, 128)
      const repos = table('project_repos', { id: 128, project_id: 128, provider: 32, org: 512, name: 128, default_branch: 1024 }, `project_id IN (${slots})`, projectIds, 128)
      const store = createBoundedWorkspaceCleanupStore(database, () => {})
      const settings = Object.fromEntries(['git_provider', 'github_org', 'repo_providers'].map(key => [key, store.getSetting(key)]))
      return { tasks, projects, repos, settings }
    }
    const captured = read(), snapshot = JSON.stringify(captured)
    const groups = new Map<string, Array<{ org: string; repos: { fullName: string }[] }>>()
    for (const task of captured.tasks) {
      const resolved = resolveTaskRepos({ getProject: id => captured.projects.find(row => row.id === id) as unknown as ReturnType<DatabaseManager['getProject']>,
        getProjectRepos: id => captured.repos.filter(row => row.project_id === id) as unknown as ReturnType<DatabaseManager['getProjectRepos']>,
        getSetting: key => captured.settings[key] }, task)
      if (resolved.length !== task.repos.length || new Set(resolved.map(repo => repo.name)).size !== resolved.length) throw new Error('WORKSPACE_CLEANUP_REPOSITORY_AUTHORITY_UNAVAILABLE')
      groups.set(task.id, resolved.map(repo => ({ org: repo.org, repos: [{ fullName: repo.fullName }] })))
    }
    return { current: (): void => { if (JSON.stringify(read()) !== snapshot) throw new Error('WORKSPACE_CLEANUP_SCOPE_CHANGED') },
      getRepoGroups: (id: string) => { const value = groups.get(id); if (!value) throw new Error('WORKSPACE_CLEANUP_SCOPE_CHANGED'); return value } }
  }

  private assertWorkspaceCleanupTasksIdle(manager: AgentManager, database: DatabaseManager, ids: readonly string[], absentIds: readonly string[] = []): void {
    const columns: string[] = []
    for (const row of database.db.prepare('PRAGMA table_info(tasks)').iterate() as Iterable<{ name: string }>) {
      if (columns.length >= 256 || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.name)) throw new Error('WORKSPACE_CLEANUP_DATA_INVALID')
      columns.push(`COALESCE(length(CAST("${row.name}" AS BLOB)),0)`)
    }
    for (const id of ids) {
      // Existing lifecycle/session helpers load the legacy full row. Bound it
      // before handing control to those owners, including repeated rechecks.
      const row = database.db.prepare(`SELECT status,agent_id,${columns.join('+')} AS bytes FROM tasks WHERE id=?`).get(id) as { status: string; agent_id: string | null; bytes: number } | undefined
      if (absentIds.includes(id)) {
        if (row) throw new Error('WORKSPACE_CLEANUP_SCOPE_CHANGED')
        if (manager.hasTaskStartOwnership(id) || manager.findSessionByTaskId(id)) throw new ProductionOwnerError('WORKSPACE_CLEANUP_BUSY')
        continue
      }
      if (!row || row.bytes > 128000) throw new Error('WORKSPACE_CLEANUP_DATA_LIMIT')
      if (row.agent_id && database.db.prepare('SELECT 1 FROM agents WHERE id=? AND length(CAST(config AS BLOB))>128000').get(row.agent_id)) throw new Error('WORKSPACE_CLEANUP_DATA_LIMIT')
      if (['agent_working', 'agent_learning', 'triaging'].includes(row.status) || manager.hasTaskStartOwnership(id) || manager.findSessionByTaskId(id)) throw new ProductionOwnerError('WORKSPACE_CLEANUP_BUSY')
    }
  }

  private assertWorkspaceCleanupUsersIdle(services: ProductionServices, ids: readonly string[]): void {
    this.getDatabaseBindingLease()
    if (this.services !== services || services.workspaceFiles.inflightCount || services.heartbeatFiles.inflightCount ||
      this.workspaceTerminalUsers.size || ids.some(id => services.heartbeat.hasTaskOwnership(id))) throw new ProductionOwnerError('WORKSPACE_CLEANUP_BUSY')
  }

  getUiBindingLease(): { ui: ProductionUiOwner; database: DatabaseManager; manager: AgentManager; assertUiOwners(owners: { ui: ProductionUiOwner; database: DatabaseManager; manager: AgentManager }): void } | null {
    this.getDatabaseBindingLease()
    const services = this.services!, ui = services.ui
    if (!ui) return null
    return { ui, database: services.db, manager: services.agents, assertUiOwners: owners => {
      this.getDatabaseBindingLease()
      if (this.services !== services || owners.ui !== ui || owners.database !== services.db || owners.manager !== services.agents) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
      assertTaskApiUiOwner(ui); ui.assertOwners(owners)
    } }
  }

  getIntegrationBindingLease(): { secretStorage: AuthenticatedSecretStorage; configuredMcp: 'enabled' | 'disabled'; oauthBrowser: 'available' | 'unavailable'; assertOwners(owners: {
    database: DatabaseManager; manager?: AgentManager; sync?: SyncManager; plugins?: PluginRegistry; probes?: McpProbeService; secretStorage?: unknown; oauth?: OAuthManager;
    recurrence?: RecurrenceSchedulerCore; heartbeat?: HeartbeatSchedulerCore; automation?: TaskAutomationScheduler
  }): void } {
    this.getDatabaseBindingLease()
    const services = this.services!, storage = this.storage!
    return { secretStorage: storage, configuredMcp: this.bootstrap.native.agents.configuredMcp,
      oauthBrowser: this.bootstrap.native.oauthBrowser ?? 'unavailable', assertOwners: owners => {
        this.getDatabaseBindingLease()
        if (this.services !== services || this.storage !== storage || owners.database !== services.db ||
          owners.manager !== undefined && owners.manager !== services.agents || owners.sync !== undefined && owners.sync !== services.sync ||
          owners.plugins !== undefined && owners.plugins !== services.registry || owners.probes !== undefined && owners.probes !== services.mcpProbes ||
          owners.secretStorage !== undefined && owners.secretStorage !== storage || owners.oauth !== undefined && owners.oauth !== services.oauth ||
          owners.recurrence !== undefined && owners.recurrence !== services.recurrence || owners.heartbeat !== undefined && owners.heartbeat !== services.heartbeat ||
          owners.automation !== undefined && owners.automation !== services.automation)
          throw new ProductionOwnerError('SERVICE_OWNER_LOST')
      } }
  }

  getConnectorBindingLease(): { runtime: ConnectorRuntime; service: ConnectorBridgeService; engine: ReturnType<ConnectorBridgeCore['engineFor']>; credentialStore: ConnectorRuntime['credentialStore']; secretStorage: AuthenticatedSecretStorage; oauthBrowser: 'available' | 'unavailable'; assertConnectorOwners(owners: {
    database: DatabaseManager; sync: SyncManager; service: ConnectorBridgeService; runtime: ConnectorRuntime; engine: ReturnType<ConnectorBridgeCore['engineFor']>; credentialStore: ConnectorRuntime['credentialStore']; secretStorage: unknown
  }): void } | null {
    this.getDatabaseBindingLease()
    const services = this.services!, runtime = this.connectorRuntime, service = this.connectorService, connector = this.connector, storage = this.storage!
    if (!runtime || !service || !connector) return null
    const engine = connector.engineFor(services.db)
    return { runtime, service, engine, credentialStore: runtime.credentialStore, secretStorage: storage,
      oauthBrowser: runtime.credentials.usesNativeFlows ? 'available' : 'unavailable', assertConnectorOwners: owners => {
        this.getDatabaseBindingLease()
        if (this.services !== services || this.connectorRuntime !== runtime || this.connectorService !== service || this.connector !== connector || this.storage !== storage ||
          owners.database !== services.db || owners.sync !== services.sync || owners.service !== service || owners.runtime !== runtime || owners.engine !== engine ||
          owners.credentialStore !== runtime.credentialStore || owners.secretStorage !== storage || connector.engineFor(services.db) !== engine)
          throw new ProductionOwnerError('SERVICE_OWNER_LOST')
        connector.assertSourceLifecycle(services.sync)
      } }
  }

  getSessionContextBindingLease(): { context: SessionContextService; assertOwners(owners: { database: DatabaseManager; context: SessionContextService }): void } {
    this.getDatabaseBindingLease()
    const services = this.services!, context = services.sessionContext
    return { context, assertOwners: owners => {
      this.getDatabaseBindingLease()
      if (this.services !== services || owners.database !== services.db || owners.context !== context || services.sessionContext !== context)
        throw new ProductionOwnerError('SERVICE_OWNER_LOST')
      context.assertSource(services.db)
    } }
  }

  getClaudePluginBindingLease(): { assertPluginOwners(owners: { database: DatabaseManager; manager: ClaudePluginManager; agents: AgentManager; sync: SyncManager }): void } {
    this.getDatabaseBindingLease()
    const services = this.services!
    return { assertPluginOwners: owners => {
      this.getDatabaseBindingLease()
      if (this.services !== services || owners.database !== services.db || owners.manager !== services.plugins || owners.agents !== services.agents || owners.sync !== services.sync)
        throw new ProductionOwnerError('SERVICE_OWNER_LOST')
      services.plugins.assertSource(services.db)
    } }
  }

  getAgentInstallerBindingLease(): { detection: PortableAgentDetectionOwner; installation?: PortableAgentInstallationOwner; emitProgress?: (progress: DesktopEventMap['agent-installer:progress'], leaseId: string) => Promise<void>; assertOwners(owners: { detection: PortableAgentDetectionOwner; installation?: PortableAgentInstallationOwner }): void } {
    this.getDatabaseBindingLease()
    const services = this.services!, detection = services.agentDetection, installation = services.agentInstallation
    return { detection, ...(installation ? { installation } : {}),
      ...(installation && services.ui && this.bootstrap.native.emitInstallationProgress ? { emitProgress: this.bootstrap.native.emitInstallationProgress.bind(this.bootstrap.native) } : {}), assertOwners: owners => {
      this.getDatabaseBindingLease()
      if (this.services !== services || owners.detection !== detection || owners.installation !== (installation ?? undefined)) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
      detection.assertOpen()
      installation?.assertOwners({ detection, home: installation.home, cwd: this.bootstrap.paths.profileRoot })
    } }
  }

  getArtifactViewerBindingLease() {
    this.getDatabaseBindingLease()
    const native = this.bootstrap.native, bridge = native.artifactViewer
    if (!bridge) return null
    if (['register', 'open', 'retire'].some(key => typeof Reflect.get(bridge, key) !== 'function')) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
    const register = bridge.register, open = bridge.open, retire = bridge.retire
    const captured = Object.freeze({ register: register.bind(bridge), open: open.bind(bridge), retire: retire.bind(bridge) })
    return { native: captured, assertAvailable: (): void => {
      this.getDatabaseBindingLease()
      if (this.bootstrap.native !== native || native.artifactViewer !== bridge || bridge.register !== register || bridge.open !== open || bridge.retire !== retire) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
    } }
  }
  getArtifactBindingLease() {
    this.getDatabaseBindingLease()
    const services = this.services!, workspaceRoot = this.bootstrap.paths.workspaceRoot, files = services.workspaceFiles
    const native = this.bootstrap.native, copyArtifact = native.copyArtifact
    const current = (): void => {
      this.getDatabaseBindingLease()
      if (this.services !== services || services.workspaceFiles !== files || this.bootstrap.native !== native || native.copyArtifact !== copyArtifact || this.databaseRuntime?.paths.workspaceRoot !== workspaceRoot) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
      files.assertOwners(workspaceRoot)
    }
    return { workspaceRoot, files,
      ...(copyArtifact ? { copyArtifact: async (receipt: WorkspacePathReceipt, caller: DesktopCallerContext, signal: AbortSignal, beforeEffect: () => void): Promise<ArtifactCopyFileResult> => {
        const guard = (): void => { current(); beforeEffect(); if (signal.aborted || !isUiLeaseId(caller.uiLeaseId)) throw new ProductionOwnerError('SERVICE_OWNER_LOST') }
        guard(); const result = await this.own(copyArtifact.call(native, receipt, caller.uiLeaseId!, guard)); guard(); return result
      } } : {}),
      assertArtifactOwners: (database: DatabaseManager, actualRoot: string, actualFiles?: WorkspaceFileOwner): void => {
        current()
        if (database !== services.db || actualRoot !== workspaceRoot || actualFiles !== undefined && actualFiles !== files) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
      } }
  }

  getMobileBindingLease(): { deps: MobileApiDeps; tunnel: TunnelManagerCore | null; port?: number; lanAddress(): string; assertMobileOwners(deps: MobileApiDeps, tunnel: TunnelManagerCore | null): void } | null {
    this.getDatabaseBindingLease()
    const mobile = this.mobile, services = this.services!
    if (!mobile) return null
    const deps = mobile.deps, tunnel = mobile.tunnel
    return { deps, tunnel, port: mobile.port, lanAddress: () => {
      for (const entries of Object.values(networkInterfaces())) for (const address of entries ?? []) if (address.family === 'IPv4' && !address.internal) return address.address
      return 'localhost'
    }, assertMobileOwners: (actual, actualTunnel) => {
      this.getDatabaseBindingLease()
      if (this.mobile !== mobile || this.services !== services || actualTunnel !== tunnel || actual.db !== services.db || actual.agentManager !== services.agents || actual.syncManager !== services.sync || actual.pluginRegistry !== services.registry || actual.taskOwners?.recurrence !== services.recurrence || actual.taskOwners?.heartbeat !== services.heartbeat || actual.taskOwners?.automation !== services.automation ||
        Object.keys(deps).some(key => Reflect.get(actual, key) !== Reflect.get(deps, key))) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
      assertMobileApiDeps(deps)
    } }
  }

  runCredentialMutation<T>(input: ProductionCredentialMutation, mutation: () => T | Promise<T>): Promise<T> {
    return this.run(async services => {
      // Both reservations are synchronous. No new turn can enter while another
      // owner's accepted provider/tool work is being awaited.
      const leases: Array<{ drain(): Promise<void>; release(): void }> = []
      try {
        if (input.kind === 'provider-key' || input.kind === 'plugin-resources') {
          leases.push(this.providers.beginMutation())
          leases.push(services.chat.beginProviderConfigurationMutation())
          leases.push(services.commander.beginProviderConfigurationMutation())
          leases.push(services.coordination.beginProviderConfigurationMutation())
        }
        return await services.agents.runProductionCredentialMutation(input, async () => {
          await Promise.all(leases.map(lease => lease.drain()))
          this.getDatabaseBindingLease()
          return mutation()
        })
      } finally { for (const lease of leases.reverse()) lease.release() }
    })
  }

  /** Register a real request backend's fence/drain synchronously while ready.
   * There is deliberately no unregister operation that can abandon raw work. */
  retainCleanup(name: string, stop: () => void, drain: () => Promise<void>): void {
    this.getDatabaseBindingLease()
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(name) || this.drains.has(`binding:${name}`)) throw new ProductionOwnerError('OWNER_BINDING_INVALID')
    this.register(`binding:${name}`, stop, drain)
  }

  private own<T>(raw: Promise<T>): Promise<T> {
    this.rawWork.add(raw)
    void raw.then(() => this.rawWork.delete(raw), () => this.rawWork.delete(raw))
    return raw
  }

  private update(phase: ProductionOwnerPhase, stage: string, code?: string): void {
    this.phase = phase; this.stage = stage; this.code = code; this.sequence++
    try { this.bootstrap.onState?.(this.snapshot()) } catch { /* observer cannot alter ownership */ }
  }

  private assertStarting(): void {
    if (this.abort.signal.aborted || this.phase !== 'starting') throw new ProductionOwnerError('OWNER_CLOSING')
    this.lock?.assertHeld()
  }

  private checkpoint(stage: string): void { this.assertStarting(); this.update('starting', stage) }

  private async initialize(): Promise<void> {
    this.lock = acquireProfileLock(this.bootstrap.paths.profileRoot)
    const profileRoot = this.lock.profileRoot
    this.checkpoint('resources')
    const space = statfsSync(profileRoot)
    if (Number(space.bavail) * Number(space.bsize) < 8 * 1024 * 1024) throw new ProductionOwnerError('PROFILE_LOW_DISK')
    if (!existsSync(this.bootstrap.paths.resourceRoot) || !statSync(this.bootstrap.paths.resourceRoot).isDirectory()) throw new ProductionOwnerError('RESOURCE_UNAVAILABLE')
    const runtime = this.bootstrap.managedTaskMcp
    if (!('disabled' in runtime)) {
      if (runtime.existingServer?.policy === 'electron-name-refresh') throw new ProductionOwnerError('AMBIGUOUS_MANAGED_MCP_SERVER')
      if (!isAbsolute(runtime.command) || !existsSync(runtime.command) || !runtime.args.length ||
          !isAbsolute(runtime.args[0]) || !existsSync(runtime.args[0])) throw new ProductionOwnerError('MANAGED_MCP_RESOURCE_UNAVAILABLE')
    }
    if (this.bootstrap.connectors.kind === 'enabled' && !this.boundaries.connectorTransport) validateConnectorResources(this.bootstrap.paths.resourceRoot)
    if (this.bootstrap.credentials.mode === 'create' && readdirSync(profileRoot).some(name => !['.21x-profile-lock.sqlite', '.21x-profile-lock.sqlite-journal', '.21x-profile-lock.sqlite-wal', '.21x-profile-lock.sqlite-shm'].includes(name))) {
      throw new ProductionOwnerError('PROFILE_NOT_EMPTY')
    }
    this.checkpoint('native-readiness')
    await this.bootstrap.native.prepareRuntime(this.abort.signal)
    this.assertStarting()
    this.checkpoint('credentials')
    // Assign even on cancelled initialization: late OS-store completion remains owned.
    this.storage = await initializeProtectedSecretStorage(this.bootstrap.credentials.store, this.bootstrap.profileId, this.bootstrap.credentials.mode)
    this.assertStarting()
    configureSecretStorage(this.storage)
    this.storageRegistered = true
    this.checkpoint('database-preflight')
    preflightProfile(join(profileRoot, '21x.db'), this.storage)
    this.checkpoint('database')
    for (const path of [this.bootstrap.paths.workspaceRoot, this.bootstrap.paths.attachmentRoot, this.bootstrap.paths.reposRoot, this.bootstrap.paths.tempRoot]) mkdirSync(path, { recursive: true })
    this.databaseRuntime = { paths: { profileRoot, workspaceRoot: this.bootstrap.paths.workspaceRoot, attachmentRoot: this.bootstrap.paths.attachmentRoot }, managedTaskMcp: runtime, attachmentDeletion: 'retain' }
    this.db = new DatabaseManager(this.databaseRuntime)
    this.db.initialize()
    const db = this.db
    reconcileProductionRestart(db)
    db.onTaskActivity = (taskId, last_activity_at) => this.emit('task:updated', { taskId, updates: { last_activity_at } })
    this.checkpoint('secret-broker')
    this.broker = new SecretBroker(db)
    this.stopOwners.push(() => this.broker?.shutdown())
    this.drains.set('secret-broker', () => this.broker!.close())
    await this.broker.start()
    this.assertStarting()
    const shellWrapper = writeSecretShellWrapper(profileRoot)
    this.checkpoint('task-api')
    const apiStartup = startTaskApiServer(db, { notifyUser: (title, body) => this.notify(title, body), attachmentMetadata: 'unavailable' })
    this.apiOwned = true
    this.stopOwners.push(() => stopTaskApiServer())
    this.drains.set('task-api', () => closeTaskApiServer())
    await apiStartup
    this.assertStarting()
    const installationBootstrap = this.boundaries.agentInstallation ?? this.bootstrap.agentInstallation
    const managedPrefix = join(profileRoot, 'agent-cli')
    if (installationBootstrap) {
      const previous = process.env.PATH
      const installed = [join(managedPrefix, 'bin'), dirname(installationBootstrap.nodeExecutable), ...(previous ?? '').split(delimiter).filter(path => isAbsolute(path))].join(delimiter)
      process.env.PATH = installed; this.ownedPath = { previous, installed }
    }
    const native = this.bootstrap.native
    const workspaceProcesses = new ProductionWorkspaceProcessOwner(this.bootstrap.paths.workspaceRoot,
      native.workspaceCleanup ? native.workspaceCleanup.observe.bind(native.workspaceCleanup) : undefined)
    this.workspaceProcesses = workspaceProcesses
    this.register('workspace-processes', () => workspaceProcesses.shutdown(), () => workspaceProcesses.close())
    const energy = native.energy ? new ProductionEnergyOwner({
      assertCurrent: () => {
        if (!this.lock || processRegistry[registryKey] !== this.identity || !['starting', 'ready', 'stopping', 'blocked'].includes(this.phase)) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
        this.lock.assertHeld()
      },
      setActive: native.energy.setActive.bind(native.energy)
    }) : null
    if (energy) this.register('native-energy', () => energy.shutdown(), () => energy.close())
    const providerFactory = this.boundaries.createProvider ?? createChatProviderFromSettings
    const provider: typeof createChatProviderFromSettings = (...args) => this.providers.wrap(providerFactory(...args))
    this.register('providers', () => this.providers.shutdown(), () => this.providers.drain())
    const broker = this.broker
    const adapters = new ProductionAdapters()
    this.register('adapters', () => adapters.shutdown(), () => adapters.close())
    const factory = this.boundaries.createAdapter ?? createAdapter
    const attachmentExecution: { owner?: AttachmentExecutionOwner } = {}
    const ownedAttachmentExecution = (): AttachmentExecutionOwner => {
      if (!attachmentExecution.owner) throw new AttachmentExecutionError('ATTACHMENT_EXECUTION_UNAVAILABLE')
      return attachmentExecution.owner
    }
    const host: AgentManagerHost = {
      ...native.agents,
      attachmentExecution: Object.freeze({
        sync: (...args: Parameters<AttachmentExecutionOwner['sync']>) => ownedAttachmentExecution().sync(...args),
        context: (...args: Parameters<AttachmentExecutionOwner['context']>) => ownedAttachmentExecution().context(...args)
      }),
      ...(energy ? { energy: energy.host } : {}),
      secrets: { kind: 'broker', getPort: () => broker.port, register: (token, agentId, ids) => broker.register(token, agentId, ids),
        unregister: token => broker.unregister(token), writeShellWrapper: () => shellWrapper },
      managedTaskMcp: 'disabled' in runtime ? { kind: 'disabled' } : {
        kind: 'server', waitUntilReady: waitForTaskApiServer,
        buildConfig: options => {
          const port = getTaskApiPort()
          return port ? { type: 'http', url: buildTaskMcpUrl(port, getTaskApiToken(), { taskId: options?.taskId ?? options?.taskScope?.taskId, parentTaskId: options?.taskScope?.parentTaskId, projectId: options?.taskScope ? undefined : options?.projectId, artifactTaskId: options?.artifactTaskId, agentId: options?.agentId, sessionNonce: options?.sessionNonce }) } : null
        }
      },
      createAdapter: (type, source) => adapters.wrap(factory(type, source)),
      isCodexAppServerAdapter,
      captainSummaryProvider: source => provider(source)
    }
    this.checkpoint('services')
    const agents = new AgentManager(db, host)
    // Register each newly constructed owner immediately; any later failure drains it.
    this.stopOwners.push(() => { void this.own(agents.stopAllSessions()).catch(() => undefined) })
    this.drains.set('agents', async () => { await agents.stopAllSessions(); await agents.stopServer() })
    agents.addExternalListener((channel, data) => this.emit(channel, data))
    const releaseActivity = agents.addActivityListener(data => {
      if (this.abort.signal.aborted) return
      // Freshness goes only to the trusted desktop event path, never mobile or
      // general status listeners that treat a push as a lifecycle transition.
      try { native.emit('agent:status', data) } catch { /* Desktop attachment is optional. */ }
    })
    this.register('agent-activity', releaseActivity, async () => { releaseActivity() })
    const gitProviders = createProductionGitProviderOwner({ database: db, profileRoot, reposRoot: this.bootstrap.paths.reposRoot, workspaceRoot: this.bootstrap.paths.workspaceRoot, tempRoot: this.bootstrap.paths.tempRoot,
      createProcess: this.boundaries.gitProviderProcess, assertCurrent: () => {
        if (this.abort.signal.aborted || !['starting', 'ready'].includes(this.phase) || processRegistry[registryKey] !== this.identity) throw new ProductionOwnerError('OWNER_CLOSING')
        this.lock!.assertHeld()
      } })
    const { github, gitlab, forgejo, processOwner: gitProviderProcess } = gitProviders
    this.register('git-provider-process', () => gitProviderProcess.stop(), () => gitProviderProcess.close())
    const worktrees = new WorktreeManager({ reposRoot: this.bootstrap.paths.reposRoot, workspaceRoot: this.bootstrap.paths.workspaceRoot,
      portableLimits: WORKTREE_PORTABLE_LIMITS,
      exec: gitProviders.exec, assertPath: path => { workspaceProcesses.assertOtherWorkAllowed(); gitProviders.assertPath(path) },
      beforeCleanupEffect: async id => {
        if (workspaceProcesses.ownsCurrentScope) await workspaceProcesses.assertIdleWorkspace(id, join(this.bootstrap.paths.workspaceRoot, id))
      },
      onWorktreeRemoved: (path, identity) => gitProviderProcess.retireWorktreeDirectory(path, identity),
      onTaskWorkspaceRemoved: (id, identity) => { workspaceFiles.retireWorkspace(id, identity); heartbeatFiles.retireWorkspace(id, identity); gitProviderProcess.retireWorktreeDirectory(join(this.bootstrap.paths.workspaceRoot, id), identity) }, emitProgress: data => this.emit('worktree:progress', data) })
    worktrees.setForgejoManager(forgejo)
    agents.setManagers(github, worktrees, gitlab, forgejo)
    this.register('worktrees', () => worktrees.shutdown(), () => worktrees.close())
    const fileOptions: WorkspaceFileOwnerOptions = { workspaceRoot: this.bootstrap.paths.workspaceRoot,
      native: { ...(native.openPath ? { openPath: native.openPath.bind(native) } : {}), ...(native.showItemInFolder ? { showItemInFolder: native.showItemInFolder.bind(native) } : {}) },
      assertCurrent: () => {
        if (this.abort.signal.aborted || !['starting', 'ready'].includes(this.phase) || processRegistry[registryKey] !== this.identity) throw new ProductionOwnerError('OWNER_CLOSING')
        workspaceProcesses.assertOtherWorkAllowed()
        this.lock!.assertHeld()
      } }
    const workspaceFiles = this.boundaries.workspaceFiles ? this.boundaries.workspaceFiles(fileOptions) : new WorkspaceFileOwner(fileOptions)
    if (!(workspaceFiles instanceof WorkspaceFileOwner)) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
    workspaceFiles.assertOwners(this.bootstrap.paths.workspaceRoot)
    this.register('workspace-files', () => workspaceFiles.shutdown(), () => workspaceFiles.close())
    const heartbeatFileOptions: HeartbeatFileOwnerOptions = { workspaceRoot: this.bootstrap.paths.workspaceRoot, assertCurrent: fileOptions.assertCurrent }
    const heartbeatFiles = this.boundaries.heartbeatFiles ? this.boundaries.heartbeatFiles(heartbeatFileOptions) : new HeartbeatFileOwner(heartbeatFileOptions)
    if (!(heartbeatFiles instanceof HeartbeatFileOwner)) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
    heartbeatFiles.assertOwners(this.bootstrap.paths.workspaceRoot)
    this.register('heartbeat-files', () => heartbeatFiles.shutdown(), () => heartbeatFiles.close())
    const oauth = new OAuthManager(db, { openExternal: url => native.openExternal(url), notify: (title, body) => this.notify(title, body) })
    agents.setOAuthManager(oauth)
    this.register('oauth', () => oauth.destroy(), () => oauth.close())
    const probeEnvironment = Object.freeze({ PATH: process.env.PATH ?? '', HOME: profileRoot, USERPROFILE: profileRoot,
      TMPDIR: this.bootstrap.paths.tempRoot, TEMP: this.bootstrap.paths.tempRoot,
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}) })
    const mcpProbes = new McpProbeService({
      spawn: (command, args, options) => spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }),
      fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
      // Explicit user MCP variables are added by the probe only after domain
      // authorization. No launch token, provider key or full parent env leaks.
      environment: () => ({ ...probeEnvironment }),
      taskApiEnvironment: () => ({}), platform: process.platform
    })
    this.register('mcp-probes', () => mcpProbes.shutdown(), () => mcpProbes.close())
    const cliBoundary = this.boundaries.cliMcp
    const cliHome = cliBoundary?.homeDir ?? realpathSync(homedir())
    const privateEnvironment = /^(?:TASK_API_|TASK_MCP_|TWENTYONEX_|21X_|SECRET_BROKER_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$|LD_|DYLD_)/i
    const cliEnvironment = Object.freeze(Object.fromEntries(Object.entries(cliBoundary?.environment ?? process.env).filter(([key]) => !privateEnvironment.test(key))))
    const cliOptions: CliMcpFileOwnerOptions = { homeDir: cliHome, env: cliEnvironment, assertCurrent: fileOptions.assertCurrent }
    const cliMcpFiles = cliBoundary?.files ? cliBoundary.files(cliOptions) : new CliMcpFileOwner(cliOptions)
    if (!(cliMcpFiles instanceof CliMcpFileOwner)) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
    cliMcpFiles.assertOwners(cliHome)
    this.register('cli-mcp-files', () => cliMcpFiles.shutdown(), () => cliMcpFiles.close())
    const cliMcp = new CliMcpConfigManager({ files: cliMcpFiles, homeDir: cliHome, env: cliEnvironment, probeService: mcpProbes })
    this.register('cli-mcp', () => cliMcp.shutdown(), () => cliMcp.close())
    const attachmentOptions: TaskAttachmentFileOwnerOptions = { attachmentRoot: this.bootstrap.paths.attachmentRoot, assertCurrent: () => {
      // Retirement retains this profile lease after new work is fenced.
      if (!['starting', 'ready', 'stopping', 'blocked'].includes(this.phase) || processRegistry[registryKey] !== this.identity) throw new ProductionOwnerError('OWNER_CLOSING')
      this.lock!.assertHeld()
    } }
    const attachmentJournal = new TaskAttachmentJournal({ database: db.db, profileId: this.bootstrap.profileId,
      attachmentRoot: attachmentOptions.attachmentRoot, assertCurrent: attachmentOptions.assertCurrent })
    attachmentOptions.journal = attachmentJournal
    const taskAttachmentFiles = this.boundaries.taskAttachmentFiles ? this.boundaries.taskAttachmentFiles(attachmentOptions) : new TaskAttachmentFileOwner(attachmentOptions)
    if (!(taskAttachmentFiles instanceof TaskAttachmentFileOwner)) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
    taskAttachmentFiles.assertOwners(this.bootstrap.paths.attachmentRoot, attachmentJournal)
    this.register('task-attachment-files', () => taskAttachmentFiles.shutdown(), () => taskAttachmentFiles.close())
    attachmentExecution.owner = new AttachmentExecutionOwner({ database: db, files: taskAttachmentFiles,
      attachmentRoot: this.bootstrap.paths.attachmentRoot, workspaceRoot: this.bootstrap.paths.workspaceRoot, assertCurrent: fileOptions.assertCurrent })
    const capturedAttachmentExecution = attachmentExecution.owner
    this.register('attachment-execution', () => capturedAttachmentExecution.shutdown(), () => capturedAttachmentExecution.close())
    const uiGrants = Object.freeze({ canAccessProject: () => true, canAccessTask: () => true, canAccessAgent: () => true })
    const ui = native.ui ? new ProductionUiOwner({ database: db, manager: agents, native: native.ui,
      assertCurrent: fileOptions.assertCurrent,
      beforeState: state => db.db.transaction(() => assertUiStateReferences(db, state, uiGrants))(),
      beforeCommand: command => db.db.transaction(() => assertUiCommandReferences(db, command, uiGrants))() }) : null
    setTaskApiUiOwner(ui)
    if (ui) this.register('ui', () => ui.shutdown(), () => ui.close())
    const registry = new PluginRegistry()
    for (const plugin of [new LinearPlugin(), new HubSpotPlugin(), new GitHubIssuesPlugin(github), new ForgejoIssuesPlugin(forgejo), new NotionPlugin(), new YouTrackPlugin()]) registry.register(plugin)
    if (this.bootstrap.connectors.kind === 'enabled') {
      const connectorHost: ConnectorRuntimeHost = { openExternal: url => native.openExternal(url),
        ...(native.connectorOAuthFlows ? { nativeFlows: native.connectorOAuthFlows } : {}),
        createTransport: this.boundaries.connectorTransport ?? (() => createPackagedConnectorTransport(this.bootstrap.paths.resourceRoot)) }
      // Construct real credential/OAuth/runtime ownership now, even if no piece is active.
      this.connectorRuntime = getConnectorRuntime(db, connectorHost)
      const runtime = this.connectorRuntime
      this.connectorService = new ConnectorBridgeService(() => {
        if (this.connectorRuntime !== runtime || getConnectorRuntime(db, connectorHost) !== runtime) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
        return runtime
      })
      this.register('connector-runtime', () => disposeConnectorRuntime(db), () => closeConnectorRuntime(db))
      this.connector = new ConnectorBridgeCore({ runtime: source => getConnectorRuntime(source, connectorHost) })
      const connector = this.connector
      registry.register(connector)
      this.register('connector-bridge', () => connector.stopPolling(), () => connector.close())
    } else if (db.getTaskSources().some(source => source.plugin_id === 'connector-bridge')) {
      throw new ProductionOwnerError('CONNECTOR_RESOURCES_REQUIRED')
    }
    const sync = new SyncManager(db, registry, oauth)
    agents.setSyncManager(sync)
    this.register('sync', () => sync.stop(), () => sync.close())
    const groups = new TaskGroupService(db, agents, sync, (channel, data) => this.emit(channel, data))
    this.register('task-groups', () => groups.shutdown(), () => groups.close())
    setTaskApiNotifier((channel, data) => this.emit(channel, data))
    setTranscriptProvider(taskId => agents.getTranscriptForTask(taskId))
    setTaskApiAgentController(agents)
    setTaskApiTaskGroupService(groups)
    configureCaptainGithubTools({ db, mergeDb: db, issueDb: db, notifyUser: (title, body) => this.notify(title, body), notifyRenderer: (channel, data) => this.emit(channel, data) })
    const chat = new ChatRuntime()
    this.register('chat', () => chat.shutdown(), () => chat.close())
    const terminalHost: TerminalProcessHost = this.boundaries.terminalProcessHost ?? {
      resolveShell,
      // The resource-verified staged engine resolves its own physical pinned
      // native module only when a terminal is accepted, never from caller paths.
      create: options => createNodePty(options, createRequire(import.meta.url)('node-pty') as typeof import('node-pty')),
      getCwd: terminalProcessCwd
    }
    const terminals = new TerminalServiceCore({ resolveShell: () => terminalHost.resolveShell(),
      create: options => {
        workspaceProcesses.assertOtherWorkAllowed()
        const token = {}; this.workspaceTerminalUsers.add(token)
        try { return terminalHost.create({ ...options, onExit: (...args) => { this.workspaceTerminalUsers.delete(token); options.onExit(...args) } }) }
        catch (error) { this.workspaceTerminalUsers.delete(token); throw error }
      },
      getCwd: async (pid, current) => {
        workspaceProcesses.assertOtherWorkAllowed()
        const token = {}; this.workspaceTerminalUsers.add(token)
        try { return await terminalHost.getCwd(pid, current) } finally { this.workspaceTerminalUsers.delete(token) }
      } })
    this.register('terminals', () => terminals.shutdown(), () => terminals.close())
    const createChatProvider = () => provider(db)
    const commanderStore = new CommanderStore(db)
    let commander: CommanderService | null = null
    const captainDelivery = new CaptainDeliveryService({ db, agents, onTerminalFailure: (record, reason, timedOut) => {
      if (this.abort.signal.aborted || !commander || !record.sourceSessionId) return
      const { record: report } = captainDelivery.store.enqueue({ idempotencyKey: `captain-request:${record.id}:${timedOut ? 'timeout' : 'failure'}`, kind: 'captain_report',
        sourceSessionId: record.sourceSessionId, projectId: record.projectId, correlationId: record.correlationId,
        payload: timedOut ? 'The Captain did not report back before the deadline. Retry when ready.' : `Your Captain request could not be delivered: ${reason}. Retry when ready.` })
      commander.appendReport({ sessionId: record.sourceSessionId, content: report.payload, projectId: record.projectId, correlationId: record.correlationId, deliveryId: report.id })
    } })
    this.register('captain-delivery', () => captainDelivery.shutdown(), () => captainDelivery.close())
    commander = new CommanderService({ store: commanderStore, createProvider: () => provider(db), emit: event => this.emit('commander:event', event),
      getTools: context => [...createCommanderProjectTools({ db, context, agents, delivery: captainDelivery, sendUiCommand: async command => {
        if (!ui) return native.sendUiCommand(command)
        const result = await ui.send(command)
        return 'error' in result ? { ok: false as const, detail: result.error } : { ok: true as const }
      },
        onProjectChanged: (projectId, kind) => this.emit('project:changed', { projectId, kind }) }),
        ...createCommanderSkillTools({ db, context, onSkillChanged: (skillId, kind) => this.emit('skills:changed', { skillId, kind }) })] })
    const commanderService = commander
    this.register('commander', () => commanderService.shutdown(), () => commanderService.close())
    this.removeReportBridge = installCommanderReportBridge({ service: commander, store: commanderStore, deliveries: captainDelivery.store, getProject: id => db.getProject(id) })
    const plugins = new ClaudePluginManager(db, join(profileRoot, 'plugins'))
    this.register('plugins', () => plugins.shutdown(), () => plugins.close())
    const heartbeatAuthority: HeartbeatTaskAuthority = Object.freeze({ database: db, manager: agents,
      assertAvailable: () => { fileOptions.assertCurrent(); if (!db.db.open || this.services && (this.services.db !== db || this.services.agents !== agents)) throw new ProductionOwnerError('SERVICE_OWNER_LOST') },
      canAccessTask: () => true, canAccessProject: () => true, canAccessAgent: () => true,
      canAccessSkill: () => true, canAccessSecret: () => true, canAccessMcpServer: () => true,
      canAccessSource: () => true, canAccessConnector: () => true })
    const heartbeatCaller = Object.freeze({ principal: 'trusted-desktop-main' as const, engineEpoch: this.epoch, webviewId: 'heartbeat-owner', origin: 'app://heartbeat-owner' })
    const captureHeartbeatBinding = (taskId: string): string => {
      const binding = captureHeartbeatTaskEffects(heartbeatAuthority, taskId, heartbeatCaller)
      // The scheduler separately captures and rechecks the exact instructions
      // through this same file owner before every admitted/background effect.
      return createHash('sha256').update(binding).digest('hex')
    }
    const heartbeat = new HeartbeatSchedulerCore(db, agents, { fileOwner: heartbeatFiles,
      beforeTaskEffect: taskId => { workspaceProcesses.assertOtherWorkAllowed(); assertHeartbeatTaskEffects(heartbeatAuthority, taskId, heartbeatCaller) },
      captureTaskBinding: captureHeartbeatBinding,
      preflightTask: (taskId, content, lastCheck) => {
        const initial = captureHeartbeatTaskEffects(heartbeatAuthority, taskId, heartbeatCaller)
        const beforeEffect = (): void => { if (captureHeartbeatTaskEffects(heartbeatAuthority, taskId, heartbeatCaller) !== initial) throw new ProductionOwnerError('HEARTBEAT_TASK_CHANGED') }
        return gitProviderProcess.withRequestGuard(() => runOwnedPreflightChecks(content, lastCheck, {
          beforeEffect, execute: args => gitProviderProcess.exec('gh', args, { timeout: 15000, maxBuffer: 128 * 1024 }) }), beforeEffect, this.abort.signal)
      } })
    heartbeat.setEventHost({ emit: (channel, data) => this.emit(channel, data), notify: (title, body) => this.notify(title, body) })
    const recurrence = new RecurrenceSchedulerCore(db, undefined, { emit: (channel, data) => this.emit(channel, data) })
    const automation = new TaskAutomationScheduler(db, agents)
    recurrence.setOnInstancesCreated(() => { void automation.runNow() })
    setTaskSchedulers({ recurrence, heartbeat })
    setTaskAutomationTrigger(() => { void automation.runNow() }, automation)
    const wakeups = new CaptainWaker(db, agents)
    const coordination = new ScheduledCoordination({ db, agents, getCommander: () => commanderService, createProvider: () => provider(db), notify: (title, body) => this.notify(title, body),
      getSpeech: () => native.speech?.get() ?? null, canPlayAudio: () => native.speech?.canPlayAudio() ?? false })
    let scheduledRepositories: ReturnType<ProductionOwner['captureCleanupRepositories']> | null = null
    const cleanup = new WorkspaceCleanupSchedulerCore(db, worktrees, { workspacesRoot: this.bootstrap.paths.workspaceRoot,
      portablePolicy: { beforeEffect: fileOptions.assertCurrent, signal: this.abort.signal, store: createBoundedWorkspaceCleanupStore(db, fileOptions.assertCurrent),
        assertIdleWorkspace: (id, path) => workspaceProcesses.assertIdleWorkspace(id, path),
        getRepoGroups: id => { if (!scheduledRepositories) throw new Error('WORKSPACE_CLEANUP_SCOPE_CHANGED'); return scheduledRepositories.getRepoGroups(id) },
        runMutation: async (ids, effect, absentIds = []) => {
          const repositories = this.captureCleanupRepositories(db, ids, absentIds)
          const tasks = createBoundedWorkspaceCleanupStore(db, fileOptions.assertCurrent).getTasks({ includeCoordinators: true }).filter(task => ids.includes(task.id))
          const sources = [...new Set(tasks.map(task => task.source_id).filter((id): id is string => typeof id === 'string'))].sort()
          const current = (): void => {
            fileOptions.assertCurrent(); repositories.current(); this.assertWorkspaceCleanupTasksIdle(agents, db, ids, absentIds)
            if (!this.services) throw new ProductionOwnerError('SERVICE_OWNER_LOST')
            this.assertWorkspaceCleanupUsersIdle(this.services, ids)
          }
          this.assertWorkspaceCleanupTasksIdle(agents, db, ids, absentIds)
          const joined = () => agents.runTaskLifecycleMutation(ids, () => agents.withWorkspaceCleanupExclusion(ids, () => workspaceProcesses.run(ids, async () => {
            scheduledRepositories = repositories
            try { return await gitProviderProcess.withRequestGuard(() => worktrees.withRequestGuard(effect, current, this.abort.signal), current, this.abort.signal) }
            finally { scheduledRepositories = null }
          }, current, this.abort.signal), () => workspaceProcesses.inflightCount === 0))
          const source = (index: number): ReturnType<typeof joined> => index === sources.length ? joined() : sync.runSourceMutation(sources[index]!, () => source(index + 1))
          return source(0)
        } },
      listWorkspaceDirs: () => readdirSync(this.bootstrap.paths.workspaceRoot, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name),
      emit: (channel, data) => this.emit(channel, data) })
    for (const [name, scheduler] of [['heartbeat', heartbeat], ['recurrence', recurrence], ['automation', automation], ['wakeups', wakeups], ['coordination', coordination], ['cleanup', cleanup]] as const) {
      this.register(name, () => scheduler.shutdown(), () => scheduler.close())
    }
    const reminders = new OverdueNotifier(() => this.emit('overdue:check', undefined))
    this.register('reminders', () => reminders.shutdown(), async () => { reminders.shutdown() })
    // Installed CLI probing uses a captured finite host environment. No key,
    // inherited runtime options or renderer-selected command reaches the child.
    const installationBoundary = this.boundaries.agentInstallation
    const detectionHome = installationBoundary?.homeDir ?? realpathSync(homedir())
    const detectionEnvironment: NodeJS.ProcessEnv = {}
    for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
      const value = (installationBoundary?.environment ?? process.env)[key]
      if (value !== undefined) detectionEnvironment[key] = value
    }
    const agentDetection = this.boundaries.agentDetection ?? new PortableAgentDetectionOwner({ environment: Object.freeze(detectionEnvironment), home: detectionHome, cwd: profileRoot,
      ...(installationBootstrap ? { preferredPaths: [join(managedPrefix, 'bin'), dirname(installationBootstrap.nodeExecutable)] } : {}) })
    if (!(agentDetection instanceof PortableAgentDetectionOwner)) throw new ProductionOwnerError('CLI_DETECTION_OWNER_INVALID')
    agentDetection.assertOpen()
    this.register('agent-detection', () => agentDetection.stop(), () => agentDetection.close())
    let agentInstallation: PortableAgentInstallationOwner | null = null
    if (installationBootstrap) {
      const npmCli = installationBoundary?.npmCliPath === null ? null : installationBoundary?.npmCliPath ?? resolveProductionNpmCli(detectionEnvironment)
      const legacyPi = process.env.PI_CODING_AGENT_DIR
      const options: PortableAgentInstallationOwnerOptions = { home: detectionHome, cwd: profileRoot,
        environment: Object.freeze(detectionEnvironment), detection: agentDetection, nodeExecutable: installationBootstrap.nodeExecutable,
        ...(npmCli ? { npm: { cliPath: npmCli, prefix: managedPrefix } } : {}),
        ...(legacyPi ? { legacyPiConfigRoot: resolve(legacyPi) } : {}), assertCurrent: fileOptions.assertCurrent }
      agentInstallation = installationBoundary?.create ? installationBoundary.create(options) : new PortableAgentInstallationOwner(options)
      if (!(agentInstallation instanceof PortableAgentInstallationOwner)) throw new ProductionOwnerError('CLI_INSTALLATION_OWNER_INVALID')
      agentInstallation.assertOwners({ detection: agentDetection, home: detectionHome, cwd: profileRoot })
      const installation = agentInstallation
      this.register('agent-installation', () => installation.shutdown(), () => installation.close())
      const piRoot = await this.own(installation.verifyManagedPiRuntime({ beforeEffect: fileOptions.assertCurrent, signal: this.abort.signal }))
      this.assertStarting()
      if (piRoot && (!legacyPi || legacyPi === piRoot)) this.applyManagedPiEnvironment(piRoot)
    }
    const sessionContext = new SessionContextService(db)
    const voice = this.bootstrap.voice ? createProductionVoiceOwner({ resources: this.bootstrap.voice, profileRoot, tempRoot: this.bootstrap.paths.tempRoot, db, agents, storage: this.storage!,
      assertCurrent: () => {
        if (this.abort.signal.aborted || !['starting', 'ready'].includes(this.phase) || processRegistry[registryKey] !== this.identity) throw new ProductionOwnerError('OWNER_CLOSING')
        this.lock!.assertHeld()
      }, notify: (channel, payload) => this.emit(channel, payload) }) : null
    if (voice) this.register('voice', () => voice.shutdown(), () => voice.close())
    this.services = { ui, cliMcp, cliMcpFiles, taskAttachmentFiles, workspaceFiles, heartbeatFiles, github, gitlab, forgejo, gitProviderProcess, voice, agentDetection, agentInstallation, db, agents, oauth, worktrees, sync, registry, groups, chat, createChatProvider, commander: commanderService, commanderStore, captainDelivery, plugins, heartbeat, recurrence, automation, wakeups, coordination, cleanup, reminders, terminals, mcpProbes, sessionContext }
    if (this.bootstrap.mobile) {
      const { distRoot, port } = this.bootstrap.mobile
      const actual = realpathSync(distRoot), resource = realpathSync(this.bootstrap.paths.resourceRoot), location = relative(resource, actual)
      if (!isAbsolute(distRoot) || actual !== distRoot || !location || location.startsWith('..') || isAbsolute(location) || lstatSync(distRoot).isSymbolicLink() || !lstatSync(join(distRoot, 'index.html')).isFile() || lstatSync(join(distRoot, 'index.html')).isSymbolicLink() ||
        port !== undefined && (!Number.isSafeInteger(port) || port < 0 || port > 65535)) throw new ProductionOwnerError('MOBILE_RESOURCES_UNAVAILABLE')
      const taskActions = new ProductionMobileActions({ database: db, manager: agents, sync, registry, oauth, secretStorage: this.storage!, recurrence, heartbeat, automation, engineEpoch: this.epoch,
        assertAvailable: () => {
          if (this.abort.signal.aborted || !['starting', 'ready'].includes(this.phase) || processRegistry[registryKey] !== this.identity || this.services?.db !== db) throw new ProductionOwnerError('OWNER_CLOSING')
          this.lock!.assertHeld()
        },
        emit: (channel, data) => this.emit(channel, data),
        onFatalEvent: () => { void this.close().catch(() => {}) } })
      this.register('mobile-actions', () => taskActions.shutdown(), () => taskActions.close())
      const deps = Object.freeze({ taskActions, db, agentManager: agents, githubManager: github, gitlabManager: gitlab, forgejoManager: forgejo, syncManager: sync, pluginRegistry: registry, mobileDistRoot: actual, taskOwners: Object.freeze({ recurrence, heartbeat, automation }) })
      const tunnel = this.boundaries.mobileTunnel ?? null
      if (tunnel !== null && !(tunnel instanceof TunnelManagerCore)) throw new ProductionOwnerError('MOBILE_TUNNEL_OWNER_INVALID')
      setMobileApiDeps(deps)
      this.mobile = { deps, tunnel, port }
      setMobileApiNotifier((channel, data) => this.emit(channel, data))
      this.register('mobile-api', () => { void stopMobileApiServer().catch(() => {}) }, () => closeMobileApiServer())
      if (tunnel) this.register('mobile-tunnel', () => { void tunnel.stop().catch(() => {}) }, () => tunnel.close())
    }
    this.checkpoint('recovery')
    await agents.reconcileStartup()
    this.assertStarting()
    await captainDelivery.reconcile()
    this.assertStarting()
    await this.own(recoverIssueWriteOutcomes(db))
    this.assertStarting()
    this.checkpoint('background')
    reminders.start()
    this.connector?.startPolling({ db, onSynced: () => this.emit('tasks:refresh', undefined) })
    for (const scheduler of [recurrence, heartbeat, automation, wakeups, coordination, cleanup]) { this.assertStarting(); scheduler.start() }
    if (this.mobile) { await applyMobileAccessSettings(this.mobile.port); this.assertStarting() }
  }

  applyVerifiedManagedPi(): void {
    this.getDatabaseBindingLease()
    const root = this.services?.agentInstallation?.piConfigRoot
    if (root) this.applyManagedPiEnvironment(root)
  }
  private applyManagedPiEnvironment(root: string): void {
    if (root !== join(this.bootstrap.paths.profileRoot, 'agent-cli', '.pi-agent')) throw new ProductionOwnerError('CLI_INSTALLATION_OWNER_INVALID')
    const previous = this.ownedPiEnvironment ? this.ownedPiEnvironment.previous : process.env.PI_CODING_AGENT_DIR
    if (previous && previous !== root) throw new ProductionOwnerError('CLI_INSTALLATION_OWNER_INVALID')
    process.env.PI_CODING_AGENT_DIR = root; this.ownedPiEnvironment = { previous, installed: root }
  }

  private register(name: string, stop: () => void, drain: () => Promise<void>): void { this.stopOwners.push(stop); this.drains.set(name, drain) }
  private emit(channel: string, data: unknown): void {
    if (this.abort.signal.aborted) return
    if (this.mobile && MOBILE_OWNER_EVENTS.has(channel)) broadcastToMobileClients(channel, data)
    try { this.bootstrap.native.emit(channel, data) } catch { /* window loss cannot stop background ownership */ }
  }
  private notify(title: string, body: string): void {
    if (!this.abort.signal.aborted) this.bootstrap.native.notify(title, body)
  }

  /** A bounded wait never drops a raw owner. Retry close after blocked work settles. */
  close(timeoutMs = 3000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) return Promise.reject(new ProductionOwnerError('OWNER_DRAIN_TIMEOUT_INVALID'))
    if (this.phase === 'new') { this.update('stopped', 'released'); return Promise.resolve() }
    if (this.phase === 'stopped' || (this.phase === 'failed' && !this.snapshot().owned)) return Promise.resolve()
    if (this.closing) return this.closing
    this.abort.abort()
    this.update('stopping', this.stage)
    try { this.fenceOwners() } catch {
      this.update('blocked', this.stage, 'OWNER_FENCE_FAILED')
      return Promise.reject(new ProductionOwnerError('OWNER_FENCE_FAILED'))
    }
    // Drain may finish after a deadline, but only a successful close releases
    // resources. A blocked owner retains its lease until an explicit retry.
    if (!this.rawDrain) {
      const raw = this.drain()
      this.rawDrain = raw
      void raw.catch(() => { if (this.rawDrain === raw) this.rawDrain = null })
    }
    this.closing = bounded(this.rawDrain, timeoutMs).then(() => this.release()).catch(() => {
      this.update('blocked', this.stage, 'OWNER_DRAIN_BLOCKED')
      throw new ProductionOwnerError('OWNER_DRAIN_BLOCKED')
    }).finally(() => { this.closing = null })
    return this.closing
  }

  private fenceOwners(): void {
    this.removeReportBridge?.(); this.removeReportBridge = null
    for (const stop of this.stopOwners) {
      if (this.fenced.has(stop)) continue
      stop()
      this.fenced.add(stop)
    }
  }

  private async drain(): Promise<void> {
    // Late init must first assign its native key, listener or provider ownership.
    await this.rawInitialization?.catch(() => undefined)
    this.fenceOwners()
    const results = await Promise.allSettled([...this.drains].filter(([name]) => name !== 'adapters').map(async ([name, drain]) => { await drain(); this.drains.delete(name) }))
    if (results.some(result => result.status === 'rejected')) throw new ProductionOwnerError('OWNER_DRAIN_BLOCKED')
    while (this.rawWork.size) await Promise.allSettled([...this.rawWork])
    const adapters = this.drains.get('adapters')
    if (adapters) { await adapters(); this.drains.delete('adapters') }
    if (!this.nativeDrained) {
      const acknowledgement = await this.bootstrap.native.drainOwnedProcesses()
      if (acknowledgement.acknowledged !== true) throw new ProductionOwnerError('NATIVE_DRAIN_UNACKNOWLEDGED')
      this.nativeDrained = true
    }
  }

  private release(): void {
    // No obsolete owner may restore process-global runtime selection.
    if (processRegistry[registryKey] !== this.identity && this.phase !== 'new') throw new ProductionOwnerError('SERVICE_OWNER_LOST')
    if (this.ownedPath && process.env.PATH === this.ownedPath.installed) {
      if (this.ownedPath.previous === undefined) delete process.env.PATH; else process.env.PATH = this.ownedPath.previous
    }
    if (this.ownedPiEnvironment && process.env.PI_CODING_AGENT_DIR === this.ownedPiEnvironment.installed) {
      if (this.ownedPiEnvironment.previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = this.ownedPiEnvironment.previous
    }
    this.ownedPath = null; this.ownedPiEnvironment = null

    if (this.apiOwned) {
      setTaskApiAgentController(null); setTaskApiTaskGroupService(null); setTaskApiNotifier(null); setTranscriptProvider(null); setTaskApiUiState(null); setTaskApiUiOwner(null)
      setTaskSchedulers({ recurrence: null, heartbeat: null }); setTaskAutomationTrigger(null)
      configureCaptainGithubTools(null); setCoordinatorCallHandler(null)
      this.apiOwned = false
    }
    if (this.db) { if (this.db.db?.open) this.db.close(); this.db = null }
    if (this.storage) {
      if (this.storageRegistered) { releaseSecretStorage(this.storage); this.storageRegistered = false }
      this.storage.dispose(); this.storage = null
    }
    this.lock?.release(); this.lock = null
    delete processRegistry[registryKey]
    this.services = null
    this.update('stopped', 'released')
  }
}

async function bounded<T>(raw: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([raw, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProductionOwnerError('OWNER_DRAIN_BLOCKED')), timeoutMs) })]) }
  finally { if (timer) clearTimeout(timer) }
}

function safeStartupCode(error: unknown, stage: string): string {
  if (error instanceof ProductionOwnerError) return error.code
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'SQLITE_FULL') return 'PROFILE_LOW_DISK'
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return 'PROFILE_DATABASE_LOCKED'
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') return 'PROFILE_DATABASE_CORRUPT'
  if (/^(PROFILE_|SECRET_|RESOURCE_|MANAGED_MCP_|CONNECTOR_|AGENT_CLI_|NATIVE_RUNTIME_|AMBIGUOUS_MANAGED_MCP_)[A-Z_]*$/.test(code)) return code
  if (stage === 'resources') return 'RESOURCE_UNAVAILABLE'
  if (stage === 'native-readiness') return 'NATIVE_RUNTIME_UNAVAILABLE'
  if (stage === 'credentials') return 'SECRET_STORE_UNAVAILABLE'
  return stage === 'database' || stage === 'database-preflight' ? 'DATABASE_UNAVAILABLE' : 'BOOTSTRAP_FAILED'
}

/** Validate existing ciphertext read-only before migrations/seeding can write. No implicit profile conversion. */
function preflightProfile(path: string, storage: AuthenticatedSecretStorage): void {
  for (const file of [path, path + '-wal', path + '-shm']) {
    let stat: ReturnType<typeof lstatSync>
    try { stat = lstatSync(file) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw new ProductionOwnerError('PROFILE_DATABASE_PATH_INVALID') }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new ProductionOwnerError('PROFILE_DATABASE_PATH_INVALID')
  }
  if (!existsSync(path)) return
  const probe = new SQLite(realpathSync(path), { readonly: true, fileMustExist: true, timeout: 1000 })
  try {
    const result = probe.pragma('quick_check', { simple: true })
    if (result !== 'ok') throw new ProductionOwnerError('PROFILE_DATABASE_CORRUPT')
    const tables = new Set((probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name))
    if (tables.has('settings')) for (const row of probe.prepare("SELECT value FROM settings WHERE key LIKE '%\\_api\\_key' ESCAPE '\\' AND value <> ''").all() as Array<{ value: string }>) {
      if (!row.value.startsWith('21x-credential:21x.aes256gcm.v1:')) throw new ProductionOwnerError('PROFILE_CREDENTIAL_FORMAT_INCOMPATIBLE')
      decryptSettingValue(row.value)
    }
    const recordCredential = (value: unknown): void => {
      if (typeof value !== 'string' || value !== '' && !value.startsWith('21x-record-credential:v1:'))
        throw new ProductionOwnerError('PROFILE_CREDENTIAL_FORMAT_INCOMPATIBLE')
      decryptRecordCredential(value)
    }
    if (tables.has('agents')) for (const row of probe.prepare('SELECT config FROM agents').iterate() as Iterable<{ config: string }>) {
      const config = JSON.parse(row.config)
      if (config.api_keys !== undefined) for (const value of Object.values(config.api_keys)) recordCredential(value)
    }
    if (tables.has('mcp_servers')) for (const row of probe.prepare('SELECT headers, environment, oauth_metadata FROM mcp_servers').iterate() as Iterable<{ headers: string; environment: string; oauth_metadata: string }>) {
      for (const values of [row.headers, row.environment]) for (const value of Object.values(JSON.parse(values || '{}'))) recordCredential(value)
      const metadata = JSON.parse(row.oauth_metadata || '{}')
      if (metadata.client_secret !== undefined) recordCredential(metadata.client_secret)
    }
    if (tables.has('task_sources')) for (const row of probe.prepare('SELECT config FROM task_sources').iterate() as Iterable<{ config: string }>) {
      const config = JSON.parse(row.config || '{}')
      for (const key of TASK_SOURCE_STORED_CREDENTIAL_FIELDS) if (config[key] !== undefined) recordCredential(config[key])
    }
    for (const [table, columns] of [['secrets', ['value']], ['oauth_tokens', ['access_token', 'refresh_token']], ['connector_instances', ['auth']]] as const) {
      if (!tables.has(table)) continue
      for (const column of columns) for (const row of probe.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).iterate() as Iterable<{ value: Buffer }>) storage.decryptString(row.value)
    }
  } catch (error) {
    if (error instanceof ProductionOwnerError) throw error
    const code = safeStartupCode(error, 'database-preflight')
    if (code === 'PROFILE_DATABASE_LOCKED' || code === 'PROFILE_DATABASE_CORRUPT' || code === 'PROFILE_LOW_DISK') throw new ProductionOwnerError(code)
    throw new ProductionOwnerError('PROFILE_CREDENTIAL_OR_DATABASE_INVALID')
  } finally { probe.close() }
}
