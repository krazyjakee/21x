import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { COMMANDER_EVENT_CHANNEL, type CommanderEvent, type CommanderListSessionsRequest } from '../../shared/commander'
import { UI_COMMAND_CHANNEL, type UiCommand } from '../../shared/ui-commands'
import { createChatProviderFromSettings } from '../chat/provider-factory'
import type { ChatProvider } from '../chat/providers/types'
import type { ChatToolDefinition } from '../chat/tools'
import { CommanderService, type CommanderToolContext } from '../commander/commander-service'
import { CommanderStore } from '../commander/commander-store'
import { createCommanderProjectTools } from '../commander/project-tools'
import { CaptainDeliveryService } from '../commander/captain-delivery'
import { createCommanderSkillTools } from '../commander/skill-tools'
import { undoCommanderAction } from '../commander/action-undo'
import { installCommanderReportBridge } from '../commander/report-tools'
import { broadcastSkillsChanged } from './settings'
import { recoverIssueWriteOutcomes } from '../captain-github-tools'
import { guardedIpcSend } from '../guarded-ipc-send'
import { assertTrustedSender } from '../ipc-sender'
import { notifyRenderer, uiState } from '../task-api/state'
import type { IpcDeps } from './deps'
import { broadcastProjectChanged } from './projects'

/**
 * Commander chat sessions (docs/commander.md): session CRUD, message history,
 * and `commander:send` / `commander:cancel` for turns. Events stream on
 * `commander:event` to every window that has used the Commander, so a report
 * that arrives while no turn is running still reaches the open view.
 */

export interface CommanderIpcOptions {
  createProvider?: (deps: IpcDeps) => ChatProvider
  /** Replaces the default project tool registry (tests, integrations). */
  getTools?: (context: CommanderToolContext) => ChatToolDefinition[]
}

const MAX_TITLE_INPUT = 500
const MAX_SEARCH_INPUT = 200

let service: CommanderService | null = null
let closing = false
interface CommanderOwner {
  commander: CommanderService
  delivery: CaptainDeliveryService
  recovery: Promise<void>
  stopHost(): void
}
const owners = new Set<CommanderOwner>()

export function shutdownCommanderServices(): void {
  closing = true
  service = null
  for (const owner of owners) {
    owner.commander.shutdown()
    owner.delivery.shutdown()
    owner.stopHost()
  }
}

export async function closeCommanderServices(timeoutMs = 2000): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) {
    throw new RangeError('Commander host shutdown deadline must be an integer from 1 to 3000 ms')
  }
  shutdownCommanderServices()
  const drain = Promise.all([...owners].map(async owner => {
    await Promise.all([owner.commander.close(timeoutMs), owner.delivery.close(timeoutMs), owner.recovery])
    owners.delete(owner)
  }))
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('COMMANDER_HOST_SHUTDOWN_INCOMPLETE')), timeoutMs)
  })
  try { await Promise.race([drain, expired]) }
  finally { if (timer) clearTimeout(timer) }
}

