import { NATIVE_NOTIFICATION_CODECS } from '@shared/native-notification-codecs'
import { UI_DESKTOP_CODECS, UI_DESKTOP_EVENT_CODECS, isUiCommand, isUiLeaseId } from '@shared/ui-desktop-codecs'
import type { UiCommand } from '@shared/ui-commands'
import { CLI_MCP_CODECS } from '@shared/cli-mcp-codecs'
import { TASK_ATTACHMENT_CODECS } from '@shared/task-attachment-codecs'
import { HEARTBEAT_CODECS, HEARTBEAT_EVENT_CODECS } from '@shared/heartbeat-codecs'
import { WORKTREE_RUNTIME_CODECS, WORKTREE_RUNTIME_EVENT_CODECS } from '@shared/worktree-runtime-codecs'
import { TASK_GROUP_CODECS } from '@shared/task-group-codecs'
import { PROJECT_RUNTIME_CODECS } from '@shared/project-runtime-codecs'
import { GIT_PROVIDER_CODECS, GIT_PROVIDER_OPERATIONS } from '@shared/git-provider-codecs'
import { WORKSPACE_FILE_CODECS, WORKSPACE_FILE_OPERATIONS } from '@shared/workspace-file-codecs'
import { VOICE_MANAGEMENT_CODECS, VOICE_MANAGEMENT_EVENT_CODECS } from '@shared/voice-management-codecs'
import { AGENT_INSTALLER_CODECS, AGENT_INSTALLER_EVENT_CODECS, isAgentInstallerProgress } from '@shared/agent-installer-codecs'
import { ARTIFACT_CODECS } from '@shared/artifact-codecs'
import { NATIVE_SERVICES_CODECS } from '@shared/native-services-codecs'
import { NATIVE_CLIPBOARD_CODECS } from '@shared/native-clipboard-codecs'
import { TASK_LIFECYCLE_CODECS, TASK_LIFECYCLE_EVENT_CODECS } from '@shared/task-lifecycle-codecs'
import { PRODUCTION_AGENT_CODECS } from '@shared/production-agent-codecs'
import { PRODUCTION_AGENT_EVENT_CODECS } from '@shared/production-agent-events'
import { COMMANDER_COMMAND_CODECS, COMMANDER_EVENT_CODECS } from '@shared/commander-desktop-codecs'
import { PRODUCTION_SETTINGS_CODECS } from '@shared/production-settings-codecs'
import { TERMINAL_COMMAND_CODECS, TERMINAL_EVENT_CODECS } from '@shared/terminal-desktop-codecs'
import { MCP_CODECS } from '@shared/mcp-codecs'
import { TASK_SOURCE_CODECS } from '@shared/task-source-codecs'
import { CONNECTOR_CODECS } from '@shared/connector-codecs'
import { TASK_SOURCE_PLUGIN_CODECS } from '@shared/task-source-plugin-codecs'
import { SESSION_CONTEXT_CODECS } from '@shared/session-context-codecs'
import { CLAUDE_PLUGIN_CODECS } from '@shared/claude-plugin-codecs'
import { MOBILE_CODECS, MOBILE_EVENT_CODECS } from '@shared/mobile-codecs'
import type { DesktopApi } from '@shared/desktop-api'
import { DATABASE_COMMAND_CODECS, DATABASE_EVENT_CODECS } from '@shared/database-desktop-codecs'
import { CONFIGURATION_COMMAND_CODECS, CONFIGURATION_EVENT_CODECS } from '@shared/configuration-desktop-codecs'
import { AGENT_COMMAND_CODECS, AGENT_EVENT_CODECS } from '@shared/agent-desktop-codecs'
import { AGENT_CONFIGURATION_CODECS, AGENT_CONFIGURATION_EVENT_CODECS } from '@shared/agent-configuration-codecs'
import type { DesktopCommandMap, DesktopEventMap } from '@shared/desktop-operations'
import { hasExactKeys, isRecord, ServiceProtocolError } from '@shared/service-protocol'
import { DesktopClient, type DesktopClientState } from './desktop-client'
import { createTauriDesktopTransport, getTauriEngineEpoch, getTauriUiDocument, NativeBootstrapUnavailableError, type TauriDesktopApi } from './tauri-desktop-transport'
import { DesktopUnavailableError, type DesktopHost } from './desktop-api'

