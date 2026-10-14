import { UiStateBackend } from './ui-state-backend'
import { UI_DESKTOP_CODECS, UI_DESKTOP_EVENT_CODECS } from '../shared/ui-desktop-codecs'
import { CliMcpBackend } from './cli-mcp-backend'
import { TaskAttachmentBackend } from './task-attachment-backend'
import { CLI_MCP_CODECS } from '../shared/cli-mcp-codecs'
import { TASK_ATTACHMENT_CODECS } from '../shared/task-attachment-codecs'
import type { CliId } from '../shared/cli-mcp-config'
import { HEARTBEAT_CODECS, HEARTBEAT_EVENT_CODECS } from '../shared/heartbeat-codecs'
import { WORKTREE_RUNTIME_CODECS, WORKTREE_RUNTIME_EVENT_CODECS } from '../shared/worktree-runtime-codecs'
import { HeartbeatBackend } from './heartbeat-backend'
import { WorktreeRuntimeBackend } from './worktree-runtime-backend'
import { TaskGroupBackend } from './task-group-backend'
import { TASK_GROUP_CODECS } from '../shared/task-group-codecs'
import { ProjectRuntimeBackend } from './project-runtime-backend'
import { PROJECT_RUNTIME_CODECS } from '../shared/project-runtime-codecs'
import { AgentInstallerBackend } from './agent-installer-backend'
import { GitProviderBackend } from './git-provider-backend'
import { GIT_PROVIDER_CODECS } from '../shared/git-provider-codecs'
import { WORKSPACE_FILE_CODECS } from '../shared/workspace-file-codecs'
import { WorkspaceFileBackend } from './workspace-file-backend'
import { AGENT_INSTALLER_CODECS, AGENT_INSTALLER_EVENT_CODECS } from '../shared/agent-installer-codecs'
import { ArtifactBackend } from './artifact-backend'
import { ARTIFACT_CODECS } from '../shared/artifact-codecs'
import { VoiceManagementBackend } from './voice-management-backend'
import { VOICE_MANAGEMENT_CODECS, VOICE_MANAGEMENT_EVENT_CODECS } from '../shared/voice-management-codecs'
import { MobileBackend, type MobileBackendOptions } from './mobile-backend'
import { MOBILE_CODECS, MOBILE_EVENT_CODECS } from '../shared/mobile-codecs'
import { SessionContextBackend } from './session-context-backend'
import { SESSION_CONTEXT_CODECS } from '../shared/session-context-codecs'
import { ClaudePluginBackend, type ClaudePluginBackendOptions } from './claude-plugin-backend'
import { CLAUDE_PLUGIN_CODECS } from '../shared/claude-plugin-codecs'
import { TaskLifecycleBackend } from './task-lifecycle-backend'
import { ProductionAgentBackend } from './production-agent-backend'
import { CommanderBackend } from './commander-backend'
import { TerminalBackend, type TerminalDirectoryAuthority } from './terminal-backend'
import { ProductionSettingsBackend, type ProductionSettingsBackendOptions } from './production-settings-backend'
import { McpBackend, type McpBackendOptions } from './mcp-backend'
import { TaskSourceBackend, type TaskSourceBackendOptions } from './task-source-backend'
import { TaskSourcePluginBackend, type TaskSourcePluginBackendOptions } from './task-source-plugin-backend'
import { ConnectorBackend, type ConnectorBackendOptions } from './connector-backend'
import { TASK_SOURCE_PLUGIN_CODECS, type TaskSourcePluginOperation } from '../shared/task-source-plugin-codecs'
import { CONNECTOR_CODECS } from '../shared/connector-codecs'
import type { TaskSourceOperation } from '../shared/task-source-codecs'
import { MCP_CODECS } from '../shared/mcp-codecs'
import { TASK_SOURCE_CODECS } from '../shared/task-source-codecs'
import { PRODUCTION_SETTINGS_CODECS } from '../shared/production-settings-codecs'
import { TERMINAL_COMMAND_CODECS, TERMINAL_EVENT_CODECS } from '../shared/terminal-desktop-codecs'
import { encodeDurableTranscriptEvent } from './transcript-events'
import { DatabaseBackend } from './database-backend'
import { ConfigurationBackend } from './configuration-backend'
import { AgentConfigurationBackend, type AgentConfigurationBackendOptions } from './agent-configuration-backend'
import type { ProductionOwner } from './production-owner'
import type { DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'
import { TASK_LIFECYCLE_CODECS, TASK_LIFECYCLE_EVENT_CODECS } from '../shared/task-lifecycle-codecs'
import { PRODUCTION_AGENT_CODECS } from '../shared/production-agent-codecs'
import { PRODUCTION_AGENT_EVENT_CODECS } from '../shared/production-agent-events'
import { COMMANDER_COMMAND_CODECS, COMMANDER_EVENT_CODECS } from '../shared/commander-desktop-codecs'
import { AGENT_CONFIGURATION_EVENT_CODECS } from '../shared/agent-configuration-codecs'
import { DATABASE_COMMAND_CODECS, DATABASE_EVENT_CODECS } from '../shared/database-desktop-codecs'
import { CONFIGURATION_CONTENT_OPERATIONS, CONFIGURATION_COMMAND_CODECS, CONFIGURATION_EVENT_CODECS } from '../shared/configuration-desktop-codecs'
import { AGENT_CONFIGURATION_CODECS } from '../shared/agent-configuration-codecs'
import { ServiceProtocolError, isRecord, isJsonValue, type JsonValue } from '../shared/service-protocol'

type Authority = Pick<AgentConfigurationBackendOptions, 'isTrustedDesktop' | 'canAccessAgent' | 'canManageGlobalConfiguration' | 'canAccessProject' | 'canQueryBackend'> & {
  canAccessTask(id: string, caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canAccessSource(id: string, caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canAccessSession(id: string, caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canAccessGlobalCommander(caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canCreateProject(caller: DesktopCallerContext): boolean
  canEditSettings(caller: DesktopCallerContext): boolean
  canAccessGlobalSkills(caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canChangeSkillScope(caller: DesktopCallerContext): boolean
  canReorderProjects(caller: DesktopCallerContext): boolean
  canAccessTerminal(id: string, caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  resolveTerminalDirectory(id: string, caller: DesktopCallerContext): TerminalDirectoryAuthority | null
  canAccessCli(cli: CliId, caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canAccessMcpServer(id: string, caller: DesktopCallerContext, access: 'read' | 'write' | 'delete'): boolean
} & Pick<ProductionSettingsBackendOptions, 'canReadSetting' | 'canWriteSetting' | 'canAccessSecret' | 'canCreateSecret' | 'canUseSecretEnvironment' | 'canReadEnvironment'> &
  Pick<McpBackendOptions, 'canUseTransport' | 'canUseEnvironmentName'> & Pick<TaskSourceBackendOptions, 'canAccessConnector'> &
  Pick<TaskSourcePluginBackendOptions, 'canBorrowSourceCredentials' | 'canResolveUnsavedConfig'> &
  Pick<ConnectorBackendOptions, 'canCreateInstance' | 'canUsePiece'> &
  Pick<ClaudePluginBackendOptions, 'canAccessMarketplace' | 'canCreateMarketplace' | 'canAccessPluginName' | 'canAccessPlugin' | 'canUseMarketplaceSource' | 'canUsePluginSource' | 'canAccessSkill' | 'canCreateGlobalSkill' | 'canCreateAgent' | 'canCreateMcpServer' | 'canUsePluginAddress'> & {
    canManageMobile: MobileBackendOptions['canManageMobile']
    canAccessMobileSession: MobileBackendOptions['canAccessSession']
    canUseSourcePlugin(id: string, caller: DesktopCallerContext, operation: TaskSourceOperation | TaskSourcePluginOperation | 'plugin:executeAction'): boolean
  }
export interface ProductionDesktopBindingOptions {
  authority: Authority
  emit(operation: string, payload: JsonValue, recipient?: DesktopCallerContext): void
  fatal(error: ServiceProtocolError): void
}

/** Source codecs are separate from native grants; each domain has actual scope. */
export const PRODUCTION_COMMAND_CODECS = { ...DATABASE_COMMAND_CODECS,
  ...Object.fromEntries(CONFIGURATION_CONTENT_OPERATIONS.map(name => [name, CONFIGURATION_COMMAND_CODECS[name]])),
  ...AGENT_CONFIGURATION_CODECS, ...TASK_LIFECYCLE_CODECS, ...PRODUCTION_AGENT_CODECS, ...COMMANDER_COMMAND_CODECS,
  ...PRODUCTION_SETTINGS_CODECS, ...TERMINAL_COMMAND_CODECS, ...MCP_CODECS, ...TASK_SOURCE_CODECS, ...TASK_SOURCE_PLUGIN_CODECS, ...CONNECTOR_CODECS, ...SESSION_CONTEXT_CODECS, ...CLAUDE_PLUGIN_CODECS, ...MOBILE_CODECS, ...AGENT_INSTALLER_CODECS, ...ARTIFACT_CODECS, ...VOICE_MANAGEMENT_CODECS, ...GIT_PROVIDER_CODECS, ...WORKSPACE_FILE_CODECS, ...TASK_GROUP_CODECS, ...PROJECT_RUNTIME_CODECS, ...HEARTBEAT_CODECS, ...WORKTREE_RUNTIME_CODECS, ...CLI_MCP_CODECS, ...TASK_ATTACHMENT_CODECS, ...UI_DESKTOP_CODECS }
export const PRODUCTION_EVENT_CODECS = { ...DATABASE_EVENT_CODECS, ...CONFIGURATION_EVENT_CODECS,
  ...PRODUCTION_AGENT_EVENT_CODECS, ...TASK_LIFECYCLE_EVENT_CODECS, ...COMMANDER_EVENT_CODECS, ...AGENT_CONFIGURATION_EVENT_CODECS, ...TERMINAL_EVENT_CODECS, ...MOBILE_EVENT_CODECS, ...VOICE_MANAGEMENT_EVENT_CODECS, ...HEARTBEAT_EVENT_CODECS, ...WORKTREE_RUNTIME_EVENT_CODECS, ...UI_DESKTOP_EVENT_CODECS, ...AGENT_INSTALLER_EVENT_CODECS }

/** Validate actual wire payload, including explicit binary envelopes. */
export function validateProductionEventWire(operation: string, payload: unknown): boolean {
  if (!Object.hasOwn(PRODUCTION_EVENT_CODECS, operation)) return false
  const codec = PRODUCTION_EVENT_CODECS[operation as keyof typeof PRODUCTION_EVENT_CODECS]
  try {
    if (operation === 'tasks:refresh') return codec.validatePayload(payload)
    const decoded = codec.decodePayload(payload as JsonValue)
    return codec.validatePayload(decoded)
  } catch { return false }
}

/** Attach reviewed domain bindings to the existing production singleton.
 * Settings remain content-scoped; task/session/Commander effects use their
 * actual lifecycle owners and exact domain codecs. */
export class ProductionDesktopBindings {
  private closed = false
  private readonly database: DatabaseBackend
  private readonly content: ConfigurationBackend
  private readonly agents: AgentConfigurationBackend
  private readonly tasks: TaskLifecycleBackend
  private readonly lifecycle: ProductionAgentBackend
  private readonly commander: CommanderBackend
  private readonly settings: ProductionSettingsBackend
  private readonly terminals: TerminalBackend
  private readonly mcp: McpBackend
  private readonly sources: TaskSourceBackend
  private readonly sourcePlugins: TaskSourcePluginBackend
  private readonly connectors: ConnectorBackend | null
  private readonly sessionContext: SessionContextBackend
  private readonly claudePlugins: ClaudePluginBackend
  private readonly mobile: MobileBackend | null
  private readonly agentInstaller: AgentInstallerBackend
  private readonly artifacts: ArtifactBackend
  private readonly voice: VoiceManagementBackend | null
  private readonly gitProviders: GitProviderBackend
  private readonly groups: TaskGroupBackend
  private readonly projectRuntime: ProjectRuntimeBackend
  private readonly workspaceFiles: WorkspaceFileBackend
  private readonly heartbeat: HeartbeatBackend
  private readonly cliMcp: CliMcpBackend
  private readonly ui: UiStateBackend | null
  private readonly taskAttachments: TaskAttachmentBackend
  private readonly worktreeRuntime: WorktreeRuntimeBackend
  private readonly epoch: string
  private constructor(private readonly owner: ProductionOwner, private readonly services: Awaited<ReturnType<ProductionOwner['start']>>, private readonly options: ProductionDesktopBindingOptions) {
    const lease = owner.getDatabaseBindingLease()
    this.epoch = owner.snapshot().epoch
    const available = (): void => {
      if (this.closed || owner.snapshot().phase !== 'ready') throw new ServiceProtocolError('DISCONNECTED')
      lease.lock.assertHeld()
    }
    const { authority } = options
    // Scope can be withdrawn while raw authorization/effects are in flight.
    // Keep every check tied to the current trusted policy, never a cached grant.
    const dynamicAuthority = Object.fromEntries(Object.keys(authority).map(key => [key, (...args: unknown[]) => {
      const check = Reflect.get(authority, key)
      return typeof check === 'function' && Reflect.apply(check, authority, args)
    }])) as Authority
    this.database = new DatabaseBackend({ engineEpoch: this.epoch, ...lease, database: services.db,
      assertOwnerAvailable: available, isTrustedDesktop: dynamicAuthority.isTrustedDesktop,
      canAccessProject: (id, caller, access = 'read') => authority.canAccessProject(id, caller, access),
      canCreateProject: dynamicAuthority.canCreateProject, canEditSettings: dynamicAuthority.canEditSettings,
      canDeleteTask: (id, caller) => {
        const task = services.db.getTask(id)
        return (!task || authority.canAccessProject(task.project_id, caller, 'write')) && !services.agents.hasTaskStartOwnership(id) && services.taskAttachmentFiles.inflightCount === 0
      },
      emit: options.emit })
    this.content = new ConfigurationBackend({ database: services.db, engineEpoch: this.epoch, assertAvailable: available,
      isTrustedDesktop: dynamicAuthority.isTrustedDesktop, canAccessProject: dynamicAuthority.canAccessProject,
      canAccessGlobalSkills: dynamicAuthority.canAccessGlobalSkills, canChangeSkillScope: dynamicAuthority.canChangeSkillScope,
      canReorderProjects: dynamicAuthority.canReorderProjects, emit: options.emit })
    this.agents = new AgentConfigurationBackend({ database: services.db, manager: services.agents, credentialStorage: owner.getSettingsBindingLease().secretStorage, engineEpoch: this.epoch,
      assertAvailable: available, ...dynamicAuthority, emit: options.emit, onFatalEvent: options.fatal })
    this.tasks = new TaskLifecycleBackend({ database: services.db, manager: services.agents, registry: services.registry,
      sync: services.sync, recurrence: services.recurrence, heartbeat: services.heartbeat, automation: services.automation,
      engineEpoch: this.epoch, assertAvailable: available, ...dynamicAuthority,
      beforeTaskDeletion: () => {
        available(); const files = owner.getTaskAttachmentBindingLease(); files.assertTaskAttachmentOwners(files)
        if (files.files.inflightCount) throw new ServiceProtocolError('INVALID_REQUEST')
      }, emit: options.emit, onFatalEvent: options.fatal })
    this.lifecycle = new ProductionAgentBackend({ database: services.db, manager: services.agents,
      engineEpoch: this.epoch, assertAvailable: available, ...dynamicAuthority })
    this.commander = new CommanderBackend({ database: services.db, store: services.commanderStore, commander: services.commander,
      chat: services.chat, agents: services.agents, createChatProvider: services.createChatProvider,
      engineEpoch: this.epoch, assertAvailable: available, ...dynamicAuthority, emit: options.emit, onFatalEvent: options.fatal })
    this.settings = new ProductionSettingsBackend({ database: services.db, manager: services.agents,
      recurrence: services.recurrence, heartbeat: services.heartbeat, automation: services.automation,
      coordination: services.coordination, cleanup: services.cleanup, ...owner.getSettingsBindingLease(),
      runCredentialMutation: (input, mutation) => owner.runCredentialMutation(input, mutation),
      engineEpoch: this.epoch, assertAvailable: available, ...dynamicAuthority,
      environment: { OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CURSOR_API_KEY: process.env.CURSOR_API_KEY },
      emit: options.emit, onFatalEvent: options.fatal })
    this.terminals = new TerminalBackend({ terminals: services.terminals, engineEpoch: this.epoch, assertAvailable: available,
      isTrustedDesktop: dynamicAuthority.isTrustedDesktop, canAccessTerminal: dynamicAuthority.canAccessTerminal,
      // Unlike boolean policy checks this callback returns a trusted directory.
      resolveDirectory: (id, caller) => authority.resolveTerminalDirectory(id, caller),
      emit: options.emit, onFatalEvent: options.fatal })
    const integration = owner.getIntegrationBindingLease()
    this.mcp = new McpBackend({ database: services.db, manager: services.agents, sync: services.sync, probes: services.mcpProbes,
      secretStorage: integration.secretStorage, configuredMcp: integration.configuredMcp,
      oauth: { kind: integration.oauthBrowser, manager: services.oauth },
      assertMcpOwners: owners => integration.assertOwners({ ...owners, oauth: owners.oauth.manager }),
      engineEpoch: this.epoch, assertAvailable: available, ...dynamicAuthority,
      canManageConfiguration: dynamicAuthority.canManageGlobalConfiguration, canAccessServer: dynamicAuthority.canAccessMcpServer,
      emit: options.emit, onFatalEvent: options.fatal })
    const privateProbeEnvironment = /^(?:PATH|HOME|SHELL|BASH_ENV|ENV|IFS|CDPATH|PROMPT_COMMAND|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|ELECTRON_.*|TASK_API_.*|TASK_MCP_.*|TWENTYONEX_.*|SECRET_BROKER_.*|21X_.*|GIT_CONFIG.*|GIT_ASKPASS|SSH_ASKPASS|CODEX_HOME|CODEX_CONFIG_HOME|PI_CODING_AGENT_DIR|CLAUDE_CONFIG_DIR)$/i
    this.cliMcp = new CliMcpBackend({ ...owner.getCliMcpBindingLease(), engineEpoch: this.epoch, assertAvailable: available,
      isTrustedDesktop: dynamicAuthority.isTrustedDesktop, canManageConfiguration: dynamicAuthority.canManageGlobalConfiguration,
      canAccessCli: dynamicAuthority.canAccessCli,
      canProbeCli: (ref, caller) => dynamicAuthority.canAccessCli(ref.cli, caller, 'read'),
      canProbeServer: (input, caller) => integration.configuredMcp === 'enabled' && dynamicAuthority.canUseTransport(input, caller) &&
        Object.keys(input.environment ?? {}).every(name => !privateProbeEnvironment.test(name) && dynamicAuthority.canUseEnvironmentName(name, caller)),
      canUseEnvironmentReference: (name, caller) => !privateProbeEnvironment.test(name) && dynamicAuthority.canUseSecretEnvironment(name, caller),
      runConfigurationMutation: async (targets, caller, beforeEffect, effect) => {
        const capture = (): string => {
          available(); beforeEffect()
          const ids = services.agents.getCliConfigurationAffectedAgents(targets)
          const projectBounds = services.db.db.prepare('SELECT COUNT(*) AS count,COALESCE(MAX(length(CAST(id AS BLOB))),0) AS field FROM projects').get() as { count: number; field: number }
          if (projectBounds.count > 128 || projectBounds.field > 128) throw new ServiceProtocolError('FRAME_TOO_LARGE')
          const projects = services.db.db.prepare('SELECT id FROM projects ORDER BY id LIMIT 128').all() as { id: string }[]
          if (projects.length > 128 || projects.some(row => typeof row.id !== 'string' || Buffer.byteLength(row.id) > 128 || !dynamicAuthority.canAccessProject(row.id, caller, 'read') || !dynamicAuthority.canAccessProject(row.id, caller, 'write')) ||
            ids.some(id => !dynamicAuthority.canAccessAgent(id, caller, 'read') || !dynamicAuthority.canAccessAgent(id, caller, 'write'))) throw new ServiceProtocolError('INVALID_REQUEST')
          const agents = ids.map(id => services.db.db.prepare('SELECT id,config FROM agents WHERE id=?').get(id))
          return JSON.stringify({ agents, projects })
        }
        const binding = capture()
        const current = (): void => { if (capture() !== binding) throw new ServiceProtocolError('INVALID_REQUEST') }
        return await services.agents.withTaskGroupRequestGuard(() => services.agents.runCliConfigurationMutation(targets, async () => { current(); const result = await effect(); current(); return result }), current, new AbortController().signal)
      } })
    this.taskAttachments = new TaskAttachmentBackend({ ...owner.getTaskAttachmentBindingLease(), engineEpoch: this.epoch, assertAvailable: available,
      isTrustedDesktop: dynamicAuthority.isTrustedDesktop, canAccessTask: dynamicAuthority.canAccessTask,
      canAccessProject: dynamicAuthority.canAccessProject, canAccessAgent: dynamicAuthority.canAccessAgent })
    this.sources = new TaskSourceBackend({ database: services.db, manager: services.agents, sync: services.sync, plugins: services.registry,
      oauth: services.oauth, secretStorage: integration.secretStorage, recurrence: services.recurrence, heartbeat: services.heartbeat, automation: services.automation,
      assertOwners: integration.assertOwners, engineEpoch: this.epoch, assertAvailable: available, ...dynamicAuthority,
      emit: options.emit, onFatalEvent: options.fatal })
    this.sourcePlugins = new TaskSourcePluginBackend({ database: services.db, sync: services.sync, plugins: services.registry,
      oauth: services.oauth, secretStorage: integration.secretStorage, assertOwners: integration.assertOwners,
      engineEpoch: this.epoch, assertAvailable: available, ...dynamicAuthority,
      canManageConfiguration: dynamicAuthority.canManageGlobalConfiguration })
    const connectorLease = owner.getConnectorBindingLease()
    this.connectors = connectorLease ? new ConnectorBackend({ database: services.db, sync: services.sync, ...connectorLease,
      engineEpoch: this.epoch, assertAvailable: available, ...dynamicAuthority,
      canManageConfiguration: dynamicAuthority.canManageGlobalConfiguration, canAccessInstance: dynamicAuthority.canAccessConnector }) : null
    this.sessionContext = new SessionContextBackend({ database: services.db, ...owner.getSessionContextBindingLease(),
      engineEpoch: this.epoch, assertAvailable: available, ...dynamicAuthority,
      canManageConfiguration: dynamicAuthority.canManageGlobalConfiguration,
      canAccessSetting: (key, caller, access) => authority.canReadSetting(key, caller) && (access === 'read' || authority.canWriteSetting(key, caller)) })
    this.claudePlugins = new ClaudePluginBackend({ database: services.db, manager: services.plugins, agents: services.agents, sync: services.sync,
      ...owner.getClaudePluginBindingLease(), engineEpoch: this.epoch, assertAvailable: available, ...dynamicAuthority,
      canManageConfiguration: dynamicAuthority.canManageGlobalConfiguration, canManageGlobalSkills: dynamicAuthority.canAccessGlobalSkills,
      runPluginMutation: (resources, mutation) => owner.runCredentialMutation({ kind: 'plugin-resources', ...resources }, mutation),
      emit: options.emit, onFatalEvent: options.fatal })
    const mobileLease = owner.getMobileBindingLease()
    this.mobile = mobileLease ? new MobileBackend({ ...mobileLease, engineEpoch: this.epoch, assertAvailable: available,
      isTrustedDesktop: dynamicAuthority.isTrustedDesktop, canManageMobile: dynamicAuthority.canManageMobile,
      canAccessSession: dynamicAuthority.canAccessMobileSession }) : null
    const installationLease = owner.getAgentInstallerBindingLease()
    let installationBinding: { name: string; signature: string } | null = null
    const installationSignature = (name: string): string => JSON.stringify({ agents: services.agents.getAgentInstallationAffectedAgents(name), projects: services.agents.getAgentInstallationAffectedProjects(name) })
    const installationGrants = (name: string, caller: DesktopCallerContext): boolean => {
      if (!dynamicAuthority.canManageGlobalConfiguration(caller, 'read') || !dynamicAuthority.canManageGlobalConfiguration(caller, 'write')) return false
      if (installationBinding && (installationBinding.name !== name || installationBinding.signature !== installationSignature(name))) throw new ServiceProtocolError('INVALID_REQUEST')
      if (!installationLease.installation?.canInstall(name)) return true // finite unsupported plans retain read-only evidence
      return services.agents.getAgentInstallationAffectedAgents(name).every(id => dynamicAuthority.canAccessAgent(id, caller, 'read') && dynamicAuthority.canAccessAgent(id, caller, 'write')) &&
        services.agents.getAgentInstallationAffectedProjects(name).every(id => dynamicAuthority.canAccessProject(id, caller, 'read') && dynamicAuthority.canAccessProject(id, caller, 'write'))
    }
    this.agentInstaller = new AgentInstallerBackend({ ...installationLease, engineEpoch: this.epoch, assertAvailable: available,
      isTrustedDesktop: dynamicAuthority.isTrustedDesktop, canManageConfiguration: dynamicAuthority.canManageGlobalConfiguration,
      ...(installationLease.installation ? { canInstallBackend: installationGrants,
        runInstallation: async (name, caller, effect, beforeEffect, signal) => {
          available(); beforeEffect()
          if (signal.aborted || !installationGrants(name, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
          if (!installationLease.installation!.canInstall(name)) return effect()
          const initial = installationSignature(name)
          const guard = (): void => {
            beforeEffect()
            if (initial !== installationSignature(name)) throw new ServiceProtocolError('INVALID_REQUEST')
          }
          return services.agents.runAgentInstallationMutation(name, async () => {
            installationBinding = { name, signature: initial }
            try {
              guard(); const result = await effect(); guard()
              if (result.success) owner.applyVerifiedManagedPi()
              return result
            } finally { installationBinding = null }
          })
        } } : {}),
      ...(installationLease.emitProgress ? { isCurrentProgressRecipient: caller => !!services.ui && services.ui.observedLeaseId === caller.uiLeaseId,
        emitProgress: (progress, caller) => installationLease.emitProgress!(progress, caller.uiLeaseId!) } : { emitProgress: undefined }) })
    this.artifacts = new ArtifactBackend({ database: services.db, ...owner.getArtifactBindingLease(), engineEpoch: this.epoch, assertAvailable: available,
      canAccessAgent: dynamicAuthority.canAccessAgent, isTrustedDesktop: dynamicAuthority.isTrustedDesktop, canAccessTask: dynamicAuthority.canAccessTask, canAccessProject: dynamicAuthority.canAccessProject })
    const voiceLease = owner.getVoiceBindingLease()
    this.voice = voiceLease ? new VoiceManagementBackend({ ...voiceLease, engineEpoch: this.epoch, assertAvailable: available,
      isTrustedDesktop: dynamicAuthority.isTrustedDesktop, canManageVoice: dynamicAuthority.canManageGlobalConfiguration }) : null
    this.gitProviders = new GitProviderBackend({ ...owner.getGitProviderBindingLease(), engineEpoch: this.epoch, assertAvailable: available,
      isTrustedDesktop: dynamicAuthority.isTrustedDesktop, canManageGitProviders: dynamicAuthority.canManageGlobalConfiguration })
    this.workspaceFiles = new WorkspaceFileBackend({ ...owner.getWorkspaceFileBindingLease(), engineEpoch: this.epoch, assertAvailable: available,
      isTrustedDesktop: dynamicAuthority.isTrustedDesktop, canAccessTask: dynamicAuthority.canAccessTask, canAccessProject: dynamicAuthority.canAccessProject })
    this.groups = new TaskGroupBackend({ ...owner.getTaskGroupBindingLease(), engineEpoch: this.epoch, assertAvailable: available, ...dynamicAuthority })
    this.projectRuntime = new ProjectRuntimeBackend({ ...owner.getProjectRuntimeBindingLease(), engineEpoch: this.epoch, assertAvailable: available, ...dynamicAuthority })
    this.heartbeat = new HeartbeatBackend({ ...owner.getHeartbeatBindingLease(), engineEpoch: this.epoch, assertAvailable: available, ...dynamicAuthority })
    this.worktreeRuntime = new WorktreeRuntimeBackend({ ...owner.getWorktreeRuntimeBindingLease(), engineEpoch: this.epoch, assertAvailable: available, ...dynamicAuthority,
      // The domain owner resolves and rechecks exact saved task/project bindings,
      // including established task repos outside the project's picker catalogue.
      canAccessRepository: (projectId, _fullName, caller, access) => dynamicAuthority.canAccessProject(projectId, caller, access) })
    const uiLease = owner.getUiBindingLease()
    this.ui = uiLease ? new UiStateBackend({ ...uiLease, engineEpoch: this.epoch, assertAvailable: available,
      isTrustedDesktop: dynamicAuthority.isTrustedDesktop, canPublishUi: dynamicAuthority.isTrustedDesktop,
      canAccessProject: dynamicAuthority.canAccessProject, canAccessTask: dynamicAuthority.canAccessTask, canAccessAgent: dynamicAuthority.canAccessAgent }) : null
    owner.retainCleanup('desktop-bindings', () => {
      this.closed = true; this.ui?.shutdown(); this.cliMcp.shutdown(); this.taskAttachments.shutdown(); this.database.close(); this.lifecycle.shutdown(); this.commander.shutdown(); this.terminals.shutdown(); this.mcp.shutdown(); this.connectors?.shutdown(); this.claudePlugins.shutdown(); this.mobile?.shutdown(); this.agentInstaller.stop(); this.artifacts.shutdown(); this.voice?.shutdown(); this.gitProviders.shutdown(); this.workspaceFiles.shutdown(); this.groups.shutdown(); this.projectRuntime.shutdown(); this.heartbeat.shutdown(); this.worktreeRuntime.shutdown()
      void Promise.all([this.agents.close(), this.tasks.close(), this.settings.close(), this.sources.close(), this.sourcePlugins.close(), this.sessionContext.close()]).catch(() => { /* Registered drain retains raw work. */ })
    }, () => Promise.all([this.agents.close(), this.tasks.close(), this.lifecycle.close(), this.commander.close(), this.settings.close(), this.terminals.close(), this.mcp.close(), this.sources.close(), this.sourcePlugins.close(), this.connectors?.close(), this.sessionContext.close(), this.claudePlugins.close(), this.mobile?.close(), this.agentInstaller.close(), this.artifacts.close(), this.voice?.close(), this.gitProviders.close(), this.workspaceFiles.close(), this.groups.close(), this.projectRuntime.close(), this.heartbeat.close(), this.worktreeRuntime.close(), this.cliMcp.close(), this.taskAttachments.close(), this.ui?.close()]).then(() => undefined))
  }

  static async attach(owner: ProductionOwner, options: ProductionDesktopBindingOptions): Promise<ProductionDesktopBindings> {
    return owner.run(services => new ProductionDesktopBindings(owner, services, options))
  }

  hasOwnerEvent(operation: string): boolean { return Object.hasOwn(PRODUCTION_EVENT_CODECS, operation) }
  /** Raw owner events never bypass exact codecs or durable transcript projection. */
  encodeOwnerEvent(operation: string, payload: unknown): JsonValue {
    if (this.closed) throw new ServiceProtocolError('DISCONNECTED')
    if (!this.hasOwnerEvent(operation)) throw new ServiceProtocolError('UNKNOWN_OPERATION')
    try {
      if (operation === 'transcript:changed') payload = encodeDurableTranscriptEvent(this.services.db, payload)
      if (operation === 'tasks:refresh' && payload === undefined) payload = {}
      const codec = PRODUCTION_EVENT_CODECS[operation as keyof typeof PRODUCTION_EVENT_CODECS]
      if ('encodePayload' in codec) return codec.encodePayload(payload as never)
      if (!codec.validatePayload(payload) || !isJsonValue(payload)) throw new ServiceProtocolError('INVALID_RESULT')
      return payload
    } catch {
      this.closed = true
      const error = new ServiceProtocolError('INVALID_RESULT')
      this.options.fatal(error)
      throw error
    }
  }

  /** Event delivery is a read grant separate from command permission. */
  projectOwnerEvent(operation: string, payload: JsonValue, caller: DesktopCallerContext): JsonValue | undefined {
    if (this.closed || caller.engineEpoch !== this.epoch || caller.principal !== 'trusted-desktop-main' || !this.options.authority.isTrustedDesktop(caller)) return undefined
    if (!validateProductionEventWire(operation, payload)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    const authority = this.options.authority
    if (Object.hasOwn(VOICE_MANAGEMENT_EVENT_CODECS, operation)) return this.voice && authority.canManageGlobalConfiguration(caller, 'read') ? payload : undefined
    const taskAllowed = (id: unknown): boolean => {
      if (typeof id !== 'string' || !authority.canAccessTask(id, caller, 'read')) return false
      const task = this.services.db.getTask(id)
      return !task || authority.canAccessProject(task.project_id, caller, 'read')
    }
    if (Object.hasOwn(MOBILE_EVENT_CODECS, operation)) {
      if (!this.mobile || !authority.canManageMobile(caller, 'read')) return undefined
      if (operation === 'mobile:pairing-initiated') return authority.canManageMobile(caller, 'write') ? payload : undefined
      return isRecord(payload) && typeof payload.sessionId === 'string' && authority.canAccessMobileSession(payload.sessionId, caller, 'read') &&
        this.services.db.db.prepare('SELECT 1 FROM mobile_sessions WHERE id=? AND revoked=0').get(payload.sessionId) ? payload : undefined
    }
    if (operation === 'commander:event' || operation === 'chat:event') {
      const codec = COMMANDER_EVENT_CODECS[operation]
      const decoded = codec.decodePayload(payload)
      return this.commander.canReadEvent(operation, decoded, caller) ? payload : undefined
    }
    if (operation === 'terminal:data' || operation === 'terminal:exit')
      return this.terminals.canReadEvent(operation, TERMINAL_EVENT_CODECS[operation].decodePayload(payload), caller) ? payload : undefined
    if (!isRecord(payload)) return undefined
    if (operation === 'worktree:progress' || Object.hasOwn(HEARTBEAT_EVENT_CODECS, operation)) {
      if (typeof payload.taskId !== 'string' || !authority.canAccessTask(payload.taskId, caller, 'read')) return undefined
      const task = this.services.db.db.prepare('SELECT project_id FROM tasks WHERE id=?').get(payload.taskId) as { project_id: string } | undefined
      return task && authority.canAccessProject(task.project_id, caller, 'read') ? payload : undefined
    }
    if (operation === 'workspace:cleanup-progress' || operation === 'workspace:cleanup-complete') {
      if (!authority.canManageGlobalConfiguration(caller, 'read')) return undefined
      const projects = this.services.db.db.prepare('SELECT id FROM projects ORDER BY id LIMIT 129').all() as { id: string }[]
      return projects.length <= 128 && projects.every(project => authority.canAccessProject(project.id, caller, 'read')) ? payload : undefined
    }
    if (operation === 'agent:startQueueChanged') {
      const queue = (payload.queue as JsonValue[]).filter(row => isRecord(row) && taskAllowed(row.taskId) && typeof row.agentId === 'string' &&
        authority.canAccessAgent(row.agentId, caller, 'read') && typeof row.projectId === 'string' && authority.canAccessProject(row.projectId, caller, 'read'))
      return { queue, ...(isRecord(payload.failed) && taskAllowed(payload.failed.taskId) ? { failed: payload.failed as JsonValue } : {}) }
    }
    if (operation === 'tasks:refresh') return this.services.db.getProjects().some(project => authority.canAccessProject(project.id, caller, 'read')) ? payload : undefined
    if (operation === 'skills:changed' && !Object.hasOwn(payload, 'projectId'))
      return authority.canAccessGlobalSkills(caller, 'read') ? payload : undefined
    if (operation === 'task:created') return isRecord(payload.task) && taskAllowed(payload.task.id) ? payload : undefined
    if (typeof payload.taskId === 'string') {
      if (!taskAllowed(payload.taskId)) return undefined
      if (typeof payload.agentId === 'string' && !authority.canAccessAgent(payload.agentId, caller, 'read')) return undefined
      return payload
    }
    if (typeof payload.parentId === 'string') return taskAllowed(payload.parentId) ? payload : undefined
    if (typeof payload.projectId === 'string') return authority.canAccessProject(payload.projectId, caller, 'read') ? payload : undefined
    return undefined
  }

  /** Caller context is selected by trusted native ingress, never payload fields. */
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    const schemas = { ...this.database.operationSchemas(caller), ...this.content.operationSchemas(caller), ...this.agents.operationSchemas(caller),
      ...this.tasks.operationSchemas(caller), ...this.lifecycle.operationSchemas(caller), ...this.commander.operationSchemas(caller),
      ...this.settings.operationSchemas(caller), ...this.terminals.operationSchemas(caller), ...this.mcp.operationSchemas(caller), ...this.sources.operationSchemas(caller),
      ...this.sourcePlugins.operationSchemas(caller), ...this.connectors?.operationSchemas(caller), ...this.sessionContext.operationSchemas(caller), ...this.claudePlugins.operationSchemas(caller), ...this.mobile?.operationSchemas(caller), ...this.agentInstaller.operationSchemas(caller), ...this.artifacts.operationSchemas(caller), ...this.voice?.operationSchemas(caller), ...this.gitProviders.operationSchemas(caller), ...this.workspaceFiles.operationSchemas(caller), ...this.groups.operationSchemas(caller), ...this.projectRuntime.operationSchemas(caller), ...this.heartbeat.operationSchemas(caller), ...this.worktreeRuntime.operationSchemas(caller), ...this.cliMcp.operationSchemas(caller), ...this.taskAttachments.operationSchemas(caller), ...this.ui?.operationSchemas(caller) }
    return Object.fromEntries(Object.entries(schemas).map(([operation, schema]) => [operation, {
      ...schema, handle: (payload: JsonValue, signal: AbortSignal) => this.invoke(operation, payload, caller, signal)
    }]))
  }

  async invoke(operation: string, payload: JsonValue, caller: DesktopCallerContext, signal: AbortSignal): Promise<JsonValue> {
    if (this.closed) throw new ServiceProtocolError('DISCONNECTED')
    if (caller.engineEpoch !== this.epoch) throw new ServiceProtocolError('STALE_EPOCH')
    return this.owner.run(async (_services, ownerSignal) => {
      const combined = new AbortController()
      const abort = (): void => combined.abort()
      signal.addEventListener('abort', abort, { once: true }); ownerSignal.addEventListener('abort', abort, { once: true })
      if (signal.aborted || ownerSignal.aborted) abort()
      try {
        if (Object.hasOwn(UI_DESKTOP_CODECS, operation)) {
          if (!this.ui) throw new ServiceProtocolError('UNKNOWN_OPERATION')
          return await this.ui.registry.invoke(operation, payload, caller, combined.signal)
        }
        if (Object.hasOwn(CLI_MCP_CODECS, operation)) return await this.cliMcp.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(TASK_ATTACHMENT_CODECS, operation)) return await this.taskAttachments.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(HEARTBEAT_CODECS, operation)) return await this.heartbeat.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(WORKTREE_RUNTIME_CODECS, operation)) return await this.worktreeRuntime.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(TASK_GROUP_CODECS, operation)) return await this.groups.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(PROJECT_RUNTIME_CODECS, operation)) return await this.projectRuntime.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(WORKSPACE_FILE_CODECS, operation)) return await this.workspaceFiles.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(GIT_PROVIDER_CODECS, operation)) return await this.gitProviders.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(VOICE_MANAGEMENT_CODECS, operation)) {
          if (!this.voice) throw new ServiceProtocolError('UNKNOWN_OPERATION')
          return await this.voice.registry.invoke(operation, payload, caller, combined.signal)
        }
        if (Object.hasOwn(MOBILE_CODECS, operation)) {
          if (!this.mobile) throw new ServiceProtocolError('UNKNOWN_OPERATION')
          return await this.mobile.registry.invoke(operation, payload, caller, combined.signal)
        }
        if (Object.hasOwn(AGENT_INSTALLER_CODECS, operation)) return await this.agentInstaller.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(ARTIFACT_CODECS, operation)) return await this.artifacts.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(SESSION_CONTEXT_CODECS, operation)) return await this.sessionContext.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(CLAUDE_PLUGIN_CODECS, operation)) return await this.claudePlugins.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(TASK_SOURCE_PLUGIN_CODECS, operation)) return await this.sourcePlugins.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(CONNECTOR_CODECS, operation)) {
          if (!this.connectors) throw new ServiceProtocolError('UNKNOWN_OPERATION')
          return await this.connectors.registry.invoke(operation, payload, caller, combined.signal)
        }
        if (Object.hasOwn(MCP_CODECS, operation)) return await this.mcp.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(TASK_SOURCE_CODECS, operation)) return await this.sources.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(PRODUCTION_SETTINGS_CODECS, operation)) return await this.settings.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(TERMINAL_COMMAND_CODECS, operation)) return await this.terminals.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(TASK_LIFECYCLE_CODECS, operation)) return await this.tasks.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(PRODUCTION_AGENT_CODECS, operation)) return await this.lifecycle.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(COMMANDER_COMMAND_CODECS, operation)) return await this.commander.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(DATABASE_COMMAND_CODECS, operation)) return await this.database.registry.invoke(operation, payload, caller, combined.signal)
        if ((CONFIGURATION_CONTENT_OPERATIONS as readonly string[]).includes(operation) && Object.hasOwn(CONFIGURATION_COMMAND_CODECS, operation))
          return await this.content.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(AGENT_CONFIGURATION_CODECS, operation)) return await this.agents.registry.invoke(operation, payload, caller, combined.signal)
        throw new ServiceProtocolError('UNKNOWN_OPERATION')
      } finally { signal.removeEventListener('abort', abort); ownerSignal.removeEventListener('abort', abort) }
    })
  }
}
