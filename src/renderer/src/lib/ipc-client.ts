import type { Task, CreateTaskDTO, UpdateTaskDTO, FileAttachment, Agent, CreateAgentDTO, UpdateAgentDTO, McpServer, CreateMcpServerDTO, UpdateMcpServerDTO, Skill, CreateSkillDTO, UpdateSkillDTO, Secret, CreateSecretDTO, UpdateSecretDTO, TaskSource, CreateTaskSourceDTO, UpdateTaskSourceDTO, SyncResult, PluginMeta, ConfigFieldOption, ActionResult, SourceUser, ReassignResult, MarketplaceSource, InstalledPlugin, DiscoverablePlugin, MarketplaceCatalog, PluginResources } from '@/types'
import type { AgentOutputEvent, AgentOutputBatchEvent, AgentStatusEvent, GhCliStatus, GlabCliStatus, TeaCliStatus, GitHubRepo, WorktreeProgressEvent, WorkspaceCleanupProgressEvent, McpTestResult, AgentMessageAttachment, TranscriptPartRecord, TranscriptChangedEvent, AgentSessionStartResult, AgentStartQueueChangedEvent, QueuedAgentStart } from '@/types/electron'
import type { ArtifactApi } from '@shared/artifacts'
import type {
  MicrophonePermission,
  VoiceActionOutcome,
  VoiceModelState,
  VoiceRuntimeProgressEvent,
  VoiceRuntimeStatus,
  VoiceSnapshot,
  VoiceStateEvent,
  VoiceTurnMode,
  VoiceUiContext,
  VoiceViewName
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
import type { CommanderEvent, CommanderListSessionsRequest, CommanderMessage, CommanderSession } from '@shared/commander'
import type {
  ConnectorBridgeCredentialInput,
  ConnectorBridgeCredentialStatus,
  ConnectorBridgeCredentialStorage,
  ConnectorBridgeInstance,
  ConnectorBridgePiece,
  ConnectorBridgeSetCredentialsResult,
  ConnectorBridgeSyncStatus
} from '@shared/connector-bridge'
import type { CliMcpMutationResult, CliMcpProbeResult, CliMcpServerRef, CliMcpSnapshot, CliMcpUpsertRequest } from '@shared/cli-mcp-config'
import type {
  ProjectRecord, CreateProjectData, UpdateProjectData,
  ProjectRepoRecord, CreateProjectRepoData, UpdateProjectRepoData,
  ProjectResourceRecord, CreateProjectResourceData, UpdateProjectResourceData
} from '@shared/projects'

export const taskApi = {
  /** Every project's tasks, or one project's when `projectId` is given. */
  getAll: (projectId?: string): Promise<Task[]> => {
    return window.electronAPI.db.getTasks(projectId)
  },

  getById: (id: string): Promise<Task | undefined> => {
    return window.electronAPI.db.getTask(id)
  },

  create: (data: CreateTaskDTO): Promise<Task> => {
    return window.electronAPI.db.createTask(data)
  },

  update: (id: string, data: UpdateTaskDTO): Promise<Task | undefined> => {
    return window.electronAPI.db.updateTask(id, data)
  },

  delete: (id: string): Promise<boolean> => {
    return window.electronAPI.db.deleteTask(id)
  },

  getSubtasks: (parentId: string): Promise<Task[]> => {
    return window.electronAPI.db.getSubtasks(parentId)
  },

  reorderSubtasks: (parentId: string, orderedIds: string[]): Promise<boolean> => {
    return window.electronAPI.db.reorderSubtasks(parentId, orderedIds)
  },

  /** The Mastermind's task row id. Hidden from getAll, so it is asked for by role. */
  getCoordinatorTaskId: (): Promise<string | null> => {
    return window.electronAPI.tasks.getCoordinatorTaskId()
  }
}

export const artifactApi: ArtifactApi = {
  scan: (taskId) => window.electronAPI.artifacts.scan(taskId),
  read: (taskId, relativePath) => window.electronAPI.artifacts.read(taskId, relativePath),
  copyFile: (taskId, relativePath) => window.electronAPI.artifacts.copyFile(taskId, relativePath)
}

export const mcpServerApi = {
  getAll: (): Promise<McpServer[]> => {
    return window.electronAPI.mcpServers.getAll()
  },

  create: (data: CreateMcpServerDTO): Promise<McpServer> => {
    return window.electronAPI.mcpServers.create(data)
  },

  update: (id: string, data: UpdateMcpServerDTO): Promise<McpServer | undefined> => {
    return window.electronAPI.mcpServers.update(id, data)
  },

  delete: (id: string): Promise<boolean> => {
    return window.electronAPI.mcpServers.delete(id)
  },

  testConnection: (data: { id?: string; name: string; type?: 'local' | 'remote'; command?: string; args?: string[]; url?: string; headers?: Record<string, string>; environment?: Record<string, string> }): Promise<McpTestResult> => {
    return window.electronAPI.mcpServers.testConnection(data)
  },

  startOAuthFlow: (mcpServerId: string): Promise<{ needsManualClientId?: boolean }> => {
    return window.electronAPI.mcpServers.startOAuthFlow(mcpServerId)
  },

  getOAuthStatus: (mcpServerId: string): Promise<{ connected: boolean; expiresAt?: string }> => {
    return window.electronAPI.mcpServers.getOAuthStatus(mcpServerId)
  },

  revokeOAuthToken: (mcpServerId: string): Promise<void> => {
    return window.electronAPI.mcpServers.revokeOAuthToken(mcpServerId)
  },

  probeForAuth: (serverUrl: string): Promise<{ requiresAuth: boolean }> => {
    return window.electronAPI.mcpServers.probeForAuth(serverUrl)
  },

  submitManualClientId: (mcpServerId: string, clientId: string): Promise<{ needsManualClientId?: boolean }> => {
    return window.electronAPI.mcpServers.submitManualClientId(mcpServerId, clientId)
  }
}

export const agentApi = {
  getAll: (): Promise<Agent[]> => {
    return window.electronAPI.agents.getAll()
  },

  create: (data: CreateAgentDTO): Promise<Agent> => {
    return window.electronAPI.agents.create(data)
  },

  update: (id: string, data: UpdateAgentDTO): Promise<Agent | undefined> => {
    return window.electronAPI.agents.update(id, data)
  },

  delete: (id: string): Promise<boolean> => {
    return window.electronAPI.agents.delete(id)
  },

  /** Starts the main process is holding back behind concurrency limits. */
  getStartQueue: (): Promise<QueuedAgentStart[]> => {
    return window.electronAPI.agents.getStartQueue()
  }
}

export const agentSessionApi = {
  start: (agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean): Promise<AgentSessionStartResult> => {
    return window.electronAPI.agentSession.start(agentId, taskId, workspaceDir, skipInitialPrompt)
  },

  resume: (agentId: string, taskId: string, ocSessionId: string): Promise<{ sessionId: string; ended?: boolean }> => {
    return window.electronAPI.agentSession.resume(agentId, taskId, ocSessionId)
  },

  abort: (sessionId: string): Promise<{ success: boolean }> => {
    return window.electronAPI.agentSession.abort(sessionId)
  },

  stop: (sessionId: string): Promise<{ success: boolean }> => {
    return window.electronAPI.agentSession.stop(sessionId)
  },

  stopByTaskId: (taskId: string): Promise<{ success: boolean; sessionId: string | null }> => {
    return window.electronAPI.agentSession.stopByTaskId(taskId)
  },

  switchAgent: (taskId: string, newAgentId: string): Promise<{ sessionId: string }> => {
    return window.electronAPI.agentSession.switchAgent(taskId, newAgentId)
  },

  send: (sessionId: string, message: string, taskId?: string, agentId?: string, attachments?: AgentMessageAttachment[]): Promise<{ success: boolean; newSessionId?: string }> => {
    return window.electronAPI.agentSession.send(sessionId, message, taskId, agentId, attachments)
  },

  sendByTaskId: (taskId: string, message: string, attachments?: AgentMessageAttachment[]): Promise<{ success: boolean; sessionId: string | null; newSessionId?: string }> => {
    return window.electronAPI.agentSession.sendByTaskId(taskId, message, attachments)
  },

  approve: (sessionId: string, approved: boolean, message?: string, responseType?: 'permission' | 'question', requestId?: string): Promise<{ success: boolean }> => {
    if (requestId) return window.electronAPI.agentSession.approve(sessionId, approved, message, responseType, requestId)
    if (responseType) return window.electronAPI.agentSession.approve(sessionId, approved, message, responseType)
    return window.electronAPI.agentSession.approve(sessionId, approved, message)
  },

  getRawTranscript: (taskId: string): Promise<Array<{ role: string; parts: Array<{ type: string; content?: string; tool?: { name: string; status?: string; input?: string; output?: string; error?: string } }> }>> => {
    return window.electronAPI.agentSession.getRawTranscript(taskId)
  },

  getTranscriptSnapshot: (taskId: string, sinceSeq?: number): Promise<TranscriptPartRecord[]> => {
    return window.electronAPI.agentSession.getTranscriptSnapshot(taskId, sinceSeq)
  },

  getTranscriptDelta: (taskId: string, sinceRev: number): Promise<{ parts: TranscriptPartRecord[]; maxRev: number }> => {
    return window.electronAPI.agentSession.getTranscriptDelta(taskId, sinceRev)
  }
}

export const agentConfigApi = {
  getProviders: (serverUrl?: string, backendType?: string): Promise<{ providers: { id: string; name: string; models: unknown }[]; default: Record<string, string> } | null> => {
    return window.electronAPI.agentConfig.getProviders(serverUrl, backendType)
  }
}

export const shellApi = {
  openPath: (filePath: string): Promise<void> => {
    return window.electronAPI.shell.openPath(filePath)
  },
  showItemInFolder: (filePath: string): Promise<void> => {
    return window.electronAPI.shell.showItemInFolder(filePath)
  },
  readTextFile: (filePath: string): Promise<{ content: string; size: number } | null> => {
    return window.electronAPI.shell.readTextFile(filePath)
  }
}

export const notificationApi = {
  show: (title: string, body: string): Promise<void> => {
    return window.electronAPI.notifications.show(title, body)
  }
}

export const onOverdueCheck = (callback: () => void): (() => void) => {
  return window.electronAPI.onOverdueCheck(callback)
}

export const onTasksRefresh = (callback: () => void): (() => void) => {
  return window.electronAPI.onTasksRefresh(callback)
}

export const attachmentApi = {
  pick: (): Promise<string[]> => {
    return window.electronAPI.attachments.pick()
  },

  save: (taskId: string, filePath: string): Promise<FileAttachment> => {
    return window.electronAPI.attachments.save(taskId, filePath)
  },

  remove: (taskId: string, attachmentId: string): Promise<void> => {
    return window.electronAPI.attachments.remove(taskId, attachmentId)
  },

  open: (taskId: string, attachmentId: string): Promise<void> => {
    return window.electronAPI.attachments.open(taskId, attachmentId)
  },

  download: (taskId: string, attachmentId: string): Promise<void> => {
    return window.electronAPI.attachments.download(taskId, attachmentId)
  }
}

export const onAgentOutput = (callback: (event: AgentOutputEvent) => void): (() => void) => {
  return window.electronAPI.onAgentOutput(callback)
}

export const onAgentOutputBatch = (callback: (event: AgentOutputBatchEvent) => void): (() => void) => {
  return window.electronAPI.onAgentOutputBatch(callback)
}

export const onArtifactUpdated = (callback: (event: { taskId: string; artifact: import('@shared/artifacts').Artifact }) => void): (() => void) => {
  return window.electronAPI.onArtifactUpdated(callback)
}

export const onTranscriptChanged = (callback: (event: TranscriptChangedEvent) => void): (() => void) => {
  return window.electronAPI.onTranscriptChanged(callback)
}

export const onAgentStatus = (callback: (event: AgentStatusEvent) => void): (() => void) => {
  return window.electronAPI.onAgentStatus(callback)
}

export const onAgentStartQueueChanged = (callback: (event: AgentStartQueueChangedEvent) => void): (() => void) => {
  return window.electronAPI.onAgentStartQueueChanged(callback)
}

export const onAgentIncompatibleSession = (callback: (event: { taskId: string; agentId: string; error: string }) => void): (() => void) => {
  return window.electronAPI.onAgentIncompatibleSession(callback)
}

export const onTaskUpdated = (callback: (event: { taskId: string; updates: Partial<Task> }) => void): (() => void) => {
  return window.electronAPI.onTaskUpdated(callback)
}

/** Fires when the main process could not push a completion to the task's source. */
export const onTaskSourceActionFailed = (
  callback: (event: { taskId: string; taskTitle: string; error: string }) => void
): (() => void) => {
  return window.electronAPI.onTaskSourceActionFailed(callback)
}

export const onTaskCreated = (callback: (event: { task: Task }) => void): (() => void) => {
  return window.electronAPI.onTaskCreated(callback)
}

export const onTaskDeleted = (callback: (event: { taskId: string }) => void): (() => void) => {
  return window.electronAPI.onTaskDeleted(callback)
}

export const settingsApi = {
  get: (key: string): Promise<string | null> => {
    return window.electronAPI.settings.get(key)
  },
  set: (key: string, value: string): Promise<void> => {
    return window.electronAPI.settings.set(key, value)
  },
  getAll: (): Promise<Record<string, string>> => {
    return window.electronAPI.settings.getAll()
  }
}

export const updaterApi = {
  check: (): Promise<{ success: boolean; version?: string; error?: string }> => {
    return window.electronAPI?.updater?.check() ?? Promise.resolve({ success: false, error: 'Not available' })
  },
  download: (): Promise<{ success: boolean; error?: string }> => {
    return window.electronAPI?.updater?.download() ?? Promise.resolve({ success: false, error: 'Not available' })
  },
  install: (): Promise<void> => {
    return window.electronAPI?.updater?.install() ?? Promise.resolve()
  },
  getVersion: (): Promise<string> => {
    return window.electronAPI?.updater?.getVersion() ?? Promise.resolve('?.?.?')
  },
  onStatus: (callback: (data: { status: string; version?: string; percent?: number; error?: string; releaseNotes?: string; releaseDate?: string; currentVersion?: string }) => void): (() => void) => {
    return window.electronAPI?.updater?.onStatus(callback) ?? (() => {})
  },
  onMenuCheckForUpdates: (callback: () => void): (() => void) => {
    return window.electronAPI?.updater?.onMenuCheckForUpdates(callback) ?? (() => {})
  }
}

export const mobileApi = {
  getInfo: (): Promise<{
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
  }> => {
    return (
      window.electronAPI?.mobile?.getInfo() ??
      Promise.resolve({ enabled: false, lanAccess: false, sessionIdleDays: 7, url: '', port: 0, lanUrl: null, tunnelUrl: null, tunnelActive: false, remoteMode: 'quick', customUrl: null })
    )
  },
  setAccess: (options: { enabled?: boolean; lanAccess?: boolean; sessionIdleDays?: number }): Promise<{ enabled: boolean; lanAccess: boolean; sessionIdleDays: number; listening: boolean }> => {
    return (
      window.electronAPI?.mobile?.setAccess(options) ??
      Promise.resolve({ enabled: false, lanAccess: false, sessionIdleDays: 7, listening: false })
    )
  },
  startTunnel: (): Promise<{ tunnelUrl: string }> => {
    return window.electronAPI?.mobile?.startTunnel() ?? Promise.resolve({ tunnelUrl: '' })
  },
  stopTunnel: (): Promise<{ success: boolean }> => {
    return window.electronAPI?.mobile?.stopTunnel() ?? Promise.resolve({ success: false })
  },
  setCustomUrl: (url: string): Promise<{ url: string }> => {
    return window.electronAPI?.mobile?.setCustomUrl(url) ?? Promise.resolve({ url: '' })
  },
  clearCustomUrl: (): Promise<{ success: boolean }> => {
    return window.electronAPI?.mobile?.clearCustomUrl() ?? Promise.resolve({ success: false })
  },
  getPendingPin: (): Promise<{ pin: string; pairCodeId: string; expiresAt: number } | null> => {
    return window.electronAPI?.mobile?.getPendingPin() ?? Promise.resolve(null)
  },
  getSessions: (): Promise<{ id: string; device_name: string; paired_at: number; last_seen: number }[]> => {
    return window.electronAPI?.mobile?.getSessions() ?? Promise.resolve([])
  },
  revokeSession: (sessionId: string): Promise<{ success: boolean }> => {
    return window.electronAPI?.mobile?.revokeSession(sessionId) ?? Promise.resolve({ success: false })
  },
  revokeAllSessions: (): Promise<{ success: boolean }> => {
    return window.electronAPI?.mobile?.revokeAllSessions() ?? Promise.resolve({ success: false })
  },
  onPairingInitiated: (fn: (data: { pin: string; pairCodeId: string; expiresAt: number }) => void): (() => void) => {
    return window.electronAPI?.mobile?.onPairingInitiated(fn) ?? (() => {})
  },
  onDeviceConnected: (fn: (data: { sessionId: string; deviceName: string }) => void): (() => void) => {
    return window.electronAPI?.mobile?.onDeviceConnected(fn) ?? (() => {})
  }
}

export const githubApi = {
  checkCli: (): Promise<GhCliStatus> => {
    return window.electronAPI.github.checkCli()
  },
  fetchOrgs: (): Promise<string[]> => {
    return window.electronAPI.github.fetchOrgs()
  },
  fetchOrgRepos: (org: string): Promise<GitHubRepo[]> => {
    return window.electronAPI.github.fetchOrgRepos(org)
  },
  fetchUserRepos: (): Promise<GitHubRepo[]> => {
    return window.electronAPI.github.fetchUserRepos()
  }
}

export const gitlabApi = {
  checkCli: (): Promise<GlabCliStatus> => {
    return window.electronAPI.gitlab.checkCli()
  },
  fetchOrgs: (): Promise<string[]> => {
    return window.electronAPI.gitlab.fetchOrgs()
  },
  fetchOrgRepos: (org: string): Promise<GitHubRepo[]> => {
    return window.electronAPI.gitlab.fetchOrgRepos(org)
  },
  fetchUserRepos: (): Promise<GitHubRepo[]> => {
    return window.electronAPI.gitlab.fetchUserRepos()
  }
}

export const forgejoApi = {
  checkCli: (): Promise<TeaCliStatus> => {
    return window.electronAPI.forgejo.checkCli()
  },
  setLogin: (loginName: string | null): Promise<TeaCliStatus> => {
    return window.electronAPI.forgejo.setLogin(loginName)
  },
  fetchOrgs: (): Promise<string[]> => {
    return window.electronAPI.forgejo.fetchOrgs()
  },
  fetchOrgRepos: (org: string): Promise<GitHubRepo[]> => {
    return window.electronAPI.forgejo.fetchOrgRepos(org)
  },
  fetchUserRepos: (): Promise<GitHubRepo[]> => {
    return window.electronAPI.forgejo.fetchUserRepos()
  }
}

export const gitApi = {
  recordRepoProviders: (repoFullNames: string[], provider: 'github' | 'gitlab' | 'forgejo'): Promise<void> => {
    return window.electronAPI.git.recordRepoProviders(repoFullNames, provider)
  }
}

export const taskSourceApi = {
  /** Every project's sources, or one project's when `projectId` is given. */
  getAll: (projectId?: string): Promise<TaskSource[]> => {
    return window.electronAPI.taskSources.getAll(projectId)
  },

  create: (data: CreateTaskSourceDTO): Promise<TaskSource> => {
    return window.electronAPI.taskSources.create(data)
  },

  update: (id: string, data: UpdateTaskSourceDTO): Promise<TaskSource | undefined> => {
    return window.electronAPI.taskSources.update(id, data)
  },

  delete: (id: string): Promise<boolean> => {
    return window.electronAPI.taskSources.delete(id)
  },

  sync: (sourceId: string): Promise<SyncResult> => {
    return window.electronAPI.taskSources.sync(sourceId)
  },

  exportUpdate: (taskId: string, fields: Record<string, unknown>): Promise<void> => {
    return window.electronAPI.taskSources.exportUpdate(taskId, fields)
  },

  getUsers: (sourceId: string): Promise<SourceUser[]> => {
    return window.electronAPI.taskSources.getUsers(sourceId)
  },

  reassign: (taskId: string, userIds: string[], assigneeDisplay: string): Promise<ReassignResult> => {
    return window.electronAPI.taskSources.reassign(taskId, userIds, assigneeDisplay)
  }
}

export const projectApi = {
  getAll: (opts?: { includeArchived?: boolean }): Promise<ProjectRecord[]> => window.electronAPI.projects.getAll(opts),
  get: (id: string): Promise<ProjectRecord | undefined> => window.electronAPI.projects.get(id),
  getDefault: (): Promise<ProjectRecord | undefined> => window.electronAPI.projects.getDefault(),
  create: (data: CreateProjectData): Promise<ProjectRecord | undefined> => window.electronAPI.projects.create(data),
  update: (id: string, data: UpdateProjectData): Promise<ProjectRecord | undefined> => window.electronAPI.projects.update(id, data),
  archive: (id: string, archived?: boolean): Promise<ProjectRecord | undefined> => window.electronAPI.projects.archive(id, archived),
  reorder: (orderedIds: string[]): Promise<void> => window.electronAPI.projects.reorder(orderedIds),
  /** Moves a top-level task with its subtasks; resolves to the moved rows, or null when refused. */
  moveTask: (taskId: string, projectId: string): Promise<Task[] | null> => window.electronAPI.projects.moveTask(taskId, projectId),

  listRepos: (projectId: string): Promise<ProjectRepoRecord[]> => window.electronAPI.projects.repos.list(projectId),
  addRepo: (projectId: string, data: CreateProjectRepoData): Promise<ProjectRepoRecord | undefined> =>
    window.electronAPI.projects.repos.add(projectId, data),
  updateRepo: (id: string, data: UpdateProjectRepoData): Promise<ProjectRepoRecord | undefined> =>
    window.electronAPI.projects.repos.update(id, data),
  removeRepo: (id: string): Promise<boolean> => window.electronAPI.projects.repos.remove(id),
  reorderRepos: (projectId: string, orderedIds: string[]): Promise<void> =>
    window.electronAPI.projects.repos.reorder(projectId, orderedIds),

  listResources: (projectId: string): Promise<ProjectResourceRecord[]> => window.electronAPI.projects.resources.list(projectId),
  addResource: (projectId: string, data: CreateProjectResourceData): Promise<ProjectResourceRecord | undefined> =>
    window.electronAPI.projects.resources.add(projectId, data),
  updateResource: (id: string, data: UpdateProjectResourceData): Promise<ProjectResourceRecord | undefined> =>
    window.electronAPI.projects.resources.update(id, data),
  removeResource: (id: string): Promise<boolean> => window.electronAPI.projects.resources.remove(id),
  reorderResources: (projectId: string, orderedIds: string[]): Promise<void> =>
    window.electronAPI.projects.resources.reorder(projectId, orderedIds)
}

export const skillApi = {
  getAll: (): Promise<Skill[]> => {
    return window.electronAPI.skills.getAll()
  },

  create: (data: CreateSkillDTO): Promise<Skill> => {
    return window.electronAPI.skills.create(data)
  },

  update: (id: string, data: UpdateSkillDTO): Promise<Skill | undefined> => {
    return window.electronAPI.skills.update(id, data)
  },

  delete: (id: string): Promise<boolean> => {
    return window.electronAPI.skills.delete(id)
  }
}

export const secretApi = {
  getAll: (): Promise<Secret[]> => {
    return window.electronAPI.secrets.getAll()
  },

  create: (data: CreateSecretDTO): Promise<Secret> => {
    return window.electronAPI.secrets.create(data)
  },

  update: (id: string, data: UpdateSecretDTO): Promise<Secret | undefined> => {
    return window.electronAPI.secrets.update(id, data)
  },

  delete: (id: string): Promise<boolean> => {
    return window.electronAPI.secrets.delete(id)
  }
}

export const pluginApi = {
  list: (): Promise<PluginMeta[]> => {
    return window.electronAPI.plugins.list()
  },

  getDocumentation: (pluginId: string): Promise<string | null> => {
    return window.electronAPI.plugins.getDocumentation(pluginId)
  },

  resolveOptions: (pluginId: string, resolverKey: string, config: Record<string, unknown>, mcpServerId?: string, sourceId?: string): Promise<ConfigFieldOption[]> => {
    return window.electronAPI.plugins.resolveOptions(pluginId, resolverKey, config, mcpServerId, sourceId)
  },

  executeAction: (actionId: string, taskId: string, sourceId: string, input?: string): Promise<ActionResult> => {
    return window.electronAPI.plugins.executeAction(actionId, taskId, sourceId, input)
  }
}

// ── Connector-bridge task source (docs/connectors.md) ─────────
// Credentials are write-only: no call returns them.

export const connectorBridgeApi = {
  bridgePieces: (): Promise<ConnectorBridgePiece[]> => window.electronAPI.connectors.bridgePieces(),
  ensureInstance: (pieceName: string, instanceId?: string): Promise<ConnectorBridgeInstance> =>
    window.electronAPI.connectors.ensureInstance(pieceName, instanceId),
  credentialStatus: (instanceId: string): Promise<ConnectorBridgeCredentialStatus> => window.electronAPI.connectors.credentialStatus(instanceId),
  setCredentials: (
    instanceId: string,
    input: ConnectorBridgeCredentialInput,
    storage?: ConnectorBridgeCredentialStorage
  ): Promise<ConnectorBridgeSetCredentialsResult> => window.electronAPI.connectors.setCredentials(instanceId, input, storage),
  clearCredentials: (instanceId: string): Promise<void> => window.electronAPI.connectors.clearCredentials(instanceId),
  syncStatus: (instanceId: string): Promise<ConnectorBridgeSyncStatus> => window.electronAPI.connectors.syncStatus(instanceId)
}

export const claudePluginApi = {
  getMarketplaceSources: (): Promise<MarketplaceSource[]> => {
    return window.electronAPI.claudePlugins.getMarketplaceSources()
  },

  addMarketplaceSource: (data: { name: string; source_type?: string; source_url: string; auto_update?: boolean }): Promise<MarketplaceSource> => {
    return window.electronAPI.claudePlugins.addMarketplaceSource(data)
  },

  removeMarketplaceSource: (id: string): Promise<boolean> => {
    return window.electronAPI.claudePlugins.removeMarketplaceSource(id)
  },

  fetchCatalog: (sourceId: string): Promise<MarketplaceCatalog | null> => {
    return window.electronAPI.claudePlugins.fetchCatalog(sourceId)
  },

  discoverPlugins: (searchQuery?: string): Promise<DiscoverablePlugin[]> => {
    return window.electronAPI.claudePlugins.discoverPlugins(searchQuery)
  },

  getInstalledPlugins: (): Promise<InstalledPlugin[]> => {
    return window.electronAPI.claudePlugins.getInstalledPlugins()
  },

  installPlugin: (pluginName: string, marketplaceId: string, scope?: string): Promise<InstalledPlugin> => {
    return window.electronAPI.claudePlugins.installPlugin(pluginName, marketplaceId, scope)
  },

  uninstallPlugin: (pluginId: string): Promise<boolean> => {
    return window.electronAPI.claudePlugins.uninstallPlugin(pluginId)
  },

  enablePlugin: (pluginId: string): Promise<InstalledPlugin | undefined> => {
    return window.electronAPI.claudePlugins.enablePlugin(pluginId)
  },

  disablePlugin: (pluginId: string): Promise<InstalledPlugin | undefined> => {
    return window.electronAPI.claudePlugins.disablePlugin(pluginId)
  },

  getPluginResources: (pluginId: string): Promise<PluginResources> => {
    return window.electronAPI.claudePlugins.getPluginResources(pluginId)
  }
}

export const worktreeApi = {
  setup: (taskId: string, repos: { fullName: string; defaultBranch: string }[], org: string, provider: 'github' | 'gitlab' | 'forgejo'): Promise<string> => {
    return window.electronAPI.worktree.setup(taskId, repos, org, provider)
  },
  cleanup: (taskId: string, repos: { fullName: string }[], org: string, removeTaskDir?: boolean): Promise<void> => {
    return window.electronAPI.worktree.cleanup(taskId, repos, org, removeTaskDir)
  },
  changes: (taskId: string, repos: { fullName: string }[]): Promise<Array<{ repo: string; diff: string; allFiles?: string[]; workspace?: boolean; error?: string; noWorktree?: boolean; path?: string; branch?: string; pushed?: boolean; prNumber?: number; prUrl?: string; prState?: string; prTitle?: string; ciStatus?: 'passing' | 'failing' | 'pending' | 'none' }>> => {
    return window.electronAPI.worktree.changes(taskId, repos)
  },
  files: (taskId: string, repos: { fullName: string }[]): Promise<Array<{ repo: string; allFiles: string[]; workspace?: boolean; error?: string; noWorktree?: boolean; path?: string }>> => {
    return window.electronAPI.worktree.files(taskId, repos)
  },
  readFile: (taskId: string, repoFullName: string | null, filePath: string): Promise<{ content: string; size: number; binary: boolean; truncated: boolean } | null> => {
    const readFile = window.electronAPI.worktree.readFile
    if (typeof readFile !== 'function') {
      return Promise.reject(new Error('Restart 21x to enable workspace file previews.'))
    }
    return readFile(taskId, repoFullName, filePath)
  },
  runCleanupNow: (): Promise<{ cleaned: number; errors: string[]; nodeModulesCleaned: number }> => {
    return window.electronAPI.worktree.runCleanupNow()
  }
}

export const onWorktreeProgress = (callback: (event: WorktreeProgressEvent) => void): (() => void) => {
  return window.electronAPI.onWorktreeProgress(callback)
}

export const onWorkspaceCleanupProgress = (callback: (event: WorkspaceCleanupProgressEvent) => void): (() => void) => {
  return window.electronAPI.onWorkspaceCleanupProgress(callback)
}

// ── Voice control ───────────────────────────────────────────
// A thin pass-through. The renderer never decides what a command does; it only
// captures audio and shows what the main process reports.

export const voiceApi = {
  getSnapshot: (): Promise<VoiceSnapshot> => window.electronAPI.voice.getSnapshot(),
  setEnabled: (enabled: boolean): Promise<VoiceSnapshot> => window.electronAPI.voice.setEnabled(enabled),
  getPermission: (): Promise<{ status: MicrophonePermission }> => window.electronAPI.voice.getPermission(),
  requestPermission: (): Promise<{ status: MicrophonePermission }> =>
    window.electronAPI.voice.requestPermission(),
  startTurn: (mode: VoiceTurnMode, context: VoiceUiContext): Promise<{ turnId: string } | { error: string }> =>
    window.electronAPI.voice.startTurn(mode, context),
  pushAudio: (turnId: string, chunk: Uint8Array): Promise<void> =>
    window.electronAPI.voice.pushAudio(turnId, chunk),
  endTurn: (turnId: string): Promise<void> => window.electronAPI.voice.endTurn(turnId),
  cancelTurn: (turnId?: string): Promise<void> => window.electronAPI.voice.cancelTurn(turnId),
  confirm: (turnId: string, choice?: { taskId?: string; agentName?: string }): Promise<{ success: boolean }> =>
    window.electronAPI.voice.confirm(turnId, choice),
  dismiss: (turnId: string): Promise<void> => window.electronAPI.voice.dismiss(turnId),
  getRuntime: (): Promise<VoiceRuntimeStatus> => window.electronAPI.voice.getRuntime(),
  installRuntime: (): Promise<VoiceRuntimeStatus> => window.electronAPI.voice.installRuntime(),
  removeRuntime: (): Promise<VoiceRuntimeStatus> => window.electronAPI.voice.removeRuntime(),
  installModel: (id: string): Promise<VoiceModelState> => window.electronAPI.voice.installModel(id),
  removeModel: (id: string): Promise<VoiceModelState[]> => window.electronAPI.voice.removeModel(id),
  selectModel: (id: string): Promise<VoiceModelState[]> => window.electronAPI.voice.selectModel(id),
  removeAllModels: (): Promise<{ success: boolean }> => window.electronAPI.voice.removeAllModels(),
  setCustomModelDir: (dir: string): Promise<VoiceSnapshot> => window.electronAPI.voice.setCustomModelDir(dir),
  pickModelDir: (): Promise<{ dir: string | null }> => window.electronAPI.voice.pickModelDir(),
  setEndpointSilence: (seconds: number): Promise<{ success: boolean }> =>
    window.electronAPI.voice.setEndpointSilence(seconds),
  setShortcut: (accelerator: string): Promise<VoiceSnapshot> => window.electronAPI.voice.setShortcut(accelerator),
  expectAnswer: (turnId: string, taskId?: string): Promise<void> =>
    window.electronAPI.voice.expectAnswer(turnId, taskId),
  /** The user typed rather than spoke, so no answer is expected by voice. */
  answerNotExpected: (taskId?: string): Promise<void> =>
    window.electronAPI?.voice?.answerNotExpected?.(taskId) ?? Promise.resolve(),
  onState: (callback: (event: VoiceStateEvent) => void): (() => void) =>
    window.electronAPI.voice.onState(callback),
  onPartial: (callback: (event: { turnId: string; text: string }) => void): (() => void) =>
    window.electronAPI.voice.onPartial(callback),
  onFinal: (callback: (event: { turnId: string; text: string }) => void): (() => void) =>
    window.electronAPI.voice.onFinal(callback),
  onSegment: (
    callback: (event: { turnId: string; text: string; index: number }) => void
  ): (() => void) => window.electronAPI.voice.onSegment(callback),
  onOutcome: (callback: (event: VoiceActionOutcome) => void): (() => void) =>
    window.electronAPI.voice.onOutcome(callback),
  onStatus: (callback: (event: Partial<VoiceSnapshot> & { model?: VoiceModelState }) => void): (() => void) =>
    window.electronAPI.voice.onStatus(callback),
  onError: (callback: (event: { message: string; code?: string }) => void): (() => void) =>
    window.electronAPI.voice.onError(callback),
  onNavigate: (callback: (event: { destination: VoiceViewName; taskId: string | null }) => void): (() => void) =>
    window.electronAPI.voice.onNavigate(callback),
  onDictate: (callback: (event: { turnId: string; text: string }) => void): (() => void) =>
    window.electronAPI.voice.onDictate(callback),
  onRuntimeProgress: (callback: (event: VoiceRuntimeProgressEvent) => void): (() => void) =>
    window.electronAPI.voice.onRuntimeProgress(callback),
  onHotkey: (callback: (event: { action: string }) => void): (() => void) =>
    window.electronAPI.voice.onHotkey(callback)
}

/** Spoken answers. Main produces the audio; the renderer only plays it. */
export const voiceTtsApi = {
  getSnapshot: (): Promise<VoiceTtsSnapshot> => window.electronAPI.voice.tts.getSnapshot(),
  setEnabled: (enabled: boolean): Promise<VoiceTtsSnapshot> =>
    window.electronAPI.voice.tts.setEnabled(enabled),
  setEngine: (engine: VoiceTtsEngineId): Promise<VoiceTtsSnapshot> =>
    window.electronAPI.voice.tts.setEngine(engine),
  setVoice: (voiceId: string): Promise<VoiceTtsSnapshot> => window.electronAPI.voice.tts.setVoice(voiceId),
  setSpeed: (speed: number): Promise<VoiceTtsSnapshot> => window.electronAPI.voice.tts.setSpeed(speed),
  setMaxChars: (maxChars: number): Promise<VoiceTtsSnapshot> =>
    window.electronAPI.voice.tts.setMaxChars(maxChars),
  setSpeakActionResults: (on: boolean): Promise<VoiceTtsSnapshot> =>
    window.electronAPI.voice.tts.setSpeakActionResults(on),
  setOnlyVoiceTurns: (on: boolean): Promise<VoiceTtsSnapshot> =>
    window.electronAPI.voice.tts.setOnlyVoiceTurns(on),
  installModel: (id: string): Promise<VoiceTtsSnapshot> => window.electronAPI.voice.tts.installModel(id),
  selectModel: (id: string): Promise<VoiceTtsSnapshot> => window.electronAPI.voice.tts.selectModel(id),
  removeModel: (id: string): Promise<VoiceTtsSnapshot> => window.electronAPI.voice.tts.removeModel(id),
  preview: (voiceId: string): Promise<{ spoken: boolean }> => window.electronAPI.voice.tts.preview(voiceId),
  speak: (text: string, taskId?: string): Promise<{ spoken: boolean }> =>
    window.electronAPI.voice.tts.speak(text, taskId),
  stop: (): Promise<void> => window.electronAPI.voice.tts.stop(),
  onSpeechStart: (callback: (event: VoiceSpeechStartEvent) => void): (() => void) =>
    window.electronAPI.voice.tts.onSpeechStart(callback),
  onSpeechChunk: (callback: (event: VoiceSpeechChunkEvent) => void): (() => void) =>
    window.electronAPI.voice.tts.onSpeechChunk(callback),
  onSpeechEnd: (callback: (event: VoiceSpeechEndEvent) => void): (() => void) =>
    window.electronAPI.voice.tts.onSpeechEnd(callback),
  onStatus: (callback: (event: VoiceTtsSnapshot) => void): (() => void) =>
    window.electronAPI.voice.tts.onStatus(callback),
  onModelProgress: (callback: (event: { model: VoiceTtsModelState }) => void): (() => void) =>
    window.electronAPI.voice.tts.onModelProgress(callback)
}

export const browserRecordingApi = {
  start: (panelId: string, title?: string) => window.electronAPI?.browser?.startRecording
    ? window.electronAPI.browser.startRecording(panelId, title)
    : Promise.resolve({ error: 'Browser recording is unavailable.' } as const),
  stop: (panelId: string) => window.electronAPI?.browser?.stopRecording
    ? window.electronAPI.browser.stopRecording(panelId)
    : Promise.resolve({ error: 'Browser recording is unavailable.' } as const),
  status: (panelId: string) => window.electronAPI?.browser?.recordingStatus
    ? window.electronAPI.browser.recordingStatus(panelId)
    : Promise.resolve({ recording: null }),
}

// ── Chat runtime ────────────────────────────────────────────
// A pass-through for the lightweight chat loop (docs/chat-runtime.md). The
// renderer sends history and draws events; every model and tool call happens
// in the main process.

export const chatApi = {
  start: (payload: ChatStartRequest): Promise<{ turnId: string; provider: string; model: string }> =>
    window.electronAPI.chat.start(payload),
  cancel: (turnId: string): Promise<{ cancelled: boolean }> => window.electronAPI.chat.cancel(turnId),
  onEvent: (callback: (event: ChatIpcEvent) => void): (() => void) => window.electronAPI.chat.onEvent(callback)
}

// ── Commander sessions ─────────────────────────────────────
// Persisted Commander chat sessions (docs/commander.md). Main stores every
// message and runs the turns; the renderer lists, sends and draws events.

export const commanderApi = {
  listSessions: (payload?: CommanderListSessionsRequest): Promise<CommanderSession[]> => window.electronAPI.commander.listSessions(payload),
  createSession: (title?: string): Promise<CommanderSession> => window.electronAPI.commander.createSession(title ? { title } : undefined),
  renameSession: (id: string, title: string): Promise<CommanderSession | null> => window.electronAPI.commander.renameSession(id, title),
  archiveSession: (id: string, archived: boolean): Promise<CommanderSession | null> => window.electronAPI.commander.archiveSession(id, archived),
  listMessages: (sessionId: string): Promise<{ messages: CommanderMessage[]; activeTurnId: string | null }> =>
    window.electronAPI.commander.listMessages(sessionId),
  markRead: (sessionId: string): Promise<CommanderSession | null> => window.electronAPI.commander.markRead(sessionId),
  send: (sessionId: string, text: string): Promise<{ turnId: string; message: CommanderMessage }> => window.electronAPI.commander.send(sessionId, text),
  cancel: (sessionId: string): Promise<{ cancelled: boolean }> => window.electronAPI.commander.cancel(sessionId),
  onEvent: (callback: (event: CommanderEvent) => void): (() => void) => window.electronAPI.commander.onEvent(callback)
}

// ── Global MCP config of the coding-agent CLIs ───────────────
// Claude Code, OpenCode and Codex global MCP servers (docs/mcp-global-config.md).

export const cliMcpApi = {
  snapshot: (): Promise<CliMcpSnapshot> => window.electronAPI.cliMcp.snapshot(),
  upsert: (request: CliMcpUpsertRequest): Promise<CliMcpMutationResult> => window.electronAPI.cliMcp.upsert(request),
  remove: (ref: CliMcpServerRef): Promise<CliMcpMutationResult> => window.electronAPI.cliMcp.remove(ref),
  setEnabled: (ref: CliMcpServerRef & { enabled: boolean }): Promise<CliMcpMutationResult> => window.electronAPI.cliMcp.setEnabled(ref),
  setToolEnabled: (ref: CliMcpServerRef & { tool: string; enabled: boolean }): Promise<CliMcpMutationResult> =>
    window.electronAPI.cliMcp.setToolEnabled(ref),
  probe: (ref: CliMcpServerRef): Promise<CliMcpProbeResult> => window.electronAPI.cliMcp.probe(ref)
}