/** The running service, for main-process integrations (#62 report routing). */
export function getCommanderService(): CommanderService | null {
  return service
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} is required`)
  return value
}

/** Pushes one UI command to the window the Task API knows about, or says why it cannot. */
function sendUiCommand(command: UiCommand): { ok: true } | { ok: false; detail: string } {
  if (!uiState.available) return { ok: false, detail: 'No 21x window is open.' }
  if (!notifyRenderer) return { ok: false, detail: 'The window cannot be reached.' }
  notifyRenderer(UI_COMMAND_CHANNEL, command)
  return { ok: true }
}

export function registerCommanderHandlers(deps: IpcDeps, options: CommanderIpcOptions = {}): CommanderService {
  if (closing) throw new Error('COMMANDER_SERVICE_CLOSED')
  const subscribers = new Set<WebContents>()
  const destroyListeners = new Map<WebContents, () => void>()
  const emit = (event: CommanderEvent): void => {
    if (closing) return
    for (const wc of subscribers) {
      if (wc.isDestroyed()) {
        subscribers.delete(wc)
        continue
      }
      guardedIpcSend(wc, COMMANDER_EVENT_CHANNEL, event)
    }
  }
  const createProvider = options.createProvider ?? ((d: IpcDeps) => createChatProviderFromSettings(d.db))
  // The connection is read on use, so registering never touches the database.
  const store = new CommanderStore({ get db() { return deps.db.db } })
  let commanderRef: CommanderService | null = null
  const delivery = new CaptainDeliveryService({
    db: deps.db,
    agents: deps.agentManager,
    onTerminalFailure: (request, reason, timedOut) => {
      if (closing || !commanderRef || !request.sourceSessionId || !request.projectId) return
      const project = deps.db.getProject(request.projectId)
      const key = `captain-request:${request.id}:${timedOut ? 'timeout' : 'failure'}`
      const content = timedOut
        ? `The Captain of "${project?.name ?? request.projectId}" did not report back before the deadline. Retry the request when ready.`
        : `Your request could not be delivered to the Captain of "${project?.name ?? request.projectId}": ${reason}. Retry the request when ready.`
      const { record } = delivery.store.enqueue({
        idempotencyKey: key,
        kind: 'captain_report',
        sourceSessionId: request.sourceSessionId,
        projectId: request.projectId,
        correlationId: request.correlationId,
        payload: content
      })
      try {
        commanderRef.appendReport({
          sessionId: request.sourceSessionId,
          content: timedOut
            ? `The Captain of "${project?.name ?? request.projectId}" did not report back before the deadline. Retry the request when ready.`
            : `Your request could not be delivered to the Captain of "${project?.name ?? request.projectId}": ${reason}. Retry the request when ready.`,
          projectId: request.projectId,
          correlationId: request.correlationId,
          deliveryId: record.id
        })
      } catch (err) {
        console.error('[Commander] Could not record the terminal Captain request outcome:', err)
      }
    }
  })
  const commander: CommanderService = new CommanderService({
    store,
    emit,
    createProvider: () => createProvider(deps),
    getTools: options.getTools ?? ((context) => [
      ...createCommanderProjectTools({
        db: deps.db,
        context,
        agents: deps.agentManager,
        delivery,
        sendUiCommand,
        onProjectChanged: (projectId, kind) => broadcastProjectChanged({ projectId, kind }),
      }),
      // Skill administration (#74): writes act on the first call.
      ...createCommanderSkillTools({
        db: deps.db,
        context,
        onSkillChanged: (skillId, kind) => broadcastSkillsChanged({ skillId, kind })
      })
    ])
  })
  commanderRef = commander
  service = commander

  // #62: `report_to_commander` (Task API route) and the Captain's merges and
  // issue writes reach the sessions through this bridge.
  const removeReportBridge = installCommanderReportBridge({
    service: commander,
    store,
    deliveries: delivery.store,
    getProject: (projectId) => deps.db.getProject(projectId)
  })
  void delivery.reconcile().catch((error) => console.error('[Commander] Durable Captain delivery recovery failed:', error))
  const recovery = Promise.resolve().then(() => closing ? undefined : recoverIssueWriteOutcomes(deps.db))
    .catch((error) => console.error('[IssueWrites] Recovery failed:', error))
  owners.add({ commander, delivery, recovery, stopHost: () => {
    removeReportBridge()
    for (const [sender, listener] of destroyListeners) sender.removeListener?.('destroyed', listener)
    destroyListeners.clear()
    subscribers.clear()
  } })

  /** Every Commander call is from the main window; the caller then receives events. */
  const trusted = (event: IpcMainInvokeEvent, channel: string): void => {
    assertTrustedSender(event, channel)
    if (closing) throw new Error('COMMANDER_SERVICE_CLOSED')
    const sender = event.sender
    if (sender && !subscribers.has(sender)) {
      subscribers.add(sender)
      const onDestroyed = (): void => {
        subscribers.delete(sender)
        destroyListeners.delete(sender)
        // A closed window shows no session: reports only queue from now on.
        commander.setActiveSession(null)
      }
      destroyListeners.set(sender, onDestroyed)
      sender.once?.('destroyed', onDestroyed)
    }
  }

  ipcMain.handle('commander:listSessions', (event, payload?: CommanderListSessionsRequest) => {
    trusted(event, 'commander:listSessions')
    const search = typeof payload?.search === 'string' ? payload.search.slice(0, MAX_SEARCH_INPUT) : undefined
    return store.listSessions({ search, includeArchived: payload?.includeArchived === true })
  })

  ipcMain.handle('commander:createSession', (event, payload?: { title?: string }) => {
    trusted(event, 'commander:createSession')
    const title = typeof payload?.title === 'string' ? payload.title.slice(0, MAX_TITLE_INPUT) : ''
    return store.createSession(title)
  })

  ipcMain.handle('commander:renameSession', (event, payload: { id?: string; title?: string }) => {
    trusted(event, 'commander:renameSession')
    const id = requireString(payload?.id, 'id')
    const title = typeof payload?.title === 'string' ? payload.title.slice(0, MAX_TITLE_INPUT) : ''
    const session = store.renameSession(id, title)
    if (session) emit({ type: 'session_updated', session })
    return session
  })

  ipcMain.handle('commander:archiveSession', (event, payload: { id?: string; archived?: boolean }) => {
    trusted(event, 'commander:archiveSession')
    const id = requireString(payload?.id, 'id')
    if (payload?.archived !== false) commander.cancel(id)
    const session = store.setArchived(id, payload?.archived !== false)
    if (session) emit({ type: 'session_updated', session })
    return session
  })

  ipcMain.handle('commander:listMessages', (event, payload: { sessionId?: string }) => {
    trusted(event, 'commander:listMessages')
    const sessionId = requireString(payload?.sessionId, 'sessionId')
    return { messages: store.listMessages(sessionId), activeTurnId: commander.activeTurnId(sessionId) }
  })

  ipcMain.handle('commander:markRead', (event, payload: { sessionId?: string }) => {
    trusted(event, 'commander:markRead')
    const session = store.markRead(requireString(payload?.sessionId, 'sessionId'))
    if (session) emit({ type: 'session_updated', session })
    return session
  })

  // #62: which session the view shows. A report for it is relayed at once;
  // any other only queues as unread. Null when the view closes.
  ipcMain.handle('commander:setActiveSession', (event, payload?: { sessionId?: string | null }) => {
    trusted(event, 'commander:setActiveSession')
    const sessionId = typeof payload?.sessionId === 'string' && payload.sessionId ? payload.sessionId : null
    commander.setActiveSession(sessionId)
  })

  // `images` (#144) are checked again in the service: type by magic bytes,
  // size, count and total, whatever the renderer already checked.
  ipcMain.handle('commander:send', (event, payload: { sessionId?: string; text?: string; images?: unknown }) => {
    trusted(event, 'commander:send')
    const sessionId = requireString(payload?.sessionId, 'sessionId')
    const { turnId, message } = commander.sendUserMessage(sessionId, typeof payload?.text === 'string' ? payload.text : '', 'typed', payload?.images)
    return { turnId, message }
  })

  // The bytes of one stored image, for the transcript's thumbnails (#144).
  ipcMain.handle('commander:getImage', (event, payload: { id?: string }) => {
    trusted(event, 'commander:getImage')
    const image = store.getImage(requireString(payload?.id, 'id'))
    return image ? { id: image.id, name: image.name, mimeType: image.mime_type, data: image.data } : null
  })

  ipcMain.handle('commander:cancel', (event, payload: { sessionId?: string }) => {
    trusted(event, 'commander:cancel')
    if (typeof payload?.sessionId !== 'string') return { cancelled: false }
    return { cancelled: commander.cancel(payload.sessionId) }
  })

  ipcMain.handle('commander:undoAction', (event, payload: { sessionId?: string; actionId?: string }) => {
    trusted(event, 'commander:undoAction')
    const sessionId = requireString(payload?.sessionId, 'sessionId')
    const actionId = requireString(payload?.actionId, 'actionId')
    const outcome = undoCommanderAction({ db: deps.db, store, agents: deps.agentManager, sessionId, actionId,
      onProjectChanged: (projectId, kind) => broadcastProjectChanged({ projectId, kind }),
      onSkillChanged: (skillId, kind) => broadcastSkillsChanged({ skillId, kind }) })
    if (!outcome.alreadyUndone) {
      emit({ type: 'messages_appended', sessionId, messages: [outcome.message] })
      const current = store.getSession(sessionId)
      if (current) emit({ type: 'session_updated', session: current })
    }
    return outcome
  })

  return commander
}
