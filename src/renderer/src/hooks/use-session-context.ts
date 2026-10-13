import { useCallback, useSyncExternalStore } from 'react'
import type { RolloverPolicy, SessionContextScope, SessionContextSnapshot } from '@shared/session-context'
import { commanderApi, onAgentStatus, onTranscriptChanged, sessionContextApi } from '@/lib/ipc-client'

interface ContextState { snapshot: SessionContextSnapshot | null; loading: boolean; error: string | null }
interface Entry {
  scope: SessionContextScope
  state: ContextState
  listeners: Set<() => void>
  request: number
  inFlight: boolean
  pending: boolean
  eventTimer: ReturnType<typeof setTimeout> | null
}
const EMPTY: ContextState = { snapshot: null, loading: false, error: null }
const entries = new Map<string, Entry>()
const keyOf = (scope: SessionContextScope) => JSON.stringify([scope.kind, scope.ownerId])
let pollTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribeEvents: Array<() => void> = []
const visible = () => typeof document === 'undefined' || !document.hidden

function publish(entry: Entry, state: ContextState) {
  entry.state = state
  for (const listener of entry.listeners) listener()
}
async function refresh(entry: Entry): Promise<void> {
  if (!visible() || !entry.listeners.size || entries.get(keyOf(entry.scope)) !== entry) return
  if (entry.inFlight) { entry.pending = true; return }
  entry.inFlight = true
  const request = ++entry.request
  publish(entry, { ...entry.state, loading: true })
  try {
    const snapshot = await sessionContextApi.getSnapshot(entry.scope)
    if (entries.get(keyOf(entry.scope)) !== entry || request !== entry.request) return
    if (snapshot.scope.kind !== entry.scope.kind || snapshot.scope.ownerId !== entry.scope.ownerId) throw new Error('Context scope mismatch')
    publish(entry, { snapshot, loading: false, error: null })
  } catch {
    if (entries.get(keyOf(entry.scope)) === entry && request === entry.request) {
      // A failed refresh cannot keep presenting cached numbers as current.
      publish(entry, { snapshot: null, loading: false, error: 'Context data is unavailable. Try refreshing.' })
    }
  } finally {
    entry.inFlight = false
    if (entry.pending) { entry.pending = false; void refresh(entry) }
  }
}
function armPolling() {
  if (pollTimer || !entries.size || !visible()) return
  pollTimer = setTimeout(() => {
    pollTimer = null
    for (const entry of entries.values()) void refresh(entry)
    armPolling()
  }, 5_000)
}
function visibilityChanged() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
  if (visible()) { for (const entry of entries.values()) void refresh(entry); armPolling() }
}
function eventRefresh(scope: SessionContextScope) {
  const entry = entries.get(keyOf(scope))
  if (!entry || entry.eventTimer || !visible()) return
  entry.eventTimer = setTimeout(() => { entry.eventTimer = null; void refresh(entry) }, 100)
}
function installWatchers() {
  document.addEventListener('visibilitychange', visibilityChanged)
  const install = (subscribe: () => (() => void)) => { try { const off = subscribe(); if (typeof off === 'function') unsubscribeEvents.push(off) } catch { /* Partial bridges still show an honest fetch error. */ } }
  install(() => commanderApi.onEvent(event => {
    if (event.type === 'turn_started' || event.type === 'messages_appended' || event.type === 'turn_event' && ['done', 'error'].includes(event.event.type)) eventRefresh({ kind: 'commander', ownerId: event.sessionId })
  }))
  install(() => onAgentStatus(event => eventRefresh({ kind: 'captain', ownerId: event.taskId })))
  install(() => onTranscriptChanged(event => {
    if (event.reloadRequired || event.parts.some(part => ['compaction', 'generation', 'step-finish'].includes(part.partType ?? ''))) eventRefresh({ kind: 'captain', ownerId: event.taskId })
  }))
  armPolling()
}
function subscribe(scope: SessionContextScope, listener: () => void) {
  const key = keyOf(scope)
  let entry = entries.get(key)
  const first = entries.size === 0
  if (!entry) { entry = { scope, state: EMPTY, listeners: new Set(), request: 0, inFlight: false, pending: false, eventTimer: null }; entries.set(key, entry) }
  const firstListener = entry.listeners.size === 0
  entry.listeners.add(listener)
  if (first) installWatchers()
  if (firstListener) void refresh(entry)
  const own = entry
  return () => {
    own.listeners.delete(listener)
    if (own.listeners.size) return
    if (own.eventTimer) clearTimeout(own.eventTimer)
    if (entries.get(key) === own) entries.delete(key)
    if (!entries.size) {
      if (pollTimer) clearTimeout(pollTimer)
      pollTimer = null
      document.removeEventListener('visibilitychange', visibilityChanged)
      for (const off of unsubscribeEvents) off()
      unsubscribeEvents = []
    }
  }
}

export function useSessionContext(scope: SessionContextScope | null) {
  const kind = scope?.kind, ownerId = scope?.ownerId
  const key = scope ? keyOf(scope) : ''
  const subscribeScope = useCallback((listener: () => void) => kind && ownerId ? subscribe({ kind, ownerId }, listener) : () => {}, [kind, ownerId])
  const read = useCallback(() => entries.get(key)?.state ?? EMPTY, [key])
  const state = useSyncExternalStore(subscribeScope, read, () => EMPTY)
  const reload = useCallback(() => { const entry = entries.get(key); if (entry) void refresh(entry) }, [key])
  const savePolicy = useCallback(async (policy: RolloverPolicy) => {
    const saved = await sessionContextApi.setPolicy(policy)
    for (const entry of entries.values()) {
      // Fence reads begun before the write, then revalidate the whole snapshot.
      entry.request++
      publish(entry, { ...entry.state, snapshot: entry.state.snapshot ? { ...entry.state.snapshot, policy: saved } : null })
      void refresh(entry)
    }
    return saved
  }, [])
  return { ...state, reload, savePolicy }
}
