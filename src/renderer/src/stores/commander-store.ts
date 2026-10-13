import { activityNow } from '@/lib/activity/activity-clock'
import { parseCommanderAction } from '@shared/commander-action'
import { create } from 'zustand'
import type { CommanderEvent, CommanderMessage, CommanderSession } from '@shared/commander'
import { commanderApi } from '@/lib/ipc-client'
import { seedCommanderImages } from '@/lib/commander-images'
import type { ChatImageInput } from '@shared/chat-images'

/**
 * Commander sessions in the renderer (docs/commander.md).
 *
 * Main owns the data: every message is stored there and arrives here through
 * `commander:event`. This store keeps the session list, the loaded histories,
 * and the in-flight turn per session (streamed text and tool calls) until the
 * stored messages replace it.
 */

export interface StreamingToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  result?: string
  isError?: boolean
}

export interface StreamingTurn {
  turnId: string
  text: string
  toolCalls: StreamingToolCall[]
}

export interface CommanderActionNotice {
  call: NonNullable<CommanderMessage['tool_calls']>[number]
  result: CommanderMessage
  requestedBy?: CommanderMessage
  observedAt: number
}

interface CommanderState {
  drafts: Record<string, string>
  setDraft: (sessionId: string, text: string) => void
  recentAction: CommanderActionNotice | null
  sessions: CommanderSession[]
  undoingActions: string[]
  undoneActions: string[]
  undoAction: (sessionId: string, actionId: string) => Promise<void>
  reportInbox: CommanderSession | null
  unseenReports: Record<string, string[]>
  readReports: (sessionId: string) => Promise<void>
  selectedSessionId: string | null
  search: string
  showArchived: boolean
  messages: Record<string, CommanderMessage[]>
  streaming: Record<string, StreamingTurn | undefined>
  /** The last turn error per session, cleared by the next send. */
  turnErrors: Record<string, string | undefined>
  isLoading: boolean
  error: string | null

  /** Subscribes to main's events. Idempotent; returns an unsubscribe. */
  subscribe: () => () => void
  fetchSessions: () => Promise<void>
  setSearch: (search: string) => Promise<void>
  setShowArchived: (show: boolean) => Promise<void>
  selectSession: (id: string | null) => Promise<void>
  createSession: () => Promise<CommanderSession | null>
  renameSession: (id: string, title: string) => Promise<void>
  archiveSession: (id: string, archived: boolean) => Promise<void>
  /** `images` (#144) may stand in for text: a message needs one or the other. */
  send: (text: string, images?: ChatImageInput[]) => Promise<boolean>
  cancel: () => Promise<void>
  handleEvent: (event: CommanderEvent) => void
}

let unsubscribeEvents: (() => void) | null = null
let eventSubscribers = 0
/**
 * Turns whose `done` already arrived. `commander:send` resolves on the invoke
 * channel and events on another, so a fast turn's `done` can beat the reply;
 * the reply must not then restart a finished turn's streaming state.
 */
const finishedTurns = new Set<string>()
const MAX_FINISHED_TURNS = 200

function rememberFinished(turnId: string): void {
  finishedTurns.add(turnId)
  if (finishedTurns.size > MAX_FINISHED_TURNS) finishedTurns.delete(finishedTurns.values().next().value as string)
}

function sortSessions(sessions: CommanderSession[]): CommanderSession[] {
  return [...sessions].sort((a, b) => b.updated_at - a.updated_at)
}

function mergeMessages(existing: CommanderMessage[], incoming: CommanderMessage[]): CommanderMessage[] {
  const seen = new Set(existing.map((m) => m.id))
  const added = incoming.filter((m) => !seen.has(m.id))
  if (added.length === 0) return existing
  return [...existing, ...added].sort((a, b) => a.created_at - b.created_at)
}