const commands = { ...DATABASE_COMMAND_CODECS, ...CONFIGURATION_COMMAND_CODECS, ...AGENT_COMMAND_CODECS, ...AGENT_CONFIGURATION_CODECS, ...TASK_LIFECYCLE_CODECS, ...PRODUCTION_AGENT_CODECS, ...COMMANDER_COMMAND_CODECS, ...PRODUCTION_SETTINGS_CODECS, ...TERMINAL_COMMAND_CODECS, ...MCP_CODECS, ...TASK_SOURCE_CODECS, ...CONNECTOR_CODECS, ...TASK_SOURCE_PLUGIN_CODECS, ...SESSION_CONTEXT_CODECS, ...CLAUDE_PLUGIN_CODECS, ...MOBILE_CODECS, ...AGENT_INSTALLER_CODECS, ...ARTIFACT_CODECS, ...NATIVE_SERVICES_CODECS, ...NATIVE_CLIPBOARD_CODECS, ...NATIVE_NOTIFICATION_CODECS, ...VOICE_MANAGEMENT_CODECS, ...GIT_PROVIDER_CODECS, ...WORKSPACE_FILE_CODECS, ...TASK_GROUP_CODECS, ...PROJECT_RUNTIME_CODECS, ...HEARTBEAT_CODECS, ...WORKTREE_RUNTIME_CODECS, ...CLI_MCP_CODECS, ...TASK_ATTACHMENT_CODECS, ...UI_DESKTOP_CODECS }
const events = { ...DATABASE_EVENT_CODECS, ...CONFIGURATION_EVENT_CODECS, ...AGENT_EVENT_CODECS, ...AGENT_CONFIGURATION_EVENT_CODECS, ...PRODUCTION_AGENT_EVENT_CODECS, ...TASK_LIFECYCLE_EVENT_CODECS, ...COMMANDER_EVENT_CODECS, ...TERMINAL_EVENT_CODECS, ...MOBILE_EVENT_CODECS, ...VOICE_MANAGEMENT_EVENT_CODECS, ...HEARTBEAT_EVENT_CODECS, ...WORKTREE_RUNTIME_EVENT_CODECS, ...UI_DESKTOP_EVENT_CODECS, ...AGENT_INSTALLER_EVENT_CODECS,
  'tasks:refresh': { decodePayload: (value: Parameters<typeof AGENT_CONFIGURATION_EVENT_CODECS['tasks:refresh']['decodePayload']>[0]) => AGENT_CONFIGURATION_EVENT_CODECS['tasks:refresh'].decodePayload(value), validatePayload: (value: unknown) => value === undefined } }
