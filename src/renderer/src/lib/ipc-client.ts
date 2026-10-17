import { desktopApi, desktopSupports, electronBrowserApi } from '@/lib/desktop-api'
import type { Task, CreateTaskDTO, UpdateTaskDTO, FileAttachment, Agent, CreateAgentDTO, UpdateAgentDTO, McpServer, CreateMcpServerDTO, UpdateMcpServerDTO, Skill, CreateSkillDTO, UpdateSkillDTO, Secret, CreateSecretDTO, UpdateSecretDTO, TaskSource, CreateTaskSourceDTO, UpdateTaskSourceDTO, SyncResult, PluginMeta, ConfigFieldOption, ActionResult, SourceUser, ReassignResult, MarketplaceSource, InstalledPlugin, DiscoverablePlugin, MarketplaceCatalog, PluginResources } from '@/types'
import type { AgentStatusEvent, GhCliStatus, GlabCliStatus, TeaCliStatus, GitHubRepo, WorktreeProgressEvent, WorkspaceCleanupProgressEvent, McpTestResult, AgentMessageAttachment, TranscriptPartRecord, TranscriptChangedEvent, AgentSessionStartResult, AgentTaskStartResult, AgentStartQueueChangedEvent, QueuedAgentStart } from '@/types/electron'
import type { ArtifactApi } from '@shared/artifacts'
import type {
  MicrophonePermission,
  VoiceActionOutcome,
  VoiceErrorEvent,
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
import type { ChatImageInput } from '@shared/chat-images'
import type { CaptainRuntimeState } from '@shared/captain-runtime'
import type { RolloverPolicy, SessionContextScope, SessionContextSnapshot } from '@shared/session-context'
import type {
  ConnectorBridgeCredentialInput,
  ConnectorBridgeCredentialStatus,
  ConnectorBridgeCredentialStorage,
  ConnectorBridgeInstance,
  ConnectorBridgeOAuthConnectInput,
  ConnectorBridgePiece,
  ConnectorBridgeSetCredentialsResult,
  ConnectorBridgeSyncStatus
} from '@shared/connector-bridge'
import type { CliMcpMutationResult, CliMcpProbeResult, CliMcpServerRef, CliMcpSnapshot, CliMcpUpsertRequest } from '@shared/cli-mcp-config'
import type {
  ProjectRecord, CreateProjectData, UpdateProjectData,
  ProjectRepoRecord, CreateProjectRepoData, UpdateProjectRepoData,
  ProjectResourceRecord, CreateProjectResourceData, UpdateProjectResourceData,
  ProjectChangedEvent
} from '@shared/projects'
import type { ProjectLimitState } from '@shared/project-limit-types'
import type { ProjectConcurrencyState } from '@shared/concurrency'
import type { ProjectStatus, ProjectStatusHistoryPage } from '@shared/project-status'
import type { ProjectOverviewEntry } from '@shared/project-overview'
import type { CaptainMemory } from '@shared/captain-memory'
import type { CreateTaskGroupData, TaskGroupReviewData } from '@shared/task-groups'

export const taskGroupsApi = {
  list: (projectId: string, includeDissolved = false) => desktopApi.taskGroups.list(projectId, includeDissolved),
  get: (id: string) => desktopApi.taskGroups.get(id),
  history: (taskId: string) => desktopApi.taskGroups.history(taskId),
  create: (data: CreateTaskGroupData) => desktopApi.taskGroups.create(data),
  add: (id: string, taskIds: string[]) => desktopApi.taskGroups.add(id, taskIds),
  remove: (id: string, taskId: string) => desktopApi.taskGroups.remove(id, taskId),
  dissolve: (id: string) => desktopApi.taskGroups.dissolve(id),
  move: (id: string, status: string) => desktopApi.taskGroups.move(id, status),
  review: (data: TaskGroupReviewData) => desktopApi.taskGroups.review(data)
}

export const taskApi = {
  /** Every project's tasks, or one project's when `projectId` is given. */
  getAll: (projectId?: string): Promise<Task[]> => {
    return desktopApi.db.getTasks(projectId)
  },

  getById: (id: string): Promise<Task | undefined> => {
    return desktopApi.db.getTask(id)
  },

  create: (data: CreateTaskDTO): Promise<Task> => {
    return desktopApi.db.createTask(data)
  },

  update: (id: string, data: UpdateTaskDTO): Promise<Task | undefined> => {
    return desktopApi.db.updateTask(id, data)
  },

  delete: (id: string): Promise<boolean> => {
    return desktopApi.db.deleteTask(id)
  },

  getSubtasks: (parentId: string): Promise<Task[]> => {
    return desktopApi.db.getSubtasks(parentId)
  },

  reorderSubtasks: (parentId: string, orderedIds: string[]): Promise<boolean> => {
    return desktopApi.db.reorderSubtasks(parentId, orderedIds)
  },

  /** A project's Captain task row id (#55). Hidden from getAll, so it is asked for by project. */
  getCoordinatorTaskId: (projectId?: string): Promise<string | null> => {
    return desktopApi.tasks.getCoordinatorTaskId(projectId)
  }
}

export const artifactApi: ArtifactApi = {
  scan: (taskId) => desktopApi.artifacts.scan(taskId),
  read: (taskId, relativePath) => desktopApi.artifacts.read(taskId, relativePath),
  copyFile: (taskId, relativePath) => desktopApi.artifacts.copyFile(taskId, relativePath)
}

export const mcpServerApi = {
  getAll: (): Promise<McpServer[]> => {
    return desktopApi.mcpServers.getAll()
  },

  create: (data: CreateMcpServerDTO): Promise<McpServer> => {
    return desktopApi.mcpServers.create(data)
  },

  update: (id: string, data: UpdateMcpServerDTO): Promise<McpServer | undefined> => {
    return desktopApi.mcpServers.update(id, data)
  },

  delete: (id: string): Promise<boolean> => {
    return desktopApi.mcpServers.delete(id)
  },

  testConnection: (data: { id?: string; name: string; type?: 'local' | 'remote'; command?: string; args?: string[]; url?: string; headers?: Record<string, string>; environment?: Record<string, string> }): Promise<McpTestResult> => {
    return desktopApi.mcpServers.testConnection(data)
  },

  startOAuthFlow: (mcpServerId: string): Promise<{ needsManualClientId?: boolean }> => {
    return desktopApi.mcpServers.startOAuthFlow(mcpServerId)
  },

  getOAuthStatus: (mcpServerId: string): Promise<{ connected: boolean; expiresAt?: string }> => {
    return desktopApi.mcpServers.getOAuthStatus(mcpServerId)
  },

  revokeOAuthToken: (mcpServerId: string): Promise<void> => {
    return desktopApi.mcpServers.revokeOAuthToken(mcpServerId)
  },

  probeForAuth: (serverUrl: string): Promise<{ requiresAuth: boolean }> => {
    return desktopApi.mcpServers.probeForAuth(serverUrl)
  },

  submitManualClientId: (mcpServerId: string, clientId: string): Promise<{ needsManualClientId?: boolean }> => {
    return desktopApi.mcpServers.submitManualClientId(mcpServerId, clientId)
  }
}

export const agentApi = {
  getAll: (): Promise<Agent[]> => {
    return desktopApi.agents.getAll()
  },

  create: (data: CreateAgentDTO): Promise<Agent> => {
    return desktopApi.agents.create(data)
  },

  update: (id: string, data: UpdateAgentDTO): Promise<Agent | undefined> => {
    return desktopApi.agents.update(id, data)
  },

  delete: (id: string): Promise<boolean> => {
    return desktopApi.agents.delete(id)
  },

  /** Durable starts waiting on capacity, dependencies or retry deadlines. */
  getStartQueue: (): Promise<QueuedAgentStart[]> => {
    return desktopApi.agents.getStartQueue()
  },

  /** Latest durable queue/recovery outcome for one task, including terminal states. */
  getStartRecoveryState: (taskId: string): Promise<QueuedAgentStart | null> => {
    return typeof desktopApi.agents.getStartRecoveryState === 'function'
      ? desktopApi.agents.getStartRecoveryState(taskId)
      : Promise.resolve(null)
  }
}

export const agentSessionApi = {
  start: (agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean): Promise<AgentSessionStartResult> => {
    return desktopApi.agentSession.start(agentId, taskId, workspaceDir, skipInitialPrompt)
  },

  startTask: (taskId: string): Promise<AgentTaskStartResult> => {
    return desktopApi.agentSession.startTask(taskId)
  },

  resume: (agentId: string, taskId: string, ocSessionId: string): Promise<{ sessionId: string; ended?: boolean }> => {
    return desktopApi.agentSession.resume(agentId, taskId, ocSessionId)
  },

  abort: (sessionId: string): Promise<{ success: boolean }> => {
    return desktopApi.agentSession.abort(sessionId)
  },

  stop: (sessionId: string): Promise<{ success: boolean }> => {
    return desktopApi.agentSession.stop(sessionId)
  },

  stopByTaskId: (taskId: string): Promise<{ success: boolean; sessionId: string | null }> => {
    return desktopApi.agentSession.stopByTaskId(taskId)
  },

  switchAgent: (taskId: string, newAgentId: string): Promise<{ sessionId: string }> => {
    return desktopApi.agentSession.switchAgent(taskId, newAgentId)
  },

  send: (sessionId: string, message: string, taskId?: string, agentId?: string, attachments?: AgentMessageAttachment[], deliveryId?: string): Promise<{ success: boolean; newSessionId?: string }> => {
    return desktopApi.agentSession.send(sessionId, message, taskId, agentId, attachments, deliveryId)
  },

  sendByTaskId: (taskId: string, message: string, attachments?: AgentMessageAttachment[], deliveryId?: string): Promise<{ success: boolean; sessionId: string | null; newSessionId?: string }> => {
    return desktopApi.agentSession.sendByTaskId(taskId, message, attachments, deliveryId)
  },

  approve: (sessionId: string, approved: boolean, message?: string, responseType?: 'permission' | 'question', requestId?: string): Promise<{ success: boolean }> => {
    if (requestId) return desktopApi.agentSession.approve(sessionId, approved, message, responseType, requestId)
    if (responseType) return desktopApi.agentSession.approve(sessionId, approved, message, responseType)
    return desktopApi.agentSession.approve(sessionId, approved, message)
  },

  getRawTranscript: (taskId: string): Promise<Array<{ role: string; parts: Array<{ type: string; content?: string; tool?: { name: string; status?: string; input?: string; output?: string; error?: string } }> }>> => {
    return desktopApi.agentSession.getRawTranscript(taskId)
  },

  getTranscriptSnapshot: (taskId: string, sinceSeq?: number): Promise<TranscriptPartRecord[]> => {
    return desktopApi.agentSession.getTranscriptSnapshot(taskId, sinceSeq)
  },

  getTranscriptDelta: (taskId: string, sinceRev: number): Promise<{ parts: TranscriptPartRecord[]; maxRev: number }> => {
    return desktopApi.agentSession.getTranscriptDelta(taskId, sinceRev)
  }
}

export const captainRuntimeApi = {
  get: (projectId: string): Promise<CaptainRuntimeState | null> => desktopApi.captainRuntime.get(projectId),
  switch: (projectId: string, agentId: string): Promise<CaptainRuntimeState> => desktopApi.captainRuntime.switch(projectId, agentId),
  retry: (projectId: string): Promise<CaptainRuntimeState> => desktopApi.captainRuntime.retry(projectId),
  rollback: (projectId: string): Promise<CaptainRuntimeState> => desktopApi.captainRuntime.rollback(projectId)
}

export const agentConfigApi = {
  getProviders: (serverUrl?: string, backendType?: string): Promise<{ providers: { id: string; name: string; models: unknown }[]; default: Record<string, string> } | null> => {
    return desktopApi.agentConfig.getProviders(serverUrl, backendType)
  },
  listModels: (backendType: string): Promise<{ id: string; name: string }[] | null> => {
    return desktopApi.agentConfig.listModels(backendType)
  }
}

export const shellApi = {
  openPath: (filePath: string): Promise<void> => {
    return desktopApi.shell.openPath(filePath)
  },
  showItemInFolder: (filePath: string): Promise<void> => {
    return desktopApi.shell.showItemInFolder(filePath)
  },
  readTextFile: (filePath: string): Promise<{ content: string; size: number } | null> => {
    return desktopApi.shell.readTextFile(filePath)
  }
}

export const notificationApi = {
  show: (title: string, body: string): Promise<void> => {
    return desktopApi.notifications.show(title, body)
  }
}

export const onOverdueCheck = (callback: () => void): (() => void) | undefined => {
  return desktopApi.onOverdueCheck?.(callback)
}

export const onTasksRefresh = (callback: () => void): (() => void) | undefined => {
  return desktopApi.onTasksRefresh?.(callback)
}

// Chat image attachments (#144): the clipboard fallback and task storage.
export const chatImageApi = {
  readClipboard: (): Promise<{ images: ChatImageInput[]; errors: string[] }> =>
    typeof desktopApi.chatImages?.readClipboard === 'function'
      ? desktopApi.chatImages.readClipboard()
      : Promise.resolve({ images: [], errors: [] }),
  saveToTask: (taskId: string, images: ChatImageInput[]): Promise<FileAttachment[]> =>
    desktopApi.chatImages.saveToTask(taskId, images)
}

export const attachmentApi = {
  pick: (): Promise<string[]> => {
    return desktopApi.attachments.pick()
  },

  save: (taskId: string, filePath: string): Promise<FileAttachment> => {
    return desktopApi.attachments.save(taskId, filePath)
  },

  remove: (taskId: string, attachmentId: string): Promise<void> => {
    return desktopApi.attachments.remove(taskId, attachmentId)
  },

  open: (taskId: string, attachmentId: string): Promise<void> => {
    return desktopApi.attachments.open(taskId, attachmentId)
  },

  download: (taskId: string, attachmentId: string): Promise<void> => {
    return desktopApi.attachments.download(taskId, attachmentId)
  }
}

export const onArtifactUpdated = (callback: (event: { taskId: string; artifact: import('@shared/artifacts').Artifact }) => void): (() => void) | undefined => {
  return desktopApi.onArtifactUpdated?.(callback)
}

export const onTranscriptChanged = (callback: (event: TranscriptChangedEvent) => void): (() => void) | undefined => {
  return desktopApi.onTranscriptChanged?.(callback)
}

export const onAgentStatus = (callback: (event: AgentStatusEvent) => void): (() => void) | undefined => {
  return desktopApi.onAgentStatus?.(callback)
}

export const onAgentStartQueueChanged = (callback: (event: AgentStartQueueChangedEvent) => void): (() => void) | undefined => {
  return desktopApi.onAgentStartQueueChanged?.(callback)
}

export const onAgentIncompatibleSession = (callback: (event: { taskId: string; agentId: string; error: string }) => void): (() => void) | undefined => {
  return desktopApi.onAgentIncompatibleSession?.(callback)
}

export const onTaskUpdated = (callback: (event: { taskId: string; updates: Partial<Task> }) => void): (() => void) | undefined => {
  return desktopApi.onTaskUpdated?.(callback)
}

/** Fires when the main process could not push a completion to the task's source. */
export const onTaskSourceActionFailed = (
  callback: (event: { taskId: string; taskTitle: string; error: string }) => void
): (() => void) | undefined => {
  return desktopApi.onTaskSourceActionFailed?.(callback)
}

export const onTaskCreated = (callback: (event: { task: Task }) => void): (() => void) | undefined => {
  return desktopApi.onTaskCreated?.(callback)
}

export const onTaskDeleted = (callback: (event: { taskId: string }) => void): (() => void) | undefined => {
  return desktopApi.onTaskDeleted?.(callback)
}

export const settingsApi = {
  get: (key: string): Promise<string | null> => {
    return desktopApi.settings.get(key)
  },
  set: (key: string, value: string): Promise<void> => {
    return desktopApi.settings.set(key, value)
  },
  getAll: (): Promise<Record<string, string>> => {
    return desktopApi.settings.getAll()
  }
}

/** Capability inspection only; this does not select an update feed or policy. */
export function desktopUpdaterAvailable(): boolean {
  return ['updater.check', 'updater.download', 'updater.install'].every(desktopSupports)
}

export const updaterApi = {
  check: (): Promise<{ success: boolean; version?: string; error?: string }> => {
    return desktopApi?.updater?.check() ?? Promise.resolve({ success: false, error: 'Not available' })
  },
  download: (): Promise<{ success: boolean; error?: string }> => {
    return desktopApi?.updater?.download() ?? Promise.resolve({ success: false, error: 'Not available' })
  },
  install: (): Promise<void> => {
    return desktopApi?.updater?.install() ?? Promise.resolve()
  },
  getVersion: (): Promise<string> => {
    if (desktopSupports('updater.getVersion')) return desktopApi.updater.getVersion()
    if (desktopSupports('app.getVersion')) return desktopApi.app.getVersion()
    return Promise.resolve('?.?.?')
  },
  onStatus: (callback: (data: { status: string; version?: string; percent?: number; error?: string; releaseNotes?: string; releaseDate?: string; currentVersion?: string }) => void): (() => void) | undefined => {
    return desktopApi?.updater?.onStatus?.(callback)
  },
  onMenuCheckForUpdates: (callback: () => void): (() => void) | undefined => {
    return desktopApi?.updater?.onMenuCheckForUpdates?.(callback)
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
      desktopApi?.mobile?.getInfo() ??
      Promise.resolve({ enabled: false, lanAccess: false, sessionIdleDays: 7, url: '', port: 0, lanUrl: null, tunnelUrl: null, tunnelActive: false, remoteMode: 'quick', customUrl: null })
    )
  },
  setAccess: (options: { enabled?: boolean; lanAccess?: boolean; sessionIdleDays?: number }): Promise<{ enabled: boolean; lanAccess: boolean; sessionIdleDays: number; listening: boolean }> => {
    return (
      desktopApi?.mobile?.setAccess(options) ??
      Promise.resolve({ enabled: false, lanAccess: false, sessionIdleDays: 7, listening: false })
    )
  },
  startTunnel: (): Promise<{ tunnelUrl: string }> => {
    return desktopApi?.mobile?.startTunnel() ?? Promise.resolve({ tunnelUrl: '' })
  },
  stopTunnel: (): Promise<{ success: boolean }> => {
    return desktopApi?.mobile?.stopTunnel() ?? Promise.resolve({ success: false })
  },
  setCustomUrl: (url: string): Promise<{ url: string }> => {
    return desktopApi?.mobile?.setCustomUrl(url) ?? Promise.resolve({ url: '' })
  },
  clearCustomUrl: (): Promise<{ success: boolean }> => {
    return desktopApi?.mobile?.clearCustomUrl() ?? Promise.resolve({ success: false })
  },
  getPendingPin: (): Promise<{ pin: string; pairCodeId: string; expiresAt: number } | null> => {
    return desktopApi?.mobile?.getPendingPin() ?? Promise.resolve(null)
  },
  getSessions: (): Promise<{ id: string; device_name: string; paired_at: number; last_seen: number }[]> => {
    return desktopApi?.mobile?.getSessions() ?? Promise.resolve([])
  },
  revokeSession: (sessionId: string): Promise<{ success: boolean }> => {
    return desktopApi?.mobile?.revokeSession(sessionId) ?? Promise.resolve({ success: false })
  },
  revokeAllSessions: (): Promise<{ success: boolean }> => {
    return desktopApi?.mobile?.revokeAllSessions() ?? Promise.resolve({ success: false })
  },
  onPairingInitiated: (fn: (data: { pin: string; pairCodeId: string; expiresAt: number }) => void): (() => void) | undefined => {
    return desktopApi?.mobile?.onPairingInitiated?.(fn)
  },
  onDeviceConnected: (fn: (data: { sessionId: string; deviceName: string }) => void): (() => void) | undefined => {
    return desktopApi?.mobile?.onDeviceConnected?.(fn)
  }
}

