import { TASK_LIFECYCLE_CODECS, TASK_LIFECYCLE_EVENT_CODECS } from '@shared/task-lifecycle-codecs'
import { PRODUCTION_AGENT_CODECS } from '@shared/production-agent-codecs'
import { PRODUCTION_AGENT_EVENT_CODECS } from '@shared/production-agent-events'
import { COMMANDER_COMMAND_CODECS, COMMANDER_EVENT_CODECS } from '@shared/commander-desktop-codecs'
import { PRODUCTION_SETTINGS_CODECS } from '@shared/production-settings-codecs'
import { TERMINAL_COMMAND_CODECS, TERMINAL_EVENT_CODECS } from '@shared/terminal-desktop-codecs'
import { MCP_CODECS } from '@shared/mcp-codecs'
import { TASK_SOURCE_CODECS } from '@shared/task-source-codecs'
import type { DesktopApi } from '@shared/desktop-api'
import { DATABASE_COMMAND_CODECS, DATABASE_EVENT_CODECS } from '@shared/database-desktop-codecs'
import { CONFIGURATION_COMMAND_CODECS, CONFIGURATION_EVENT_CODECS } from '@shared/configuration-desktop-codecs'
import { AGENT_COMMAND_CODECS, AGENT_EVENT_CODECS } from '@shared/agent-desktop-codecs'
import { AGENT_CONFIGURATION_CODECS, AGENT_CONFIGURATION_EVENT_CODECS } from '@shared/agent-configuration-codecs'
import type { DesktopCommandMap, DesktopEventMap } from '@shared/desktop-operations'
import { isRecord, ServiceProtocolError } from '@shared/service-protocol'
import { DesktopClient, type DesktopClientState } from './desktop-client'
import { createTauriDesktopTransport, getTauriEngineEpoch, NativeBootstrapUnavailableError, type TauriDesktopApi } from './tauri-desktop-transport'
import { DesktopUnavailableError, type DesktopHost } from './desktop-api'

const commands = { ...DATABASE_COMMAND_CODECS, ...CONFIGURATION_COMMAND_CODECS, ...AGENT_COMMAND_CODECS, ...AGENT_CONFIGURATION_CODECS, ...TASK_LIFECYCLE_CODECS, ...PRODUCTION_AGENT_CODECS, ...COMMANDER_COMMAND_CODECS, ...PRODUCTION_SETTINGS_CODECS, ...TERMINAL_COMMAND_CODECS, ...MCP_CODECS, ...TASK_SOURCE_CODECS }
const events = { ...DATABASE_EVENT_CODECS, ...CONFIGURATION_EVENT_CODECS, ...AGENT_EVENT_CODECS, ...AGENT_CONFIGURATION_EVENT_CODECS, ...PRODUCTION_AGENT_EVENT_CODECS, ...TASK_LIFECYCLE_EVENT_CODECS, ...COMMANDER_EVENT_CODECS, ...TERMINAL_EVENT_CODECS,
  'tasks:refresh': { decodePayload: (value: Parameters<typeof AGENT_CONFIGURATION_EVENT_CODECS['tasks:refresh']['decodePayload']>[0]) => AGENT_CONFIGURATION_EVENT_CODECS['tasks:refresh'].decodePayload(value), validatePayload: (value: unknown) => value === undefined } }
type ApiPath<T> = { [K in keyof T & string]: NonNullable<T[K]> extends (...args: never[]) => unknown ? K : NonNullable<T[K]> extends object ? `${K}.${ApiPath<NonNullable<T[K]>>}` : never }[keyof T & string]
/** Explicit binding is separate from codec validation and native/service authorization. */
export const NATIVE_COMMAND_BINDINGS = {
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
  'taskSource:sync': 'taskSources.sync', 'taskSource:exportUpdate': 'taskSources.exportUpdate', 'taskSource:getUsers': 'taskSources.getUsers', 'taskSource:reassign': 'taskSources.reassign'
} as const satisfies Record<keyof typeof commands, ApiPath<DesktopApi>>
export const NATIVE_EVENT_BINDINGS = {
  'task:created': 'onTaskCreated', 'task:updated': 'onTaskUpdated', 'task:deleted': 'onTaskDeleted', 'project:changed': 'projects.onChanged', 'transcript:changed': 'onTranscriptChanged',
  'skills:changed': 'skills.onChanged', 'agent:status': 'onAgentStatus', 'agent:startQueueChanged': 'onAgentStartQueueChanged',
  'project:statusChanged': 'projects.onStatusChanged', 'concurrency:changed': 'concurrency.onChanged', 'tasks:refresh': 'onTasksRefresh',
  'commander:event': 'commander.onEvent', 'chat:event': 'chat.onEvent', 'terminal:data': 'terminal.onData', 'terminal:exit': 'terminal.onExit'
  // Recovery-state codec exists, but there is no production API binding yet.
} as const satisfies Partial<Record<keyof typeof events, ApiPath<DesktopApi>>>
const reads = new Set<keyof typeof commands>(['db:getTasks', 'db:getTask', 'project:getAll', 'project:get', 'project:getDefault', 'settings:get', 'settings:getAll', 'agent:getAll', 'skills:getAll', 'projectRepo:list', 'projectResource:list', 'agentSession:getTranscriptSnapshot', 'agentSession:getTranscriptDelta', 'agentSession:getTranscriptPage', 'agentConfig:getProviders', 'agentConfig:listModels', 'db:getSubtasks', 'tasks:getCoordinatorTaskId', 'agent:getStartQueue',
  'agent:getStartRecoveryState', 'agentSession:getRawTranscript', 'captainRuntime:get', 'commander:listSessions',
  'commander:listMessages', 'commander:getImage', 'commander:getActivity', 'secrets:getAll', 'env:get', 'terminal:getCwd', 'terminal:getBuffer',
  'mcp:getAll', 'mcp:getOAuthStatus', 'mcp:probeForAuth', 'taskSource:getAll', 'taskSource:getUsers'])

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
      const result: unknown = await client.invoke(operation, args as DesktopCommandMap[typeof operation]['apiArguments'])
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
      let epoch: string
      try { epoch = await getTauriEngineEpoch(native) }
      catch (error) { bootstrapFailure = error instanceof NativeBootstrapUnavailableError ? error.explanation : null; client.disconnect('DISCONNECTED'); notify(); throw error }
      await client.connect(epoch)
      // Reads during hydration are allowed; mutation/approval is fenced until
      // all retained durable owners have settled against this trusted epoch.
      if (rehydrate) await hydrate()
    },
    dispose() { if (disposed) return; disposed = true; client.dispose(); observers.clear(); refreshes.clear() }
  }
}