export const useCommanderStore = create<CommanderState>((set, get) => ({
  drafts: {},
  setDraft: (sessionId, text) => set(state => ({ drafts: { ...state.drafts, [sessionId]: text } })),
  recentAction: null,
  sessions: [],
  undoingActions: [], undoneActions: [],
  undoAction: async (sessionId, actionId) => {
    if (get().undoingActions.includes(actionId) || get().undoneActions.includes(actionId)) return
    set(state => ({ undoingActions: [...state.undoingActions, actionId] }))
    try {
      const result = await commanderApi.undoAction(sessionId, actionId)
      get().handleEvent({ type: 'messages_appended', sessionId, messages: [result.message] })
      set(state => ({ undoneActions: [...state.undoneActions, actionId] }))
    } finally { set(state => ({ undoingActions: state.undoingActions.filter(id => id !== actionId) })) }
  },
  reportInbox: null, unseenReports: {},
  readReports: async (id) => {
    const session = await commanderApi.markRead(id)
    if (session) get().handleEvent({ type: 'session_updated', session })
    set(state => ({ unseenReports: { ...state.unseenReports, [id]: [] } }))
  },
  selectedSessionId: null,
  search: '',
  showArchived: false,
  messages: {},
  streaming: {},
  turnErrors: {},
  isLoading: false,
  error: null,

  subscribe: () => {
    if (!unsubscribeEvents) {
      unsubscribeEvents = commanderApi.onEvent((event) => get().handleEvent(event)) ?? null
    }
    eventSubscribers++
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      if (--eventSubscribers === 0) { unsubscribeEvents?.(); unsubscribeEvents = null }
    }
  },

  fetchSessions: async () => {
    set({ isLoading: true, error: null })
    try {
      const { search, showArchived } = get()
      const sessions = await commanderApi.listSessions({ search: search || undefined, includeArchived: showArchived })
      set({ sessions: sortSessions(sessions), reportInbox: sessions.find(session => session.is_report_inbox) ?? get().reportInbox, isLoading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), isLoading: false })
    }
  },

  setSearch: async (search) => {
    set({ search })
    await get().fetchSessions()
  },

  setShowArchived: async (showArchived) => {
    set({ showArchived })
    await get().fetchSessions()
  },

  selectSession: async (id) => {
    set({ selectedSessionId: id })
    // Opening a thread marks its reports read; quiet delivery never buys a model turn.
    void Promise.resolve(commanderApi.setActiveSession(id)).catch(() => {})
    if (!id) return
    try {
      const { messages, activeTurnId } = await commanderApi.listMessages(id)
      set((state) => ({
        // mergeMessages(existing, incoming) drops `incoming` entries whose id is
        // already in `existing`, so the stored fetch dedupes against local state
        // instead of the combined array (which contains each id twice).
        messages: { ...state.messages, [id]: mergeMessages(state.messages[id] ?? [], messages) },
        undoneActions: [...new Set([...state.undoneActions, ...messages.filter(message => message.tool_name === 'undo_action' && message.tool_call_id).map(message => message.tool_call_id!)])],
        // Main is the truth about running turns: events may have been missed
        // while the view was closed, so a turn that ended meanwhile is cleared.
        streaming: !activeTurnId
          ? { ...state.streaming, [id]: undefined }
          : state.streaming[id]?.turnId === activeTurnId
            ? state.streaming
            : { ...state.streaming, [id]: { turnId: activeTurnId, text: '', toolCalls: [] } }
      }))
      // Opening a session reads its reports.
      await get().readReports(id)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  createSession: async () => {
    try {
      const session = await commanderApi.createSession()
      set((state) => ({
        sessions: sortSessions([session, ...state.sessions.filter((s) => s.id !== session.id)]),
        messages: { ...state.messages, [session.id]: [] },
        selectedSessionId: session.id
      }))
      return session
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      return null
    }
  },

  renameSession: async (id, title) => {
    const session = await commanderApi.renameSession(id, title)
    if (session) get().handleEvent({ type: 'session_updated', session })
  },

  archiveSession: async (id, archived) => {
    const session = await commanderApi.archiveSession(id, archived)
    if (session) get().handleEvent({ type: 'session_updated', session })
    if (archived && get().selectedSessionId === id && !get().showArchived) set({ selectedSessionId: null })
  },

  send: async (text, images) => {
    const sessionId = get().selectedSessionId
    const trimmed = text.trim()
    if (!sessionId || (!trimmed && !images?.length) || get().streaming[sessionId]) return false
    set((state) => ({ turnErrors: { ...state.turnErrors, [sessionId]: undefined } }))
    try {
      const { turnId, message } = images?.length
        ? await commanderApi.send(sessionId, trimmed, images)
        : await commanderApi.send(sessionId, trimmed)
      // The thumbnails are on screen already; no need to fetch the bytes back.
      if (images?.length) seedCommanderImages(message.images, images)
      set((state) => ({
        messages: { ...state.messages, [sessionId]: mergeMessages(state.messages[sessionId] ?? [], [message]) },
        // turn_started may already have arrived (keep whatever streamed), or
        // the whole turn may already be over.
        streaming: state.streaming[sessionId] || finishedTurns.has(turnId)
          ? state.streaming
          : { ...state.streaming, [sessionId]: { turnId, text: '', toolCalls: [] } }
      }))
      return true
    } catch (err) {
      // Electron wraps a handler's error ("Error invoking remote method 'x': Error: …");
      // the user reads only the reason, e.g. that the model can't read images.
      const reason = (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')
      set((state) => ({ turnErrors: { ...state.turnErrors, [sessionId]: reason } }))
      return false
    }
  },

  cancel: async () => {
    const sessionId = get().selectedSessionId
    if (sessionId) await commanderApi.cancel(sessionId)
  },

  handleEvent: (event) => {
    switch (event.type) {
      case 'turn_started': {
        if (finishedTurns.has(event.turnId)) return
        set((state) => ({
          streaming: { ...state.streaming, [event.sessionId]: { turnId: event.turnId, text: '', toolCalls: [] } }
        }))
        return
      }
      case 'turn_event': {
        const { sessionId, turnId } = event
        const inner = event.event
        if (inner.type === 'done') {
          rememberFinished(turnId)
          set((state) => ({ streaming: { ...state.streaming, [sessionId]: undefined } }))
          return
        }
        if (finishedTurns.has(turnId)) return
        if (inner.type === 'error') {
          set((state) => ({ turnErrors: { ...state.turnErrors, [sessionId]: inner.message } }))
          return
        }
        set((state) => {
          const current = state.streaming[sessionId]
          const turn: StreamingTurn = current && current.turnId === turnId ? current : { turnId, text: '', toolCalls: [] }
          let next: StreamingTurn = turn
          if (inner.type === 'text_delta') {
            next = { ...turn, text: turn.text + inner.text }
          } else if (inner.type === 'tool_call_start') {
            next = { ...turn, toolCalls: [...turn.toolCalls, { id: inner.id, name: inner.name, input: inner.input }] }
          } else if (inner.type === 'tool_call_result') {
            next = {
              ...turn,
              toolCalls: turn.toolCalls.map((c) => (c.id === inner.id ? { ...c, result: inner.content, isError: inner.isError } : c))
            }
          }
          const call = inner.type === 'tool_call_result' ? turn.toolCalls.find(call => call.id === inner.id) : undefined
          const action = call && inner.type === 'tool_call_result' ? parseCommanderAction(call.name, inner.content, inner.isError) : null
          const recentAction = action && call && inner.type === 'tool_call_result' ? {
            call, result: { id: `live:${turnId}:${call.id}`, session_id: sessionId, role: 'tool' as const,
              content: inner.content, is_error: inner.isError, tool_calls: null, tool_call_id: call.id,
              tool_name: call.name, project_id: null, correlation_id: null, created_at: Date.now() },
            requestedBy: [...(state.messages[sessionId] ?? [])].reverse().find(message => message.role === 'user'), observedAt: activityNow()
          } : state.recentAction
          return { streaming: { ...state.streaming, [sessionId]: next }, recentAction }
        })
        return
      }
      case 'messages_appended': {
        const { sessionId, messages } = event
        const state = get()
        const loaded = state.messages[sessionId]
        const stored = messages.some((m) => m.tool_name !== 'undo_action' && (m.role === 'assistant' || m.role === 'tool'))
        set({
          undoneActions: [...new Set([...state.undoneActions, ...messages.filter(message => message.tool_name === 'undo_action' && message.tool_call_id).map(message => message.tool_call_id!)])],
          unseenReports: { ...state.unseenReports, [sessionId]: [...new Set([...(state.unseenReports[sessionId] ?? []), ...messages.filter(message => message.role === 'report').map(message => message.id)])] },
          messages: loaded ? { ...state.messages, [sessionId]: mergeMessages(loaded, messages) } : state.messages,
          // Stored assistant output replaces the streamed text of the same turn.
          streaming: stored && state.streaming[sessionId]
            ? { ...state.streaming, [sessionId]: { ...state.streaming[sessionId]!, text: '', toolCalls: [] } }
            : state.streaming
        })
        // Quiet reports keep their unread marker until the user explicitly reads them.
        return
      }
      case 'session_updated': {
        const { session } = event
        set((state) => {
          const others = state.sessions.filter((s) => s.id !== session.id)
          // With a search active, only sessions already in the results are updated.
          const outsideSearch = !!state.search && others.length === state.sessions.length
          const hidden = (session.archived && !state.showArchived) || outsideSearch
          return { sessions: hidden ? others : sortSessions([session, ...others]), reportInbox: session.is_report_inbox ? session : state.reportInbox }
        })
        return
      }
    }
  }
}))