export const githubApi = {
  checkCli: (): Promise<GhCliStatus> => {
    return desktopApi.github.checkCli()
  },
  fetchOrgs: (): Promise<string[]> => {
    return desktopApi.github.fetchOrgs()
  },
  fetchOrgRepos: (org: string): Promise<GitHubRepo[]> => {
    return desktopApi.github.fetchOrgRepos(org)
  },
  fetchUserRepos: (): Promise<GitHubRepo[]> => {
    return desktopApi.github.fetchUserRepos()
  }
}

export const gitlabApi = {
  checkCli: (): Promise<GlabCliStatus> => {
    return desktopApi.gitlab.checkCli()
  },
  fetchOrgs: (): Promise<string[]> => {
    return desktopApi.gitlab.fetchOrgs()
  },
  fetchOrgRepos: (org: string): Promise<GitHubRepo[]> => {
    return desktopApi.gitlab.fetchOrgRepos(org)
  },
  fetchUserRepos: (): Promise<GitHubRepo[]> => {
    return desktopApi.gitlab.fetchUserRepos()
  }
}

export const forgejoApi = {
  checkCli: (): Promise<TeaCliStatus> => {
    return desktopApi.forgejo.checkCli()
  },
  setLogin: (loginName: string | null): Promise<TeaCliStatus> => {
    return desktopApi.forgejo.setLogin(loginName)
  },
  fetchOrgs: (): Promise<string[]> => {
    return desktopApi.forgejo.fetchOrgs()
  },
  fetchOrgRepos: (org: string): Promise<GitHubRepo[]> => {
    return desktopApi.forgejo.fetchOrgRepos(org)
  },
  fetchUserRepos: (): Promise<GitHubRepo[]> => {
    return desktopApi.forgejo.fetchUserRepos()
  }
}