type ApiPath<T> = { [K in keyof T & string]: NonNullable<T[K]> extends (...args: never[]) => unknown ? K : NonNullable<T[K]> extends object ? `${K}.${ApiPath<NonNullable<T[K]>>}` : never }[keyof T & string]
/** Explicit binding is separate from codec validation and native/service authorization. */
export const NATIVE_COMMAND_BINDINGS = {
  'ui:publishState': 'ui.publishState',
  'cliMcp:snapshot': 'cliMcp.snapshot', 'cliMcp:upsert': 'cliMcp.upsert', 'cliMcp:remove': 'cliMcp.remove', 'cliMcp:setEnabled': 'cliMcp.setEnabled', 'cliMcp:setToolEnabled': 'cliMcp.setToolEnabled', 'cliMcp:probe': 'cliMcp.probe',
  'chatImages:saveToTask': 'chatImages.saveToTask', 'chatImages:readClipboard': 'chatImages.readClipboard', 'attachments:remove': 'attachments.remove', 'attachments:open': 'attachments.open', 'attachments:download': 'attachments.download',
  'heartbeat:enable': 'heartbeat.enable', 'heartbeat:disable': 'heartbeat.disable', 'heartbeat:runNow': 'heartbeat.runNow', 'heartbeat:getLogs': 'heartbeat.getLogs', 'heartbeat:getStatus': 'heartbeat.getStatus', 'heartbeat:updateInterval': 'heartbeat.updateInterval', 'heartbeat:readFile': 'heartbeat.readFile', 'heartbeat:writeFile': 'heartbeat.writeFile',
  'worktree:setup': 'worktree.setup', 'worktree:changes': 'worktree.changes', 'worktree:files': 'worktree.files', 'worktree:readFile': 'worktree.readFile', 'worktree:cleanup': 'worktree.cleanup', 'workspace:runCleanupNow': 'worktree.runCleanupNow',
  'taskGroups:list': 'taskGroups.list', 'taskGroups:get': 'taskGroups.get', 'taskGroups:history': 'taskGroups.history', 'taskGroups:create': 'taskGroups.create', 'taskGroups:add': 'taskGroups.add', 'taskGroups:remove': 'taskGroups.remove', 'taskGroups:dissolve': 'taskGroups.dissolve', 'taskGroups:move': 'taskGroups.move', 'taskGroups:review': 'taskGroups.review',
  'project:getStatus': 'projects.getStatus', 'project:getStatusHistory': 'projects.getStatusHistory', 'project:getCaptainMemory': 'projects.getCaptainMemory', 'project:getAllStatuses': 'overview.getAllStatuses',
  'projectLimits:getState': 'projectLimits.getState', 'projectLimits:isAllPaused': 'projectLimits.isAllPaused', 'projectLimits:pauseAll': 'projectLimits.pauseAll',
  'concurrency:getState': 'concurrency.getState', 'concurrency:setCaptainControl': 'concurrency.setCaptainControl', 'concurrency:pin': 'concurrency.pin',
  'github:checkCli': 'github.checkCli', 'github:fetchOrgs': 'github.fetchOrgs', 'github:fetchOrgRepos': 'github.fetchOrgRepos', 'github:fetchUserRepos': 'github.fetchUserRepos', 'github:fetchPullRequestDetails': 'github.fetchPullRequestDetails',
  'gitlab:checkCli': 'gitlab.checkCli', 'gitlab:fetchOrgs': 'gitlab.fetchOrgs', 'gitlab:fetchOrgRepos': 'gitlab.fetchOrgRepos', 'gitlab:fetchUserRepos': 'gitlab.fetchUserRepos',
  'forgejo:checkCli': 'forgejo.checkCli', 'forgejo:setLogin': 'forgejo.setLogin', 'forgejo:fetchOrgs': 'forgejo.fetchOrgs', 'forgejo:fetchOrgRepos': 'forgejo.fetchOrgRepos', 'forgejo:fetchUserRepos': 'forgejo.fetchUserRepos', 'git:recordRepoProviders': 'git.recordRepoProviders',
  'voice:getSnapshot': 'voice.getSnapshot',
  'voice:setEnabled': 'voice.setEnabled',
  'voice:getRuntime': 'voice.getRuntime',
  'voice:installRuntime': 'voice.installRuntime',
  'voice:removeRuntime': 'voice.removeRuntime',
  'voice:installModel': 'voice.installModel',
  'voice:removeModel': 'voice.removeModel',
  'voice:removeAllModels': 'voice.removeAllModels',
  'voice:selectModel': 'voice.selectModel',
  'voice:setEndpointSilence': 'voice.setEndpointSilence',
  'voice:tts:getSnapshot': 'voice.tts.getSnapshot',
  'voice:tts:setEnabled': 'voice.tts.setEnabled',
  'voice:tts:setEngine': 'voice.tts.setEngine',
  'voice:tts:setVoice': 'voice.tts.setVoice',
  'voice:tts:setSpeed': 'voice.tts.setSpeed',
  'voice:tts:setMaxChars': 'voice.tts.setMaxChars',
  'voice:tts:setSpeakActionResults': 'voice.tts.setSpeakActionResults',
  'voice:tts:setOnlyVoiceTurns': 'voice.tts.setOnlyVoiceTurns',
  'voice:tts:installModel': 'voice.tts.installModel',
  'voice:tts:selectModel': 'voice.tts.selectModel',
  'voice:tts:removeModel': 'voice.tts.removeModel',

  'db:getTasks': 'db.getTasks', 'db:getTask': 'db.getTask', 'db:createTask': 'db.createTask', 'db:updateTask': 'db.updateTask', 'db:deleteTask': 'db.deleteTask',
  'project:getAll': 'projects.getAll', 'project:get': 'projects.get', 'project:getDefault': 'projects.getDefault', 'project:create': 'projects.create',
  'settings:get': 'settings.get', 'settings:set': 'settings.set', 'settings:getAll': 'settings.getAll',
  'agentSession:getTranscriptSnapshot': 'agentSession.getTranscriptSnapshot', 'agentSession:getTranscriptDelta': 'agentSession.getTranscriptDelta', 'agentSession:getTranscriptPage': 'agentSession.getTranscriptPage',
  'agent:getAll': 'agents.getAll', 'agent:create': 'agents.create', 'agent:update': 'agents.update', 'agent:delete': 'agents.delete',
  'skills:getAll': 'skills.getAll', 'skills:create': 'skills.create', 'skills:update': 'skills.update', 'skills:delete': 'skills.delete', 'skills:setProject': 'skills.setProject',
  'project:update': 'projects.update', 'project:archive': 'projects.archive', 'project:reorder': 'projects.reorder',
  'projectRepo:list': 'projects.repos.list', 'projectRepo:add': 'projects.repos.add', 'projectRepo:update': 'projects.repos.update', 'projectRepo:remove': 'projects.repos.remove', 'projectRepo:reorder': 'projects.repos.reorder',
  'projectResource:list': 'projects.resources.list', 'projectResource:add': 'projects.resources.add', 'projectResource:update': 'projects.resources.update', 'projectResource:remove': 'projects.resources.remove', 'projectResource:reorder': 'projects.resources.reorder',
  'agentSession:start': 'agentSession.start', 'agentSession:resume': 'agentSession.resume', 'agentSession:approve': 'agentSession.approve', 'agentSession:stop': 'agentSession.stop',
  'agentConfig:getProviders': 'agentConfig.getProviders', 'agentConfig:listModels': 'agentConfig.listModels',
  'db:getSubtasks': 'db.getSubtasks', 'db:reorderSubtasks': 'db.reorderSubtasks', 'project:moveTask': 'projects.moveTask',
  'tasks:getCoordinatorTaskId': 'tasks.getCoordinatorTaskId', 'plugin:executeAction': 'plugins.executeAction',
  'agentSession:startTask': 'agentSession.startTask', 'agentSession:send': 'agentSession.send', 'agentSession:sendByTaskId': 'agentSession.sendByTaskId',
  'agentSession:abort': 'agentSession.abort', 'agentSession:stopByTaskId': 'agentSession.stopByTaskId', 'agentSession:switchAgent': 'agentSession.switchAgent',
  'agent:getStartQueue': 'agents.getStartQueue', 'agent:getStartRecoveryState': 'agents.getStartRecoveryState', 'agentSession:getRawTranscript': 'agentSession.getRawTranscript',
  'captainRuntime:get': 'captainRuntime.get', 'captainRuntime:switch': 'captainRuntime.switch', 'captainRuntime:retry': 'captainRuntime.retry', 'captainRuntime:rollback': 'captainRuntime.rollback',
  'commander:listSessions': 'commander.listSessions', 'commander:createSession': 'commander.createSession', 'commander:renameSession': 'commander.renameSession',
  'commander:archiveSession': 'commander.archiveSession', 'commander:listMessages': 'commander.listMessages', 'commander:markRead': 'commander.markRead',
  'commander:setActiveSession': 'commander.setActiveSession', 'commander:send': 'commander.send', 'commander:getImage': 'commander.getImage',
  'commander:cancel': 'commander.cancel', 'commander:undoAction': 'commander.undoAction', 'commander:getActivity': 'commander.getActivity',
  'chat:start': 'chat.start', 'chat:cancel': 'chat.cancel',
  'secrets:getAll': 'secrets.getAll', 'secrets:create': 'secrets.create', 'secrets:update': 'secrets.update', 'secrets:delete': 'secrets.delete', 'env:get': 'env.get',
  'terminal:create': 'terminal.create', 'terminal:write': 'terminal.write', 'terminal:resize': 'terminal.resize',
  'terminal:kill': 'terminal.kill', 'terminal:getCwd': 'terminal.getCwd', 'terminal:getBuffer': 'terminal.getBuffer',
  'mcp:getAll': 'mcpServers.getAll', 'mcp:create': 'mcpServers.create', 'mcp:update': 'mcpServers.update', 'mcp:delete': 'mcpServers.delete',
  'mcp:testConnection': 'mcpServers.testConnection', 'mcp:startOAuthFlow': 'mcpServers.startOAuthFlow', 'mcp:getOAuthStatus': 'mcpServers.getOAuthStatus',
  'mcp:revokeOAuthToken': 'mcpServers.revokeOAuthToken', 'mcp:probeForAuth': 'mcpServers.probeForAuth', 'mcp:submitManualClientId': 'mcpServers.submitManualClientId',
  'taskSource:getAll': 'taskSources.getAll', 'taskSource:create': 'taskSources.create', 'taskSource:update': 'taskSources.update', 'taskSource:delete': 'taskSources.delete',
  'taskSource:sync': 'taskSources.sync', 'taskSource:exportUpdate': 'taskSources.exportUpdate', 'taskSource:getUsers': 'taskSources.getUsers', 'taskSource:reassign': 'taskSources.reassign',
  'connectors:bridgePieces': 'connectors.bridgePieces', 'connectors:ensureInstance': 'connectors.ensureInstance', 'connectors:credentialStatus': 'connectors.credentialStatus',
  'connectors:setCredentials': 'connectors.setCredentials', 'connectors:clearCredentials': 'connectors.clearCredentials', 'connectors:oauthConnect': 'connectors.oauthConnect', 'connectors:syncStatus': 'connectors.syncStatus',
  'plugin:list': 'plugins.list', 'plugin:getDocumentation': 'plugins.getDocumentation', 'plugin:resolveOptions': 'plugins.resolveOptions',
  'sessionContext:getSnapshot': 'sessionContext.getSnapshot', 'sessionContext:setPolicy': 'sessionContext.setPolicy',
  'claudePlugin:getMarketplaceSources': 'claudePlugins.getMarketplaceSources', 'claudePlugin:addMarketplaceSource': 'claudePlugins.addMarketplaceSource', 'claudePlugin:removeMarketplaceSource': 'claudePlugins.removeMarketplaceSource',
  'claudePlugin:fetchCatalog': 'claudePlugins.fetchCatalog', 'claudePlugin:discoverPlugins': 'claudePlugins.discoverPlugins', 'claudePlugin:getInstalledPlugins': 'claudePlugins.getInstalledPlugins',
  'claudePlugin:installPlugin': 'claudePlugins.installPlugin', 'claudePlugin:uninstallPlugin': 'claudePlugins.uninstallPlugin', 'claudePlugin:enablePlugin': 'claudePlugins.enablePlugin', 'claudePlugin:disablePlugin': 'claudePlugins.disablePlugin', 'claudePlugin:getPluginResources': 'claudePlugins.getPluginResources',
  'agent-installer:detect': 'agentInstaller.detect', 'agent-installer:install': 'agentInstaller.install', 'artifacts:scan': 'artifacts.scan', 'artifacts:read': 'artifacts.read', 'artifacts:copyFile': 'artifacts.copyFile',
  'notifications:show': 'notifications.show', 'app:getNotificationPermission': 'app.getNotificationPermission', 'app:requestNotificationPermission': 'app.requestNotificationPermission',
  'shell:openExternal': 'shell.openExternal', 'app:getVersion': 'app.getVersion',
  'tasks:getWorkspaceDir': 'tasks.getWorkspaceDir', 'shell:readTextFile': 'shell.readTextFile', 'shell:openPath': 'shell.openPath', 'shell:showItemInFolder': 'shell.showItemInFolder',
  'mobile:getInfo': 'mobile.getInfo', 'mobile:setAccess': 'mobile.setAccess', 'mobile:startTunnel': 'mobile.startTunnel', 'mobile:stopTunnel': 'mobile.stopTunnel',
  'mobile:setCustomUrl': 'mobile.setCustomUrl', 'mobile:clearCustomUrl': 'mobile.clearCustomUrl', 'mobile:getPendingPin': 'mobile.getPendingPin', 'mobile:getSessions': 'mobile.getSessions', 'mobile:revokeSession': 'mobile.revokeSession', 'mobile:revokeAllSessions': 'mobile.revokeAllSessions'
} as const satisfies Record<keyof typeof commands, ApiPath<DesktopApi>>
export const NATIVE_EVENT_BINDINGS = {
  'agent-installer:progress': 'agentInstaller.onProgress',
  'ui:command': 'ui.onCommand',
  'heartbeat:alert': 'onHeartbeatAlert', 'heartbeat:disabled': 'onHeartbeatDisabled',
  'worktree:progress': 'onWorktreeProgress', 'workspace:cleanup-progress': 'onWorkspaceCleanupProgress',
  'voice:status': 'voice.onStatus', 'voice:runtimeProgress': 'voice.onRuntimeProgress',
  'voice:tts:status': 'voice.tts.onStatus', 'voice:tts:modelProgress': 'voice.tts.onModelProgress',
  'task:created': 'onTaskCreated', 'task:updated': 'onTaskUpdated', 'task:deleted': 'onTaskDeleted', 'project:changed': 'projects.onChanged', 'transcript:changed': 'onTranscriptChanged',
  'skills:changed': 'skills.onChanged', 'agent:status': 'onAgentStatus', 'agent:startQueueChanged': 'onAgentStartQueueChanged',
  'project:statusChanged': 'projects.onStatusChanged', 'concurrency:changed': 'concurrency.onChanged', 'tasks:refresh': 'onTasksRefresh',
  'commander:event': 'commander.onEvent', 'chat:event': 'chat.onEvent', 'terminal:data': 'terminal.onData', 'terminal:exit': 'terminal.onExit',
  'mobile:pairing-initiated': 'mobile.onPairingInitiated', 'mobile:device-connected': 'mobile.onDeviceConnected'
  // Recovery-state codec exists, but there is no production API binding yet.
} as const satisfies Partial<Record<keyof typeof events, ApiPath<DesktopApi>>>
const reads = new Set<keyof typeof commands>(['cliMcp:snapshot', 'heartbeat:getLogs', 'heartbeat:getStatus', 'heartbeat:readFile', 'worktree:changes', 'worktree:files', 'worktree:readFile', 'taskGroups:list', 'taskGroups:get', 'taskGroups:history', 'project:getStatus', 'project:getStatusHistory', 'project:getCaptainMemory', 'project:getAllStatuses', 'projectLimits:getState', 'projectLimits:isAllPaused', 'concurrency:getState', 'github:checkCli', 'github:fetchOrgs', 'github:fetchOrgRepos', 'github:fetchUserRepos', 'github:fetchPullRequestDetails', 'gitlab:checkCli', 'gitlab:fetchOrgs', 'gitlab:fetchOrgRepos', 'gitlab:fetchUserRepos', 'forgejo:checkCli', 'forgejo:fetchOrgs', 'forgejo:fetchOrgRepos', 'forgejo:fetchUserRepos', 'voice:getSnapshot', 'voice:getRuntime', 'voice:tts:getSnapshot', 'db:getTasks', 'db:getTask', 'project:getAll', 'project:get', 'project:getDefault', 'settings:get', 'settings:getAll', 'agent:getAll', 'skills:getAll', 'projectRepo:list', 'projectResource:list', 'agentSession:getTranscriptSnapshot', 'agentSession:getTranscriptDelta', 'agentSession:getTranscriptPage', 'agentConfig:getProviders', 'agentConfig:listModels', 'db:getSubtasks', 'tasks:getCoordinatorTaskId', 'agent:getStartQueue',
  'agent:getStartRecoveryState', 'agentSession:getRawTranscript', 'captainRuntime:get', 'commander:listSessions',
  'commander:listMessages', 'commander:getImage', 'commander:getActivity', 'secrets:getAll', 'env:get', 'terminal:getCwd', 'terminal:getBuffer',
  'mcp:getAll', 'mcp:getOAuthStatus', 'mcp:probeForAuth', 'taskSource:getAll', 'taskSource:getUsers', 'connectors:bridgePieces', 'connectors:credentialStatus', 'connectors:syncStatus', 'plugin:list', 'plugin:getDocumentation', 'plugin:resolveOptions',
  'sessionContext:getSnapshot', 'claudePlugin:getMarketplaceSources', 'claudePlugin:fetchCatalog', 'claudePlugin:discoverPlugins', 'claudePlugin:getInstalledPlugins', 'claudePlugin:getPluginResources', 'mobile:getPendingPin', 'mobile:getSessions', 'agent-installer:detect', 'artifacts:scan', 'artifacts:read', 'app:getVersion', 'app:getNotificationPermission', 'shell:readTextFile'])

