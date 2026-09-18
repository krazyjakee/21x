import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { COMMANDER_EVENT_CHANNEL, type CommanderEvent, type CommanderListSessionsRequest } from '../../shared/commander'
import { createChatProviderFromSettings } from '../chat/provider-factory'
import type { ChatProvider } from '../chat/providers/types'
import type { ChatToolDefinition } from '../chat/tools'
import { CommanderService, type CommanderToolContext } from '../commander/commander-service'
import { CommanderStore } from '../commander/commander-store'
import { guardedIpcSend } from '../guarded-ipc-send'
import { assertTrustedSender } from '../ipc-sender'
import type { IpcDeps } from './deps'

/**
 * Commander chat sessions (docs/commander.md): session CRUD, message history,
 * and `commander:send` / `commander:cancel` for turns. Events stream on
 * `commander:event` to every window that has used the Commander, so a report
 * that arrives while no turn is running still reaches the open view.
 */

export interface CommanderIpcOptions {
  createProvider?: (deps: IpcDeps) => ChatProvider
  /** The Commander's tools (#61). */
  getTools?: (context: CommanderToolContext) => ChatToolDefinition[]
}

const MAX_TITLE_INPUT = 500
const MAX_SEARCH_INPUT = 200

let service: CommanderService | null = null

/** The running service, for main-process integrations (#61 tools, #62 report routing). */
export function getCommanderService(): CommanderService | null {
  return service
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} is required`)
  return value
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
  const commander = new CommanderService({
    store,
    emit,
    createProvider: () => createProvider(deps),
    getTools: options.getTools
  })
  service = commander

  /** Every Commander call is from the main window; the caller then receives events. */
  const trusted = (event: IpcMainInvokeEvent, channel: string): void => {
    assertTrustedSender(event, channel)
    const sender = event.sender
    if (sender && !subscribers.has(sender)) {
      subscribers.add(sender)
      sender.once?.('destroyed', () => subscribers.delete(sender))
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

  ipcMain.handle('commander:send', (event, payload: { sessionId?: string; text?: string }) => {
    trusted(event, 'commander:send')
    const sessionId = requireString(payload?.sessionId, 'sessionId')
    const { turnId, message } = commander.sendUserMessage(sessionId, typeof payload?.text === 'string' ? payload.text : '')
    return { turnId, message }
  })

  ipcMain.handle('commander:cancel', (event, payload: { sessionId?: string }) => {
    trusted(event, 'commander:cancel')
    if (typeof payload?.sessionId !== 'string') return { cancelled: false }
    return { cancelled: commander.cancel(payload.sessionId) }
  })

  return commander
}