export const gitApi = {
  recordRepoProviders: (repoFullNames: string[], provider: 'github' | 'gitlab' | 'forgejo'): Promise<void> => {
    return desktopApi.git.recordRepoProviders(repoFullNames, provider)
  }
}

export const taskSourceApi = {
  /** Every project's sources, or one project's when `projectId` is given. */
  getAll: (projectId?: string): Promise<TaskSource[]> => {
    return desktopApi.taskSources.getAll(projectId)
  },

  create: (data: CreateTaskSourceDTO): Promise<TaskSource> => {
    return desktopApi.taskSources.create(data)
  },

  update: (id: string, data: UpdateTaskSourceDTO): Promise<TaskSource | undefined> => {
    return desktopApi.taskSources.update(id, data)
  },

  delete: (id: string): Promise<boolean> => {
    return desktopApi.taskSources.delete(id)
  },

  sync: (sourceId: string): Promise<SyncResult> => {
    return desktopApi.taskSources.sync(sourceId)
  },

  exportUpdate: (taskId: string, fields: Record<string, unknown>): Promise<void> => {
    return desktopApi.taskSources.exportUpdate(taskId, fields)
  },

  getUsers: (sourceId: string): Promise<SourceUser[]> => {
    return desktopApi.taskSources.getUsers(sourceId)
  },

  reassign: (taskId: string, userIds: string[], assigneeDisplay: string): Promise<ReassignResult> => {
    return desktopApi.taskSources.reassign(taskId, userIds, assigneeDisplay)
  }
}

