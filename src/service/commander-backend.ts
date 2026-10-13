import type { DatabaseManager } from '../main/database/manager'
import type { CommanderService } from '../main/commander/commander-service'
import type { CommanderStore } from '../main/commander/commander-store'
import { undoCommanderAction } from '../main/commander/action-undo'
import type { CommanderAgents } from '../main/commander/project-tools'
import type { ChatRuntime } from '../main/chat/chat-runtime'
import type { ChatProvider } from '../main/chat/providers/types'
import type { ChatToolDefinition } from '../main/chat/tools'
import type { CommanderEvent, CommanderListSessionsRequest } from '../shared/commander'
import type { ChatIpcEvent } from '../shared/chat'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { COMMANDER_COMMAND_CODECS, COMMANDER_EVENT_CODECS, COMMANDER_DESKTOP_OPERATIONS, COMMANDER_DESKTOP_LIMITS, type CommanderDesktopOperation, type CommanderCommandCodec, type CommanderDesktopEvent } from '../shared/commander-desktop-codecs'
import { isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

type Access = 'read' | 'write'
export interface CommanderBackendOptions {
  database: DatabaseManager
  store: CommanderStore
  commander: CommanderService
  chat: ChatRuntime
  agents: CommanderAgents
  createChatProvider(): ChatProvider
  chatTools?: ChatToolDefinition[]
  engineEpoch: string
  assertAvailable(): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  /** Write authority includes the real Commander's cross-project/admin tools. */
  canAccessGlobalCommander(caller: DesktopCallerContext, access: Access): boolean
  canAccessSession(sessionId: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessProject(projectId: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessGlobalSkills(caller: DesktopCallerContext, access: Access): boolean
  emit(operation: string, payload: JsonValue, recipient?: DesktopCallerContext): void
  onFatalEvent(error: ServiceProtocolError): void
}

/** Binds the actual process-owned runtimes. Renderer disconnection never
 * replays an accepted turn or directly owns the Commander provider lifetime. */
export class CommanderBackend {
  readonly registry: DesktopOperationRegistry
  private closing = false
  private failed = false
  private readonly flights = new Set<Promise<unknown>>()
  private readonly commanderTurns = new Map<string, string>()
  private readonly chatOwners = new Map<string, DesktopCallerContext>()
  private activeViewer: string | null = null
  constructor(private readonly options: CommanderBackendOptions) {
    options.assertAvailable()
    if (options.store.database !== options.database.db) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    this.registry.bindEvent('commander:event', COMMANDER_EVENT_CODECS['commander:event'])
    this.registry.bindEvent('chat:event', COMMANDER_EVENT_CODECS['chat:event'])
    this.bindCommands()
  }
  get inflightCount(): number { return this.flights.size }
  shutdown(): void {
    if (this.closing) return
    this.closing = true
    this.options.commander.setActiveSession(null)
    this.activeViewer = null
    for (const [sessionId, turnId] of this.commanderTurns) if (this.options.commander.activeTurnId(sessionId) === turnId) this.options.commander.cancel(sessionId)
    for (const turnId of this.chatOwners.keys()) this.options.chat.cancel(turnId)
  }
  /** ProductionOwner separately shuts down/joins the real runtimes, then DB. */
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid Commander backend shutdown deadline')
    this.shutdown()
    let timer: NodeJS.Timeout | undefined
    try { await Promise.race([Promise.allSettled([...this.flights]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  /** Destruction only, not hide/navigation: preserve Commander and its PiP call. */
  detachCaller(caller: DesktopCallerContext): void {
    if (!this.identified(caller) || caller.principal !== 'trusted-desktop-main' || caller.engineEpoch !== this.options.engineEpoch || !this.options.isTrustedDesktop(caller)) return
    if (this.activeViewer === this.callerKey(caller)) { this.activeViewer = null; this.options.commander.setActiveSession(null) }
    for (const [turnId, owner] of this.chatOwners) if (this.sameCaller(owner, caller)) this.options.chat.cancel(turnId)
  }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(COMMANDER_DESKTOP_OPERATIONS.map(operation => [operation, {
      validatePayload: (payload: unknown) => { try { return isJsonValue(payload) && COMMANDER_COMMAND_CODECS[operation].validateArguments(COMMANDER_COMMAND_CODECS[operation].decodeArguments(payload)) } catch { return false } },
      validateResult: COMMANDER_COMMAND_CODECS[operation].validateWireResult,
      handle: (payload: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, payload, caller, signal)
    }]))
  }
  /** Root calls this on the existing owner stream; no second Commander subscriber. */
  encodeEvent(operation: CommanderDesktopEvent, payload: CommanderEvent | ChatIpcEvent): JsonValue {
    try { return this.registry.encodeEvent(operation, payload, { principal: 'service', engineEpoch: this.options.engineEpoch }) }
    catch { this.eventFailed(); throw new ServiceProtocolError('DISCONNECTED') }
  }
  canReadEvent(operation: CommanderDesktopEvent, payload: CommanderEvent | ChatIpcEvent, caller: DesktopCallerContext): boolean {
    if (!this.options.isTrustedDesktop(caller) || caller.principal !== 'trusted-desktop-main' || caller.engineEpoch !== this.options.engineEpoch) return false
    if (operation === 'chat:event') {
      const owner = this.chatOwners.get((payload as ChatIpcEvent).turnId)
      return !!owner && this.sameCaller(owner, caller) && this.options.canAccessGlobalCommander(caller, 'read')
    }
    const event = payload as CommanderEvent
    return this.sessionAllowed(event.type === 'session_updated' ? event.session.id : event.sessionId, caller, 'read') &&
      (event.type !== 'messages_appended' || event.messages.every(message => !message.project_id || this.options.canAccessProject(message.project_id, caller, 'read')))
  }
  private available(): void { if (this.closing || this.failed) throw new ServiceProtocolError('DISCONNECTED'); this.options.assertAvailable() }
  private retain<T>(flight: Promise<T>): Promise<T> {
    this.flights.add(flight)
    void flight.then(() => this.flights.delete(flight), () => this.flights.delete(flight))
    return flight
  }
  private callerKey(caller: DesktopCallerContext): string { return JSON.stringify([caller.engineEpoch, caller.webviewId, caller.origin]) }
  private sameCaller(one: DesktopCallerContext, two: DesktopCallerContext): boolean { return this.callerKey(one) === this.callerKey(two) }
  private identified(caller: DesktopCallerContext): boolean { return typeof caller.webviewId === 'string' && !!caller.webviewId && typeof caller.origin === 'string' && !!caller.origin }
  private sessionAllowed(sessionId: string, caller: DesktopCallerContext, access: Access): boolean {
    if (!this.identified(caller) || !this.options.canAccessGlobalCommander(caller, access) || !this.options.canAccessGlobalCommander(caller, 'read') || !this.options.canAccessSession(sessionId, caller, access) || !this.options.canAccessSession(sessionId, caller, 'read')) return false
    // Store get/rename/read return the entire legacy session row. Inspect only
    // SQLite lengths before any such read can materialize corrupt large fields.
    const oversizedSession = this.options.database.db.prepare(`SELECT 1 FROM commander_sessions WHERE id=? AND
      (length(CAST(title AS BLOB))>2000 OR length(CAST(created_at AS BLOB))>32 OR length(CAST(updated_at AS BLOB))>32 OR
       length(CAST(archived AS BLOB))>16 OR length(CAST(last_read_at AS BLOB))>32) LIMIT 1`).get(sessionId)
    if (oversizedSession) return false
    const invalid = this.options.database.db.prepare('SELECT 1 FROM commander_messages WHERE session_id=? AND project_id IS NOT NULL AND length(CAST(project_id AS BLOB))>128 LIMIT 1').get(sessionId)
    if (invalid) return false
    const projects = this.options.database.db.prepare('SELECT DISTINCT project_id FROM commander_messages WHERE session_id=? AND project_id IS NOT NULL LIMIT ?').all(sessionId, COMMANDER_DESKTOP_LIMITS.records + 1) as Array<{ project_id: string }>
    return projects.length <= COMMANDER_DESKTOP_LIMITS.records && projects.every(row => this.options.canAccessProject(row.project_id, caller, 'read'))
  }
  private preflightMessages(sessionId: string, includeImages = false): void {
    const stats = this.options.database.db.prepare(`SELECT COUNT(*) AS count,
      COALESCE(SUM(length(CAST(content AS BLOB)) + COALESCE(length(CAST(tool_calls AS BLOB)),0) + length(CAST(id AS BLOB)) + length(CAST(session_id AS BLOB)) +
        COALESCE(length(CAST(tool_name AS BLOB)),0) + COALESCE(length(CAST(tool_call_id AS BLOB)),0) + COALESCE(length(CAST(project_id AS BLOB)),0) + COALESCE(length(CAST(correlation_id AS BLOB)),0)),0) AS bytes,
      COALESCE(MAX(length(CAST(content AS BLOB))),0) AS content,
      COALESCE(MAX(length(CAST(tool_calls AS BLOB))),0) AS calls,
      COALESCE(MAX(MAX(length(CAST(id AS BLOB)),COALESCE(length(CAST(tool_call_id AS BLOB)),0),COALESCE(length(CAST(correlation_id AS BLOB)),0))),0) AS identity,
      COALESCE(MAX(length(CAST(tool_name AS BLOB))),0) AS tool,
      COALESCE(MAX(MAX(COALESCE(length(CAST(input_mode AS BLOB)),0),length(CAST(role AS BLOB)),length(CAST(is_error AS BLOB)))),0) AS mode,
      COALESCE(MAX(length(CAST(created_at AS BLOB))),0) AS timestamp FROM commander_messages WHERE session_id=?`).get(sessionId) as { count: number; bytes: number; content: number; calls: number; identity: number; tool: number; mode: number; timestamp: number }
    if (stats.count > COMMANDER_DESKTOP_LIMITS.records || stats.bytes > 512 * 1024 || stats.content > COMMANDER_DESKTOP_LIMITS.fieldBytes || stats.calls > COMMANDER_DESKTOP_LIMITS.fieldBytes || stats.identity > 512 || stats.tool > 256 || stats.mode > 16 || stats.timestamp > 32) throw new ServiceProtocolError('FRAME_TOO_LARGE')
    const refs = this.options.database.db.prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(length(CAST(name AS BLOB))),0) AS name,
      COALESCE(MAX(length(CAST(id AS BLOB))),0) AS id, COALESCE(MAX(length(CAST(mime_type AS BLOB))),0) AS mime,
      COALESCE(MAX(length(CAST(size AS BLOB))),0) AS size, COALESCE(SUM(length(CAST(data AS BLOB))),0) AS bytes
      FROM commander_images WHERE message_id IN (SELECT id FROM commander_messages WHERE session_id=?)`).get(sessionId) as { count: number; name: number; id: number; mime: number; size: number; bytes: number }
    if (refs.count > COMMANDER_DESKTOP_LIMITS.records * COMMANDER_DESKTOP_LIMITS.images || refs.name > 200 || refs.id > 128 || refs.mime > 64 || refs.size > 32 || includeImages && refs.bytes > COMMANDER_DESKTOP_LIMITS.imageTotalBytes) throw new ServiceProtocolError('FRAME_TOO_LARGE')
  }
  private listSessions(options: CommanderListSessionsRequest | undefined, caller: DesktopCallerContext) {
    const conditions = options?.includeArchived ? [] : ['s.archived=0'], params: unknown[] = []
    const search = options?.search?.trim()
    if (search) {
      const pattern = `%${search.replace(/[\\%_]/g, character => `\\${character}`)}%`
      conditions.push("(s.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM commander_messages m WHERE m.session_id=s.id AND m.role IN ('user','assistant','report') AND m.content LIKE ? ESCAPE '\\'))")
      params.push(pattern, pattern)
    }
    const stats = this.options.database.db.prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(length(CAST(s.title AS BLOB))),0) AS title,
      COALESCE(MAX(length(CAST(s.id AS BLOB))),0) AS id,
      COALESCE(MAX(MAX(length(CAST(s.created_at AS BLOB)),length(CAST(s.updated_at AS BLOB)),COALESCE(length(CAST(s.last_read_at AS BLOB)),0))),0) AS timestamp,
      COALESCE(MAX(length(CAST(s.archived AS BLOB))),0) AS archived FROM commander_sessions s${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''}`).get(...params) as { count: number; title: number; id: number; timestamp: number; archived: number }
    if (stats.count > COMMANDER_DESKTOP_LIMITS.records || stats.title > 2000 || stats.id > 128 || stats.timestamp > 32 || stats.archived > 16) throw new ServiceProtocolError('FRAME_TOO_LARGE')
    return this.options.store.listSessions(options).filter(session => this.sessionAllowed(session.id, caller, 'read'))
  }
  private imageOwner(imageId: string): { session_id: string | null; size: number | null; bytes: number; name: number; mime: number } | undefined {
    return this.options.database.db.prepare(`SELECT CASE WHEN length(CAST(m.session_id AS BLOB))<=128 THEN m.session_id ELSE NULL END AS session_id,
      CASE WHEN typeof(i.size)='integer' AND typeof(i.data)='blob' THEN i.size ELSE NULL END AS size,
      length(CAST(i.data AS BLOB)) AS bytes,length(CAST(i.name AS BLOB)) AS name,length(CAST(i.mime_type AS BLOB)) AS mime
      FROM commander_images i JOIN commander_messages m ON m.id=i.message_id WHERE i.id=?`).get(imageId) as { session_id: string | null; size: number | null; bytes: number; name: number; mime: number } | undefined
  }
  private eventFailed(): void {
    if (this.failed) return
    this.failed = true
    this.options.onFatalEvent(new ServiceProtocolError('DISCONNECTED'))
  }
  private emit(operation: CommanderDesktopEvent, payload: CommanderEvent | ChatIpcEvent, recipient?: DesktopCallerContext): void {
    if (this.closing) return
    const encoded = this.encodeEvent(operation, payload)
    try { this.options.emit(operation, encoded, recipient) } catch { this.eventFailed(); throw new ServiceProtocolError('DISCONNECTED') }
  }
  private emitSession(sessionId: string): void { const session = this.options.store.getSession(sessionId); if (session) this.emit('commander:event', { type: 'session_updated', session }) }
  private notifyChanged(operation: string, payload: JsonValue): void {
    try { this.options.emit(operation, payload) } catch { this.eventFailed(); throw new ServiceProtocolError('DISCONNECTED') }
  }
  private bind<K extends CommanderDesktopOperation>(operation: K,
    authorize: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext) => boolean,
    effect: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext, signal: AbortSignal) => unknown | Promise<unknown>): void {
    const codec = COMMANDER_COMMAND_CODECS[operation] as CommanderCommandCodec<K>
    this.registry.bindCommand(operation, {
      decodeRequest: codec.decodeArguments, validateArguments: codec.validateArguments,
      authorize: (args, caller) => { this.available(); return authorize(args, caller) },
      invoke: (args, caller, signal) => this.retain((async () => {
        this.available(); if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
        if (!authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const result = await effect(args, caller, signal)
        if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
        this.available()
        if (!authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const encoded = codec.encodeResult(result)
        return codec.decodeResult(encoded.defined ? encoded.value : undefined)
      })()), validateResult: codec.validateResult, encodeResult: codec.encodeResult
    })
  }
  private undoAllowed(sessionId: string, actionId: string, caller: DesktopCallerContext): boolean {
    if (!this.sessionAllowed(sessionId, caller, 'write')) return false
    const row = this.options.database.db.prepare(`SELECT CASE WHEN length(CAST(target AS BLOB))<=8192 THEN target ELSE NULL END AS target,
      length(CAST(target AS BLOB)) AS bytes,length(CAST(changes AS BLOB)) AS changes,length(CAST(tool_name AS BLOB)) AS tool FROM commander_actions WHERE id=? AND session_id=?`).get(actionId, sessionId) as { target: string | null; bytes: number; changes: number; tool: number } | undefined
    if (!row || row.target === null || row.bytes > 8192 || row.changes > 512 * 1024 || row.tool > 256) return false
    let target: unknown
    try { target = JSON.parse(row.target) } catch { return false }
    if (!isRecord(target) || typeof target.id !== 'string') return false
    const db = this.options.database
    if (target.kind === 'project') return !!db.getProject(target.id) && this.options.canAccessProject(target.id, caller, 'write')
    if (target.kind === 'repo') { const repo = db.getProjectRepo(target.id); return !!repo && repo.project_id === target.projectId && this.options.canAccessProject(repo.project_id, caller, 'write') }
    if (target.kind === 'resource') { const resource = db.getProjectResource(target.id); return !!resource && resource.project_id === target.projectId && this.options.canAccessProject(resource.project_id, caller, 'write') }
    if (target.kind === 'skill') { const skill = db.getSkill(target.id); return !!skill && (skill.project_id ?? null) === (target.projectId ?? null) && (skill.project_id ? this.options.canAccessProject(skill.project_id, caller, 'write') : this.options.canAccessGlobalSkills(caller, 'write')) }
    return target.kind === 'all-projects' && this.options.canAccessGlobalCommander(caller, 'write')
  }
  private bindCommands(): void {
    const { commander, store } = this.options
    const global = (caller: DesktopCallerContext, access: Access) => this.identified(caller) && this.options.canAccessGlobalCommander(caller, access) && this.options.canAccessGlobalCommander(caller, 'read')
    this.bind('commander:listSessions', (_args, caller) => global(caller, 'read'), ([opts], caller) => this.listSessions(opts, caller))
    this.bind('commander:createSession', (_args, caller) => global(caller, 'write'), ([opts]) => { const session = store.createSession(opts?.title); this.emitSession(session.id); return session })
    this.bind('commander:renameSession', ([id], caller) => this.sessionAllowed(id, caller, 'write'), ([id, title]) => { const session = store.renameSession(id, title); if (session) this.emitSession(id); return session })
    this.bind('commander:archiveSession', ([id], caller) => this.sessionAllowed(id, caller, 'write'), ([id, archived]) => { if (archived) commander.cancel(id); const session = store.setArchived(id, archived); if (session) this.emitSession(id); return session })
    this.bind('commander:markRead', ([id], caller) => this.sessionAllowed(id, caller, 'write'), ([id]) => { const session = store.markRead(id); if (session) this.emitSession(id); return session })
    this.bind('commander:listMessages', ([id], caller) => this.sessionAllowed(id, caller, 'read'), ([id]) => { this.preflightMessages(id); return { messages: store.listMessages(id), activeTurnId: commander.activeTurnId(id) } })
    this.bind('commander:getActivity', ([id], caller) => this.sessionAllowed(id, caller, 'read'), ([id]) => commander.activitySnapshot(id))
    this.bind('commander:setActiveSession', ([id], caller) => global(caller, 'write') && (id === null ? !this.activeViewer || this.activeViewer === this.callerKey(caller) : this.sessionAllowed(id, caller, 'read')), ([id], caller) => { commander.setActiveSession(id); this.activeViewer = id === null ? null : this.callerKey(caller) })
    this.bind('commander:send', ([id], caller) => this.sessionAllowed(id, caller, 'write'), ([id, content, images]) => {
      this.preflightMessages(id, true)
      const accepted = commander.sendUserMessage(id, content, 'typed', images)
      this.commanderTurns.set(id, accepted.turnId)
      this.retain(accepted.done).then(() => { if (this.commanderTurns.get(id) === accepted.turnId) this.commanderTurns.delete(id) }, () => { if (this.commanderTurns.get(id) === accepted.turnId) this.commanderTurns.delete(id) })
      return { turnId: accepted.turnId, message: accepted.message }
    })
    this.bind('commander:cancel', ([id], caller) => this.sessionAllowed(id, caller, 'write'), ([id]) => ({ cancelled: commander.cancel(id) }))
    this.bind('commander:getImage', ([id], caller) => { const owner = this.imageOwner(id); return global(caller, 'read') && (!owner || owner.session_id !== null && this.sessionAllowed(owner.session_id, caller, 'read')) }, ([id]) => {
      const owner = this.imageOwner(id)
      if (!owner) return null
      if (owner.bytes !== owner.size || owner.bytes > COMMANDER_DESKTOP_LIMITS.imageBytes || owner.name > 200 || owner.mime > 64) throw new ServiceProtocolError('FRAME_TOO_LARGE')
      const image = store.getImage(id)
      return image ? { id: image.id, name: image.name, mimeType: image.mime_type, data: image.data } : null
    })
    this.bind('commander:undoAction', ([id, actionId], caller) => this.undoAllowed(id, actionId, caller), ([sessionId, actionId]) => {
      const agents = new Proxy(this.options.agents, { get: (target, key) => {
        const value = Reflect.get(target, key)
        if (key === 'releaseCaptainIfAgentChanged' && typeof value === 'function') return (projectId: string) => this.retain(Promise.resolve(value.call(target, projectId)))
        return typeof value === 'function' ? value.bind(target) : value
      } })
      const result = undoCommanderAction({ db: this.options.database, store, agents, sessionId, actionId,
        onProjectChanged: (projectId, kind) => this.notifyChanged('project:changed', { projectId, kind }),
        onSkillChanged: (skillId, kind) => this.notifyChanged('skills:changed', { skillId, kind }) })
      if (!result.alreadyUndone) { this.emit('commander:event', { type: 'messages_appended', sessionId, messages: [result.message] }); this.emitSession(sessionId) }
      return result
    })
    this.bind('chat:start', (_args, caller) => global(caller, 'write'), ([request], caller) => {
      const provider = this.options.createChatProvider()
      if (request.messages.some(message => message.role === 'user' && message.images?.length) && provider.supportsImages !== true) throw new ServiceProtocolError('INVALID_ARGUMENTS')
      const owner = { ...caller }
      const handle = this.options.chat.startTurn({ provider, messages: request.messages, system: request.system, maxToolCalls: request.maxToolCalls, tools: this.options.chatTools ?? [] }, event => {
        if (this.closing || this.failed) return
        try { this.emit('chat:event', { turnId: handle.turnId, event }, owner) } catch { /* The accepted runtime remains owned; its result is never replayed. */ }
      })
      this.chatOwners.set(handle.turnId, owner)
      this.retain(handle.done).then(() => this.chatOwners.delete(handle.turnId), () => this.chatOwners.delete(handle.turnId))
      return { turnId: handle.turnId, provider: provider.id, model: provider.model }
    })
    this.bind('chat:cancel', ([id], caller) => global(caller, 'write') && (!this.chatOwners.has(id) || this.sameCaller(this.chatOwners.get(id)!, caller)), ([id]) => ({ cancelled: this.chatOwners.has(id) && this.options.chat.cancel(id) }))
  }
}
