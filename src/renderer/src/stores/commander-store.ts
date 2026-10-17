import { activityNow } from '@/lib/activity/activity-clock'
import { parseCommanderAction } from '@shared/commander-action'
import { create } from 'zustand'
import type { CommanderEvent, CommanderMessage, CommanderSession } from '@shared/commander'
import { commanderApi } from '@/lib/ipc-client'
import { seedCommanderImages, clearCommanderImageCache } from '@/lib/commander-images'
import { captureDesktopRead } from '@/lib/desktop-api'
import { createDesktopSnapshotReader } from '@/lib/desktop-snapshot'
import { ServiceProtocolError } from '@shared/service-protocol'
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

let eventOwner: { active: boolean; subscribers: number; off?: () => void } | undefined
let documentGeneration = 0
let selectionGeneration = 0

function captureCommanderRead() {
  const generation = documentGeneration, scope = captureDesktopRead()
  return { isCurrent: () => generation === documentGeneration && scope.isCurrent() }
}

/** Retire only this document's readers/listeners; durable service work stays owned there. */
export function retireCommanderDesktopState(): void {
  documentGeneration++
  selectionGeneration++
  desktopRecoveryGeneration++
  sessionSnapshot.dispose()
  clearCommanderImageCache()
  if (eventOwner) { eventOwner.active = false; eventOwner.off?.(); eventOwner = undefined }
  window.removeEventListener('pagehide', retireCommanderDesktopState)
}
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