export const projectApi = {
  getAll: (opts?: { includeArchived?: boolean }): Promise<ProjectRecord[]> => desktopApi.projects.getAll(opts),
  get: (id: string): Promise<ProjectRecord | undefined> => desktopApi.projects.get(id),
  getDefault: (): Promise<ProjectRecord | undefined> => desktopApi.projects.getDefault(),
  create: (data: CreateProjectData): Promise<ProjectRecord | undefined> => desktopApi.projects.create(data),
  update: (id: string, data: UpdateProjectData): Promise<ProjectRecord | undefined> => desktopApi.projects.update(id, data),
  archive: (id: string, archived?: boolean): Promise<ProjectRecord | undefined> => desktopApi.projects.archive(id, archived),
  reorder: (orderedIds: string[]): Promise<void> => desktopApi.projects.reorder(orderedIds),
  /** The memory file the project's Captain keeps (#55); null when the project has no Captain. */
  getCaptainMemory: (projectId: string): Promise<CaptainMemory | null> =>
    desktopApi.projects.getCaptainMemory(projectId),
  /** Moves a top-level task with its subtasks; resolves to the moved rows, or null when refused. */
  moveTask: (taskId: string, projectId: string): Promise<Task[] | null> => desktopApi.projects.moveTask(taskId, projectId),
  onChanged: (callback: (event: ProjectChangedEvent) => void): (() => void) | undefined =>
    typeof desktopApi.projects?.onChanged === 'function' ? desktopApi.projects.onChanged?.(callback) : undefined,
  /** Project status (#58): counts computed now, plus the Captain's latest summary. */
  getStatus: (projectId: string): Promise<ProjectStatus> => desktopApi.projects.getStatus(projectId),
  /** Status history (#72): one page of the Captain's journal, newest first; pass `next_cursor` back for older entries. */
  getStatusHistory: (projectId: string, query?: { limit?: number; cursor?: string | null }): Promise<ProjectStatusHistoryPage> =>
    desktopApi.projects.getStatusHistory(projectId, query),
  /** Fires when the Captain writes a new summary through `update_project_status`. */
  onStatusChanged: (callback: (event: { projectId: string }) => void): (() => void) | undefined =>
    typeof desktopApi.projects.onStatusChanged === 'function' ? desktopApi.projects.onStatusChanged?.(callback) : undefined,

  listRepos: (projectId: string): Promise<ProjectRepoRecord[]> => desktopApi.projects.repos.list(projectId),
  addRepo: (projectId: string, data: CreateProjectRepoData): Promise<ProjectRepoRecord | undefined> =>
    desktopApi.projects.repos.add(projectId, data),
  updateRepo: (id: string, data: UpdateProjectRepoData): Promise<ProjectRepoRecord | undefined> =>
    desktopApi.projects.repos.update(id, data),
  removeRepo: (id: string): Promise<boolean> => desktopApi.projects.repos.remove(id),
  reorderRepos: (projectId: string, orderedIds: string[]): Promise<void> =>
    desktopApi.projects.repos.reorder(projectId, orderedIds),

  listResources: (projectId: string): Promise<ProjectResourceRecord[]> => desktopApi.projects.resources.list(projectId),
  addResource: (projectId: string, data: CreateProjectResourceData): Promise<ProjectResourceRecord | undefined> =>
    desktopApi.projects.resources.add(projectId, data),
  updateResource: (id: string, data: UpdateProjectResourceData): Promise<ProjectResourceRecord | undefined> =>
    desktopApi.projects.resources.update(id, data),
  removeResource: (id: string): Promise<boolean> => desktopApi.projects.resources.remove(id),
  reorderResources: (projectId: string, orderedIds: string[]): Promise<void> =>
    desktopApi.projects.resources.reorder(projectId, orderedIds)
}

