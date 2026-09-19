import type { TranscriptPartRecord } from '@shared/transcript/types'
import type { BrowserRecordingManifest } from '@shared/browser-recording'
import type { UiCommand } from '@shared/ui-commands'
import type {
  Task,
  CreateTaskDTO,
  UpdateTaskDTO,
  FileAttachment,
  Agent,
  CreateAgentDTO,
  UpdateAgentDTO,
  McpServer,
  CreateMcpServerDTO,
  UpdateMcpServerDTO,
  Skill,
  CreateSkillDTO,
  UpdateSkillDTO,
  Secret,
  CreateSecretDTO,
  UpdateSecretDTO,
  TaskSource,
  CreateTaskSourceDTO,
  UpdateTaskSourceDTO,
  SyncResult,
  PluginMeta,
  ConfigFieldOption,
  ActionResult,
  SourceUser,
  ReassignResult,
  MarketplaceSource,
  InstalledPlugin,
  DiscoverablePlugin,
  MarketplaceCatalog,
  PluginResources,
  HeartbeatLog
} from './index'
import type { PullRequestDetails } from '@shared/artifacts'
import type { ArtifactApi } from '@shared/artifacts'
import type {
  VoiceActionOutcome,
  VoiceModelState,
  VoiceRuntimeProgressEvent,
  VoiceRuntimeStatus,
  VoiceSnapshot,
  VoiceStateEvent,
  VoiceTurnMode,
  VoiceUiContext,
  VoiceViewName,
  MicrophonePermission
} from '@shared/voice'
import type {
  VoiceSpeechChunkEvent,
  VoiceSpeechEndEvent,
  VoiceSpeechStartEvent,
  VoiceTtsEngineId,
  VoiceTtsModelState,
  VoiceTtsSnapshot
} from '@shared/voice-tts'
import type { ChatIpcEvent, ChatStartRequest } from '@shared/chat'
import type { ChatImageInput } from '@shared/chat-images'
import type { CommanderEvent, CommanderListSessionsRequest, CommanderMessage, CommanderSession } from '@shared/commander'
import type { CliMcpMutationResult, CliMcpProbeResult, CliMcpServerRef, CliMcpSnapshot, CliMcpUpsertRequest } from '@shared/cli-mcp-config'
import type {
  ProjectRecord, CreateProjectData, UpdateProjectData,
  ProjectRepoRecord, CreateProjectRepoData, UpdateProjectRepoData,
  ProjectResourceRecord, CreateProjectResourceData, UpdateProjectResourceData,
  ProjectChangedEvent
} from '@shared/projects'
import type { HeldAction, ProjectLimitState } from '@shared/project-limit-types'
import type { MergeGrant, MergeGrantAuditEntry } from '@shared/merge-grants'
import type { ProjectStatus, ProjectStatusHistoryPage } from '@shared/project-status'
import type { ProjectOverviewEntry } from '@shared/project-overview'
import type { CaptainMemory } from '@shared/captain-memory'

export interface AgentSessionStartResult {
  sessionId: string
  /** True when the main process queued the start behind a concurrency limit; sessionId is then ''. */
  queued?: boolean
  queuePosition?: number
  queueReason?: 'agent_limit' | 'global_limit'
}

export interface AgentTaskStartResult {
  action: 'task_started' | 'subtask_started' | 'triage_started' | 'already_running' | 'queued' | 'no_action'
  sessionId?: string
  startedTaskId?: string
  agentId?: string
  queuePosition?: number
  queueReason?: 'agent_limit' | 'global_limit'
}

/** A session start waiting in the main-process queue for a free slot. */
export interface QueuedAgentStart {
  taskId: string
  agentId: string
  reason: 'agent_limit' | 'global_limit'
  queuedAt: string
  /** 1-based. */
  position: number
}

export interface AgentStartQueueChangedEvent {
  queue: QueuedAgentStart[]
  /** Set when a queued start was attempted and failed. */
  failed?: { taskId: string; error: string }
}

export interface AgentSessionSuccessResult {
  success: boolean
}

export interface AgentMessageAttachment {
  id: string
  filename: string
  size: number
  mime_type: string
}

export interface AgentStatusEvent {
  sessionId: string
  agentId: string
  taskId: string
  status: import('@/stores/agent-store').SessionStatus
}

/** A durable transcript projection part (the single source of truth for rendering). */
export type { TranscriptPartRecord }

/** Payload of the transcript:changed delta push. */
export interface TranscriptChangedEvent {
  reloadRequired?: boolean
  taskId: string
  parts: TranscriptPartRecord[]
  maxRev: number
}

