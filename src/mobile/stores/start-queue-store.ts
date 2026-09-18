import { create } from 'zustand'
import { onEvent } from '../api/websocket'

export interface QueuedStart {
  /** 1-based place in the desktop's start queue when the start was requested. */
  position: number
  reason?: 'agent_limit' | 'global_limit'
}

interface StartQueueState {
  /** Task id -> its queued start. The desktop starts it on its own when a slot frees. */
  queued: Record<string, QueuedStart>
  markQueued: (taskId: string, entry: QueuedStart) => void
  clear: (taskId: string) => void
}

export const useStartQueueStore = create<StartQueueState>((set, get) => {
  // A queued start begins on the desktop; the task moving to a working (or any
  // other) status is the signal that it left the queue.
  onEvent('task:updated', (payload) => {
    const { taskId, updates } = payload as { taskId: string; updates: { status?: string } }
    if (updates?.status && updates.status !== 'not_started' && get().queued[taskId]) get().clear(taskId)
  })

  return {
    queued: {},
    markQueued: (taskId, entry) => set((state) => ({ queued: { ...state.queued, [taskId]: entry } })),
    clear: (taskId) => set((state) => {
      if (!state.queued[taskId]) return state
      const next = { ...state.queued }
      delete next[taskId]
      return { queued: next }
    })
  }
})

export function describeQueuedStart(entry: QueuedStart): string {
  const limit = entry.reason === 'agent_limit' ? "this agent's limit" : 'the concurrency limit'
  return `Queued (#${entry.position}) behind ${limit}. It starts on its own when a slot frees.`
}