/** Per-project limits and the global pause (#65). */
export const projectLimitsApi = {
  getState: (projectId: string): Promise<ProjectLimitState> => desktopApi.projectLimits.getState(projectId),
  isAllPaused: (): Promise<boolean> => desktopApi.projectLimits.isAllPaused(),
  pauseAll: (paused: boolean): Promise<boolean> => desktopApi.projectLimits.pauseAll(paused)
}

/** Captain-managed concurrency under the user-set hard cap (#150). */
export const concurrencyApi = {
  getState: (projectId: string): Promise<ProjectConcurrencyState> => desktopApi.concurrency.getState(projectId),
  setCaptainControl: (projectId: string, enabled: boolean): Promise<{ success: true } | { error: string }> =>
    desktopApi.concurrency.setCaptainControl(projectId, enabled),
  pin: (projectId: string, agentId: string, level: number | null): Promise<{ success: true } | { error: string }> =>
    desktopApi.concurrency.pin(projectId, agentId, level),
  onChanged: (callback: (event: { projectId: string }) => void): (() => void) | undefined =>
    typeof desktopApi.concurrency?.onChanged === 'function' ? desktopApi.concurrency.onChanged?.(callback) : undefined
}


/** The all-projects overview (#63): every active project's status and card facts in one call. */
export const overviewApi = {
  getAllStatuses: (): Promise<ProjectOverviewEntry[]> =>
    typeof desktopApi.overview?.getAllStatuses === 'function' ? desktopApi.overview.getAllStatuses() : Promise.resolve([])
}

export const skillApi = {
  getAll: (): Promise<Skill[]> => {
    return desktopApi.skills.getAll()
  },

  create: (data: CreateSkillDTO): Promise<Skill> => {
    return desktopApi.skills.create(data)
  },

  update: (id: string, data: UpdateSkillDTO): Promise<Skill | undefined> => {
    return desktopApi.skills.update(id, data)
  },

  delete: (id: string): Promise<boolean> => {
    return desktopApi.skills.delete(id)
  },

  /** Promote to global (null) or move into a project (#74). */
  setProject: (id: string, projectId: string | null): Promise<Skill | undefined> => {
    return desktopApi.skills.setProject(id, projectId)
  },

  /** A skill changed outside the Skills view (the Commander); absent on older preloads. */
  onChanged: (callback: (event: { skillId: string; kind: string }) => void): (() => void) | undefined => {
    return typeof desktopApi.skills.onChanged === 'function' ? desktopApi.skills.onChanged?.(callback) : undefined
  }
}

export const secretApi = {
  getAll: (): Promise<Secret[]> => {
    return desktopApi.secrets.getAll()
  },

  create: (data: CreateSecretDTO): Promise<Secret> => {
    return desktopApi.secrets.create(data)
  },

  update: (id: string, data: UpdateSecretDTO): Promise<Secret | undefined> => {
    return desktopApi.secrets.update(id, data)
  },

  delete: (id: string): Promise<boolean> => {
    return desktopApi.secrets.delete(id)
  }
}

export const pluginApi = {
  list: (): Promise<PluginMeta[]> => {
    return desktopApi.plugins.list()
  },

  getDocumentation: (pluginId: string): Promise<string | null> => {
    return desktopApi.plugins.getDocumentation(pluginId)
  },

  resolveOptions: (pluginId: string, resolverKey: string, config: Record<string, unknown>, mcpServerId?: string, sourceId?: string): Promise<ConfigFieldOption[]> => {
    return desktopApi.plugins.resolveOptions(pluginId, resolverKey, config, mcpServerId, sourceId)
  },

  executeAction: (actionId: string, taskId: string, sourceId: string, input?: string): Promise<ActionResult> => {
    return desktopApi.plugins.executeAction(actionId, taskId, sourceId, input)
  }
}

// ── Connector-bridge task source (docs/connectors.md) ─────────
// Credentials are write-only: no call returns them.

export const connectorBridgeApi = {
  bridgePieces: (): Promise<ConnectorBridgePiece[]> => desktopApi.connectors.bridgePieces(),
  ensureInstance: (pieceName: string, instanceId?: string): Promise<ConnectorBridgeInstance> =>
    desktopApi.connectors.ensureInstance(pieceName, instanceId),
  credentialStatus: (instanceId: string): Promise<ConnectorBridgeCredentialStatus> => desktopApi.connectors.credentialStatus(instanceId),
  setCredentials: (
    instanceId: string,
    input: ConnectorBridgeCredentialInput,
    storage?: ConnectorBridgeCredentialStorage
  ): Promise<ConnectorBridgeSetCredentialsResult> => desktopApi.connectors.setCredentials(instanceId, input, storage),
  clearCredentials: (instanceId: string): Promise<void> => desktopApi.connectors.clearCredentials(instanceId),
  oauthConnect: (
    instanceId: string,
    input: ConnectorBridgeOAuthConnectInput,
    storage?: ConnectorBridgeCredentialStorage
  ): Promise<ConnectorBridgeSetCredentialsResult> => desktopApi.connectors.oauthConnect(instanceId, input, storage),
  syncStatus: (instanceId: string): Promise<ConnectorBridgeSyncStatus> => desktopApi.connectors.syncStatus(instanceId)
}