export interface McpTestResult {
  status: 'connected' | 'failed'
  error?: string
  errorDetail?: string
  toolCount?: number
  tools?: { name: string; description: string }[]
}

export interface GhCliStatus {
  installed: boolean
  authenticated: boolean
  username?: string
}

export interface GitHubRepo {
  name: string
  fullName: string
  defaultBranch: string
  cloneUrl: string
  description: string
  isPrivate: boolean
}

export interface HeartbeatStatusResult {
  enabled: boolean
  intervalMinutes: number | null
  lastCheckAt: string | null
  nextCheckAt: string | null
  hasHeartbeatFile: boolean
}

export interface HeartbeatAlertEvent {
  taskId: string
  title: string
  summary: string
}

export interface WorktreeProgressEvent {
  taskId: string
  repo: string
  step: string
  done: boolean
  error?: string
}

export interface WorkspaceCleanupProgressEvent {
  phase: 'starting' | 'scanning' | 'cleaning' | 'pruning' | 'done'
  current: number
  total: number
  message?: string
  cleaned?: number
  nodeModulesCleaned?: number
  errors?: string[]
}

export interface ToolStatus {
  installed: boolean
  version: string | null
  supported?: boolean
  reason?: string | null
}

export interface GlabCliStatus {
  installed: boolean
  authenticated: boolean
  username?: string
}

export type TeaStatusCode =
  | 'ready'
  | 'not-installed'
  | 'no-login'
  | 'login-selection-required'
  | 'login-not-found'
  | 'unauthorized'
  | 'unreachable'
  | 'error'

export interface TeaLogin {
  name: string
  url: string
  sshHost: string
  user: string
  isDefault: boolean
}

/** Status of the tea CLI used for Forgejo. Credentials stay inside tea. */
export interface TeaCliStatus {
  installed: boolean
  authenticated: boolean
  username?: string
  login?: string
  serverUrl?: string
  logins: TeaLogin[]
  code: TeaStatusCode
  message?: string
}

