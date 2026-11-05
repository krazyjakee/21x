import { create } from 'zustand'
import type { CommanderActionExecution, CommanderEvent, CommanderMessage, CommanderSession } from '@shared/commander'
import { commanderApi } from '@/lib/ipc-client'

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
  execution_id?: string
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

interface CommanderState {
  sessions: CommanderSession[]
  selectedSessionId: string | null
  search: string
  showArchived: boolean
  messages: Record<string, CommanderMessage[]>
  actions: Record<string, CommanderActionExecution[]>
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
  send: (text: string) => Promise<boolean>
  cancel: () => Promise<void>
  handleEvent: (event: CommanderEvent) => void
}

let unsubscribeEvents: (() => void) | null = null
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

function mergeActions(existing: CommanderActionExecution[], incoming: CommanderActionExecution[]): CommanderActionExecution[] {
  const merged = new Map(existing.map((action) => [action.execution_id, action]))
  for (const action of incoming) merged.set(action.execution_id, action)
  return [...merged.values()].sort((a, b) => a.created_at - b.created_at)
}

export const useCommanderStore = create<CommanderState>((set, get) => ({
  sessions: [],
  selectedSessionId: null,
  search: '',
  showArchived: false,
  messages: {},
  actions: {},
  streaming: {},
  turnErrors: {},
  isLoading: false,
  error: null,

  subscribe: () => {
    if (!unsubscribeEvents) {
      unsubscribeEvents = commanderApi.onEvent((event) => get().handleEvent(event))
    }
    return () => {
      unsubscribeEvents?.()
      unsubscribeEvents = null
    }
  },

  fetchSessions: async () => {
    set({ isLoading: true, error: null })
    try {
      const { search, showArchived } = get()
      const sessions = await commanderApi.listSessions({ search: search || undefined, includeArchived: showArchived })
      set({ sessions: sortSessions(sessions), isLoading: false })
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
    // Main relays a report at once only for the open session (#62).
    void Promise.resolve(commanderApi.setActiveSession(id)).catch(() => {})
    if (!id) return
    try {
      const { messages, actions, activeTurnId } = await commanderApi.listMessages(id)
      set((state) => ({
        // mergeMessages(existing, incoming) drops `incoming` entries whose id is
        // already in `existing`, so the stored fetch dedupes against local state
        // instead of the combined array (which contains each id twice).
        messages: { ...state.messages, [id]: mergeMessages(state.messages[id] ?? [], messages) },
        actions: { ...state.actions, [id]: mergeActions(state.actions[id] ?? [], actions) },
        // Main is the truth about running turns: events may have been missed
        // while the view was closed, so a turn that ended meanwhile is cleared.
        streaming: !activeTurnId
          ? { ...state.streaming, [id]: undefined }
          : state.streaming[id]?.turnId === activeTurnId
            ? state.streaming
            : { ...state.streaming, [id]: { turnId: activeTurnId, text: '', toolCalls: [] } }
      }))
      // Opening a session reads its reports.
      const session = await commanderApi.markRead(id)
      if (session) get().handleEvent({ type: 'session_updated', session })
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

  send: async (text) => {
    const sessionId = get().selectedSessionId
    const trimmed = text.trim()
    if (!sessionId || !trimmed || get().streaming[sessionId]) return false
    set((state) => ({ turnErrors: { ...state.turnErrors, [sessionId]: undefined } }))
    try {
      const { turnId, message } = await commanderApi.send(sessionId, trimmed)
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
      set((state) => ({ turnErrors: { ...state.turnErrors, [sessionId]: err instanceof Error ? err.message : String(err) } }))
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
            next = {
              ...turn,
              toolCalls: [...turn.toolCalls, {
                id: inner.id,
                execution_id: inner.execution_id,
                name: inner.name,
                input: inner.input
              }]
            }
          } else if (inner.type === 'tool_call_result') {
            let matched = false
            next = {
              ...turn,
              toolCalls: turn.toolCalls.map((c) => {
                const same = inner.execution_id
                  ? c.execution_id === inner.execution_id
                  : !matched && c.id === inner.id && c.result === undefined
                if (!same) return c
                matched = true
                return { ...c, result: inner.content, isError: inner.isError }
              })
            }
          }
          return { streaming: { ...state.streaming, [sessionId]: next } }
        })
        return
      }
      case 'action_completed':
      case 'action_updated': {
        const { sessionId, action } = event
        set((state) => ({
          actions: {
            ...state.actions,
            [sessionId]: mergeActions(state.actions[sessionId] ?? [], [action])
          }
        }))
        return
      }
      case 'messages_appended': {
        const { sessionId, messages } = event
        const state = get()
        const loaded = state.messages[sessionId]
        const stored = messages.some((m) => m.role === 'assistant' || m.role === 'tool')
        set({
          messages: loaded ? { ...state.messages, [sessionId]: mergeMessages(loaded, messages) } : state.messages,
          // Stored assistant output replaces the streamed text of the same turn.
          streaming: stored && state.streaming[sessionId]
            ? { ...state.streaming, [sessionId]: { ...state.streaming[sessionId]!, text: '', toolCalls: [] } }
            : state.streaming
        })
        // A report arriving in the open session is read on arrival.
        if (sessionId === state.selectedSessionId && messages.some((m) => m.role === 'report')) {
          void commanderApi.markRead(sessionId).then((session) => {
            if (session) get().handleEvent({ type: 'session_updated', session })
          }).catch(() => {})
        }
        return
      }
      case 'session_updated': {
        const { session } = event
        set((state) => {
          const others = state.sessions.filter((s) => s.id !== session.id)
          // With a search active, only sessions already in the results are updated.
          const outsideSearch = !!state.search && others.length === state.sessions.length
          const hidden = (session.archived && !state.showArchived) || outsideSearch
          return { sessions: hidden ? others : sortSessions([session, ...others]) }
        })
        return
      }
    }
  }
}))