export const claudePluginApi = {
  getMarketplaceSources: (): Promise<MarketplaceSource[]> => {
    return desktopApi.claudePlugins.getMarketplaceSources()
  },

  addMarketplaceSource: (data: { name: string; source_type?: string; source_url: string; auto_update?: boolean }): Promise<MarketplaceSource> => {
    return desktopApi.claudePlugins.addMarketplaceSource(data)
  },

  removeMarketplaceSource: (id: string): Promise<boolean> => {
    return desktopApi.claudePlugins.removeMarketplaceSource(id)
  },

  fetchCatalog: (sourceId: string): Promise<MarketplaceCatalog | null> => {
    return desktopApi.claudePlugins.fetchCatalog(sourceId)
  },

  discoverPlugins: (searchQuery?: string): Promise<DiscoverablePlugin[]> => {
    return desktopApi.claudePlugins.discoverPlugins(searchQuery)
  },

  getInstalledPlugins: (): Promise<InstalledPlugin[]> => {
    return desktopApi.claudePlugins.getInstalledPlugins()
  },

  installPlugin: (pluginName: string, marketplaceId: string, scope?: string): Promise<InstalledPlugin> => {
    return desktopApi.claudePlugins.installPlugin(pluginName, marketplaceId, scope)
  },

  uninstallPlugin: (pluginId: string): Promise<boolean> => {
    return desktopApi.claudePlugins.uninstallPlugin(pluginId)
  },

  enablePlugin: (pluginId: string): Promise<InstalledPlugin | undefined> => {
    return desktopApi.claudePlugins.enablePlugin(pluginId)
  },

  disablePlugin: (pluginId: string): Promise<InstalledPlugin | undefined> => {
    return desktopApi.claudePlugins.disablePlugin(pluginId)
  },

  getPluginResources: (pluginId: string): Promise<PluginResources> => {
    return desktopApi.claudePlugins.getPluginResources(pluginId)
  }
}

export const worktreeApi = {
  setup: (taskId: string, repos: { fullName: string; defaultBranch: string }[], org: string, provider: 'github' | 'gitlab' | 'forgejo'): Promise<string> => {
    return desktopApi.worktree.setup(taskId, repos, org, provider)
  },
  cleanup: (taskId: string, repos: { fullName: string }[], org: string, removeTaskDir?: boolean): Promise<void> => {
    return desktopApi.worktree.cleanup(taskId, repos, org, removeTaskDir)
  },
  changes: (taskId: string, repos: { fullName: string }[]): Promise<Array<{ repo: string; diff: string; allFiles?: string[]; workspace?: boolean; error?: string; noWorktree?: boolean; path?: string; branch?: string; pushed?: boolean; prNumber?: number; prUrl?: string; prState?: string; prTitle?: string; ciStatus?: 'passing' | 'failing' | 'pending' | 'none' }>> => {
    return desktopApi.worktree.changes(taskId, repos)
  },
  files: (taskId: string, repos: { fullName: string }[]): Promise<Array<{ repo: string; allFiles: string[]; workspace?: boolean; error?: string; noWorktree?: boolean; path?: string }>> => {
    return desktopApi.worktree.files(taskId, repos)
  },
  readFile: (taskId: string, repoFullName: string | null, filePath: string): Promise<{ content: string; size: number; binary: boolean; truncated: boolean } | null> => {
    const readFile = desktopApi.worktree.readFile
    if (typeof readFile !== 'function') {
      return Promise.reject(new Error('Restart 21x to enable workspace file previews.'))
    }
    return readFile(taskId, repoFullName, filePath)
  },
  runCleanupNow: (): Promise<{ cleaned: number; errors: string[]; nodeModulesCleaned: number }> => {
    return desktopApi.worktree.runCleanupNow()
  }
}

export const onWorktreeProgress = (callback: (event: WorktreeProgressEvent) => void): (() => void) | undefined => {
  return desktopApi.onWorktreeProgress?.(callback)
}

export const onWorkspaceCleanupProgress = (callback: (event: WorkspaceCleanupProgressEvent) => void): (() => void) | undefined => {
  return desktopApi.onWorkspaceCleanupProgress?.(callback)
}

// ── Voice control ───────────────────────────────────────────
// A thin pass-through. The renderer never decides what a command does; it only
// captures audio and shows what the main process reports.