interface ElectronAPI {
  db: {
    getTasks: (projectId?: string) => Promise<Task[]>
    getTask: (id: string) => Promise<Task | undefined>
    createTask: (data: CreateTaskDTO) => Promise<Task>
    updateTask: (id: string, data: UpdateTaskDTO) => Promise<Task | undefined>
    deleteTask: (id: string) => Promise<boolean>
    getSubtasks: (parentId: string) => Promise<Task[]>
    reorderSubtasks: (parentId: string, orderedIds: string[]) => Promise<boolean>
  }
  tasks: {
    getWorkspaceDir: (taskId: string) => Promise<string>
    getCoordinatorTaskId: (projectId?: string) => Promise<string | null>
  }
  /** The preload bridge always exposes every artifact capability, including
   * the desktop-only file clipboard action. */
  artifacts: Required<ArtifactApi>
  mcpServers: {
    getAll: () => Promise<McpServer[]>
    create: (data: CreateMcpServerDTO) => Promise<McpServer>
    update: (id: string, data: UpdateMcpServerDTO) => Promise<McpServer | undefined>
    delete: (id: string) => Promise<boolean>
    testConnection: (data: { id?: string; name: string; type?: 'local' | 'remote'; command?: string; args?: string[]; url?: string; headers?: Record<string, string>; environment?: Record<string, string> }) => Promise<McpTestResult>
    startOAuthFlow: (mcpServerId: string) => Promise<{ needsManualClientId?: boolean }>
    getOAuthStatus: (mcpServerId: string) => Promise<{ connected: boolean; expiresAt?: string }>
    revokeOAuthToken: (mcpServerId: string) => Promise<void>
    probeForAuth: (serverUrl: string) => Promise<{ requiresAuth: boolean }>
    submitManualClientId: (mcpServerId: string, clientId: string) => Promise<{ needsManualClientId?: boolean }>
  }
  cliMcp: {
    snapshot: () => Promise<CliMcpSnapshot>
    upsert: (request: CliMcpUpsertRequest) => Promise<CliMcpMutationResult>
    remove: (ref: CliMcpServerRef) => Promise<CliMcpMutationResult>
    setEnabled: (ref: CliMcpServerRef & { enabled: boolean }) => Promise<CliMcpMutationResult>
    setToolEnabled: (ref: CliMcpServerRef & { tool: string; enabled: boolean }) => Promise<CliMcpMutationResult>
    probe: (ref: CliMcpServerRef) => Promise<CliMcpProbeResult>
  }
  agents: {
    getAll: () => Promise<Agent[]>
    create: (data: CreateAgentDTO) => Promise<Agent>
    update: (id: string, data: UpdateAgentDTO) => Promise<Agent | undefined>
    delete: (id: string) => Promise<boolean>
    getStartQueue: () => Promise<QueuedAgentStart[]>
  }
  agentSession: {
    start: (agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean) => Promise<AgentSessionStartResult>
    startTask: (taskId: string) => Promise<AgentTaskStartResult>
    resume: (agentId: string, taskId: string, ocSessionId: string) => Promise<AgentSessionStartResult & { ended?: boolean }>
    abort: (sessionId: string) => Promise<AgentSessionSuccessResult>
    stop: (sessionId: string) => Promise<AgentSessionSuccessResult>
    stopByTaskId: (taskId: string) => Promise<AgentSessionSuccessResult & { sessionId: string | null }>
    switchAgent: (taskId: string, newAgentId: string) => Promise<AgentSessionStartResult>
    send: (sessionId: string, message: string, taskId?: string, agentId?: string, attachments?: AgentMessageAttachment[]) => Promise<AgentSessionSuccessResult & { newSessionId?: string }>
    sendByTaskId: (taskId: string, message: string, attachments?: AgentMessageAttachment[]) => Promise<AgentSessionSuccessResult & { sessionId: string | null; newSessionId?: string }>
    approve: (sessionId: string, approved: boolean, message?: string, responseType?: 'permission' | 'question', requestId?: string) => Promise<AgentSessionSuccessResult>
    getRawTranscript: (taskId: string) => Promise<Array<{ role: string; parts: Array<{ type: string; content?: string; tool?: { name: string; status?: string; input?: string; output?: string; error?: string } }> }>>
    getTranscriptSnapshot: (taskId: string, sinceSeq?: number) => Promise<TranscriptPartRecord[]>
    getTranscriptDelta: (taskId: string, sinceRev: number) => Promise<{ parts: TranscriptPartRecord[]; maxRev: number }>
  }
  agentConfig: {
    getProviders: (serverUrl?: string, backendType?: string) => Promise<{ providers: { id: string; name: string; models: unknown }[]; default: Record<string, string> } | null>
  }
  attachments: {
    pick: () => Promise<string[]>
    save: (taskId: string, filePath: string) => Promise<FileAttachment>
    remove: (taskId: string, attachmentId: string) => Promise<void>
    open: (taskId: string, attachmentId: string) => Promise<void>
    download: (taskId: string, attachmentId: string) => Promise<void>
  }
  /** Chat image attachments (#144). */
  chatImages: {
    /** Main-process clipboard fallback for a paste whose event carried no image. */
    readClipboard: () => Promise<{ images: ChatImageInput[]; errors: string[] }>
    /** Stores pasted images as task attachments; resolves with the new attachments. */
    saveToTask: (taskId: string, images: ChatImageInput[]) => Promise<FileAttachment[]>
  }
  shell: {
    openPath: (filePath: string) => Promise<void>
    showItemInFolder: (filePath: string) => Promise<void>
    readTextFile: (filePath: string) => Promise<{ content: string; size: number } | null>
    openExternal: (url: string) => Promise<void>
  }
  oauth: {
    startFlow: (provider: string, config: Record<string, unknown>) => Promise<string>
    exchangeCode: (provider: string, code: string, state: string, sourceId: string) => Promise<void>
    startLocalhostFlow: (provider: string, config: Record<string, unknown>, sourceId: string) => Promise<void>
    getValidToken: (sourceId: string) => Promise<string | null>
    revokeToken: (sourceId: string) => Promise<void>
  }
  notifications: {
    show: (title: string, body: string) => Promise<void>
  }
  settings: {
    get: (key: string) => Promise<string | null>
    set: (key: string, value: string) => Promise<void>
    getAll: () => Promise<Record<string, string>>
  }
  env: {
    get: (key: string) => Promise<string | null>
  }
  github: {
    checkCli: () => Promise<GhCliStatus>
    fetchOrgs: () => Promise<string[]>
    fetchOrgRepos: (org: string) => Promise<GitHubRepo[]>
    fetchUserRepos: () => Promise<GitHubRepo[]>
    fetchPullRequestDetails: (url: string) => Promise<PullRequestDetails>
  }
  gitlab: {
    checkCli: () => Promise<GlabCliStatus>
    fetchOrgs: () => Promise<string[]>
    fetchOrgRepos: (org: string) => Promise<GitHubRepo[]>
    fetchUserRepos: () => Promise<GitHubRepo[]>
  }
  forgejo: {
    checkCli: () => Promise<TeaCliStatus>
    setLogin: (loginName: string | null) => Promise<TeaCliStatus>
    fetchOrgs: () => Promise<string[]>
    fetchOrgRepos: (org: string) => Promise<GitHubRepo[]>
    fetchUserRepos: () => Promise<GitHubRepo[]>
  }
  git: {
    recordRepoProviders: (repoFullNames: string[], provider: 'github' | 'gitlab' | 'forgejo') => Promise<void>
  }
  worktree: {
    setup: (taskId: string, repos: { fullName: string; defaultBranch: string }[], org: string, provider: 'github' | 'gitlab' | 'forgejo') => Promise<string>
    cleanup: (taskId: string, repos: { fullName: string }[], org: string, removeTaskDir?: boolean) => Promise<void>
    changes: (taskId: string, repos: { fullName: string }[]) => Promise<Array<{ repo: string; diff: string; allFiles?: string[]; workspace?: boolean; error?: string; noWorktree?: boolean; path?: string; branch?: string; pushed?: boolean; prNumber?: number; prUrl?: string; prState?: string; prTitle?: string; ciStatus?: 'passing' | 'failing' | 'pending' | 'none' }>>
    files: (taskId: string, repos: { fullName: string }[]) => Promise<Array<{ repo: string; allFiles: string[]; workspace?: boolean; error?: string; noWorktree?: boolean; path?: string }>>
    readFile: (taskId: string, repoFullName: string | null, filePath: string) => Promise<{ content: string; size: number; binary: boolean; truncated: boolean } | null>
    runCleanupNow: () => Promise<{ cleaned: number; errors: string[]; nodeModulesCleaned: number }>
  }
  taskSources: {
    getAll: (projectId?: string) => Promise<TaskSource[]>
    create: (data: CreateTaskSourceDTO) => Promise<TaskSource>
    update: (id: string, data: UpdateTaskSourceDTO) => Promise<TaskSource | undefined>
    delete: (id: string) => Promise<boolean>
    sync: (sourceId: string) => Promise<SyncResult>
    exportUpdate: (taskId: string, fields: Record<string, unknown>) => Promise<void>
    getUsers: (sourceId: string) => Promise<SourceUser[]>
    reassign: (taskId: string, userIds: string[], assigneeDisplay: string) => Promise<ReassignResult>
  }
  projects: {
    getAll: (opts?: { includeArchived?: boolean }) => Promise<ProjectRecord[]>
    get: (id: string) => Promise<ProjectRecord | undefined>
    getDefault: () => Promise<ProjectRecord | undefined>
    create: (data: CreateProjectData) => Promise<ProjectRecord | undefined>
    update: (id: string, data: UpdateProjectData) => Promise<ProjectRecord | undefined>
    archive: (id: string, archived?: boolean) => Promise<ProjectRecord | undefined>
    reorder: (orderedIds: string[]) => Promise<void>
    getCaptainMemory: (projectId: string) => Promise<CaptainMemory | null>
    moveTask: (taskId: string, projectId: string) => Promise<Task[] | null>
    onChanged: (callback: (event: ProjectChangedEvent) => void) => () => void
    /** Project status (#58). */
    getStatus: (projectId: string) => Promise<ProjectStatus>
    /** Status history (#72): one page of the journal, newest first. */
    getStatusHistory: (projectId: string, query?: { limit?: number; cursor?: string | null }) => Promise<ProjectStatusHistoryPage>
    onStatusChanged: (callback: (event: { projectId: string }) => void) => () => void
    repos: {
      list: (projectId: string) => Promise<ProjectRepoRecord[]>
      add: (projectId: string, data: CreateProjectRepoData) => Promise<ProjectRepoRecord | undefined>
      update: (id: string, data: UpdateProjectRepoData) => Promise<ProjectRepoRecord | undefined>
      remove: (id: string) => Promise<boolean>
      reorder: (projectId: string, orderedIds: string[]) => Promise<void>
    }
    resources: {
      list: (projectId: string) => Promise<ProjectResourceRecord[]>
      add: (projectId: string, data: CreateProjectResourceData) => Promise<ProjectResourceRecord | undefined>
      update: (id: string, data: UpdateProjectResourceData) => Promise<ProjectResourceRecord | undefined>
      remove: (id: string) => Promise<boolean>
      reorder: (projectId: string, orderedIds: string[]) => Promise<void>
    }
  }
  /** Per-project limits and the global pause (#65). */
  projectLimits: {
    getState: (projectId: string) => Promise<ProjectLimitState>
    isAllPaused: () => Promise<boolean>
    pauseAll: (paused: boolean) => Promise<boolean>
  }
  /** Captain tool calls held by the escalation policy (#66). */
  escalation: {
    listHeld: (projectId?: string) => Promise<HeldAction[]>
    approve: (id: string) => Promise<{ ok: boolean; result?: unknown; error?: string }>
    reject: (id: string, note?: string) => Promise<boolean>
    onHeldChanged: (callback: (event: { held: HeldAction[] }) => void) => () => void
  }
  /** Merge grants the user gave Captains (#137). */
  mergeGrants: {
    noteTyped: (taskId: string, text: string) => Promise<void>
    listActive: (projectId?: string) => Promise<MergeGrant[]>
    audit: (projectId: string) => Promise<MergeGrantAuditEntry[]>
    revoke: (id: string) => Promise<{ ok: boolean; error?: string }>
    onChanged: (callback: (event: { projectId: string }) => void) => () => void
  }
  /** The all-projects overview (#63). */
  overview: {
    getAllStatuses: () => Promise<ProjectOverviewEntry[]>
  }
  skills: {
    getAll: () => Promise<Skill[]>
    create: (data: CreateSkillDTO) => Promise<Skill>
    update: (id: string, data: UpdateSkillDTO) => Promise<Skill | undefined>
    delete: (id: string) => Promise<boolean>
    /** Promote to global (null) or move into a project (#74). */
    setProject: (id: string, projectId: string | null) => Promise<Skill | undefined>
    onChanged: (callback: (event: { skillId: string; kind: string }) => void) => () => void
  }
  secrets: {
    getAll: () => Promise<Secret[]>
    create: (data: CreateSecretDTO) => Promise<Secret>
    update: (id: string, data: UpdateSecretDTO) => Promise<Secret | undefined>
    delete: (id: string) => Promise<boolean>
  }
  plugins: {
    list: () => Promise<PluginMeta[]>
    getDocumentation: (pluginId: string) => Promise<string | null>
    resolveOptions: (pluginId: string, resolverKey: string, config: Record<string, unknown>, mcpServerId?: string, sourceId?: string) => Promise<ConfigFieldOption[]>
    executeAction: (actionId: string, taskId: string, sourceId: string, input?: string) => Promise<ActionResult>
  }
  connectors: {
    bridgePieces: () => Promise<import('@shared/connector-bridge').ConnectorBridgePiece[]>
    ensureInstance: (pieceName: string, instanceId?: string) => Promise<import('@shared/connector-bridge').ConnectorBridgeInstance>
    credentialStatus: (instanceId: string) => Promise<import('@shared/connector-bridge').ConnectorBridgeCredentialStatus>
    setCredentials: (
      instanceId: string,
      input: import('@shared/connector-bridge').ConnectorBridgeCredentialInput,
      storage?: import('@shared/connector-bridge').ConnectorBridgeCredentialStorage
    ) => Promise<import('@shared/connector-bridge').ConnectorBridgeSetCredentialsResult>
    clearCredentials: (instanceId: string) => Promise<void>
    oauthConnect: (
      instanceId: string,
      input: import('@shared/connector-bridge').ConnectorBridgeOAuthConnectInput,
      storage?: import('@shared/connector-bridge').ConnectorBridgeCredentialStorage
    ) => Promise<import('@shared/connector-bridge').ConnectorBridgeSetCredentialsResult>
    syncStatus: (instanceId: string) => Promise<import('@shared/connector-bridge').ConnectorBridgeSyncStatus>
  }
  claudePlugins: {
    getMarketplaceSources: () => Promise<MarketplaceSource[]>
    addMarketplaceSource: (data: { name: string; source_type?: string; source_url: string; auto_update?: boolean }) => Promise<MarketplaceSource>
    removeMarketplaceSource: (id: string) => Promise<boolean>
    fetchCatalog: (sourceId: string) => Promise<MarketplaceCatalog | null>
    discoverPlugins: (searchQuery?: string) => Promise<DiscoverablePlugin[]>
    getInstalledPlugins: () => Promise<InstalledPlugin[]>
    installPlugin: (pluginName: string, marketplaceId: string, scope?: string) => Promise<InstalledPlugin>
    uninstallPlugin: (pluginId: string) => Promise<boolean>
    enablePlugin: (pluginId: string) => Promise<InstalledPlugin | undefined>
    disablePlugin: (pluginId: string) => Promise<InstalledPlugin | undefined>
    getPluginResources: (pluginId: string) => Promise<PluginResources>
  }
  heartbeat: {
    enable: (taskId: string, intervalMinutes?: number) => Promise<Task | undefined>
    disable: (taskId: string) => Promise<Task | undefined>
    runNow: (taskId: string) => Promise<'sent' | 'no_file' | 'no_agent' | 'in_progress' | 'error'>
    getLogs: (taskId: string, limit?: number) => Promise<HeartbeatLog[]>
    getStatus: (taskId: string) => Promise<HeartbeatStatusResult | null>
    updateInterval: (taskId: string, intervalMinutes: number) => Promise<Task | undefined>
    readFile: (taskId: string) => Promise<string | null>
    writeFile: (taskId: string, content: string) => Promise<boolean>
  }
  app: {
    getVersion: () => Promise<string>
    getLoginItemSettings: () => Promise<{ openAtLogin: boolean; openAsHidden: boolean }>
    setLoginItemSettings: (openAtLogin: boolean) => Promise<{ openAtLogin: boolean; openAsHidden: boolean }>
    getNotificationPermission: () => Promise<'granted' | 'denied'>
    requestNotificationPermission: () => Promise<'granted' | 'denied'>
    getMinimizeToTray: () => Promise<boolean>
    setMinimizeToTray: (enabled: boolean) => Promise<boolean>
    setTitleBarOverlay: (colors: { color: string; symbolColor: string }) => Promise<void>
  }
  mobile: {
    getInfo: () => Promise<{
      enabled: boolean
      lanAccess: boolean
      sessionIdleDays: number
      url: string
      port: number
      lanUrl: string | null
      tunnelUrl: string | null
      tunnelActive: boolean
      remoteMode: 'quick' | 'custom'
      customUrl: string | null
    }>
    setAccess: (options: { enabled?: boolean; lanAccess?: boolean; sessionIdleDays?: number }) => Promise<{ enabled: boolean; lanAccess: boolean; sessionIdleDays: number; listening: boolean }>
    startTunnel: () => Promise<{ tunnelUrl: string }>
    stopTunnel: () => Promise<{ success: boolean }>
    setCustomUrl: (url: string) => Promise<{ url: string }>
    clearCustomUrl: () => Promise<{ success: boolean }>
    getPendingPin: () => Promise<{ pin: string; pairCodeId: string; expiresAt: number } | null>
    getSessions: () => Promise<{ id: string; device_name: string; paired_at: number; last_seen: number }[]>
    revokeSession: (sessionId: string) => Promise<{ success: boolean }>
    revokeAllSessions: () => Promise<{ success: boolean }>
    onPairingInitiated: (fn: (data: { pin: string; pairCodeId: string; expiresAt: number }) => void) => () => void
    onDeviceConnected: (fn: (data: { sessionId: string; deviceName: string }) => void) => () => void
  }
  updater: {
    check: () => Promise<{ success: boolean; version?: string; error?: string }>
    download: () => Promise<{ success: boolean; error?: string }>
    install: () => Promise<void>
    getVersion: () => Promise<string>
    onStatus: (callback: (data: { status: string; version?: string; percent?: number; error?: string; releaseNotes?: string; releaseDate?: string; currentVersion?: string }) => void) => () => void
    onMenuCheckForUpdates: (callback: () => void) => () => void
  }
  agentInstaller: {
    detect: () => Promise<Record<string, { installed: boolean; version: string | null }>>
    install: (agentName: string) => Promise<{ success: boolean; error: string | null; newStatus: Record<string, { installed: boolean; version: string | null }> }>
    onProgress: (callback: (data: { agentName: string; stage: string; output: string; percent: number }) => void) => () => void
  }
  webUtils: {
    getPathForFile: (file: File) => string
  }
  terminal: {
    create: (id: string, cols: number, rows: number, cwd?: string) => Promise<{ pid: number }>
    write: (id: string, data: string) => Promise<void>
    resize: (id: string, cols: number, rows: number) => Promise<void>
    kill: (id: string, expectedPid?: number) => Promise<void>
    getCwd: (id: string, expectedPid?: number) => Promise<{ cwd: string | null }>
    getBuffer: (id: string, lines?: number) => Promise<{ lines: string[] }>
    onData: (callback: (data: { id: string; data: string }) => void) => () => void
    onExit: (callback: (data: { id: string }) => void) => () => void
  }
  onOverdueCheck: (callback: () => void) => () => void
  onTasksRefresh: (callback: () => void) => () => void
  onArtifactUpdated: (callback: (event: { taskId: string; artifact: import('@shared/artifacts').Artifact }) => void) => () => void
  onTranscriptChanged: (callback: (event: TranscriptChangedEvent) => void) => () => void
  onAgentStatus: (callback: (event: AgentStatusEvent) => void) => () => void
  onAgentStartQueueChanged: (callback: (event: AgentStartQueueChangedEvent) => void) => () => void
  onAgentIncompatibleSession: (callback: (event: { taskId: string; agentId: string; error: string }) => void) => () => void
  onTaskUpdated: (callback: (event: { taskId: string; updates: Partial<Task> }) => void) => () => void
  onTaskSourceActionFailed: (callback: (event: { taskId: string; taskTitle: string; error: string }) => void) => () => void
  onTaskCreated: (callback: (event: { task: Task }) => void) => () => void
  onTaskDeleted: (callback: (event: { taskId: string }) => void) => () => void
  onHeartbeatAlert: (callback: (event: HeartbeatAlertEvent) => void) => () => void
  onHeartbeatDisabled: (callback: (event: { taskId: string; reason: string }) => void) => () => void
  onWorktreeProgress: (callback: (event: WorktreeProgressEvent) => void) => () => void
  onWorkspaceCleanupProgress: (callback: (event: WorkspaceCleanupProgressEvent) => void) => () => void
  browser: {
    startRecording: (panelId: string, title?: string) => Promise<{ ok: true; recording: BrowserRecordingManifest } | { error: string }>
    stopRecording: (panelId: string) => Promise<{ ok: true; recording: BrowserRecordingManifest } | { error: string }>
    recordingStatus: (panelId: string) => Promise<{ recording: BrowserRecordingManifest | null }>
    registerBrokerPanel: (payload: { panelId: string; webContentsId: number; taskIds: string[] }) => Promise<{ success: boolean }>
    unregisterBrokerPanel: (panelId: string) => Promise<{ success: boolean }>
    openExternalAuth: (loginUrl: string) => Promise<{ success: boolean; finalUrl: string; cookieCount: number }>
  }
  ui: {
    publishState: (state: Record<string, unknown>) => Promise<void>
    onCommand: (callback: (command: UiCommand) => void) => () => void
  }
  voice: {
    getSnapshot: () => Promise<VoiceSnapshot>
    setEnabled: (enabled: boolean) => Promise<VoiceSnapshot>
    getPermission: () => Promise<{ status: MicrophonePermission }>
    requestPermission: () => Promise<{ status: MicrophonePermission }>
    startTurn: (
      mode: VoiceTurnMode,
      context: VoiceUiContext
    ) => Promise<{ turnId: string } | { error: string }>
    pushAudio: (turnId: string, chunk: Uint8Array) => Promise<void>
    endTurn: (turnId: string) => Promise<void>
    cancelTurn: (turnId?: string) => Promise<void>
    confirm: (turnId: string, choice?: { taskId?: string; agentName?: string }) => Promise<{ success: boolean }>
    dismiss: (turnId: string) => Promise<void>
    getRuntime: () => Promise<VoiceRuntimeStatus>
    installRuntime: () => Promise<VoiceRuntimeStatus>
    removeRuntime: () => Promise<VoiceRuntimeStatus>
    installModel: (id: string) => Promise<VoiceModelState>
    removeModel: (id: string) => Promise<VoiceModelState[]>
    selectModel: (id: string) => Promise<VoiceModelState[]>
    removeAllModels: () => Promise<{ success: boolean }>
    setCustomModelDir: (dir: string) => Promise<VoiceSnapshot>
    pickModelDir: () => Promise<{ dir: string | null }>
    setEndpointSilence: (seconds: number) => Promise<{ success: boolean }>
    setShortcut: (accelerator: string) => Promise<VoiceSnapshot>
    expectAnswer: (turnId: string, taskId?: string) => Promise<void>
    answerNotExpected: (taskId?: string) => Promise<void>
    onState: (callback: (event: VoiceStateEvent) => void) => () => void
    onPartial: (callback: (event: { turnId: string; text: string }) => void) => () => void
    onFinal: (callback: (event: { turnId: string; text: string }) => void) => () => void
    onSegment: (callback: (event: { turnId: string; text: string; index: number }) => void) => () => void
    onOutcome: (callback: (event: VoiceActionOutcome) => void) => () => void
    onStatus: (callback: (event: Partial<VoiceSnapshot> & { model?: VoiceModelState }) => void) => () => void
    onError: (callback: (event: { message: string; code?: string }) => void) => () => void
    onNavigate: (callback: (event: { destination: VoiceViewName; taskId: string | null }) => void) => () => void
    onDictate: (callback: (event: { turnId: string; text: string }) => void) => () => void
    onRuntimeProgress: (callback: (event: VoiceRuntimeProgressEvent) => void) => () => void
    onHotkey: (callback: (event: { action: string }) => void) => () => void
    /** Spoken answers. Main produces the audio; the renderer only plays it. */
    tts: {
      getSnapshot: () => Promise<VoiceTtsSnapshot>
      setEnabled: (enabled: boolean) => Promise<VoiceTtsSnapshot>
      setEngine: (engine: VoiceTtsEngineId) => Promise<VoiceTtsSnapshot>
      setVoice: (voiceId: string) => Promise<VoiceTtsSnapshot>
      setSpeed: (speed: number) => Promise<VoiceTtsSnapshot>
      setMaxChars: (maxChars: number) => Promise<VoiceTtsSnapshot>
      setSpeakActionResults: (on: boolean) => Promise<VoiceTtsSnapshot>
      setOnlyVoiceTurns: (on: boolean) => Promise<VoiceTtsSnapshot>
      installModel: (id: string) => Promise<VoiceTtsSnapshot>
      selectModel: (id: string) => Promise<VoiceTtsSnapshot>
      removeModel: (id: string) => Promise<VoiceTtsSnapshot>
      preview: (voiceId: string) => Promise<{ spoken: boolean }>
      speak: (text: string, taskId?: string) => Promise<{ spoken: boolean }>
      stop: () => Promise<void>
      onSpeechStart: (callback: (event: VoiceSpeechStartEvent) => void) => () => void
      onSpeechChunk: (callback: (event: VoiceSpeechChunkEvent) => void) => () => void
      onSpeechEnd: (callback: (event: VoiceSpeechEndEvent) => void) => () => void
      onStatus: (callback: (event: VoiceTtsSnapshot) => void) => () => void
      onModelProgress: (callback: (event: { model: VoiceTtsModelState }) => void) => () => void
    }
  }
  /** Lightweight chat runtime (docs/chat-runtime.md). */
  chat: {
    start: (payload: ChatStartRequest) => Promise<{ turnId: string; provider: string; model: string }>
    cancel: (turnId: string) => Promise<{ cancelled: boolean }>
    onEvent: (callback: (event: ChatIpcEvent) => void) => () => void
  }
  /** Commander chat sessions (docs/commander.md). */
  commander: {
    listSessions: (payload?: CommanderListSessionsRequest) => Promise<CommanderSession[]>
    createSession: (payload?: { title?: string }) => Promise<CommanderSession>
    renameSession: (id: string, title: string) => Promise<CommanderSession | null>
    archiveSession: (id: string, archived: boolean) => Promise<CommanderSession | null>
    listMessages: (sessionId: string) => Promise<{ messages: CommanderMessage[]; activeTurnId: string | null }>
    markRead: (sessionId: string) => Promise<CommanderSession | null>
    /** The session the view shows, or null when the view is closed (#62 report relay). */
    setActiveSession: (sessionId: string | null) => Promise<void>
    send: (sessionId: string, text: string, images?: ChatImageInput[]) => Promise<{ turnId: string; message: CommanderMessage }>
    /** One stored image's bytes (#144), or null. */
    getImage: (id: string) => Promise<(ChatImageInput & { id: string }) | null>
    cancel: (sessionId: string) => Promise<{ cancelled: boolean }>
    onEvent: (callback: (event: CommanderEvent) => void) => () => void
  }
  /** ElevenLabs speech engine (#64). Answers with the speech snapshot; the key never comes back. */
  voiceElevenLabs: {
    setKey: (key: string) => Promise<VoiceTtsSnapshot>
    clearKey: () => Promise<VoiceTtsSnapshot>
    acceptDisclosure: () => Promise<VoiceTtsSnapshot>
    refresh: () => Promise<VoiceTtsSnapshot>
    setModel: (modelId: string) => Promise<VoiceTtsSnapshot>
  }
  /** Commander voice mode (#64): main speaks the active session's replies and reports. */
  commanderVoice: {
    setActive: (sessionId: string | null) => Promise<{ active: string | null }>
    bargeIn: (sessionId: string) => Promise<{ cancelled: boolean }>
    send: (sessionId: string, text: string) => Promise<{ turnId: string; message: CommanderMessage }>
  }
  onOAuthCallback: (callback: (event: { code: string; state: string }) => void) => () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
