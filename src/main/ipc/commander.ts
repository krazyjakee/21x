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
import { createCommanderMergeGrantTools } from '../commander/merge-grant-tools'
import { installCommanderReportBridge } from '../commander/report-tools'
import { broadcastSkillsChanged } from './settings'
import { listHeldActions, recoverMergeGrantOutcomes, recoverIssueWriteOutcomes } from '../escalation'
import { guardedIpcSend } from '../guarded-ipc-send'
import { assertTrustedSender } from '../ipc-sender'
import { notifyRenderer, uiState } from '../task-api/state'
import type { IpcDeps } from './deps'
import { broadcastProjectChanged } from './projects'
import { SessionUsageStore } from '../sessions/usage-store'
import { SessionLedgerRecorder } from '../sessions/ledger-recorder'

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
  const subscribers = new Set<WebContents>()
  const emit = (event: CommanderEvent): void => {
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
      if (!commanderRef || !request.sourceSessionId || !request.projectId) return
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
    usage: new SessionUsageStore({ get db() { return deps.db.db } }),
    ledger: new SessionLedgerRecorder({ get db() { return deps.db.db } }),
    createProvider: () => createProvider(deps),
    getTools: options.getTools ?? ((context) => [
      ...createCommanderProjectTools({
        db: deps.db,
        context,
        agents: deps.agentManager,
        delivery,
        listHeldActions,
        sendUiCommand,
        onProjectChanged: (projectId, kind) => broadcastProjectChanged({ projectId, kind }),
      }),
      // Merge grants (#137): list and revoke; creating one goes through ask_captain.
      ...createCommanderMergeGrantTools({ db: deps.db, context }),
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

  // #62: `report_to_commander` (Task API route) and `tell_commander`
  // escalations reach the sessions through this bridge.
  installCommanderReportBridge({
    service: commander,
    store,
    deliveries: delivery.store,
    getProject: (projectId) => deps.db.getProject(projectId)
  })
  void delivery.reconcile().catch((error) => console.error('[Commander] Durable Captain delivery recovery failed:', error))
  void recoverMergeGrantOutcomes(deps.db).catch((error) => console.error('[MergeGrants] Recovery failed:', error))
  void recoverIssueWriteOutcomes(deps.db).catch((error) => console.error('[IssueWrites] Recovery failed:', error))

  /** Every Commander call is from the main window; the caller then receives events. */
  const trusted = (event: IpcMainInvokeEvent, channel: string): void => {
    assertTrustedSender(event, channel)
    const sender = event.sender
    if (sender && !subscribers.has(sender)) {
      subscribers.add(sender)
      sender.once?.('destroyed', () => {
        subscribers.delete(sender)
        // A closed window shows no session: reports only queue from now on.
        commander.setActiveSession(null)
      })
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

  return commander
}