export interface NativeDesktopHost extends DesktopHost {
  reconnect: () => Promise<void>
  /** Durable state owners register here; callbacks read snapshots, never replay writes. */
  setRehydrator: (rehydrate: () => Promise<void>) => void
  rehydrate: () => Promise<void>
  readonly hydrationPending: boolean
  readonly unavailableCapability: string | null
  readonly recoveryFailed: boolean
  readonly bootstrapFailure?: string | null
}
export function createNativeDesktopHost(native: TauriDesktopApi): NativeDesktopHost {
  const observers = new Set<() => void>(), refreshes = new Set<() => void>()
  let state: Readonly<DesktopClientState> = { status: 'disconnected', engineEpoch: null }
  let hydrationPending = true, rehydrate: (() => Promise<void>) | undefined, disposed = false
  const installationObservers = new Set<(progress: DesktopEventMap['agent-installer:progress']) => void>()
  const uiObservers = new Set<(command: UiCommand) => void>()
  let uiCleanup: (() => void) | undefined
  let uiConnectGeneration = 0
  let generation = 0
  let hydrationGeneration = 0, recoveryFailed = false
  let unavailableCapability: string | null = null
  let bootstrapFailure: string | null = null
  const sessionTasks = new Map<string, string>(), observedRevisions = new Map<string, number>(), hydratedRevisions = new Map<string, number>()
  const notify = () => { for (const listener of [...observers]) { try { listener() } catch { /* Consumer failures cannot change connection ownership. */ } } }
  const client = new DesktopClient({ transport: createTauriDesktopTransport(native), commands, events, onState: next => {
    state = next
    if (next.status !== 'ready') { generation++; hydrationGeneration++; hydrationPending = true; recoveryFailed = false; sessionTasks.clear(); observedRevisions.clear(); hydratedRevisions.clear() }
    notify()
  } })
  client.subscribe('agent:status', event => { sessionTasks.set(event.sessionId, event.taskId) })
  client.subscribe('transcript:changed', event => {
    observedRevisions.set(event.taskId, Math.max(observedRevisions.get(event.taskId) ?? 0, event.maxRev))
    if (event.reloadRequired) hydratedRevisions.delete(event.taskId)
  })
  const commandPaths = new Map(Object.entries(NATIVE_COMMAND_BINDINGS).map(([operation, path]) => [path as string, operation as keyof typeof commands]))
  const eventPaths = new Map(Object.entries(NATIVE_EVENT_BINDINGS).map(([operation, path]) => [path as string, operation as keyof typeof events]))
  const namespaces = new Set(['projects.repos', 'projects.resources', 'voice.tts'])
  const nodes = new Map<string, unknown>()
  const functionFor = (path: string): unknown => {
    const operation = commandPaths.get(path)
    if (operation) return async (...args: unknown[]) => {
      if (!reads.has(operation) && hydrationPending) throw new ServiceProtocolError('DISCONNECTED')
      if (operation === 'agentSession:approve') {
        const taskId = sessionTasks.get(String(args[0])), hydrated = taskId ? hydratedRevisions.get(taskId) : undefined
        if (!taskId || hydrated === undefined || hydrated < (observedRevisions.get(taskId) ?? 0)) throw new ServiceProtocolError('DISCONNECTED')
      }
      if (operation === 'agentSession:getTranscriptPage' && isRecord(args[1]) && args[1].mode === 'snapshot') hydratedRevisions.delete(String(args[0]))
      let result: unknown
      try { result = await client.invoke(operation, args as DesktopCommandMap[typeof operation]['apiArguments']) }
      catch (error) {
        if ((operation.startsWith('connectors:') || operation.startsWith('mobile:') || operation.startsWith('voice:') || GIT_PROVIDER_OPERATIONS.some(name => name === operation) || WORKSPACE_FILE_OPERATIONS.some(name => name === operation)) && error instanceof ServiceProtocolError && error.code === 'UNKNOWN_OPERATION') {
          unavailableCapability = path; notify()
        }
        throw error
      }
      if (operation === 'agentSession:getTranscriptSnapshot' && Array.isArray(result)) {
        let revision = 0
        for (const row of result) if (isRecord(row) && typeof row.rev === 'number') revision = Math.max(revision, row.rev)
        hydratedRevisions.set(String(args[0]), revision)
      }
      if ((operation === 'agentSession:getTranscriptDelta' || operation === 'agentSession:getTranscriptPage') && isRecord(result)) {
        const revision = operation === 'agentSession:getTranscriptDelta' ? result.maxRev : result.mode === 'delta' && result.hasMore === false ? result.watermark : undefined
        if (typeof revision === 'number') hydratedRevisions.set(String(args[0]), revision)
      }
      if ((operation === 'agentSession:start' || operation === 'agentSession:resume') && isRecord(result) && typeof result.sessionId === 'string' && result.sessionId && !sessionTasks.has(result.sessionId)) sessionTasks.set(result.sessionId, String(args[1]))
      if (operation === 'agentSession:startTask' && isRecord(result) && typeof result.sessionId === 'string' && result.sessionId && typeof result.startedTaskId === 'string') sessionTasks.set(result.sessionId, result.startedTaskId)
      return result
    }
    if (path === 'onTasksRefresh') return (listener: () => void) => {
      const nativeCleanup = client.subscribe('tasks:refresh', () => listener())
      refreshes.add(listener); let released = false
      return () => { if (!released) { released = true; refreshes.delete(listener); nativeCleanup() } }
    }
    if (path === 'agentInstaller.onProgress') return (listener: (progress: DesktopEventMap['agent-installer:progress']) => void) => { installationObservers.add(listener); return () => { installationObservers.delete(listener) } }
    if (path === 'ui.onCommand') return (listener: (command: UiCommand) => void) => {
      uiObservers.add(listener); return () => { uiObservers.delete(listener) }
    }
    const event = eventPaths.get(path)
    if (event) return (listener: (payload: DesktopEventMap[NonNullable<typeof event>]) => void) => client.subscribe(event, listener)
    if (path.split('.').at(-1)?.startsWith('on')) return undefined
    const unavailable = () => { unavailableCapability = path; notify(); return new DesktopUnavailableError(path) }
    if (path === 'webUtils.getPathForFile') return () => { throw unavailable() }
    return () => Promise.reject(unavailable())
  }
  const hydrate = async () => {
    if (!rehydrate || disposed || client.connection.status !== 'ready') throw new ServiceProtocolError('DISCONNECTED')
    const mine = generation, attempt = ++hydrationGeneration
    hydrationPending = true; recoveryFailed = false; notify()
    try {
      await rehydrate()
      if (mine !== generation || attempt !== hydrationGeneration || client.connection.status !== 'ready') throw new ServiceProtocolError('STALE_EPOCH')
      hydrationPending = false
      for (const listener of [...refreshes]) { try { listener() } catch { /* Local invalidation, not a granted native event. */ } }
      notify()
    } catch (error) {
      if (mine === generation && attempt === hydrationGeneration) { recoveryFailed = true; notify() }
      throw error
    }
  }
  const node = (prefix: string): unknown => {
    if (nodes.has(prefix)) return nodes.get(prefix)
    const value = new Proxy({}, { get(_target, key) {
      if (typeof key !== 'string' || key === 'then' || key === 'browser') return undefined
      const path = prefix ? `${prefix}.${key}` : key
      if ((!prefix && !key.startsWith('on')) || namespaces.has(path)) return node(path)
      if (!nodes.has(path)) nodes.set(path, functionFor(path))
      return nodes.get(path)
    } })
    nodes.set(prefix, value); return value
  }
  return {
    kind: 'tauri', api: node('') as DesktopApi,
    get connection() { return state }, get hydrationPending() { return hydrationPending },
    get unavailableCapability() { return unavailableCapability },
    get recoveryFailed() { return recoveryFailed },
    get bootstrapFailure() { return bootstrapFailure },
    supports: path => commandPaths.has(path) || eventPaths.has(path) || path === 'onTasksRefresh',
    subscribeConnection: listener => { observers.add(listener); return () => { observers.delete(listener) } },
    setRehydrator: callback => { rehydrate = callback },
    rehydrate: hydrate,
    async reconnect() {
      if (disposed) throw new ServiceProtocolError('DISCONNECTED')
      unavailableCapability = null
      bootstrapFailure = null
      hydrationPending = true; recoveryFailed = false; notify()
      uiCleanup?.(); uiCleanup = undefined
      const attempt = ++uiConnectGeneration
      let epoch: string
      try { epoch = await getTauriEngineEpoch(native) }
      catch (error) { if (attempt === uiConnectGeneration && !disposed) { bootstrapFailure = error instanceof NativeBootstrapUnavailableError ? error.explanation : null; client.disconnect('DISCONNECTED'); notify() } throw error }
      if (disposed || attempt !== uiConnectGeneration) throw new ServiceProtocolError('STALE_EPOCH')
      const document = getTauriUiDocument(native)
      if (document) {
        const unlisteners = new Set<() => void>()
        let active = true
        const release = (): void => { active = false; for (const cleanup of unlisteners) cleanup(); unlisteners.clear() }
        uiCleanup = release
        const currentDocument = (value: unknown): value is Record<string, unknown> => {
          const current = getTauriUiDocument(native)
          return active && !disposed && !hydrationPending && state.status === 'ready' && current === document && isRecord(value) && value.engineEpoch === document.engineEpoch && value.leaseId === document.leaseId
        }
        try {
          const subscriptions: Array<{ event: string; receive(value: unknown): void }> = [
            { event: 'desktop:ui-command', receive: value => {
              if (!currentDocument(value) || !hasExactKeys(value, ['engineEpoch', 'leaseId', 'command']) || !isUiLeaseId(value.leaseId) || !isUiCommand(value.command)) return
              for (const observer of [...uiObservers]) { try { observer(structuredClone(value.command)) } catch { /* Consumers do not own native delivery. */ } }
            } },
            { event: 'desktop:agent-installation-progress', receive: value => {
              if (!currentDocument(value) || !hasExactKeys(value, ['engineEpoch', 'leaseId', 'progress']) || !isAgentInstallerProgress(value.progress)) return
              for (const observer of [...installationObservers]) { try { observer(structuredClone(value.progress)) } catch { /* Receipts do not change installation ownership. */ } }
            } }
          ]
          for (const subscription of subscriptions) {
            const cleanup = await native.event.listen<unknown>(subscription.event, event => subscription.receive(event.payload), { target: { kind: 'WebviewWindow', label: 'main' } })
            if (!active || disposed || attempt !== uiConnectGeneration) { cleanup(); throw new ServiceProtocolError('DISCONNECTED') }
            unlisteners.add(cleanup)
          }
        } catch (error) { release(); if (attempt === uiConnectGeneration && !disposed) client.disconnect('DISCONNECTED'); throw error }
      }
      await client.connect(epoch)
      if (disposed || attempt !== uiConnectGeneration) throw new ServiceProtocolError('STALE_EPOCH')
      // Reads during hydration are allowed; mutation/approval is fenced until
      // all retained durable owners have settled against this trusted epoch.
      if (rehydrate) await hydrate()
    },
    dispose() { if (disposed) return; disposed = true; uiConnectGeneration++; uiCleanup?.(); uiCleanup = undefined; uiObservers.clear(); installationObservers.clear(); client.dispose(); observers.clear(); refreshes.clear() }
  }
}