export const voiceApi = {
  getSnapshot: (): Promise<VoiceSnapshot> => desktopApi.voice.getSnapshot(),
  setEnabled: (enabled: boolean): Promise<VoiceSnapshot> => desktopApi.voice.setEnabled(enabled),
  getPermission: (): Promise<{ status: MicrophonePermission }> => desktopApi.voice.getPermission(),
  requestPermission: (): Promise<{ status: MicrophonePermission }> =>
    desktopApi.voice.requestPermission(),
  startTurn: (mode: VoiceTurnMode, context: VoiceUiContext): Promise<{ turnId: string; turnEpoch?: string } | { error: string }> =>
    desktopApi.voice.startTurn(mode, context),
  pushAudio: (turnId: string, chunk: Uint8Array): Promise<void> =>
    desktopApi.voice.pushAudio(turnId, chunk),
  endTurn: (turnId: string): Promise<void> => desktopApi.voice.endTurn(turnId),
  cancelTurn: (turnId?: string, turnEpoch?: string): Promise<void> =>
    desktopApi.voice.cancelTurn(turnId, turnEpoch),
  confirm: (turnId: string, choice?: { taskId?: string; agentName?: string }, turnEpoch?: string): Promise<{ success: boolean }> =>
    turnEpoch
      ? desktopApi.voice.confirm(turnId, choice, turnEpoch)
      : desktopApi.voice.confirm(turnId, choice),
  dismiss: (turnId: string, turnEpoch?: string): Promise<void> =>
    turnEpoch
      ? desktopApi.voice.dismiss(turnId, turnEpoch)
      : desktopApi.voice.dismiss(turnId),
  getRuntime: (): Promise<VoiceRuntimeStatus> => desktopApi.voice.getRuntime(),
  installRuntime: (): Promise<VoiceRuntimeStatus> => desktopApi.voice.installRuntime(),
  removeRuntime: (): Promise<VoiceRuntimeStatus> => desktopApi.voice.removeRuntime(),
  installModel: (id: string): Promise<VoiceModelState> => desktopApi.voice.installModel(id),
  removeModel: (id: string): Promise<VoiceModelState[]> => desktopApi.voice.removeModel(id),
  selectModel: (id: string): Promise<VoiceModelState[]> => desktopApi.voice.selectModel(id),
  removeAllModels: (): Promise<{ success: boolean }> => desktopApi.voice.removeAllModels(),
  setCustomModelDir: (dir: string): Promise<VoiceSnapshot> => desktopApi.voice.setCustomModelDir(dir),
  pickModelDir: (): Promise<{ dir: string | null }> => desktopApi.voice.pickModelDir(),
  setEndpointSilence: (seconds: number): Promise<{ success: boolean }> =>
    desktopApi.voice.setEndpointSilence(seconds),
  setShortcut: (accelerator: string): Promise<VoiceSnapshot> => desktopApi.voice.setShortcut(accelerator),
  expectAnswer: (turnId: string, taskId?: string): Promise<void> =>
    desktopApi.voice.expectAnswer(turnId, taskId),
  /** The user typed rather than spoke, so no answer is expected by voice. */
  answerNotExpected: (taskId?: string): Promise<void> =>
    desktopApi?.voice?.answerNotExpected?.(taskId) ?? Promise.resolve(),
  onState: (callback: (event: VoiceStateEvent) => void): (() => void) | undefined =>
    desktopApi.voice.onState?.(callback),
  onPartial: (callback: (event: { turnId: string; turnEpoch: string | null; text: string }) => void): (() => void) | undefined =>
    desktopApi.voice.onPartial?.(callback),
  onFinal: (callback: (event: { turnId: string; turnEpoch: string | null; text: string }) => void): (() => void) | undefined =>
    desktopApi.voice.onFinal?.(callback),
  onSegment: (
    callback: (event: { turnId: string; turnEpoch: string | null; text: string; index: number }) => void
  ): (() => void) | undefined => desktopApi.voice.onSegment?.(callback),
  onOutcome: (callback: (event: VoiceActionOutcome) => void): (() => void) | undefined =>
    desktopApi.voice.onOutcome?.(callback),
  onStatus: (callback: (event: Partial<VoiceSnapshot> & { model?: VoiceModelState }) => void): (() => void) | undefined =>
    desktopApi.voice.onStatus?.(callback),
  onError: (callback: (event: VoiceErrorEvent) => void): (() => void) | undefined =>
    desktopApi.voice.onError?.(callback),
  onNavigate: (callback: (event: { destination: VoiceViewName; taskId: string | null }) => void): (() => void) | undefined =>
    desktopApi.voice.onNavigate?.(callback),
  onDictate: (callback: (event: { turnId: string; text: string }) => void): (() => void) | undefined =>
    desktopApi.voice.onDictate?.(callback),
  onRuntimeProgress: (callback: (event: VoiceRuntimeProgressEvent) => void): (() => void) | undefined =>
    desktopApi.voice.onRuntimeProgress?.(callback),
  onHotkey: (callback: (event: { action: string }) => void): (() => void) | undefined =>
    desktopApi.voice.onHotkey?.(callback)
}

/** Spoken answers. Main produces the audio; the renderer only plays it. */
export const voiceTtsApi = {
  getSnapshot: (): Promise<VoiceTtsSnapshot> => desktopApi.voice.tts.getSnapshot(),
  setEnabled: (enabled: boolean): Promise<VoiceTtsSnapshot> =>
    desktopApi.voice.tts.setEnabled(enabled),
  setEngine: (engine: VoiceTtsEngineId): Promise<VoiceTtsSnapshot> =>
    desktopApi.voice.tts.setEngine(engine),
  setVoice: (voiceId: string): Promise<VoiceTtsSnapshot> => desktopApi.voice.tts.setVoice(voiceId),
  setSpeed: (speed: number): Promise<VoiceTtsSnapshot> => desktopApi.voice.tts.setSpeed(speed),
  setMaxChars: (maxChars: number): Promise<VoiceTtsSnapshot> =>
    desktopApi.voice.tts.setMaxChars(maxChars),
  setSpeakActionResults: (on: boolean): Promise<VoiceTtsSnapshot> =>
    desktopApi.voice.tts.setSpeakActionResults(on),
  setOnlyVoiceTurns: (on: boolean): Promise<VoiceTtsSnapshot> =>
    desktopApi.voice.tts.setOnlyVoiceTurns(on),
  installModel: (id: string): Promise<VoiceTtsSnapshot> => desktopApi.voice.tts.installModel(id),
  selectModel: (id: string): Promise<VoiceTtsSnapshot> => desktopApi.voice.tts.selectModel(id),
  removeModel: (id: string): Promise<VoiceTtsSnapshot> => desktopApi.voice.tts.removeModel(id),
  preview: (voiceId: string): Promise<{ spoken: boolean }> => desktopApi.voice.tts.preview(voiceId),
  speak: (text: string, taskId?: string): Promise<{ spoken: boolean }> =>
    desktopApi.voice.tts.speak(text, taskId),
  stop: (): Promise<void> => desktopApi.voice.tts.stop(),
  onSpeechStart: (callback: (event: VoiceSpeechStartEvent) => void): (() => void) | undefined =>
    desktopApi.voice.tts.onSpeechStart?.(callback),
  onSpeechChunk: (callback: (event: VoiceSpeechChunkEvent) => void): (() => void) | undefined =>
    desktopApi.voice.tts.onSpeechChunk?.(callback),
  onSpeechEnd: (callback: (event: VoiceSpeechEndEvent) => void): (() => void) | undefined =>
    desktopApi.voice.tts.onSpeechEnd?.(callback),
  onStatus: (callback: (event: VoiceTtsSnapshot) => void): (() => void) | undefined =>
    desktopApi.voice.tts.onStatus?.(callback),
  onModelProgress: (callback: (event: { model: VoiceTtsModelState }) => void): (() => void) | undefined =>
    desktopApi.voice.tts.onModelProgress?.(callback)
}

