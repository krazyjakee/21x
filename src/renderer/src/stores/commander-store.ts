import { create } from 'zustand'
import type { CommanderEvent, CommanderSession } from '@shared/commander'
import { commanderApi } from '@/lib/ipc-client'

/**
 * Commander sessions in the renderer (docs/commander.md).
 *
 * Each session's conversation is an agent session on a hidden task row whose
 * id is the session id, so its transcript lives in the agent store like any
 * task's. This store keeps what is particular to the Commander: the session
 * list, the selection, search, and unread reports, all of which main pushes on
 * `commander:event`.
 */

interface CommanderState {
  sessions: CommanderSession[]
  selectedSessionId: string | null
  search: string
  showArchived: boolean
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
  handleEvent: (event: CommanderEvent) => void
}

let unsubscribeEvents: (() => void) | null = null

function sortSessions(sessions: CommanderSession[]): CommanderSession[] {
  return [...sessions].sort((a, b) => b.updated_at - a.updated_at)
}

export const useCommanderStore = create<CommanderState>((set, get) => ({
  sessions: [],
  selectedSessionId: null,
  search: '',
  showArchived: false,
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
    // Main hands reports to the agent only for the open session (#62).
    void Promise.resolve(commanderApi.setActiveSession(id)).catch(() => {})
    if (!id) return
    try {
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
      set((state) => ({ sessions: sortSessions([session, ...state.sessions.filter((s) => s.id !== session.id)]) }))
      await get().selectSession(session.id)
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
    if (archived && get().selectedSessionId === id && !get().showArchived) void get().selectSession(null)
  },

  handleEvent: (event) => {
    switch (event.type) {
      case 'messages_appended': {
        // A report arriving in the open session is read on arrival.
        const { sessionId, messages } = event
        if (sessionId === get().selectedSessionId && messages.some((m) => m.role === 'report')) {
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