let desktopRecoveryGeneration = 0
/** Reconnect reads durable state without marking reports read or sending a turn. */
export async function rehydrateCommanderDesktopState(): Promise<void> {
  const generation = ++desktopRecoveryGeneration
  const scope = captureCommanderRead()
  const selection = ++selectionGeneration
  clearCommanderImageCache()
  const { selectedSessionId, search, showArchived } = useCommanderStore.getState()
  finishedTurns.clear()
  useCommanderStore.setState({ messages: selectedSessionId ? { [selectedSessionId]: [] } : {}, streaming: {}, turnErrors: {}, recentAction: null, undoingActions: [], undoneActions: [], unseenReports: {} })
  const [, history] = await Promise.all([
    sessionSnapshot.refresh(),
    selectedSessionId ? commanderApi.listMessages(selectedSessionId) : Promise.resolve(null)
  ])
  const current = useCommanderStore.getState()
  if (generation !== desktopRecoveryGeneration || selection !== selectionGeneration || !scope.isCurrent() || selectedSessionId !== current.selectedSessionId || search !== current.search || showArchived !== current.showArchived) throw new ServiceProtocolError('STALE_EPOCH')
  useCommanderStore.setState(state => {
    const live = selectedSessionId ? state.streaming[selectedSessionId] : undefined
    const turn = live && !finishedTurns.has(live.turnId) ? live
      : history?.activeTurnId && !finishedTurns.has(history.activeTurnId) ? { turnId: history.activeTurnId, text: '', toolCalls: [] } : undefined
    return {
      messages: selectedSessionId && history ? { [selectedSessionId]: mergeMessages(history.messages, state.messages[selectedSessionId] ?? []) } : {},
      streaming: selectedSessionId && turn ? { [selectedSessionId]: turn } : {},
      undoneActions: [...new Set([...state.undoneActions, ...(history?.messages.filter(message => message.tool_name === 'undo_action' && message.tool_call_id).map(message => message.tool_call_id!) ?? [])])],
      error: null, isLoading: false
    }
  })
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
    const scope = captureCommanderRead()
    const session = await commanderApi.markRead(id)
    if (!scope.isCurrent()) return
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
    if (!eventOwner) {
      const owner = { active: true, subscribers: 0, off: undefined as (() => void) | undefined }
      eventOwner = owner
      owner.off = commanderApi.onEvent(event => { if (owner.active) get().handleEvent(event) }) ?? undefined
      window.addEventListener('pagehide', retireCommanderDesktopState, { once: true })
    }
    const owner = eventOwner
    owner.subscribers++
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      if (owner.active && --owner.subscribers === 0) retireCommanderDesktopState()
    }
  },

  fetchSessions: async () => {
    await sessionSnapshot.refresh().catch(() => {})
  },

  setSearch: async (search) => {
    sessionSnapshot.invalidate()
    set({ search })
    await get().fetchSessions()
  },

  setShowArchived: async (showArchived) => {
    sessionSnapshot.invalidate()
    set({ showArchived })
    await get().fetchSessions()
  },

  selectSession: async (id) => {
    const selection = ++selectionGeneration, scope = captureCommanderRead()
    const isCurrent = () => selection === selectionGeneration && scope.isCurrent() && get().selectedSessionId === id
    const previousTurn = id ? get().streaming[id] : undefined
    set({ selectedSessionId: id })
    // Opening a thread marks its reports read; quiet delivery never buys a model turn.
    void Promise.resolve(commanderApi.setActiveSession(id)).catch(() => {})
    if (!id) return
    try {
      const { messages, activeTurnId } = await commanderApi.listMessages(id)
      if (!isCurrent()) return
      set((state) => ({
        // mergeMessages(existing, incoming) drops `incoming` entries whose id is
        // already in `existing`, so the stored fetch dedupes against local state
        // instead of the combined array (which contains each id twice).
        messages: { ...state.messages, [id]: mergeMessages(state.messages[id] ?? [], messages) },
        undoneActions: [...new Set([...state.undoneActions, ...messages.filter(message => message.tool_name === 'undo_action' && message.tool_call_id).map(message => message.tool_call_id!)])],
        // Main is the truth about running turns: events may have been missed
        // while the view was closed, so a turn that ended meanwhile is cleared.
        streaming: state.streaming[id] && state.streaming[id] !== previousTurn && !finishedTurns.has(state.streaming[id]!.turnId)
          ? state.streaming
          : { ...state.streaming, [id]: activeTurnId && !finishedTurns.has(activeTurnId) ? { turnId: activeTurnId, text: '', toolCalls: [] } : undefined }
      }))
      // Opening a session reads its reports.
      if (isCurrent()) await get().readReports(id)
    } catch (err) {
      if (isCurrent()) set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  createSession: async () => {
    try {
      const scope = captureCommanderRead()
      const session = await commanderApi.createSession()
      if (!scope.isCurrent()) return session
      sessionSnapshot.invalidate()
      selectionGeneration++
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
    const scope = captureCommanderRead()
    const session = await commanderApi.renameSession(id, title)
    if (!scope.isCurrent()) return
    if (session) get().handleEvent({ type: 'session_updated', session })
  },

  archiveSession: async (id, archived) => {
    const scope = captureCommanderRead()
    const session = await commanderApi.archiveSession(id, archived)
    if (!scope.isCurrent()) return
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
          // A delayed terminal for an older turn cannot stop the newer one.
          if (get().streaming[sessionId]?.turnId === turnId) set((state) => ({ streaming: { ...state.streaming, [sessionId]: undefined } }))
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
        sessionSnapshot.invalidate()
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

const sessionSnapshot = createDesktopSnapshotReader({
  read: async () => {
    const { search, showArchived } = useCommanderStore.getState()
    const [sessions, all] = await Promise.all([
      commanderApi.listSessions({ search: search || undefined, includeArchived: showArchived }),
      search ? commanderApi.listSessions({ includeArchived: true }) : Promise.resolve(null)
    ])
    return { sessions, inbox: (all ?? sessions).find(session => session.is_report_inbox), search, showArchived }
  },
  start: () => useCommanderStore.setState({ isLoading: true, error: null }),
  apply: ({ sessions, inbox, search, showArchived }) => {
    const state = useCommanderStore.getState()
    if (search !== state.search || showArchived !== state.showArchived) throw new ServiceProtocolError('STALE_EPOCH')
    useCommanderStore.setState({ sessions: sortSessions(sessions), reportInbox: inbox ?? state.reportInbox, isLoading: false, error: null })
  },
  fail: error => useCommanderStore.setState({ error: error instanceof Error ? error.message : String(error), isLoading: false })
})
if (import.meta.hot) import.meta.hot.dispose(retireCommanderDesktopState)