export const browserRecordingApi = {
  start: (panelId: string, title?: string) => electronBrowserApi()?.startRecording
    ? electronBrowserApi()!.startRecording(panelId, title)
    : Promise.resolve({ error: 'Browser recording is unavailable.' } as const),
  stop: (panelId: string) => electronBrowserApi()?.stopRecording
    ? electronBrowserApi()!.stopRecording(panelId)
    : Promise.resolve({ error: 'Browser recording is unavailable.' } as const),
  status: (panelId: string) => electronBrowserApi()?.recordingStatus
    ? electronBrowserApi()!.recordingStatus(panelId)
    : Promise.resolve({ recording: null }),
}

// ── Chat runtime ────────────────────────────────────────────
// A pass-through for the lightweight chat loop (docs/chat-runtime.md). The
// renderer sends history and draws events; every model and tool call happens
// in the main process.

export const chatApi = {
  start: (payload: ChatStartRequest): Promise<{ turnId: string; provider: string; model: string }> =>
    desktopApi.chat.start(payload),
  cancel: (turnId: string): Promise<{ cancelled: boolean }> => desktopApi.chat.cancel(turnId),
  onEvent: (callback: (event: ChatIpcEvent) => void): (() => void) | undefined => desktopApi.chat.onEvent?.(callback)
}

// ── Commander sessions ─────────────────────────────────────
// Persisted Commander chat sessions (docs/commander.md). Main stores every
// message and runs the turns; the renderer lists, sends and draws events.

export const sessionContextApi = {
  getSnapshot: (scope: SessionContextScope): Promise<SessionContextSnapshot> => desktopApi.sessionContext.getSnapshot(scope),
  setPolicy: (policy: RolloverPolicy): Promise<RolloverPolicy> => desktopApi.sessionContext.setPolicy(policy)
}

export const commanderApi = {
  listSessions: (payload?: CommanderListSessionsRequest): Promise<CommanderSession[]> => desktopApi.commander.listSessions(payload),
  createSession: (title?: string): Promise<CommanderSession> => desktopApi.commander.createSession(title ? { title } : undefined),
  renameSession: (id: string, title: string): Promise<CommanderSession | null> => desktopApi.commander.renameSession(id, title),
  archiveSession: (id: string, archived: boolean): Promise<CommanderSession | null> => desktopApi.commander.archiveSession(id, archived),
  listMessages: (sessionId: string): Promise<{ messages: CommanderMessage[]; activeTurnId: string | null }> =>
    desktopApi.commander.listMessages(sessionId),
  markRead: (sessionId: string): Promise<CommanderSession | null> => desktopApi.commander.markRead(sessionId),
  /** Tells main which session the view shows (#62): a report for it is relayed at once, others only queue as unread. */
  setActiveSession: (sessionId: string | null): Promise<void> =>
    typeof desktopApi.commander.setActiveSession === 'function' ? desktopApi.commander.setActiveSession(sessionId) : Promise.resolve(),
  send: (sessionId: string, text: string, images?: ChatImageInput[]): Promise<{ turnId: string; message: CommanderMessage }> =>
    images?.length ? desktopApi.commander.send(sessionId, text, images) : desktopApi.commander.send(sessionId, text),
  getImage: (id: string): Promise<(ChatImageInput & { id: string }) | null> => desktopApi.commander.getImage(id),
  cancel: (sessionId: string): Promise<{ cancelled: boolean }> => desktopApi.commander.cancel(sessionId),
  undoAction: (sessionId: string, actionId: string): Promise<{ alreadyUndone: boolean; message: CommanderMessage }> =>
    desktopApi.commander.undoAction(sessionId, actionId),
  getActivity: (sessionId: string): Promise<import('@shared/activity').CommanderActivitySnapshot> => desktopApi.commander.getActivity(sessionId),
  onEvent: (callback: (event: CommanderEvent) => void): (() => void) | undefined => desktopApi.commander.onEvent?.(callback)
}

// ── Global MCP config of the coding-agent CLIs ───────────────
// Claude Code, OpenCode and Codex global MCP servers (docs/mcp-global-config.md).

export const cliMcpApi = {
  snapshot: (): Promise<CliMcpSnapshot> => desktopApi.cliMcp.snapshot(),
  upsert: (request: CliMcpUpsertRequest): Promise<CliMcpMutationResult> => desktopApi.cliMcp.upsert(request),
  remove: (ref: CliMcpServerRef): Promise<CliMcpMutationResult> => desktopApi.cliMcp.remove(ref),
  setEnabled: (ref: CliMcpServerRef & { enabled: boolean }): Promise<CliMcpMutationResult> => desktopApi.cliMcp.setEnabled(ref),
  setToolEnabled: (ref: CliMcpServerRef & { tool: string; enabled: boolean }): Promise<CliMcpMutationResult> =>
    desktopApi.cliMcp.setToolEnabled(ref),
  probe: (ref: CliMcpServerRef): Promise<CliMcpProbeResult> => desktopApi.cliMcp.probe(ref)
}

// ── Voice: ElevenLabs engine and Commander voice mode (#64) ──
// The key is sent to main and never read back; every call returns the speech
// snapshot, which only says whether a key is set.

export const voiceElevenLabsApi = {
  setKey: (key: string): Promise<VoiceTtsSnapshot> => desktopApi.voiceElevenLabs.setKey(key),
  clearKey: (): Promise<VoiceTtsSnapshot> => desktopApi.voiceElevenLabs.clearKey(),
  acceptDisclosure: (): Promise<VoiceTtsSnapshot> => desktopApi.voiceElevenLabs.acceptDisclosure(),
  refresh: (): Promise<VoiceTtsSnapshot> => desktopApi.voiceElevenLabs.refresh(),
  setModel: (modelId: string): Promise<VoiceTtsSnapshot> => desktopApi.voiceElevenLabs.setModel(modelId)
}

export const commanderVoiceApi = {
  setActive: (sessionId: string | null): Promise<{ active: string | null }> => desktopApi.commanderVoice.setActive(sessionId),
  bargeIn: (sessionId: string): Promise<{ cancelled: boolean }> => desktopApi.commanderVoice.bargeIn(sessionId),
  send: (sessionId: string, text: string): Promise<{ turnId: string; message: CommanderMessage }> =>
    desktopApi.commanderVoice.send(sessionId, text)
}
