import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { ChatIpcEvent, ChatMessage, ChatStartRequest, ChatToolCall } from '../../shared/chat'
import { ChatRuntime } from '../chat/chat-runtime'
import { createChatProviderFromSettings } from '../chat/provider-factory'
import type { ChatProvider } from '../chat/providers/types'
import type { ChatToolDefinition } from '../chat/tools'
import { guardedIpcSend } from '../guarded-ipc-send'
import { assertTrustedSender } from '../ipc-sender'
import type { IpcDeps } from './deps'

/**
 * `chat:start` runs one turn of the lightweight chat runtime and streams its
 * events back on `chat:event`; `chat:cancel` aborts it mid-turn. Every model
 * call spends the user's API budget and every tool call acts on their data, so
 * only the main window's own frame may start one.
 *
 * Tools are supplied by the registrar (the Commander's delegation tools come
 * with a later issue). With none, the model can only talk.
 */

export const CHAT_EVENT_CHANNEL = 'chat:event'

const MAX_HISTORY_MESSAGES = 400
const MAX_MESSAGE_CHARS = 200_000
const MAX_SYSTEM_CHARS = 50_000

export interface ChatIpcOptions {
  tools?: ChatToolDefinition[]
  /** Overrides settings-based provider construction (tests, future per-session providers). */
  createProvider?: (deps: IpcDeps) => ChatProvider
  runtime?: ChatRuntime
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isToolCall(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' && isRecord(value.input)
}

/** Only well-formed history reaches a provider; anything else is a client bug, not a prompt. */
export function sanitizeChatMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) throw new Error('chat:start requires a messages array')
  if (raw.length === 0) throw new Error('chat:start requires at least one message')
  if (raw.length > MAX_HISTORY_MESSAGES) throw new Error(`chat:start history exceeds ${MAX_HISTORY_MESSAGES} messages`)
  const messages: ChatMessage[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item.content !== 'string') throw new Error('chat:start message must have string content')
    if (item.content.length > MAX_MESSAGE_CHARS) throw new Error('chat:start message is too long')
    if (item.role === 'user') {
      messages.push({ role: 'user', content: item.content })
    } else if (item.role === 'assistant') {
      const toolCalls = item.toolCalls
      if (toolCalls !== undefined && (!Array.isArray(toolCalls) || !toolCalls.every(isToolCall))) {
        throw new Error('chat:start assistant toolCalls are malformed')
      }
      messages.push({
        role: 'assistant',
        content: item.content,
        ...(Array.isArray(toolCalls) && toolCalls.length > 0 ? { toolCalls: toolCalls as ChatToolCall[] } : {})
      })
    } else if (item.role === 'tool') {
      if (typeof item.toolCallId !== 'string' || typeof item.name !== 'string') throw new Error('chat:start tool message is malformed')
      messages.push({ role: 'tool', toolCallId: item.toolCallId, name: item.name, content: item.content, isError: item.isError === true })
    } else {
      throw new Error(`chat:start unknown message role: ${String(item.role)}`)
    }
  }
  if (messages[messages.length - 1].role === 'assistant') throw new Error('chat:start history must not end with an assistant message')
  return messages
}

export function registerChatHandlers(deps: IpcDeps, options: ChatIpcOptions = {}): ChatRuntime {
  const runtime = options.runtime ?? new ChatRuntime()
  const tools = options.tools ?? []
  const createProvider = options.createProvider ?? ((d: IpcDeps) => createChatProviderFromSettings(d.db))
  // Which turns belong to which window, so a closing window cancels its own turns only.
  const turnOwners = new Map<string, WebContents>()

  ipcMain.handle('chat:start', async (event: IpcMainInvokeEvent, payload: ChatStartRequest) => {
    assertTrustedSender(event, 'chat:start')
    const messages = sanitizeChatMessages(payload?.messages)
    const system = typeof payload?.system === 'string' ? payload.system.slice(0, MAX_SYSTEM_CHARS) : undefined
    const maxToolCalls = typeof payload?.maxToolCalls === 'number' ? payload.maxToolCalls : undefined
    // Provider construction reads settings and keys now, so a missing key is
    // reported as a rejected invoke rather than a mid-stream error event.
    const provider = createProvider(deps)

    const sender = event.sender
    const handle = runtime.startTurn(
      { provider, messages, system, tools, maxToolCalls },
      (chatEvent) => {
        if (sender.isDestroyed()) return
        const message: ChatIpcEvent = { turnId: handle.turnId, event: chatEvent }
        guardedIpcSend(sender, CHAT_EVENT_CHANNEL, message)
      }
    )
    turnOwners.set(handle.turnId, sender)
    const onDestroyed = (): void => handle.cancel()
    sender.once('destroyed', onDestroyed)
    void handle.done.finally(() => {
      turnOwners.delete(handle.turnId)
      if (!sender.isDestroyed()) sender.removeListener('destroyed', onDestroyed)
    })
    return { turnId: handle.turnId, provider: provider.id, model: provider.model }
  })

  ipcMain.handle('chat:cancel', (event: IpcMainInvokeEvent, payload: { turnId?: string }) => {
    const turnId = payload?.turnId
    if (typeof turnId !== 'string') return { cancelled: false }
    // A window may only cancel turns it started.
    if (turnOwners.get(turnId) !== event.sender) return { cancelled: false }
    return { cancelled: runtime.cancel(turnId) }
  })

  return runtime
}
